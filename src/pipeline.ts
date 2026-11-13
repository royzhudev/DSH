import path from "node:path";
import fs from "node:fs/promises";
import type {
  AppConfig,
  CastAsset,
  DialogueLine,
  GeneratedClip,
  JobProgress,
  JobStage,
  LipsyncProvider,
  PipelineResult,
  ProgressReporter,
  ScriptProvider,
  ScriptSegment,
  SegmentPlan,
  SegmentResult,
  SubtitleCue,
  TtsProvider,
  TtsResult,
  VideoGenProvider,
} from "./types.js";
import { AppError, toErrorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import { createScriptProvider } from "./script/index.js";
import { createTtsProvider } from "./tts/index.js";
import { createVideoGenProvider } from "./videogen/index.js";
import { MaterialLibrary } from "./materials/library.js";
import { matchMaterial, materialTagPool } from "./materials/match.js";
import { CastLibrary, castSummary, resolveCastNames, selectCastAssets } from "./cast/library.js";
import { buildShotPrompt } from "./cast/prompt.js";
import { isAiVideoEnabled } from "./config.js";
import { preflightVideoJob } from "./preflight.js";
import { burnSegmentSubtitles, renderSegment } from "./render/segment.js";
import { concatSegments } from "./render/concat.js";
import { buildSubtitleCues, renderSrt } from "./subtitles/ass.js";
import { probeMedia, extractPoster, concatAudio } from "./media/ffmpeg.js";
import { createLipsyncProvider } from "./lipsync/dashscope.js";
import { assignDialogueVoices, voiceRateFor } from "./tts/voices.js";
import { ensureDir, sha256, shortId, writeJsonFile } from "./util/fs.js";

export interface RunPipelineOptions {
  topic: string;
  config: AppConfig;
  logger?: Logger;
  onProgress?: ProgressReporter;
  jobId?: string;
  signal?: AbortSignal;
  library?: MaterialLibrary;
  /** 角色/道具库；默认按 config.castDir 创建。 */
  castLibrary?: CastLibrary;
  scriptProvider?: ScriptProvider;
  ttsProvider?: TtsProvider;
  /** 显式传入 null 可禁用画面生成；未传时按配置创建。 */
  videoGenProvider?: VideoGenProvider | null;
  /** 显式传入 null 可禁口型同步；未传时按配置创建。 */
  lipsyncProvider?: LipsyncProvider | null;
  /** 剧本/大纲文本；为空时只按主题创作。 */
  story?: string;
  /** 本片使用的角色/道具 id；未提供表示使用角色库全部设定。 */
  castIds?: string[];
  /** 对话模式：分镜按人物台词生成，并按说话人分配音色。 */
  dialogue?: boolean;
}

const STAGE_LABELS: Record<JobStage, string> = {
  queued: "排队",
  preflight: "检查配置",
  script: "脚本生成",
  materials: "画面准备",
  tts: "配音合成",
  videogen: "AI 画面生成",
  render: "分镜剪辑",
  lipsync: "对口型",
  concat: "成片拼接",
  done: "完成",
};

export function createJobId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${shortId().slice(0, 8)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("任务已取消", { code: "ABORTED", status: 499 });
  }
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function castPromptInput(assets: CastAsset[]): Array<Pick<CastAsset, "name" | "kind" | "description">> {
  return assets.map(({ name, kind, description }) => ({ name, kind, description }));
}

/** 把阶段信息加到错误消息前面，用户能直接看出是哪一步出的问题。 */
function withStageLabel(stage: JobStage, error: unknown): unknown {
  if (error instanceof AppError && error.code === "ABORTED") return error;
  if (stage === "preflight") return error;
  const message = toErrorMessage(error);
  if (message.startsWith("【")) return error;
  return new AppError(`【${STAGE_LABELS[stage] ?? stage}】${message}`, {
    code: error instanceof AppError ? error.code : "PIPELINE_FAILED",
    status: error instanceof AppError ? error.status : 500,
    cause: error,
  });
}

interface DialogueSynthesisInput {
  lines: DialogueLine[];
  cast: CastAsset[];
  config: AppConfig;
  logger: Logger;
  jobDir: string;
  index: number;
  ttsProvider: TtsProvider;
  signal?: AbortSignal;
}

/**
 * 对话模式：按说话人逐句合成，再把几段配音拼成一条音轨。
 * - 每个说话人固定音色（角色库可指定，未指定时按名字稳定分配）；
 * - 字幕按“角色：台词”逐句出现，时间轴按每句真实时长累加；
 * - Edge 以外的供应商不支持切换音色时，仍按对话逐句合成，字幕保留说话人。
 */
async function synthesizeDialogueLines(input: DialogueSynthesisInput): Promise<{
  tts: TtsResult;
  cues: SubtitleCue[];
  lines: Array<DialogueLine & { voice: string; durationSec: number }>;
}> {
  const { lines, cast, config, logger, jobDir, index, ttsProvider, signal } = input;
  const canSwitchVoice = config.tts.provider === "edge";
  const voices = canSwitchVoice
    ? assignDialogueVoices([...new Set(lines.map((line) => line.speaker))], cast, config.tts.voice)
    : new Map<string, string>();
  const providers = new Map<string, TtsProvider>();
  const audioFiles: string[] = [];
  const synthesized: Array<DialogueLine & { voice: string; durationSec: number }> = [];
  const cues: SubtitleCue[] = [];
  let offset = 0;
  let allCached = true;

  for (const line of lines) {
    if (signal?.aborted) throw new AppError("任务已取消", { code: "ABORTED", status: 499 });
    const voice = voices.get(line.speaker) ?? config.tts.voice;
    // 语速跟着人物设定微调（年长慢一点、年轻快一点），比全片一个速度自然。
    const rate = voiceRateFor(cast.find((asset) => asset.name === line.speaker)?.description ?? "", config.tts.rate);
    let provider = ttsProvider;
    const providerKey = `${voice}|${rate}`;
    if (canSwitchVoice && (voice !== ttsProvider.voice || rate !== config.tts.rate)) {
      provider = providers.get(providerKey) ?? createTtsProvider(
        { ...config, tts: { ...config.tts, voice, rate } },
        config.cacheDir,
        logger,
      );
      providers.set(providerKey, provider);
    }
    const cacheKey = sha256(
      [config.tts.provider, config.tts.model, voice, String(rate), line.text].join("|"),
    ).slice(0, 40);
    const result = await provider.synthesize({ text: line.text, cacheKey }, signal);
    audioFiles.push(result.audioPath);
    allCached = allCached && result.cached;
    synthesized.push({
      speaker: line.speaker,
      text: line.text,
      voice: result.voice,
      durationSec: round3(result.durationSec),
    });
    cues.push({
      startSec: round3(offset),
      endSec: round3(offset + result.durationSec),
      text: `${line.speaker}：${line.text}`,
    });
    offset += result.durationSec;
  }

  const audioDir = path.join(jobDir, "audio");
  await ensureDir(audioDir);
  const audioPath = path.join(audioDir, `segment-${String(index + 1).padStart(2, "0")}.mp3`);
  await concatAudio(audioFiles, audioPath);
  const voicesUsed = [...new Set(synthesized.map((line) => line.voice))];
  if (canSwitchVoice) {
    const summary = [...voices.entries()]
      .map(([speaker, voice]) => {
        const description = cast.find((asset) => asset.name === speaker)?.description ?? "";
        return `${speaker}=${voice}（语速 ${voiceRateFor(description, config.tts.rate)}）`;
      })
      .join("，");
    logger.info(`分镜 ${index + 1} 角色音色：${summary || "沿用旁白音色"}`);
  }
  return {
    tts: {
      provider: ttsProvider.name,
      voice: voicesUsed.join("、"),
      audioPath,
      durationSec: round3(offset),
      cached: allCached,
    },
    cues: offset > 0 ? cues : [],
    lines: synthesized,
  };
}


/** 脚本没写清分镜出场角色时，用已上传的角色兜底，避免参考图完全没用上。 */
function inferSegmentCast(segment: ScriptSegment, cast: CastAsset[]): CastAsset[] {
  const characters = cast.filter((asset) => asset.kind === "character");
  if (characters.length === 0) return [];
  if (characters.length === 1) return characters;
  const mentioned = characters.filter(
    (asset) => segment.narration.includes(asset.name) || segment.lines?.some((line) => line.speaker.includes(asset.name)),
  );
  return mentioned;
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const { topic, config } = options;
  const logger = options.logger ?? silentLogger;
  const signal = options.signal;
  const normalizedTopic = topic.trim();
  if (!normalizedTopic) {
    throw new AppError("主题不能为空", { code: "INVALID_TOPIC", status: 400 });
  }
  if (normalizedTopic.length > 200) {
    throw new AppError("主题不能超过 200 个字符", { code: "INVALID_TOPIC", status: 400 });
  }
  const story = options.story?.trim() || undefined;

  let currentStage: JobStage = "preflight";
  const report = (progress: JobProgress): void => {
    currentStage = progress.stage;
    try {
      options.onProgress?.(progress);
    } catch {
      // 进度回调失败不影响主流程
    }
  };

  const createdAt = new Date().toISOString();
  const jobId = options.jobId ?? createJobId();
  const jobDir = path.join(config.outputDir, jobId);
  const outputFile = path.join(jobDir, "video.mp4");
  const srtPath = path.join(jobDir, "subtitles.srt");
  const scriptPath = path.join(jobDir, "script.json");
  const resultPath = path.join(jobDir, "result.json");
  const warnings: string[] = [];
  if (config.videoGen.provider === "http" && !config.videoGen.apiKey) {
    warnings.push(
      "AI 画面生成还没有填写 API Key（默认接阿里百炼 Wan），本次已回退素材库；在设置页填写 Key 后才会调用模型。",
    );
  }

  try {
    await ensureDir(jobDir);
    await ensureDir(config.workDir);
    await ensureDir(config.libraryDir);
    await ensureDir(config.castDir);
    await ensureDir(config.cacheDir);

    // 先做本地检查，再调用任何可能产生费用的模型。
    report({ stage: "preflight", percent: 2, message: "检查配置、参考图与运行环境" });
    const castLibrary = options.castLibrary ?? new CastLibrary(config.castDir, logger);
    const allCast = await castLibrary.list();
    const cast = selectCastAssets(allCast, options.castIds);
    await preflightVideoJob({
      config,
      topic: normalizedTopic,
      story,
      castAssets: cast,
      options: { castIds: options.castIds, videoGenEnabled: isAiVideoEnabled(config.videoGen) },
      logger,
    });
    throwIfAborted(signal);

    report({ stage: "script", percent: 5, message: "读取素材库并生成脚本" });
    const library = options.library ?? new MaterialLibrary(config.libraryDir, logger);
    const materials = await library.list();
    const scriptProvider = options.scriptProvider ?? createScriptProvider(config, logger);
    const script = await scriptProvider.generate(
      {
        topic: normalizedTopic,
        targetDurationSec: config.script.targetDurationSec,
        maxSegments: config.script.maxSegments,
        availableTags: materialTagPool(materials),
        ...(story ? { story } : {}),
        ...(options.dialogue ? { dialogue: true } : {}),
        ...(cast.length > 0 ? { cast: castPromptInput(cast) } : {}),
      },
      signal,
    );
    throwIfAborted(signal);
    if (story && script.provider === "offline") {
      warnings.push(
        "当前使用离线脚本模板，剧本/大纲没有参与分镜生成；配置脚本模型后可严格按剧本生成。",
      );
    }
    if (script.droppedSegments && script.droppedSegments > 0) {
      warnings.push(
        `脚本里有 ${script.droppedSegments} 个内容重复的分镜已自动去掉（台词/旁白相同），避免成片出现同一镜头反复播放。`,
      );
      logger.warn(`脚本去重：丢掉 ${script.droppedSegments} 个重复分镜`);
    }
    await writeJsonFile(scriptPath, script);
    logger.info(`脚本已生成：${script.title}（${script.segments.length} 段）`);
    report({
      stage: "script",
      percent: 15,
      message: `脚本已生成，素材库共 ${materials.length} 条`,
    });

    const ttsProvider = options.ttsProvider ?? createTtsProvider(config, config.cacheDir, logger);
    const plans: SegmentPlan[] = [];
    let cursor = 0;
    const totalSegments = script.segments.length;

    for (let index = 0; index < totalSegments; index += 1) {
      throwIfAborted(signal);
      const segment = script.segments[index]!;

      const dialogueLines = segment.lines ?? [];
      let tts: TtsResult;
      let cues: SubtitleCue[];
      let lineResults: SegmentPlan["lines"];
      if (dialogueLines.length > 0) {
        const synthesized = await synthesizeDialogueLines({
          lines: dialogueLines,
          cast,
          config,
          logger,
          jobDir,
          index,
          ttsProvider,
          signal,
        });
        tts = synthesized.tts;
        cues = synthesized.cues;
        lineResults = synthesized.lines;
      } else {
        const cacheKey = sha256(
          [
            config.tts.provider,
            config.tts.model,
            config.tts.voice,
            String(config.tts.rate),
            segment.narration,
          ].join("|"),
        ).slice(0, 40);
        tts = await ttsProvider.synthesize({ text: segment.narration, cacheKey }, signal);
        cues = buildSubtitleCues({
          narration: segment.narration,
          sentences: tts.sentences,
          audioDurationSec: tts.durationSec,
          style: config.subtitles,
        });
      }
      if (config.tts.provider !== "silent" && tts.provider === "silent") {
        warnings.push(`分镜 ${index + 1} 配音失败，已回退为静音占位（详见服务日志）。`);
      }
      const durationSec = round3(
        Math.max(tts.durationSec + config.video.tailPaddingSec, config.video.minSegmentSec),
      );
      const explicitCast = resolveCastNames(segment.cast, cast);
      const inferredCast = explicitCast.length > 0 ? [] : inferSegmentCast(segment, cast);
      if (inferredCast.length > 0) {
        logger.info(
          `分镜 ${index + 1} 脚本没有写角色名，按已上传角色代入：${inferredCast.map((item) => item.name).join("、")}`,
        );
        warnings.push(
          `分镜 ${index + 1} 的脚本没有标明出场角色，已按角色库代入「${inferredCast.map((item) => item.name).join("、")}」；如需换人请在脚本里写明角色名。`,
        );
      }
      plans.push({
        index,
        segment,
        material: null,
        cast: explicitCast.length > 0 ? explicitCast : inferredCast,
        tts,
        durationSec,
        cues,
        ...(lineResults ? { lines: lineResults } : {}),
        startSec: round3(cursor),
      });
      cursor = round3(cursor + durationSec);
      report({
        stage: "tts",
        percent: Math.round(15 + ((index + 1) / totalSegments) * 35),
        message: `配音 ${index + 1}/${totalSegments} 完成（${durationSec.toFixed(1)}s）`,
      });
    }

    throwIfAborted(signal);
    const videoGen =
      options.videoGenProvider === undefined
        ? createVideoGenProvider(config, logger)
        : options.videoGenProvider;
    const castCharacters = cast.filter((asset) => asset.kind === "character");
    const plansWithCast = plans.filter((plan) => plan.cast.some((asset) => asset.kind === "character"));
    if (!videoGen && castCharacters.length > 0) {
      warnings.push(
        `角色库里已有 ${castCharacters.length} 个角色，但没有启用 AI 画面生成，成片只会用素材/背景，不会出现角色形象；在设置里配置 AI 画面模型后才会用角色参考图。`,
      );
    } else if (videoGen && castCharacters.length > 0 && plansWithCast.length === 0) {
      warnings.push(
        "脚本没有任何分镜引用角色库，已上传的角色形象不会出现在成片里；请在剧本里写明角色名，或重新生成脚本。",
      );
    }
    const usedIds = new Set<string>();
    for (let index = 0; index < plans.length; index += 1) {
      throwIfAborted(signal);
      const plan = plans[index]!;
      let fallbackReason: string | undefined;
      if (videoGen) {
        report({
          stage: "videogen",
          percent: Math.round(50 + (index / plans.length) * 14),
          message: `AI 生成画面 ${index + 1}/${plans.length}${plan.cast.length > 0 ? `（${plan.cast.map((item) => item.name).join("、")}）` : ""}`,
        });
        const references = plan.cast
          .filter((asset) => asset.imageFile)
          .map((asset) => ({
            role: asset.kind,
            name: asset.name,
            file: path.join(config.castDir, asset.imageFile!),
          }));
        const primary = references.find((reference) => reference.role === "character") ?? references[0];
        // 角色参考图是“人设定妆照”，不是每个分镜的首帧。所有镜头都拿同一张图做首帧，
        // 生成结果会像同一个镜头重复播放。只让第 1 镜定调，其余镜头按剧本文字生成不同画面。
        const firstFrame = index === 0 ? primary : undefined;
        const shotPrompt = buildShotPrompt({
          topic: normalizedTopic,
          index: index + 1,
          total: plans.length,
          segment: plan.segment,
          cast: plan.cast,
        });
        logger.info(
          `分镜 ${index + 1}/${plans.length} 画面提示词：${shotPrompt.split("\n")[1] ?? shotPrompt.slice(0, 40)}`,
        );
        try {
          const generated: GeneratedClip = await videoGen.generate(
            {
              prompt: shotPrompt,
              durationSec: Math.min(config.videoGen.clipDurationSec, Math.max(2, plan.durationSec)),
              ...(firstFrame ? { image: firstFrame.file } : {}),
              ...(references.length > 0 ? { references } : {}),
            },
            path.join(jobDir, "generated"),
            signal,
          );
          plan.generated = generated;
          plan.imageToVideo = Boolean(firstFrame);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!config.videoGen.fallbackToMaterials) throw error;
          fallbackReason = toErrorMessage(error);
          logger.warn(`分镜 ${index + 1} AI 画面生成失败，回退素材匹配：${fallbackReason}`);
        }
      }
      if (!plan.generated) {
        const material = matchMaterial(plan.segment, materials, {
          allowUnmatched: config.materials.allowUnmatched,
          usedIds,
        });
        if (material) usedIds.add(material.id);
        plan.material = material;
        if (fallbackReason) {
          warnings.push(
            `分镜 ${index + 1} AI 画面生成失败，已回退${material ? "素材库" : "渐变背景"}：${fallbackReason}`,
          );
        }
      }
    }
    // 平台偶尔对不同分镜返回同一条视频；这里按文件内容对比，发现重复就明确告警，
    // 免得成片里"同一个分镜出现了两次"却查不出原因。
    const clipOwners = new Map<string, number>();
    for (const plan of plans) {
      if (!plan.generated?.file) continue;
      try {
        const digest = sha256((await fs.readFile(plan.generated.file)).toString("base64"));
        const owner = clipOwners.get(digest);
        if (owner) {
          warnings.push(
            `分镜 ${owner} 与分镜 ${plan.index + 1} 拿到的是同一条生成视频，建议对这两镜换提示词或重新生成。`,
          );
          logger.warn(`分镜 ${owner} 与分镜 ${plan.index + 1} 生成视频内容完全一致：${plan.generated.file}`);
        } else {
          clipOwners.set(digest, plan.index + 1);
        }
      } catch (error) {
        logger.warn(`对比分镜 ${plan.index + 1} 生成视频失败：${toErrorMessage(error)}`);
      }
    }

    report({
      stage: "materials",
      percent: 65,
      message: videoGen ? "画面准备完成" : "素材匹配完成",
    });

    throwIfAborted(signal);
    const lipsyncProvider =
      options.lipsyncProvider === undefined
        ? createLipsyncProvider(config.lipsync, logger)
        : options.lipsyncProvider;
    if (config.lipsync.provider === "dashscope" && !config.lipsync.apiKey) {
      warnings.push("口型同步已选择百炼 VideoRetalk，但还没有填写 API Key，本次跳过口型同步。");
    }
    if (lipsyncProvider) {
      warnings.push(
        "口型同步会按成片时长计费（百炼 VideoRetalk 0.08 元/秒），且只在分镜含台词、画面有人物时生效。",
      );
    }
    const rendered: string[] = [];
    const lipsyncStats = { synced: 0, skipped: 0, failed: 0 };
    const segmentLipsync = new Map<number, "synced" | "unsynced" | "skipped">();
    const renderBase = videoGen ? 65 : 50;
    for (let index = 0; index < plans.length; index += 1) {
      throwIfAborted(signal);
      const plan = plans[index]!;
      report({
        stage: "render",
        percent: Math.round(renderBase + (index / plans.length) * (88 - renderBase)),
        message: `剪辑分镜 ${index + 1}/${plans.length}`,
      });
      const willSync =
        Boolean(lipsyncProvider) &&
        Boolean(plan.lines && plan.lines.length > 0) &&
        plan.durationSec > 2 &&
        plan.durationSec < 120 &&
        plan.cast.some((asset) => asset.kind === "character");
      const result = await renderSegment({
        index: plan.index + 1,
        segment: plan.segment,
        material: plan.material,
        materialPath: plan.generated?.file,
        tts: plan.tts,
        durationSec: plan.durationSec,
        cues: plan.cues,
        config,
        jobDir,
        topic: normalizedTopic,
        logger,
        // 口型同步会把整帧重新生成，先不烧字幕，同步后再补，避免文字被模型重绘。
        ...(willSync ? { burnSubtitles: false } : {}),
      });
      let segmentFile = result.file;
      // 口型结果按分镜序号记录，供 result.json 展示。
      const syncable = willSync;
      if (syncable && lipsyncProvider) {
        report({
          stage: "lipsync",
          percent: Math.round(renderBase + ((index + 0.5) / plans.length) * (88 - renderBase)),
          message: `对口型 ${index + 1}/${plans.length}`,
        });
        try {
          const synced = await lipsyncProvider.sync(
            { videoFile: result.file, audioFile: plan.tts.audioPath },
            jobDir,
            signal,
          );
          segmentFile = synced.file;
          lipsyncStats.synced += 1;
          // VideoRetalk 会按音频扩展/截断画面，字幕与后续分镜起点必须按真实时长重算。
          const syncedProbe = await probeMedia(segmentFile);
          const syncedDuration = round3(Math.max(syncedProbe.durationSec ?? plan.durationSec, 0.1));
          if (Math.abs(syncedDuration - plan.durationSec) > 0.05) {
            logger.info(
              `分镜 ${index + 1} 口型同步后时长 ${plan.durationSec.toFixed(2)}s → ${syncedDuration.toFixed(2)}s，已按新时长重排字幕与后续分镜`,
            );
            plan.durationSec = syncedDuration;
          }
          segmentFile = await burnSegmentSubtitles({
            index: index + 1,
            file: segmentFile,
            cues: plan.cues,
            config,
            logger,
          });
          logger.info(`分镜 ${index + 1} 口型已同步（${synced.model}）`);
        } catch (error) {
          if (!config.lipsync.fallbackToUnsynced) throw error;
          lipsyncStats.failed += 1;
          warnings.push(
            `分镜 ${index + 1} 口型同步失败，已保留未对口型的片段：${toErrorMessage(error)}`,
          );
          logger.warn(`分镜 ${index + 1} 口型同步失败，回退未对口型画面：${toErrorMessage(error)}`);
        }
      } else if (lipsyncProvider && plan.lines?.length) {
        lipsyncStats.skipped += 1;
      }
      if (lipsyncProvider && plan.lines?.length) {
        segmentLipsync.set(
          plan.index,
          segmentFile === result.file ? (syncable ? "unsynced" : "skipped") : "synced",
        );
      }
      rendered.push(segmentFile);
    }

    // 口型同步可能改变分镜时长：按最终时长重排起点，保证 SRT 与画面一致。
    let finalCursor = 0;
    for (const plan of plans) {
      plan.startSec = round3(finalCursor);
      finalCursor = round3(finalCursor + plan.durationSec);
    }

    throwIfAborted(signal);
    report({ stage: "concat", percent: 88, message: "拼接成片" });
    const finalDuration = await concatSegments({
      segmentFiles: rendered,
      outputFile,
      jobDir,
      config,
      logger,
    });
    throwIfAborted(signal);

    let posterPath: string | undefined;
    try {
      const candidate = path.join(jobDir, "poster.jpg");
      await extractPoster(outputFile, candidate);
      posterPath = candidate;
    } catch (error) {
      logger.warn(`生成播放器封面失败（不影响成片）：${toErrorMessage(error)}`);
    }

    const srtCues = plans.flatMap((plan) =>
      plan.cues.map((cue) => ({ ...cue, startOffsetSec: plan.startSec })),
    );
    await fs.writeFile(srtPath, renderSrt(srtCues), "utf8");

    const finishedAt = new Date().toISOString();
    const segmentResults: SegmentResult[] = plans.map((plan) => ({
      index: plan.index + 1,
      narration: plan.segment.narration,
      keywords: plan.segment.keywords,
      ...(plan.segment.scene ? { scene: plan.segment.scene } : {}),
      ...(plan.segment.shot ? { shot: plan.segment.shot } : {}),
      ...(plan.cast.length > 0
        ? { cast: plan.cast.map(({ id, name, kind }) => ({ id, name, kind })) }
        : {}),
      material: plan.material
        ? {
            id: plan.material.id,
            title: plan.material.title,
            type: plan.material.type,
            file: plan.material.file,
          }
        : null,
      voice: plan.tts.voice,
      ttsProvider: plan.tts.provider,
      ...(segmentLipsync.has(plan.index) ? { lipsync: segmentLipsync.get(plan.index) } : {}),
      ...(plan.lines ? { lines: plan.lines } : {}),
      durationSec: plan.durationSec,
      startSec: plan.startSec,
      subtitleCues: plan.cues.length,
      source: plan.generated ? "generated" : plan.material ? "material" : "background",
      ...(plan.imageToVideo ? { imageToVideo: true } : {}),
      generated: plan.generated
        ? { provider: plan.generated.provider, model: plan.generated.model }
        : undefined,
    }));

    const videoProbe = await probeMedia(outputFile);
    const result: PipelineResult = {
      jobId,
      topic: normalizedTopic,
      ...(story ? { story } : {}),
      createdAt,
      finishedAt,
      durationSec: round3(finalDuration || videoProbe.durationSec || cursor),
      videoPath: outputFile,
      posterPath,
      srtPath,
      scriptPath,
      resultPath,
      script,
      cast: castSummary(cast),
      segments: segmentResults,
      ...(warnings.length > 0 ? { warnings } : {}),
      video: {
        width: videoProbe.width ?? config.video.width,
        height: videoProbe.height ?? config.video.height,
        fps: config.video.fps,
      },
    };
    await writeJsonFile(resultPath, result);
    report({ stage: "done", percent: 100, message: "成片已生成" });
    logger.info(`成片完成：${outputFile}（${result.durationSec.toFixed(1)}s）`);
    return result;
  } catch (error) {
    const failure = withStageLabel(currentStage, error);
    await writeJsonFile(path.join(jobDir, "error.json"), {
      message: toErrorMessage(failure),
      code: failure instanceof AppError ? failure.code : "PIPELINE_FAILED",
      stage: currentStage,
      stack: failure instanceof Error ? failure.stack : undefined,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    throw failure;
  }
}
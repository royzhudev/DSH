import path from "node:path";
import fs from "node:fs/promises";
import type {
  AppConfig,
  CastAsset,
  GeneratedClip,
  JobProgress,
  JobStage,
  PipelineResult,
  ProgressReporter,
  ScriptProvider,
  SegmentPlan,
  SegmentResult,
  TtsProvider,
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
import { preflightVideoJob } from "./preflight.js";
import { renderSegment } from "./render/segment.js";
import { concatSegments } from "./render/concat.js";
import { buildSubtitleCues, renderSrt } from "./subtitles/ass.js";
import { probeMedia, extractPoster } from "./media/ffmpeg.js";
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
  /** 剧本/大纲文本；为空时只按主题创作。 */
  story?: string;
  /** 本片使用的角色/道具 id；未提供表示使用角色库全部设定。 */
  castIds?: string[];
}

const STAGE_LABELS: Record<JobStage, string> = {
  queued: "排队",
  preflight: "检查配置",
  script: "脚本生成",
  materials: "画面准备",
  tts: "配音合成",
  videogen: "AI 画面生成",
  render: "分镜剪辑",
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
      options: { castIds: options.castIds, videoGenEnabled: config.videoGen.provider !== "none" },
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

      const cacheKey = sha256(
        [
          config.tts.provider,
          config.tts.model,
          config.tts.voice,
          String(config.tts.rate),
          segment.narration,
        ].join("|"),
      ).slice(0, 40);
      const tts = await ttsProvider.synthesize({ text: segment.narration, cacheKey }, signal);
      if (config.tts.provider !== "silent" && tts.provider === "silent") {
        warnings.push(`分镜 ${index + 1} 配音失败，已回退为静音占位（详见服务日志）。`);
      }
      const durationSec = round3(
        Math.max(tts.durationSec + config.video.tailPaddingSec, config.video.minSegmentSec),
      );
      const cues = buildSubtitleCues({
        narration: segment.narration,
        sentences: tts.sentences,
        audioDurationSec: tts.durationSec,
        style: config.subtitles,
      });
      plans.push({
        index,
        segment,
        material: null,
        cast: resolveCastNames(segment.cast, cast),
        tts,
        durationSec,
        cues,
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
        try {
          const generated: GeneratedClip = await videoGen.generate(
            {
              prompt: buildShotPrompt({
                topic: normalizedTopic,
                index: index + 1,
                total: plans.length,
                segment: plan.segment,
                cast: plan.cast,
              }),
              durationSec: Math.min(config.videoGen.clipDurationSec, Math.max(2, plan.durationSec)),
              ...(primary ? { image: primary.file } : {}),
              ...(references.length > 0 ? { references } : {}),
            },
            path.join(jobDir, "generated"),
            signal,
          );
          plan.generated = generated;
          plan.imageToVideo = Boolean(primary);
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
    report({
      stage: "materials",
      percent: 65,
      message: videoGen ? "画面准备完成" : "素材匹配完成",
    });

    throwIfAborted(signal);
    const rendered: string[] = [];
    const renderBase = videoGen ? 65 : 50;
    for (let index = 0; index < plans.length; index += 1) {
      throwIfAborted(signal);
      const plan = plans[index]!;
      report({
        stage: "render",
        percent: Math.round(renderBase + (index / plans.length) * (88 - renderBase)),
        message: `剪辑分镜 ${index + 1}/${plans.length}`,
      });
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
      });
      rendered.push(result.file);
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
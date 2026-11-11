import path from "node:path";
import fs from "node:fs/promises";
import type {
  AppConfig,
  GeneratedClip,
  JobProgress,
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
  scriptProvider?: ScriptProvider;
  ttsProvider?: TtsProvider;
  /** 显式传入 null 可禁用画面生成；未传时按配置创建。 */
  videoGenProvider?: VideoGenProvider | null;
}

/** 把主题、口播和关键词拼成画面生成提示词。 */
export function buildVideoPrompt(topic: string, segment: { narration: string; keywords: string[] }): string {
  const keywords = segment.keywords.filter(Boolean).join("、");
  const prompt = [
    `主题：${topic}`,
    `画面：${segment.narration}`,
    keywords ? `关键词：${keywords}` : "",
    "竖屏 9:16，真实拍摄质感，光线自然，镜头稳定，无文字水印。",
  ]
    .filter(Boolean)
    .join("；");
  return prompt.slice(0, 800);
}

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

  const report = (progress: JobProgress): void => {
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

  await ensureDir(jobDir);
  await ensureDir(config.workDir);
  await ensureDir(config.libraryDir);
  await ensureDir(config.cacheDir);

  try {
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
      },
      signal,
    );
    throwIfAborted(signal);
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
      if (videoGen) {
        report({
          stage: "videogen",
          percent: Math.round(50 + (index / plans.length) * 14),
          message: `AI 生成画面 ${index + 1}/${plans.length}`,
        });
        try {
          const generated: GeneratedClip = await videoGen.generate(
            {
              prompt: buildVideoPrompt(normalizedTopic, plan.segment),
              durationSec: Math.min(config.videoGen.clipDurationSec, Math.max(2, plan.durationSec)),
            },
            path.join(jobDir, "generated"),
            signal,
          );
          plan.generated = generated;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!config.videoGen.fallbackToMaterials) throw error;
          logger.warn(
            `分镜 ${index + 1} AI 画面生成失败，回退素材匹配：${toErrorMessage(error)}`,
          );
        }
      }
      if (!plan.generated) {
        const material = matchMaterial(plan.segment, materials, {
          allowUnmatched: config.materials.allowUnmatched,
          usedIds,
        });
        if (material) usedIds.add(material.id);
        plan.material = material;
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
      generated: plan.generated
        ? { provider: plan.generated.provider, model: plan.generated.model }
        : undefined,
    }));

    const videoProbe = await probeMedia(outputFile);
    const result: PipelineResult = {
      jobId,
      topic: normalizedTopic,
      createdAt,
      finishedAt,
      durationSec: round3(finalDuration || videoProbe.durationSec || cursor),
      videoPath: outputFile,
      posterPath,
      srtPath,
      scriptPath,
      resultPath,
      script,
      segments: segmentResults,
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
    await writeJsonFile(path.join(jobDir, "error.json"), {
      message: toErrorMessage(error),
      code: error instanceof AppError ? error.code : "PIPELINE_FAILED",
      stack: error instanceof Error ? error.stack : undefined,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
}
import { TTS_PROVIDER_NAMES } from "../types.js";
import type {
  AppConfig,
  CastAsset,
  JobOptions,
  JobProgress,
  JobStage,
  PipelineResult,
  Script,
  SegmentResult,
  TtsProviderName,
  VideoInfo,
} from "../types.js";
import type { Logger } from "../logger.js";
import { createJobId, runPipeline } from "../pipeline.js";
import { AppError, toErrorMessage } from "../errors.js";
import { STORY_MAX_LENGTH } from "../preflight.js";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  topic: string;
  options: JobOptions;
  state: JobState;
  progress: JobProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: PipelineResult;
  error?: string;
  /** 任务失败时所在的阶段，便于界面提示“失败于哪一步”。 */
  errorStage?: JobStage;
  /** 任务创建时的配置快照，保证运行期间设置变更不影响本任务。 */
  config: AppConfig;
}

export interface SerializedJob {
  id: string;
  topic: string;
  options: JobOptions;
  state: JobState;
  progress: JobProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  videoUrl?: string;
  posterUrl?: string;
  subtitlesUrl?: string;
  scriptUrl?: string;
  resultUrl?: string;
  error?: string;
  errorStage?: JobStage;
  script?: Script;
  story?: string;
  cast?: Array<Pick<CastAsset, "id" | "name" | "kind" | "description" | "imageFile">>;
  warnings?: string[];
  segments?: SegmentResult[];
  video?: VideoInfo;
}


export function validateOptions(options: JobOptions, config: AppConfig): void {
  if (options.targetDurationSec !== undefined) {
    if (
      !Number.isFinite(options.targetDurationSec) ||
      options.targetDurationSec < 5 ||
      options.targetDurationSec > 600
    ) {
      throw new AppError("目标时长必须在 5 到 600 秒之间", { code: "INVALID_OPTIONS", status: 400 });
    }
  }
  if (options.maxSegments !== undefined) {
    if (!Number.isFinite(options.maxSegments) || options.maxSegments < 1 || options.maxSegments > 20) {
      throw new AppError("分镜数量必须在 1 到 20 之间（1 表示一镜到底）", { code: "INVALID_OPTIONS", status: 400 });
    }
  }
  if (options.ttsProvider !== undefined && !TTS_PROVIDER_NAMES.includes(options.ttsProvider)) {
    throw new AppError(`不支持的配音供应商：${options.ttsProvider}`, {
      code: "INVALID_OPTIONS",
      status: 400,
    });
  }
  if (options.voice !== undefined && (!options.voice.trim() || options.voice.length > 120)) {
    throw new AppError("音色名称不能为空且不能超过 120 个字符", {
      code: "INVALID_OPTIONS",
      status: 400,
    });
  }
  if (options.videoGenEnabled && config.videoGen.provider === "none") {
    throw new AppError("尚未配置 AI 画面生成模型，请先在设置中启用", {
      code: "VIDEOGEN_NOT_CONFIGURED",
      status: 400,
    });
  }
  if (options.story !== undefined) {
    if (typeof options.story !== "string") {
      throw new AppError("剧本/大纲必须是文本", { code: "INVALID_OPTIONS", status: 400 });
    }
    if (options.story.trim().length > STORY_MAX_LENGTH) {
      throw new AppError(`剧本/大纲不能超过 ${STORY_MAX_LENGTH} 个字符`, {
        code: "INVALID_OPTIONS",
        status: 400,
      });
    }
  }
  if (options.dialogue !== undefined && options.dialogue !== true && options.dialogue !== false) {
    throw new AppError("对话模式开关必须是布尔值", { code: "INVALID_OPTIONS", status: 400 });
  }
  if (options.castIds !== undefined) {
    if (!Array.isArray(options.castIds) || options.castIds.some((id) => typeof id !== "string")) {
      throw new AppError("castIds 必须是角色/道具 id 数组", { code: "INVALID_OPTIONS", status: 400 });
    }
    if (options.castIds.length > 30) {
      throw new AppError("单个视频最多选择 30 个角色/道具", { code: "INVALID_OPTIONS", status: 400 });
    }
  }
}

/** 把单次任务选项应用到配置副本，不修改全局配置。 */
export function buildJobConfig(config: AppConfig, options: JobOptions): AppConfig {
  const next = structuredClone(config);
  if (options.targetDurationSec !== undefined) {
    next.script.targetDurationSec = Math.round(options.targetDurationSec);
  }
  if (options.maxSegments !== undefined) {
    next.script.maxSegments = Math.round(options.maxSegments);
  }
  if (options.ttsProvider !== undefined) next.tts.provider = options.ttsProvider;
  if (options.voice !== undefined) next.tts.voice = options.voice.trim();
  if (options.subtitlesEnabled !== undefined) next.subtitles.enabled = options.subtitlesEnabled;
  if (options.allowUnmatched !== undefined) next.materials.allowUnmatched = options.allowUnmatched;
  if (options.videoGenEnabled === false) next.videoGen.provider = "none";
  if (next.tts.provider === "openai" && !next.tts.apiKey) {
    throw new AppError("配音供应商为 openai 但未配置 API Key", {
      code: "CONFIG_MISSING_API_KEY",
      status: 400,
    });
  }
  return next;
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private draining = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  create(topic: string, options: JobOptions = {}): JobRecord {
    validateOptions(options, this.config);
    const jobConfig = buildJobConfig(this.config, options);
    const id = createJobId();
    const record: JobRecord = {
      id,
      topic,
      options,
      state: "queued",
      progress: { stage: "queued", percent: 0, message: "等待执行" },
      createdAt: new Date().toISOString(),
      config: jobConfig,
    };
    this.jobs.set(id, record);
    this.queue.push(id);
    this.logger.info(`任务入队：${id}（${topic}）`);
    setImmediate(() => {
      void this.drain();
    });
    return record;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  serialize(record: JobRecord, detail = false): SerializedJob {
    const base = `/api/videos/${record.id}`;
    return {
      id: record.id,
      topic: record.topic,
      options: record.options,
      state: record.state,
      progress: record.progress,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationSec: record.result?.durationSec,
      videoUrl: record.state === "succeeded" ? `${base}/video` : undefined,
      posterUrl: record.state === "succeeded" && record.result?.posterPath ? `${base}/poster` : undefined,
      subtitlesUrl: record.state === "succeeded" ? `${base}/subtitles` : undefined,
      scriptUrl: record.state === "succeeded" ? `${base}/script` : undefined,
      resultUrl: record.state === "succeeded" ? `${base}/result` : undefined,
      error: record.error,
      errorStage: record.errorStage,
      ...(detail && record.result
        ? {
            script: record.result.script,
            story: record.result.story,
            cast: record.result.cast,
            warnings: record.result.warnings,
            segments: record.result.segments,
            video: record.result.video,
          }
        : {}),
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        const record = this.jobs.get(id);
        if (!record) continue;
        record.state = "running";
        record.startedAt = new Date().toISOString();
        record.progress = { stage: "script", percent: 1, message: "开始生成" };
        this.logger.info(`任务开始：${id}`);
        try {
          const result = await runPipeline({
            topic: record.topic,
            config: record.config,
            logger: this.logger,
            jobId: id,
            story: record.options.story,
            castIds: record.options.castIds,
            dialogue: record.options.dialogue,
            onProgress: (progress) => {
              record.progress = progress;
            },
          });
          record.result = result;
          record.state = "succeeded";
          record.finishedAt = new Date().toISOString();
          record.progress = { stage: "done", percent: 100, message: "成片已生成" };
          this.logger.info(`任务完成：${id}（${result.durationSec.toFixed(1)}s）`);
        } catch (error) {
          record.state = "failed";
          record.error = toErrorMessage(error);
          record.errorStage = record.progress.stage;
          record.finishedAt = new Date().toISOString();
          record.progress = { ...record.progress, message: "任务失败" };
          this.logger.error(`任务失败：${id}`, error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

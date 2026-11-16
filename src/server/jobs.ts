import path from "node:path";
import fsp from "node:fs/promises";
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
import { concatSegments } from "../render/concat.js";
import { extractPoster } from "../media/ffmpeg.js";
import { DashScopeVideoEditProvider } from "../videoedit/dashscope.js";
import type { VideoEditRequest, VideoEditResult } from "../videoedit/dashscope.js";
import { sha256 } from "../util/fs.js";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface JobVideoEditProvider {
  edit(request: VideoEditRequest): Promise<VideoEditResult>;
}

export type VideoEditProviderFactory = (
  settings: AppConfig["videoGen"],
  logger: Logger,
) => JobVideoEditProvider;

export interface VideoEditState {
  status: "running" | "succeeded" | "failed";
  segmentIndex: number;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

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
  /** 最近一次分镜局部编辑的状态。 */
  edit?: VideoEditState;
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
  edit?: VideoEditState;
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
    private readonly videoEditFactory: VideoEditProviderFactory = (settings, logger) =>
      new DashScopeVideoEditProvider(settings, logger),
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
    // 局部修改后给播放器地址加版本号，避免浏览器继续用旧成片缓存。
    const version = record.edit?.finishedAt ? `?v=${encodeURIComponent(record.edit.finishedAt)}` : "";
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
      videoUrl: record.state === "succeeded" ? `${base}/video${version}` : undefined,
      posterUrl:
        record.state === "succeeded" && record.result?.posterPath ? `${base}/poster${version}` : undefined,
      subtitlesUrl: record.state === "succeeded" ? `${base}/subtitles` : undefined,
      scriptUrl: record.state === "succeeded" ? `${base}/script` : undefined,
      resultUrl: record.state === "succeeded" ? `${base}/result` : undefined,
      error: record.error,
      errorStage: record.errorStage,
      edit: record.edit,
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

  /**
   * 对一个已完成任务的分镜做局部修改：调用视频编辑模型重绘画面，保留原音轨，
   * 再用新的分镜重新拼接成片。编辑是异步的，接口先返回 202，前端轮询任务详情。
   */
  startVideoEdit(id: string, segmentIndex: number, prompt: string): JobRecord {
    const record = this.jobs.get(id);
    if (!record) {
      throw new AppError("任务不存在", { code: "JOB_NOT_FOUND", status: 404 });
    }
    if (record.state !== "succeeded" || !record.result) {
      throw new AppError("只有已生成完成的任务才能局部修改", { code: "JOB_NOT_EDITABLE", status: 409 });
    }
    if (record.edit?.status === "running") {
      throw new AppError("这个任务正在局部修改，请等当前修改完成", { code: "JOB_EDIT_RUNNING", status: 409 });
    }
    const segment = record.result.segments[segmentIndex - 1];
    if (!segment?.renderedFile) {
      throw new AppError("找不到要修改的分镜", { code: "JOB_SEGMENT_NOT_FOUND", status: 404 });
    }
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new AppError("请填写局部修改要求", { code: "JOB_EDIT_PROMPT_EMPTY", status: 400 });
    }
    if (trimmed.length > 2000) {
      throw new AppError("局部修改要求不能超过 2000 字", { code: "JOB_EDIT_PROMPT_TOO_LONG", status: 400 });
    }
    record.edit = {
      status: "running",
      segmentIndex,
      prompt: trimmed,
      startedAt: new Date().toISOString(),
    };
    void this.runVideoEdit(record, segmentIndex, trimmed);
    return record;
  }

  private async runVideoEdit(record: JobRecord, segmentIndex: number, prompt: string): Promise<void> {
    const result = record.result;
    if (!result) return;
    const jobDir = path.dirname(result.videoPath);
    const segment = result.segments[segmentIndex - 1];
    try {
      if (!segment?.renderedFile) throw new AppError("找不到要修改的分镜", { code: "JOB_SEGMENT_NOT_FOUND" });
      const sourceFile = path.resolve(jobDir, segment.renderedFile);
      if (!sourceFile.startsWith(`${jobDir}${path.sep}`)) {
        throw new AppError("分镜文件路径异常", { code: "JOB_SEGMENT_NOT_FOUND" });
      }
      const editsDir = path.join(jobDir, "edits");
      await fsp.mkdir(editsDir, { recursive: true });
      const outputFile = path.join(editsDir, `segment-${String(segmentIndex).padStart(2, "0")}-${Date.now()}.mp4`);
      const provider = this.videoEditFactory(record.config.videoGen, this.logger);
      this.logger.info(`开始局部修改任务 ${record.id} 分镜 ${segmentIndex}：${prompt}`);
      const edited = await provider.edit({
        sourceFile,
        prompt,
        outputFile,
        durationSec: segment.durationSec,
        config: record.config,
        logger: this.logger,
      });

      const segmentFiles = result.segments.map((item, index) => {
        if (index === segmentIndex - 1) return edited.file;
        if (!item.renderedFile) throw new AppError("有分镜缺少渲染文件，无法重新拼接", { code: "JOB_SEGMENT_NOT_FOUND" });
        return path.resolve(jobDir, item.renderedFile);
      });
      const tempFinal = path.join(jobDir, `final-edit-${Date.now()}.mp4`);
      const durationSec = await concatSegments({
        segmentFiles,
        outputFile: tempFinal,
        jobDir,
        config: record.config,
        logger: this.logger,
      });
      await fsp.rename(tempFinal, result.videoPath);
      const posterFile = result.posterPath ?? path.join(jobDir, "poster.jpg");
      await extractPoster(result.videoPath, posterFile)
        .then(() => {
          result.posterPath = posterFile;
        })
        .catch((error) => {
          this.logger.warn(`局部修改后更新封面失败（不影响成片）：${toErrorMessage(error)}`);
        });

      segment.renderedFile = path.relative(jobDir, edited.file).split(path.sep).join("/");
      segment.renderedSha256 = sha256((await fsp.readFile(edited.file)).toString("base64"));
      segment.edited = true;
      segment.editPrompt = prompt;
      result.durationSec = durationSec;
      await fsp.writeFile(path.join(jobDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
      record.edit = {
        ...record.edit!,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
      };
      this.logger.info(`局部修改完成：${record.id} 分镜 ${segmentIndex}`);
    } catch (error) {
      record.edit = {
        ...record.edit!,
        status: "failed",
        error: toErrorMessage(error),
        finishedAt: new Date().toISOString(),
      };
      this.logger.error(`局部修改失败：${record.id} 分镜 ${segmentIndex}`, error);
    }
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
            script: record.options.script,
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

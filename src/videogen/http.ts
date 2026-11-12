import fsp from "node:fs/promises";
import path from "node:path";
import type { GeneratedClip, VideoGenProvider, VideoGenRequest, VideoGenSettings } from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";
import { probeMedia } from "../media/ffmpeg.js";
import { ensureDir, sha256 } from "../util/fs.js";

const SUCCESS_STATES = new Set(["succeeded", "success", "completed", "complete", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "failure", "error", "canceled", "cancelled"]);
const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 兼容裸响应、{data} 包裹与常见字段命名，避免绑定单一供应商。 */
function unwrap(json: unknown): Record<string, unknown> {
  if (!isRecord(json)) return {};
  return isRecord(json.data) ? { ...json, ...json.data } : json;
}

function isUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

/** 明确表示“这是成片地址”的字段。 */
const VIDEO_URL_KEYS = new Set([
  "video_url",
  "videourl",
  "download_url",
  "downloadurl",
  "file_url",
  "fileurl",
  "result_url",
  "resulturl",
  "output_url",
  "outputurl",
  "play_url",
  "playurl",
  "video_uri",
  "media_url",
]);
/** 结构特殊时也能兜底的通用地址字段。 */
const GENERIC_URL_KEYS = new Set(["url", "uri", "href", "src", "link"]);
/** 容器字段，继续往下找。 */
const CONTAINER_KEYS = new Set([
  "data",
  "result",
  "results",
  "output",
  "outputs",
  "task",
  "tasks",
  "job",
  "payload",
  "response",
  "content",
  "items",
  "list",
  "video",
  "videos",
  "file",
  "files",
  "asset",
  "assets",
  "artifacts",
  "generations",
]);
/** 封面、缩略图之类不是成片。 */
const NON_VIDEO_KEY = /(cover|thumb|thumbnail|poster|image|img|avatar|icon|logo|sprite|qr_?code|preview_image|watermark)/i;
const MAX_WALK_DEPTH = 6;

/**
 * 视频地址字段的兼容解析。
 *
 * 聚合平台的返回结构差异很大：有的直接给 video_url，有的包成
 * {code:0,data:{status:"completed",output:{video_url:"..."}}}，
 * 还有的给 data[0].url 或 result.videos[0].file_url。这里按字段语义递归查找，
 * 优先选“明确是成片”的字段，其次才是通用 url，并跳过封面/缩略图。
 */
function findVideoUrl(json: unknown): string | undefined {
  let best: { url: string; score: number } | undefined;
  const consider = (key: string, raw: string): void => {
    const url = raw.trim();
    if (!isUrlLike(url)) return;
    const lower = key.toLowerCase();
    let score = 0;
    if (VIDEO_URL_KEYS.has(lower)) score = 3;
    else if (GENERIC_URL_KEYS.has(lower) || CONTAINER_KEYS.has(lower)) score = 2;
    else return;
    if (!best || score > best.score) best = { url, score };
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (NON_VIDEO_KEY.test(key)) continue;
      if (typeof child === "string") {
        consider(key, child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(json, 0);
  return best?.url;
}

const STATUS_KEYS = new Set(["status", "state", "task_status", "taskstate", "job_status", "progress_status"]);
const STATUS_CONTAINER_KEYS = new Set(["data", "result", "task", "job", "payload", "response", "output"]);

/** 状态字段同样兼容嵌套：data.status、data.task.status 等。 */
function pickStatus(json: unknown): string {
  let best: { status: string; score: number } | undefined;
  const walk = (value: unknown, depth: number, containerKey: string): void => {
    if (depth > 4 || value === null || value === undefined || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, containerKey);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (typeof child === "string" && STATUS_KEYS.has(lower)) {
        const score = (STATUS_KEYS.has(lower) ? 2 : 1) + (STATUS_CONTAINER_KEYS.has(containerKey) ? 1 : 0);
        if (!best || score > best.score) best = { status: child.trim().toLowerCase(), score };
        continue;
      }
      walk(child, depth + 1, lower);
    }
  };
  walk(json, 0, "");
  return best?.status ?? "";
}

function readPath(json: unknown, path: string): unknown {
  let current: unknown = json;
  for (const raw of path.split(".")) {
    const key = raw.trim();
    if (!key) continue;
    const index = /^\[(\d+)\]$/.exec(key);
    if (index) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index[1])];
      continue;
    }
    if (Array.isArray(current)) {
      const numeric = Number(key);
      if (!Number.isInteger(numeric) || numeric < 0) return undefined;
      current = current[numeric];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function pickTaskId(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const flat = unwrap(json);
  const direct = pickString(flat, ["id", "task_id", "taskId", "job_id", "jobId", "request_id"]);
  if (direct) return direct;
  if (isRecord(flat.task)) return pickString(flat.task, ["id", "task_id", "taskId"]);
  return undefined;
}

function pickError(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const flat = unwrap(json);
  const message = flat.error ?? flat.message ?? flat.msg ?? flat.error_message ?? flat.fail_reason;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (isRecord(message)) {
    const nested = pickString(message, ["message", "detail", "reason"]);
    if (nested) return nested;
  }
  return undefined;
}

/** 返回结构摘要，截断长字符串，避免日志与错误信息过长。 */
function describeJson(json: unknown): string {
  try {
    return JSON.stringify(json, (_key, value) =>
      typeof value === "string" && value.length > 120 ? `${value.slice(0, 60)}…${value.slice(-20)}` : value,
    ).slice(0, 400);
  } catch {
    return String(json);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取本地参考图并转成 data URL，避免把本机路径暴露给生成服务。 */
async function readImageDataUrl(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new AppError(`参考图格式不支持：${path.basename(file)}（支持 jpg/png/webp）`, {
      code: "VIDEOGEN_REFERENCE_INVALID",
      status: 400,
    });
  }
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    throw new AppError(`参考图无法读取：${path.basename(file)}`, {
      code: "VIDEOGEN_REFERENCE_INVALID",
      status: 400,
      cause: error,
    });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new AppError(`参考图无法读取：${path.basename(file)}`, {
      code: "VIDEOGEN_REFERENCE_INVALID",
      status: 400,
    });
  }
  if (stat.size > MAX_REFERENCE_BYTES) {
    throw new AppError(`参考图超过 ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)}MB：${path.basename(file)}`, {
      code: "VIDEOGEN_REFERENCE_INVALID",
      status: 400,
    });
  }
  const buffer = await fsp.readFile(file);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new AppError("AI 画面生成已取消", { code: "ABORTED", status: 499 });
}

export interface HttpVideoGenDeps {
  fetchImpl?: typeof fetch;
}

/**
 * 画面生成已提交（可能已计费）但本次没等到成片。
 *
 * 超时、轮询用尽或提交响应丢失都不等于生成失败：平台通常已经受理并可能已扣费。
 * 调用方应把任务 ID 交给用户，并复用该任务继续查询，而不是重新提交一次付费请求。
 */
export class VideoGenPendingError extends AppError {
  readonly taskId?: string;
  readonly submitted: boolean;
  readonly lastStatus: string;

  constructor(options: {
    message: string;
    taskId?: string;
    submitted: boolean;
    lastStatus?: string;
  }) {
    super(options.message, { code: "VIDEOGEN_PENDING", status: 504 });
    this.name = "VideoGenPendingError";
    this.taskId = options.taskId;
    this.submitted = options.submitted;
    this.lastStatus = options.lastStatus ?? "";
  }
}

/**
 * 通用 HTTP 文生/图生视频适配器。约定：
 *  - POST {baseUrl}{submitPath}  JSON {model, prompt, duration_sec, aspect_ratio}
 *    图生视频时额外携带 image（首帧/主参考图，data URL）与
 *    reference_images（[{role, name, image}]，角色/道具参考图），
 *    → 立即返回 video_url，或返回 {id}/{task_id} 供轮询；
 *  - GET {baseUrl}{pollPath}（{id} 替换为任务 ID）
 *    → {status, video_url}，状态 succeeded/failed 等；
 *  - 生成完成后下载视频并使用 ffprobe 校验。
 * 返回字段兼容 {data: {...}} 包裹，方便对接各类 OpenAI 兼容网关。
 */
export class HttpVideoGenProvider implements VideoGenProvider {
  readonly name = "http";
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(
    private readonly settings: VideoGenSettings,
    private readonly logger: Logger,
    deps: HttpVideoGenDeps = {},
  ) {
    this.model = settings.model;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.settings.apiKey) headers.authorization = `Bearer ${this.settings.apiKey}`;
    return headers;
  }

  private withTimeout(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    if (!signal) return timeout;
    return AbortSignal.any([signal, timeout]);
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      throw new AppError(`无法连接画面生成服务：${toErrorMessage(error)}`, {
        code: "VIDEOGEN_REQUEST_FAILED",
        status: 502,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(
        `画面生成服务返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ""}`,
        { code: "VIDEOGEN_REQUEST_FAILED", status: 502 },
      );
    }
    try {
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      throw new AppError("画面生成服务返回的不是 JSON", {
        code: "VIDEOGEN_INVALID_RESPONSE",
        status: 502,
      });
    }
  }

  /** 优先使用配置的点号路径，其次按常见字段语义自动识别。 */
  private videoUrlOf(json: unknown): string | undefined {
    const configured = this.settings.resultPath?.trim();
    if (configured) {
      const value = readPath(json, configured);
      if (typeof value === "string" && isUrlLike(value.trim())) return value.trim();
      this.logger.warn(`配置的视频地址字段 ${configured} 没有取到地址，回退到自动识别`);
    }
    return findVideoUrl(json);
  }

  private async waitForVideoUrl(taskId: string, signal: AbortSignal): Promise<string> {
    const pollUrl = `${this.baseUrl}${this.settings.pollPath.replace("{id}", encodeURIComponent(taskId))}`;
    const deadline = Date.now() + this.settings.timeoutMs;
    let lastStatus = "";
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortReason(signal);
      const json = await this.requestJson(pollUrl, { method: "GET", headers: this.headers() }, signal);
      const videoUrl = this.videoUrlOf(json);
      if (videoUrl) return videoUrl;
      const status = pickStatus(json);
      if (status) lastStatus = status;
      if (FAILED_STATES.has(status)) {
        throw new AppError(`画面生成失败${pickError(json) ? `：${pickError(json)}` : ""}`, {
          code: "VIDEOGEN_TASK_FAILED",
          status: 502,
        });
      }
      if (SUCCESS_STATES.has(status)) {
        // 平台说完成了却没有可识别的地址：把返回结构记下来，便于针对性补字段。
        this.logger.warn(`画面生成任务 ${taskId} 已完成但未解析到视频地址：${describeJson(json)}`);
        throw new AppError(
          `画面生成任务已完成，但返回里没有可识别的视频地址：${describeJson(json)}。` +
            "可在设置页填入「视频地址字段」（如 output.video_url）后继续等待该任务，不会重新扣费。",
          { code: "VIDEOGEN_INVALID_RESPONSE", status: 502 },
        );
      }
      await sleep(this.settings.pollIntervalMs);
    }
    throw new VideoGenPendingError({
      message: `画面生成任务 ${taskId} 已提交，但 ${Math.round(this.settings.timeoutMs / 1000)} 秒内没有完成（最后状态：${lastStatus || "未知"}），平台可能已经扣费。`,
      taskId,
      submitted: true,
      lastStatus,
    });
  }

  private async download(url: string, outputDir: string, signal: AbortSignal): Promise<string> {
    const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, `${this.baseUrl}/`).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(absolute, { signal });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new AppError(`下载生成视频失败：${toErrorMessage(error)}`, {
        code: "VIDEOGEN_DOWNLOAD_FAILED",
        status: 502,
      });
    }
    if (!response.ok) {
      throw new AppError(`下载生成视频失败：HTTP ${response.status}`, {
        code: "VIDEOGEN_DOWNLOAD_FAILED",
        status: 502,
      });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new AppError("生成视频为空文件", { code: "VIDEOGEN_DOWNLOAD_FAILED", status: 502 });
    }
    await ensureDir(outputDir);
    const file = path.join(outputDir, `${sha256(`${absolute}:${Date.now()}`).slice(0, 16)}.mp4`);
    await fsp.writeFile(file, buffer);
    return file;
  }

  /** 下载成片并校验时长；这一步失败时任务本身可能已成功，不影响已扣费的事实。 */
  private async collect(videoUrl: string, outputDir: string, signal: AbortSignal): Promise<GeneratedClip> {
    const file = await this.download(videoUrl, outputDir, signal);
    const probe = await probeMedia(file);
    if (!probe.durationSec || probe.durationSec <= 0) {
      await fsp.rm(file, { force: true });
      throw new AppError("生成视频无法读取时长", { code: "VIDEOGEN_INVALID_VIDEO", status: 502 });
    }
    this.logger.info(`AI 画面已生成：${file}（${probe.durationSec.toFixed(1)}s）`);
    return {
      file,
      durationSec: probe.durationSec,
      provider: this.name,
      model: this.settings.model,
    };
  }

  /**
   * 把“已提交但没等到结果”和真正的失败区分开：只有前者会在平台侧扣费，
   * 调用方需要拿到任务 ID 复用，而不是重新提交一次付费请求。
   */
  private pendingFrom(
    error: unknown,
    options: { taskId?: string; submitted: boolean; callerSignal?: AbortSignal },
  ): unknown {
    // 只有“人主动取消”才算取消；调用方传入的超时同样属于“已扣费但没出片”。
    const callerReason = options.callerSignal?.reason as { name?: string } | undefined;
    if (options.callerSignal?.aborted && callerReason?.name !== "TimeoutError") {
      return abortReason(options.callerSignal);
    }
    if (error instanceof VideoGenPendingError) return error;
    if (error instanceof AppError && error.status < 500) return error;
    if (error instanceof AppError && error.code === "VIDEOGEN_TASK_FAILED") return error;
    if (error instanceof AppError && error.code === "VIDEOGEN_INVALID_VIDEO") return error;
    // 已完成但解析不到地址、响应格式不对：是确定的解析问题，不是“还在生成”，
    // 保留原始提示（含响应结构摘要与字段配置建议），否则用户只会看到“继续等待”。
    if (error instanceof AppError && error.code === "VIDEOGEN_INVALID_RESPONSE") return error;
    if (!options.submitted) {
      return new VideoGenPendingError({
        message:
          "提交画面生成请求时超时或连接中断，无法确认平台是否已受理。" +
          "为避免重复扣费，本次不会自动重试；请先在服务商控制台确认是否有新任务，再决定是否重新测试。",
        taskId: options.taskId,
        submitted: false,
      });
    }
    return new VideoGenPendingError({
      message:
        `画面生成已提交（任务 ${options.taskId ?? "未知"}），但在超时前没有拿到成片。` +
        "平台可能已经扣费，重新测试会复用该任务继续查询，不会重复提交。",
      taskId: options.taskId,
      submitted: true,
    });
  }

  async generate(
    request: VideoGenRequest,
    outputDir: string,
    signal?: AbortSignal,
  ): Promise<GeneratedClip> {
    const composed = this.withTimeout(signal);
    if (composed.aborted) throw abortReason(composed);
    const references = request.references ?? [];
    const cache = new Map<string, string>();
    const dataUrlFor = async (file: string): Promise<string> => {
      const cached = cache.get(file);
      if (cached) return cached;
      const dataUrl = await readImageDataUrl(file);
      cache.set(file, dataUrl);
      return dataUrl;
    };

    const image = request.image ? await dataUrlFor(request.image) : undefined;
    const referenceImages =
      references.length > 0
        ? await Promise.all(
            references.map(async (reference) => ({
              role: reference.role,
              name: reference.name,
              image: await dataUrlFor(reference.file),
            })),
          )
        : [];
    this.logger.info(
      `AI 画面生成${image ? "（图生视频）" : ""}：${this.model}，${request.durationSec.toFixed(1)}s${
        referenceImages.length > 0 ? `，${referenceImages.length} 张参考图` : ""
      }`,
    );
    const submitUrl = `${this.baseUrl}${this.settings.submitPath}`;
    let taskId: string | undefined;
    let submitted = false;
    try {
      const json = await this.requestJson(
        submitUrl,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: this.settings.model,
            prompt: request.prompt,
            duration_sec: request.durationSec,
            aspect_ratio: "9:16",
            ...(image ? { image } : {}),
            ...(referenceImages.length > 0 ? { reference_images: referenceImages } : {}),
          }),
        },
        composed,
      );
      submitted = true;
      const directUrl = this.videoUrlOf(json);
      if (directUrl) return await this.collect(directUrl, outputDir, composed);
      taskId = pickTaskId(json);
      if (!taskId) {
        throw new AppError(`画面生成服务响应缺少任务 ID 或视频地址：${JSON.stringify(json).slice(0, 300)}`, {
          code: "VIDEOGEN_INVALID_RESPONSE",
          status: 502,
        });
      }
      const videoUrl = await this.waitForVideoUrl(taskId, composed);
      return await this.collect(videoUrl, outputDir, composed);
    } catch (error) {
      throw this.pendingFrom(error, { taskId, submitted, callerSignal: signal });
    }
  }

  /** 复用已提交的任务继续查询成片，不再提交新的生成请求（因此不会重复扣费）。 */
  async resume(taskId: string, outputDir: string, signal?: AbortSignal): Promise<GeneratedClip> {
    const composed = this.withTimeout(signal);
    if (composed.aborted) throw abortReason(composed);
    this.logger.info(`复用已提交的 AI 画面任务：${taskId}`);
    try {
      const videoUrl = await this.waitForVideoUrl(taskId, composed);
      return await this.collect(videoUrl, outputDir, composed);
    } catch (error) {
      throw this.pendingFrom(error, { taskId, submitted: true, callerSignal: signal });
    }
  }
}

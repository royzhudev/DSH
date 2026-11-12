import fsp from "node:fs/promises";
import path from "node:path";
import type { GeneratedClip, VideoGenProvider, VideoGenRequest, VideoGenSettings } from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";
import { probeMedia } from "../media/ffmpeg.js";
import { ensureDir, sha256 } from "../util/fs.js";

const SUCCESS_STATES = new Set(["succeeded", "success", "completed", "complete", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "failure", "error", "canceled", "cancelled"]);

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

function pickVideoUrl(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const direct = pickString(json, ["video_url", "videoUrl", "url", "output", "video"]);
  if (direct && isUrlLike(direct)) return direct;
  const data = json.data;
  if (isRecord(data)) {
    const nested = pickString(data, ["video_url", "videoUrl", "url", "output"]);
    if (nested && isUrlLike(nested)) return nested;
    if (isRecord(data.video)) {
      const inVideo = pickString(data.video, ["url", "video_url", "download_url"]);
      if (inVideo && isUrlLike(inVideo)) return inVideo;
    }
    if (isRecord(data.result)) {
      const inResult = pickString(data.result, ["video_url", "url", "output"]);
      if (inResult && isUrlLike(inResult)) return inResult;
    }
  }
  return undefined;
}

function pickTaskId(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const flat = unwrap(json);
  return pickString(flat, ["id", "task_id", "taskId", "job_id", "jobId", "request_id"]);
}

function pickStatus(json: unknown): string {
  if (!isRecord(json)) return "";
  const flat = unwrap(json);
  const value = flat.status ?? flat.state ?? flat.task_status;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function pickError(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const flat = unwrap(json);
  const message = flat.error ?? flat.message ?? flat.error_message ?? flat.fail_reason;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (isRecord(message)) {
    const nested = pickString(message, ["message", "detail", "reason"]);
    if (nested) return nested;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new AppError("AI 画面生成已取消", { code: "ABORTED", status: 499 });
}

export interface HttpVideoGenDeps {
  fetchImpl?: typeof fetch;
}

export interface VideoGenCheckResult {
  model: string;
  taskId?: string;
  status?: string;
  videoUrlReturned: boolean;
}

/**
 * 通用 HTTP 文生视频适配器。约定：
 *  - POST {baseUrl}{submitPath}  JSON {model, prompt, duration_sec, aspect_ratio}
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

  private withTimeout(signal?: AbortSignal, maxMs?: number): AbortSignal {
    const timeout = AbortSignal.timeout(Math.min(this.settings.timeoutMs, maxMs ?? this.settings.timeoutMs));
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

  private async waitForVideoUrl(taskId: string, signal: AbortSignal): Promise<string> {
    const pollUrl = `${this.baseUrl}${this.settings.pollPath.replace("{id}", encodeURIComponent(taskId))}`;
    const deadline = Date.now() + this.settings.timeoutMs;
    let lastStatus = "";
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortReason(signal);
      const json = await this.requestJson(pollUrl, { method: "GET", headers: this.headers() }, signal);
      const videoUrl = pickVideoUrl(json);
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
        throw new AppError("画面生成任务已完成，但响应中没有视频地址", {
          code: "VIDEOGEN_INVALID_RESPONSE",
          status: 502,
        });
      }
      await sleep(this.settings.pollIntervalMs);
    }
    throw new AppError(`画面生成超时（最后状态：${lastStatus || "未知"}）`, {
      code: "VIDEOGEN_TIMEOUT",
      status: 504,
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

  /**
   * 设置页“测试配置”：按配置的单段时长提交一次生成请求并查询一次任务，
   * 验证服务地址、密钥、模型与提交/查询路径是否可用。不下载成片、不等待生成完成。
   */
  async check(signal?: AbortSignal): Promise<VideoGenCheckResult> {
    const composed = this.withTimeout(signal, 30_000);
    const submitUrl = `${this.baseUrl}${this.settings.submitPath}`;
    const json = await this.requestJson(
      submitUrl,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.settings.model,
          prompt: "配置测试：纯色渐变背景",
          duration_sec: this.settings.clipDurationSec,
          aspect_ratio: "9:16",
        }),
      },
      composed,
    );

    if (pickVideoUrl(json)) {
      return { model: this.settings.model, videoUrlReturned: true };
    }
    const taskId = pickTaskId(json);
    if (!taskId) {
      throw new AppError(`画面生成服务响应缺少任务 ID 或视频地址：${JSON.stringify(json).slice(0, 300)}`, {
        code: "VIDEOGEN_INVALID_RESPONSE",
        status: 502,
      });
    }

    const pollUrl = `${this.baseUrl}${this.settings.pollPath.replace("{id}", encodeURIComponent(taskId))}`;
    const pollJson = await this.requestJson(pollUrl, { method: "GET", headers: this.headers() }, composed);
    const status = pickStatus(pollJson);
    if (FAILED_STATES.has(status)) {
      throw new AppError(`画面生成任务失败${pickError(pollJson) ? `：${pickError(pollJson)}` : ""}`, {
        code: "VIDEOGEN_TASK_FAILED",
        status: 502,
      });
    }
    const videoUrlReturned = Boolean(pickVideoUrl(pollJson));
    if (!status && !videoUrlReturned) {
      throw new AppError("画面生成查询接口的响应缺少状态或视频地址", {
        code: "VIDEOGEN_INVALID_RESPONSE",
        status: 502,
      });
    }
    return {
      model: this.settings.model,
      taskId,
      status: status || "pending",
      videoUrlReturned,
    };
  }

  async generate(
    request: VideoGenRequest,
    outputDir: string,
    signal?: AbortSignal,
  ): Promise<GeneratedClip> {
    const composed = this.withTimeout(signal);
    if (composed.aborted) throw abortReason(composed);
    this.logger.info(`AI 画面生成：${this.model}，${request.durationSec.toFixed(1)}s`);
    const submitUrl = `${this.baseUrl}${this.settings.submitPath}`;
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
        }),
      },
      composed,
    );

    let videoUrl = pickVideoUrl(json);
    if (!videoUrl) {
      const taskId = pickTaskId(json);
      if (!taskId) {
        throw new AppError(`画面生成服务响应缺少任务 ID 或视频地址：${JSON.stringify(json).slice(0, 300)}`, {
          code: "VIDEOGEN_INVALID_RESPONSE",
          status: 502,
        });
      }
      videoUrl = await this.waitForVideoUrl(taskId, composed);
    }

    const file = await this.download(videoUrl, outputDir, composed);
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
}

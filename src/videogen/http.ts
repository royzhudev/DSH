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

const MAX_SCAN_DEPTH = 6;
const IMAGE_HINTS = /thumb|poster|cover|image|img|pic|avatar|icon|qrcode/i;
const VIDEO_HINTS = /video|mp4|download|play|file|asset|output|media|result/i;

/** 广度优先遍历响应中的所有对象（含数组元素），兼容聚合平台的各种包装与嵌套。 */
function scanRecords(json: unknown, maxLevel = MAX_SCAN_DEPTH): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const queue: Array<{ node: unknown; level: number }> = [{ node: json, level: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.level > maxLevel) continue;
    const node = current.node;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) queue.push({ node: item, level: current.level + 1 });
      continue;
    }
    if (!isRecord(node)) continue;
    records.push(node);
    for (const value of Object.values(node)) {
      if (typeof value === "object" && value !== null) {
        queue.push({ node: value, level: current.level + 1 });
      }
    }
  }
  return records;
}

/**
 * 找成片地址。不同聚合平台把链接放在 video_url、data[0].url、output.video_url、
 * result.videos[].url 等位置，这里统一扫描并按“像不像视频链接”打分，避免字段名不兼容。
 */
function pickVideoUrl(json: unknown): string | undefined {
  let best: { url: string; score: number } | undefined;
  for (const record of scanRecords(json)) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string" || !isUrlLike(value)) continue;
      const lowerKey = key.toLowerCase();
      const lowerValue = value.toLowerCase();
      let score = 0;
      if (VIDEO_HINTS.test(lowerKey)) score += 6;
      if (/\.(mp4|mov|webm|mkv|m4v)(\?|$)/.test(lowerValue)) score += 5;
      if (/^(url|uri|link|src|href|path|output|file|download_url|video_url|videoUrl)$/.test(lowerKey)) score += 3;
      if (IMAGE_HINTS.test(lowerKey)) score -= 12;
      if (/\.(jpg|jpeg|png|webp|gif|bmp|svg)(\?|$)/.test(lowerValue)) score -= 12;
      if (score > 0 && (!best || score > best.score)) best = { url: value, score };
    }
  }
  return best?.url;
}

function pickTaskId(json: unknown): string | undefined {
  const flat = unwrap(json);
  // 阿里百炼（DashScope）把任务 ID 放在 output.task_id，响应里同时还有 request_id（请求 ID，不是任务 ID）。
  if (isRecord(flat.output)) {
    const nested = pickString(flat.output, ["task_id", "taskId", "id"]);
    if (nested) return nested;
  }
  const direct = pickString(flat, ["id", "task_id", "taskId", "job_id", "jobId"]);
  if (direct) return direct;
  if (isRecord(flat.task)) return pickString(flat.task, ["id", "task_id", "taskId"]);
  return pickString(flat, ["request_id"]);
}

/** 状态字段同样可能出现在 data、数组元素或更深层的包装里。 */
function pickStatus(json: unknown): string {
  for (const record of scanRecords(json, 3)) {
    const value = record.status ?? record.state ?? record.task_status;
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

function pickError(json: unknown): string | undefined {
  for (const record of scanRecords(json, 3)) {
    const message = record.error ?? record.message ?? record.error_message ?? record.fail_reason;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (isRecord(message)) {
      const nested = pickString(message, ["message", "detail", "reason"]);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** 读点号路径，支持 data.result.videos[0].file_url 这种下标写法。 */
function readPath(json: unknown, path: string): unknown {
  let current: unknown = json;
  for (const raw of path.split(".")) {
    const segment = raw.trim();
    if (!segment) continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const key = match[1];
    if (key) {
      if (Array.isArray(current)) {
        const numeric = Number(key);
        if (!Number.isInteger(numeric) || numeric < 0) return undefined;
        current = current[numeric];
      } else if (isRecord(current)) {
        current = current[key];
      } else {
        return undefined;
      }
    }
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index[1])];
    }
  }
  return current;
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

/**
 * 把平台返回的 HTTP 错误整理成可执行的提示：优先取 {code, message}，
 * 再按常见原因（密钥、限流、时长/尺寸/模型参数）补一句该怎么改。
 */
function httpFailureMessage(status: number, text: string, requestUrl = ""): string {
  let detail = "";
  let code = "";
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const record = isRecord(parsed) ? parsed : undefined;
      const message = record?.message ?? record?.msg ?? record?.error;
      if (typeof message === "string" && message.trim()) detail = message.trim();
      if (typeof record?.code === "string") code = record.code;
      else if (typeof record?.error_code === "string") code = record.error_code;
    } catch {
      detail = text.slice(0, 300);
    }
  }
  const where =
    requestUrl && (status === 403 || status === 404) ? `（请求地址：${requestUrl}）` : "";
  const head = `画面生成服务返回 HTTP ${status}${code ? `（${code}）` : ""}${detail ? `：${detail}` : ""}${where}`;
  const lower = `${code} ${detail}`.toLowerCase();
  const hints: string[] = [];
  // "asynchronous" 里包含 "synchronous"，必须先判异步，否则两种提示会同时命中。
  const asyncCallIssue = /does not support asynchronous calls|不支持异步调用/i.test(`${code} ${detail}`);
  const syncCallIssue = !asyncCallIssue && /does not support synchronous calls|不支持同步调用/i.test(`${code} ${detail}`);
  const syncHint =
    "该接口只支持异步调用，提交需要请求头 X-DashScope-Async: enable；把接口协议设为「自动」或「阿里百炼 DashScope」即可（百炼域名会自动加上）";
  const asyncHint =
    "该接口只支持同步调用，请求里不能带 X-DashScope-Async；提交已自动改为同步重试一次，任务查询始终不带该头；若仍失败请核对模型名与提交路径是否属于同一个接口";
  if ((status === 401 || status === 403) && !syncCallIssue && !asyncCallIssue) {
    hints.push("API Key 无效、过期或没有该模型的权限");
  }
  if (status === 429 || /throttl|rate.?limit|quota|limit.*exceed|并发/.test(lower)) {
    hints.push("平台限流或并发已满，稍等再试；已提交的任务可在设置页继续查询，不要重复提交");
  }
  if (/duration|时长|seconds|秒/.test(lower)) hints.push("该模型可能不支持所填时长（百炼 Wan 常见为 5 秒，可先改用 5 秒）");
  if (/size|resolution|分辨率|像素|aspect/.test(lower)) hints.push("画面尺寸不被接受，可填 720*1280 或 1280*720");
  if (/model/.test(lower)) hints.push("模型名称不被平台接受，核对模型名是否与服务商一致");
  if (/prompt|描述/.test(lower)) hints.push("描述可能触发了内容审核，换个说法再试");
  if (syncCallIssue) hints.push(syncHint);
  if (asyncCallIssue) hints.push(asyncHint);
  return hints.length > 0 ? `${head}。提示：${hints.join("；")}` : head;
}

/**
 * 判断请求是不是发往阿里百炼（DashScope）的视频接口。
 * 百炼的 video-synthesis 只支持异步调用，缺了 X-DashScope-Async 会报
 * “current user api does not support synchronous calls”。除了按域名判断，
 * 也识别百炼的提交路径，避免自定义域名/反向代理下漏加异步头。
 */
function isDashScopeEndpoint(baseUrl: string, submitPath: string): boolean {
  const host = baseUrl
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/.test(host)) return true;
  return /\/services\/aigc\/video-generation\//.test(submitPath);
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
/**
 * 平台明确表态过的异步/同步模式，按“地址+路径+模型”记在进程里。
 * 百炼不同模型对 X-DashScope-Async 的要求不一样，记住后就不必每次先被 403 拒一次。
 */
const negotiatedAsyncMode = new Map<string, "enable" | null>();

export class HttpVideoGenProvider implements VideoGenProvider {
  readonly name = "http";
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private warnedDashScopeProtocol = false;
  /**
   * 提交/查询时要不要带 X-DashScope-Async。
   * 百炼不同接口对异步支持不一样：视频合成只支持异步，图片类等只支持同步。
   * 平台用 403 AccessDenied 明确告诉我们方向时，自动切换一次并记住，
   * 用户就不用去猜“到底该不该带这个头”。
   */
  private asyncHeader: "enable" | null = null;
  private readonly asyncModeKey: string;
  private readonly baseUrl: string;
  /** 竖屏短剧默认 720P；万相 3.0 用 resolution+ratio，不再传 size。 */
  private readonly DASHSCOPE_RESOLUTION = "720P";
  private readonly DASHSCOPE_RATIO = "9:16";

  constructor(
    private readonly settings: VideoGenSettings,
    private readonly logger: Logger,
    deps: HttpVideoGenDeps = {},
  ) {
    this.model = settings.model;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    const cacheKey = `${this.baseUrl}|${settings.submitPath}|${settings.model}`;
    this.asyncModeKey = cacheKey;
    this.asyncHeader = negotiatedAsyncMode.has(cacheKey)
      ? (negotiatedAsyncMode.get(cacheKey) ?? null)
      : this.protocol() === "dashscope"
        ? "enable"
        : null;
  }

  /** 接口协议：显式配置优先，auto 时按服务地址判断（DashScope 用异步任务接口）。 */
  private protocol(): "dashscope" | "generic" {
    const configured = this.settings.protocol;
    if (configured === "dashscope") return "dashscope";
    // 地址或提交路径已经是百炼视频接口时，必须走异步协议：
    // 百炼的 video-synthesis 不支持同步调用，协议选错会直接 AccessDenied。
    if (isDashScopeEndpoint(this.baseUrl, this.settings.submitPath)) {
      if (configured === "generic" && !this.warnedDashScopeProtocol) {
        this.warnedDashScopeProtocol = true;
        this.logger.warn("检测到阿里百炼视频接口，已自动按 DashScope 异步协议发送（忽略“通用 HTTP 契约”设置）");
      }
      return "dashscope";
    }
    return "generic";
  }

  /** withAsync 只给提交请求用：百炼的任务查询接口是同步的，带异步头会报 AccessDenied。 */
  private headers(withAsync = false): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.settings.apiKey) headers.authorization = `Bearer ${this.settings.apiKey}`;
    if (withAsync && this.asyncHeader) headers["X-DashScope-Async"] = this.asyncHeader;
    return headers;
  }

  /**
   * 按协议组装提交体。DashScope（阿里百炼）用 {model, input, parameters}，
   * 图生视频的首帧放 input.img_url；通用 HTTP 契约保持扁平字段。
   */
  private submitBody(
    request: VideoGenRequest,
    image: string | undefined,
    referenceImages: Array<{ role: string; name: string; image: string }>,
  ): Record<string, unknown> {
    if (this.protocol() === "dashscope") {
      const duration = Math.max(1, Math.round(request.durationSec));
      const wan3 = /^wan3[.\-]/i.test(this.settings.model.trim());
      return {
        model: this.settings.model,
        input: {
          prompt: request.prompt,
          // 万相 3.0 的图生视频用 media[type=first_frame]；早期模型用 img_url。
          ...(image ? (wan3 ? { media: [{ type: "first_frame", url: image }] } : { img_url: image }) : {}),
        },
        parameters: wan3
          ? { resolution: this.DASHSCOPE_RESOLUTION, ratio: this.DASHSCOPE_RATIO, duration }
          : { duration, size: "720*1280" },
      };
    }
    return {
      model: this.settings.model,
      prompt: request.prompt,
      duration_sec: request.durationSec,
      aspect_ratio: "9:16",
      ...(image ? { image } : {}),
      ...(referenceImages.length > 0 ? { reference_images: referenceImages } : {}),
    };
  }

  /** 先用配置的「视频地址字段」，取不到再回退自动识别；任务已完成时不会重新扣费。 */
  private videoUrlOf(json: unknown): string | undefined {
    const configured = this.settings.resultPath?.trim();
    if (configured) {
      const value = readPath(json, configured);
      // 允许相对地址（如 /files/clip.mp4），下载时按 baseUrl 解析。
      if (typeof value === "string" && value.trim()) return value.trim();
      this.logger.warn(`配置的视频地址字段 ${configured} 没有取到地址，回退到自动识别`);
    }
    return pickVideoUrl(json);
  }

  private withTimeout(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    if (!signal) return timeout;
    return AbortSignal.any([signal, timeout]);
  }

  /**
   * 平台说“不支持异步调用”时去掉异步头，说“不支持同步调用”时改成 enable。
   * 返回是否值得重试一次；同一实例只翻转一次，避免来回打乒乓。
   */
  private adaptAsyncMode(error: unknown): boolean {
    if (!(error instanceof AppError)) return false;
    const message = error.message;
    if (/does not support asynchronous calls/i.test(message)) {
      if (this.asyncHeader === null) return false;
      this.logger.warn("平台不支持异步调用，改为同步请求重试一次（不带 X-DashScope-Async）");
      this.asyncHeader = null;
      negotiatedAsyncMode.set(this.asyncModeKey, null);
      return true;
    }
    if (/does not support synchronous calls/i.test(message)) {
      if (this.asyncHeader === "enable") return false;
      this.logger.warn("平台要求异步调用，改为 X-DashScope-Async: enable 重试一次");
      this.asyncHeader = "enable";
      negotiatedAsyncMode.set(this.asyncModeKey, "enable");
      return true;
    }
    return false;
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
      throw new AppError(httpFailureMessage(response.status, text, url), {
        code: "VIDEOGEN_REQUEST_FAILED",
        // 4xx 是平台明确拒绝（参数、密钥、限流），原样透出，不能被当成“提交后没等到结果”。
        status: response.status >= 500 ? 502 : response.status,
      });
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
    // 任务已经建好、只是轮到查询时出错（网络、限流、4xx）：任务还在平台侧，
    // 必须带着 taskId 交回调用方继续查询，不能当成“测试失败”让用户重新提交。
    if (options.submitted && options.taskId && error instanceof AppError && error.status < 500) {
      return new VideoGenPendingError({
        message:
          `画面生成已提交（任务 ${options.taskId}），查询结果时出错：${error.message}` +
          "任务仍在平台侧生成，重新测试会复用该任务继续查询，不会重复提交或扣费。",
        taskId: options.taskId,
        submitted: true,
      });
    }
    if (error instanceof AppError && error.status < 500) return error;
    if (error instanceof AppError && error.code === "VIDEOGEN_TASK_FAILED") return error;
    if (error instanceof AppError && error.code === "VIDEOGEN_INVALID_VIDEO") return error;
    // 任务已完成却找不到成片地址：属于确定的解析失败，再次轮询也不会变好。
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
    this.logger.info(
      `提交画面生成任务：POST ${submitUrl}（${this.protocol() === "dashscope" ? "DashScope 异步协议" : "通用 HTTP 契约"}，模型 ${this.settings.model}）`,
    );
    let taskId: string | undefined;
    let submitted = false;
    try {
      const body = JSON.stringify(this.submitBody(request, image, referenceImages));
      const submit = () =>
        this.requestJson(submitUrl, { method: "POST", headers: this.headers(true), body }, composed);
      let json: unknown;
      try {
        json = await submit();
      } catch (error) {
        // 平台可能用 403 告诉我们“异步/同步用错了”，自动纠正后重发一次。
        if (!this.adaptAsyncMode(error)) throw error;
        json = await submit();
      }
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

import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig, VideoGenSettings } from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";
import { probeMedia, runFfmpeg } from "../media/ffmpeg.js";
import { ensureDir, sha256 } from "../util/fs.js";

const SUCCESS_STATES = new Set(["succeeded", "success", "completed", "complete", "done"]);
const FAILED_STATES = new Set(["failed", "failure", "error", "canceled", "cancelled"]);
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MIN_INPUT_SEC = 2;
const MAX_INPUT_SEC = 10;
/** 视频编辑比普通生成慢，百炼官方常见 5–15 分钟；这里给足 20 分钟再判超时。 */
const EDIT_TIMEOUT_MS = 20 * 60 * 1000;

export interface VideoEditRequest {
  /** 本地分镜文件（mp4）。 */
  sourceFile: string;
  prompt: string;
  /** 编辑后的分镜输出路径。 */
  outputFile: string;
  /** 最终要保留的分镜时长；编辑结果会被裁/补到这个长度，保证字幕时间轴不变。 */
  durationSec: number;
  config: AppConfig;
  logger: Logger;
  signal?: AbortSignal;
}

export interface VideoEditResult {
  file: string;
  durationSec: number;
  provider: string;
  model: string;
}

export interface VideoEditDeps {
  fetchImpl?: typeof fetch;
  /** 测试用：跳过真实视频上传，直接返回可控地址。 */
  uploadImpl?: (file: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 万相视频编辑（Wan2.7-VideoEdit）：先用百炼临时存储上传分镜，再提交异步任务，
 * 轮询拿到 output.video_url 后下载。参数与官方 video-synthesis 接口一致：
 * input.media[type=video] + input.prompt，audio_setting=origin 保留原声。
 */
export class DashScopeVideoEditProvider {
  readonly name = "dashscope";
  private readonly settings: VideoGenSettings;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly uploadImpl?: (file: string) => Promise<string>;

  constructor(settings: VideoGenSettings, logger: Logger, deps: VideoEditDeps = {}) {
    this.settings = settings;
    this.logger = logger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.uploadImpl = deps.uploadImpl;
  }

  private get model(): string {
    return this.settings.editModel?.trim() || "wan2.7-videoedit";
  }

  private headers(json = true, async = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.settings.apiKey ?? ""}`,
      ...(json ? { "content-type": "application/json" } : {}),
      ...(async ? { "X-DashScope-Async": "enable" } : {}),
    };
  }

  private async fail(response: Response, action: string): Promise<never> {
    const text = await response.text().catch(() => "");
    throw new AppError(`${action}失败（HTTP ${response.status}）：${text.slice(0, 300)}`, {
      code: "VIDEO_EDIT_FAILED",
      status: 502,
    });
  }

  /** 上传本地分镜到百炼临时存储，返回 oss:// 临时地址。 */
  private async upload(file: string): Promise<string> {
    if (this.uploadImpl) return this.uploadImpl(file);
    const policyUrl = new URL("/api/v1/uploads", this.settings.baseUrl);
    policyUrl.searchParams.set("action", "getPolicy");
    policyUrl.searchParams.set("model", this.model);
    const policyResponse = await this.fetchImpl(policyUrl, { headers: this.headers(false) });
    if (!policyResponse.ok) await this.fail(policyResponse, "获取视频上传凭证");
    const policy = ((await policyResponse.json()) as { data?: Record<string, unknown> }).data;
    if (!policy) {
      throw new AppError("百炼临时存储返回的上传凭证为空", { code: "VIDEO_EDIT_FAILED", status: 502 });
    }
    const buffer = await fsp.readFile(file);
    const extension = path.extname(file) || ".mp4";
    const fileName = `video-edit-${sha256(`${file}|${Date.now()}`).slice(0, 16)}${extension}`;
    const key = `${String(policy.upload_dir)}/${fileName}`;
    const form = new FormData();
    form.append("OSSAccessKeyId", String(policy.oss_access_key_id));
    form.append("Signature", String(policy.signature));
    form.append("policy", String(policy.policy));
    form.append("x-oss-object-acl", String(policy.x_oss_object_acl));
    form.append("x-oss-forbid-overwrite", String(policy.x_oss_forbid_overwrite));
    form.append("key", key);
    form.append("success_action_status", "200");
    form.append("file", new Blob([buffer]), fileName);
    const uploadResponse = await this.fetchImpl(String(policy.upload_host), {
      method: "POST",
      body: form,
    });
    if (!uploadResponse.ok) await this.fail(uploadResponse, "上传分镜");
    return `oss://${key}`;
  }

  private async submit(videoUrl: string, prompt: string): Promise<string> {
    const url = new URL(this.settings.submitPath, this.settings.baseUrl);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...this.headers(true, true),
        "X-DashScope-OssResourceResolve": "enable",
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          prompt,
          media: [{ type: "video", url: videoUrl }],
        },
        parameters: {
          resolution: "720P",
          audio_setting: "origin",
        },
      }),
    });
    if (!response.ok) await this.fail(response, "提交视频局部编辑任务");
    const json = (await response.json()) as Record<string, unknown>;
    const output = isRecord(json.output) ? json.output : undefined;
    const taskId = pickString(output, ["task_id", "taskId", "id"]);
    if (!taskId) {
      throw new AppError(`视频编辑任务响应缺少 task_id：${JSON.stringify(json).slice(0, 300)}`, {
        code: "VIDEO_EDIT_INVALID_RESPONSE",
        status: 502,
      });
    }
    this.logger.info(`视频局部编辑任务已提交：${taskId}（${this.model}）`);
    return taskId;
  }

  private async waitForVideo(taskId: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + Math.max(this.settings.timeoutMs, EDIT_TIMEOUT_MS);
    const pollUrl = new URL(this.settings.pollPath.replace("{id}", encodeURIComponent(taskId)), this.settings.baseUrl);
    while (Date.now() < deadline) {
      await sleep(this.settings.pollIntervalMs);
      if (signal?.aborted) throw new AppError("局部编辑已取消", { code: "VIDEO_EDIT_ABORTED" });
      const response = await this.fetchImpl(pollUrl, { headers: this.headers(false) });
      if (!response.ok) await this.fail(response, "查询视频编辑任务");
      const json = (await response.json()) as Record<string, unknown>;
      const output = isRecord(json.output) ? json.output : {};
      const status = (pickString(output, ["task_status", "status", "state"]) ?? "").toLowerCase();
      if (SUCCESS_STATES.has(status)) {
        const url = pickString(output, ["video_url", "videoUrl", "url"]);
        if (!url) {
          throw new AppError(`视频编辑任务没有返回视频地址：${JSON.stringify(json).slice(0, 300)}`, {
            code: "VIDEO_EDIT_INVALID_RESPONSE",
            status: 502,
          });
        }
        return url;
      }
      if (FAILED_STATES.has(status)) {
        const message =
          pickString(output, ["message", "error_message", "code"]) ??
          pickString(json, ["message", "code"]) ??
          "未知错误";
        throw new AppError(`视频局部编辑失败：${message}`, { code: "VIDEO_EDIT_FAILED", status: 502 });
      }
    }
    throw new AppError("视频局部编辑超时", { code: "VIDEO_EDIT_TIMEOUT", status: 504 });
  }

  private async download(url: string, outputFile: string): Promise<void> {
    const response = await this.fetchImpl(url);
    if (!response.ok) await this.fail(response, "下载编辑后的视频");
    await ensureDir(path.dirname(outputFile));
    await fsp.writeFile(outputFile, Buffer.from(await response.arrayBuffer()));
  }

  /** 校验输入视频并下载编辑结果，输出仍保持原分镜时长，便于直接替换。 */
  async edit(request: VideoEditRequest): Promise<VideoEditResult> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new AppError("请填写局部修改要求", { code: "VIDEO_EDIT_PROMPT_EMPTY", status: 400 });
    }
    if (prompt.length > 2000) {
      throw new AppError("局部修改要求不能超过 2000 字", { code: "VIDEO_EDIT_PROMPT_TOO_LONG", status: 400 });
    }
    const source = await probeMedia(request.sourceFile);
    const sourceDuration = source.durationSec ?? 0;
    if (!(sourceDuration >= MIN_INPUT_SEC && sourceDuration <= MAX_INPUT_SEC)) {
      throw new AppError(
        `该分镜时长 ${sourceDuration.toFixed(1)} 秒，视频编辑模型只支持 2–10 秒；请选择更长的分镜。`,
        { code: "VIDEO_EDIT_DURATION_INVALID", status: 400 },
      );
    }
    if (request.config.video.fps < 16) {
      throw new AppError(
        `当前成片帧率 ${request.config.video.fps}fps，视频编辑模型要求至少 16fps；请把视频帧率调到 16 以上。`,
        { code: "VIDEO_EDIT_FPS_INVALID", status: 400 },
      );
    }
    const stats = await fsp.stat(request.sourceFile).catch(() => undefined);
    if (!stats || stats.size > MAX_INPUT_BYTES) {
      throw new AppError("分镜文件超过 100MB，无法提交视频编辑", {
        code: "VIDEO_EDIT_FILE_TOO_LARGE",
        status: 400,
      });
    }

    const uploaded = await this.upload(request.sourceFile);
    const taskId = await this.submit(uploaded, prompt);
    const url = await this.waitForVideo(taskId, request.signal);
    const tempFile = `${request.outputFile}.download.mp4`;
    await this.download(url, tempFile);

    try {
      await conformEditedSegment({
        editedFile: tempFile,
        sourceFile: request.sourceFile,
        outputFile: request.outputFile,
        durationSec: request.durationSec,
        config: request.config,
        logger: request.logger,
      });
    } catch (error) {
      await fsp.rm(tempFile, { force: true }).catch(() => undefined);
      throw new AppError(`编辑结果处理失败：${toErrorMessage(error)}`, {
        code: "VIDEO_EDIT_CONFORM_FAILED",
        cause: error,
      });
    }
    await fsp.rm(tempFile, { force: true }).catch(() => undefined);
    const probe = await probeMedia(request.outputFile);
    return {
      file: request.outputFile,
      durationSec: probe.durationSec ?? request.durationSec,
      provider: this.name,
      model: this.model,
    };
  }
}

/** 统一画幅/帧率，并保留原分镜音轨（编辑模型只改画面），时长固定为原分镜时长。 */
export async function conformEditedSegment(input: {
  editedFile: string;
  sourceFile: string;
  outputFile: string;
  durationSec: number;
  config: AppConfig;
  logger: Logger;
}): Promise<void> {
  const { editedFile, sourceFile, outputFile, durationSec, config, logger } = input;
  const source = await probeMedia(sourceFile);
  const duration = Math.max(0.5, durationSec);
  await ensureDir(path.dirname(outputFile));
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    editedFile,
    ...(source.hasAudio
      ? ["-i", sourceFile]
      : ["-f", "lavfi", "-t", duration.toFixed(2), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]),
    "-map",
    "0:v:0",
    "-map",
    source.hasAudio ? "1:a:0" : "1:a:0",
    "-vf",
    [
      `scale=${config.video.width}:${config.video.height}:force_original_aspect_ratio=decrease`,
      `pad=${config.video.width}:${config.video.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "setsar=1",
      `fps=${config.video.fps}`,
      `tpad=stop_mode=clone:stop_duration=${duration.toFixed(2)}`,
    ].join(","),
    "-af",
    source.hasAudio
      ? `apad=pad_dur=${duration.toFixed(2)},atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS`
      : `atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS`,
    "-c:v",
    "libx264",
    "-preset",
    config.video.preset,
    "-crf",
    String(config.video.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-t",
    duration.toFixed(3),
    "-movflags",
    "+faststart",
    outputFile,
  ];
  logger.info(`替换分镜画面：保留原音轨并统一到 ${config.video.width}x${config.video.height}`);
  await runFfmpeg(args, { timeoutMs: 10 * 60 * 1000 });
}

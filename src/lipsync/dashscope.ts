import fs from "node:fs/promises";
import path from "node:path";
import { AppError, toErrorMessage } from "../errors.js";
import type { Logger } from "../logger.js";
import type { LipsyncProvider, LipsyncRequest, LipsyncResult, LipsyncSettings } from "../types.js";
import { probeMedia } from "../media/ffmpeg.js";
import { ensureDir, sha256, shortId } from "../util/fs.js";

/**
 * 阿里云百炼「声动人像 VideoRetalk」口型同步。
 *
 * 官方链路（见 help.aliyun.com/zh/model-studio/videoretalk-api）：
 * 1. 视频/音频必须是公网可访问的 URL。本地文件先传到百炼临时存储：
 *    GET /api/v1/uploads?action=getPolicy&model=videoretalk 拿上传凭证，
 *    再把文件 multipart 传到 upload_host，得到 oss:// 前缀的临时 URL。
 * 2. 提交异步任务：POST /api/v1/services/aigc/image2video/video-synthesis，
 *    header 需要 X-DashScope-Async: enable 与 X-DashScope-OssResourceResolve: enable。
 * 3. 查询 GET /api/v1/tasks/{id}，成功后下载 output.video_url（24 小时有效）。
 *
 * 限制：该模型只在华北 2（北京）地域提供，且必须使用该地域的 API Key；
 * 视频 2–120 秒、边长 640–2048、15–60fps，音频 2–120 秒。
 */
export class DashScopeLipsyncProvider implements LipsyncProvider {
  readonly name = "dashscope";
  private readonly settings: LipsyncSettings;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: LipsyncSettings, logger: Logger, fetchImpl: typeof fetch = fetch) {
    this.settings = settings;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
  }

  private headers(json = true): Record<string, string> {
    return {
      authorization: `Bearer ${this.settings.apiKey ?? ""}`,
      ...(json ? { "content-type": "application/json" } : {}),
      "X-DashScope-OssResourceResolve": "enable",
    };
  }

  private async fail(response: Response, stage: string): Promise<never> {
    const text = await response.text().catch(() => "");
    const hint =
      response.status === 401 || response.status === 403
        ? "请确认使用的是华北 2（北京）地域的百炼 API Key，且已开通 VideoRetalk。"
        : "";
    throw new AppError(`${stage}失败（HTTP ${response.status}）：${text.slice(0, 300)}${hint}`, {
      code: "LIPSYNC_FAILED",
      status: 502,
    });
  }

  /** 上传一个本地文件到百炼临时存储，返回 oss:// 前缀的临时 URL。 */
  private async uploadFile(file: string, label: string): Promise<string> {
    const policyUrl = new URL("/api/v1/uploads", this.settings.baseUrl);
    policyUrl.searchParams.set("action", "getPolicy");
    policyUrl.searchParams.set("model", this.settings.model);
    const policyResponse = await this.fetchImpl(policyUrl, { headers: this.headers(false) });
    if (!policyResponse.ok) await this.fail(policyResponse, `获取${label}上传凭证`);
    const policy = ((await policyResponse.json()) as { data?: Record<string, unknown> }).data;
    if (!policy) {
      throw new AppError("百炼临时存储返回的上传凭证为空", { code: "LIPSYNC_FAILED", status: 502 });
    }

    const buffer = await fs.readFile(file);
    const extension = path.extname(file) || (label === "音频" ? ".mp3" : ".mp4");
    const fileName = `lipsync-${sha256(`${file}|${Date.now()}`).slice(0, 16)}${extension}`;
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
    if (!uploadResponse.ok) await this.fail(uploadResponse, `上传${label}`);
    return `oss://${key}`;
  }

  private async validate(videoFile: string, audioFile: string): Promise<void> {
    const video = await probeMedia(videoFile);
    const audio = await probeMedia(audioFile);
    const problems: string[] = [];
    const videoDuration = video.durationSec ?? 0;
    const audioDuration = audio.durationSec ?? 0;
    if (!(videoDuration > 2 && videoDuration < 120)) {
      problems.push(`视频时长 ${videoDuration.toFixed(1)}s 需在 2–120 秒之间`);
    }
    if (!(audioDuration > 2 && audioDuration < 120)) {
      problems.push(`音频时长 ${audioDuration.toFixed(1)}s 需在 2–120 秒之间`);
    }
    const shortSide = Math.min(video.width ?? 0, video.height ?? 0);
    const longSide = Math.max(video.width ?? 0, video.height ?? 0);
    if (shortSide < 640 || longSide > 2048) {
      problems.push(`视频边长 ${video.width}x${video.height} 超出 640–2048`);
    }
    if (problems.length > 0) {
      throw new AppError(`口型同步输入不符合 VideoRetalk 要求：${problems.join("；")}`, {
        code: "LIPSYNC_INPUT_INVALID",
        status: 400,
      });
    }
  }

  private async submit(videoUrl: string, audioUrl: string): Promise<string> {
    const response = await this.fetchImpl(
      new URL("/api/v1/services/aigc/image2video/video-synthesis", this.settings.baseUrl),
      {
        method: "POST",
        headers: { ...this.headers(), "X-DashScope-Async": "enable" },
        body: JSON.stringify({
          model: this.settings.model,
          input: { video_url: videoUrl, audio_url: audioUrl },
          // 不要把画面“倒放-正放”去凑音频长度：那会让同一镜头来回播放。
          // 成片时长由渲染阶段保证（生成片段不足时定格补帧），这里保持不扩展。
          parameters: { video_extension: false },
        }),
      },
    );
    if (!response.ok) await this.fail(response, "提交口型同步任务");
    const json = (await response.json()) as { output?: { task_id?: string } };
    const taskId = json.output?.task_id;
    if (!taskId) {
      throw new AppError(`口型同步任务响应缺少 task_id：${JSON.stringify(json).slice(0, 200)}`, {
        code: "LIPSYNC_INVALID_RESPONSE",
        status: 502,
      });
    }
    return taskId;
  }

  private async waitForVideo(taskId: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.settings.timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new AppError("任务已取消", { code: "ABORTED", status: 499 });
      const response = await this.fetchImpl(
        new URL(`/api/v1/tasks/${taskId}`, this.settings.baseUrl),
        { headers: this.headers(false) },
      );
      if (!response.ok) await this.fail(response, "查询口型同步任务");
      const json = (await response.json()) as {
        output?: { task_status?: string; video_url?: string; code?: string; message?: string };
      };
      const status = json.output?.task_status;
      if (status === "SUCCEEDED" && json.output?.video_url) return json.output.video_url;
      if (status === "FAILED") {
        throw new AppError(
          `口型同步任务失败：${json.output?.code ?? ""} ${json.output?.message ?? ""}`.trim(),
          { code: "LIPSYNC_TASK_FAILED", status: 502 },
        );
      }
      if (Date.now() > deadline) {
        throw new AppError(
          `等待口型同步超时（任务 ${taskId}），可稍后在百炼控制台查看该任务。`,
          { code: "LIPSYNC_TIMEOUT", status: 504 },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.settings.pollIntervalMs));
    }
  }

  async sync(request: LipsyncRequest, outputDir: string, signal?: AbortSignal): Promise<LipsyncResult> {
    if (!this.settings.apiKey) {
      throw new AppError("还没有配置口型同步 API Key：请在设置页填写百炼（北京地域）Key", {
        code: "LIPSYNC_MISSING_API_KEY",
        status: 400,
      });
    }
    await this.validate(request.videoFile, request.audioFile);
    this.logger.info("口型同步：上传视频与配音到百炼临时存储");
    const [videoUrl, audioUrl] = await Promise.all([
      this.uploadFile(request.videoFile, "视频"),
      this.uploadFile(request.audioFile, "音频"),
    ]);
    this.logger.info("口型同步：提交 VideoRetalk 任务");
    const taskId = await this.submit(videoUrl, audioUrl);
    const videoUrlResult = await this.waitForVideo(taskId, signal);

    const response = await this.fetchImpl(videoUrlResult, { signal });
    if (!response.ok) await this.fail(response, "下载口型同步成片");
    const buffer = Buffer.from(await response.arrayBuffer());
    await ensureDir(outputDir);
    const file = path.join(outputDir, `lipsync-${shortId().slice(0, 8)}.mp4`);
    await fs.writeFile(file, buffer);
    const probe = await probeMedia(file);
    this.logger.info(`口型同步完成：${path.basename(file)}（${(probe.durationSec ?? 0).toFixed(1)}s）`);
    return {
      provider: this.name,
      model: this.settings.model,
      file,
      durationSec: probe.durationSec ?? 0,
    };
  }
}

/** 根据配置创建口型同步 provider；未启用时返回 null。 */
export function createLipsyncProvider(
  settings: LipsyncSettings,
  logger: Logger,
): LipsyncProvider | null {
  if (settings.provider !== "dashscope") return null;
  return new DashScopeLipsyncProvider(settings, logger);
}

export function lipsyncEnabled(settings: LipsyncSettings): boolean {
  return settings.provider === "dashscope" && Boolean(settings.apiKey);
}

export function lipsyncErrorHint(error: unknown): string {
  return toErrorMessage(error);
}
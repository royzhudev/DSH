import fsp from "node:fs/promises";
import path from "node:path";
import { AppError, toErrorMessage } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ImageGenSettings } from "../types.js";
import { probeMedia } from "../media/ffmpeg.js";
import { ensureDir } from "../util/fs.js";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";
const GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export interface ImageGenResult {
  file: string;
  width: number;
  height: number;
  provider: string;
  model: string;
}

export interface ImageGenDeps {
  fetchImpl?: typeof fetch;
  /** imageGen.baseUrl 留空时沿用视频接口的地址，用户只需要填 Key。 */
  fallbackBaseUrl?: string;
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

/**
 * 阿里百炼 Qwen-Image 文生图：同步 multimodal-generation 接口。
 * 默认参数（模型、尺寸、负向提示词、提示词改写）在设置里预置，用户只需填 API Key。
 * 生成结果 URL 只有 24 小时有效期，这里立刻下载到本地再交给角色库入库。
 */
export class DashScopeImageProvider {
  readonly name = "bailian";
  private readonly settings: ImageGenSettings;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackBaseUrl: string;

  constructor(settings: ImageGenSettings, logger: Logger, deps: ImageGenDeps = {}) {
    this.settings = settings;
    this.logger = logger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.fallbackBaseUrl = deps.fallbackBaseUrl?.trim() || "";
  }

  private get model(): string {
    return this.settings.model.trim() || "qwen-image-2.0-pro";
  }

  private get baseUrl(): string {
    return this.settings.baseUrl.trim() || this.fallbackBaseUrl || DEFAULT_BASE_URL;
  }

  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(10_000, this.settings.timeoutMs));
    try {
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError("生成角色参考图超时，请稍后重试", {
          code: "IMAGE_GEN_TIMEOUT",
          status: 504,
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fail(response: Response, action: string): Promise<never> {
    const text = await response.text().catch(() => "");
    throw new AppError(`${action}失败（HTTP ${response.status}）：${text.slice(0, 300)}`, {
      code: "IMAGE_GEN_FAILED",
      status: 502,
    });
  }

  async generate(prompt: string, outputFile: string): Promise<ImageGenResult> {
    if (!this.settings.apiKey) {
      throw new AppError("还没有填写图像生成 API Key，请到「设置 → AI 角色图生成」填写", {
        code: "IMAGE_GEN_DISABLED",
        status: 400,
      });
    }
    const text = prompt.trim();
    if (!text) {
      throw new AppError("外观设定不能为空，先写清楚人物或道具长什么样", {
        code: "IMAGE_GEN_PROMPT_EMPTY",
        status: 400,
      });
    }
    const url = new URL(GENERATION_PATH, this.baseUrl);
    const body = {
      model: this.model,
      input: {
        messages: [{ role: "user", content: [{ text: text.slice(0, 6000) }] }],
      },
      parameters: {
        size: this.settings.size,
        n: 1,
        negative_prompt: this.settings.negativePrompt,
        prompt_extend: this.settings.promptExtend,
        watermark: false,
      },
    };
    this.logger.info(`生成角色参考图：${this.model}，${this.settings.size}`);
    const response = await this.withTimeout((signal) =>
      this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.settings.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      }),
    );
    if (!response.ok) await this.fail(response, "生成角色参考图");

    const json = (await response.json()) as Record<string, unknown>;
    const code = pickString(json, ["code"]);
    if (code) {
      throw new AppError(`图像生成失败：${pickString(json, ["message"]) ?? code}`, {
        code: "IMAGE_GEN_FAILED",
        status: 502,
      });
    }
    const output = isRecord(json.output) ? json.output : {};
    const choices = Array.isArray(output.choices) ? output.choices : [];
    let imageUrl: string | undefined;
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const message = isRecord(choice.message) ? choice.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (!isRecord(item)) continue;
        imageUrl = pickString(item, ["image", "url"]);
        if (imageUrl) break;
      }
      if (imageUrl) break;
    }
    // 兼容 Wanx 老接口的 output.results[0].url，模型名改回 Wan 时不用改代码。
    if (!imageUrl && Array.isArray(output.results)) {
      const first = output.results[0];
      if (isRecord(first)) imageUrl = pickString(first, ["url", "image_url"]);
    }
    if (!imageUrl) {
      throw new AppError(`图像生成响应里没有图片地址：${JSON.stringify(json).slice(0, 300)}`, {
        code: "IMAGE_GEN_INVALID_RESPONSE",
        status: 502,
      });
    }

    const download = await this.withTimeout((signal) => this.fetchImpl(imageUrl, { signal }));
    if (!download.ok) await this.fail(download, "下载生成的参考图");
    const contentLength = Number(download.headers.get("content-length") ?? "0");
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new AppError("生成的参考图超过 30MB，无法保存", {
        code: "IMAGE_GEN_TOO_LARGE",
        status: 502,
      });
    }
    const buffer = Buffer.from(await download.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new AppError("下载到的参考图为空", { code: "IMAGE_GEN_EMPTY", status: 502 });
    }
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new AppError("生成的参考图超过 30MB，无法保存", {
        code: "IMAGE_GEN_TOO_LARGE",
        status: 502,
      });
    }
    await ensureDir(path.dirname(outputFile));
    await fsp.writeFile(outputFile, buffer);
    const probe = await probeMedia(outputFile).catch((error: unknown) => {
      throw new AppError(`生成的参考图无法读取：${toErrorMessage(error)}`, {
        code: "IMAGE_GEN_INVALID_IMAGE",
        status: 502,
        cause: error,
      });
    });
    if (!probe.width || !probe.height) {
      throw new AppError("生成的参考图尺寸无效", { code: "IMAGE_GEN_INVALID_IMAGE", status: 502 });
    }
    this.logger.info(`参考图已生成：${probe.width}×${probe.height}`);
    return {
      file: outputFile,
      width: probe.width,
      height: probe.height,
      provider: this.name,
      model: this.model,
    };
  }
}

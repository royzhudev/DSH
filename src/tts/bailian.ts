import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { TtsProvider, TtsRequest, TtsResult, TtsSettings } from "../types.js";
import { ensureDir, pathExists } from "../util/fs.js";
import { truncate } from "../util/text.js";
import { probeMedia } from "../media/ffmpeg.js";
import { estimateSentences } from "./estimate.js";

const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com";
const DEFAULT_HTTP_MODEL = "qwen-tts";
const DEFAULT_WS_MODEL = "cosyvoice-v3";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 阿里百炼原生语音合成。
 *
 * - `qwen-tts` / `qwen-tts-latest`：走 DashScope 多模态 HTTP 接口，返回音频地址或 base64；
 * - `cosyvoice-v2` / `cosyvoice-v3`：走 DashScope 实时 WebSocket 接口（流式音频）。
 *
 * 声音复刻：在百炼控制台/接口复刻得到的 voice id 直接填到角色库的
 * 「对话配音音色」（或设置里的默认音色），这里只按 id 合成，不重复做复刻。
 */
export class BailianTtsProvider implements TtsProvider {
  readonly name = "bailian" as const;
  readonly voice: string;
  private readonly settings: TtsSettings;
  private readonly cacheDir: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: TtsSettings, cacheDir: string, logger: Logger, fetchImpl: typeof fetch = fetch) {
    this.settings = settings;
    this.voice = settings.voice;
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
  }

  private get baseUrl(): string {
    const configured = this.settings.baseUrl?.trim();
    // 默认配置里的接口地址是 OpenAI 的；用户切到百炼但没改地址时，用 DashScope 官方地址兜底。
    if (!configured || configured.includes("api.openai.com")) return DASHSCOPE_BASE;
    return configured.replace(/\/+$/, "");
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    const apiKey = this.settings.apiKey;
    if (!apiKey) {
      throw new AppError("未配置阿里百炼密钥 TTS_API_KEY", { code: "CONFIG_MISSING_API_KEY" });
    }
    await ensureDir(this.cacheDir);
    const audioFile = path.join(this.cacheDir, `${request.cacheKey}-bailian.mp3`);
    if (this.settings.cache && (await pathExists(audioFile))) {
      const probe = await probeMedia(audioFile);
      const durationSec = probe.durationSec ?? 0;
      return {
        provider: this.name,
        voice: this.voice,
        audioPath: audioFile,
        durationSec,
        sentences: estimateSentences(request.text, durationSec),
        cached: true,
      };
    }

    const model = this.settings.model?.trim() || DEFAULT_HTTP_MODEL;
    if (/^cosyvoice/i.test(model)) {
      await this.synthesizeViaWebSocket(request, model, audioFile, signal);
    } else if (/^qwen-tts/i.test(model)) {
      await this.synthesizeViaHttp(request, model, audioFile, signal);
    } else {
      // 百炼上的第三方语音模型（如 MiniMax/speech-2.8-turbo）走兼容 OpenAI 的 /audio/speech。
      await this.synthesizeViaCompatibleSpeech(request, model, audioFile, signal);
    }
    const probe = await probeMedia(audioFile);
    const durationSec = probe.durationSec ?? 0;
    if (!durationSec) {
      throw new AppError("百炼返回的音频无法读取时长", { code: "TTS_API_FAILED", status: 502 });
    }
    return {
      provider: this.name,
      voice: this.voice,
      audioPath: audioFile,
      durationSec,
      sentences: estimateSentences(request.text, durationSec),
      cached: false,
    };
  }

  /**
   * 百炼第三方语音模型（MiniMax/speech-2.8-turbo 等）：兼容 OpenAI 的 /audio/speech。
   * baseUrl 既可以填 https://dashscope.aliyuncs.com，也可以直接填 .../compatible-mode/v1。
   */
  private async synthesizeViaCompatibleSpeech(
    request: TtsRequest,
    model: string,
    audioFile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const endpoint = /\/compatible-mode\/v1$/.test(this.baseUrl)
      ? `${this.baseUrl}/audio/speech`
      : `${this.baseUrl}/compatible-mode/v1/audio/speech`;
    const rate = Math.max(0.25, Math.min(4, request.rate ?? this.settings.rate));
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: request.text,
        voice: this.voice,
        response_format: "mp3",
        speed: rate,
      }),
      signal: signal ?? AbortSignal.timeout(this.settings.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new AppError(`百炼语音合成（${model}）返回 ${response.status}：${truncate(text, 300)}`, {
        code: "TTS_API_FAILED",
        status: 502,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const text = await response.text();
      throw new AppError(`百炼语音合成（${model}）没有返回音频：${truncate(text, 300)}`, {
        code: "TTS_API_FAILED",
        status: 502,
      });
    }
    await fs.writeFile(audioFile, Buffer.from(await response.arrayBuffer()));
  }

  /** qwen-tts：DashScope 多模态 HTTP，返回音频 URL 或 base64。 */
  private async synthesizeViaHttp(
    request: TtsRequest,
    model: string,
    audioFile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = {
      model,
      input: {
        text: request.text,
        voice: this.voice,
        language_type: "Chinese",
      },
    };
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.settings.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(`百炼语音合成返回 ${response.status}：${truncate(text, 300)}`, {
        code: "TTS_API_FAILED",
        status: 502,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError("百炼语音合成返回的不是 JSON", { code: "TTS_API_FAILED", status: 502 });
    }
    const audio = (parsed as { output?: { audio?: { url?: string; data?: string } } })?.output?.audio;
    if (audio?.data) {
      await fs.writeFile(audioFile, Buffer.from(audio.data, "base64"));
      return;
    }
    if (audio?.url) {
      const download = await this.fetchImpl(audio.url);
      if (!download.ok) {
        throw new AppError(`下载百炼音频失败：${download.status}`, { code: "TTS_API_FAILED", status: 502 });
      }
      await fs.writeFile(audioFile, Buffer.from(await download.arrayBuffer()));
      return;
    }
    throw new AppError("百炼语音合成没有返回音频", { code: "TTS_API_FAILED", status: 502 });
  }

  /** cosyvoice-v2 / v3：DashScope 实时 WebSocket，流式接收二进制音频。 */
  private async synthesizeViaWebSocket(
    request: TtsRequest,
    model: string,
    audioFile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseUrl.replace(/^http/, "ws")}/api-ws/v1/inference`;
    const taskId = randomUUID();
    const chunks: Buffer[] = [];
    const rate = request.rate ?? this.settings.rate;
    const volume = Math.round(50 + (request.volume ?? 0));

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${this.settings.apiKey}`,
          "X-DashScope-DataInspection": "enable",
        },
      });
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // 关闭失败不影响结果
        }
        if (error) {
          reject(
            error instanceof AppError
              ? error
              : new AppError(`CosyVoice 合成失败：${String(error)}`, {
                  code: "TTS_API_FAILED",
                  status: 502,
                  cause: error,
                }),
          );
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish(new AppError("CosyVoice 合成超时", { code: "TTS_TIMEOUT", status: 504 }));
      }, this.settings.timeoutMs);
      const send = (action: string, payload: Record<string, unknown>) => {
        socket.send(JSON.stringify({ header: { action, task_id: taskId, streaming: "duplex" }, payload }));
      };

      socket.on("open", () => {
        send("run-task", {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model,
          parameters: {
            text_type: "PlainText",
            voice: this.voice,
            format: "mp3",
            sample_rate: 24000,
            volume: Math.max(0, Math.min(100, volume)),
            rate: Math.max(0.5, Math.min(2, rate)),
            pitch: 1,
          },
          input: {},
        });
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          return;
        }
        try {
          const message = JSON.parse(data.toString()) as {
            header?: { event?: string; error_message?: string };
          };
          const name = message.header?.event;
          if (name === "task-started") {
            send("continue-task", { input: { text: request.text } });
            send("finish-task", { input: {} });
          } else if (name === "task-finished") {
            finish();
          } else if (name === "task-failed") {
            finish(
              new AppError(message.header?.error_message ?? "CosyVoice 合成失败", {
                code: "TTS_API_FAILED",
                status: 502,
              }),
            );
          }
        } catch {
          // 忽略非 JSON 文本帧
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        // task-finished 后会主动关闭；没有音频说明服务端提前断开。
        if (!settled) {
          finish(chunks.length > 0 ? undefined : new AppError("CosyVoice 连接提前关闭", {
            code: "TTS_API_FAILED",
            status: 502,
          }));
        }
      });
      signal?.addEventListener("abort", () => finish(new AppError("任务已取消", { code: "ABORTED", status: 499 })), {
        once: true,
      });
    });

    if (chunks.length === 0) {
      throw new AppError("CosyVoice 没有返回音频", { code: "TTS_API_FAILED", status: 502 });
    }
    await fs.writeFile(audioFile, Buffer.concat(chunks));
  }
}

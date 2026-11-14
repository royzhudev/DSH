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

interface AudioPayload {
  url?: string;
  buffer?: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 兼容 base64、data URI 和 MiniMax 原生返回的十六进制音频。 */
function decodeAudioData(value: string): Buffer | undefined {
  const text = value.trim();
  if (!text || /^https?:\/\//i.test(text)) return undefined;
  const comma = text.indexOf(",");
  const raw = text.startsWith("data:") && comma >= 0 ? text.slice(comma + 1) : text;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return undefined;
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0 && compact.length >= 32) {
    return Buffer.from(compact, "hex");
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return undefined;
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function audioPayloadFrom(value: unknown): AudioPayload | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    if (/^https?:\/\//i.test(text)) return { url: text };
    const buffer = decodeAudioData(text);
    return buffer && buffer.length >= 64 ? { buffer } : undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["url", "audio_url", "audioUrl", "download_url"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate.trim())) {
      return { url: candidate.trim() };
    }
  }
  for (const key of ["data", "audio", "content", "base64"]) {
    const payload = audioPayloadFrom(value[key]);
    if (payload) return payload;
  }
  return undefined;
}

/** 从模型返回里找音频：兼容 output.audio{url,data}、output.audio 字符串、output.audio_url、data.audio。 */
function audioPayloadFromResponse(parsed: unknown): AudioPayload | undefined {
  if (!isRecord(parsed)) return undefined;
  const roots = [parsed];
  if (isRecord(parsed.output)) {
    roots.push(parsed.output);
    // MiniMax/speech-2.8-hd 的真实返回是 output.data.audio（十六进制），不是 output.audio。
    if (isRecord(parsed.output.data)) roots.push(parsed.output.data);
  }
  if (isRecord(parsed.data)) {
    roots.push(parsed.data);
    if (isRecord(parsed.data.data)) roots.push(parsed.data.data);
  }
  for (const root of roots) {
    if (!isRecord(root)) continue;
    for (const key of ["audio", "audio_url", "audioUrl", "audioData", "url"]) {
      const payload = audioPayloadFrom(root[key]);
      if (payload) return payload;
    }
  }
  return undefined;
}

function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      // 忽略非 JSON 事件
    }
  }
  return events;
}

/** 同时兼容 JSON 与 SSE：流式时把每段 base64 解码后拼接，URL 则返回最后一个。 */
function extractAudioPayload(text: string, contentType: string): AudioPayload | undefined {
  const isSse = /text\/event-stream/i.test(contentType) || /^\s*data:/m.test(text);
  if (isSse) {
    const chunks: Buffer[] = [];
    let url: string | undefined;
    for (const event of parseSseEvents(text)) {
      const payload = audioPayloadFromResponse(event);
      if (payload?.buffer) chunks.push(payload.buffer);
      if (payload?.url) url = payload.url;
    }
    if (chunks.length > 0) return { buffer: Buffer.concat(chunks) };
    if (url) return { url };
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return audioPayloadFromResponse(parsed);
}

/** 200 但没有音频时，把模型自己的错误信息带出来，避免只报“没有 output.audio”。 */
function describeEmptyAudio(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return truncate(text, 160);
  }
  if (!isRecord(parsed)) return undefined;
  const pieces: string[] = [];
  const baseResps = [parsed.base_resp];
  if (isRecord(parsed.output)) baseResps.push(parsed.output.base_resp);
  for (const baseResp of baseResps) {
    if (!isRecord(baseResp)) continue;
    const code = baseResp.status_code;
    const message = baseResp.status_msg;
    if (code !== undefined && code !== 0) pieces.push(`status_code=${String(code)}`);
    if (typeof message === "string" && message && message !== "success") pieces.push(message);
  }
  for (const key of ["message", "msg", "code"]) {
    if (typeof parsed[key] === "string" && parsed[key]) pieces.push(parsed[key] as string);
  }
  if (isRecord(parsed.output)) {
    for (const key of ["message", "code", "finish_reason", "task_status"]) {
      const value = parsed.output[key];
      if ((typeof value === "string" || typeof value === "number") && value !== "") {
        pieces.push(`${key}=${String(value)}`);
      }
    }
  }
  const unique = [...new Set(pieces)];
  return unique.length > 0 ? truncate(unique.join("，"), 200) : undefined;
}

async function hasAudioDuration(file: string): Promise<boolean> {
  try {
    const probe = await probeMedia(file);
    return Boolean(probe.durationSec && probe.durationSec > 0);
  } catch {
    return false;
  }
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
    } else if (/^qwen[\w.-]*tts/i.test(model)) {
      await this.synthesizeViaHttp(request, model, audioFile, signal);
    } else {
      // 百炼上的第三方语音模型（如 MiniMax/speech-2.8-turbo）走百炼原生多模态接口，
      // 请求体不是 OpenAI TTS 的 {model,input,voice}，而是 input.audio + parameters.voice。
      await this.synthesizeViaNative(request, model, audioFile, signal);
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

  /** 百炼原生多模态接口；baseUrl 允许填域名、兼容模式地址或完整接口地址。 */
  private get nativeEndpoint(): string {
    const base = this.baseUrl;
    if (/\/generation$/.test(base)) return base;
    if (/\/compatible-mode\/v1$/.test(base)) {
      return `${base.replace(/\/compatible-mode\/v1$/, "")}/api/v1/services/aigc/multimodal-generation/generation`;
    }
    if (/\/api\/v1$/.test(base)) {
      return `${base}/services/aigc/multimodal-generation/generation`;
    }
    return `${base}/api/v1/services/aigc/multimodal-generation/generation`;
  }

  /**
   * 百炼第三方语音模型（MiniMax/speech-2.8-hd、speech-2.8-turbo 等）：原生 multimodal-generation 接口。
   * MiniMax 系列的官方入参是 text + voice_setting.voice_id；百炼不同模型/版本对 input 的包装略有差异，
   * 这里按文档顺序逐个尝试，并对返回结构做兼容解析（output.audio 对象/字符串、audio_url、data.audio）。
   */
  private async synthesizeViaNative(
    request: TtsRequest,
    model: string,
    audioFile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const rate = Math.max(0.5, Math.min(2, request.rate ?? this.settings.rate));
    const voiceSetting = { voice_id: this.voice, speed: rate, vol: 1, pitch: 0 };
    const audioSetting = { sample_rate: 24000, bitrate: 128000, format: "mp3", channel: 1 };
    const candidates: Array<Record<string, unknown>> = [
      {
        model,
        input: { text: request.text, voice_setting: voiceSetting, audio_setting: audioSetting },
      },
      {
        model,
        input: { text: request.text, voice_setting: { voice_id: this.voice, speed: rate } },
      },
      {
        model,
        text: request.text,
        voice_setting: voiceSetting,
        audio_setting: audioSetting,
      },
      {
        model,
        input: { text: request.text },
        parameters: { voice: this.voice, format: "mp3", sample_rate: 24000, rate },
      },
      {
        model,
        input: { text: request.text },
        parameters: { voice_setting: voiceSetting, audio_setting: audioSetting },
      },
      {
        model,
        input: { audio: { text: request.text, voice: this.voice } },
        parameters: { voice: this.voice, format: "mp3", sample_rate: 24000, rate },
      },
    ];
    const failures: string[] = [];
    for (const body of candidates) {
      const response = await this.fetchImpl(this.nativeEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.settings.timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        failures.push(`${response.status}：${truncate(text, 160)}`);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const payload = extractAudioPayload(text, contentType);
      if (payload?.buffer) {
        await fs.writeFile(audioFile, payload.buffer);
        if (await hasAudioDuration(audioFile)) return;
        failures.push("返回的音频无法读取时长");
        continue;
      }
      if (payload?.url) {
        const download = await this.fetchImpl(payload.url, { signal });
        if (!download.ok) {
          failures.push(`下载音频失败：${download.status}`);
          continue;
        }
        await fs.writeFile(audioFile, Buffer.from(await download.arrayBuffer()));
        if (await hasAudioDuration(audioFile)) return;
        failures.push("下载到的音频无法读取时长");
        continue;
      }
      failures.push(describeEmptyAudio(text) || "响应里没有 output.audio");
    }
    throw new AppError(`百炼语音合成（${model}）失败：${failures.join("；")}`, {
      code: "TTS_API_FAILED",
      status: 502,
    });
  }

  /** qwen-tts / qwen3-tts 系列：DashScope 多模态 HTTP，返回音频 URL 或 base64。 */
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
    const response = await this.fetchImpl(this.nativeEndpoint, {
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

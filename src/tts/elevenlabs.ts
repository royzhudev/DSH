import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { TtsProvider, TtsRequest, TtsResult, TtsSettings } from "../types.js";
import { ensureDir, pathExists } from "../util/fs.js";
import { truncate } from "../util/text.js";
import { probeMedia } from "../media/ffmpeg.js";
import { estimateSentences } from "./estimate.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ElevenLabs 语音合成：多语种模型的中文表演比免费音色自然得多，
 * 支持 stability/style 等参数控制情绪起伏，适合短剧对白。
 * 角色音色需要在角色库的 voice 字段填 ElevenLabs 的 voice_id；
 * 没填时用设置里的默认音色。
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs" as const;
  readonly voice: string;
  private readonly settings: TtsSettings;
  private readonly cacheDir: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(
    settings: TtsSettings,
    cacheDir: string,
    logger: Logger,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.settings = settings;
    this.voice = settings.voice;
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    const apiKey = this.settings.apiKey;
    if (!apiKey) {
      throw new AppError("未配置 ElevenLabs 密钥 TTS_API_KEY", { code: "CONFIG_MISSING_API_KEY" });
    }
    await ensureDir(this.cacheDir);
    const audioFile = path.join(this.cacheDir, `${request.cacheKey}-elevenlabs.mp3`);

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

    const baseUrl = this.settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voice)}`;
    const body = {
      text: request.text,
      model_id: this.settings.model || "eleven_multilingual_v2",
      // 短剧对白要自然、有情绪起伏：stability 低一点更生动，style 高一点更有表演感。
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.75,
        style: 0.45,
        use_speaker_boost: true,
      },
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "xi-api-key": apiKey,
            accept: "audio/mpeg",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < 3) {
            this.logger.warn(`ElevenLabs 返回 ${response.status}，第 ${attempt} 次重试`);
            await sleep(800 * attempt);
            continue;
          }
          throw new AppError(`ElevenLabs 配音返回 ${response.status}：${truncate(text, 300)}`, {
            code: "TTS_API_FAILED",
            status: 502,
          });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 1000) {
          throw new AppError("ElevenLabs 返回的音频过小", { code: "TTS_API_EMPTY", status: 502 });
        }
        await fs.writeFile(audioFile, buffer);
        const probe = await probeMedia(audioFile);
        const durationSec = probe.durationSec ?? 0;
        if (!durationSec) {
          throw new AppError("ElevenLabs 返回的音频无法读取时长", { code: "TTS_API_FAILED", status: 502 });
        }
        return {
          provider: this.name,
          voice: this.voice,
          audioPath: audioFile,
          durationSec,
          sentences: estimateSentences(request.text, durationSec),
          cached: false,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof AppError) throw error;
        if (attempt < 3) {
          this.logger.warn(`ElevenLabs 配音请求失败，第 ${attempt} 次重试：${String(error)}`);
          await sleep(800 * attempt);
          continue;
        }
        throw new AppError(`ElevenLabs 配音请求失败：${String(error)}`, {
          code: "TTS_API_FAILED",
          status: 502,
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    throw new AppError("ElevenLabs 配音请求失败", { code: "TTS_API_FAILED", status: 502 });
  }
}

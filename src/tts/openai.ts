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

/** OpenAI 兼容的 /audio/speech 接口，可替换为任意同协议供应商。 */
export class OpenAiTtsProvider implements TtsProvider {
  readonly name = "openai";
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
      throw new AppError("未配置配音接口密钥 TTS_API_KEY", { code: "CONFIG_MISSING_API_KEY" });
    }
    await ensureDir(this.cacheDir);
    const audioFile = path.join(this.cacheDir, `${request.cacheKey}-openai.mp3`);

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

    const url = `${this.settings.baseUrl}/audio/speech`;
    const baseBody: Record<string, unknown> = {
      model: this.settings.model,
      voice: this.voice,
      input: request.text,
      response_format: "mp3",
    };
    const rate = request.rate ?? this.settings.rate;
    if (Math.abs(rate - 1) > 0.01) baseBody.speed = rate;
    if (request.instructions) baseBody.instructions = request.instructions;

    let body = baseBody;
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
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          if (response.status === 400 && ("speed" in body || "instructions" in body)) {
            this.logger.warn("配音接口不接受 speed/instructions 参数，去掉后重试");
            const { speed: _speed, instructions: _instructions, ...rest } = body;
            body = rest;
            continue;
          }
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < 3) {
            this.logger.warn(`配音接口返回 ${response.status}，第 ${attempt} 次重试`);
            await sleep(800 * attempt);
            continue;
          }
          throw new AppError(`配音接口返回 ${response.status}：${truncate(text, 300)}`, {
            code: "TTS_API_FAILED",
            status: 502,
          });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 1000) {
          throw new AppError("配音接口返回的音频过小", { code: "TTS_API_EMPTY", status: 502 });
        }
        await fs.writeFile(audioFile, buffer);
        const probe = await probeMedia(audioFile);
        const durationSec = probe.durationSec ?? 0;
        if (!durationSec) {
          throw new AppError("配音接口返回的音频无法读取时长", { code: "TTS_API_FAILED", status: 502 });
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
          this.logger.warn(`配音接口请求失败，第 ${attempt} 次重试：${String(error)}`);
          await sleep(800 * attempt);
          continue;
        }
        throw new AppError(`配音接口请求失败：${String(error)}`, {
          code: "TTS_API_FAILED",
          status: 502,
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    throw new AppError("配音接口请求失败", { code: "TTS_API_FAILED", status: 502 });
  }
}
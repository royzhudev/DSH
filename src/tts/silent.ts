import path from "node:path";
import type { TtsProvider, TtsRequest, TtsResult, TtsSettings } from "../types.js";
import type { Logger } from "../logger.js";
import { ensureDir, pathExists } from "../util/fs.js";
import { generateSilentAudio, probeMedia } from "../media/ffmpeg.js";
import { estimateSentences, estimateSpeechDuration } from "./estimate.js";

/**
 * 静音占位配音：没有可用 TTS 时仍能完成成片，方便离线演示与自动化测试。
 * 会在日志中明确告警，避免把静音成片误当成正常配音结果。
 */
export class SilentTtsProvider implements TtsProvider {
  readonly name = "silent";
  readonly voice = "silent";
  private readonly settings: TtsSettings;
  private readonly cacheDir: string;
  private readonly logger: Logger;

  constructor(settings: TtsSettings, cacheDir: string, logger: Logger) {
    this.settings = settings;
    this.cacheDir = cacheDir;
    this.logger = logger;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    await ensureDir(this.cacheDir);
    const audioFile = path.join(this.cacheDir, `${request.cacheKey}-silent.mp3`);
    let durationSec: number;
    if (this.settings.cache && (await pathExists(audioFile))) {
      const probe = await probeMedia(audioFile);
      durationSec = probe.durationSec ?? estimateSpeechDuration(request.text);
    } else {
      durationSec = estimateSpeechDuration(request.text);
      await generateSilentAudio(audioFile, durationSec);
    }
    this.logger.warn(`使用静音占位配音（${durationSec.toFixed(2)}s）：${request.text.slice(0, 24)}…`);
    return {
      provider: this.name,
      voice: this.voice,
      audioPath: audioFile,
      durationSec,
      sentences: estimateSentences(request.text, durationSec),
      cached: false,
    };
  }
}
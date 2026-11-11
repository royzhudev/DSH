import fs from "node:fs/promises";
import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { TtsProvider, TtsRequest, TtsResult, TtsSettings } from "../types.js";
import { ensureDir, pathExists, shortId } from "../util/fs.js";
import { escapeXml } from "../util/text.js";
import { probeMedia } from "../media/ffmpeg.js";
import { parseEdgeMetadata } from "./estimate.js";

export class EdgeTtsProvider implements TtsProvider {
  readonly name = "edge";
  readonly voice: string;
  private readonly settings: TtsSettings;
  private readonly cacheDir: string;
  private readonly logger: Logger;

  constructor(settings: TtsSettings, cacheDir: string, logger: Logger) {
    this.settings = settings;
    this.voice = settings.voice;
    this.cacheDir = cacheDir;
    this.logger = logger;
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    if (signal?.aborted) throw new AppError("任务已取消", { code: "ABORTED" });
    const audioFile = path.join(this.cacheDir, `${request.cacheKey}-edge.mp3`);
    const metaFile = path.join(this.cacheDir, `${request.cacheKey}-edge.meta.json`);
    await ensureDir(this.cacheDir);

    if (this.settings.cache && (await pathExists(audioFile))) {
      const probe = await probeMedia(audioFile);
      const durationSec = probe.durationSec ?? 0;
      const meta = (await pathExists(metaFile)) ? await fs.readFile(metaFile, "utf8") : "";
      return {
        provider: this.name,
        voice: this.voice,
        audioPath: audioFile,
        durationSec,
        sentences: parseEdgeMetadata(meta, request.text, durationSec),
        cached: true,
      };
    }

    const tempDir = path.join(this.cacheDir, `.edge-${shortId()}`);
    await ensureDir(tempDir);
    const tts = new MsEdgeTTS({
      connectionTimeoutMs: 20_000,
      synthesisTimeoutMs: this.settings.timeoutMs,
    });
    try {
      await tts.setMetadata(
        this.voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
        { sentenceBoundaryEnabled: true },
      );
      const { audioFilePath, metadataFilePath } = await tts.toFile(
        tempDir,
        escapeXml(request.text),
        { rate: this.settings.rate },
      );
      await fs.rename(audioFilePath, audioFile);
      if (metadataFilePath) {
        await fs.rename(metadataFilePath, metaFile);
      }
    } catch (error) {
      this.logger.warn(`Edge TTS 合成失败：${String(error)}`);
      throw new AppError(`Edge TTS 合成失败：${String(error)}`, {
        code: "TTS_FAILED",
        cause: error,
      });
    } finally {
      tts.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const probe = await probeMedia(audioFile);
    const durationSec = probe.durationSec ?? 0;
    if (!durationSec) {
      throw new AppError("Edge TTS 未返回有效音频时长", { code: "TTS_FAILED" });
    }
    const meta = (await pathExists(metaFile)) ? await fs.readFile(metaFile, "utf8") : "";
    return {
      provider: this.name,
      voice: this.voice,
      audioPath: audioFile,
      durationSec,
      sentences: parseEdgeMetadata(meta, request.text, durationSec),
      cached: false,
    };
  }
}
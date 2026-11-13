import type { AppConfig, TtsProvider, TtsRequest, TtsResult } from "../types.js";
import type { Logger } from "../logger.js";
import { EdgeTtsProvider } from "./edge.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { OpenAiTtsProvider } from "./openai.js";
import { SilentTtsProvider } from "./silent.js";

class FallbackTtsProvider implements TtsProvider {
  readonly name;
  readonly voice;

  constructor(
    private readonly primary: TtsProvider,
    private readonly fallback: TtsProvider,
    private readonly logger: Logger,
  ) {
    this.name = primary.name;
    this.voice = primary.voice;
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    try {
      return await this.primary.synthesize(request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.logger.warn(
        `配音供应商 ${this.primary.name} 失败，回退到静音占位：${error instanceof Error ? error.message : String(error)}`,
      );
      return this.fallback.synthesize(request, signal);
    }
  }
}

export function createTtsProvider(config: AppConfig, cacheDir: string, logger: Logger): TtsProvider {
  const silent = new SilentTtsProvider(config.tts, cacheDir, logger);
  switch (config.tts.provider) {
    case "silent":
      logger.warn("配音供应商：silent（仅静音占位，用于演示/测试）");
      return silent;
    case "openai": {
      const primary = new OpenAiTtsProvider(config.tts, cacheDir, logger);
      return config.tts.fallback === "silent"
        ? new FallbackTtsProvider(primary, silent, logger)
        : primary;
    }
    case "elevenlabs": {
      const primary = new ElevenLabsTtsProvider(config.tts, cacheDir, logger);
      logger.info(`配音供应商：elevenlabs（${config.tts.voice}）`);
      return config.tts.fallback === "silent"
        ? new FallbackTtsProvider(primary, silent, logger)
        : primary;
    }
    case "edge":
    default: {
      const primary = new EdgeTtsProvider(config.tts, cacheDir, logger);
      logger.info(`配音供应商：edge（${config.tts.voice}）`);
      return config.tts.fallback === "silent"
        ? new FallbackTtsProvider(primary, silent, logger)
        : primary;
    }
  }
}

export { EdgeTtsProvider } from "./edge.js";
export { ElevenLabsTtsProvider } from "./elevenlabs.js";
export { OpenAiTtsProvider } from "./openai.js";
export { SilentTtsProvider } from "./silent.js";
export { estimateSentences, estimateSpeechDuration, parseEdgeMetadata } from "./estimate.js";
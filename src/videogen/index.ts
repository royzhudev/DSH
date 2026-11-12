import type { AppConfig, VideoGenProvider } from "../types.js";
import type { Logger } from "../logger.js";
import { HttpVideoGenProvider } from "./http.js";

export function createVideoGenProvider(
  config: AppConfig,
  logger: Logger,
  fetchImpl?: typeof fetch,
): VideoGenProvider | null {
  if (config.videoGen.provider === "none") return null;
  logger.info(`AI 画面生成：http（${config.videoGen.model}）`);
  return new HttpVideoGenProvider(config.videoGen, logger, { fetchImpl });
}

export { HttpVideoGenProvider } from "./http.js";

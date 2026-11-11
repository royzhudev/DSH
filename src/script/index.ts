import type { AppConfig, Script, ScriptProvider, ScriptRequest } from "../types.js";
import type { Logger } from "../logger.js";
import { resolveScriptProvider } from "../config.js";
import { OfflineScriptProvider } from "./offline.js";
import { OpenAiScriptProvider } from "./openai.js";

class FallbackScriptProvider implements ScriptProvider {
  readonly name = "openai";

  constructor(
    private readonly primary: ScriptProvider,
    private readonly fallback: ScriptProvider,
    private readonly logger: Logger,
  ) {}

  async generate(request: ScriptRequest, signal?: AbortSignal): Promise<Script> {
    try {
      return await this.primary.generate(request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.logger.warn(
        `大模型脚本生成失败，改用离线模板：${error instanceof Error ? error.message : String(error)}`,
      );
      return this.fallback.generate(request, signal);
    }
  }
}

export function createScriptProvider(config: AppConfig, logger: Logger): ScriptProvider {
  const resolved = resolveScriptProvider(config);
  const offline = new OfflineScriptProvider();
  if (resolved === "offline") {
    logger.info("脚本供应商：offline（未配置 SCRIPT_API_KEY，使用内置模板）");
    return offline;
  }

  const openai = new OpenAiScriptProvider({ config: config.script, logger });
  if (!config.script.fallbackToOffline) return openai;
  return new FallbackScriptProvider(openai, offline, logger);
}

export { OfflineScriptProvider } from "./offline.js";
export { OpenAiScriptProvider } from "./openai.js";
export { normalizeScript, parseScriptJson, extractJsonObject } from "./parse.js";
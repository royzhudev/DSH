import path from "node:path";
import fs from "node:fs";
import { AppError } from "./errors.js";
import type { AppConfig, ScriptProviderName, TtsProviderName } from "./types.js";

export const DEFAULT_CONFIG: AppConfig = {
  outputDir: "./output",
  workDir: "./.work",
  libraryDir: "./materials",
  cacheDir: "./.cache",
  video: {
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 20,
    preset: "veryfast",
    transition: "fade",
    transitionDurationSec: 0.2,
    minSegmentSec: 2.2,
    tailPaddingSec: 0.4,
  },
  script: {
    provider: "auto",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    targetDurationSec: 45,
    maxSegments: 6,
    timeoutMs: 120_000,
    fallbackToOffline: true,
  },
  tts: {
    provider: "edge",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: 1.0,
    baseUrl: "https://api.openai.com/v1",
    model: "tts-1",
    timeoutMs: 120_000,
    fallback: "silent",
    cache: true,
  },
  subtitles: {
    enabled: true,
    fontFamily: "Noto Sans CJK SC",
    fontSize: 72,
    maxCharsPerLine: 16,
    maxLines: 2,
    marginV: 260,
    primaryColor: "#FFFFFF",
    outlineColor: "#000000",
    outline: 3,
    shadow: 1,
    bold: true,
  },
  materials: {
    allowUnmatched: false,
  },
  server: {
    host: "127.0.0.1",
    port: 8787,
    maxUploadBytes: 200 * 1024 * 1024,
  },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: DeepPartial<AppConfig>;
}

const SCRIPT_PROVIDERS: ScriptProviderName[] = ["auto", "openai", "offline"];
const TTS_PROVIDERS: TtsProviderName[] = ["edge", "openai", "silent"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只合并默认配置中存在的键，避免配置文件里的拼写错误污染运行配置。 */
function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in result) || value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? mergeKnown(current, value) : value;
  }
  return result as T;
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = envString(env, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`环境变量 ${name} 不是有效数字：${value}`, { code: "CONFIG_INVALID" });
  }
  return parsed;
}

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = envString(env, name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new AppError(`环境变量 ${name} 不是有效布尔值：${value}`, { code: "CONFIG_INVALID" });
}

function applyEnv(config: AppConfig, env: NodeJS.ProcessEnv): void {
  const set = <T>(current: T, value: T | undefined): T => (value === undefined ? current : value);

  config.outputDir = set(config.outputDir, envString(env, "VIDEO_AGENT_OUTPUT_DIR"));
  config.workDir = set(config.workDir, envString(env, "VIDEO_AGENT_WORK_DIR"));
  config.libraryDir = set(config.libraryDir, envString(env, "VIDEO_AGENT_LIBRARY_DIR"));
  config.cacheDir = set(config.cacheDir, envString(env, "VIDEO_AGENT_CACHE_DIR"));

  config.video.width = set(config.video.width, envNumber(env, "VIDEO_WIDTH"));
  config.video.height = set(config.video.height, envNumber(env, "VIDEO_HEIGHT"));
  config.video.fps = set(config.video.fps, envNumber(env, "VIDEO_FPS"));
  config.video.crf = set(config.video.crf, envNumber(env, "VIDEO_CRF"));
  config.video.preset = set(config.video.preset, envString(env, "VIDEO_PRESET"));

  const scriptProvider = envString(env, "SCRIPT_PROVIDER") as ScriptProviderName | undefined;
  if (scriptProvider) config.script.provider = scriptProvider;
  config.script.apiKey = set(
    config.script.apiKey,
    envString(env, "SCRIPT_API_KEY") ?? envString(env, "OPENAI_API_KEY"),
  );
  config.script.baseUrl = set(
    config.script.baseUrl,
    envString(env, "SCRIPT_BASE_URL") ?? envString(env, "OPENAI_BASE_URL"),
  );
  config.script.model = set(config.script.model, envString(env, "SCRIPT_MODEL"));
  config.script.temperature = set(config.script.temperature, envNumber(env, "SCRIPT_TEMPERATURE"));
  config.script.targetDurationSec = set(
    config.script.targetDurationSec,
    envNumber(env, "SCRIPT_TARGET_DURATION"),
  );
  config.script.maxSegments = set(config.script.maxSegments, envNumber(env, "SCRIPT_MAX_SEGMENTS"));
  config.script.timeoutMs = set(config.script.timeoutMs, envNumber(env, "SCRIPT_TIMEOUT_MS"));
  config.script.fallbackToOffline = set(
    config.script.fallbackToOffline,
    envBoolean(env, "SCRIPT_FALLBACK_OFFLINE"),
  );

  const ttsProvider = envString(env, "TTS_PROVIDER") as TtsProviderName | undefined;
  if (ttsProvider) config.tts.provider = ttsProvider;
  config.tts.voice = set(config.tts.voice, envString(env, "TTS_VOICE"));
  config.tts.rate = set(config.tts.rate, envNumber(env, "TTS_RATE"));
  config.tts.apiKey = set(
    config.tts.apiKey,
    envString(env, "TTS_API_KEY") ?? envString(env, "OPENAI_API_KEY"),
  );
  config.tts.baseUrl = set(
    config.tts.baseUrl,
    envString(env, "TTS_BASE_URL") ?? envString(env, "OPENAI_BASE_URL"),
  );
  config.tts.model = set(config.tts.model, envString(env, "TTS_MODEL"));
  config.tts.timeoutMs = set(config.tts.timeoutMs, envNumber(env, "TTS_TIMEOUT_MS"));
  config.tts.fallback = set(config.tts.fallback, envString(env, "TTS_FALLBACK") as "silent" | "error" | undefined);
  config.tts.cache = set(config.tts.cache, envBoolean(env, "TTS_CACHE"));

  config.subtitles.fontFamily = set(config.subtitles.fontFamily, envString(env, "SUBTITLE_FONT"));
  config.subtitles.fontSize = set(config.subtitles.fontSize, envNumber(env, "SUBTITLE_FONT_SIZE"));
  config.subtitles.maxCharsPerLine = set(
    config.subtitles.maxCharsPerLine,
    envNumber(env, "SUBTITLE_MAX_CHARS"),
  );
  config.subtitles.marginV = set(config.subtitles.marginV, envNumber(env, "SUBTITLE_MARGIN_V"));

  config.materials.allowUnmatched = set(
    config.materials.allowUnmatched,
    envBoolean(env, "MATERIALS_ALLOW_UNMATCHED"),
  );

  config.server.host = set(
    config.server.host,
    envString(env, "VIDEO_AGENT_HOST") ?? envString(env, "HOST"),
  );
  config.server.port = set(config.server.port, envNumber(env, "PORT"));
  config.server.maxUploadBytes = set(
    config.server.maxUploadBytes,
    envNumber(env, "MAX_UPLOAD_BYTES"),
  );
}

function requireRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new AppError(`配置 ${name} 必须在 ${min} 到 ${max} 之间，当前为 ${value}`, {
      code: "CONFIG_INVALID",
    });
  }
}

function validateConfig(config: AppConfig): void {
  requireRange("video.width", config.video.width, 160, 7680);
  requireRange("video.height", config.video.height, 160, 7680);
  requireRange("video.fps", config.video.fps, 10, 60);
  requireRange("video.crf", config.video.crf, 0, 51);
  requireRange("video.transitionDurationSec", config.video.transitionDurationSec, 0, 2);
  requireRange("video.minSegmentSec", config.video.minSegmentSec, 0.5, 30);
  requireRange("video.tailPaddingSec", config.video.tailPaddingSec, 0, 5);
  requireRange("script.temperature", config.script.temperature, 0, 2);
  requireRange("script.targetDurationSec", config.script.targetDurationSec, 5, 600);
  requireRange("script.maxSegments", config.script.maxSegments, 2, 20);
  requireRange("script.timeoutMs", config.script.timeoutMs, 1000, 600_000);
  requireRange("tts.rate", config.tts.rate, 0.5, 2);
  requireRange("tts.timeoutMs", config.tts.timeoutMs, 1000, 600_000);
  requireRange("subtitles.fontSize", config.subtitles.fontSize, 12, 160);
  requireRange("subtitles.maxCharsPerLine", config.subtitles.maxCharsPerLine, 4, 60);
  requireRange("subtitles.maxLines", config.subtitles.maxLines, 1, 4);
  requireRange("subtitles.marginV", config.subtitles.marginV, 0, 2000);
  requireRange("server.port", config.server.port, 0, 65535);
  requireRange("server.maxUploadBytes", config.server.maxUploadBytes, 1024, 2 * 1024 * 1024 * 1024);

  if (!SCRIPT_PROVIDERS.includes(config.script.provider)) {
    throw new AppError(`不支持的脚本供应商：${config.script.provider}`, { code: "CONFIG_INVALID" });
  }
  if (!TTS_PROVIDERS.includes(config.tts.provider)) {
    throw new AppError(`不支持的配音供应商：${config.tts.provider}`, { code: "CONFIG_INVALID" });
  }
  if (config.tts.fallback !== "silent" && config.tts.fallback !== "error") {
    throw new AppError(`tts.fallback 只能是 silent 或 error`, { code: "CONFIG_INVALID" });
  }
  if (config.video.transition !== "fade") {
    throw new AppError(`当前仅支持 fade 转场`, { code: "CONFIG_INVALID" });
  }
  if (config.script.provider === "openai" && !config.script.apiKey) {
    throw new AppError(
      "脚本供应商为 openai 但未配置 SCRIPT_API_KEY（或 OPENAI_API_KEY）。也可以改用 offline 或 auto。",
      { code: "CONFIG_MISSING_API_KEY" },
    );
  }
  if (config.tts.provider === "openai" && !config.tts.apiKey) {
    throw new AppError(
      "配音供应商为 openai 但未配置 TTS_API_KEY（或 OPENAI_API_KEY）。也可以改用 edge 或 silent。",
      { code: "CONFIG_MISSING_API_KEY" },
    );
  }

  config.video.width = Math.round(config.video.width / 2) * 2;
  config.video.height = Math.round(config.video.height / 2) * 2;
  config.video.fps = Math.round(config.video.fps);
  config.video.crf = Math.round(config.video.crf);
  config.script.maxSegments = Math.round(config.script.maxSegments);
  config.script.targetDurationSec = Math.round(config.script.targetDurationSec);
  config.subtitles.fontSize = Math.round(config.subtitles.fontSize);
  config.subtitles.maxCharsPerLine = Math.round(config.subtitles.maxCharsPerLine);
  config.subtitles.maxLines = Math.round(config.subtitles.maxLines);
  config.subtitles.marginV = Math.round(config.subtitles.marginV);
  config.server.port = Math.round(config.server.port);
  config.server.maxUploadBytes = Math.round(config.server.maxUploadBytes);
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitPath = options.configPath ?? envString(env, "VIDEO_AGENT_CONFIG");
  const configPath = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.join(cwd, "video-agent.config.json");

  let fileConfig: unknown = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new AppError(`无法解析配置文件 ${configPath}`, {
        code: "CONFIG_INVALID",
        cause: error,
      });
    }
  } else if (explicitPath) {
    throw new AppError(`配置文件不存在：${configPath}`, { code: "CONFIG_NOT_FOUND" });
  }

  let config = mergeKnown(structuredClone(DEFAULT_CONFIG), fileConfig);
  applyEnv(config, env);
  config = mergeKnown(config, options.overrides ?? {});

  config.outputDir = path.resolve(cwd, config.outputDir);
  config.workDir = path.resolve(cwd, config.workDir);
  config.libraryDir = path.resolve(cwd, config.libraryDir);
  config.cacheDir = path.resolve(cwd, config.cacheDir);
  config.script.baseUrl = config.script.baseUrl.replace(/\/+$/, "");
  config.tts.baseUrl = config.tts.baseUrl.replace(/\/+$/, "");

  validateConfig(config);
  return config;
}

/** auto 模式：有密钥走大模型，没有密钥走离线模板，保证开箱可跑通。 */
export function resolveScriptProvider(config: AppConfig): "openai" | "offline" {
  if (config.script.provider === "auto") {
    return config.script.apiKey ? "openai" : "offline";
  }
  return config.script.provider;
}

export interface ConfigSummary {
  scriptProvider: string;
  scriptModel: string;
  ttsProvider: string;
  ttsVoice: string;
  video: { width: number; height: number; fps: number };
  outputDir: string;
  libraryDir: string;
}

export function summarizeConfig(config: AppConfig): ConfigSummary {
  return {
    scriptProvider: resolveScriptProvider(config),
    scriptModel: config.script.model,
    ttsProvider: config.tts.provider,
    ttsVoice: config.tts.voice,
    video: {
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
    },
    outputDir: config.outputDir,
    libraryDir: config.libraryDir,
  };
}
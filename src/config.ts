import path from "node:path";
import fs from "node:fs";
import { AppError } from "./errors.js";
import { TTS_PROVIDER_NAMES } from "./types.js";
import type {
  AppConfig,
  ScriptProviderName,
  TtsProviderName,
  VideoGenChannel,
  VideoGenSettings,
} from "./types.js";

export const DASHSCOPE_VIDEO_BASE_URL = "https://dashscope.aliyuncs.com";
export const DASHSCOPE_VIDEO_SUBMIT_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
export const DASHSCOPE_VIDEO_POLL_PATH = "/api/v1/tasks/{id}";
/** One API Lumi（Nexus）的 Seedance 视频接口；任务接口挂在域名根下，不是 OpenAI 的 /v1 前缀。 */
export const ONEAPI_LUMI_VIDEO_BASE_URL = "https://nexus.cytain.com";
export const ONEAPI_LUMI_TASKS_PATH = "/api/v3/contents/generations/tasks";
export const ONEAPI_LUMI_TASK_PATH = "/api/v3/contents/generations/tasks/{id}";

export interface VideoGenModelOption {
  id: string;
  label: string;
  hint: string;
  minDurationSec: number;
  maxDurationSec: number;
}

/** One API Lumi 文档里的 Seedance 模型；2.5 最高 1080p，2.0 系列为 4k/720p。 */
export const SEEDANCE_MODEL_OPTIONS: readonly VideoGenModelOption[] = [
  {
    id: "doubao-seedance-2-5-260628",
    label: "Seedance 2.5（4–30 秒，最高 1080p）",
    hint: "支持首尾帧与参考图；时长 4–30 秒，分辨率最高 1080p。",
    minDurationSec: 4,
    maxDurationSec: 30,
  },
  {
    id: "doubao-seedance-2-0-260128",
    label: "Seedance 2.0（4–15 秒，最高 4k）",
    hint: "时长 4–15 秒，分辨率最高 4k；支持参考图。",
    minDurationSec: 4,
    maxDurationSec: 15,
  },
  {
    id: "doubao-seedance-2-0-fast-260128",
    label: "Seedance 2.0 Fast（4–15 秒，最高 720p）",
    hint: "生成更快，时长 4–15 秒，分辨率最高 720p。",
    minDurationSec: 4,
    maxDurationSec: 15,
  },
  {
    id: "doubao-seedance-2-0-mini-260615",
    label: "Seedance 2.0 Mini（4–15 秒，最高 720p）",
    hint: "轻量模型，时长 4–15 秒，分辨率最高 720p。",
    minDurationSec: 4,
    maxDurationSec: 15,
  },
] as const;

export const DEFAULT_CONFIG: AppConfig = {
  outputDir: "./output",
  workDir: "./.work",
  libraryDir: "./materials",
  castDir: "./cast",
  cacheDir: "./.cache",
  settingsFile: "./data/settings.json",
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
    targetDurationSec: 15,
    maxSegments: 6,
    timeoutMs: 120_000,
    fallbackToOffline: true,
  },
  tts: {
    enabled: true,
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
  videoGen: {
    // 默认接阿里百炼（DashScope）的 Wan 视频模型，API Key 由用户在设置页填写。
    channel: "bailian-wan3",
    provider: "http",
    // auto：默认地址是百炼时走 DashScope 异步协议，其他地址仍按通用契约，兼容旧配置。
    protocol: "auto",
    baseUrl: DASHSCOPE_VIDEO_BASE_URL,
    model: "wan3.0-video",
    editModel: "wan2.7-videoedit",
    submitPath: DASHSCOPE_VIDEO_SUBMIT_PATH,
    pollPath: DASHSCOPE_VIDEO_POLL_PATH,
    pollIntervalMs: 3000,
    timeoutMs: 300_000,
    clipDurationSec: 5,
    resultPath: "",
    fallbackToMaterials: true,
  },
  imageGen: {
    // 角色参考图默认接阿里百炼 Qwen-Image；只填 API Key 即可，地址留空沿用画面生成地址。
    provider: "bailian",
    baseUrl: "",
    apiKey: undefined,
    model: "qwen-image-2.0-pro",
    size: "1152*1536",
    negativePrompt:
      "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。",
    promptExtend: true,
    timeoutMs: 300_000,
  },
  lipsync: {
    // 总开关默认打开，但供应商默认 none，因此默认不会调用；
    // 选好百炼 VideoRetalk 并填 Key 后才真正生效，关掉总开关则完全跳过。
    enabled: true,
    provider: "none",
    baseUrl: "https://dashscope.aliyuncs.com",
    model: "videoretalk",
    timeoutMs: 900_000,
    pollIntervalMs: 5_000,
    fallbackToUnsynced: true,
  },
  douyin: {
    clientKey: "",
    redirectUri: "",
    scope: "user_info,video.create",
    apiBaseUrl: "https://open.douyin.com",
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
  /** 网页设置保存的覆盖文件，默认 <cwd>/data/settings.json。 */
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: DeepPartial<AppConfig>;
}

const SCRIPT_PROVIDERS: ScriptProviderName[] = ["auto", "openai", "offline"];
const VIDEO_GEN_PROVIDERS = ["none", "http"] as const;

/** AI 画面是否真的可用：启用了 HTTP 供应商并且填写了 API Key，否则走素材库。 */
export function isAiVideoEnabled(videoGen: AppConfig["videoGen"]): boolean {
  return videoGen.provider === "http" && Boolean(videoGen.apiKey);
}

/** 局部修改依赖百炼视频编辑模型，Seedance 等聚合渠道不支持。 */
export function isVideoEditSupported(videoGen: AppConfig["videoGen"]): boolean {
  return videoGen.channel === "bailian-wan3" || isDashscopeBaseUrl(videoGen.baseUrl);
}

/** 角色参考图生成是否可用：选择百炼并填写 API Key。 */
export function isImageGenEnabled(imageGen: AppConfig["imageGen"]): boolean {
  return imageGen.provider === "bailian" && Boolean(imageGen.apiKey);
}

const VIDEO_GEN_PROTOCOLS = ["auto", "dashscope", "generic", "seedance"] as const;
const VIDEO_GEN_CHANNELS: VideoGenChannel[] = [
  "none",
  "bailian-wan3",
  "aggregator-seedance2",
  "custom",
];

/** 渠道预置的非密钥参数；选中渠道后由服务端自动写入，用户只需要填 API Key。 */
export type VideoGenChannelFields = Pick<
  VideoGenSettings,
  | "channel"
  | "provider"
  | "protocol"
  | "baseUrl"
  | "model"
  | "editModel"
  | "submitPath"
  | "pollPath"
  | "pollIntervalMs"
  | "timeoutMs"
  | "clipDurationSec"
  | "resultPath"
>;

export interface VideoGenChannelOption {
  channel: VideoGenChannel;
  label: string;
  description: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  /** 渠道是否支持成片详情的「局部修改」（依赖百炼视频编辑模型）。 */
  editSupported: boolean;
  /** 同一渠道下可选的模型；没有时模型固定为 fields.model。 */
  models?: readonly VideoGenModelOption[];
  /** 是否接受本地参考图。One API Lumi 只接受公网图片，本地角色图不会上传。 */
  referenceImagesSupported?: boolean;
  /** 自动生成的参数；none/custom 没有。 */
  fields?: VideoGenChannelFields;
}

const BAILIAN_WAN3_FIELDS: VideoGenChannelFields = {
  channel: "bailian-wan3",
  provider: "http",
  protocol: "dashscope",
  baseUrl: DASHSCOPE_VIDEO_BASE_URL,
  model: "wan3.0-video",
  editModel: "wan2.7-videoedit",
  submitPath: DASHSCOPE_VIDEO_SUBMIT_PATH,
  pollPath: DASHSCOPE_VIDEO_POLL_PATH,
  pollIntervalMs: 3000,
  timeoutMs: 600_000,
  clipDurationSec: 5,
  resultPath: "",
};

const ONEAPI_LUMI_SEEDANCE_FIELDS: VideoGenChannelFields = {
  channel: "aggregator-seedance2",
  provider: "http",
  protocol: "seedance",
  baseUrl: ONEAPI_LUMI_VIDEO_BASE_URL,
  model: SEEDANCE_MODEL_OPTIONS[0]!.id,
  editModel: "wan2.7-videoedit",
  submitPath: ONEAPI_LUMI_TASKS_PATH,
  pollPath: ONEAPI_LUMI_TASK_PATH,
  pollIntervalMs: 3000,
  timeoutMs: 600_000,
  clipDurationSec: 5,
  resultPath: "content.video_url",
};

export const VIDEO_GEN_CHANNEL_OPTIONS: readonly VideoGenChannelOption[] = [
  {
    channel: "none",
    label: "不使用",
    description: "关闭 AI 画面生成，只用素材库/渐变背景。",
    apiKeyLabel: "API Key",
    apiKeyHint: "",
    editSupported: false,
  },
  {
    channel: "bailian-wan3",
    label: "阿里百炼 · wan3.0-video",
    description:
      "百炼异步视频接口，模型、地址、路径、轮询参数已预置；只需填百炼 API Key。",
    apiKeyLabel: "阿里百炼 API Key",
    apiKeyHint: "在阿里云百炼控制台创建，与 wan3.0-video 模型同一业务空间。",
    editSupported: true,
    referenceImagesSupported: true,
    fields: BAILIAN_WAN3_FIELDS,
  },
  {
    channel: "aggregator-seedance2",
    label: "One API Lumi · Seedance",
    description:
      "One API Lumi（nexus.cytain.com）的 Seedance 2.5 / 2.0 / Fast / Mini；模型、地址、路径、轮询参数已预置，只需填 API Key 并选择模型。平台只接受公网参考图，本地角色图不会上传，含参考图的分镜按文字生成。",
    apiKeyLabel: "One API Lumi API Key",
    apiKeyHint: "在 One API Lumi 创建，需有目标 Seedance 模型的调用权限。",
    editSupported: false,
    referenceImagesSupported: false,
    models: SEEDANCE_MODEL_OPTIONS,
    fields: ONEAPI_LUMI_SEEDANCE_FIELDS,
  },
  {
    channel: "custom",
    label: "自定义 HTTP 接口",
    description: "其他聚合平台或自建网关：手动填写接口协议、地址、模型与路径。",
    apiKeyLabel: "API Key",
    apiKeyHint: "",
    editSupported: true,
    referenceImagesSupported: true,
  },
];

export function videoGenChannelOption(channel: VideoGenChannel): VideoGenChannelOption | undefined {
  return VIDEO_GEN_CHANNEL_OPTIONS.find((option) => option.channel === channel);
}

/** 渠道要自动写入的参数；none 只关闭按钮，custom 保持用户填写。 */
export function videoGenChannelFields(
  channel: VideoGenChannel,
): VideoGenChannelFields | undefined {
  return videoGenChannelOption(channel)?.fields;
}

/** 从已有参数推断渠道，用于兼容旧设置文件（旧版本没有 channel 字段）。 */
export function inferVideoGenChannel(videoGen: VideoGenSettings): VideoGenChannel {
  if (videoGen.provider === "none") return "none";
  const model = videoGen.model.trim().toLowerCase();
  if (videoGen.protocol === "seedance" || model.includes("seedance")) {
    return "aggregator-seedance2";
  }
  if (isDashscopeBaseUrl(videoGen.baseUrl)) return "bailian-wan3";
  return "custom";
}

function readExplicitVideoGenChannel(patch: unknown): VideoGenChannel | undefined {
  if (!isPlainObject(patch) || !isPlainObject(patch.videoGen)) return undefined;
  const channel = patch.videoGen.channel;
  if (typeof channel !== "string") return undefined;
  const normalized = lowerToken(channel as VideoGenChannel);
  return VIDEO_GEN_CHANNELS.includes(normalized) ? normalized : undefined;
}

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
  config.castDir = set(config.castDir, envString(env, "VIDEO_AGENT_CAST_DIR"));
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

  config.tts.enabled = set(config.tts.enabled, envBoolean(env, "TTS_ENABLED"));
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

  const videoGenProvider = envString(env, "VIDEOGEN_PROVIDER") as "none" | "http" | undefined;
  if (videoGenProvider) config.videoGen.provider = videoGenProvider;
  config.videoGen.channel = set(
    config.videoGen.channel,
    envString(env, "VIDEOGEN_CHANNEL") as VideoGenChannel | undefined,
  );
  config.videoGen.protocol = set(
    config.videoGen.protocol,
    envString(env, "VIDEOGEN_PROTOCOL") as "auto" | "dashscope" | "generic" | "seedance" | undefined,
  );
  config.videoGen.baseUrl = set(config.videoGen.baseUrl, envString(env, "VIDEOGEN_BASE_URL"));
  config.videoGen.apiKey = set(config.videoGen.apiKey, envString(env, "VIDEOGEN_API_KEY"));
  config.videoGen.model = set(config.videoGen.model, envString(env, "VIDEOGEN_MODEL"));

  config.lipsync.enabled = set(config.lipsync.enabled, envBoolean(env, "LIPSYNC_ENABLED"));
  const lipsyncProvider = envString(env, "LIPSYNC_PROVIDER") as "none" | "dashscope" | undefined;
  if (lipsyncProvider) config.lipsync.provider = lipsyncProvider;
  config.lipsync.baseUrl = set(config.lipsync.baseUrl, envString(env, "LIPSYNC_BASE_URL"));
  config.lipsync.apiKey = set(config.lipsync.apiKey, envString(env, "LIPSYNC_API_KEY"));
  config.lipsync.model = set(config.lipsync.model, envString(env, "LIPSYNC_MODEL"));
  config.lipsync.pollIntervalMs = set(
    config.lipsync.pollIntervalMs,
    envNumber(env, "LIPSYNC_POLL_INTERVAL_MS"),
  );
  config.lipsync.timeoutMs = set(config.lipsync.timeoutMs, envNumber(env, "LIPSYNC_TIMEOUT_MS"));
  config.videoGen.submitPath = set(config.videoGen.submitPath, envString(env, "VIDEOGEN_SUBMIT_PATH"));
  config.videoGen.pollPath = set(config.videoGen.pollPath, envString(env, "VIDEOGEN_POLL_PATH"));
  config.videoGen.pollIntervalMs = set(
    config.videoGen.pollIntervalMs,
    envNumber(env, "VIDEOGEN_POLL_INTERVAL_MS"),
  );
  config.videoGen.timeoutMs = set(config.videoGen.timeoutMs, envNumber(env, "VIDEOGEN_TIMEOUT_MS"));
  config.videoGen.clipDurationSec = set(
    config.videoGen.clipDurationSec,
    envNumber(env, "VIDEOGEN_CLIP_DURATION"),
  );
  config.videoGen.resultPath = set(config.videoGen.resultPath, envString(env, "VIDEOGEN_RESULT_PATH"));
  config.videoGen.fallbackToMaterials = set(
    config.videoGen.fallbackToMaterials,
    envBoolean(env, "VIDEOGEN_FALLBACK_MATERIALS"),
  );

  config.douyin.clientKey = set(config.douyin.clientKey, envString(env, "DOUYIN_CLIENT_KEY"));
  config.douyin.clientSecret = set(config.douyin.clientSecret, envString(env, "DOUYIN_CLIENT_SECRET"));
  config.douyin.redirectUri = set(config.douyin.redirectUri, envString(env, "DOUYIN_REDIRECT_URI"));
  config.douyin.scope = set(config.douyin.scope, envString(env, "DOUYIN_SCOPE"));
  config.douyin.apiBaseUrl = set(config.douyin.apiBaseUrl, envString(env, "DOUYIN_API_BASE_URL"));

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
  requireRange("script.maxSegments", config.script.maxSegments, 1, 20);
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
  if (!TTS_PROVIDER_NAMES.includes(config.tts.provider)) {
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
  if (config.tts.enabled && config.tts.provider === "openai" && !config.tts.apiKey) {
    throw new AppError(
      "配音供应商为 openai 但未配置 TTS_API_KEY（或 OPENAI_API_KEY）。也可以改用 edge 或 silent。",
      { code: "CONFIG_MISSING_API_KEY" },
    );
  }
  if (!VIDEO_GEN_PROTOCOLS.includes(config.videoGen.protocol)) {
    throw new AppError("AI 画面生成的协议只能是 auto、dashscope、generic 或 seedance", {
      code: "CONFIG_INVALID",
    });
  }
  if (!VIDEO_GEN_CHANNELS.includes(config.videoGen.channel)) {
    throw new AppError(`不支持的画面模型渠道：${config.videoGen.channel}`, {
      code: "CONFIG_INVALID",
    });
  }
  if (!VIDEO_GEN_PROVIDERS.includes(config.videoGen.provider)) {
    throw new AppError(`不支持的画面生成供应商：${config.videoGen.provider}`, {
      code: "CONFIG_INVALID",
    });
  }
  requireRange("videoGen.pollIntervalMs", config.videoGen.pollIntervalMs, 200, 60_000);
  requireRange("videoGen.timeoutMs", config.videoGen.timeoutMs, 5_000, 1_800_000);
  requireRange("videoGen.clipDurationSec", config.videoGen.clipDurationSec, 2, 60);
  if (config.videoGen.provider === "http") {
    if (!config.videoGen.baseUrl) {
      throw new AppError("启用 AI 画面生成时，必须配置服务地址 VIDEOGEN_BASE_URL", {
        code: "CONFIG_INVALID",
      });
    }
    if (!config.videoGen.model) {
      throw new AppError("启用 AI 画面生成时，必须配置模型名称", { code: "CONFIG_INVALID" });
    }
    if (!config.videoGen.submitPath.startsWith("/") || !config.videoGen.pollPath.startsWith("/")) {
      throw new AppError("AI 画面生成的请求路径必须以 / 开头", { code: "CONFIG_INVALID" });
    }
    if (!config.videoGen.pollPath.includes("{id}")) {
      throw new AppError("AI 画面生成的查询路径必须包含 {id} 占位符", { code: "CONFIG_INVALID" });
    }
    const resultPath = config.videoGen.resultPath.trim();
    if (resultPath.length > 200) {
      throw new AppError("AI 画面生成的视频地址字段不能超过 200 个字符", { code: "CONFIG_INVALID" });
    }
    if (resultPath && !/^[A-Za-z0-9_.[\]-]+$/.test(resultPath)) {
      throw new AppError(
        "AI 画面生成的视频地址字段只能是点号路径，例如 data.output.video_url",
        { code: "CONFIG_INVALID" },
      );
    }
  }
  if (!config.douyin.scope.trim()) {
    throw new AppError("抖音授权 scope 不能为空", { code: "CONFIG_INVALID" });
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

  const envChannel = readExplicitVideoGenChannel({
    videoGen: { channel: envString(env, "VIDEOGEN_CHANNEL") },
  });
  let explicitChannel = envChannel ?? readExplicitVideoGenChannel(fileConfig);

  let config = mergeKnown(structuredClone(DEFAULT_CONFIG), fileConfig);
  applyEnv(config, env);

  // 网页保存的设置优先级高于配置文件与环境变量，低于调用方显式覆盖。
  const settingsPath = resolveSettingsPath({
    cwd,
    env,
    settingsPath: options.settingsPath,
    fallback: config.settingsFile,
  });
  if (fs.existsSync(settingsPath)) {
    let settingsConfig: unknown;
    try {
      settingsConfig = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw new AppError(`无法解析网页设置文件 ${settingsPath}`, {
        code: "CONFIG_INVALID",
        cause: error,
      });
    }
    config = mergeKnown(config, settingsConfig);
    // 旧版设置文件没有 channel；只有显式写过渠道时才信任它，否则按参数推断。
    explicitChannel =
      readExplicitVideoGenChannel(settingsConfig) ??
      explicitChannel;
  }

  config = mergeKnown(config, options.overrides ?? {});

  config.outputDir = path.resolve(cwd, config.outputDir);
  config.workDir = path.resolve(cwd, config.workDir);
  config.libraryDir = path.resolve(cwd, config.libraryDir);
  config.castDir = path.resolve(cwd, config.castDir);
  config.cacheDir = path.resolve(cwd, config.cacheDir);
  config.settingsFile = settingsPath;
  config.script.baseUrl = config.script.baseUrl.trim().replace(/\/+$/, "");
  config.tts.baseUrl = config.tts.baseUrl.trim().replace(/\/+$/, "");
  config.videoGen.baseUrl = config.videoGen.baseUrl.trim().replace(/\/+$/, "");
  if (config.videoGen.baseUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(config.videoGen.baseUrl)) {
    // 直接填域名（dashscope.aliyuncs.com）也能用，省得因为少了 https:// 而报连接失败。
    config.videoGen.baseUrl = `https://${config.videoGen.baseUrl}`;
  }
  config.douyin.apiBaseUrl = config.douyin.apiBaseUrl.trim().replace(/\/+$/, "");
  normalizeProviderTokens(config);
  normalizeVideoGenProtocol(config);
  config.videoGen.channel = explicitChannel ?? inferVideoGenChannel(config.videoGen);

  validateConfig(config);
  return config;
}

/** 枚举值统一成小写：网页设置或手写配置里常出现 BAILIAN、Edge 这类写法。 */
function lowerToken<T extends string>(value: T): T {
  return (typeof value === "string" ? value.trim().toLowerCase() : value) as T;
}

/**
 * 供应商、协议等枚举值不区分大小写。设置页把选项标签（例如 BAILIAN）直接存进配置后，
 * 如果不在这里归一化，创建任务就会在校验阶段报“不支持的配音提供商”。
 */
function normalizeProviderTokens(config: AppConfig): void {
  config.script.provider = lowerToken(config.script.provider);
  config.tts.provider = lowerToken(config.tts.provider);
  config.tts.fallback = lowerToken(config.tts.fallback);
  config.video.transition = lowerToken(config.video.transition);
  config.videoGen.provider = lowerToken(config.videoGen.provider);
  config.videoGen.protocol = lowerToken(config.videoGen.protocol);
  config.videoGen.channel = lowerToken(config.videoGen.channel);
  config.lipsync.provider = lowerToken(config.lipsync.provider);
}

function isDashscopeBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return /(^|\.)dashscope(-intl)?\.aliyuncs\.com$/.test(host);
  } catch {
    return false;
  }
}

function isOneApiLumiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "nexus.cytain.com";
  } catch {
    return false;
  }
}

/**
 * One API Lumi 的 Seedance 路由挂在域名根下（/api/v3/...）；用户给的
 * https://nexus.cytain.com/v1 是 OpenAI 兼容前缀，拼上 Seedance 路径会 404。
 * 这里把已知前缀收回域名，并顺手迁移旧版词易 Token 的路径。
 */
function normalizeOneApiLumi(config: AppConfig): void {
  if (!isOneApiLumiBaseUrl(config.videoGen.baseUrl)) return;
  if (config.videoGen.protocol !== "seedance" && !/seedance/i.test(config.videoGen.model)) {
    return;
  }
  try {
    const url = new URL(config.videoGen.baseUrl);
    const suffix = url.pathname.replace(/\/+$/, "");
    if (
      suffix === "/v1" ||
      suffix === "/api/v3" ||
      suffix === ONEAPI_LUMI_TASKS_PATH
    ) {
      config.videoGen.baseUrl = url.origin;
    }
  } catch {
    return;
  }
  if (config.videoGen.protocol === "auto" || config.videoGen.protocol === "generic") {
    config.videoGen.protocol = "seedance";
  }
  if (config.videoGen.submitPath === "/v1/video/generations") {
    config.videoGen.submitPath = ONEAPI_LUMI_TASKS_PATH;
  }
  if (config.videoGen.pollPath === "/v1/video/generations/{id}") {
    config.videoGen.pollPath = ONEAPI_LUMI_TASK_PATH;
  }
  if (config.videoGen.resultPath === "output.video_url") {
    config.videoGen.resultPath = "content.video_url";
  }
}

/**
 * 服务地址就是阿里百炼时，视频接口只支持异步调用（缺少 X-DashScope-Async: enable 会被
 * 平台以 AccessDenied「current user api does not support synchronous calls」拒绝）。
 * 「通用 HTTP」协议发的是扁平字段、也没有异步请求头，必然失败，所以这里直接纠正，
 * 避免用户选错协议后只能看到一段平台报错。
 */
function normalizeVideoGenProtocol(config: AppConfig): void {
  normalizeOneApiLumi(config);
  if (!isDashscopeBaseUrl(config.videoGen.baseUrl)) return;
  // 常见的手填错误：把完整接口地址（或 compatible-mode 地址）当成「服务地址」。
  // 百炼的异步视频接口固定挂在域名根下，这里收回域名，避免路径重复。
  try {
    const url = new URL(config.videoGen.baseUrl);
    const suffix = url.pathname.replace(/\/+$/, "");
    if (
      suffix === "/api/v1" ||
      suffix === "/compatible-mode/v1" ||
      suffix === DASHSCOPE_VIDEO_SUBMIT_PATH
    ) {
      config.videoGen.baseUrl = url.origin;
    }
  } catch {
    return;
  }
  if (config.videoGen.protocol === "generic") config.videoGen.protocol = "dashscope";
  if (config.videoGen.submitPath === "/v1/videos/generations") {
    config.videoGen.submitPath = DASHSCOPE_VIDEO_SUBMIT_PATH;
  }
  if (config.videoGen.pollPath === "/v1/videos/generations/{id}") {
    config.videoGen.pollPath = DASHSCOPE_VIDEO_POLL_PATH;
  }
}

export function resolveSettingsPath(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  settingsPath?: string;
  fallback?: string;
} = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  if (options.settingsPath) return path.resolve(cwd, options.settingsPath);
  const fromEnv = envString(env, "VIDEO_AGENT_SETTINGS_FILE");
  if (fromEnv) return path.resolve(cwd, fromEnv);
  const fallback = options.fallback?.trim();
  return fallback ? path.resolve(cwd, fallback) : path.join(cwd, "data", "settings.json");
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
  castDir: string;
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
    castDir: config.castDir,
  };
}
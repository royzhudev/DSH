import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AppError } from "../errors.js";
import {
  DEFAULT_CONFIG,
  VIDEO_GEN_CHANNEL_OPTIONS,
  loadConfig,
  videoGenChannelFields,
  videoGenChannelOption,
  type DeepPartial,
  type VideoGenChannelOption,
} from "../config.js";
import type { Logger } from "../logger.js";
import type { AppConfig, VideoGenChannel } from "../types.js";
import { ensureDir } from "../util/fs.js";

const EDITABLE_SECTIONS = [
  "script",
  "tts",
  "video",
  "subtitles",
  "materials",
  "videoGen",
  "imageGen",
  "lipsync",
  "douyin",
] as const;

type EditableSection = (typeof EDITABLE_SECTIONS)[number];
type Overlay = Partial<Record<EditableSection, Record<string, unknown>>> & { updatedAt?: string };

const SECRET_KEYS = new Set(["apiKey", "clientSecret"]);

/** 取值是固定枚举的字段：保存时统一小写，避免 BAILIAN 这类写法存进配置后校验失败。 */
const TOKEN_KEYS = new Set(["provider", "protocol", "fallback", "transition", "channel", "mode"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretView(value: string | undefined): { set: boolean; hint?: string } {
  if (!value) return { set: false };
  return { set: true, hint: value.length <= 4 ? "已配置" : `…${value.slice(-4)}` };
}

function maskSecretFields(section: string, value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  for (const key of SECRET_KEYS) {
    if (key in result) {
      const { set, hint } = secretView(typeof result[key] === "string" ? (result[key] as string) : undefined);
      delete result[key];
      result[`${key}Set`] = set;
      if (hint) result[`${key}Hint`] = hint;
    }
  }
  return result;
}

export interface SettingsView {
  script: Record<string, unknown> & { apiKeySet: boolean; apiKeyHint?: string };
  tts: Record<string, unknown> & { apiKeySet: boolean; apiKeyHint?: string };
  video: Record<string, unknown>;
  subtitles: Record<string, unknown>;
  materials: Record<string, unknown>;
  videoGen: Record<string, unknown> & { apiKeySet: boolean; apiKeyHint?: string };
  /** 可选渠道及其自动生成参数，前端据此切换并回填表单。 */
  videoGenChannels: readonly VideoGenChannelOption[];
  imageGen: Record<string, unknown> & { apiKeySet: boolean; apiKeyHint?: string };
  lipsync: Record<string, unknown> & { apiKeySet: boolean; apiKeyHint?: string };
  douyin: Record<string, unknown> & {
    clientSecretSet: boolean;
    clientSecretHint?: string;
    effectiveRedirectUri: string;
  };
  server: { host: string; port: number };
  paths: { outputDir: string; libraryDir: string; castDir: string; settingsFile: string };
  updatedAt?: string;
}

export function effectiveRedirectUri(config: AppConfig): string {
  if (config.douyin.redirectUri.trim()) return config.douyin.redirectUri.trim();
  const host = config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return `http://${displayHost}:${config.server.port}/api/douyin/callback`;
}

export function serializeSettings(config: AppConfig, settingsPath: string, updatedAt?: string): SettingsView {
  const sections = {} as Record<EditableSection, Record<string, unknown>>;
  for (const section of EDITABLE_SECTIONS) {
    sections[section] = maskSecretFields(section, config[section] as unknown as Record<string, unknown>);
  }
  for (const section of ["script", "tts", "videoGen", "imageGen", "lipsync"] as const) {
    if (!("apiKeySet" in sections[section])) sections[section].apiKeySet = false;
  }
  if (!("clientSecretSet" in sections.douyin)) sections.douyin.clientSecretSet = false;
  return {
    script: sections.script as SettingsView["script"],
    tts: sections.tts as SettingsView["tts"],
    video: sections.video,
    subtitles: sections.subtitles,
    materials: sections.materials,
    videoGen: sections.videoGen as SettingsView["videoGen"],
    videoGenChannels: VIDEO_GEN_CHANNEL_OPTIONS,
    imageGen: sections.imageGen as SettingsView["imageGen"],
    lipsync: sections.lipsync as SettingsView["lipsync"],
    douyin: {
      ...sections.douyin,
      effectiveRedirectUri: effectiveRedirectUri(config),
    } as SettingsView["douyin"],
    server: { host: config.server.host, port: config.server.port },
    paths: {
      outputDir: config.outputDir,
      libraryDir: config.libraryDir,
      castDir: config.castDir,
      settingsFile: settingsPath,
    },
    updatedAt,
  };
}

function sanitizeSection(section: EditableSection, patch: unknown): Record<string, unknown> {
  if (patch === undefined) return {};
  if (!isRecord(patch)) {
    throw new AppError(`设置项 ${section} 必须是对象`, { code: "SETTINGS_INVALID", status: 400 });
  }
  const defaults = DEFAULT_CONFIG[section] as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults) && !SECRET_KEYS.has(key)) continue;
    const fallback = defaults[key];
    if (value === undefined) continue;
    if (value === null) {
      if (SECRET_KEYS.has(key)) result[key] = "";
      continue;
    }
    if (isRecord(fallback) && isRecord(value)) {
      result[key] = sanitizeSection(section, value);
      continue;
    }
    result[key] = TOKEN_KEYS.has(key) && typeof value === "string" ? value.trim().toLowerCase() : value;
  }
  return result;
}

function mergeOverlay(base: Overlay, patch: Record<string, unknown>): Overlay {
  const merged: Overlay = { ...base };
  for (const section of EDITABLE_SECTIONS) {
    if (!(section in patch)) continue;
    const current = (base[section] ?? {}) as Record<string, unknown>;
    const next = sanitizeSection(section, patch[section]);
    merged[section] = { ...current, ...next };
  }
  return merged;
}

function requestedVideoGenChannel(patch: Record<string, unknown>): VideoGenChannel | undefined {
  const videoGen = patch.videoGen;
  if (!isRecord(videoGen) || typeof videoGen.channel !== "string") return undefined;
  const channel = videoGen.channel.trim().toLowerCase() as VideoGenChannel;
  return VIDEO_GEN_CHANNEL_OPTIONS.some((option) => option.channel === channel)
    ? channel
    : undefined;
}

/** 把渠道的预置参数写进保存对象；API Key 与其他用户可调开关不受影响。 */
function applyVideoGenChannel(
  target: Record<string, unknown>,
  channel: VideoGenChannel,
  requestedModel?: string,
): void {
  target.channel = channel;
  if (channel === "none") {
    target.provider = "none";
    return;
  }
  const fields = videoGenChannelFields(channel);
  if (fields) Object.assign(target, fields);
  // 同一渠道可选多个模型时，保留用户在下拉框里选的那个；非法值回退渠道默认模型。
  const models = videoGenChannelOption(channel)?.models;
  if (models && typeof requestedModel === "string") {
    const selected = models.find((model) => model.id === requestedModel.trim());
    if (selected) target.model = selected.id;
  }
}

function toConfigError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (error.status >= 400 && error.status < 500) return error;
    return new AppError(error.message, { code: error.code, status: 400, cause: error });
  }
  return new AppError(error instanceof Error ? error.message : String(error), {
    code: "SETTINGS_INVALID",
    status: 400,
    cause: error,
  });
}

/**
 * 网页设置存储：把用户可编辑的配置持久化到 data/settings.json，
 * 并原地更新运行中的配置对象（新任务生效，已排队任务使用创建时的快照）。
 */
export class SettingsStore {
  private overlay: Overlay = {};
  private updatedAt: string | undefined;
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly options: {
      settingsPath: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
      logger: Logger;
    },
  ) {}

  get settingsPath(): string {
    return this.options.settingsPath;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.load().finally(() => {
      this.loaded = true;
    });
    await this.loadPromise;
  }

  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.options.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return;
      this.overlay = mergeOverlay({}, parsed);
      if (typeof parsed.updatedAt === "string") this.updatedAt = parsed.updatedAt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn(`网页设置读取失败，将使用环境配置：${String(error)}`);
      }
    }
  }

  async view(): Promise<SettingsView> {
    await this.ensureLoaded();
    return serializeSettings(this.config, this.options.settingsPath, this.updatedAt);
  }

  async update(patch: unknown): Promise<SettingsView> {
    await this.ensureLoaded();
    if (!isRecord(patch)) {
      throw new AppError("设置请求体必须是 JSON 对象", { code: "SETTINGS_INVALID", status: 400 });
    }
    const merged = mergeOverlay(this.overlay, patch);
    // 以运行中的配置为底，保留命令行/测试注入等显式覆盖，避免保存设置时被重置。
    const current = structuredClone(this.config) as unknown as Record<string, unknown>;
    for (const section of EDITABLE_SECTIONS) {
      if (!(section in merged)) continue;
      current[section] = {
        ...(current[section] as Record<string, unknown>),
        ...(merged[section] as Record<string, unknown>),
      };
    }
    // 选中渠道后由服务端写入预置参数：客户端可以只传 channel 与 apiKey，
    // 地址、模型、路径、轮询间隔都不会再依赖手填。
    const requestedChannel = requestedVideoGenChannel(patch);
    if (requestedChannel) {
      const requestedModel =
        isRecord(merged.videoGen) && typeof merged.videoGen.model === "string"
          ? merged.videoGen.model
          : undefined;
      applyVideoGenChannel(merged.videoGen!, requestedChannel, requestedModel);
      applyVideoGenChannel(
        current.videoGen as Record<string, unknown>,
        requestedChannel,
        requestedModel,
      );
    }
    // 公网素材地址用于把本地角色图映射成平台可访问的只读 URL；令牌只生成一次，
    // 清除地址时一并清除，避免旧的公开链接继续暴露角色图。
    const mergedVideoGen = isRecord(merged.videoGen) ? merged.videoGen : undefined;
    if (mergedVideoGen) {
      const currentVideoGen = current.videoGen as Record<string, unknown>;
      const publicBaseUrl =
        typeof mergedVideoGen.publicBaseUrl === "string"
          ? mergedVideoGen.publicBaseUrl.trim().replace(/\/+$/, "")
          : String(currentVideoGen.publicBaseUrl ?? "").trim();
      const existingToken =
        typeof mergedVideoGen.publicAssetToken === "string"
          ? mergedVideoGen.publicAssetToken.trim()
          : String(currentVideoGen.publicAssetToken ?? "").trim();
      const publicAssetToken = publicBaseUrl
        ? existingToken || randomBytes(24).toString("base64url")
        : "";
      mergedVideoGen.publicBaseUrl = publicBaseUrl;
      mergedVideoGen.publicAssetToken = publicAssetToken;
      currentVideoGen.publicBaseUrl = publicBaseUrl;
      currentVideoGen.publicAssetToken = publicAssetToken;
    }
    let next: AppConfig;
    try {
      next = loadConfig({
        cwd: this.options.cwd,
        env: this.options.env,
        settingsPath: this.options.settingsPath,
        overrides: current as DeepPartial<AppConfig>,
      });
    } catch (error) {
      throw toConfigError(error);
    }
    // 旧设置文件里的 channel 可能早于本次选择；以本次请求为准（custom 也要保留）。
    if (requestedChannel) next.videoGen.channel = requestedChannel;

    const updatedAt = new Date().toISOString();
    await this.persist({ ...merged, updatedAt });
    this.overlay = merged;
    this.updatedAt = updatedAt;
    Object.assign(this.config, next);
    this.options.logger.info("设置已更新");
    return serializeSettings(this.config, this.options.settingsPath, this.updatedAt);
  }

  private async persist(overlay: Overlay): Promise<void> {
    await ensureDir(path.dirname(this.options.settingsPath));
    const tmp = `${this.options.settingsPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.options.settingsPath);
    await fsp.chmod(this.options.settingsPath, 0o600).catch(() => undefined);
  }
}

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
import { IMAGE_GEN_MODEL_OPTIONS, type ImageGenModelOption } from "../imagegen/models.js";
import { ensureDir } from "../util/fs.js";

/** 每用户可编辑的个人设置：模型 API Key、音色、画面渠道与个人偏好。 */
export const PERSONAL_SECTIONS = [
  "script",
  "tts",
  "video",
  "subtitles",
  "materials",
  "videoGen",
  "imageGen",
  "lipsync",
] as const;

/** 平台级设置：只有管理员能改，影响整个部署。 */
export const PLATFORM_SECTIONS = ["douyin", "mail", "registration"] as const;

type PersonalSection = (typeof PERSONAL_SECTIONS)[number];
type PlatformSection = (typeof PLATFORM_SECTIONS)[number];
type EditableSection = PersonalSection | PlatformSection;

type Overlay = Partial<Record<EditableSection, Record<string, unknown>>> & {
  updatedAt?: string;
  /** 平台级部署地址；只有平台设置使用。 */
  publicBaseUrl?: string;
};

const SECRET_KEYS = new Set(["apiKey", "clientSecret", "password"]);

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
  /** 阿里百炼可切换的文生图模型；前端据此渲染下拉框并显示模型说明。 */
  imageGenModels: readonly ImageGenModelOption[];
  lipsync: Record<string, unknown> & { apiKeySet: boolean; apiKeyHint?: string };
  server: { host: string; port: number; publicBaseUrl: string };
  paths: { outputDir: string; libraryDir: string; castDir: string; settingsFile: string };
  updatedAt?: string;
}

export interface PlatformSettingsView {
  douyin: Record<string, unknown> & {
    clientSecretSet: boolean;
    clientSecretHint?: string;
    effectiveRedirectUri: string;
  };
  mail: Record<string, unknown> & {
    passwordSet: boolean;
    passwordHint?: string;
    configured: boolean;
  };
  registration: { enabled: boolean; allowedEmailDomains: string[] };
  server: { host: string; port: number; publicBaseUrl: string };
  paths: { settingsFile: string };
  updatedAt?: string;
}

export function effectiveRedirectUri(config: AppConfig): string {
  if (config.douyin.redirectUri.trim()) return config.douyin.redirectUri.trim();
  const host = config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return `http://${displayHost}:${config.server.port}/api/douyin/callback`;
}

function sectionView(config: AppConfig, section: EditableSection): Record<string, unknown> {
  return maskSecretFields(section, config[section] as unknown as Record<string, unknown>);
}

export function serializeSettings(
  config: AppConfig,
  settingsPath: string,
  updatedAt?: string,
): SettingsView {
  const sections = {} as Record<PersonalSection, Record<string, unknown>>;
  for (const section of PERSONAL_SECTIONS) {
    sections[section] = sectionView(config, section);
  }
  return {
    script: sections.script as SettingsView["script"],
    tts: sections.tts as SettingsView["tts"],
    video: sections.video,
    subtitles: sections.subtitles,
    materials: sections.materials,
    videoGen: sections.videoGen as SettingsView["videoGen"],
    videoGenChannels: VIDEO_GEN_CHANNEL_OPTIONS,
    imageGen: sections.imageGen as SettingsView["imageGen"],
    imageGenModels: IMAGE_GEN_MODEL_OPTIONS,
    lipsync: sections.lipsync as SettingsView["lipsync"],
    server: {
      host: config.server.host,
      port: config.server.port,
      publicBaseUrl: config.server.publicBaseUrl,
    },
    paths: {
      outputDir: config.outputDir,
      libraryDir: config.libraryDir,
      castDir: config.castDir,
      settingsFile: settingsPath,
    },
    updatedAt,
  };
}

export function serializePlatformSettings(
  config: AppConfig,
  settingsPath: string,
  updatedAt?: string,
): PlatformSettingsView {
  const douyin = sectionView(config, "douyin") as PlatformSettingsView["douyin"];
  const mail = sectionView(config, "mail") as PlatformSettingsView["mail"];
  return {
    douyin: { ...douyin, effectiveRedirectUri: effectiveRedirectUri(config) },
    mail: {
      ...mail,
      configured: Boolean(config.mail.enabled && config.mail.host && config.mail.from),
    },
    registration: {
      enabled: config.registration.enabled,
      allowedEmailDomains: [...config.registration.allowedEmailDomains],
    },
    server: {
      host: config.server.host,
      port: config.server.port,
      publicBaseUrl: config.server.publicBaseUrl,
    },
    paths: { settingsFile: settingsPath },
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
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new AppError(`设置项 ${section}.${key} 必须是字符串数组`, {
          code: "SETTINGS_INVALID",
          status: 400,
        });
      }
      result[key] = value.map((item) => item.trim()).filter(Boolean);
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

function mergeOverlay(base: Overlay, patch: Record<string, unknown>, sections: readonly EditableSection[]): Overlay {
  const merged: Overlay = { ...base };
  for (const section of sections) {
    if (!(section in patch)) continue;
    const current = (base[section] ?? {}) as Record<string, unknown>;
    const next = sanitizeSection(section, patch[section]);
    merged[section] = { ...current, ...next };
  }
  return merged;
}

function applyOverlaySections(
  target: Record<string, unknown>,
  overlay: Overlay,
  sections: readonly EditableSection[],
): void {
  for (const section of sections) {
    const value = overlay[section];
    if (!value) continue;
    target[section] = { ...(target[section] as Record<string, unknown>), ...value };
  }
}

function requestedVideoGenChannel(patch: Record<string, unknown>): VideoGenChannel | undefined {
  const videoGen = patch.videoGen;
  if (!isRecord(videoGen) || typeof videoGen.channel !== "string") return undefined;
  const channel = videoGen.channel.trim().toLowerCase() as VideoGenChannel;
  return VIDEO_GEN_CHANNEL_OPTIONS.some((option) => option.channel === channel) ? channel : undefined;
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

interface PersonalStoreOptions {
  settingsPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** 平台配置的公网地址；个人没填时作为默认值。 */
  defaultPublicBaseUrl?: () => string;
}

/**
 * 每用户设置存储：把个人可编辑的配置持久化到 data/users/<id>/settings.json，
 * 并原地更新交给它的配置对象（该对象是平台配置的副本，改不到别人）。
 * 新任务使用保存后的快照；已排队任务继续用创建时的配置。
 */
export class SettingsStore {
  private overlay: Overlay = {};
  private updatedAt: string | undefined;
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly options: PersonalStoreOptions,
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
      if (isRecord(parsed)) {
        this.overlay = mergeOverlay({}, parsed, PERSONAL_SECTIONS);
        if (typeof parsed.updatedAt === "string") this.updatedAt = parsed.updatedAt;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn(`个人设置读取失败，将使用平台配置：${String(error)}`);
      }
    }
    // 个人设置文件不经过 loadConfig 读取，这里把覆盖应用到位。
    await this.recompute(this.overlay);
    // 首次生成或平台地址带来新令牌时立刻落盘，避免重启后旧链接失效。
    const token = this.config.videoGen.publicAssetToken;
    if (token && this.overlay.videoGen?.publicAssetToken !== token) {
      this.overlay = {
        ...this.overlay,
        videoGen: { ...(this.overlay.videoGen ?? {}), publicAssetToken: token },
      };
      await this.persist(this.overlay);
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
    const merged = mergeOverlay(this.overlay, patch, PERSONAL_SECTIONS);
    // 选中渠道后由服务端写入预置参数：客户端可以只传 channel 与 apiKey，
    // 地址、模型、路径、轮询间隔都不会再依赖手填。
    const requestedChannel = requestedVideoGenChannel(patch);
    if (requestedChannel) {
      const requestedModel = isRecord(merged.videoGen) && typeof merged.videoGen.model === "string"
        ? merged.videoGen.model
        : undefined;
      merged.videoGen = { ...(merged.videoGen ?? {}) };
      applyVideoGenChannel(merged.videoGen, requestedChannel, requestedModel);
    }
    await this.recompute(merged);
    const updatedAt = new Date().toISOString();
    await this.persist({ ...merged, updatedAt });
    this.overlay = merged;
    this.updatedAt = updatedAt;
    this.options.logger.info("个人设置已更新");
    return serializeSettings(this.config, this.options.settingsPath, this.updatedAt);
  }

  /** 依次应用个人覆盖、部署默认公网地址与素材令牌，然后校验并写回 this.config。 */
  private async recompute(merged: Overlay, persistToken = false): Promise<void> {
    const current = structuredClone(this.config) as unknown as Record<string, unknown>;
    applyOverlaySections(current, merged, PERSONAL_SECTIONS);
    const videoGen = current.videoGen as Record<string, unknown>;
    const explicitBase =
      typeof videoGen.publicBaseUrl === "string" ? videoGen.publicBaseUrl.trim().replace(/\/+$/, "") : "";
    const fallbackBase = (this.options.defaultPublicBaseUrl?.() ?? "").trim().replace(/\/+$/, "");
    const publicBaseUrl = explicitBase || fallbackBase;
    let token = typeof videoGen.publicAssetToken === "string" ? videoGen.publicAssetToken.trim() : "";
    if (publicBaseUrl && !token) token = randomBytes(24).toString("base64url");
    if (!publicBaseUrl) token = "";
    videoGen.publicBaseUrl = publicBaseUrl;
    videoGen.publicAssetToken = token;
    // 令牌要落盘，否则重启后旧链接全部失效。
    if (token && token !== this.overlay.videoGen?.publicAssetToken) {
      merged.videoGen = { ...(merged.videoGen ?? {}), publicAssetToken: token };
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
    Object.assign(this.config, next);
  }

  private async persist(overlay: Overlay): Promise<void> {
    await ensureDir(path.dirname(this.options.settingsPath));
    const tmp = `${this.options.settingsPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.options.settingsPath);
    await fsp.chmod(this.options.settingsPath, 0o600).catch(() => undefined);
  }
}

interface PlatformStoreOptions {
  settingsPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

/**
 * 平台设置存储：邮件通道、注册开关、抖音应用凭证与部署公网地址。
 * 只有管理员能改；保存后影响到所有用户（个人覆盖仍然优先）。
 */
export class PlatformSettingsStore {
  private overlay: Overlay = {};
  private updatedAt: string | undefined;
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly options: PlatformStoreOptions,
  ) {}

  get settingsPath(): string {
    return this.options.settingsPath;
  }

  get currentConfig(): AppConfig {
    return this.config;
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
      if (isRecord(parsed)) {
        this.overlay = this.platformOverlayFrom(parsed);
        if (typeof parsed.updatedAt === "string") this.updatedAt = parsed.updatedAt;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn(`平台设置读取失败，将使用环境配置：${String(error)}`);
      }
    }
    this.apply(this.overlay);
  }

  async view(): Promise<PlatformSettingsView> {
    await this.ensureLoaded();
    return serializePlatformSettings(this.config, this.options.settingsPath, this.updatedAt);
  }

  async update(patch: unknown): Promise<PlatformSettingsView> {
    await this.ensureLoaded();
    if (!isRecord(patch)) {
      throw new AppError("设置请求体必须是 JSON 对象", { code: "SETTINGS_INVALID", status: 400 });
    }
    const merged = mergeOverlay(this.overlay, patch, PLATFORM_SECTIONS);
    if (isRecord(patch.server) && typeof patch.server.publicBaseUrl === "string") {
      merged.publicBaseUrl = patch.server.publicBaseUrl.trim().replace(/\/+$/, "");
    }
    this.apply(merged);
    const updatedAt = new Date().toISOString();
    await this.persist({ ...merged, updatedAt });
    this.overlay = merged;
    this.updatedAt = updatedAt;
    this.options.logger.info("平台设置已更新");
    return serializePlatformSettings(this.config, this.options.settingsPath, this.updatedAt);
  }

  private platformOverlayFrom(parsed: Record<string, unknown>): Overlay {
    const overlay = mergeOverlay({}, parsed, PLATFORM_SECTIONS);
    if (isRecord(parsed.server) && typeof parsed.server.publicBaseUrl === "string") {
      overlay.publicBaseUrl = parsed.server.publicBaseUrl.trim().replace(/\/+$/, "");
    }
    return overlay;
  }

  private apply(overlay: Overlay): void {
    const before = structuredClone(this.config);
    const current = structuredClone(this.config) as unknown as Record<string, unknown>;
    applyOverlaySections(current, overlay, PLATFORM_SECTIONS);
    if (overlay.publicBaseUrl !== undefined) {
      current.server = {
        ...(current.server as Record<string, unknown>),
        publicBaseUrl: overlay.publicBaseUrl,
      };
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
    // 平台设置文件里可能残留旧版的个人设置，个人部分一律以内存基线为准，
    // 避免把管理员或前一个用户的 API Key 带进其他人的有效配置。
    for (const section of PERSONAL_SECTIONS) {
      (next as unknown as Record<string, unknown>)[section] = before[section];
    }
    Object.assign(this.config, next);
  }

  /**
   * 迁移完成后调用：把平台配置里残留的个人设置恢复为部署基线
   * （默认值 + 配置文件 + 环境变量），不读取 data/settings.json。
   */
  async resetPersonalSections(sections: readonly PersonalSection[]): Promise<void> {
    if (sections.length === 0) return;
    const baseline = loadConfig({
      cwd: this.options.cwd,
      env: this.options.env,
      settingsPath: this.options.settingsPath,
      skipSettingsFile: true,
      overrides: {},
    });
    for (const section of sections) {
      (this.config as unknown as Record<string, unknown>)[section] = baseline[section];
    }
  }

  private async persist(overlay: Overlay): Promise<void> {
    await ensureDir(path.dirname(this.options.settingsPath));
    const payload: Record<string, unknown> = {
      ...overlay,
      ...(overlay.publicBaseUrl !== undefined
        ? { server: { publicBaseUrl: overlay.publicBaseUrl } }
        : {}),
      updatedAt: overlay.updatedAt,
    };
    delete payload.publicBaseUrl;
    const tmp = `${this.options.settingsPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.options.settingsPath);
    await fsp.chmod(this.options.settingsPath, 0o600).catch(() => undefined);
  }
}
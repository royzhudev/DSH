import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import { DEFAULT_CONFIG, loadConfig, type DeepPartial } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppConfig } from "../types.js";
import { ensureDir } from "../util/fs.js";

const EDITABLE_SECTIONS = [
  "script",
  "tts",
  "video",
  "subtitles",
  "materials",
  "videoGen",
  "lipsync",
  "douyin",
] as const;

type EditableSection = (typeof EDITABLE_SECTIONS)[number];
type Overlay = Partial<Record<EditableSection, Record<string, unknown>>> & { updatedAt?: string };

const SECRET_KEYS = new Set(["apiKey", "clientSecret"]);

/** 取值是固定枚举的字段：保存时统一小写，避免 BAILIAN 这类写法存进配置后校验失败。 */
const TOKEN_KEYS = new Set(["provider", "protocol", "fallback", "transition"]);

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
  for (const section of ["script", "tts", "videoGen", "lipsync"] as const) {
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

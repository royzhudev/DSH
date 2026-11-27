import path from "node:path";
import { CastLibrary } from "../cast/library.js";
import type { Logger } from "../logger.js";
import { MaterialLibrary } from "../materials/library.js";
import { H5ShareStore } from "../publish/h5-store.js";
import { PublishStore } from "../publish/store.js";
import { DouyinTokenStore } from "../publish/token-store.js";
import type { AppConfig } from "../types.js";
import { SettingsStore } from "./settings.js";

export interface WorkspaceUserRef {
  id: string;
}

interface WorkspaceManagerOptions {
  /** 数据根目录：data/，用户私有数据放在 data/users/<id>/。 */
  dataDir: string;
  /** 平台配置（路径、邮件、抖音应用凭证等）；用户配置在它之上叠加。 */
  baseConfig: () => AppConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** 遍历所有用户，用于按公网素材令牌反查归属。 */
  listUsers: () => Promise<WorkspaceUserRef[]>;
}

const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 同步构造某用户的配置快照（不含个人设置覆盖），用于启动时恢复历史任务。 */
export function scopedConfigFor(base: AppConfig, id: string): AppConfig {
  assertUserId(id);
  const config = structuredClone(base);
  config.outputDir = path.join(base.outputDir, "users", id);
  config.libraryDir = path.join(base.libraryDir, "users", id);
  config.castDir = path.join(base.castDir, "users", id);
  return config;
}

/**
 * 单个用户的工作区：独立的设置文件、素材库、角色库、发布记录与抖音令牌。
 * 配置对象是该用户独占的副本，任何修改都不会影响其他用户或平台配置。
 */
export class UserWorkspace {
  /** 该用户的有效配置（平台配置 + 个人覆盖 + 私有目录）。 */
  readonly config: AppConfig;
  readonly settings: SettingsStore;
  private materialLibrary?: MaterialLibrary;
  private castLibrary?: CastLibrary;
  private tokenStore?: DouyinTokenStore;
  private publishStore?: PublishStore;
  private h5ShareStore?: H5ShareStore;

  constructor(
    readonly id: string,
    readonly dir: string,
    baseConfig: AppConfig,
    private readonly options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      logger: Logger;
      defaultPublicBaseUrl: () => string;
    },
  ) {
    this.config = scopedConfigFor(baseConfig, id);
    this.settings = new SettingsStore(this.config, {
      settingsPath: path.join(dir, "settings.json"),
      cwd: options.cwd,
      env: options.env,
      logger: options.logger,
      defaultPublicBaseUrl: options.defaultPublicBaseUrl,
    });
  }

  async ensureConfig(): Promise<AppConfig> {
    await this.settings.ensureLoaded();
    return this.config;
  }

  library(): MaterialLibrary {
    this.materialLibrary ??= new MaterialLibrary(this.config.libraryDir, this.options.logger);
    return this.materialLibrary;
  }

  cast(): CastLibrary {
    this.castLibrary ??= new CastLibrary(this.config.castDir, this.options.logger);
    return this.castLibrary;
  }

  tokens(): DouyinTokenStore {
    this.tokenStore ??= new DouyinTokenStore(path.join(this.dir, "douyin-token.json"), this.options.logger);
    return this.tokenStore;
  }

  publishes(): PublishStore {
    this.publishStore ??= new PublishStore(path.join(this.dir, "publishes.json"), this.options.logger);
    return this.publishStore;
  }

  h5Shares(): H5ShareStore {
    this.h5ShareStore ??= new H5ShareStore(path.join(this.dir, "douyin-h5-shares.json"), this.options.logger);
    return this.h5ShareStore;
  }
}

export class WorkspaceManager {
  private readonly cache = new Map<string, UserWorkspace>();

  constructor(private readonly options: WorkspaceManagerOptions) {}

  async for(user: WorkspaceUserRef): Promise<UserWorkspace> {
    const id = assertUserId(user.id);
    const existing = this.cache.get(id);
    if (existing) return existing;
    const workspace = new UserWorkspace(id, path.join(this.options.dataDir, "users", id), this.options.baseConfig(), {
      cwd: this.options.cwd,
      env: this.options.env,
      logger: this.options.logger,
      defaultPublicBaseUrl: () => this.options.baseConfig().server.publicBaseUrl,
    });
    this.cache.set(id, workspace);
    return workspace;
  }

  /** 个人公网素材令牌是随机的，只能逐用户比对；用户数量级很小，无需额外索引。 */
  async findByPublicAssetToken(token: string): Promise<UserWorkspace | undefined> {
    const trimmed = token.trim();
    if (!trimmed) return undefined;
    for (const user of await this.options.listUsers()) {
      const workspace = await this.for(user);
      const config = await workspace.ensureConfig();
      if (config.videoGen.publicAssetToken === trimmed) return workspace;
    }
    return undefined;
  }

  /** 平台设置或用户设置变化后调用，下一次访问重新套用覆盖。 */
  invalidate(userId?: string): void {
    if (userId) {
      this.cache.delete(userId);
      return;
    }
    this.cache.clear();
  }
}

export function assertUserId(id: string): string {
  if (!USER_ID_PATTERN.test(id)) {
    throw new Error(`非法用户目录名：${id}`);
  }
  return id;
}
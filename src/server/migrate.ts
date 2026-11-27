import fsp from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { AppConfig } from "../types.js";
import { ensureDir } from "../util/fs.js";
import { PERSONAL_SECTIONS, PLATFORM_SECTIONS } from "./settings.js";

const JOB_DIR_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{8}$/;
const MIGRATION_FILE = "workspace-migration.json";

export interface MigrationResult {
  status: "migrated" | "already" | "no-admin";
  adminUserId?: string;
  notes: string[];
}

interface MigrationMarker {
  version: 1;
  adminUserId: string;
  migratedAt: string;
  notes: string[];
}

export interface MigrationOptions {
  /** 数据根目录（settings.json 所在目录）。 */
  dataDir: string;
  usersPath: string;
  config: AppConfig;
  logger: Logger;
}

/**
 * 一次性迁移：把多租户之前写在全局目录里的数据搬进管理员的工作区，
 * 并把个人设置从 data/settings.json 拆到 data/users/<adminId>/settings.json。
 * 幂等：搬走/改写过的文件再执行不会重复处理；完成时写 marker。
 */
export async function migrateLegacyWorkspace(options: MigrationOptions): Promise<MigrationResult> {
  const { dataDir, usersPath, config, logger } = options;
  const markerPath = path.join(dataDir, MIGRATION_FILE);
  const notes: string[] = [];
  try {
    const marker = JSON.parse(await fsp.readFile(markerPath, "utf8")) as MigrationMarker;
    if (marker?.version === 1 && marker.adminUserId) {
      return { status: "already", adminUserId: marker.adminUserId, notes: [] };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`迁移标记读取失败，将按未迁移处理：${String(error)}`);
    }
  }

  const adminId = await findAdminId(usersPath);
  if (!adminId) return { status: "no-admin", notes };

  const userDataDir = path.join(dataDir, "users", adminId);
  const outputRoot = path.join(config.outputDir, "users", adminId);
  const libraryRoot = path.join(config.libraryDir, "users", adminId);
  const castRoot = path.join(config.castDir, "users", adminId);
  await Promise.all(
    [userDataDir, outputRoot, libraryRoot, castRoot].map((dir) => ensureDir(dir)),
  );

  const backupDir = await createBackup(dataDir, [config.settingsFile], notes, logger);

  await moveDirectoryEntries(config.outputDir, outputRoot, (name) => JOB_DIR_PATTERN.test(name), notes, "任务目录", logger);
  await moveDirectoryEntries(config.libraryDir, libraryRoot, () => true, notes, "素材文件", logger);
  await moveDirectoryEntries(config.castDir, castRoot, () => true, notes, "角色文件", logger);

  await migrateSettings({
    settingsFile: config.settingsFile,
    userSettingsFile: path.join(userDataDir, "settings.json"),
    notes,
    logger,
  });

  await moveJsonFile(path.join(dataDir, "publishes.json"), path.join(userDataDir, "publishes.json"), notes, logger);
  await moveJsonFile(
    path.join(dataDir, "douyin-h5-shares.json"),
    path.join(userDataDir, "douyin-h5-shares.json"),
    notes,
    logger,
  );
  await moveJsonFile(
    path.join(config.cacheDir, "douyin-token.json"),
    path.join(userDataDir, "douyin-token.json"),
    notes,
    logger,
  );

  const marker: MigrationMarker = {
    version: 1,
    adminUserId: adminId,
    migratedAt: new Date().toISOString(),
    notes: backupDir ? [...notes, `备份目录：${backupDir}`] : notes,
  };
  await writeJson(markerPath, marker);
  logger.info(
    `多租户数据迁移完成：管理员 ${adminId}，${notes.length} 条提示${backupDir ? `，备份在 ${backupDir}` : ""}`,
  );
  return { status: "migrated", adminUserId: adminId, notes: marker.notes };
}

async function findAdminId(usersPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(usersPath, "utf8")) as {
      users?: Array<{ id?: unknown; role?: unknown }>;
    };
    const admins = (parsed.users ?? []).filter(
      (user) => user.role === "admin" && typeof user.id === "string",
    );
    return (admins[0]?.id as string | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

async function createBackup(
  dataDir: string,
  files: string[],
  notes: string[],
  logger: Logger,
): Promise<string | undefined> {
  let copied = 0;
  const dir = path.join(dataDir, `migration-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  for (const file of files) {
    try {
      await ensureDir(dir);
      await fsp.copyFile(file, path.join(dir, path.basename(file)));
      copied += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        notes.push(`备份 ${path.basename(file)} 失败：${String(error)}`);
        logger.warn(`迁移备份失败：${file}：${String(error)}`);
      }
    }
  }
  return copied > 0 ? dir : undefined;
}

async function moveDirectoryEntries(
  sourceRoot: string,
  targetRoot: string,
  accept: (name: string) => boolean,
  notes: string[],
  label: string,
  logger: Logger,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      notes.push(`读取 ${sourceRoot} 失败：${String(error)}`);
    }
    return;
  }
  for (const entry of entries) {
    if (entry.name === "users" || !accept(entry.name)) continue;
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    try {
      await fsp.rename(source, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
        // 目标已存在（例如部分迁移后重跑）：保留管理员已有的数据，提示人工检查。
        notes.push(`${label} ${entry.name} 目标已存在，未覆盖`);
        continue;
      }
      notes.push(`迁移${label} ${entry.name} 失败：${String(error)}`);
      logger.warn(`迁移${label}失败：${source}：${String(error)}`);
    }
  }
}

async function migrateSettings(options: {
  settingsFile: string;
  userSettingsFile: string;
  notes: string[];
  logger: Logger;
}): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(await fsp.readFile(options.settingsFile, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    parsed = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      options.notes.push(`读取全局设置失败：${String(error)}`);
    }
    return;
  }

  const personal: Record<string, unknown> = {};
  for (const section of PERSONAL_SECTIONS) {
    if (section in parsed) personal[section] = parsed[section];
  }
  const hasPersonal = Object.keys(personal).length > 0;
  const videoGen = personal.videoGen as Record<string, unknown> | undefined;
  const personalPublicBase =
    videoGen && typeof videoGen.publicBaseUrl === "string" ? videoGen.publicBaseUrl.trim() : "";

  // 先写个人设置，失败时仍保留全局文件，重跑还能继续。
  if (hasPersonal) {
    try {
      await fsp.access(options.userSettingsFile);
      options.notes.push("管理员个人设置文件已存在，保留现有文件");
    } catch {
      await writeJson(options.userSettingsFile, { ...personal, updatedAt: new Date().toISOString() });
    }
  }

  const platform: Record<string, unknown> = {};
  for (const section of PLATFORM_SECTIONS) {
    if (section in parsed) platform[section] = parsed[section];
  }
  if (personalPublicBase) {
    platform.server = { publicBaseUrl: personalPublicBase.replace(/\/+$/, "") };
    options.notes.push("已把个人公网素材地址迁移为平台公网地址");
  }
  if (typeof parsed.updatedAt === "string") platform.updatedAt = parsed.updatedAt;
  const hasPlatform = Object.keys(platform).length > 0 || hasPersonal;
  if (hasPlatform) {
    await writeJson(options.settingsFile, platform);
    options.logger.info("已拆分全局设置为平台设置与管理员个人设置");
  }
}

async function moveJsonFile(
  source: string,
  target: string,
  notes: string[],
  logger: Logger,
): Promise<void> {
  try {
    await fsp.access(target);
    notes.push(`${path.basename(target)} 已存在，未覆盖`);
    return;
  } catch {
    // 目标不存在，继续迁移。
  }
  try {
    await ensureDir(path.dirname(target));
    await fsp.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      notes.push(`迁移 ${path.basename(source)} 失败：${String(error)}`);
      logger.warn(`迁移失败：${source}：${String(error)}`);
    }
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
  await fsp.chmod(file, 0o600).catch(() => undefined);
}
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import { ensureDir } from "../util/fs.js";

/** 网页左侧导航对应的模块权限。 */
export const MENU_PERMISSIONS = ["create", "jobs", "cast", "materials", "publish", "settings"] as const;
export type MenuPermission = (typeof MENU_PERMISSIONS)[number];
export type UserRole = "admin" | "member";

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const DISPLAY_NAME_MAX_LENGTH = 40;
const SCRYPT_KEY_LENGTH = 64;

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  permissions: MenuPermission[];
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

interface UsersFile {
  version: 1;
  users: UserRecord[];
}

export interface UserView {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  permissions: MenuPermission[];
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface CreateUserInput {
  username: string;
  displayName?: string;
  password: string;
  role?: UserRole;
  permissions?: MenuPermission[];
}

export interface UpdateUserInput {
  displayName?: string;
  password?: string;
  role?: UserRole;
  permissions?: MenuPermission[];
  disabled?: boolean;
}

export interface SetupInput {
  username: string;
  displayName?: string;
  password: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltText, hashText] = stored.split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = await deriveKey(password, Buffer.from(saltText, "base64url"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function parseUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim() : "";
  if (!USERNAME_PATTERN.test(username)) {
    throw new AppError("用户名需为 3-32 位字母、数字、下划线、点或短横线", {
      code: "USERNAME_INVALID",
      status: 400,
    });
  }
  return username;
}

function parseDisplayName(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    throw new AppError("显示名称必须是文本", { code: "DISPLAY_NAME_INVALID", status: 400 });
  }
  const displayName = value.trim();
  if (!displayName || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new AppError(`显示名称需为 1-${DISPLAY_NAME_MAX_LENGTH} 个字符`, {
      code: "DISPLAY_NAME_INVALID",
      status: 400,
    });
  }
  return displayName;
}

function parsePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(`密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`, {
      code: "PASSWORD_INVALID",
      status: 400,
    });
  }
  return value;
}

function parseRole(value: unknown, fallback: UserRole): UserRole {
  if (value === undefined || value === null || value === "") return fallback;
  if (value !== "admin" && value !== "member") {
    throw new AppError("角色只能是 admin 或 member", { code: "ROLE_INVALID", status: 400 });
  }
  return value;
}

/** 校验并归一化权限：管理员始终拥有全部模块；创作依赖任务状态。 */
export function normalizePermissions(value: unknown, role: UserRole): MenuPermission[] {
  if (role === "admin") return [...MENU_PERMISSIONS];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError("permissions 必须是数组", { code: "PERMISSIONS_INVALID", status: 400 });
  }
  const selected = new Set<MenuPermission>();
  for (const item of value) {
    if (!MENU_PERMISSIONS.includes(item as MenuPermission)) {
      throw new AppError(`未知权限：${String(item)}`, { code: "PERMISSIONS_INVALID", status: 400 });
    }
    selected.add(item as MenuPermission);
  }
  // 创建视频后需要查看任务进度，因此创作权限自动包含任务。
  if (selected.has("create")) selected.add("jobs");
  // 角色/道具和素材同属画面素材管理，勾选素材库时一并开放。
  if (selected.has("materials")) selected.add("cast");
  return MENU_PERMISSIONS.filter((permission) => selected.has(permission));
}

export function effectivePermissions(user: Pick<UserRecord, "role" | "permissions">): MenuPermission[] {
  if (user.role === "admin") return [...MENU_PERMISSIONS];
  return user.permissions.filter((permission) => MENU_PERMISSIONS.includes(permission));
}

export function toUserView(user: UserRecord): UserView {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: effectivePermissions(user),
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
  };
}

function parseStoredUser(value: unknown): UserRecord {
  if (!isRecord(value)) throw new Error("用户记录不是对象");
  const role = value.role === "admin" ? "admin" : value.role === "member" ? "member" : null;
  if (
    typeof value.id !== "string" ||
    typeof value.username !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.passwordHash !== "string" ||
    !role ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("用户记录字段不完整");
  }
  return {
    id: value.id,
    username: value.username,
    displayName: value.displayName,
    role,
    permissions: normalizePermissions(value.permissions, role),
    passwordHash: value.passwordHash,
    disabled: value.disabled === true,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastLoginAt === "string" ? { lastLoginAt: value.lastLoginAt } : {}),
  };
}

/**
 * 用户存储：账号、密码哈希、角色与菜单权限，持久化到 data/users.json。
 * 文件权限 0600；密码使用 scrypt 加盐哈希，绝不回显。
 */
export class UserStore {
  private users: UserRecord[] = [];
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  get usersPath(): string {
    return this.filePath;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.load().then(() => {
      this.loaded = true;
    });
    await this.loadPromise;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.users = [];
        return;
      }
      throw new AppError(`用户数据读取失败：${(error as Error).message}`, {
        code: "USERS_READ_FAILED",
        status: 500,
        cause: error,
      });
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.users)) throw new Error("文件结构不正确");
      this.users = parsed.users.map(parseStoredUser);
    } catch (error) {
      // 用户数据损坏时拒绝继续，避免被当成空库重新初始化。
      throw new AppError(`用户数据文件损坏，请检查 ${this.filePath}：${(error as Error).message}`, {
        code: "USERS_CORRUPTED",
        status: 500,
        cause: error,
      });
    }
  }

  async hasUsers(): Promise<boolean> {
    await this.ensureLoaded();
    return this.users.length > 0;
  }

  async list(): Promise<UserView[]> {
    await this.ensureLoaded();
    return [...this.users]
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map(toUserView);
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    await this.ensureLoaded();
    return this.users.find((user) => user.id === id);
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    await this.ensureLoaded();
    const target = username.trim().toLowerCase();
    return this.users.find((user) => user.username.toLowerCase() === target);
  }

  async setup(input: SetupInput): Promise<UserView> {
    await this.ensureLoaded();
    if (this.users.length > 0) {
      throw new AppError("管理员账号已初始化", { code: "SETUP_ALREADY_DONE", status: 409 });
    }
    const user = await this.createRecord(
      {
        username: input.username,
        displayName: input.displayName,
        password: input.password,
        role: "admin",
        permissions: [...MENU_PERMISSIONS],
      },
      { skipDuplicateCheck: true },
    );
    this.logger.info(`已初始化管理员账号：${user.username}`);
    return toUserView(user);
  }

  async create(input: CreateUserInput): Promise<UserView> {
    await this.ensureLoaded();
    const role = parseRole(input.role, "member");
    const user = await this.createRecord({ ...input, role });
    this.logger.info(`已创建用户：${user.username}（${user.role}）`);
    return toUserView(user);
  }

  async update(id: string, patch: UpdateUserInput, actorId: string): Promise<UserView> {
    await this.ensureLoaded();
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new AppError("用户不存在", { code: "USER_NOT_FOUND", status: 404 });

    const nextRole = parseRole(patch.role, user.role);
    const nextDisabled = patch.disabled === undefined ? user.disabled : Boolean(patch.disabled);
    if (id === actorId && nextRole !== user.role) {
      throw new AppError("不能修改自己的角色", { code: "SELF_ROLE_CHANGE", status: 400 });
    }
    if (id === actorId && nextDisabled) {
      throw new AppError("不能禁用自己的账号", { code: "SELF_DISABLE", status: 400 });
    }
    const losesAdmin = user.role === "admin" && !user.disabled && (nextRole !== "admin" || nextDisabled);
    if (losesAdmin && this.activeAdminCount() <= 1) {
      throw new AppError("至少需要保留一个启用的管理员", { code: "LAST_ADMIN", status: 400 });
    }

    if (patch.displayName !== undefined) {
      user.displayName = parseDisplayName(patch.displayName, user.displayName);
    }
    if (patch.password !== undefined) {
      user.passwordHash = await hashPassword(parsePassword(patch.password));
    }
    const wasAdmin = user.role === "admin";
    user.role = nextRole;
    // 管理员降级为成员时默认清空菜单权限，避免无意保留全部访问权。
    const permissionSource =
      patch.permissions !== undefined
        ? patch.permissions
        : wasAdmin && nextRole === "member"
          ? []
          : user.permissions;
    user.permissions = normalizePermissions(permissionSource, nextRole);
    user.disabled = nextDisabled;
    user.updatedAt = new Date().toISOString();
    await this.persist();
    this.logger.info(`已更新用户：${user.username}`);
    return toUserView(user);
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.ensureLoaded();
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new AppError("用户不存在", { code: "USER_NOT_FOUND", status: 404 });
    if (id === actorId) {
      throw new AppError("不能删除自己的账号", { code: "SELF_DELETE", status: 400 });
    }
    if (user.role === "admin" && !user.disabled && this.activeAdminCount() <= 1) {
      throw new AppError("至少需要保留一个启用的管理员", { code: "LAST_ADMIN", status: 400 });
    }
    this.users = this.users.filter((item) => item.id !== id);
    await this.persist();
    this.logger.info(`已删除用户：${user.username}`);
  }

  /** 校验用户名和密码；禁用账号与密码错误返回相同结果，避免枚举账号。 */
  async verify(username: string, password: string): Promise<UserRecord | null> {
    await this.ensureLoaded();
    const user = await this.findByUsername(username);
    if (!user) {
      await deriveKey(password, Buffer.alloc(16)).catch(() => undefined);
      return null;
    }
    if (user.disabled) return null;
    const valid = await verifyPassword(password, user.passwordHash);
    return valid ? user : null;
  }

  async markLogin(id: string): Promise<void> {
    await this.ensureLoaded();
    const user = this.users.find((item) => item.id === id);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    try {
      await this.persist();
    } catch (error) {
      this.logger.warn(`记录登录时间失败：${(error as Error).message}`);
    }
  }

  private activeAdminCount(): number {
    return this.users.filter((user) => user.role === "admin" && !user.disabled).length;
  }

  private async createRecord(
    input: CreateUserInput,
    options: { skipDuplicateCheck?: boolean } = {},
  ): Promise<UserRecord> {
    const username = parseUsername(input.username);
    const duplicate = this.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
    if (duplicate && !options.skipDuplicateCheck) {
      throw new AppError("用户名已存在", { code: "USERNAME_TAKEN", status: 409 });
    }
    const role = parseRole(input.role, "member");
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomBytes(8).toString("hex"),
      username,
      displayName: parseDisplayName(input.displayName, username),
      role,
      permissions: normalizePermissions(input.permissions, role),
      passwordHash: await hashPassword(parsePassword(input.password)),
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.users.push(user);
    await this.persist();
    return user;
  }

  private async persist(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    const payload: UsersFile = { version: 1, users: this.users };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.filePath);
    await fsp.chmod(this.filePath, 0o600).catch(() => undefined);
  }
}
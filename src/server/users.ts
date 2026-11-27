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
export const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const DISPLAY_NAME_MAX_LENGTH = 40;
const SCRYPT_KEY_LENGTH = 64;

/** 自助注册用户的默认菜单：除用户管理外全部可用，以便配置自己的 API Key。 */
export const DEFAULT_SIGNUP_PERMISSIONS: MenuPermission[] = [
  "create",
  "jobs",
  "cast",
  "materials",
  "publish",
  "settings",
];

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
  /** 自助注册的邮箱；管理员创建的历史账号可以没有。 */
  email?: string;
  /** 邮箱验证通过时间；有 email 但该字段为空时不能登录。 */
  emailVerifiedAt?: string;
}

interface UsersFile {
  version: 1 | 2;
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
  email?: string;
  emailVerified: boolean;
}

export interface CreateUserInput {
  username: string;
  displayName?: string;
  password: string;
  role?: UserRole;
  permissions?: MenuPermission[];
  email?: string;
}

export interface SignupInput {
  email: string;
  password: string;
  displayName?: string;
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

export function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email) {
    throw new AppError("请填写邮箱地址", { code: "EMAIL_INVALID", status: 400 });
  }
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new AppError("邮箱地址格式不正确", { code: "EMAIL_INVALID", status: 400 });
  }
  return email;
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
    ...(user.email ? { email: user.email } : {}),
    emailVerified: Boolean(user.emailVerifiedAt),
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
    ...(typeof value.email === "string" && value.email ? { email: value.email } : {}),
    ...(typeof value.emailVerifiedAt === "string" && value.emailVerifiedAt
      ? { emailVerifiedAt: value.emailVerifiedAt }
      : {}),
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

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    await this.ensureLoaded();
    const target = email.trim().toLowerCase();
    return this.users.find((user) => (user.email ?? "").toLowerCase() === target);
  }

  /** 登录标识既可以是邮箱，也可以是历史账号的用户名。 */
  async findByLogin(login: string): Promise<UserRecord | undefined> {
    if (login.includes("@")) return this.findByEmail(login);
    return this.findByUsername(login);
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

  /**
   * 自助注册：邮箱已注册且验证过时返回 alreadyVerified（不改密码）；
   * 未验证的同邮箱账号则更新密码与显示名，等待重新验证。
   */
  async signup(
    input: SignupInput,
  ): Promise<{ user: UserRecord; created: boolean; alreadyVerified: boolean }> {
    await this.ensureLoaded();
    const email = normalizeEmail(input.email);
    const password = parsePassword(input.password);
    const existing = await this.findByEmail(email);
    if (existing) {
      if (existing.emailVerifiedAt) {
        return { user: existing, created: false, alreadyVerified: true };
      }
      if (existing.disabled) {
        throw new AppError("该账号已被禁用，请联系管理员", { code: "ACCOUNT_DISABLED", status: 403 });
      }
      existing.passwordHash = await hashPassword(password);
      if (input.displayName !== undefined) {
        existing.displayName = parseDisplayName(input.displayName, existing.displayName);
      }
      existing.updatedAt = new Date().toISOString();
      await this.persist();
      return { user: existing, created: false, alreadyVerified: false };
    }
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: randomBytes(8).toString("hex"),
      username: `u_${randomBytes(4).toString("hex")}`,
      displayName: parseDisplayName(input.displayName, email.split("@")[0] || "新用户"),
      role: "member",
      permissions: [...DEFAULT_SIGNUP_PERMISSIONS],
      passwordHash: await hashPassword(password),
      disabled: false,
      createdAt: now,
      updatedAt: now,
      email,
    };
    this.users.push(user);
    await this.persist();
    this.logger.info(`新用户注册（待验证邮箱）：${maskEmail(email)}`);
    return { user, created: true, alreadyVerified: false };
  }

  /** 邮箱验证通过；返回更新后的用户。 */
  async markEmailVerified(email: string): Promise<UserRecord | undefined> {
    await this.ensureLoaded();
    const user = await this.findByEmail(email);
    if (!user || user.disabled) return undefined;
    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date().toISOString();
      user.updatedAt = user.emailVerifiedAt;
      await this.persist();
      this.logger.info(`邮箱验证通过：${maskEmail(user.email ?? "")}`);
    }
    return user;
  }

  /** 邮箱验证码重置密码；仅对已验证账号生效。 */
  async resetPasswordByEmail(email: string, password: string): Promise<UserRecord | undefined> {
    await this.ensureLoaded();
    const user = await this.findByEmail(email);
    if (!user || user.disabled || !user.emailVerifiedAt) return undefined;
    user.passwordHash = await hashPassword(parsePassword(password));
    user.updatedAt = new Date().toISOString();
    await this.persist();
    this.logger.info(`用户重置密码：${maskEmail(user.email ?? "")}`);
    return user;
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

  /** 校验登录标识（邮箱或用户名）和密码；禁用账号与密码错误返回相同结果，避免枚举账号。 */
  async authenticate(
    login: string,
    password: string,
  ): Promise<
    | { status: "ok"; user: UserRecord }
    | { status: "invalid" }
    | { status: "unverified"; user: UserRecord }
  > {
    await this.ensureLoaded();
    const user = await this.findByLogin(login);
    if (!user) {
      await deriveKey(password, Buffer.alloc(16)).catch(() => undefined);
      return { status: "invalid" };
    }
    if (user.disabled) return { status: "invalid" };
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return { status: "invalid" };
    if (user.email && !user.emailVerifiedAt) return { status: "unverified", user };
    return { status: "ok", user };
  }

  /** 兼容旧调用：返回验证通过的用户，否则 null。 */
  async verify(login: string, password: string): Promise<UserRecord | null> {
    const result = await this.authenticate(login, password);
    return result.status === "ok" ? result.user : null;
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
    const email = input.email ? normalizeEmail(input.email) : undefined;
    if (email && this.users.some((user) => (user.email ?? "").toLowerCase() === email)) {
      throw new AppError("邮箱已被注册", { code: "EMAIL_TAKEN", status: 409 });
    }
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
      ...(email ? { email, emailVerifiedAt: now } : {}),
    };
    this.users.push(user);
    await this.persist();
    return user;
  }

  private async persist(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    const payload: UsersFile = { version: 2, users: this.users };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.filePath);
    await fsp.chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

/** 日志里只保留域名与首字符，避免把完整邮箱写进日志。 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = (local ?? "").slice(0, 1);
  return `${head}***@${domain}`;
}
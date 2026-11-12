import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AppError } from "../errors.js";

export const SESSION_COOKIE = "va_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/** 进程内会话表：重启后需要重新登录。 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlMs = SESSION_TTL_MS) {}

  create(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sweep(now);
    this.sessions.set(token, { userId, createdAt: now, expiresAt: now + this.ttlMs });
    return token;
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  destroyUser(userId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(token);
    }
  }

  private sweep(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * 拒绝跨站写请求：浏览器会为跨站表单/JSON 请求带 Origin，
 * 同源请求或非浏览器客户端（无 Origin）不受影响。
 */
export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (!origin) return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new AppError("请求来源不合法", { code: "INVALID_ORIGIN", status: 403 });
  }
  if (!req.headers.host || host !== req.headers.host) {
    throw new AppError("请求来源不合法", { code: "INVALID_ORIGIN", status: 403 });
  }
}

interface ThrottleEntry {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

/** 简单的登录失败限流，降低本机服务暴露到局域网时的暴力破解风险。 */
export class LoginThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(
    private readonly limit = 8,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly blockMs = 5 * 60 * 1000,
  ) {}

  check(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const now = Date.now();
    if (entry.blockedUntil && entry.blockedUntil > now) {
      throw new AppError("登录尝试过于频繁，请稍后再试", { code: "LOGIN_THROTTLED", status: 429 });
    }
    if (entry.resetAt <= now) this.entries.delete(key);
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count >= this.limit) {
      entry.blockedUntil = now + this.blockMs;
      entry.resetAt = now + this.blockMs;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import { ensureDir } from "../util/fs.js";

export type EmailCodePurpose = "signup" | "reset";

export const EMAIL_CODE_TTL_MINUTES = 10;
const EMAIL_CODE_TTL_MS = EMAIL_CODE_TTL_MINUTES * 60 * 1000;
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_HOURLY_LIMIT = 10;
const EMAIL_DAILY_LIMIT = 30;
const IP_HOURLY_LIMIT = 30;
const CODE_SECRET_FILE = "email-code-secret";

interface StoredCode {
  email: string;
  purpose: EmailCodePurpose;
  hash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
  /** 最近 24 小时的发送时间戳，用于按邮箱限流，重启后仍生效。 */
  sends: number[];
}

interface CodesFile {
  version: 1;
  codes: StoredCode[];
}

interface IpBucket {
  count: number;
  resetAt: number;
}

export interface EmailCodeStoreOptions {
  /** 数据目录（与 settings.json 同级），验证码与密钥都放在这里。 */
  dataDir: string;
  logger: Logger;
  ttlMs?: number;
  maxAttempts?: number;
  resendCooldownMs?: number;
  emailHourlyLimit?: number;
  emailDailyLimit?: number;
  ipHourlyLimit?: number;
}

/**
 * 邮箱验证码：只保存 HMAC 哈希，不保存明文；一次性、限时、限次数。
 * 按邮箱的发送记录落盘（重启后限流仍有效），按 IP 的计数放内存。
 */
export class EmailCodeStore {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownMs: number;
  private readonly emailHourlyLimit: number;
  private readonly emailDailyLimit: number;
  private readonly ipHourlyLimit: number;
  private readonly ipBuckets = new Map<string, IpBucket>();
  private readonly logger: Logger;
  private secret = Buffer.alloc(0);
  private loaded = false;
  private loadPromise?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: EmailCodeStoreOptions) {
    this.file = path.join(options.dataDir, "email-codes.json");
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? EMAIL_CODE_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.resendCooldownMs = options.resendCooldownMs ?? RESEND_COOLDOWN_MS;
    this.emailHourlyLimit = options.emailHourlyLimit ?? EMAIL_HOURLY_LIMIT;
    this.emailDailyLimit = options.emailDailyLimit ?? EMAIL_DAILY_LIMIT;
    this.ipHourlyLimit = options.ipHourlyLimit ?? IP_HOURLY_LIMIT;
  }

  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }

  /** 生成并保存一个新验证码；超过限流时抛 429。 */
  async issue(
    email: string,
    purpose: EmailCodePurpose,
    ip: string,
  ): Promise<{ code: string; expiresAt: number }> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const now = Date.now();
      this.checkIp(ip, now);
      const codes = await this.readCodes();
      const existing = codes.find((item) => item.email === email && item.purpose === purpose);
      const sends = (existing?.sends ?? []).filter((time) => now - time < 24 * 60 * 60 * 1000);
      if (existing && now - existing.sentAt < this.resendCooldownMs) {
        throw new AppError("验证码发送过于频繁，请稍后再试", {
          code: "EMAIL_CODE_THROTTLED",
          status: 429,
        });
      }
      const hourly = sends.filter((time) => now - time < 60 * 60 * 1000).length;
      if (hourly >= this.emailHourlyLimit || sends.length >= this.emailDailyLimit) {
        throw new AppError("该邮箱今日验证码发送次数过多，请明天再试", {
          code: "EMAIL_CODE_THROTTLED",
          status: 429,
        });
      }
      const code = crypto.randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
      const hash = this.hash(email, purpose, code);
      const expiresAt = now + this.ttlMs;
      const record: StoredCode = {
        email,
        purpose,
        hash,
        expiresAt,
        attempts: 0,
        sentAt: now,
        sends: [...sends, now],
      };
      const nextCodes = [...codes.filter((item) => !(item.email === email && item.purpose === purpose)), record];
      await this.writeCodes(nextCodes);
      this.bucketFor(ip, now).count += 1;
      return { code, expiresAt };
    });
  }

  /**
   * 校验并消费验证码。成功即删除；失败累加次数，超过上限直接作废。
   */
  async verify(
    email: string,
    purpose: EmailCodePurpose,
    code: string,
  ): Promise<"ok" | "invalid" | "expired" | "too_many"> {
    await this.ensureLoaded();
    return this.withLock(async () => {
      const now = Date.now();
      const codes = await this.readCodes();
      const index = codes.findIndex((item) => item.email === email && item.purpose === purpose);
      if (index < 0) return "invalid";
      const record = codes[index]!;
      if (record.expiresAt <= now) {
        codes.splice(index, 1);
        await this.writeCodes(codes);
        return "expired";
      }
      if (record.attempts >= this.maxAttempts) {
        codes.splice(index, 1);
        await this.writeCodes(codes);
        return "too_many";
      }
      const expected = record.hash;
      const actual = this.hash(email, purpose, code);
      const matches =
        expected.length === actual.length &&
        crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
      if (!matches) {
        record.attempts += 1;
        await this.writeCodes(codes);
        return record.attempts >= this.maxAttempts ? "too_many" : "invalid";
      }
      codes.splice(index, 1);
      await this.writeCodes(codes);
      return "ok";
    });
  }

  private checkIp(ip: string, now: number): void {
    const bucket = this.bucketFor(ip, now);
    if (bucket.count >= this.ipHourlyLimit) {
      throw new AppError("当前网络请求验证码过于频繁，请稍后再试", {
        code: "EMAIL_CODE_THROTTLED",
        status: 429,
      });
    }
  }

  private bucketFor(ip: string, now: number): IpBucket {
    const existing = this.ipBuckets.get(ip);
    if (existing && existing.resetAt > now) return existing;
    const bucket: IpBucket = { count: 0, resetAt: now + 60 * 60 * 1000 };
    this.ipBuckets.set(ip, bucket);
    // 顺手清理过期桶，避免长期运行后无限增长。
    for (const [key, value] of this.ipBuckets) {
      if (value.resetAt <= now) this.ipBuckets.delete(key);
    }
    return bucket;
  }

  private hash(email: string, purpose: EmailCodePurpose, code: string): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`${purpose}:${email}:${code}`)
      .digest("base64url");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      this.secret = await this.loadOrCreateSecret();
      this.loaded = true;
    })();
    await this.loadPromise;
  }

  private async loadOrCreateSecret(): Promise<Buffer> {
    const file = path.join(this.options.dataDir, CODE_SECRET_FILE);
    try {
      const raw = await fsp.readFile(file, "utf8");
      if (/^[a-f0-9]{64}$/i.test(raw.trim())) return Buffer.from(raw.trim(), "hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`验证码密钥读取失败，将重建：${(error as Error).message}`);
      }
    }
    const secret = crypto.randomBytes(32);
    await ensureDir(this.options.dataDir);
    await fsp.writeFile(file, secret.toString("hex"), { mode: 0o600 });
    await fsp.chmod(file, 0o600).catch(() => undefined);
    return secret;
  }

  private async readCodes(): Promise<StoredCode[]> {
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return [];
      const codes = (parsed as CodesFile).codes;
      if (!Array.isArray(codes)) return [];
      const now = Date.now();
      return codes.filter(
        (item) =>
          typeof item?.email === "string" &&
          (item.purpose === "signup" || item.purpose === "reset") &&
          typeof item.hash === "string" &&
          typeof item.expiresAt === "number" &&
          item.expiresAt > now - 24 * 60 * 60 * 1000,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`验证码数据读取失败，将忽略旧记录：${(error as Error).message}`);
      }
      return [];
    }
  }

  private async writeCodes(codes: StoredCode[]): Promise<void> {
    // 只保留未过期或仍在限流窗口内的记录，避免文件无限膨胀。
    const now = Date.now();
    const kept = codes.filter(
      (item) => item.expiresAt > now || item.sentAt > now - 24 * 60 * 60 * 1000,
    );
    await ensureDir(this.options.dataDir);
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(
      tmp,
      `${JSON.stringify({ version: 1, codes: kept } satisfies CodesFile, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fsp.rename(tmp, this.file);
    await fsp.chmod(this.file, 0o600).catch(() => undefined);
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
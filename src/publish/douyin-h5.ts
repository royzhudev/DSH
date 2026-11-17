import crypto from "node:crypto";
import type { AppConfig, DouyinSettings } from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";

const CLIENT_TOKEN_PATH = "/oauth/client_token/";
const OPEN_TICKET_PATH = "/open/getticket/";
const SHARE_ID_PATH = "/share-id/";
const GET_SHARE_PATH = "/api/douyin/v1/schema/get_share/";
const SHARE_TTL_SEC = 3600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function httpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(`${label}必须是完整的 https 地址`, { code: "INVALID_OPTIONS", status: 400 });
  }
  if (parsed.protocol !== "https:") {
    throw new AppError(`${label}必须是 https 地址（抖音需要公网可访问）`, {
      code: "INVALID_OPTIONS",
      status: 400,
    });
  }
  return parsed.toString();
}

export interface H5ShareInput {
  videoUrl: string;
  title?: string;
  hashtags?: string[];
  shareToPublish?: boolean;
  taskId?: string;
  callbackUrl?: string;
}

export interface H5ShareResult {
  shareId: string;
  schema: string;
  expiresAt: string;
}

/** 抖音 H5 投稿：官方 h5.share 链路，返回可直接扫码/打开的分享 Schema。 */
export class DouyinH5Client {
  private tokenCache?: { clientKey: string; clientSecret: string; token: string; expiresAt: number };
  private ticketCache?: { clientKey: string; clientSecret: string; ticket: string; expiresAt: number };

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get settings(): DouyinSettings {
    return this.config.douyin;
  }

  get configured(): boolean {
    return Boolean(this.settings.clientKey && this.settings.clientSecret);
  }

  private async call(
    apiPath: string,
    init: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.settings.apiBaseUrl}${apiPath}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (init.method === "POST") headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: init.method,
        headers,
        body: init.method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
        signal,
      });
    } catch (error) {
      throw new AppError(`无法连接抖音开放平台：${toErrorMessage(error)}`, {
        code: "DOUYIN_NETWORK_ERROR",
        status: 502,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(`抖音接口返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ""}`, {
        code: "DOUYIN_HTTP_ERROR",
        status: 502,
      });
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError("抖音接口返回的不是 JSON", { code: "DOUYIN_INVALID_RESPONSE", status: 502 });
    }
    const root = isRecord(json) ? json : {};
    const data = isRecord(root.data) ? root.data : root;
    const errNo = numberField(root, "err_no") ?? 0;
    const errorCode = numberField(data, "error_code") ?? 0;
    if (errNo !== 0 || errorCode !== 0) {
      const description =
        stringField(root, "err_msg") ??
        stringField(data, "description") ??
        stringField(root, "message") ??
        `错误码 ${errNo || errorCode}`;
      throw new AppError(`抖音接口返回错误：${description}`, {
        code: "DOUYIN_API_ERROR",
        status: 502,
      });
    }
    return data;
  }

  private async clientToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (
      this.tokenCache &&
      this.tokenCache.clientKey === this.settings.clientKey &&
      this.tokenCache.clientSecret === this.settings.clientSecret &&
      this.tokenCache.expiresAt > now
    ) {
      return this.tokenCache.token;
    }
    const data = await this.call(
      CLIENT_TOKEN_PATH,
      {
        method: "POST",
        body: {
          client_key: this.settings.clientKey,
          client_secret: this.settings.clientSecret,
          grant_type: "client_credential",
        },
      },
      signal,
    );
    const token = stringField(data, "access_token");
    if (!token) {
      throw new AppError("抖音 client_token 响应缺少 access_token", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    const expiresIn = Math.max(numberField(data, "expires_in") ?? 0, 120);
    this.tokenCache = {
      clientKey: this.settings.clientKey,
      clientSecret: this.settings.clientSecret ?? "",
      token,
      expiresAt: now + (expiresIn - 60) * 1000,
    };
    return token;
  }

  private async openTicket(token: string, signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (
      this.ticketCache &&
      this.ticketCache.clientKey === this.settings.clientKey &&
      this.ticketCache.clientSecret === this.settings.clientSecret &&
      this.ticketCache.expiresAt > now
    ) {
      return this.ticketCache.ticket;
    }
    const data = await this.call(
      OPEN_TICKET_PATH,
      { method: "GET", headers: { "access-token": token } },
      signal,
    );
    const ticket = stringField(data, "ticket");
    if (!ticket) {
      throw new AppError("抖音 open_ticket 响应缺少 ticket", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    const expiresIn = Math.max(numberField(data, "expires_in") ?? 0, 120);
    this.ticketCache = {
      clientKey: this.settings.clientKey,
      clientSecret: this.settings.clientSecret ?? "",
      ticket,
      expiresAt: now + (expiresIn - 60) * 1000,
    };
    return ticket;
  }

  private async createShareId(token: string, signal?: AbortSignal): Promise<string> {
    const data = await this.call(
      SHARE_ID_PATH,
      {
        method: "POST",
        headers: { "access-token": token },
        query: { need_callback: "true" },
      },
      signal,
    );
    const shareId = stringField(data, "share_id");
    if (!shareId) {
      throw new AppError("抖音 share_id 响应缺少 share_id", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    return shareId;
  }

  async createShare(input: H5ShareInput, signal?: AbortSignal): Promise<H5ShareResult> {
    if (!this.configured) {
      throw new AppError("尚未配置抖音开放平台 client_key / client_secret", {
        code: "DOUYIN_NOT_CONFIGURED",
        status: 400,
      });
    }
    const videoUrl = httpsUrl(input.videoUrl, "videoUrl");
    if (input.callbackUrl) httpsUrl(input.callbackUrl, "callbackUrl");
    const title = (input.title ?? "AI 成片").trim().slice(0, 55) || "AI 成片";
    const hashtags = (input.hashtags ?? [])
      .map((tag) => tag.trim().replace(/^#+/, ""))
      .filter(Boolean)
      .slice(0, 10);
    const token = await this.clientToken(signal);
    const ticket = await this.openTicket(token, signal);
    const shareId = await this.createShareId(token, signal);
    const expiresAtSec = Math.floor(Date.now() / 1000) + SHARE_TTL_SEC;
    const data = await this.call(
      GET_SHARE_PATH,
      {
        method: "POST",
        headers: { "access-token": token },
        body: {
          client_ticket: ticket,
          expire_at: expiresAtSec,
          state: shareId,
          video_path: videoUrl,
          title,
          ...(hashtags.length > 0 ? { hashtag_list: hashtags } : {}),
          share_to_publish: input.shareToPublish === false ? 0 : 1,
        },
      },
      signal,
    );
    const schema = stringField(data, "schema");
    if (!schema) {
      throw new AppError("抖音 H5 分享响应缺少 schema", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    this.logger.info(`抖音 H5 投稿链接已生成：share_id=${shareId}`);
    return {
      shareId,
      schema,
      expiresAt: new Date(expiresAtSec * 1000).toISOString(),
    };
  }

  /** 官方 Webhook 签名：sha1(client_secret + 原始 body)。 */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.settings.clientSecret) return false;
    const expected = crypto
      .createHash("sha1")
      .update(this.settings.clientSecret)
      .update(rawBody)
      .digest("hex");
    const actual = signature.trim().toLowerCase();
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }
}

/** 回调给调用方程序时的签名，复用 client_secret，避免额外密钥。 */
export function signCallback(secret: string, rawBody: string): string {
  return crypto.createHash("sha1").update(secret).update(rawBody).digest("hex");
}

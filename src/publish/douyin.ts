import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig, DouyinSettings, DouyinToken, PublishRecord } from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";
import { shortId } from "../util/fs.js";
import { effectiveRedirectUri } from "../server/settings.js";

const TOKEN_PATH = "/oauth/access_token/";
const REFRESH_PATH = "/oauth/refresh_token/";
const USERINFO_PATH = "/oauth/userinfo/";
const UPLOAD_PATH = "/api/douyin/v1/video/upload_video/";
const CREATE_PATH = "/api/douyin/v1/video/create_video/";
const AUTH_PATH = "/platform/oauth/connect/";

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

export interface PublishOptions {
  text: string;
  coverTsp?: number;
}

export interface DouyinPublishResult {
  record: PublishRecord;
}

/**
 * 抖音开放平台客户端：OAuth 授权、令牌刷新、视频上传与发布。
 * 接口文档：https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token
 */
export class DouyinClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  /** 每次读取，保证网页修改抖音应用配置后立即生效。 */
  private get settings(): DouyinSettings {
    return this.config.douyin;
  }

  get configured(): boolean {
    return Boolean(this.settings.clientKey && this.settings.clientSecret);
  }

  get redirectUri(): string {
    return effectiveRedirectUri(this.config);
  }

  authorizeUrl(state: string): string {
    if (!this.configured) {
      throw new AppError("尚未配置抖音开放平台 client_key / client_secret", {
        code: "DOUYIN_NOT_CONFIGURED",
        status: 400,
      });
    }
    const params = new URLSearchParams({
      client_key: this.settings.clientKey,
      response_type: "code",
      scope: this.settings.scope,
      redirect_uri: this.redirectUri,
      state,
    });
    return `${this.settings.apiBaseUrl}${AUTH_PATH}?${params.toString()}`;
  }

  private async callJson(
    apiPath: string,
    init: { method: "POST"; body: Record<string, unknown> } | { method: "GET" },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = `${this.settings.apiBaseUrl}${apiPath}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.method === "POST") headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers,
        body: init.method === "POST" ? JSON.stringify(init.body) : undefined,
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
    const data = isRecord(json) && isRecord(json.data) ? json.data : isRecord(json) ? json : {};
    const errorCode = numberField(data, "error_code") ?? numberField(data, "err_code") ?? 0;
    if (errorCode !== 0) {
      const description = stringField(data, "description") ?? stringField(data, "message") ?? "未知错误";
      throw new AppError(`抖音接口错误（${errorCode}）：${description}`, {
        code: "DOUYIN_API_ERROR",
        status: 502,
      });
    }
    return data;
  }

  private tokenFromData(data: Record<string, unknown>, previous?: DouyinToken): DouyinToken {
    const accessToken = stringField(data, "access_token");
    const openId = stringField(data, "open_id");
    if (!accessToken || !openId) {
      throw new AppError("抖音授权响应缺少 access_token 或 open_id", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    const expiresIn = numberField(data, "expires_in") ?? 0;
    const refreshExpiresIn = numberField(data, "refresh_expires_in");
    const now = Date.now();
    return {
      accessToken,
      refreshToken: stringField(data, "refresh_token") ?? previous?.refreshToken ?? "",
      openId,
      scope: stringField(data, "scope") ?? previous?.scope ?? this.settings.scope,
      expiresAt: new Date(now + Math.max(0, expiresIn) * 1000).toISOString(),
      refreshExpiresAt: refreshExpiresIn
        ? new Date(now + refreshExpiresIn * 1000).toISOString()
        : previous?.refreshExpiresAt,
      nickname: previous?.nickname,
      avatar: previous?.avatar,
      updatedAt: new Date(now).toISOString(),
    };
  }

  async exchangeCode(code: string, signal?: AbortSignal): Promise<DouyinToken> {
    const data = await this.callJson(
      TOKEN_PATH,
      {
        method: "POST",
        body: {
          client_key: this.settings.clientKey,
          client_secret: this.settings.clientSecret,
          code,
          grant_type: "authorization_code",
        },
      },
      signal,
    );
    return this.tokenFromData(data);
  }

  async refresh(token: DouyinToken, signal?: AbortSignal): Promise<DouyinToken> {
    if (!token.refreshToken) {
      throw new AppError("抖音令牌已过期且没有 refresh_token，请重新授权", {
        code: "DOUYIN_REAUTH_REQUIRED",
        status: 401,
      });
    }
    const data = await this.callJson(
      REFRESH_PATH,
      {
        method: "POST",
        body: {
          client_key: this.settings.clientKey,
          grant_type: "refresh_token",
          refresh_token: token.refreshToken,
        },
      },
      signal,
    );
    return this.tokenFromData(data, token);
  }

  /** 距离过期不足 60 秒时自动刷新。 */
  async ensureFresh(token: DouyinToken, signal?: AbortSignal): Promise<DouyinToken> {
    const expiresAt = Date.parse(token.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) return token;
    return this.refresh(token, signal);
  }

  async fetchUserInfo(token: DouyinToken, signal?: AbortSignal): Promise<{ nickname?: string; avatar?: string }> {
    const query = new URLSearchParams({ access_token: token.accessToken, open_id: token.openId });
    const data = await this.callJson(`${USERINFO_PATH}?${query.toString()}`, { method: "GET" }, signal);
    return {
      nickname: stringField(data, "nickname"),
      avatar: stringField(data, "avatar") ?? stringField(data, "avatar_larger"),
    };
  }

  private async uploadVideo(
    token: DouyinToken,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new AppError("成片文件不存在，无法发布", { code: "VIDEO_NOT_FOUND", status: 404 });
    }
    const buffer = await fsp.readFile(filePath);
    const form = new FormData();
    form.append("video", new Blob([buffer], { type: "video/mp4" }), path.basename(filePath));
    const url = new URL(`${this.settings.apiBaseUrl}${UPLOAD_PATH}`);
    url.searchParams.set("open_id", token.openId);
    url.searchParams.set("access_token", token.accessToken);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method: "POST", body: form, signal });
    } catch (error) {
      throw new AppError(`上传视频到抖音失败：${toErrorMessage(error)}`, {
        code: "DOUYIN_UPLOAD_FAILED",
        status: 502,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(`上传视频到抖音失败：HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ""}`, {
        code: "DOUYIN_UPLOAD_FAILED",
        status: 502,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new AppError("抖音上传接口返回的不是 JSON", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    const data = isRecord(json) && isRecord(json.data) ? json.data : isRecord(json) ? json : {};
    const errorCode = numberField(data, "error_code") ?? 0;
    if (errorCode !== 0) {
      throw new AppError(
        `抖音上传失败（${errorCode}）：${stringField(data, "description") ?? "未知错误"}`,
        { code: "DOUYIN_UPLOAD_FAILED", status: 502 },
      );
    }
    const video = isRecord(data.video) ? data.video : {};
    const videoId = stringField(video, "video_id") ?? stringField(data, "video_id");
    if (!videoId) {
      throw new AppError("抖音上传响应缺少 video_id", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    return videoId;
  }

  async publish(
    token: DouyinToken,
    job: { id: string; topic: string; videoPath: string },
    options: PublishOptions,
    signal?: AbortSignal,
  ): Promise<DouyinPublishResult> {
    if (!this.configured) {
      throw new AppError("尚未配置抖音开放平台应用，无法发布", {
        code: "DOUYIN_NOT_CONFIGURED",
        status: 400,
      });
    }
    const text = options.text.trim();
    if (!text) {
      throw new AppError("发布标题不能为空", { code: "DOUYIN_TEXT_REQUIRED", status: 400 });
    }
    if (text.length > 55) {
      throw new AppError("抖音发布标题最多 55 个字符", { code: "DOUYIN_TEXT_TOO_LONG", status: 400 });
    }
    const fresh = await this.ensureFresh(token, signal);
    this.logger.info(`发布视频到抖音：任务 ${job.id}`);
    const videoId = await this.uploadVideo(fresh, job.videoPath, signal);
    const body: Record<string, unknown> = { video_id: videoId, text };
    if (options.coverTsp !== undefined) body.cover_tsp = options.coverTsp;
    const data = await this.callJson(
      `${CREATE_PATH}?open_id=${encodeURIComponent(fresh.openId)}&access_token=${encodeURIComponent(fresh.accessToken)}`,
      { method: "POST", body },
      signal,
    );
    const itemId = stringField(data, "item_id");
    if (!itemId) {
      throw new AppError("抖音发布响应缺少 item_id", {
        code: "DOUYIN_INVALID_RESPONSE",
        status: 502,
      });
    }
    const record: PublishRecord = {
      id: shortId(),
      jobId: job.id,
      topic: job.topic,
      text,
      itemId,
      videoId,
      coverTsp: options.coverTsp,
      createdAt: new Date().toISOString(),
    };
    this.logger.info(`抖音发布成功：item_id=${itemId}`);
    return { record };
  }
}

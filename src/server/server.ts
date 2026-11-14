import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { TTS_PROVIDER_NAMES } from "../types.js";
import type {
  AppConfig,
  CastAsset,
  DouyinToken,
  JobOptions,
  ScriptProviderName,
  TtsProviderName,
} from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";
import { isAiVideoEnabled } from "../config.js";
import { MaterialLibrary, materialType } from "../materials/library.js";
import { materialTagPool } from "../materials/match.js";
import { ensureDir, isInside, sanitizeFilename, sha256 } from "../util/fs.js";
import {
  CastLibrary,
  castImageType,
  parseCastDescription,
  parseCastKind,
  parseCastName,
  parseCastVoice,
  selectCastAssets,
  type UpdateCastOptions,
} from "../cast/library.js";
import { STORY_MAX_LENGTH, preflightScript, preflightVideoJob } from "../preflight.js";
import { reviewCreation } from "../creation/review.js";
import { createScriptProvider } from "../script/index.js";
import { createTtsProvider } from "../tts/index.js";
import { voicePitchFor, voiceRateFor, voiceStyleFor } from "../tts/voices.js";
import { voiceCatalog } from "../tts/voice-catalog.js";
import { HttpVideoGenProvider, VideoGenPendingError } from "../videogen/http.js";
import { buildJobConfig, JobManager } from "./jobs.js";
import { SettingsStore, effectiveRedirectUri } from "./settings.js";
import {
  LoginThrottle,
  SESSION_COOKIE,
  SessionStore,
  assertSameOrigin,
  clearSessionCookie,
  parseCookies,
  sessionCookie,
} from "./auth.js";
import {
  MENU_PERMISSIONS,
  UserStore,
  effectivePermissions,
  toUserView,
  type CreateUserInput,
  type MenuPermission,
  type UpdateUserInput,
  type UserRecord,
  type UserRole,
} from "./users.js";
import { DouyinClient } from "../publish/douyin.js";
import { DouyinTokenStore } from "../publish/token-store.js";
import { PublishStore } from "../publish/store.js";

const API_VERSION = "0.2.0";
const JSON_BODY_LIMIT = 1024 * 1024;
const SCRIPT_PROVIDERS: ScriptProviderName[] = ["auto", "openai", "offline"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServerDeps {
  fetchImpl?: typeof fetch;
  webDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface VideoServer {
  server: http.Server;
  jobs: JobManager;
  library: MaterialLibrary;
  cast: CastLibrary;
  settings: SettingsStore;
  users: UserStore;
  sessions: SessionStore;
  douyin: DouyinClient;
  tokens: DouyinTokenStore;
  publishes: PublishStore;
  close(): Promise<void>;
}

export interface StartedServer extends VideoServer {
  port: number;
  url: string;
}

interface ServerContext {
  config: AppConfig;
  logger: Logger;
  jobs: JobManager;
  library: MaterialLibrary;
  cast: CastLibrary;
  settings: SettingsStore;
  users: UserStore;
  sessions: SessionStore;
  loginThrottle: LoginThrottle;
  douyin: DouyinClient;
  tokens: DouyinTokenStore;
  publishes: PublishStore;
  webDir: string;
  pendingStates: Map<string, number>;
}

function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, text: string, contentType: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > JSON_BODY_LIMIT) {
      throw new AppError("请求体过大", { code: "BODY_TOO_LARGE", status: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("请求体必须是 JSON 对象", { code: "INVALID_JSON", status: 400 });
  }
}

async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new AppError("文件不存在", { code: "FILE_NOT_FOUND", status: 404 });
  }
  if (!stat.isFile()) {
    throw new AppError("文件不存在", { code: "FILE_NOT_FOUND", status: 404 });
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { ...securityHeaders(), "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    const startRaw = match[1];
    const endRaw = match[2];
    let start: number;
    let end: number;
    if (startRaw === "" && endRaw) {
      const suffix = Number(endRaw);
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = Number(startRaw);
      end = endRaw === "" ? stat.size - 1 : Number(endRaw);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
      res.writeHead(416, { ...securityHeaders(), "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...securityHeaders(),
      "content-type": contentType,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => undefined);
    return;
  }

  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": contentType,
    "content-length": stat.size,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(file), res).catch(() => undefined);
}

function requireTopic(value: unknown): string {
  const topic = typeof value === "string" ? value.trim() : "";
  if (!topic) throw new AppError("topic 不能为空", { code: "INVALID_TOPIC", status: 400 });
  if (topic.length > 200) {
    throw new AppError("topic 不能超过 200 个字符", { code: "INVALID_TOPIC", status: 400 });
  }
  return topic;
}

function optionalNumber(body: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`${label}必须是数字`, { code: "INVALID_OPTIONS", status: 400 });
  }
  return parsed;
}

function optionalBoolean(body: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new AppError(`${label}必须是布尔值`, { code: "INVALID_OPTIONS", status: 400 });
  }
  return value;
}

function optionalStory(body: Record<string, unknown>): string | undefined {
  const value = body.story;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AppError("剧本/大纲必须是文本", { code: "INVALID_OPTIONS", status: 400 });
  }
  const story = value.trim();
  if (!story) return undefined;
  if (story.length > STORY_MAX_LENGTH) {
    throw new AppError(`剧本/大纲不能超过 ${STORY_MAX_LENGTH} 个字符`, {
      code: "INVALID_OPTIONS",
      status: 400,
    });
  }
  return story;
}

function optionalCastIds(body: Record<string, unknown>): string[] | undefined {
  const value = body.castIds;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new AppError("castIds 必须是角色/道具 id 数组", { code: "INVALID_OPTIONS", status: 400 });
  }
  const ids = [...new Set(value.map((id) => (id as string).trim()).filter(Boolean))];
  if (ids.length > 30) {
    throw new AppError("单个视频最多选择 30 个角色/道具", { code: "INVALID_OPTIONS", status: 400 });
  }
  return ids;
}

function parseJobOptions(body: Record<string, unknown>): JobOptions {
  const options: JobOptions = {};
  const targetDurationSec = optionalNumber(body, "targetDurationSec", "目标时长");
  if (targetDurationSec !== undefined) options.targetDurationSec = targetDurationSec;
  const maxSegments = optionalNumber(body, "maxSegments", "分镜数量");
  if (maxSegments !== undefined) options.maxSegments = maxSegments;
  if (body.ttsProvider !== undefined && body.ttsProvider !== null) {
    if (!TTS_PROVIDER_NAMES.includes(body.ttsProvider as TtsProviderName)) {
      throw new AppError(`不支持的配音供应商：${String(body.ttsProvider)}`, {
        code: "INVALID_OPTIONS",
        status: 400,
      });
    }
    options.ttsProvider = body.ttsProvider as TtsProviderName;
  }
  if (typeof body.voice === "string") options.voice = body.voice;
  const subtitlesEnabled = optionalBoolean(body, "subtitlesEnabled", "字幕开关");
  if (subtitlesEnabled !== undefined) options.subtitlesEnabled = subtitlesEnabled;
  const videoGenEnabled = optionalBoolean(body, "videoGenEnabled", "AI 画面开关");
  if (videoGenEnabled !== undefined) options.videoGenEnabled = videoGenEnabled;
  const allowUnmatched = optionalBoolean(body, "allowUnmatched", "素材兜底开关");
  if (allowUnmatched !== undefined) options.allowUnmatched = allowUnmatched;
  const story = optionalStory(body);
  if (story !== undefined) options.story = story;
  const castIds = optionalCastIds(body);
  if (castIds !== undefined) options.castIds = castIds;
  if (body.dialogue === true) options.dialogue = true;
  return options;
}

interface MultipartUpload {
  fields: Record<string, string>;
  file?: { tempPath: string; filename: string };
  tempDir: string;
}

/**
 * 读取单个 multipart 上传：文件先落到临时目录，调用方负责清理 tempDir。
 * 通过 accept 校验文件类型，让素材与角色参考图各自给出明确提示。
 */
async function readMultipartUpload(
  req: http.IncomingMessage,
  config: AppConfig,
  options: {
    accept: (filename: string) => boolean;
    unsupportedMessage: (filename: string) => string;
    unsupportedCode: string;
    required: boolean;
  },
): Promise<MultipartUpload> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new AppError("上传需要 multipart/form-data", {
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    });
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "video-agent-upload-"));
  let tempFile: string | undefined;
  let originalName = "";
  let fileError: Error | undefined;
  let truncated = false;
  let filePromise: Promise<void> = Promise.resolve();
  const fields: Record<string, string> = {};

  try {
    const busboy = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: {
        fileSize: config.server.maxUploadBytes,
        files: 1,
        fields: 10,
      },
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, stream, info) => {
      if (name !== "file" || tempFile) {
        stream.resume();
        return;
      }
      const filename = info.filename ?? "upload";
      if (!options.accept(filename)) {
        fileError = new AppError(options.unsupportedMessage(filename), {
          code: options.unsupportedCode,
          status: 415,
        });
        stream.resume();
        return;
      }
      originalName = filename;
      tempFile = path.join(tempDir, sanitizeFilename(filename));
      filePromise = pipeline(stream, fs.createWriteStream(tempFile)).catch((error: unknown) => {
        fileError = error instanceof Error ? error : new Error(String(error));
      });
      stream.on("limit", () => {
        truncated = true;
      });
    });

    busboy.on("error", (error) => {
      fileError = error instanceof Error ? error : new Error(String(error));
    });

    await new Promise<void>((resolve, reject) => {
      busboy.on("close", resolve);
      busboy.on("error", reject);
      req.pipe(busboy);
    });
    await filePromise;

    if (fileError) throw fileError;
    if (truncated) {
      throw new AppError(`文件超过上传上限 ${config.server.maxUploadBytes} 字节`, {
        code: "FILE_TOO_LARGE",
        status: 413,
      });
    }
    if (options.required && !tempFile) {
      throw new AppError("缺少 file 字段", { code: "MISSING_FILE", status: 400 });
    }
    return {
      fields,
      ...(tempFile ? { file: { tempPath: tempFile, filename: originalName } } : {}),
      tempDir,
    };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  library: MaterialLibrary,
): Promise<void> {
  const upload = await readMultipartUpload(req, config, {
    accept: (filename) => Boolean(materialType(filename)),
    unsupportedMessage: (filename) =>
      `不支持的素材格式：${path.extname(filename) || "未知"}（支持 mp4/mov/webm/mkv 与 jpg/png/webp）`,
    unsupportedCode: "MATERIAL_UNSUPPORTED",
    required: true,
  });
  try {
    const tags = (upload.fields.tags ?? "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const material = await library.add(upload.file!.tempPath, {
      tags,
      title: upload.fields.title?.trim() || upload.file!.filename.replace(/\.[^.]+$/, ""),
    });
    sendJson(res, 201, { material: { ...material, url: `/api/materials/${material.id}/file` } });
  } finally {
    await fsp.rm(upload.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 角色库试听：用指定音色与人物设定合成一句示例台词，直接返回音频。
 * 不落任务、不改设置，试听失败也不影响角色保存。
 */
async function handleCastVoicePreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const body = await readJsonBody(req);
  const config = structuredClone(ctx.config);
  if (config.tts.provider === "silent") {
    throw new AppError("当前配音是静音占位，无法试听；请先在设置里选择可发声的配音供应商", {
      code: "TTS_PREVIEW_UNAVAILABLE",
      status: 400,
    });
  }
  const requestedVoice = typeof body.voice === "string" ? body.voice.trim().slice(0, 120) : "";
  if (!requestedVoice) {
    throw new AppError("请先选择或填写音色", { code: "TTS_PREVIEW_NO_VOICE", status: 400 });
  }
  let voice = requestedVoice;
  const catalog = await voiceCatalog(config.tts, ctx.logger);
  const known = catalog.voices.some((item) => item.value === voice);
  if (!known && config.tts.provider !== "edge" && /Neural$/i.test(voice) && catalog.voices.length > 0) {
    // 设置里换了供应商，角色库还留着 Edge 音色：直接拿旧音色去合成只会报错或没声。
    voice = catalog.voices[0]!.value;
  } else if (!known && config.tts.provider === "edge" && !/Neural$/i.test(voice)) {
    throw new AppError(`Edge TTS 不支持音色「${voice}」：请选列表里的 Edge 音色，或在设置里切换配音供应商后再试听`, {
      code: "TTS_PREVIEW_VOICE_MISMATCH",
      status: 400,
    });
  }
  config.tts.voice = voice;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
  const description = typeof body.description === "string" ? body.description.slice(0, 500) : "";
  const text = name ? `你好，我是${name}，先听一下我的声音。` : "你好，这是一段角色配音试听。";
  const rate = voiceRateFor(description, config.tts.rate);
  const pitch = voicePitchFor(description);
  const instructions =
    config.tts.provider === "openai" || config.tts.provider === "elevenlabs"
      ? voiceStyleFor(description, text)
      : undefined;
  const provider = createTtsProvider(config, config.cacheDir, ctx.logger);
  const result = await provider.synthesize(
    {
      text,
      cacheKey: sha256(
        ["cast-preview", provider.name, voice, String(rate), pitch, instructions ?? "", text].join("|"),
      ).slice(0, 40),
      rate,
      pitch,
      ...(instructions ? { instructions } : {}),
    },
    AbortSignal.timeout(Math.min(config.tts.timeoutMs, 30_000)),
  );
  const buffer = await fsp.readFile(result.audioPath);
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "audio/mpeg",
    "content-length": buffer.length,
    "cache-control": "no-store",
    "x-preview-voice": encodeURIComponent(voice),
    "x-preview-provider": encodeURIComponent(config.tts.provider),
  });
  res.end(buffer);
}

function castView(asset: CastAsset): Record<string, unknown> {
  return {
    ...asset,
    ...(asset.imageFile ? { imageUrl: `/api/cast/${asset.id}/image` } : {}),
  };
}

async function handleCastUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  replaceId?: string,
): Promise<void> {
  const upload = await readMultipartUpload(req, ctx.config, {
    accept: (filename) => Boolean(castImageType(filename)),
    unsupportedMessage: (filename) =>
      `参考图只支持 jpg/png/webp，当前为 ${path.extname(filename) || "未知格式"}`,
    unsupportedCode: "CAST_UNSUPPORTED",
    required: Boolean(replaceId),
  });
  try {
    if (replaceId) {
      const asset = await ctx.cast.setImage(replaceId, upload.file!.tempPath);
      sendJson(res, 200, { cast: castView(asset) });
      return;
    }
    const kind = parseCastKind(upload.fields.kind);
    const name = parseCastName(upload.fields.name);
    const description = parseCastDescription(upload.fields.description);
    const voice = parseCastVoice(upload.fields.voice);
    const asset = await ctx.cast.add({
      kind,
      name,
      description,
      voice,
      imagePath: upload.file?.tempPath ?? null,
    });
    sendJson(res, 201, { cast: castView(asset) });
  } finally {
    await fsp.rm(upload.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleCastUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const patch: UpdateCastOptions = {};
  if (body.kind !== undefined) patch.kind = parseCastKind(body.kind);
  if (body.name !== undefined) patch.name = parseCastName(body.name);
  if (body.description !== undefined) patch.description = parseCastDescription(body.description);
  if (body.voice !== undefined) patch.voice = parseCastVoice(body.voice);
  const asset = await ctx.cast.update(id, patch);
  sendJson(res, 200, { cast: castView(asset) });
}

function apiIndex(config: AppConfig): Record<string, unknown> {
  return {
    name: "video-agent",
    version: API_VERSION,
    description: "视频创作智能体：主题 → 脚本 → 素材/AI 画面 → 配音 → 剪辑 → 成片",
    web: "/",
    authentication: "HttpOnly 会话 Cookie；除 /api、/api/auth/* 与抖音回调外均需登录",
    endpoints: {
      session: "GET /api/auth/session",
      setup: "POST /api/auth/setup {username, displayName?, password}",
      login: "POST /api/auth/login {username, password}",
      logout: "POST /api/auth/logout",
      settings: "GET/PUT /api/settings",
      testSettings: "POST /api/settings/test {kind: script|tts|videogen|douyin}",
      users: "GET/POST /api/users（管理员）",
      updateUser: "PATCH /api/users/:id（管理员）",
      deleteUser: "DELETE /api/users/:id（管理员）",
      createVideo:
        "POST /api/videos {topic, story?, castIds?, targetDurationSec?, maxSegments?, voice?, ...}",
      listVideos: "GET /api/videos",
      videoStatus: "GET /api/videos/:id",
      videoFile: "GET /api/videos/:id/video",
      videoPoster: "GET /api/videos/:id/poster",
      subtitles: "GET /api/videos/:id/subtitles",
      generateScript: "POST /api/scripts/generate {topic, story?, castIds?}",
      listCast: "GET /api/cast",
      createCast: "POST /api/cast (multipart: kind, name, description?, file?)",
      updateCast: "PATCH /api/cast/:id {name?, description?, kind?}",
      castImage: "GET /api/cast/:id/image",
      castVoicePreview: "POST /api/cast/voice-preview {voice, name?, description?}",
      ttsVoices: "GET /api/tts/voices?provider=&model=",
      replaceCastImage: "POST /api/cast/:id/image (multipart: file)",
      deleteCast: "DELETE /api/cast/:id",
      listMaterials: "GET /api/materials",
      uploadMaterial: "POST /api/materials (multipart: file, tags?, title?)",
      materialFile: "GET /api/materials/:id/file",
      deleteMaterial: "DELETE /api/materials/:id",
      douyinStatus: "GET /api/douyin/status",
      douyinAuthorize: "GET /api/douyin/authorize",
      douyinCallback: "GET /api/douyin/callback",
      publish: "POST /api/videos/:id/publish {text?, coverTsp?}",
      publishes: "GET /api/publishes",
    },
    config: {
      scriptProvider: config.script.provider,
      ttsProvider: config.tts.provider,
      videoGenProvider: config.videoGen.provider,
      douyinConfigured: Boolean(config.douyin.clientKey && config.douyin.clientSecret),
    },
  };
}

function readSessionToken(req: http.IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

async function resolveSessionUser(
  ctx: ServerContext,
  req: http.IncomingMessage,
): Promise<UserRecord | null> {
  const token = readSessionToken(req);
  const session = ctx.sessions.get(token);
  if (!session) return null;
  const user = await ctx.users.findById(session.userId);
  if (!user || user.disabled) {
    ctx.sessions.destroy(token);
    return null;
  }
  return user;
}

async function authPayload(
  ctx: ServerContext,
  user: UserRecord | null,
): Promise<Record<string, unknown>> {
  return {
    authenticated: Boolean(user),
    needsSetup: !(await ctx.users.hasUsers()),
    user: user ? toUserView(user) : null,
    menus: user ? effectivePermissions(user) : [],
  };
}

function hasMenuPermission(user: UserRecord, permission: MenuPermission): boolean {
  return user.role === "admin" || user.permissions.includes(permission);
}

/** API 路径所需的菜单权限；admin 表示仅管理员可访问。 */
function requiredPermission(method: string, pathname: string): MenuPermission | "admin" | null {
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) return "admin";
  if (pathname === "/api/settings") return method === "GET" ? null : "settings";
  if (pathname.startsWith("/api/settings/")) return "settings";
  if (pathname === "/api/materials" || pathname.startsWith("/api/materials/")) return "materials";
  if (pathname === "/api/cast" || pathname.startsWith("/api/cast/")) return "cast";
  if (pathname === "/api/scripts/generate") return "create";
  if (pathname === "/api/videos") return method === "POST" ? "create" : "jobs";
  if (pathname.startsWith("/api/videos/") && pathname.endsWith("/publish")) return "publish";
  if (pathname.startsWith("/api/videos/")) return "jobs";
  if (pathname === "/api/publishes") return "publish";
  if (pathname.startsWith("/api/douyin/")) return "publish";
  return null;
}

function isPublicApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/auth/") || pathname === "/api/douyin/callback";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function permissionInput(value: unknown): MenuPermission[] | undefined {
  return value === undefined ? undefined : (value as MenuPermission[]);
}

async function handleAuthSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const user = await resolveSessionUser(ctx, req);
  sendJson(res, 200, await authPayload(ctx, user));
}

async function handleSetup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  assertSameOrigin(req);
  const body = await readJsonBody(req);
  const user = await ctx.users.setup({
    username: optionalString(body.username) ?? "",
    displayName: optionalString(body.displayName),
    password: optionalString(body.password) ?? "",
  });
  const token = ctx.sessions.create(user.id);
  await ctx.users.markLogin(user.id);
  const record = await ctx.users.findById(user.id);
  sendJson(
    res,
    201,
    await authPayload(ctx, record ?? null),
    { "set-cookie": sessionCookie(token) },
  );
}

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  assertSameOrigin(req);
  const body = await readJsonBody(req);
  const username = optionalString(body.username)?.trim() ?? "";
  const password = optionalString(body.password) ?? "";
  const throttleKey = `${req.socket.remoteAddress ?? "unknown"}|${username.toLowerCase()}`;
  ctx.loginThrottle.check(throttleKey);
  const user = await ctx.users.verify(username, password);
  if (!user) {
    ctx.loginThrottle.fail(throttleKey);
    throw new AppError("用户名或密码错误", { code: "INVALID_CREDENTIALS", status: 401 });
  }
  ctx.loginThrottle.reset(throttleKey);
  const token = ctx.sessions.create(user.id);
  await ctx.users.markLogin(user.id);
  sendJson(res, 200, await authPayload(ctx, user), { "set-cookie": sessionCookie(token) });
}

async function handleLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  assertSameOrigin(req);
  ctx.sessions.destroy(readSessionToken(req));
  sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
}

async function handleCreateUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  assertSameOrigin(req);
  const body = await readJsonBody(req);
  const input: CreateUserInput = {
    username: optionalString(body.username) ?? "",
    displayName: optionalString(body.displayName),
    password: optionalString(body.password) ?? "",
    role: body.role === undefined ? undefined : (body.role as UserRole),
    permissions: permissionInput(body.permissions),
  };
  const user = await ctx.users.create(input);
  sendJson(res, 201, { user });
}

async function handleUpdateUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  id: string,
  actor: UserRecord,
): Promise<void> {
  assertSameOrigin(req);
  const body = await readJsonBody(req);
  const patch: UpdateUserInput = {};
  if (body.displayName !== undefined) patch.displayName = body.displayName as string;
  if (body.password !== undefined) patch.password = body.password as string;
  if (body.role === "admin" || body.role === "member") patch.role = body.role;
  else if (body.role !== undefined) patch.role = body.role as UserRole;
  if (body.permissions !== undefined) patch.permissions = permissionInput(body.permissions);
  const disabled = optionalBoolean(body, "disabled", "禁用状态");
  if (disabled !== undefined) patch.disabled = disabled;
  const user = await ctx.users.update(id, patch, actor.id);
  if (user.disabled) ctx.sessions.destroyUser(id);
  // 管理员重置他人密码后，旧会话立即失效；修改自己的密码保留当前会话。
  if (body.password !== undefined && id !== actor.id) ctx.sessions.destroyUser(id);
  sendJson(res, 200, { user });
}

async function handleDeleteUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  id: string,
  actor: UserRecord,
): Promise<void> {
  assertSameOrigin(req);
  await ctx.users.remove(id, actor.id);
  ctx.sessions.destroyUser(id);
  sendJson(res, 200, { ok: true });
}

const SETTINGS_TEST_VIDEO_KEEP = 20;
const DEFAULT_VIDEOGEN_TEST_PROMPT = "一只橘猫在窗台上看雨，电影感，近景";

const SETTINGS_TEST_PENDING_TTL_MS = 30 * 60_000;

interface PendingVideoTest {
  taskId: string;
  prompt: string;
  durationSec: number;
  model: string;
  at: number;
}

/**
 * 已提交但没在本轮请求内出片的测试任务。
 * 再次点击测试时复用这些任务继续查询，避免对同一段测试视频重复付费。
 */
const pendingVideoTests = new Map<string, PendingVideoTest>();
/**
 * 正在跑的视频测试。同一个“地址+模型+时长+描述”的重复请求（连点、自动续查、
 * 多标签页）共享同一次提交，避免向平台重复提交、重复扣费。
 */
const inflightVideoTests = new Map<string, Promise<Record<string, unknown>>>();

function settingsTestKey(
  config: { videoGen: { baseUrl: string; model: string } },
  prompt: string,
  durationSec: number,
): string {
  return [config.videoGen.baseUrl, config.videoGen.model, durationSec, prompt].join("|");
}

async function runVideoTestOnce(
  key: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const existing = inflightVideoTests.get(key);
  if (existing) return existing;
  const task = run().finally(() => {
    inflightVideoTests.delete(key);
  });
  inflightVideoTests.set(key, task);
  return task;
}

function takePendingVideoTest(key: string): PendingVideoTest | undefined {
  const pending = pendingVideoTests.get(key);
  if (!pending) return undefined;
  if (Date.now() - pending.at > SETTINGS_TEST_PENDING_TTL_MS) {
    pendingVideoTests.delete(key);
    return undefined;
  }
  return pending;
}

/** 测试视频只保留最近若干条，避免长期占用缓存目录。 */
async function pruneSettingsTestVideos(dir: string): Promise<void> {
  try {
    const names = (await fsp.readdir(dir)).filter((name) => name.endsWith(".mp4"));
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        mtimeMs: (await fsp.stat(path.join(dir, name))).mtimeMs,
      })),
    );
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(
      files
        .slice(SETTINGS_TEST_VIDEO_KEEP)
        .map((file) => fsp.rm(path.join(dir, file.name), { force: true })),
    );
  } catch {
    // 清理失败不影响本次测试
  }
}

async function handleSettingsTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const body = await readJsonBody(req);
  const kind = body.kind;
  if (kind === "script") {
    const config = structuredClone(ctx.config);
    const provider = createScriptProvider(config, ctx.logger);
    const materials = await ctx.library.list();
    const script = await provider.generate(
      {
        topic: "连接测试：一杯手冲咖啡",
        targetDurationSec: 10,
        maxSegments: 2,
        availableTags: materialTagPool(materials),
      },
      AbortSignal.timeout(Math.min(config.script.timeoutMs, 60_000)),
    );
    sendJson(res, 200, {
      ok: true,
      kind,
      provider: script.provider,
      title: script.title,
      segments: script.segments.length,
    });
    return;
  }
  if (kind === "tts") {
    const config = structuredClone(ctx.config);
    const provider = createTtsProvider(config, config.cacheDir, ctx.logger);
    const text = "你好，这是一段配音测试。";
    const result = await provider.synthesize(
      { text, cacheKey: `settings-test-${sha256(`${config.tts.provider}|${config.tts.voice}|${text}`).slice(0, 20)}` },
      AbortSignal.timeout(Math.min(config.tts.timeoutMs, 60_000)),
    );
    sendJson(res, 200, {
      ok: true,
      kind,
      provider: result.provider,
      voice: result.voice,
      durationSec: result.durationSec,
      cached: result.cached,
    });
    return;
  }
  if (kind === "videogen") {
    const config = structuredClone(ctx.config);
    if (config.videoGen.provider !== "http") {
      throw new AppError("AI 画面生成未启用：请选择「HTTP 文生视频接口」并保存", {
        code: "VIDEOGEN_DISABLED",
        status: 400,
      });
    }
    if (!config.videoGen.apiKey) {
      throw new AppError(
        "AI 画面生成还没有填写 API Key：请在上面填写后保存，再点击测试；测试会真实生成视频并可能产生费用。",
        { code: "VIDEOGEN_MISSING_API_KEY", status: 400 },
      );
    }
    const prompt = (optionalString(body.prompt) ?? "").trim() || DEFAULT_VIDEOGEN_TEST_PROMPT;
    if (prompt.length > 500) {
      throw new AppError("测试描述最多 500 个字符", { code: "INVALID_OPTIONS", status: 400 });
    }
    const durationSec = optionalNumber(body, "durationSec", "测试时长") ?? 5;
    if (durationSec !== 3 && durationSec !== 5) {
      throw new AppError("测试时长只能是 3 秒或 5 秒", { code: "INVALID_OPTIONS", status: 400 });
    }
    const outputDir = path.join(config.cacheDir, "settings-test");
    await ensureDir(outputDir);
    const key = settingsTestKey(config, prompt, durationSec);
    // 一次请求内最多等待 3 分钟；超时后任务通常仍在平台侧生成，继续复用而不是重新提交。
    const budgetMs = Math.min(config.videoGen.timeoutMs, 180_000);
    const explicitTaskId = (optionalString(body.resumeTaskId) ?? "").trim();
    const runTest = async (): Promise<Record<string, unknown>> => {
      const provider = new HttpVideoGenProvider(config.videoGen, ctx.logger);
      const pending = explicitTaskId ? undefined : takePendingVideoTest(key);
      const resumeTaskId = explicitTaskId || pending?.taskId;
      if (!resumeTaskId) {
        ctx.logger.info(`设置页测试提交画面生成任务：${config.videoGen.model}（${prompt.slice(0, 20)}…）`);
      }
      try {
        const generated = resumeTaskId
          ? await provider.resume(resumeTaskId, outputDir, AbortSignal.timeout(budgetMs))
          : await provider.generate({ prompt, durationSec }, outputDir, AbortSignal.timeout(budgetMs));
        pendingVideoTests.delete(key);
        await pruneSettingsTestVideos(outputDir);
        return {
          ok: true,
          kind,
          provider: generated.provider,
          model: generated.model,
          prompt,
          durationSec: generated.durationSec,
          reused: Boolean(resumeTaskId),
          submitted: !resumeTaskId,
          videoUrl: `/api/settings/test/video/${encodeURIComponent(path.basename(generated.file))}`,
        };
      } catch (error) {
        if (!(error instanceof VideoGenPendingError)) {
          pendingVideoTests.delete(key);
          throw error;
        }
        // 已提交但还没出片：不算失败，如实告诉用户并记住任务，避免重复扣费。
        if (error.taskId) {
          pendingVideoTests.set(key, {
            taskId: error.taskId,
            prompt,
            durationSec,
            model: config.videoGen.model,
            at: Date.now(),
          });
        } else {
          pendingVideoTests.delete(key);
        }
        return {
          ok: true,
          kind,
          pending: true,
          submitted: error.submitted,
          reused: Boolean(resumeTaskId),
          taskId: error.taskId ?? null,
          provider: provider.name,
          model: config.videoGen.model,
          prompt,
          durationSec,
          lastStatus: error.lastStatus || null,
          message: error.message,
        };
      }
    };
    // 同一个 key 的并发请求（双击、两个标签页、自动续查同时触发）只提交一次：
    // 后来的请求直接等同一个结果，避免重复提交、重复扣费。
    const flightKey = `${key}|${explicitTaskId}`;
    const payload = await runVideoTestOnce(flightKey, runTest);
    sendJson(res, 200, payload);
    return;
  }
  if (kind === "douyin") {
    const result = await ctx.douyin.verifyCredentials(AbortSignal.timeout(20_000));
    sendJson(res, 200, {
      ok: true,
      kind,
      clientKey: ctx.config.douyin.clientKey,
      redirectUri: effectiveRedirectUri(ctx.config),
      expiresInSec: result.expiresInSec,
      authorized: Boolean(await ctx.tokens.read()),
    });
    return;
  }
  throw new AppError("kind 只能是 script、tts、videogen 或 douyin", {
    code: "INVALID_OPTIONS",
    status: 400,
  });
}

async function handleGenerateScript(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const body = await readJsonBody(req);
  const topic = requireTopic(body.topic);
  const config = structuredClone(ctx.config);
  const targetDurationSec = optionalNumber(body, "targetDurationSec", "目标时长");
  const maxSegments = optionalNumber(body, "maxSegments", "分镜数量");
  if (targetDurationSec !== undefined) config.script.targetDurationSec = targetDurationSec;
  if (maxSegments !== undefined) config.script.maxSegments = maxSegments;
  if (body.provider !== undefined && body.provider !== null) {
    if (!SCRIPT_PROVIDERS.includes(body.provider as ScriptProviderName)) {
      throw new AppError(`不支持的脚本供应商：${String(body.provider)}`, {
        code: "INVALID_OPTIONS",
        status: 400,
      });
    }
    config.script.provider = body.provider as ScriptProviderName;
  }
  if (config.script.provider === "openai" && !config.script.apiKey) {
    throw new AppError("脚本供应商为 openai 但未配置 API Key", {
      code: "CONFIG_MISSING_API_KEY",
      status: 400,
    });
  }
  if (config.script.targetDurationSec < 5 || config.script.targetDurationSec > 600) {
    throw new AppError("目标时长必须在 5 到 600 秒之间", { code: "INVALID_OPTIONS", status: 400 });
  }
  if (config.script.maxSegments < 2 || config.script.maxSegments > 20) {
    throw new AppError("分镜数量必须在 2 到 20 之间", { code: "INVALID_OPTIONS", status: 400 });
  }
  const story = optionalStory(body);
  const castIds = optionalCastIds(body);
  const allCast = await ctx.cast.list();
  const selectedCast = selectCastAssets(allCast, castIds);
  // 预览同样会在调用模型前拦截明显问题，避免预览就产生费用。
  await preflightScript({ config, topic, story, castAssets: selectedCast });
  const materials = await ctx.library.list();
  const provider = createScriptProvider(config, ctx.logger);
  const script = await provider.generate(
    {
      topic,
      targetDurationSec: config.script.targetDurationSec,
      maxSegments: config.script.maxSegments,
      availableTags: materialTagPool(materials),
      ...(story ? { story } : {}),
      ...(body.dialogue === true ? { dialogue: true } : {}),
      ...(selectedCast.length > 0
        ? {
            cast: selectedCast.map(({ name, kind, description }) => ({ name, kind, description })),
          }
        : {}),
    },
    AbortSignal.timeout(Math.min(config.script.timeoutMs, 120_000)),
  );
  sendJson(res, 200, {
    script,
    provider: script.provider,
    targetDurationSec: config.script.targetDurationSec,
    maxSegments: config.script.maxSegments,
    availableTags: materialTagPool(materials),
    cast: selectedCast.map(castView),
    review: reviewCreation({
      topic,
      story,
      targetDurationSec: config.script.targetDurationSec,
      segments: script.segments,
      cast: selectedCast.map(({ name, kind, imageFile }) => ({ name, kind, ...(imageFile ? { imageFile } : {}) })),
    }),
  });
}

function douyinStatus(ctx: ServerContext, token: DouyinToken | null): Record<string, unknown> {
  return {
    configured: ctx.douyin.configured,
    authorized: Boolean(token),
    redirectUri: effectiveRedirectUri(ctx.config),
    scope: ctx.config.douyin.scope,
    token: token
      ? {
          openId: token.openId,
          nickname: token.nickname,
          avatar: token.avatar,
          scope: token.scope,
          expiresAt: token.expiresAt,
          expired: Date.parse(token.expiresAt) <= Date.now(),
        }
      : null,
  };
}

async function handlePublish(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  jobId: string,
): Promise<void> {
  const record = ctx.jobs.get(jobId);
  if (!record) throw new AppError("任务不存在", { code: "JOB_NOT_FOUND", status: 404 });
  if (record.state !== "succeeded" || !record.result) {
    throw new AppError("成片尚未生成，无法发布", { code: "JOB_NOT_READY", status: 409 });
  }
  const body = await readJsonBody(req);
  const text = typeof body.text === "string" && body.text.trim() ? body.text.trim() : record.topic;
  const coverTsp = optionalNumber(body, "coverTsp", "封面时间戳");
  if (coverTsp !== undefined && (coverTsp < 0 || coverTsp > record.result.durationSec * 1000)) {
    throw new AppError("封面时间戳超出成片时长", { code: "INVALID_OPTIONS", status: 400 });
  }
  let token = await ctx.tokens.read();
  if (!token) {
    throw new AppError("请先完成抖音授权", { code: "DOUYIN_NOT_AUTHORIZED", status: 401 });
  }
  token = await ctx.douyin.ensureFresh(token);
  await ctx.tokens.write(token);
  const result = await ctx.douyin.publish(
    token,
    { id: record.id, topic: record.topic, videoPath: record.result.videoPath },
    { text, coverTsp },
  );
  await ctx.publishes.add(result.record);
  sendJson(res, 201, { publish: result.record });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  ctx.logger.debug(`${method} ${pathname}`);

  if (pathname === "/healthz" && method === "GET") {
    sendJson(res, 200, { ok: true, version: API_VERSION });
    return;
  }

  if ((pathname === "/" || pathname === "/index.html") && (method === "GET" || method === "HEAD")) {
    const index = path.join(ctx.webDir, "index.html");
    if (fs.existsSync(index)) {
      await serveFile(req, res, index, CONTENT_TYPES[".html"]!);
      return;
    }
  }

  if (pathname === "/api" && method === "GET") {
    sendJson(res, 200, apiIndex(ctx.config));
    return;
  }

  if (pathname === "/api/auth/session" && method === "GET") {
    await handleAuthSession(req, res, ctx);
    return;
  }

  if (pathname === "/api/auth/setup" && method === "POST") {
    await handleSetup(req, res, ctx);
    return;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    await handleLogin(req, res, ctx);
    return;
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    await handleLogout(req, res, ctx);
    return;
  }

  if ((method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
    const ext = path.extname(pathname).toLowerCase();
    if (ext && CONTENT_TYPES[ext]) {
      const file = path.join(ctx.webDir, pathname.replace(/^\/+/, ""));
      if (!isInside(ctx.webDir, file)) {
        throw new AppError("文件不存在", { code: "FILE_NOT_FOUND", status: 404 });
      }
      await serveFile(req, res, file, CONTENT_TYPES[ext]!);
      return;
    }
  }

  const actor = await resolveSessionUser(ctx, req);
  if (pathname.startsWith("/api/") && !isPublicApi(pathname)) {
    if (!actor) {
      throw new AppError("请先登录", { code: "AUTH_REQUIRED", status: 401 });
    }
    const required = requiredPermission(method, pathname);
    if (required === "admin" && actor.role !== "admin") {
      throw new AppError("需要管理员权限", { code: "FORBIDDEN", status: 403 });
    }
    if (required && required !== "admin" && !hasMenuPermission(actor, required)) {
      throw new AppError(`没有访问${MENU_PERMISSIONS.includes(required) ? "该模块" : "该资源"}的权限`, {
        code: "FORBIDDEN",
        status: 403,
      });
    }
  }

  if (pathname === "/api/users" && method === "GET") {
    sendJson(res, 200, { users: await ctx.users.list() });
    return;
  }

  if (pathname === "/api/users" && method === "POST") {
    await handleCreateUser(req, res, ctx);
    return;
  }

  const userMatch = /^\/api\/users\/([a-zA-Z0-9]+)$/.exec(pathname);
  if (userMatch && method === "PATCH") {
    await handleUpdateUser(req, res, ctx, userMatch[1]!, actor!);
    return;
  }
  if (userMatch && method === "DELETE") {
    await handleDeleteUser(req, res, ctx, userMatch[1]!, actor!);
    return;
  }

  if (pathname === "/api/settings" && method === "GET") {
    sendJson(res, 200, { settings: await ctx.settings.view() });
    return;
  }

  if (pathname === "/api/settings" && method === "PUT") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { settings: await ctx.settings.update(body) });
    return;
  }

  if (pathname === "/api/settings/test" && method === "POST") {
    await handleSettingsTest(req, res, ctx);
    return;
  }

  const settingsTestVideo = /^\/api\/settings\/test\/video\/([a-zA-Z0-9_-]+\.mp4)$/.exec(pathname);
  if (settingsTestVideo && method === "GET") {
    const dir = path.join(ctx.config.cacheDir, "settings-test");
    const file = path.join(dir, settingsTestVideo[1]!);
    if (!isInside(dir, file) || !fs.existsSync(file)) {
      throw new AppError("测试视频不存在或已过期", { code: "TEST_VIDEO_NOT_FOUND", status: 404 });
    }
    await serveFile(req, res, file, "video/mp4");
    return;
  }


  if (pathname === "/api/cast" && method === "GET") {
    const assets = await ctx.cast.list();
    sendJson(res, 200, { cast: assets.map(castView) });
    return;
  }

  if (pathname === "/api/cast" && method === "POST") {
    await handleCastUpload(req, res, ctx);
    return;
  }

  if (pathname === "/api/tts/voices" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const config = structuredClone(ctx.config);
    const provider = url.searchParams.get("provider");
    const model = url.searchParams.get("model");
    if (provider && TTS_PROVIDER_NAMES.includes(provider as TtsProviderName)) {
      config.tts.provider = provider as TtsProviderName;
    }
    if (model !== null) config.tts.model = model;
    sendJson(res, 200, { catalog: await voiceCatalog(config.tts, ctx.logger) });
    return;
  }

  if (pathname === "/api/cast/voice-preview" && method === "POST") {
    await handleCastVoicePreview(req, res, ctx);
    return;
  }

  const castImage = /^\/api\/cast\/([a-zA-Z0-9]+)\/image$/.exec(pathname);
  if (castImage) {
    const asset = await ctx.cast.find(castImage[1]!);
    if (!asset) throw new AppError("角色/道具不存在", { code: "CAST_NOT_FOUND", status: 404 });
    if (method === "POST") {
      await handleCastUpload(req, res, ctx, asset.id);
      return;
    }
    if (method === "GET") {
      if (!asset.imageFile) throw new AppError("该角色/道具还没有参考图", { code: "CAST_IMAGE_MISSING", status: 404 });
      const file = path.join(ctx.cast.dir, asset.imageFile);
      if (!isInside(ctx.cast.dir, file)) {
        throw new AppError("角色/道具不存在", { code: "CAST_NOT_FOUND", status: 404 });
      }
      await serveFile(req, res, file, contentTypeFor(file));
      return;
    }
  }

  const castItem = /^\/api\/cast\/([a-zA-Z0-9]+)$/.exec(pathname);
  if (castItem) {
    if (method === "PATCH") {
      await handleCastUpdate(req, res, ctx, castItem[1]!);
      return;
    }
    if (method === "DELETE") {
      const removed = await ctx.cast.remove(castItem[1]!);
      if (!removed) throw new AppError("角色/道具不存在", { code: "CAST_NOT_FOUND", status: 404 });
      sendJson(res, 200, { ok: true });
      return;
    }
  }


  if (pathname === "/api/materials" && method === "GET") {
    const materials = await ctx.library.list();
    sendJson(res, 200, {
      materials: materials.map((material) => ({
        ...material,
        url: `/api/materials/${material.id}/file`,
      })),
    });
    return;
  }

  if (pathname === "/api/materials" && method === "POST") {
    await handleUpload(req, res, ctx.config, ctx.library);
    return;
  }

  const materialFile = /^\/api\/materials\/([a-zA-Z0-9]+)\/file$/.exec(pathname);
  if (materialFile && method === "GET") {
    const materials = await ctx.library.list();
    const material = materials.find((item) => item.id === materialFile[1]);
    if (!material) throw new AppError("素材不存在", { code: "MATERIAL_NOT_FOUND", status: 404 });
    const file = path.join(ctx.library.dir, material.file);
    if (!isInside(ctx.library.dir, file)) {
      throw new AppError("素材不存在", { code: "MATERIAL_NOT_FOUND", status: 404 });
    }
    await serveFile(req, res, file, contentTypeFor(file));
    return;
  }

  const materialDelete = /^\/api\/materials\/([a-zA-Z0-9]+)$/.exec(pathname);
  if (materialDelete && method === "DELETE") {
    const removed = await ctx.library.remove(materialDelete[1]!);
    if (!removed) throw new AppError("素材不存在", { code: "MATERIAL_NOT_FOUND", status: 404 });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/scripts/generate" && method === "POST") {
    await handleGenerateScript(req, res, ctx);
    return;
  }

  if (pathname === "/api/videos" && method === "GET") {
    sendJson(res, 200, { jobs: ctx.jobs.list().map((job) => ctx.jobs.serialize(job)) });
    return;
  }

  if (pathname === "/api/videos" && method === "POST") {
    const body = await readJsonBody(req);
    const topic = requireTopic(body.topic);
    const options = parseJobOptions(body);
    // 先验证这次任务实际会用的配置与角色参考图，再入队，避免扣费后才报错。
    const jobConfig = buildJobConfig(ctx.config, options);
    const selectedCast = selectCastAssets(await ctx.cast.list(), options.castIds);
    await preflightVideoJob({
      config: jobConfig,
      topic,
      story: options.story,
      options: {
        ...options,
        videoGenEnabled: options.videoGenEnabled === false ? false : isAiVideoEnabled(jobConfig.videoGen),
      },
      castAssets: selectedCast,
      logger: ctx.logger,
    });
    const record = ctx.jobs.create(topic, options);
    res.writeHead(202, {
      ...securityHeaders(),
      "content-type": "application/json; charset=utf-8",
      location: `/api/videos/${record.id}`,
      "cache-control": "no-store",
    });
    res.end(`${JSON.stringify(ctx.jobs.serialize(record), null, 2)}\n`);
    return;
  }

  const jobPublish = /^\/api\/videos\/([a-zA-Z0-9-]+)\/publish$/.exec(pathname);
  if (jobPublish && method === "POST") {
    await handlePublish(req, res, ctx, jobPublish[1]!);
    return;
  }
  if (jobPublish && method === "GET") {
    const publishes = await ctx.publishes.list();
    sendJson(res, 200, { publishes: publishes.filter((item) => item.jobId === jobPublish[1]) });
    return;
  }

  const jobMatch = /^\/api\/videos\/([a-zA-Z0-9-]+)(?:\/(video|poster|subtitles|script|result))?$/.exec(pathname);
  if (jobMatch) {
    const [, id, resource] = jobMatch;
    const record = ctx.jobs.get(id!);
    if (!record) throw new AppError("任务不存在", { code: "JOB_NOT_FOUND", status: 404 });

    if (!resource && method === "GET") {
      sendJson(res, 200, ctx.jobs.serialize(record, true));
      return;
    }

    if (resource && method === "GET") {
      if (record.state !== "succeeded" || !record.result) {
        throw new AppError("成片尚未生成", { code: "JOB_NOT_READY", status: 409 });
      }
      const jobDir = path.join(ctx.config.outputDir, record.id);
      const files: Record<string, { file: string; type: string }> = {
        video: { file: record.result.videoPath, type: "video/mp4" },
        ...(record.result.posterPath
          ? { poster: { file: record.result.posterPath, type: "image/jpeg" } }
          : {}),
        subtitles: { file: record.result.srtPath, type: "text/plain; charset=utf-8" },
        script: { file: record.result.scriptPath, type: "application/json; charset=utf-8" },
        result: { file: record.result.resultPath, type: "application/json; charset=utf-8" },
      };
      const target = files[resource];
      if (!target || !isInside(jobDir, target.file)) {
        throw new AppError("文件不存在", { code: "FILE_NOT_FOUND", status: 404 });
      }
      if (resource === "video" || resource === "poster") {
        await serveFile(req, res, target.file, target.type);
      } else {
        const text = await fsp.readFile(target.file, "utf8");
        sendText(res, 200, text, target.type);
      }
      return;
    }
  }

  if (pathname === "/api/publishes" && method === "GET") {
    sendJson(res, 200, { publishes: await ctx.publishes.list() });
    return;
  }

  if (pathname === "/api/douyin/status" && method === "GET") {
    sendJson(res, 200, douyinStatus(ctx, await ctx.tokens.read()));
    return;
  }

  if (pathname === "/api/douyin/authorize" && method === "GET") {
    if (!ctx.douyin.configured) {
      throw new AppError("请先在设置中填写抖音开放平台 client_key 与 client_secret", {
        code: "DOUYIN_NOT_CONFIGURED",
        status: 400,
      });
    }
    const now = Date.now();
    for (const [key, expiresAt] of ctx.pendingStates) {
      if (expiresAt <= now) ctx.pendingStates.delete(key);
    }
    const state = randomBytes(16).toString("hex");
    ctx.pendingStates.set(state, now + 10 * 60 * 1000);
    sendJson(res, 200, { url: ctx.douyin.authorizeUrl(state), redirectUri: ctx.douyin.redirectUri });
    return;
  }

  if (pathname === "/api/douyin/callback" && method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    try {
      const expiresAt = state ? ctx.pendingStates.get(state) : undefined;
      if (!code || !state || !expiresAt || expiresAt <= Date.now()) {
        throw new AppError("授权状态已失效，请重新发起授权", {
          code: "DOUYIN_INVALID_STATE",
          status: 400,
        });
      }
      ctx.pendingStates.delete(state);
      const token = await ctx.douyin.exchangeCode(code);
      try {
        const info = await ctx.douyin.fetchUserInfo(token);
        token.nickname = info.nickname;
        token.avatar = info.avatar;
      } catch (error) {
        ctx.logger.warn(`抖音用户信息获取失败：${toErrorMessage(error)}`);
      }
      await ctx.tokens.write(token);
      res.writeHead(302, { ...securityHeaders(), location: "/?douyin=connected#/settings" });
      res.end();
    } catch (error) {
      ctx.logger.warn(`抖音授权失败：${toErrorMessage(error)}`);
      const message = encodeURIComponent(toErrorMessage(error));
      res.writeHead(302, {
        ...securityHeaders(),
        location: `/?douyin=error&message=${message}#/settings`,
      });
      res.end();
    }
    return;
  }

  if (pathname === "/api/douyin/disconnect" && method === "POST") {
    await ctx.tokens.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/douyin/refresh" && method === "POST") {
    const token = await ctx.tokens.read();
    if (!token) {
      throw new AppError("尚未授权抖音", { code: "DOUYIN_NOT_AUTHORIZED", status: 401 });
    }
    const refreshed = await ctx.douyin.refresh(token);
    await ctx.tokens.write(refreshed);
    sendJson(res, 200, douyinStatus(ctx, refreshed));
    return;
  }

  throw new AppError("接口不存在", { code: "NOT_FOUND", status: 404 });
}

export function createVideoServer(config: AppConfig, logger: Logger, deps: ServerDeps = {}): VideoServer {
  const settings = new SettingsStore(config, {
    settingsPath: config.settingsFile,
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    logger,
  });
  const jobs = new JobManager(config, logger);
  const library = new MaterialLibrary(config.libraryDir, logger);
  const cast = new CastLibrary(config.castDir, logger);
  const users = new UserStore(path.join(path.dirname(config.settingsFile), "users.json"), logger);
  const sessions = new SessionStore();
  const loginThrottle = new LoginThrottle();
  const douyin = new DouyinClient(config, logger, deps.fetchImpl ?? fetch);
  const tokens = new DouyinTokenStore(path.join(config.cacheDir, "douyin-token.json"), logger);
  const publishes = new PublishStore(path.join(path.dirname(config.settingsFile), "publishes.json"), logger);
  const webDir = deps.webDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  const ctx: ServerContext = {
    config,
    logger,
    jobs,
    library,
    cast,
    settings,
    users,
    sessions,
    loginThrottle,
    douyin,
    tokens,
    publishes,
    webDir,
    pendingStates: new Map(),
  };
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, ctx).catch((error: unknown) => {
      const status = error instanceof AppError ? error.status : 500;
      const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
      if (!(error instanceof AppError)) logger.error("请求处理失败", error);
      if (!res.headersSent) {
        sendJson(res, status, { error: { code, message: toErrorMessage(error) } });
      } else {
        res.end();
      }
    });
  });
  return {
    server,
    jobs,
    library,
    cast,
    settings,
    users,
    sessions,
    douyin,
    tokens,
    publishes,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export async function startServer(
  config: AppConfig,
  logger: Logger,
  deps: ServerDeps = {},
): Promise<StartedServer> {
  const app = createVideoServer(config, logger, deps);
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.server.port, config.server.host, () => resolve());
  });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.server.port;
  // 端口为 0 时使用实际监听端口，保证抖音回调地址正确。
  config.server.port = port;
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return {
    ...app,
    port,
    url: `http://${host}:${port}`,
  };
}

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { AppConfig } from "../types.js";
import type { Logger } from "../logger.js";
import { AppError, toErrorMessage } from "../errors.js";
import { MaterialLibrary, materialType } from "../materials/library.js";
import { isInside, sanitizeFilename } from "../util/fs.js";
import { JobManager } from "./jobs.js";

const API_VERSION = "0.1.0";
const JSON_BODY_LIMIT = 1024 * 1024;

export interface VideoServer {
  server: http.Server;
  jobs: JobManager;
  library: MaterialLibrary;
  close(): Promise<void>;
}

export interface StartedServer extends VideoServer {
  port: number;
  url: string;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, text: string, contentType: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
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
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
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
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
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

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  library: MaterialLibrary,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new AppError("素材上传需要 multipart/form-data", {
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
      if (!materialType(filename)) {
        fileError = new AppError(
          `不支持的素材格式：${path.extname(filename) || "未知"}（支持 mp4/mov/webm/mkv 与 jpg/png/webp）`,
          { code: "MATERIAL_UNSUPPORTED", status: 415 },
        );
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
      throw new AppError(`素材超过上传上限 ${config.server.maxUploadBytes} 字节`, {
        code: "FILE_TOO_LARGE",
        status: 413,
      });
    }
    if (!tempFile) {
      throw new AppError("缺少 file 字段", { code: "MISSING_FILE", status: 400 });
    }

    const tags = (fields.tags ?? "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const material = await library.add(tempFile, {
      tags,
      title: fields.title?.trim() || originalName.replace(/\.[^.]+$/, ""),
    });
    sendJson(res, 201, { material });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AppConfig,
  logger: Logger,
  jobs: JobManager,
  library: MaterialLibrary,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  logger.debug(`${method} ${pathname}`);

  if (pathname === "/healthz" && method === "GET") {
    sendJson(res, 200, { ok: true, version: API_VERSION });
    return;
  }

  if (pathname === "/" && method === "GET") {
    sendJson(res, 200, {
      name: "video-agent",
      version: API_VERSION,
      description: "视频创作智能体 MVP：主题 → 脚本 → 素材 → 配音 → 剪辑",
      endpoints: {
        createVideo: "POST /api/videos {topic}",
        listVideos: "GET /api/videos",
        videoStatus: "GET /api/videos/:id",
        videoFile: "GET /api/videos/:id/video",
        subtitles: "GET /api/videos/:id/subtitles",
        listMaterials: "GET /api/materials",
        uploadMaterial: "POST /api/materials (multipart: file, tags?, title?)",
        deleteMaterial: "DELETE /api/materials/:id",
      },
    });
    return;
  }

  if (pathname === "/api/materials" && method === "GET") {
    sendJson(res, 200, { materials: await library.list() });
    return;
  }

  if (pathname === "/api/materials" && method === "POST") {
    await handleUpload(req, res, config, library);
    return;
  }

  const materialDelete = /^\/api\/materials\/([a-zA-Z0-9]+)$/.exec(pathname);
  if (materialDelete && method === "DELETE") {
    const removed = await library.remove(materialDelete[1]!);
    if (!removed) throw new AppError("素材不存在", { code: "MATERIAL_NOT_FOUND", status: 404 });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/videos" && method === "GET") {
    sendJson(res, 200, { jobs: jobs.list().map((job) => jobs.serialize(job)) });
    return;
  }

  if (pathname === "/api/videos" && method === "POST") {
    const body = await readJsonBody(req);
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) throw new AppError("topic 不能为空", { code: "INVALID_TOPIC", status: 400 });
    if (topic.length > 200) throw new AppError("topic 不能超过 200 个字符", { code: "INVALID_TOPIC", status: 400 });
    const record = jobs.create(topic);
    res.writeHead(202, {
      "content-type": "application/json; charset=utf-8",
      location: `/api/videos/${record.id}`,
      "cache-control": "no-store",
    });
    res.end(`${JSON.stringify(jobs.serialize(record), null, 2)}\n`);
    return;
  }

  const jobMatch = /^\/api\/videos\/([a-zA-Z0-9-]+)(?:\/(video|subtitles|script|result))?$/.exec(pathname);
  if (jobMatch) {
    const [, id, resource] = jobMatch;
    const record = jobs.get(id!);
    if (!record) throw new AppError("任务不存在", { code: "JOB_NOT_FOUND", status: 404 });

    if (!resource && method === "GET") {
      sendJson(res, 200, jobs.serialize(record));
      return;
    }

    if (resource && method === "GET") {
      if (record.state !== "succeeded" || !record.result) {
        throw new AppError("成片尚未生成", { code: "JOB_NOT_READY", status: 409 });
      }
      const jobDir = path.join(config.outputDir, record.id);
      const files: Record<string, { file: string; type: string }> = {
        video: { file: record.result.videoPath, type: "video/mp4" },
        subtitles: { file: record.result.srtPath, type: "text/plain; charset=utf-8" },
        script: { file: record.result.scriptPath, type: "application/json; charset=utf-8" },
        result: { file: record.result.resultPath, type: "application/json; charset=utf-8" },
      };
      const target = files[resource];
      if (!target || !isInside(jobDir, target.file)) {
        throw new AppError("文件不存在", { code: "FILE_NOT_FOUND", status: 404 });
      }
      if (resource === "video") {
        await serveFile(req, res, target.file, target.type);
      } else {
        const text = await fsp.readFile(target.file, "utf8");
        sendText(res, 200, text, target.type);
      }
      return;
    }
  }

  throw new AppError("接口不存在", { code: "NOT_FOUND", status: 404 });
}

export function createVideoServer(config: AppConfig, logger: Logger): VideoServer {
  const jobs = new JobManager(config, logger);
  const library = new MaterialLibrary(config.libraryDir, logger);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, config, logger, jobs, library).catch((error: unknown) => {
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export async function startServer(config: AppConfig, logger: Logger): Promise<StartedServer> {
  const app = createVideoServer(config, logger);
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.server.port, config.server.host, () => resolve());
  });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.server.port;
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return {
    ...app,
    port,
    url: `http://${host}:${port}`,
  };
}
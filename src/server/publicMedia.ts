import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Logger } from "../logger.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const PUBLIC_URL_TTL_MS = 24 * 60 * 60 * 1000;

export interface PublicMediaHostOptions {
  /** 允许公开的扩展名，默认角色图。 */
  extensions?: ReadonlySet<string>;
  /** 公开路由前缀，默认 /api/public/media/。 */
  publicPath?: string;
}

/**
 * 取任务创建请求里的对外地址，用于生成平台可访问的图片链接。
 * 只接受公网域名/公网 IP；本机、局域网和 .local 地址一律不生成链接，
 * 让流水线回退成纯文字，而不是给平台一个它永远访问不到的地址。
 */
export function publicBaseUrlFromRequest(req: http.IncomingMessage): string | undefined {
  const host = req.headers.host?.trim();
  if (!host || !isPublicHost(host)) return undefined;
  const forwarded = req.headers["x-forwarded-proto"];
  const candidate = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  const scheme =
    candidate === "https" || candidate === "http"
      ? candidate
      : (req.socket as { encrypted?: boolean }).encrypted
        ? "https"
        : "http";
  return `${scheme}://${host}`;
}

export function isPublicHost(host: string): boolean {
  const parsed = splitHost(host);
  if (!parsed) return false;
  const hostname = parsed.hostname;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = hostname.split(".").map(Number);
    if (
      a === undefined ||
      b === undefined ||
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return false;
    }
    return true;
  }
  if (ipVersion === 6) {
    if (hostname === "::" || hostname === "::1" || /^f[cd]/i.test(hostname) || /^fe[89ab]/i.test(hostname)) {
      return false;
    }
    return !hostname.startsWith("::ffff:");
  }
  return hostname.includes(".");
}

function splitHost(host: string): { hostname: string; port?: string } | undefined {
  if (host.startsWith("[")) {
    const match = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(host);
    if (!match) return undefined;
    return { hostname: match[1]!.toLowerCase(), port: match[2] };
  }
  const match = /^([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
  if (!match) return undefined;
  return { hostname: match[1]!.toLowerCase(), port: match[2] };
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 把角色库里的本地图片变成平台可访问的临时公网链接。
 *
 * One API Lumi 等视频平台要求参考图是公网 HTTP(S) URL，不接受本地文件或
 * data URL。控制台本身通过公网地址访问时，这里用带密钥的签名链接把图片
 * 暴露出去：链接只对角色库目录内的 jpg/png/webp 生效，默认 24 小时过期，
 * 校验失败一律 404，不能枚举目录。
 */
export class PublicMediaHost {
  private readonly root: string;
  private readonly secret: Buffer;
  private readonly extensions: ReadonlySet<string>;
  private readonly publicPath: string;

  constructor(castDir: string, secretFile: string, logger?: Logger, options: PublicMediaHostOptions = {}) {
    this.root = path.resolve(castDir);
    this.secret = loadOrCreateSecret(secretFile, logger);
    this.extensions = options.extensions ?? IMAGE_EXTENSIONS;
    this.publicPath = options.publicPath ?? "/api/public/media/";
  }

  /** 生成签名链接；文件不在公开目录内时返回 undefined。 */
  url(baseUrl: string, file: string): string | undefined {
    const relative = this.relativeOf(file);
    if (!relative) return undefined;
    const expires = Date.now() + PUBLIC_URL_TTL_MS;
    const token = this.token(relative, expires);
    const encoded = relative.split("/").map((part) => encodeURIComponent(part)).join("/");
    return `${baseUrl.replace(/\/+$/, "")}${this.publicPath}${encoded}?expires=${expires}&token=${token}`;
  }

  /** 校验签名并返回本地文件；过期、签名不符或路径不合法时返回 undefined。 */
  resolve(relativePath: string, expires: number, token: string): string | undefined {
    if (!Number.isInteger(expires) || expires < Date.now()) return undefined;
    const relative = relativePath.replace(/^\/+/, "");
    if (!relative || relative.split("/").some((part) => !part || part === ".." || part === ".")) {
      return undefined;
    }
    if (!this.extensions.has(path.extname(relative).toLowerCase())) return undefined;
    const expected = this.token(relative, expires);
    if (
      expected.length !== token.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    ) {
      return undefined;
    }
    const file = path.resolve(this.root, relative);
    if (!isInside(this.root, file)) return undefined;
    return file;
  }

  private relativeOf(file: string): string | undefined {
    const resolved = path.resolve(file);
    if (!isInside(this.root, resolved)) return undefined;
    const relative = path.relative(this.root, resolved).split(path.sep).join("/");
    if (!this.extensions.has(path.extname(relative).toLowerCase())) return undefined;
    return relative;
  }

  private token(relative: string, expires: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`${relative}\n${expires}`)
      .digest("base64url");
  }
}

/** 密钥落盘，避免服务重启后正在生成的任务拿到的图片链接全部失效。 */
function loadOrCreateSecret(file: string, logger?: Logger): Buffer {
  try {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, "utf8").trim();
      if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
    }
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
    return secret;
  } catch (error) {
    logger?.warn(`公网图片签名密钥读写失败，改用进程内临时密钥：${(error as Error).message}`);
    return crypto.randomBytes(32);
  }
}
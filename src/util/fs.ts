import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** 去掉路径分隔符、控制字符等，避免素材上传时穿越目录。 */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name).normalize("NFKC");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 120) || "file";
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function fileSize(file: string): Promise<number> {
  const stat = await fs.stat(file);
  return stat.size;
}
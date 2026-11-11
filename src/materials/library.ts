import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Material, MaterialType } from "../types.js";
import { ensureDir, isInside, pathExists, readJsonFile, sanitizeFilename, shortId, writeJsonFile } from "../util/fs.js";
import { normalizeTagList, tagsFromFilename } from "../util/text.js";
import { probeMedia } from "../media/ffmpeg.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpeg", ".mpg"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);

export function materialType(filename: string): MaterialType | null {
  const ext = path.extname(filename).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

interface MaterialIndexFile {
  version: 1;
  materials: Material[];
}

export interface AddMaterialOptions {
  tags?: string[];
  title?: string;
  /** 用于提取标签的原始文件名；上传时避免把随机后缀当成标签。 */
  sourceName?: string;
}

export class MaterialLibrary {
  readonly dir: string;
  private readonly indexPath: string;
  private readonly logger: Logger;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, logger: Logger) {
    this.dir = path.resolve(dir);
    this.indexPath = path.join(this.dir, ".materials.json");
    this.logger = logger;
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async list(): Promise<Material[]> {
    return this.withLock(async () => {
      const materials = await this.scanInternal();
      return materials;
    });
  }

  async add(filePath: string, options: AddMaterialOptions = {}): Promise<Material> {
    return this.withLock(async () => {
      await this.scanInternal();
      return this.addInternal(filePath, options);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const materials = await this.scanInternal();
      const target = materials.find((material) => material.id === id);
      if (!target) return false;
      const remaining = materials.filter((material) => material.id !== id);
      await fs.rm(path.join(this.dir, target.file), { force: true });
      await this.persist(remaining);
      return true;
    });
  }

  async tags(): Promise<string[]> {
    const materials = await this.list();
    const tags = new Set<string>();
    for (const material of materials) {
      for (const tag of material.tags) tags.add(tag);
    }
    return [...tags].slice(0, 100);
  }

  private async loadIndex(): Promise<Material[]> {
    if (!(await pathExists(this.indexPath))) return [];
    try {
      const parsed = await readJsonFile<MaterialIndexFile | Material[]>(this.indexPath);
      const materials = Array.isArray(parsed) ? parsed : parsed.materials;
      if (!Array.isArray(materials)) return [];
      return materials.filter(
        (material): material is Material =>
          typeof material?.id === "string" &&
          typeof material?.file === "string" &&
          (material?.type === "video" || material?.type === "image") &&
          isInside(this.dir, path.join(this.dir, material.file)),
      );
    } catch (error) {
      this.logger.warn(`素材索引损坏，将重建：${String(error)}`);
      return [];
    }
  }

  private async persist(materials: Material[]): Promise<void> {
    const sorted = [...materials].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    await writeJsonFile(this.indexPath, { version: 1, materials: sorted } satisfies MaterialIndexFile);
  }

  private async scanInternal(): Promise<Material[]> {
    await ensureDir(this.dir);
    const indexed = await this.loadIndex();
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    const fileSet = new Set(files);

    const kept = indexed.filter((material) => fileSet.has(material.file));
    const known = new Set(kept.map((material) => material.file));
    const added: Material[] = [];

    for (const filename of files) {
      if (known.has(filename)) continue;
      const type = materialType(filename);
      if (!type) continue;
      try {
        // 目标文件名带有 6 位随机后缀；重新扫描时不要把它当成标签。
        const tagSource = filename.replace(/-[0-9a-f]{6}(-\d+)?(\.[^.]+)$/i, "$2$3");
        const material = await this.describe(filename, path.join(this.dir, filename), type, {
          tags: tagsFromFilename(tagSource),
          sourceName: tagSource,
          title: filename
            .replace(/\.[^.]+$/, "")
            .replace(/-[0-9a-f]{6}(-\d+)?$/i, "")
            .replace(/[-_]+/g, " ")
            .trim(),
        });
        added.push(material);
      } catch (error) {
        this.logger.warn(`素材探测失败，已跳过 ${filename}：${String(error)}`);
      }
    }

    const all = [...kept, ...added];
    if (added.length > 0 || kept.length !== indexed.length) {
      await this.persist(all);
    }
    return all;
  }

  private async describe(
    filename: string,
    absolutePath: string,
    type: MaterialType,
    options: AddMaterialOptions,
  ): Promise<Material> {
    const probe = await probeMedia(absolutePath);
    if (!probe.width || !probe.height) {
      throw new AppError(`无法读取素材尺寸：${filename}`, { code: "MATERIAL_INVALID" });
    }
    if (type === "video" && (!probe.durationSec || probe.durationSec <= 0)) {
      throw new AppError(`无法读取视频时长：${filename}`, { code: "MATERIAL_INVALID" });
    }
    const stat = await fs.stat(absolutePath);
    const tags = normalizeTagList([
      ...(options.tags ?? []),
      ...tagsFromFilename(options.sourceName ?? filename),
    ]);
    return {
      id: shortId(),
      file: filename,
      type,
      title: (options.title ?? filename.replace(/\.[^.]+$/, "")).trim().slice(0, 80),
      tags,
      durationSec: probe.durationSec ? Number(probe.durationSec.toFixed(3)) : undefined,
      width: probe.width,
      height: probe.height,
      sizeBytes: stat.size,
      addedAt: new Date().toISOString(),
    };
  }

  private async addInternal(filePath: string, options: AddMaterialOptions): Promise<Material> {
    const source = path.resolve(filePath);
    if (!(await pathExists(source))) {
      throw new AppError(`素材文件不存在：${source}`, { code: "MATERIAL_NOT_FOUND", status: 404 });
    }
    const type = materialType(source);
    if (!type) {
      throw new AppError(
        `不支持的素材格式：${path.extname(source) || "未知"}（支持 mp4/mov/webm/mkv 与 jpg/png/webp）`,
        { code: "MATERIAL_UNSUPPORTED", status: 415 },
      );
    }

    const base = sanitizeFilename(path.basename(source));
    const ext = path.extname(base).toLowerCase();
    const stem = base.slice(0, -ext.length) || "material";
    let targetName = `${stem}-${shortId().slice(0, 6)}${ext}`;
    let target = path.join(this.dir, targetName);
    let attempt = 0;
    while (await pathExists(target)) {
      attempt += 1;
      targetName = `${stem}-${shortId().slice(0, 6)}-${attempt}${ext}`;
      target = path.join(this.dir, targetName);
    }

    await ensureDir(this.dir);
    await fs.copyFile(source, target);
    try {
      const material = await this.describe(targetName, target, type, {
        tags: options.tags,
        title: options.title ?? stem,
        sourceName: path.basename(source),
      });
      const materials = await this.loadIndex();
      await this.persist([...materials.filter((item) => item.file !== targetName), material]);
      return material;
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
  }
}
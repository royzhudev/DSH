import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { CastAsset, CastKind } from "../types.js";
import {
  ensureDir,
  isInside,
  pathExists,
  readJsonFile,
  sanitizeFilename,
  shortId,
  writeJsonFile,
} from "../util/fs.js";
import { probeMedia } from "../media/ffmpeg.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const NAME_MAX_LENGTH = 40;
const DESCRIPTION_MAX_LENGTH = 500;

interface CastIndexFile {
  version: 1;
  cast: CastAsset[];
}

export interface AddCastOptions {
  kind: CastKind;
  name: string;
  description?: string;
  /** 参考图；省略时只保存文字设定。 */
  imagePath?: string | null;
  /** 对话模式下的配音音色（Edge voice id）。 */
  voice?: string;
}

export interface UpdateCastOptions {
  kind?: CastKind;
  name?: string;
  description?: string;
  voice?: string;
}

const VOICE_MAX_LENGTH = 60;

export function parseCastVoice(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new AppError("配音音色必须是文本", { code: "CAST_INVALID", status: 400 });
  }
  const voice = value.trim();
  if (voice.length > VOICE_MAX_LENGTH) {
    throw new AppError(`配音音色不能超过 ${VOICE_MAX_LENGTH} 个字符`, {
      code: "CAST_INVALID",
      status: 400,
    });
  }
  return voice;
}

export function castImageType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

export function parseCastKind(value: unknown): CastKind {
  if (value === "character" || value === "prop") return value;
  throw new AppError("kind 只能是 character（角色）或 prop（道具）", {
    code: "CAST_INVALID",
    status: 400,
  });
}

export function parseCastName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new AppError("角色/道具名称不能为空", { code: "CAST_INVALID", status: 400 });
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new AppError(`角色/道具名称不能超过 ${NAME_MAX_LENGTH} 个字符`, {
      code: "CAST_INVALID",
      status: 400,
    });
  }
  return name;
}

export function parseCastDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new AppError("外观设定必须是文本", { code: "CAST_INVALID", status: 400 });
  }
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new AppError(`外观设定不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符`, {
      code: "CAST_INVALID",
      status: 400,
    });
  }
  return description;
}

function filePrefix(kind: CastKind): string {
  return kind === "character" ? "char" : "prop";
}

function kindFromPrefix(filename: string): CastKind {
  return /^prop[-_]/i.test(filename) ? "prop" : "character";
}

function nameFromFilename(filename: string): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/^char[-_]?/i, "")
    .replace(/^prop[-_]?/i, "")
    .replace(/-[0-9a-f]{6}(-\d+)?$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return (stem || "未命名").slice(0, NAME_MAX_LENGTH);
}

/**
 * 角色/道具库：保存短剧的人物与物品设定和参考图。
 * 设定会写进每个分镜的提示词，参考图会作为图生视频的输入，
 * 从而让同一人物、同一道具在后续镜头里保持一致。
 */
export class CastLibrary {
  readonly dir: string;
  private readonly indexPath: string;
  private readonly logger: Logger;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, logger: Logger) {
    this.dir = path.resolve(dir);
    this.indexPath = path.join(this.dir, ".cast.json");
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

  async list(): Promise<CastAsset[]> {
    return this.withLock(() => this.scanInternal());
  }

  async find(id: string): Promise<CastAsset | undefined> {
    const assets = await this.list();
    return assets.find((asset) => asset.id === id);
  }

  async add(options: AddCastOptions): Promise<CastAsset> {
    return this.withLock(async () => {
      const assets = await this.scanInternal();
      const kind = parseCastKind(options.kind);
      const name = parseCastName(options.name);
      const description = parseCastDescription(options.description);
      const voice = parseCastVoice(options.voice);
      this.assertNameAvailable(assets, name);
      const image = options.imagePath
        ? await this.importImage(options.imagePath, kind, name)
        : undefined;
      const now = new Date().toISOString();
      const asset: CastAsset = {
        id: shortId(),
        kind,
        name,
        description,
        ...(voice ? { voice } : {}),
        ...image,
        createdAt: now,
        updatedAt: now,
      };
      await this.persist([...assets, asset]);
      this.logger.info(`已添加${kind === "character" ? "角色" : "道具"}：${name}`);
      return asset;
    });
  }

  async update(id: string, patch: UpdateCastOptions): Promise<CastAsset> {
    return this.withLock(async () => {
      const assets = await this.scanInternal();
      const target = assets.find((asset) => asset.id === id);
      if (!target) throw new AppError("角色/道具不存在", { code: "CAST_NOT_FOUND", status: 404 });
      if (patch.kind !== undefined) target.kind = parseCastKind(patch.kind);
      if (patch.name !== undefined) {
        const name = parseCastName(patch.name);
        this.assertNameAvailable(assets, name, id);
        target.name = name;
      }
      if (patch.description !== undefined) {
        target.description = parseCastDescription(patch.description);
      }
      if (patch.voice !== undefined) {
        const voice = parseCastVoice(patch.voice);
        if (voice) target.voice = voice;
        else delete target.voice;
      }
      target.updatedAt = new Date().toISOString();
      await this.persist(assets);
      return target;
    });
  }

  async setImage(id: string, imagePath: string): Promise<CastAsset> {
    return this.withLock(async () => {
      const assets = await this.scanInternal();
      const target = assets.find((asset) => asset.id === id);
      if (!target) throw new AppError("角色/道具不存在", { code: "CAST_NOT_FOUND", status: 404 });
      const image = await this.importImage(imagePath, target.kind, target.name);
      const previous = target.imageFile;
      Object.assign(target, image, { updatedAt: new Date().toISOString() });
      await this.persist(assets);
      if (previous) await fs.rm(path.join(this.dir, previous), { force: true });
      return target;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const assets = await this.scanInternal();
      const target = assets.find((asset) => asset.id === id);
      if (!target) return false;
      await this.persist(assets.filter((asset) => asset.id !== id));
      if (target.imageFile) {
        await fs.rm(path.join(this.dir, target.imageFile), { force: true });
      }
      this.logger.info(`已删除角色/道具：${target.name}`);
      return true;
    });
  }

  private assertNameAvailable(assets: CastAsset[], name: string, exceptId?: string): void {
    const taken = assets.some(
      (asset) => asset.id !== exceptId && asset.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      throw new AppError(`名称「${name}」已被占用，请换一个名字`, {
        code: "CAST_NAME_TAKEN",
        status: 409,
      });
    }
  }

  private async importImage(
    sourcePath: string,
    kind: CastKind,
    name: string,
  ): Promise<Pick<CastAsset, "imageFile" | "width" | "height" | "sizeBytes">> {
    const source = path.resolve(sourcePath);
    if (!(await pathExists(source))) {
      throw new AppError(`参考图不存在：${source}`, { code: "CAST_IMAGE_INVALID", status: 400 });
    }
    const ext = castImageType(source);
    if (!ext) {
      throw new AppError(
        `参考图只支持 jpg/png/webp，当前为 ${path.extname(source) || "未知格式"}`,
        { code: "CAST_UNSUPPORTED", status: 415 },
      );
    }
    const probe = await probeMedia(source).catch((error: unknown) => {
      throw new AppError(`无法读取参考图：${(error as Error).message}`, {
        code: "CAST_IMAGE_INVALID",
        status: 400,
        cause: error,
      });
    });
    if (!probe.width || !probe.height) {
      throw new AppError("参考图无法读取尺寸", { code: "CAST_IMAGE_INVALID", status: 400 });
    }

    await ensureDir(this.dir);
    const stem = sanitizeFilename(`${filePrefix(kind)}-${name}`).slice(0, 80) || filePrefix(kind);
    let targetName = `${stem}-${shortId().slice(0, 6)}${ext}`;
    let attempt = 0;
    while (await pathExists(path.join(this.dir, targetName))) {
      attempt += 1;
      targetName = `${stem}-${shortId().slice(0, 6)}-${attempt}${ext}`;
    }
    const target = path.join(this.dir, targetName);
    await fs.copyFile(source, target);
    const stat = await fs.stat(target);
    return {
      imageFile: targetName,
      width: probe.width,
      height: probe.height,
      sizeBytes: stat.size,
    };
  }

  private async loadIndex(): Promise<CastAsset[]> {
    if (!(await pathExists(this.indexPath))) return [];
    try {
      const parsed = await readJsonFile<CastIndexFile | CastAsset[]>(this.indexPath);
      const assets = Array.isArray(parsed) ? parsed : parsed.cast;
      if (!Array.isArray(assets)) return [];
      return assets.filter(
        (asset): asset is CastAsset =>
          typeof asset?.id === "string" &&
          typeof asset?.name === "string" &&
          (asset?.kind === "character" || asset?.kind === "prop") &&
          typeof asset?.createdAt === "string" &&
          typeof asset?.updatedAt === "string" &&
          (asset.imageFile === undefined ||
            (typeof asset.imageFile === "string" && isInside(this.dir, path.join(this.dir, asset.imageFile)))),
      );
    } catch (error) {
      this.logger.warn(`角色库索引损坏，将重建：${String(error)}`);
      return [];
    }
  }

  private async persist(assets: CastAsset[]): Promise<void> {
    const sorted = [...assets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeJsonFile(this.indexPath, { version: 1, cast: sorted } satisfies CastIndexFile);
  }

  private async scanInternal(): Promise<CastAsset[]> {
    await ensureDir(this.dir);
    const indexed = await this.loadIndex();
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    const fileSet = new Set(files);

    const kept = indexed.filter(
      (asset) => !asset.imageFile || fileSet.has(asset.imageFile),
    );
    const known = new Set(kept.map((asset) => asset.imageFile).filter(Boolean));
    const added: CastAsset[] = [];

    for (const filename of files) {
      if (known.has(filename) || !castImageType(filename)) continue;
      const kind = kindFromPrefix(filename);
      try {
        const probe = await probeMedia(path.join(this.dir, filename));
        if (!probe.width || !probe.height) continue;
        const stat = await fs.stat(path.join(this.dir, filename));
        const now = new Date().toISOString();
        added.push({
          id: shortId(),
          kind,
          name: nameFromFilename(filename),
          description: "",
          imageFile: filename,
          width: probe.width,
          height: probe.height,
          sizeBytes: stat.size,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        this.logger.warn(`角色参考图探测失败，已跳过 ${filename}：${String(error)}`);
      }
    }

    const all = [...kept, ...added];
    if (added.length > 0 || kept.length !== indexed.length) {
      await this.persist(all);
    }
    return all;
  }
}

/**
 * 按名称解析脚本里声明的出场角色/道具：先精确匹配名称，
 * 再尝试忽略大小写与空白；未识别的名称会被忽略（模型可能写了别称）。
 */
export function resolveCastNames(names: string[] | undefined, assets: CastAsset[]): CastAsset[] {
  if (!names?.length) return [];
  const resolved: CastAsset[] = [];
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const asset =
      assets.find((item) => item.name.toLowerCase() === name) ??
      assets.find(
        (item) =>
          item.name.toLowerCase().includes(name) || name.includes(item.name.toLowerCase()),
      );
    if (asset && !resolved.some((item) => item.id === asset.id)) resolved.push(asset);
  }
  return resolved;
}

/** 选择本片使用的角色/道具：未指定表示全部，指定时校验 id 都存在。 */
export function selectCastAssets(assets: CastAsset[], ids?: string[]): CastAsset[] {
  if (ids === undefined) return assets;
  const selected: CastAsset[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const asset = assets.find((item) => item.id === id);
    if (asset) {
      if (!selected.some((item) => item.id === asset.id)) selected.push(asset);
    } else {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new AppError(`角色/道具不存在：${missing.join("、")}`, {
      code: "CAST_NOT_FOUND",
      status: 400,
    });
  }
  return selected;
}

export function castSummary(
  assets: CastAsset[],
): Array<Pick<CastAsset, "id" | "name" | "kind" | "description" | "imageFile">> {
  return assets.map(({ id, name, kind, description, imageFile }) => ({
    id,
    name,
    kind,
    description,
    ...(imageFile ? { imageFile } : {}),
  }));
}
import fsp from "node:fs/promises";
import path from "node:path";
import type { DouyinH5Share } from "../types.js";
import type { Logger } from "../logger.js";
import { ensureDir, readJsonFile } from "../util/fs.js";

interface H5ShareFile {
  version: 1;
  shares: DouyinH5Share[];
}

const MAX_RECORDS = 200;

/** H5 投稿记录；用 share_id 关联抖音 Webhook 回调。 */
export class H5ShareStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<DouyinH5Share[]> {
    try {
      const parsed = await readJsonFile<H5ShareFile | DouyinH5Share[]>(this.file);
      const shares = Array.isArray(parsed) ? parsed : parsed.shares;
      return Array.isArray(shares) ? shares : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`H5 投稿记录读取失败：${String(error)}`);
      }
      return [];
    }
  }

  private async save(shares: DouyinH5Share[]): Promise<void> {
    await ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify({ version: 1, shares }, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, this.file);
  }

  async list(): Promise<DouyinH5Share[]> {
    return this.withLock(async () => {
      const shares = await this.load();
      return [...shares].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async find(shareId: string): Promise<DouyinH5Share | null> {
    return this.withLock(async () => (await this.load()).find((share) => share.shareId === shareId) ?? null);
  }

  async add(share: DouyinH5Share): Promise<void> {
    await this.withLock(async () => {
      const shares = await this.load();
      await this.save([share, ...shares].slice(0, MAX_RECORDS));
    });
  }

  async update(shareId: string, patch: Partial<DouyinH5Share>): Promise<DouyinH5Share | null> {
    return this.withLock(async () => {
      const shares = await this.load();
      const found = shares.find((share) => share.shareId === shareId);
      if (!found) return null;
      Object.assign(found, patch, { updatedAt: new Date().toISOString() });
      await this.save(shares);
      return found;
    });
  }
}

import fsp from "node:fs/promises";
import path from "node:path";
import type { PublishRecord } from "../types.js";
import type { Logger } from "../logger.js";
import { ensureDir, readJsonFile } from "../util/fs.js";

interface PublishHistoryFile {
  version: 1;
  publishes: PublishRecord[];
}

const MAX_RECORDS = 200;

/** 发布历史；保存成功发布的 item_id，便于用户回查。 */
export class PublishStore {
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

  private async load(): Promise<PublishRecord[]> {
    try {
      const parsed = await readJsonFile<PublishHistoryFile | PublishRecord[]>(this.file);
      const records = Array.isArray(parsed) ? parsed : parsed.publishes;
      return Array.isArray(records) ? records : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`发布历史读取失败：${String(error)}`);
      }
      return [];
    }
  }

  async list(): Promise<PublishRecord[]> {
    return this.withLock(async () => {
      const records = await this.load();
      return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async add(record: PublishRecord): Promise<void> {
    await this.withLock(async () => {
      const records = await this.load();
      const next = [record, ...records].slice(0, MAX_RECORDS);
      await ensureDir(path.dirname(this.file));
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, `${JSON.stringify({ version: 1, publishes: next }, null, 2)}\n`, "utf8");
      await fsp.rename(tmp, this.file);
    });
  }
}

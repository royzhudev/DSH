import fsp from "node:fs/promises";
import path from "node:path";
import type { DouyinToken } from "../types.js";
import type { Logger } from "../logger.js";
import { ensureDir } from "../util/fs.js";

/** 抖音令牌持久化，文件权限 0600，避免把 access_token 暴露给其他用户。 */
export class DouyinTokenStore {
  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  async read(): Promise<DouyinToken | null> {
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<DouyinToken>;
      if (
        typeof parsed.accessToken !== "string" ||
        typeof parsed.refreshToken !== "string" ||
        typeof parsed.openId !== "string"
      ) {
        return null;
      }
      return parsed as DouyinToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`抖音令牌读取失败：${String(error)}`);
      }
      return null;
    }
  }

  async write(token: DouyinToken): Promise<void> {
    await ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.file);
    await fsp.chmod(this.file, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await fsp.rm(this.file, { force: true });
  }
}

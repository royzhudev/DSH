export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function formatMeta(meta: unknown): string {
  if (meta === undefined) return "";
  if (meta instanceof Error) return ` ${meta.stack ?? meta.message}`;
  if (typeof meta === "string") return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export function createLogger(options: { level?: Level; silent?: boolean } = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const write = (level: Level, message: string, meta?: unknown) => {
    if (options.silent) return;
    if (LEVEL_ORDER[level] < threshold) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${formatMeta(meta)}`;
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.error(line);
    }
  };
  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
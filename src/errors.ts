export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  override readonly cause?: unknown;

  constructor(message: string, options: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "AppError";
    this.code = options.code ?? "APP_ERROR";
    this.status = options.status ?? 500;
    this.cause = options.cause;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
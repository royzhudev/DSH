import path from "node:path";
import fs from "node:fs/promises";
import type { AppConfig } from "../types.js";
import type { Logger } from "../logger.js";
import { probeMedia, runFfmpeg } from "../media/ffmpeg.js";

export interface ConcatOptions {
  segmentFiles: string[];
  outputFile: string;
  jobDir: string;
  config: AppConfig;
  logger: Logger;
}

function escapeConcatPath(file: string): string {
  return file.replace(/'/g, "'\\''");
}

/** 把分镜按顺序拼接成成片；统一重编码，避免各分镜时间基/编码参数差异导致音画不同步。 */
export async function concatSegments(options: ConcatOptions): Promise<number> {
  const { segmentFiles, outputFile, jobDir, config, logger } = options;
  if (segmentFiles.length === 0) {
    throw new Error("没有可拼接的分镜");
  }
  const listFile = path.join(jobDir, "concat.txt");
  const lines = segmentFiles.map(
    (file) => `file '${escapeConcatPath(path.relative(jobDir, file).split(path.sep).join("/"))}'`,
  );
  await fs.writeFile(listFile, `${lines.join("\n")}\n`, "utf8");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    "concat.txt",
    "-c:v",
    "libx264",
    "-preset",
    config.video.preset,
    "-crf",
    String(config.video.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outputFile,
  ];
  logger.info(`拼接 ${segmentFiles.length} 个分镜 → ${path.basename(outputFile)}`);
  await runFfmpeg(args, { cwd: jobDir, timeoutMs: 15 * 60 * 1000 });
  const probe = await probeMedia(outputFile);
  return probe.durationSec ?? 0;
}
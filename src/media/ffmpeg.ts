import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { AppError } from "../errors.js";

const MAX_CAPTURE = 2 * 1024 * 1024;

export function getFfmpegPath(): string {
  const override = process.env.FFMPEG_PATH?.trim();
  const resolved = override || (ffmpegStatic as unknown as string | null);
  if (!resolved) {
    throw new AppError("未找到 ffmpeg 可执行文件，请设置 FFMPEG_PATH 或重新安装依赖", {
      code: "FFMPEG_NOT_FOUND",
    });
  }
  return resolved;
}

export function getFfprobePath(): string {
  const override = process.env.FFPROBE_PATH?.trim();
  const resolved = override || ffprobeStatic.path;
  if (!resolved) {
    throw new AppError("未找到 ffprobe 可执行文件，请设置 FFPROBE_PATH 或重新安装依赖", {
      code: "FFPROBE_NOT_FOUND",
    });
  }
  return resolved;
}

export interface RunProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxCapture?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const maxCapture = options.maxCapture ?? MAX_CAPTURE;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new AppError(`命令执行超时（${Math.round(timeoutMs / 1000)}s）：${command}`, {
          code: "PROCESS_TIMEOUT",
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxCapture) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxCapture) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new AppError(`无法启动命令 ${command}：${error.message}`, {
          code: "PROCESS_SPAWN_FAILED",
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.split("\n").slice(-25).join("\n").trim();
        reject(
          new AppError(`命令失败（exit ${code}）：${command} ${args.join(" ")}\n${tail}`, {
            code: "PROCESS_FAILED",
          }),
        );
      }
    });
  });
}

export async function runFfmpeg(args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return runProcess(getFfmpegPath(), args, options);
}

/** 从成片抽一帧作为网页播放器封面。 */
export async function extractPoster(inputFile: string, outputFile: string, atSec = 0.3): Promise<void> {
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(atSec),
    "-i",
    inputFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=720:-2",
    "-q:v",
    "3",
    outputFile,
  ]);
}

export async function runFfprobe(args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return runProcess(getFfprobePath(), args, options);
}

export interface MediaProbe {
  durationSec?: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName?: string;
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
    codec_name?: string;
  }>;
  format?: { duration?: string; format_name?: string };
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  const { stdout } = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeJson;
  } catch (error) {
    throw new AppError(`无法解析 ffprobe 输出：${file}`, { code: "PROBE_FAILED", cause: error });
  }
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const formatDuration = Number(parsed.format?.duration);
  const streamDuration = Number(videoStream?.duration ?? audioStream?.duration);
  const duration = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration
      : undefined;
  return {
    durationSec: duration,
    width: videoStream?.width,
    height: videoStream?.height,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    formatName: parsed.format?.format_name,
  };
}

export async function generateSilentAudio(
  file: string,
  durationSec: number,
  sampleRate = 24000,
): Promise<void> {
  const duration = Math.max(0.2, durationSec);
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${sampleRate}:cl=mono`,
    "-t",
    duration.toFixed(3),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    file,
  ]);
}
/** 把多段配音按顺序拼成一条音轨（短剧多角色对话用）。 */
export async function concatAudio(files: string[], outputFile: string): Promise<void> {
  if (files.length === 0) throw new Error("没有可拼接的音频片段");
  if (files.length === 1) {
    await fs.copyFile(files[0]!, outputFile);
    return;
  }
  const listFile = `${outputFile}.list.txt`;
  const lines = files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listFile, `${lines}\n`, "utf8");
  try {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "48k",
      outputFile,
    ]);
  } finally {
    await fs.rm(listFile, { force: true });
  }
}

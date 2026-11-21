import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { AppError } from "../errors.js";

const require = createRequire(import.meta.url);
const MAX_CAPTURE = 2 * 1024 * 1024;

function isExecutableFile(file: string): boolean {
  try {
    fsSync.accessSync(file, fsSync.constants.X_OK);
    return fsSync.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 读取 ffprobe 依赖自带的二进制路径。
 * 该包在“当前平台没有对应可选依赖”时会直接在加载时报错，
 * 因此延迟到真正需要时再读取，并允许后续回退到系统 ffprobe。
 */
let bundledFfprobePath: string | null | undefined;
function getBundledFfprobePath(): string | null {
  if (bundledFfprobePath !== undefined) return bundledFfprobePath;
  try {
    const installer = require("@ffprobe-installer/ffprobe") as { path?: unknown };
    bundledFfprobePath = typeof installer.path === "string" ? installer.path : null;
  } catch {
    bundledFfprobePath = null;
  }
  return bundledFfprobePath;
}

/** 内置静态二进制缺少当前平台时，回退到 PATH 里的系统可执行文件。 */
function findOnPath(command: string): string | undefined {
  const names = process.platform === "win32" ? [`${command}.exe`, command] : [command];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 解析媒体工具路径：显式环境变量 > 依赖自带静态二进制 > PATH 里的系统命令。
 * 有些静态包只带 x64 二进制（例如旧版 ffprobe-static），在 arm64 上路径存在但不可执行，
 * 这里主动检查文件是否可用，避免等到下载完视频才发现 ffprobe 起不来。
 */
function resolveMediaBinary(options: {
  override: string | undefined;
  bundled: string | null | undefined;
  envName: string;
  command: string;
  label: string;
  code: string;
  reinstallHint: string;
}): string {
  const override = options.override?.trim();
  if (override) {
    if (isExecutableFile(override)) return override;
    // 允许环境变量写成命令名（如 FFMPEG_PATH=ffmpeg），按 PATH 解析。
    const fromPath = findOnPath(override);
    if (fromPath) return fromPath;
    throw new AppError(`${options.envName} 指向的 ${options.label}不可用：${override}（文件不存在或不可执行）`, {
      code: options.code,
    });
  }
  if (options.bundled && isExecutableFile(options.bundled)) return options.bundled;
  const system = findOnPath(options.command);
  if (system) return system;
  throw new AppError(
    `未找到可用的 ${options.label}：当前平台 ${process.platform}-${process.arch} 没有可执行的依赖二进制，` +
      `系统 PATH 中也没有 ${options.command}。${options.reinstallHint}，或安装系统 ${options.command}，` +
      `也可以用 ${options.envName} 指定路径。`,
    { code: options.code },
  );
}

export function getFfmpegPath(): string {
  return resolveMediaBinary({
    override: process.env.FFMPEG_PATH,
    bundled: ffmpegStatic as unknown as string | null,
    envName: "FFMPEG_PATH",
    command: "ffmpeg",
    label: "ffmpeg 可执行文件",
    code: "FFMPEG_NOT_FOUND",
    reinstallHint: "请重新安装依赖（ffmpeg-static）",
  });
}

export function getFfprobePath(): string {
  return resolveMediaBinary({
    override: process.env.FFPROBE_PATH,
    bundled: getBundledFfprobePath(),
    envName: "FFPROBE_PATH",
    command: "ffprobe",
    label: "ffprobe 可执行文件",
    code: "FFPROBE_NOT_FOUND",
    reinstallHint: "请重新安装依赖（@ffprobe-installer/ffprobe）",
  });
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
/**
 * 把多段配音按顺序拼成一条音轨（短剧多角色对话用）。
 *
 * 不同音色（男声/女声/年长/年轻）天生响度不一样，直接拼起来会有“一句大声一句小声”的
 * 割裂感。这里先逐句做响度归一（EBU R128，-18 LUFS），再用 concat 滤镜拼成一条，
 * 让每个角色的音量在同一水平上。
 */
export async function concatAudio(files: string[], outputFile: string): Promise<void> {
  if (files.length === 0) throw new Error("没有可拼接的音频片段");
  if (files.length === 1) {
    await fs.copyFile(files[0]!, outputFile);
    return;
  }
  const inputs = files.flatMap((file) => ["-i", file]);
  const normalized = files.map((_, index) => `[${index}:a]loudnorm=I=-18:TP=-2:LRA=7[a${index}]`);
  const concatInputs = files.map((_, index) => `[a${index}]`).join("");
  const filter = [
    ...normalized,
    `${concatInputs}concat=n=${files.length}:v=0:a=1[out]`,
  ].join(";");
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
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
}

/** 生成一段静音 mp3，用作对白之间的自然停顿。 */
export async function createSilence(seconds: number, outputFile: string): Promise<void> {
  const duration = Math.max(0.02, seconds);
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=24000:cl=mono`,
    "-t",
    duration.toFixed(3),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    outputFile,
  ]);
}

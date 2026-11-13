import path from "node:path";
import type { AppConfig, Material, ScriptSegment, SubtitleCue, TtsResult } from "../types.js";
import type { Logger } from "../logger.js";
import { createGradientImage, backgroundSeed } from "../media/background.js";
import { runFfmpeg } from "../media/ffmpeg.js";
import { renderAss } from "../subtitles/ass.js";
import { ensureDir } from "../util/fs.js";
import fs from "node:fs/promises";

export interface RenderSegmentOptions {
  index: number;
  segment: ScriptSegment;
  material: Material | null;
  /** 直接指定画面文件（AI 生成的视频），优先于 material。 */
  materialPath?: string;
  tts: TtsResult;
  durationSec: number;
  cues: SubtitleCue[];
  config: AppConfig;
  jobDir: string;
  topic: string;
  logger: Logger;
  /** 是否烧录字幕；口型同步需要先不烧字幕，等同步后再补，避免模型把字也重绘。 */
  burnSubtitles?: boolean;
}

export interface RenderedSegment {
  index: number;
  file: string;
  durationSec: number;
}

function quoteFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * 渲染单个分镜：素材（或渐变背景）铺满竖屏，烧录字幕，配音铺满分镜时长，
 * 首尾加固定淡入淡出，作为分镜间统一的“固定转场”。
 */
export async function renderSegment(options: RenderSegmentOptions): Promise<RenderedSegment> {
  const { index, segment, material, tts, durationSec, cues, config, jobDir, topic, logger } = options;
  const segDir = path.join(jobDir, "segments", `seg-${String(index).padStart(2, "0")}`);
  await ensureDir(segDir);
  const outputFile = path.join(segDir, "segment.mp4");
  const fade = Math.min(config.video.transitionDurationSec, durationSec / 4);
  const frames = Math.max(1, Math.round(durationSec * config.video.fps));

  let inputArgs: string[];
  let videoFilter: string;

  const visualPath = options.materialPath ?? (material ? path.join(config.libraryDir, material.file) : null);
  if (visualPath) {
    if (material?.type === "image") {
      inputArgs = ["-i", visualPath];
      videoFilter = [
        `scale=${config.video.width * 2}:${config.video.height * 2}:force_original_aspect_ratio=increase`,
        `crop=${config.video.width * 2}:${config.video.height * 2}`,
        `zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${config.video.width}x${config.video.height}:fps=${config.video.fps}`,
        "setsar=1",
      ].join(",");
    } else {
      inputArgs = ["-stream_loop", "-1", "-i", visualPath];
      videoFilter = [
        `scale=${config.video.width}:${config.video.height}:force_original_aspect_ratio=increase`,
        `crop=${config.video.width}:${config.video.height}`,
        "setsar=1",
        `fps=${config.video.fps}`,
      ].join(",");
    }
  } else {
    const bgFile = path.join(segDir, "background.ppm");
    await createGradientImage(
      bgFile,
      config.video.width,
      config.video.height,
      backgroundSeed(index, topic),
    );
    inputArgs = ["-i", bgFile];
    videoFilter = [
      `scale=${config.video.width * 2}:${config.video.height * 2}:force_original_aspect_ratio=increase`,
      `crop=${config.video.width * 2}:${config.video.height * 2}`,
      `zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${config.video.width}x${config.video.height}:fps=${config.video.fps}`,
      "setsar=1",
    ].join(",");
  }

  if (config.subtitles.enabled && options.burnSubtitles !== false) {
    await fs.writeFile(
      path.join(segDir, "sub.ass"),
      renderAss(cues, config.subtitles, {
        width: config.video.width,
        height: config.video.height,
        fps: config.video.fps,
      }),
      "utf8",
    );
    videoFilter += `,ass=${quoteFilterValue("sub.ass")}`;
  }

  videoFilter += `,fade=t=in:st=0:d=${fade.toFixed(2)},fade=t=out:st=${Math.max(0, durationSec - fade).toFixed(2)}:d=${fade.toFixed(2)}`;

  const audioFilter = [
    `apad=pad_dur=${config.video.tailPaddingSec.toFixed(2)}`,
    `atrim=0:${durationSec.toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
  ].join(",");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputArgs,
    "-i",
    tts.audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    videoFilter,
    "-af",
    audioFilter,
    "-r",
    String(config.video.fps),
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
    "-t",
    durationSec.toFixed(3),
    "-movflags",
    "+faststart",
    outputFile,
  ];

  logger.debug(
    `渲染分镜 ${index}：${options.materialPath ? "AI 生成画面" : material ? material.file : "渐变背景"}，${durationSec.toFixed(2)}s`,
  );
  await runFfmpeg(args, { cwd: segDir, timeoutMs: 10 * 60 * 1000 });
  return { index, file: outputFile, durationSec };
}


/** 在已有分镜视频上补烧字幕（口型同步之后调用，保持文字清晰且时间轴不变）。 */
export async function burnSegmentSubtitles(options: {
  index: number;
  file: string;
  cues: SubtitleCue[];
  config: AppConfig;
  logger: Logger;
}): Promise<string> {
  const { index, file, cues, config, logger } = options;
  if (!config.subtitles.enabled || cues.length === 0) return file;
  const segDir = path.dirname(file);
  const assFile = path.join(segDir, `sub-${index}.ass`);
  await fs.writeFile(
    assFile,
    renderAss(cues, config.subtitles, {
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
    }),
    "utf8",
  );
  const output = path.join(segDir, "segment-subbed.mp4");
  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-vf",
      `ass=${quoteFilterValue(path.basename(assFile))}`,
      "-c:v",
      "libx264",
      "-preset",
      config.video.preset,
      "-crf",
      String(config.video.crf),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ],
    { cwd: segDir, timeoutMs: 10 * 60 * 1000 },
  );
  logger.debug(`分镜 ${index} 口型同步后补烧字幕`);
  return output;
}

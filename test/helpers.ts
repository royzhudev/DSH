import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type DeepPartial } from "../src/config.js";
import type { AppConfig } from "../src/types.js";
import { runFfmpeg } from "../src/media/ffmpeg.js";

export async function makeTempDir(prefix = "video-agent-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function makeTestConfig(cwd: string, overrides: DeepPartial<AppConfig> = {}): AppConfig {
  return loadConfig({
    cwd,
    env: {},
    overrides: {
      outputDir: "./output",
      workDir: "./.work",
      libraryDir: "./materials",
      cacheDir: "./.cache",
      video: {
        width: 360,
        height: 640,
        fps: 15,
        preset: "ultrafast",
        crf: 30,
        transitionDurationSec: 0.1,
        minSegmentSec: 1.2,
        tailPaddingSec: 0.2,
      },
      script: {
        provider: "offline",
        targetDurationSec: 20,
        maxSegments: 3,
      },
      tts: {
        provider: "silent",
      },
      subtitles: {
        fontSize: 20,
        maxCharsPerLine: 10,
        maxLines: 2,
        marginV: 50,
      },
      ...overrides,
    },
  });
}

export async function generateTestClip(
  file: string,
  options: { durationSec?: number; size?: string; color?: string } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const duration = options.durationSec ?? 1;
  const size = options.size ?? "160x160";
  const color = options.color ?? "0x224466";
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:d=${duration}:r=15`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
}
export async function generateTestImage(
  file: string,
  options: { size?: string; color?: string } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const size = options.size ?? "240x320";
  const color = options.color ?? "0x884422";
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:d=1`,
    "-frames:v",
    "1",
    file,
  ]);
}

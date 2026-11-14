import fs from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, probeMedia } from "../media/ffmpeg.js";
import { ensureDir } from "../util/fs.js";

/**
 * 人声后期处理（母带级轻处理）。
 *
 * 素材里的配音是“干声”：没有均衡、没有压缩、音量忽大忽小，直接贴到画面上会显得
 * 又尖又飘，听起来就像有人在旁边念稿。这里做四件事，让它像成片里的一条人声：
 * 1. 高通 90Hz：去掉低频轰鸣与喷麦，手机外放不至于糊；
 * 2. 轻压缩：把忽大忽小的句子拉到同一响度，长句不会越念越小；
 * 3. 极轻的早期反射：给一点房间感，避免贴耳干声；
 * 4. EBU R128 响度归一：统一到 -16 LUFS，和常见的短视频成片一致。
 */
const VOICE_CHAIN = [
  "highpass=f=90",
  "acompressor=threshold=-18dB:ratio=3:attack=5:release=150",
  "aecho=0.8:0.65:26:0.05",
  "loudnorm=I=-16:TP=-1.5:LRA=11",
].join(",");

export interface VoiceMasterOptions {
  /** 关闭处理时直接返回原文件。 */
  enabled?: boolean;
}

/**
 * 对一条人声轨做后期处理，返回新文件路径（原文件保留，便于对比与排查）。
 */
export async function masterVoiceTrack(
  inputFile: string,
  outputFile: string,
  options: VoiceMasterOptions = {},
): Promise<{ file: string; durationSec: number }> {
  if (options.enabled === false) {
    const probe = await probeMedia(inputFile);
    return { file: inputFile, durationSec: probe.durationSec ?? 0 };
  }
  await ensureDir(path.dirname(outputFile));
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputFile,
    "-af",
    VOICE_CHAIN,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputFile,
  ]);
  const probe = await probeMedia(outputFile);
  return { file: outputFile, durationSec: probe.durationSec ?? 0 };
}

/** 测试与排查用：暴露处理链，便于断言参数确实生效。 */
export const VOICE_MASTER_CHAIN = VOICE_CHAIN;

/** 处理结果文件命名：与输入同目录，便于按分镜排查。 */
export function masteredVoicePath(inputFile: string): string {
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, path.extname(inputFile));
  return path.join(dir, `${base}-master.mp3`);
}

/** 该目录是否可写（母带处理需要写新文件）。 */
export async function ensureMasterDir(file: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.access(path.dirname(file));
}
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { concatAudio, probeMedia, runFfmpeg } from "../../src/media/ffmpeg.js";
import { makeTempDir } from "../helpers.js";

/** 生成一段固定频率、指定音量的音频。 */
async function makeTone(file: string, durationSec: number, volume: number): Promise<void> {
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${durationSec}`,
    "-af",
    `volume=${volume}`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    file,
  ]);
}

async function meanVolume(file: string): Promise<number> {
  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-i",
    file,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const match = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  assert.ok(match, `读不到平均音量：${stderr.slice(-300)}`);
  return Number(match[1]);
}

test("多角色配音拼接：逐句做响度归一，音量差被抹平且总时长不变", { timeout: 180_000 }, async () => {
  const dir = await makeTempDir();
  const loud = path.join(dir, "loud.mp3");
  const quiet = path.join(dir, "quiet.mp3");
  await makeTone(loud, 1, 1);
  await makeTone(quiet, 1, 0.05);
  const before = Math.abs((await meanVolume(loud)) - (await meanVolume(quiet)));
  assert.ok(before > 10, `测试素材本身的音量差应很明显，实际 ${before.toFixed(1)} dB`);

  const output = path.join(dir, "joined.mp3");
  await concatAudio([loud, quiet], output);

  const probe = await probeMedia(output);
  assert.ok(Math.abs((probe.durationSec ?? 0) - 2) < 0.3, `拼接后时长应约 2s，实际 ${probe.durationSec}`);

  // 原来的两条素材相差 10 dB 以上；归一后前后半段的音量应该在同一个水平。
  const firstHalf = path.join(dir, "first.mp3");
  const secondHalf = path.join(dir, "second.mp3");
  for (const [file, start] of [
    [firstHalf, "0"],
    [secondHalf, "1"],
  ] as const) {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start,
      "-t",
      "0.9",
      "-i",
      output,
      "-c:a",
      "libmp3lame",
      file,
    ]);
  }
  const after = Math.abs((await meanVolume(firstHalf)) - (await meanVolume(secondHalf)));
  assert.ok(after < 4, `归一后前后两段仍有 ${after.toFixed(1)} dB 落差`);

  await fs.rm(dir, { recursive: true, force: true });
});
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JobManager } from "../../src/server/jobs.js";
import { silentLogger } from "../../src/logger.js";
import { probeMedia, runFfmpeg } from "../../src/media/ffmpeg.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

test("任务局部修改：替换指定分镜并自动重新拼接成片", { timeout: 180_000 }, async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, {
    video: { fps: 24, width: 360, height: 640 },
    videoGen: { provider: "none" },
  });
  const jobs = new JobManager(config, silentLogger, () => ({
    edit: async (request) => {
      await fs.mkdir(path.dirname(request.outputFile), { recursive: true });
      await runFfmpeg([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x884422:s=${config.video.width}x${config.video.height}:d=${request.durationSec}:r=${config.video.fps}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${request.durationSec}`,
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        request.outputFile,
      ]);
      return {
        file: request.outputFile,
        durationSec: request.durationSec,
        provider: "fake",
        model: "fake-edit",
      };
    },
  }));
  try {
    const record = jobs.create("局部修改测试", {
      targetDurationSec: 10,
      maxSegments: 2,
      ttsProvider: "silent",
    });
    for (let i = 0; i < 240 && record.state !== "succeeded" && record.state !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(record.state, "succeeded", record.error);
    const before = await probeMedia(record.result!.videoPath);
    const segmentBefore = record.result!.segments[0]!;
    assert.equal(segmentBefore.edited, undefined);

    jobs.startVideoEdit(record.id, 1, "把背景改成黄昏的街道");
    for (let i = 0; i < 240 && record.edit?.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(record.edit?.status, "succeeded", record.edit?.error);
    assert.equal(record.result!.segments[0]!.edited, true);
    assert.equal(record.result!.segments[0]!.editPrompt, "把背景改成黄昏的街道");
    assert.match(record.result!.segments[0]!.renderedFile ?? "", /^edits\//);
    const after = await probeMedia(record.result!.videoPath);
    assert.equal(after.hasVideo, true);
    assert.equal(after.hasAudio, true);
    assert.ok(Math.abs((after.durationSec ?? 0) - (before.durationSec ?? 0)) < 1.5);
    const saved = JSON.parse(await fs.readFile(record.result!.resultPath, "utf8")) as {
      segments: Array<{ edited?: boolean; renderedFile?: string }>;
    };
    assert.equal(saved.segments[0]?.edited, true);
    assert.match(saved.segments[0]?.renderedFile ?? "", /^edits\//);
    assert.ok(record.result!.segments[1]!.renderedFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

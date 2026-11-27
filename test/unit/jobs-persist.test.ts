import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { silentLogger } from "../../src/logger.js";
import { JobManager } from "../../src/server/jobs.js";
import { scopedConfigFor } from "../../src/server/workspaces.js";
import type { PipelineResult } from "../../src/types.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

function sampleResult(jobId: string, jobDir: string): PipelineResult {
  return {
    jobId,
    topic: "历史短剧",
    createdAt: "2026-11-10T10:00:00.000Z",
    finishedAt: "2026-11-10T10:02:00.000Z",
    durationSec: 12,
    videoPath: `/旧部署/output/${jobId}/video.mp4`,
    posterPath: `/旧部署/output/${jobId}/poster.jpg`,
    srtPath: `/旧部署/output/${jobId}/subtitles.srt`,
    scriptPath: `/旧部署/output/${jobId}/script.json`,
    resultPath: `/旧部署/output/${jobId}/result.json`,
    script: { title: "历史短剧", summary: "历史摘要", segments: [], provider: "offline" },
    cast: [],
    segments: [],
    video: { width: 360, height: 640, fps: 15 },
  };
}

test("历史任务：重启后从 result.json 恢复成片记录并重定位路径", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const id = "20261110-100000-abcd1234";
  const jobDir = path.join(config.outputDir, "users", "u1", id);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify(sampleResult(id, jobDir)), "utf8");

  const jobs = new JobManager(config, silentLogger, undefined, undefined, {
    configFor: (userId) => scopedConfigFor(config, userId),
  });
  assert.equal(jobs.list("u1").length, 1);
  const restored = jobs.get(id);
  assert.ok(restored);
  assert.equal(restored.state, "succeeded");
  assert.equal(restored.topic, "历史短剧");
  assert.equal(restored.result?.videoPath, path.join(jobDir, "video.mp4"));
  assert.equal(restored.result?.posterPath, path.join(jobDir, "poster.jpg"));
  const detail = jobs.serialize(restored, true);
  assert.equal(detail.videoUrl, `/api/videos/${id}/video`);
  assert.equal(detail.script?.title, "历史短剧");
  assert.equal(detail.durationSec, 12);
});

test("历史任务：重启时把未完成的运行中任务标记为中断", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const id = "20261110-110000-deadbeef";
  const jobDir = path.join(config.outputDir, "users", "u1", id);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(
    path.join(jobDir, "job.json"),
    JSON.stringify({
      version: 1,
      id,
      topic: "中断的任务",
      options: {},
      state: "running",
      progress: { stage: "tts", percent: 40, message: "正在配音" },
      createdAt: "2026-11-10T11:00:00.000Z",
    }),
    "utf8",
  );
  await fs.writeFile(path.join(jobDir, "job.json.bak"), "ignore", "utf8");

  const jobs = new JobManager(config, silentLogger, undefined, undefined, {
    configFor: (userId) => scopedConfigFor(config, userId),
  });
  const restored = jobs.get(id);
  assert.ok(restored);
  assert.equal(restored.state, "failed");
  assert.match(restored.error ?? "", /任务已中断/);
  assert.equal(restored.result, undefined);
});

test("历史任务：忽略输出目录里的非任务目录", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  await fs.mkdir(path.join(config.outputDir, "cache"), { recursive: true });
  const jobs = new JobManager(config, silentLogger);
  assert.equal(jobs.list("u1").length, 0);
});

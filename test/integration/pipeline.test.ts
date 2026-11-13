import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "../../src/pipeline.js";
import { probeMedia } from "../../src/media/ffmpeg.js";
import { silentLogger } from "../../src/logger.js";
import { MaterialLibrary } from "../../src/materials/library.js";
import { generateTestImage, makeTempDir, makeTestConfig } from "../helpers.js";

test(
  "完整闭环：主题 → 脚本 → 素材回退 → 配音 → 字幕 → 成片",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    try {
      const result = await runPipeline({
        topic: "城市夜景",
        config,
        logger: silentLogger,
      });

      assert.ok(result.jobId);
      assert.equal(result.topic, "城市夜景");
      assert.ok(result.segments.length >= 3);
      assert.equal(result.script.provider, "offline");
      assert.ok(result.durationSec > 3, `成片时长异常：${result.durationSec}`);

      const videoStat = await fs.stat(result.videoPath);
      assert.ok(videoStat.size > 10_000);
      const probe = await probeMedia(result.videoPath);
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, true);
      assert.equal(probe.width, config.video.width);
      assert.equal(probe.height, config.video.height);

      const srt = await fs.readFile(result.srtPath, "utf8");
      assert.match(srt, /00:00:0\d,\d{3} --> /);
      assert.ok(srt.includes("城市夜景"));

      const scriptJson = JSON.parse(await fs.readFile(result.scriptPath, "utf8")) as {
        segments: unknown[];
      };
      assert.equal(scriptJson.segments.length, result.segments.length);

      const resultJson = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
        jobId: string;
        segments: Array<{ ttsProvider: string; material: unknown }>;
      };
      assert.equal(resultJson.jobId, result.jobId);
      assert.ok(resultJson.segments.every((segment) => segment.ttsProvider === "silent"));
      assert.ok(resultJson.segments.every((segment) => segment.material === null));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "图片素材走 zoompan 渲染路径并复用素材",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    try {
      const image = path.join(dir, "source", "city.png");
      await generateTestImage(image);
      const library = new MaterialLibrary(config.libraryDir, silentLogger);
      const material = await library.add(image, { tags: ["城市"] });
      assert.equal(material.type, "image");

      const result = await runPipeline({ topic: "城市夜景", config, logger: silentLogger });
      assert.ok(result.segments.some((segment) => segment.material?.type === "image"));
      const probe = await probeMedia(result.videoPath);
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, true);
      assert.ok(result.durationSec > 3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "对话模式：分镜按人物台词逐句配音，字幕带说话人",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "silent" } });
    try {
      const result = await runPipeline({
        topic: "外卖员被冤枉",
        config,
        logger: silentLogger,
        dialogue: true,
      });
      assert.equal(result.script.mode, "dialogue");
      assert.ok(result.segments.length >= 2);
      for (const segment of result.segments) {
        assert.ok(segment.lines && segment.lines.length >= 2, "对话模式每个分镜都应有台词");
        assert.ok(segment.lines!.every((line) => line.speaker && line.text && line.durationSec > 0));
      }
      // 逐句合成后拼接成一条音轨，时间轴按真实时长累加
      const first = result.segments[0]!;
      const expected = first.lines!.reduce((sum, line) => sum + line.durationSec, 0);
      assert.ok(Math.abs(expected - first.durationSec) < 1.5, `时长对不上：${expected} vs ${first.durationSec}`);
      const srt = await fs.readFile(result.srtPath, "utf8");
      assert.match(srt, /我：/);
      assert.match(srt, /：/);
      const probe = await probeMedia(result.videoPath);
      assert.equal(probe.hasAudio, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

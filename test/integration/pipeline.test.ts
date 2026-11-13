import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "../../src/pipeline.js";
import { probeMedia, runFfmpeg } from "../../src/media/ffmpeg.js";
import { silentLogger } from "../../src/logger.js";
import { CastLibrary } from "../../src/cast/library.js";
import { MaterialLibrary } from "../../src/materials/library.js";
import type { LipsyncProvider, Script } from "../../src/types.js";
import { AppError } from "../../src/errors.js";
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

test(
  "口型同步：对话分镜渲染后调用对口型，失败可回退",
  { timeout: 240_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "silent" } });
    const library = new CastLibrary(config.castDir, silentLogger);
    await library.add({
      kind: "character",
      name: "林小满",
      description: "25 岁女性，齐肩短发，米色风衣",
    });
    const calls: Array<{ videoFile: string; audioFile: string }> = [];
    const provider: LipsyncProvider = {
      name: "fake",
      // 和真实 VideoRetalk 一样把结果写在任务根目录，而不是分镜目录；
      // 这样能覆盖“补字幕时所有分镜写同一个文件、互相覆盖”的回归。
      async sync(request, outputDir) {
        calls.push(request);
        const target = path.join(outputDir, `fake-lipsync-${calls.length}.mp4`);
        await fs.copyFile(request.videoFile, target);
        return { provider: "fake", model: "fake-lipsync", file: target, durationSec: 1 };
      },
    };
    try {
      const result = await runPipeline({
        topic: "外卖员被冤枉",
        config,
        logger: silentLogger,
        dialogue: true,
        lipsyncProvider: provider,
      });
      assert.ok(calls.length >= 1, "对话分镜应按已上传角色调用口型同步");
      assert.equal(calls.length, result.segments.filter((segment) => segment.lines?.length).length);
      assert.ok(result.segments.every((segment) => segment.lipsync === "synced"));
      // 脚本里只有“我/你”时，也要代入已上传的单个角色，不能因为名字对不上就丢掉参考图
      assert.ok(
        result.segments.every((segment) => segment.cast?.some((asset) => asset.name === "林小满")),
        "每个分镜都应带上已上传角色",
      );
      // 每个分镜都要有自己的补字幕文件，不能共用同一个 segment-subbed.mp4
      for (let index = 0; index < result.segments.length; index += 1) {
        const file = path.join(
          dir,
          "output",
          result.jobId,
          "segments",
          `seg-${String(index + 1).padStart(2, "0")}`,
          "segment-subbed.mp4",
        );
        assert.equal(await fs.stat(file).then(() => true).catch(() => false), true, `分镜 ${index + 1} 缺少独立补字幕文件`);
      }
      const totalSegmentDuration = result.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
      assert.ok(
        Math.abs(result.durationSec - totalSegmentDuration) < 2,
        `成片时长 ${result.durationSec} 与分镜合计 ${totalSegmentDuration} 对不上，可能重复/漏拼`,
      );
      const srt = await fs.readFile(result.srtPath, "utf8");
      assert.match(srt, /：/);
      const probe = await probeMedia(result.videoPath);
      assert.equal(probe.hasAudio, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "口型同步：失败时回退未对口型片段并给出提醒",
  { timeout: 240_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "silent" } });
    const library = new CastLibrary(config.castDir, silentLogger);
    await library.add({ kind: "character", name: "林小满", description: "25 岁女性" });
    const provider: LipsyncProvider = {
      name: "fake",
      async sync() {
        throw new Error("口型服务暂不可用");
      },
    };
    try {
      const result = await runPipeline({
        topic: "外卖员被冤枉",
        config,
        logger: silentLogger,
        dialogue: true,
        lipsyncProvider: provider,
      });
      assert.ok(result.segments.every((segment) => segment.lipsync === "unsynced"));
      assert.ok(result.warnings?.some((warning) => warning.includes("口型同步失败")));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "口型同步：时长变化后字幕与后续分镜起点重排，不再错位",
  { timeout: 300_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "silent" } });
    const library = new CastLibrary(config.castDir, silentLogger);
    await library.add({ kind: "character", name: "林小满", description: "25 岁女性" });
    const provider: LipsyncProvider = {
      name: "fake",
      async sync(request) {
        const target = path.join(path.dirname(request.videoFile), "fake-synced.mp4");
        // 模拟 VideoRetalk 的 video_extension：画面被拉长到 3.2 秒
        await runFfmpeg([
          "-y",
          "-stream_loop",
          "-1",
          "-i",
          request.videoFile,
          "-i",
          request.audioFile,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-t",
          "3.2",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          target,
        ]);
        return { provider: "fake", model: "fake", file: target, durationSec: 3.2 };
      },
    };
    try {
      const result = await runPipeline({
        topic: "外卖员被冤枉",
        config,
        logger: silentLogger,
        dialogue: true,
        lipsyncProvider: provider,
      });
      assert.ok(result.segments.every((segment) => segment.lipsync === "synced"));
      const total = result.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
      assert.ok(Math.abs(total - result.durationSec) < 0.6, `时长对不上：${total} vs ${result.durationSec}`);
      let expectedStart = 0;
      for (const segment of result.segments) {
        assert.ok(Math.abs(segment.startSec - expectedStart) < 0.05, "分镜起点应连续");
        expectedStart += segment.durationSec;
      }
      const srt = await fs.readFile(result.srtPath, "utf8");
      const ends = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> /g)].map((match) => {
        const [, h, m, s, ms] = match;
        return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
      });
      assert.ok(ends.length > 0);
      assert.ok(
        Math.max(...ends) <= result.durationSec + 0.3,
        `字幕结尾 ${Math.max(...ends)} 超过成片时长 ${result.durationSec}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "脚本把同一句旁白写了好几遍时，流水线自动重新生成一次剧本",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const good: Script = {
      title: "重试成功",
      summary: "",
      provider: "flaky",
      segments: [
        { id: 1, narration: "第一句台词。", keywords: [] },
        { id: 2, narration: "第二句台词。", keywords: [] },
      ],
    };
    let calls = 0;
    const scriptProvider = {
      name: "flaky",
      generate: async () => {
        calls += 1;
        if (calls === 1) {
          throw new AppError("同一句台词重复了好几遍", { code: "SCRIPT_DUPLICATED" });
        }
        return good;
      },
    };
    try {
      const result = await runPipeline({
        topic: "重试",
        config,
        logger: silentLogger,
        scriptProvider: scriptProvider as never,
        videoGenProvider: null,
      });
      assert.equal(calls, 2, "应当自动重新请求一次脚本");
      assert.equal(result.segments.length, 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);


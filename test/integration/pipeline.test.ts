import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "../../src/pipeline.js";
import { generateSilentAudio, probeMedia, runFfmpeg } from "../../src/media/ffmpeg.js";
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
      // 对白之间要有自然停顿，不能一句顶一句。
      assert.ok(
        first.durationSec > expected + 0.15,
        `台词之间的停顿没有进音轨：${first.durationSec} vs ${expected}`,
      );
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
  "对话模式：百炼配音按角色设定的音色逐人合成",
  { timeout: 240_000 },
  async () => {
    const dir = await makeTempDir();
    const audio = path.join(dir, "sample.mp3");
    await generateSilentAudio(audio, 0.8);
    const audioBuffer = await fs.readFile(audio);
    const heardVoices = new Set<string>();
    let base = "";
    const mock = http.createServer(async (req, res) => {
      if (req.url === "/audio/sample.mp3") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(audioBuffer);
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}") as { input?: { voice?: string } };
      if (body.input?.voice) heardVoices.add(body.input.voice);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { audio: { url: `${base}/audio/sample.mp3` } } }));
    });
    const port = await new Promise<number>((resolve) =>
      mock.listen(0, "127.0.0.1", () => {
        const address = mock.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      }),
    );
    base = `http://127.0.0.1:${port}`;
    const config = makeTestConfig(dir, {
      tts: {
        provider: "bailian",
        baseUrl: base,
        apiKey: "bailian-key",
        model: "qwen-tts",
        voice: "Cherry",
        rate: 1,
      },
    });
    const library = new CastLibrary(config.castDir, silentLogger);
    await library.add({
      kind: "character",
      name: "林小满",
      description: "25 岁女性，齐肩短发",
      voice: "Cherry",
    });
    await library.add({
      kind: "character",
      name: "黄乐",
      description: "45 岁男性，酒吧老板",
      voice: "Ethan",
    });
    try {
      const result = await runPipeline({
        topic: "外卖员被冤枉",
        config,
        logger: silentLogger,
        dialogue: true,
      });
      const voices = new Set(
        result.segments.flatMap((segment) => segment.lines?.map((line) => line.voice) ?? []),
      );
      assert.ok(voices.has("Cherry"), `缺少林小满的音色：${[...voices].join(",")}`);
      assert.ok(voices.has("Ethan"), `缺少黄乐的音色：${[...voices].join(",")}`);
      assert.ok(heardVoices.has("Cherry") && heardVoices.has("Ethan"), "合成本身要按角色切换音色");
    } finally {
      mock.closeAllConnections?.();
      await new Promise<void>((resolve) => mock.close(() => resolve()));
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

test(
  "配音混音：分镜音轨会生成后期处理版本，且成片用的是处理后的音轨",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "edge" } });
    let calls = 0;
    const ttsProvider = {
      name: "edge" as const,
      voice: "zh-CN-XiaoxiaoNeural",
      synthesize: async () => {
        calls += 1;
        const file = path.join(dir, "tts", `line-${calls}.mp3`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        // 很小的干声：正常 TTS 的输出响度，混音后应该被拉到成片水平。
        await runFfmpeg([
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1.2",
          "-af",
          "volume=0.03",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "48k",
          file,
        ]);
        return {
          provider: "edge" as const,
          voice: "zh-CN-XiaoxiaoNeural",
          audioPath: file,
          durationSec: 1.2,
          sentences: [{ text: "第一句台词。", startSec: 0, endSec: 1.2 }],
          cached: false,
        };
      },
    };
    try {
      const result = await runPipeline({
        topic: "混音校验",
        config,
        logger: silentLogger,
        ttsProvider: ttsProvider as never,
        videoGenProvider: null,
      });
      const audioDir = path.join(config.outputDir, result.jobId, "audio");
      const voices = (await fs.readdir(audioDir)).filter((name) => name.endsWith("-voice-master.mp3"));
      assert.ok(voices.length >= 1, `没有生成人声后期文件：${(await fs.readdir(audioDir)).join(", ")}`);
      const mastered = path.join(audioDir, voices[0]!);
      const { stderr } = await runFfmpeg(["-hide_banner", "-i", mastered, "-af", "volumedetect", "-f", "null", "-"]);
      const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      assert.ok(match, "没有读到混音后响度");
      assert.ok(Number(match![1]) > -24, `混音后仍然过小：${match![1]}dB`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);


test(
  "一镜到底：分镜数量 1 也能产出完整成片",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    config.script.maxSegments = 1;
    try {
      const result = await runPipeline({ topic: "雨夜便利店", config, logger: silentLogger });
      assert.equal(result.segments.length, 1);
      assert.ok(result.durationSec > 3, `成片时长异常：${result.durationSec}`);
      const probe = await probeMedia(result.videoPath);
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "口型同步总开关关闭：即使传了口型供应商也不调用",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "silent" }, lipsync: { enabled: false } });
    const library = new CastLibrary(config.castDir, silentLogger);
    await library.add({ kind: "character", name: "林小满", description: "25 岁女性，齐肩短发" });
    let calls = 0;
    const provider: LipsyncProvider = {
      name: "fake",
      async sync(request, outputDir) {
        calls += 1;
        const target = path.join(outputDir, `fake-lipsync-${calls}.mp4`);
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
      assert.equal(calls, 0, "总开关关闭后不应调用口型同步");
      assert.ok(result.segments.every((segment) => segment.lipsync === undefined));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "创作页改过的脚本：成片严格按修改后的内容生成，不再调用脚本模型",
  { timeout: 180_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { tts: { provider: "silent" } });
    let generated = 0;
    const scriptProvider = {
      name: "fake",
      async generate() {
        generated += 1;
        throw new Error("不应调用脚本模型");
      },
    };
    try {
      const result = await runPipeline({
        topic: "钟表店",
        config,
        logger: silentLogger,
        scriptProvider,
        script: {
          title: "改过的标题",
          summary: "外卖员被冤枉",
          provider: "edited",
          segments: [
            { id: 1, narration: "林小满推门而入，雨还没停。", keywords: ["钟表店", "雨夜"] },
            { id: 2, narration: "黄乐把表推回柜台。", keywords: ["柜台", "特写"] },
          ],
        },
      });
      assert.equal(generated, 0, "用户已经改好脚本时不应重新生成");
      assert.equal(result.script.title, "改过的标题");
      assert.equal(result.script.segments.length, 2);
      const srt = await fs.readFile(result.srtPath, "utf8");
      assert.match(srt, /雨还没停/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

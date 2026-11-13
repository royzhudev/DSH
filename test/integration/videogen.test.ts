import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "../../src/pipeline.js";
import { CastLibrary } from "../../src/cast/library.js";
import { silentLogger } from "../../src/logger.js";
import { runFfmpeg } from "../../src/media/ffmpeg.js";
import type { VideoGenProvider, VideoGenRequest } from "../../src/types.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

test(
  "流水线使用 AI 生成画面，并在失败时回退背景",
  { timeout: 240_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      script: { provider: "offline", targetDurationSec: 12, maxSegments: 3 },
      videoGen: {
        provider: "http",
        baseUrl: "http://127.0.0.1:1",
        model: "fake-model",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5000,
        clipDurationSec: 2,
        fallbackToMaterials: true,
      },
    });
    const clip = path.join(dir, "generated.mp4");
    await generateTestClip(clip, { durationSec: 1.5, size: "160x160" });
    let calls = 0;
    const provider: VideoGenProvider = {
      name: "fake",
      model: "fake-model",
      generate: async () => {
        calls += 1;
        if (calls === 2) throw new Error("模拟生成失败");
        return { file: clip, durationSec: 1.5, provider: "fake", model: "fake-model" };
      },
    };
    const result = await runPipeline({
      topic: "城市夜景",
      config,
      logger: silentLogger,
      videoGenProvider: provider,
    });
    assert.equal(result.segments.length, 3);
    assert.equal(result.segments[0]!.source, "generated");
    assert.equal(result.segments[1]!.source, "background");
    assert.equal(result.segments[2]!.source, "generated");
    assert.deepEqual(result.segments[0]!.generated, { provider: "fake", model: "fake-model" });
    assert.equal(await fs.stat(result.videoPath).then((stat) => stat.size > 0), true);
  },
);

test(
  "流水线：剧本 + 角色参考图走图生视频并保持人物一致",
  { timeout: 240_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      script: { provider: "offline", targetDurationSec: 12, maxSegments: 3 },
      videoGen: {
        provider: "http",
        baseUrl: "http://127.0.0.1:1",
        model: "fake-model",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5000,
        clipDurationSec: 2,
        fallbackToMaterials: true,
      },
    });
    const heroImage = path.join(config.castDir, "hero.png");
    await fs.mkdir(config.castDir, { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x884466:s=64x64", "-frames:v", "1", heroImage]);
    const library = new CastLibrary(config.castDir, silentLogger);
    const hero = await library.add({
      kind: "character",
      name: "林小满",
      description: "25 岁女性，齐肩短发，米色风衣",
      imagePath: heroImage,
    });
    const prop = await library.add({ kind: "prop", name: "旧怀表", description: "铜质，表盘有裂纹" });

    const clip = path.join(dir, "generated.mp4");
    await generateTestClip(clip, { durationSec: 1.5, size: "160x160" });
    const requests: VideoGenRequest[] = [];
    const provider: VideoGenProvider = {
      name: "fake",
      model: "fake-model",
      generate: async (request) => {
        requests.push(request);
        return { file: clip, durationSec: 1.5, provider: "fake", model: "fake-model" };
      },
    };
    const result = await runPipeline({
      topic: "钟表店",
      story: "林小满在钟表店遇到一位神秘客人，旧怀表在柜台里轻轻震动。",
      castIds: [hero.id, prop.id],
      config,
      logger: silentLogger,
      videoGenProvider: provider,
    });

    assert.equal(result.story?.includes("林小满"), true);
    assert.deepEqual(
      result.cast?.map((asset) => asset.name).sort(),
      ["林小满", "旧怀表"].sort(),
    );
    assert.equal(result.segments.length, 3);
    assert.equal(result.segments[0]!.imageToVideo, true);
    assert.ok(result.segments[0]!.cast?.some((item) => item.name === "林小满"));
    assert.ok(requests.length > 0);
    assert.ok(requests[0]!.image, "首帧参考图没有传给图生视频");
    assert.ok(requests[0]!.references?.some((reference) => reference.name === "林小满"));
    assert.ok(requests[0]!.prompt.includes("林小满"));
    assert.ok(result.warnings?.some((warning) => warning.includes("离线")), "缺少离线脚本提示");
    assert.equal(await fs.stat(result.videoPath).then((stat) => stat.size > 0), true);
  },
);

test(
  "流水线：多个分镜各用各的生成视频，重复内容会给出告警",
  { timeout: 240_000 },
  async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      script: { provider: "offline", targetDurationSec: 16, maxSegments: 4 },
      videoGen: {
        provider: "http",
        baseUrl: "http://127.0.0.1:1",
        model: "fake-model",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5000,
        clipDurationSec: 2,
        fallbackToMaterials: true,
      },
    });
    const clips: string[] = [];
    for (const [index, color] of ["red", "green", "blue", "yellow"].entries()) {
      const file = path.join(dir, `clip-${index}.mp4`);
      await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x160:d=1.5`, "-pix_fmt", "yuv420p", file]);
      clips.push(file);
    }
    const requests: VideoGenRequest[] = [];
    // 第 3 镜故意返回第 1 镜的视频，模拟平台对两个分镜给出同一条结果。
    const provider: VideoGenProvider = {
      name: "fake",
      model: "fake-model",
      generate: async (request) => {
        requests.push(request);
        const index = requests.length - 1;
        const file = index === 2 ? clips[0]! : clips[index % clips.length]!;
        return { file, durationSec: 1.5, provider: "fake", model: "fake-model" };
      },
    };
    const result = await runPipeline({
      topic: "城市夜景",
      config,
      logger: silentLogger,
      videoGenProvider: provider,
    });

    assert.equal(result.segments.length >= 3, true);
    // 每个分镜的提示词都不同（镜头序号不同）。
    assert.equal(new Set(requests.map((request) => request.prompt)).size, requests.length);
    assert.equal(
      (result.warnings ?? []).some((warning) => warning.includes("同一条生成视频")),
      true,
      `重复画面没有被识别：${(result.warnings ?? []).join(" / ")}`,
    );
    assert.equal(await fs.stat(result.videoPath).then((stat) => stat.size > 0), true);
  },
);


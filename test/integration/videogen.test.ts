import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "../../src/pipeline.js";
import { silentLogger } from "../../src/logger.js";
import type { VideoGenProvider } from "../../src/types.js";
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

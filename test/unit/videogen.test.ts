import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { HttpVideoGenProvider, VideoGenPendingError } from "../../src/videogen/http.js";
import { createVideoGenProvider } from "../../src/videogen/index.js";
import { AppError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import { probeMedia } from "../../src/media/ffmpeg.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

interface MockVideoServer {
  url: string;
  close(): Promise<void>;
}

async function startVideoMock(): Promise<MockVideoServer> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === "/v1/videos/generations") {
      const parsed = JSON.parse(body) as { prompt: string };
      if (parsed.prompt.includes("fail")) {
        send({ id: "task-fail" });
        return;
      }
      if (parsed.prompt.includes("immediate")) {
        send({ data: { video_url: "/files/clip.mp4" } });
        return;
      }
      if (parsed.prompt.includes("slow")) {
        send({ task_id: "task-slow" });
        return;
      }
      send({ task_id: "task-1" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/generations/task-1") {
      send({ data: { status: "succeeded", video_url: "/files/clip.mp4" } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/generations/task-slow") {
      send(
        process.env.VIDEOGEN_SLOW_DONE === "1"
          ? { data: { status: "succeeded", video_url: "/files/clip.mp4" } }
          : { data: { status: "running" } },
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/generations/task-fail") {
      send({ status: "failed", error: "生成失败" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/files/clip.mp4") {
      const file = process.env.VIDEOGEN_TEST_CLIP;
      if (!file) {
        res.writeHead(500);
        res.end();
        return;
      }
      const buffer = await fs.readFile(file);
      res.writeHead(200, { "content-type": "video/mp4", "content-length": buffer.length });
      res.end(buffer);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

test("HTTP 文生视频：提交、轮询、下载与 ffprobe 校验", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  process.env.VIDEOGEN_TEST_CLIP = clip;
  const mock = await startVideoMock();
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        baseUrl: mock.url,
        model: "video-model",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
        clipDurationSec: 3,
        fallbackToMaterials: true,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger);
    const generated = await provider.generate({ prompt: "城市夜景", durationSec: 3 }, path.join(dir, "gen"));
    assert.equal(generated.provider, "http");
    assert.equal(generated.model, "video-model");
    assert.equal(generated.durationSec > 0.5, true);
    assert.equal(await fs.stat(generated.file).then((stat) => stat.isFile()), true);
    const probe = await probeMedia(generated.file);
    assert.equal(probe.width, 160);

    const immediate = await provider.generate(
      { prompt: "immediate 城市夜景", durationSec: 3 },
      path.join(dir, "gen"),
    );
    assert.equal(immediate.durationSec > 0.5, true);

    await assert.rejects(
      provider.generate({ prompt: "fail 城市夜景", durationSec: 3 }, path.join(dir, "gen")),
      (error: unknown) => error instanceof AppError && error.code === "VIDEOGEN_TASK_FAILED",
    );

    // 超时后必须给出任务 ID 让调用方复用，而不是当成生成失败。
    const impatient = new HttpVideoGenProvider(
      { ...config.videoGen, timeoutMs: 700, pollIntervalMs: 100 },
      silentLogger,
    );
    await assert.rejects(
      impatient.generate({ prompt: "slow 城市夜景", durationSec: 3 }, path.join(dir, "gen")),
      (error: unknown) =>
        error instanceof VideoGenPendingError &&
        error.submitted === true &&
        error.taskId === "task-slow",
    );

    // 复用同一个任务继续查询，不再提交新的（付费）生成请求。
    process.env.VIDEOGEN_SLOW_DONE = "1";
    const resumed = await impatient.resume("task-slow", path.join(dir, "gen"));
    assert.equal(resumed.provider, "http");
    assert.equal(resumed.durationSec > 0.5, true);
    delete process.env.VIDEOGEN_SLOW_DONE;

    const disabled = makeTestConfig(dir);
    assert.equal(createVideoGenProvider(disabled, silentLogger), null);
  } finally {
    delete process.env.VIDEOGEN_TEST_CLIP;
    await mock.close();
  }
});

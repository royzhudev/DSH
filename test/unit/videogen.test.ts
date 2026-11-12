import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { HttpVideoGenProvider } from "../../src/videogen/http.js";
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
      send({ task_id: "task-1" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/generations/task-1") {
      send({ data: { status: "succeeded", video_url: "/files/clip.mp4" } });
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

test("HTTP 文生视频：测试配置提交最短任务并校验轮询", async () => {
  const dir = await makeTempDir();
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
    const result = await provider.check();
    assert.equal(result.model, "video-model");
    assert.equal(result.taskId, "task-1");
    assert.equal(result.status, "succeeded");
    assert.equal(result.videoUrlReturned, true);

    await assert.rejects(
      new HttpVideoGenProvider(
        { ...config.videoGen, baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 },
        silentLogger,
      ).check(),
      (error: unknown) => error instanceof AppError && error.code === "VIDEOGEN_REQUEST_FAILED",
    );
  } finally {
    await mock.close();
  }
});

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

    const disabled = makeTestConfig(dir);
    assert.equal(createVideoGenProvider(disabled, silentLogger), null);
  } finally {
    delete process.env.VIDEOGEN_TEST_CLIP;
    await mock.close();
  }
});

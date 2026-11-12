import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { HttpVideoGenProvider, VideoGenPendingError } from "../../src/videogen/http.js";
import { createVideoGenProvider } from "../../src/videogen/index.js";
import { AppError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import { probeMedia, runFfmpeg } from "../../src/media/ffmpeg.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

interface MockVideoServer {
  url: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startVideoMock(): Promise<MockVideoServer> {
  const requests: Array<Record<string, unknown>> = [];
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
      requests.push(parsed as Record<string, unknown>);
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
    requests,
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

test("HTTP 图生视频：提交首帧与角色参考图 data URL", async () => {
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
    const hero = path.join(dir, "cast", "hero.png");
    await fs.mkdir(path.dirname(hero), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x884466:s=64x64", "-frames:v", "1", hero]);

    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger);
    const generated = await provider.generate(
      {
        prompt: "林小满走进钟表店",
        durationSec: 3,
        image: hero,
        references: [{ role: "character", name: "林小满", file: hero }],
      },
      path.join(dir, "gen"),
    );
    assert.equal(generated.durationSec > 0.5, true);

    const submitted = mock.requests.at(-1);
    assert.ok(submitted, "没有捕获到提交请求");
    assert.equal(submitted.prompt, "林小满走进钟表店");
    assert.match(String(submitted.image), /^data:image\/png;base64,/);
    const references = submitted.reference_images as Array<Record<string, unknown>>;
    assert.equal(references.length, 1);
    assert.equal(references[0]!.role, "character");
    assert.equal(references[0]!.name, "林小满");
    assert.match(String(references[0]!.image), /^data:image\/png;base64,/);

    await assert.rejects(
      provider.generate(
        {
          prompt: "参考图缺失",
          durationSec: 3,
          references: [{ role: "character", name: "林小满", file: path.join(dir, "missing.png") }],
        },
        path.join(dir, "gen"),
      ),
      (error: unknown) => error instanceof AppError && error.code === "VIDEOGEN_REFERENCE_INVALID",
    );
  } finally {
    delete process.env.VIDEOGEN_TEST_CLIP;
    await mock.close();
  }
});


test("HTTP 文生视频：兼容聚合平台把成片地址放在数组/嵌套字段里", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const shapes: Record<string, unknown> = {
    "task-array": { data: [{ status: "succeeded", url: "/files/clip.mp4" }] },
    "task-output": { status: "completed", output: { video_url: "/files/clip.mp4" } },
    "task-deep": { data: { task: { state: "SUCCESS", result: { videos: [{ url: "/files/clip.mp4" }] } } } },
    "task-thumb": { data: { status: "succeeded", thumbnail: "https://example.com/cover.jpg" } },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === "/v1/videos/generations") {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prompt: string };
      send({ task_id: parsed.prompt });
      return;
    }
    const pollMatch = /^\/v1\/videos\/generations\/([a-z-]+)$/.exec(url.pathname);
    if (req.method === "GET" && pollMatch) {
      send(shapes[pollMatch[1]!] ?? { status: "running" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/files/clip.mp4") {
      const buffer = await fs.readFile(clip);
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
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        baseUrl: `http://127.0.0.1:${port}`,
        model: "aggregator-model",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
        clipDurationSec: 5,
        fallbackToMaterials: true,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger);
    for (const taskId of ["task-array", "task-output", "task-deep"]) {
      const generated = await provider.generate(
        { prompt: taskId, durationSec: 5 },
        path.join(dir, "gen"),
      );
      assert.equal(generated.durationSec > 0.5, true, `应能从 ${taskId} 取回成片`);
    }

    // 只有图片地址时不能把封面当成视频，也不能假装成功。
    await assert.rejects(
      provider.generate({ prompt: "task-thumb", durationSec: 5 }, path.join(dir, "gen")),
      (error: unknown) => error instanceof AppError && error.code === "VIDEOGEN_INVALID_RESPONSE",
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

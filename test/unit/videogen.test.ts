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

    const disabled = makeTestConfig(dir, { videoGen: { provider: "none" } });
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

test("HTTP 视频：识别聚合平台常见的嵌套与数组返回结构", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const bytes = await fs.readFile(clip);
  try {
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const run = async (pollPayload: unknown, resultPath = "") => {
      const config = makeTestConfig(dir);
      config.videoGen = {
        ...config.videoGen,
        provider: "http",
        baseUrl: "http://videogen.test",
        model: "happyhorse-1.1-t2v",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 40,
        timeoutMs: 5_000,
        clipDurationSec: 3,
        resultPath,
        fallbackToMaterials: true,
      };
      let submits = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          submits += 1;
          return json({ code: 0, data: { task_id: "task_nested" } });
        }
        if (url.includes("/v1/videos/generations/task_nested")) return json(pollPayload);
        if (url.endsWith("/files/clip.mp4")) return new Response(bytes, { status: 200 });
        return new Response("{}", { status: 404 });
      };
      const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });
      const generated = await provider.generate({ prompt: "城市夜景", durationSec: 3 }, path.join(dir, "gen"));
      return { generated, submits };
    };

    // tokease 风格：{code:0, data:{status:"completed", output:{video_url}}}
    const nested = await run({
      code: 0,
      message: "ok",
      data: { task_id: "task_nested", status: "completed", output: { video_url: "/files/clip.mp4" } },
    });
    assert.equal(nested.generated.durationSec > 0.5, true);
    assert.equal(nested.submits, 1);

    // 更深的嵌套与数组：data.task.result.videos[0].file_url
    const deep = await run({
      data: { task: { status: "succeeded", result: { videos: [{ file_url: "/files/clip.mp4" }] } } },
    });
    assert.equal(deep.generated.durationSec > 0.5, true);

    // 状态与地址都嵌在 data.result 下
    const inResult = await run({
      data: { result: { status: "SUCCESS", url: "/files/clip.mp4" } },
    });
    assert.equal(inResult.generated.durationSec > 0.5, true);

    // 封面/缩略图不会被误当成成片
    const withThumb = await run({
      data: {
        status: "completed",
        cover: { url: "/files/cover.jpg" },
        output: { video_url: "/files/clip.mp4" },
      },
    });
    assert.equal(withThumb.generated.durationSec > 0.5, true);

    // 结构完全自定义时，用「视频地址字段」点号路径兜底
    const custom = await run({ data: { weird: { addr: "/files/clip.mp4" } } }, "data.weird.addr");
    assert.equal(custom.generated.durationSec > 0.5, true);

    // 点号路径支持数组下标
    const indexed = await run(
      { content: { clips: [{ file: { link: "/files/clip.mp4" } }] } },
      "content.clips[0].file.link",
    );
    assert.equal(indexed.generated.durationSec > 0.5, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：任务完成却没解析到地址时，提示可配置视频地址字段", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir);
    config.videoGen = {
      ...config.videoGen,
      provider: "http",
      baseUrl: "http://videogen.test",
      model: "video-model",
      submitPath: "/v1/videos/generations",
      pollPath: "/v1/videos/generations/{id}",
      pollIntervalMs: 40,
      timeoutMs: 5_000,
      resultPath: "data.addr",
      fallbackToMaterials: true,
    };
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") return json({ task_id: "task-nourl" });
      if (url.includes("/v1/videos/generations/task-nourl")) {
        return json({ data: { status: "completed", weird: { somewhere: "/files/opaque-clip" } } });
      }
      return new Response("{}", { status: 404 });
    };
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });
    const error = await provider
      .generate({ prompt: "城市夜景", durationSec: 3 }, path.join(dir, "gen"))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "VIDEOGEN_INVALID_RESPONSE");
    assert.match(error.message, /没有可识别的视频地址/);
    assert.match(error.message, /视频地址字段/);
    // 响应结构摘要要出现，便于用户回报真实字段名。
    assert.match(error.message, /completed/);
    assert.match(error.message, /somewhere/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：阿里百炼 DashScope 协议提交与轮询", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const bytes = await fs.readFile(clip);
  try {
    const config = makeTestConfig(dir);
    config.videoGen = {
      ...config.videoGen,
      provider: "http",
      protocol: "auto",
      baseUrl: "https://dashscope.aliyuncs.com",
      model: "wan3.0-video",
      apiKey: "sk-bailian",
      submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
      pollPath: "/api/v1/tasks/{id}",
      pollIntervalMs: 40,
      timeoutMs: 5_000,
      clipDurationSec: 5,
      resultPath: "",
      fallbackToMaterials: true,
    };
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      if (init?.method === "POST") {
        return json({ output: { task_id: "task-dashscope", task_status: "PENDING" }, request_id: "req-1" });
      }
      if (url.includes("/api/v1/tasks/task-dashscope")) {
        return json({
          output: {
            task_id: "task-dashscope",
            task_status: "SUCCEEDED",
            video_url: "https://dashscope.aliyuncs.com/files/clip.mp4",
          },
          request_id: "req-1",
        });
      }
      if (url.endsWith("/files/clip.mp4")) return new Response(bytes, { status: 200 });
      return new Response("{}", { status: 404 });
    };
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });
    const generated = await provider.generate({ prompt: "一只橘猫在窗台上看雨", durationSec: 5 }, path.join(dir, "gen"));
    assert.equal(generated.durationSec > 0.5, true);

    // 提交协议：DashScope 异步头 + {model, input, parameters} 结构
    const submit = seen.find((item) => item.method === "POST");
    assert.ok(submit);
    assert.equal(submit.headers["X-DashScope-Async"], "enable");
    assert.equal(submit.headers.authorization, "Bearer sk-bailian");
    const body = JSON.parse(submit.body) as {
      model: string;
      input: { prompt: string };
      parameters: { duration: number; resolution?: string; ratio?: string; size?: string };
    };
    assert.equal(body.model, "wan3.0-video");
    assert.equal(body.input.prompt, "一只橘猫在窗台上看雨");
    assert.equal(body.parameters.duration, 5);
    // 万相 3.0 用 resolution + ratio，不再传 size
    assert.equal(body.parameters.resolution, "720P");
    assert.equal(body.parameters.ratio, "9:16");
    assert.equal(body.parameters.size, undefined);
    // 轮询只发一次，任务 ID 取自 output.task_id，状态取自 output.task_status
    const polls = seen.filter((item) => item.url.includes("/api/v1/tasks/"));
    assert.equal(polls.length, 1);
    // 任务查询是同步接口，不能带异步头
    assert.equal(polls[0]!.headers["X-DashScope-Async"], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
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

test("HTTP 视频：平台报错时给出可执行的提示", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        timeoutMs: 5_000,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: "InvalidParameter", message: "duration is invalid", request_id: "r1" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    await assert.rejects(
      provider.generate({ prompt: "城市夜景", durationSec: 3 }, path.join(dir, "gen")),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /InvalidParameter/);
        assert.match(error.message, /duration is invalid/);
        assert.match(error.message, /5 秒/);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：百炼地址即使协议误设为通用，也按异步接口发送", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const bytes = await fs.readFile(clip);
  try {
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const runCase = async (overrides: Record<string, string>) => {
      const config = makeTestConfig(dir, {
        videoGen: {
          provider: "http",
          protocol: "generic",
          baseUrl: "https://dashscope.aliyuncs.com",
          model: "wan3.0-video",
          apiKey: "sk-test",
          submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
          pollPath: "/api/v1/tasks/{id}",
          pollIntervalMs: 200,
          timeoutMs: 5_000,
          ...overrides,
        },
      });
      const seen: Array<{ headers: Record<string, string>; body: string }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          seen.push({
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: String(init?.body ?? ""),
          });
          return json({ output: { task_id: "task-sync-check", task_status: "PENDING" } });
        }
        if (url.includes("/api/v1/tasks/task-sync-check")) {
          return json({
            output: { task_status: "SUCCEEDED", video_url: "https://dashscope.aliyuncs.com/files/clip.mp4" },
          });
        }
        if (url.endsWith("/files/clip.mp4")) return new Response(bytes, { status: 200 });
        return new Response("{}", { status: 404 });
      };
      const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });
      await provider.generate({ prompt: "城市夜景", durationSec: 5 }, path.join(dir, "gen"));
      return seen[0];
    };

    // 协议写错成“通用”，但地址是百炼：仍要带 X-DashScope-Async 与 {model,input,parameters}
    const byHost = await runCase({});
    assert.equal(byHost.headers["X-DashScope-Async"], "enable");
    const hostBody = JSON.parse(byHost.body) as { input?: { prompt?: string } };
    assert.equal(hostBody.input?.prompt, "城市夜景");

    // 自定义域名 + 百炼提交路径：同样按异步发送
    const byPath = await runCase({
      baseUrl: "https://video-gateway.example.com",
      submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
    });
    assert.equal(byPath.headers["X-DashScope-Async"], "enable");
    const pathBody = JSON.parse(byPath.body) as { input?: { prompt?: string } };
    assert.equal(pathBody.input?.prompt, "城市夜景");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：同步调用被拒时提示需要异步头", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        timeoutMs: 5_000,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: "AccessDenied",
            message: "current user api does not support synchronous calls",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    });
    await assert.rejects(
      provider.generate({ prompt: "城市夜景", durationSec: 5 }, path.join(dir, "gen")),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /X-DashScope-Async/);
        assert.match(error.message, /异步/);
        // 同步调用被拒不是密钥问题，不该给“API Key 无效”的错误建议
        assert.doesNotMatch(error.message, /API Key 无效/);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 文生视频：平台只支持同步时自动去掉异步头重试", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const posts: Array<{ async: string | undefined; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (req.method === "POST") {
      posts.push({
        async: req.headers["x-dashscope-async"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.headers["x-dashscope-async"]) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "AccessDenied",
            message: "current user api does not support asynchronous calls",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { video_url: "/files/clip.mp4" } }));
      return;
    }
    if (url.pathname === "/files/clip.mp4") {
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
        model: "wan-sync-only",
        apiKey: "sk-test",
        // 路径是百炼视频接口 → 默认带异步头，但平台说只支持同步。
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
        clipDurationSec: 5,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger);
    const generated = await provider.generate({ prompt: "同步出片", durationSec: 5 }, path.join(dir, "gen"));
    assert.equal(generated.durationSec > 0.5, true);
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.async, "enable");
    assert.equal(posts[1]!.async, undefined);
    // 两次都按百炼的 {model, input, parameters} 组装，只是请求头不同。
    const body = JSON.parse(posts[1]!.body) as { model: string; input: { prompt: string } };
    assert.equal(body.model, "wan-sync-only");
    assert.equal(body.input.prompt, "同步出片");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

test("HTTP 文生视频：平台要求异步时自动补上 X-DashScope-Async 重试", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const posts: Array<string | undefined> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (req.method === "POST") {
      posts.push(req.headers["x-dashscope-async"] as string | undefined);
      if (!req.headers["x-dashscope-async"]) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "AccessDenied",
            message: "current user api does not support synchronous calls",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ video_url: "/files/clip.mp4" }));
      return;
    }
    if (url.pathname === "/files/clip.mp4") {
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
        // 通用协议本来不带异步头，平台却要求异步。
        protocol: "generic",
        model: "generic-model",
        apiKey: "sk-test",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
        clipDurationSec: 5,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger);
    const generated = await provider.generate({ prompt: "异步出片", durationSec: 5 }, path.join(dir, "gen"));
    assert.equal(generated.durationSec > 0.5, true);
    assert.equal(posts.length, 2);
    assert.equal(posts[0], undefined);
    assert.equal(posts[1], "enable");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});


test("HTTP 视频：万相 3.0 的图生视频首帧走 media[type=first_frame]", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const bytes = await fs.readFile(clip);
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        protocol: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
      },
    });
    const hero = path.join(dir, "cast", "hero.png");
    await fs.mkdir(path.dirname(hero), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x884466:s=64x64", "-frames:v", "1", hero]);
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ output: { task_id: "task-wan3", task_status: "PENDING" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(input).endsWith("/files/clip.mp4")) return new Response(bytes, { status: 200 });
      return new Response(
        JSON.stringify({
          output: { task_status: "SUCCEEDED", video_url: "https://dashscope.aliyuncs.com/files/clip.mp4" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });
    await provider.generate({ prompt: "雨夜街道", durationSec: 5, image: hero }, path.join(dir, "gen"));

    const input = body?.input as { media?: Array<{ type: string; url: string }>; img_url?: string };
    const parameters = body?.parameters as { resolution?: string; ratio?: string; duration?: number };
    assert.equal(parameters.resolution, "720P");
    assert.equal(parameters.ratio, "9:16");
    assert.equal(parameters.duration, 5);
    assert.equal(input.media?.[0]?.type, "first_frame");
    assert.match(String(input.media?.[0]?.url), /^data:image\/png;base64,/);
    assert.equal(input.img_url, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：异步调用被拒时提示改回同步协议", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        timeoutMs: 5_000,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: "AccessDenied", message: "current user api does not support asynchronous calls" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    });
    await assert.rejects(
      provider.generate({ prompt: "城市夜景", durationSec: 5 }, path.join(dir, "gen")),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /同步/);
        assert.doesNotMatch(error.message, /需要请求头 X-DashScope-Async: enable/);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：提交成功但查询被拒时，保留任务 ID 交给调用方续查", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        protocol: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5_000,
      },
    });
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, {
      fetchImpl: async (input, init) => {
        if ((init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ output: { task_id: "task-poll-denied", task_status: "PENDING" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ code: "AccessDenied", message: "current user api does not support asynchronous calls" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      },
    });
    await assert.rejects(
      provider.generate({ prompt: "城市夜景", durationSec: 5 }, path.join(dir, "gen")),
      (error: unknown) => {
        assert.ok(error instanceof VideoGenPendingError, `应保留任务，实际：${String(error)}`);
        assert.equal(error.taskId, "task-poll-denied");
        assert.equal(error.submitted, true);
        assert.match(error.message, /task-poll-denied/);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：万相 3.0 把角色库参考图放进 media[type=reference_image]", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const bytes = await fs.readFile(clip);
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        protocol: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
      },
    });
    const hero = path.join(dir, "cast", "hero.png");
    const extra = path.join(dir, "cast", "cafe.png");
    await fs.mkdir(path.dirname(hero), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x884466:s=64x64", "-frames:v", "1", hero]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x223344:s=64x64", "-frames:v", "1", extra]);
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ output: { task_id: "task-wan3-ref", task_status: "PENDING" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(input).endsWith("/files/clip.mp4")) return new Response(bytes, { status: 200 });
      return new Response(
        JSON.stringify({
          output: { task_status: "SUCCEEDED", video_url: "https://dashscope.aliyuncs.com/files/clip.mp4" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });
    await provider.generate(
      {
        prompt: "女主在咖啡馆说话",
        durationSec: 5,
        image: hero,
        references: [
          { role: "character", name: "女主", file: hero },
          { role: "scene", name: "咖啡馆", file: extra },
        ],
      },
      path.join(dir, "gen"),
    );

    const input = body?.input as {
      media?: Array<{ type: string; url: string }>;
      img_url?: string;
    };
    const media = input.media ?? [];
    assert.equal(media.length, 2, "两张角色/场景参考图都要传给平台");
    assert.equal(media.every((item) => item.type === "reference_image"), true);
    assert.match(String(media[0]?.url), /^data:image\/png;base64,/);
    // 首帧与参考图互斥：有参考图时不再单独传 first_frame，避免平台报错。
    assert.equal(media.some((item) => item.type === "first_frame"), false);
    assert.equal(input.img_url, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HTTP 视频：没有参考图时万相 3.0 仍用首帧，且参考图最多 10 张", async () => {
  const dir = await makeTempDir();
  const clip = path.join(dir, "clip.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });
  const bytes = await fs.readFile(clip);
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        protocol: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com",
        model: "wan3.0-video",
        apiKey: "sk-test",
        submitPath: "/api/v1/services/aigc/video-generation/video-synthesis",
        pollPath: "/api/v1/tasks/{id}",
        pollIntervalMs: 200,
        timeoutMs: 10_000,
      },
    });
    const hero = path.join(dir, "cast", "hero.png");
    await fs.mkdir(path.dirname(hero), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x884466:s=64x64", "-frames:v", "1", hero]);
    const bodies: Array<Record<string, unknown>> = [];
    let taskSeq = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        taskSeq += 1;
        return new Response(
          JSON.stringify({ output: { task_id: `task-${taskSeq}`, task_status: "PENDING" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(input).endsWith("/files/clip.mp4")) return new Response(bytes, { status: 200 });
      return new Response(
        JSON.stringify({
          output: { task_status: "SUCCEEDED", video_url: "https://dashscope.aliyuncs.com/files/clip.mp4" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new HttpVideoGenProvider(config.videoGen, silentLogger, { fetchImpl });

    await provider.generate({ prompt: "无参考图", durationSec: 5, image: hero }, path.join(dir, "gen"));
    const first = (bodies[0]?.input as { media?: Array<{ type: string }> }).media ?? [];
    assert.equal(first[0]?.type, "first_frame");

    // 12 张参考图只发前 10 张（平台上限）。
    const many = Array.from({ length: 12 }, (_, index) => ({
      role: "character",
      name: `角色${index + 1}`,
      file: hero,
    }));
    await provider.generate(
      { prompt: "参考图超限", durationSec: 5, references: many },
      path.join(dir, "gen"),
    );
    const second = (bodies[1]?.input as { media?: Array<{ type: string }> }).media ?? [];
    assert.equal(second.length, 10);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


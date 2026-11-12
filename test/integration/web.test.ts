import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import {
  generateTestClip,
  generateTestImage,
  makeTempDir,
  makeTestConfig,
  setupTestAdmin,
  withCookie,
} from "../helpers.js";

const WEB_DIR = path.resolve(fileURLToPath(new URL("../../web", import.meta.url)));

interface DouyinMock {
  url: string;
  calls: Array<{ path: string; query: URLSearchParams; contentType: string }>;
  close(): Promise<void>;
}

async function startDouyinMock(): Promise<DouyinMock> {
  const calls: DouyinMock["calls"] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    calls.push({
      path: url.pathname,
      query: url.searchParams,
      contentType: String(req.headers["content-type"] ?? ""),
    });
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/oauth/client_token/") {
      send({ data: { access_token: "client-token-1", expires_in: 7200, error_code: 0 } });
      return;
    }
    if (url.pathname === "/oauth/access_token/" || url.pathname === "/oauth/refresh_token/") {
      send({
        data: {
          access_token: "access-1",
          refresh_token: "refresh-1",
          open_id: "open-1",
          scope: "user_info,video.create",
          expires_in: 3600,
          refresh_expires_in: 7200,
          error_code: 0,
        },
      });
      return;
    }
    if (url.pathname === "/oauth/userinfo/") {
      send({ data: { nickname: "测试抖音号", avatar: "", error_code: 0 } });
      return;
    }
    if (url.pathname === "/api/douyin/v1/video/upload_video/") {
      send({ data: { error_code: 0, video: { video_id: "video-1" } } });
      return;
    }
    if (url.pathname === "/api/douyin/v1/video/create_video/") {
      send({ data: { error_code: 0, item_id: "item-1" } });
      return;
    }
    send({ data: { error_code: 404, description: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

interface VideoGenMock {
  url: string;
  calls: Array<{ method: string; path: string; body: string; authorization: string }>;
  close(): Promise<void>;
}

async function startVideoGenMock(clipPath: string): Promise<VideoGenMock> {
  const calls: VideoGenMock["calls"] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    calls.push({
      method: req.method ?? "GET",
      path: url.pathname,
      body: Buffer.concat(chunks).toString("utf8"),
      authorization: String(req.headers.authorization ?? ""),
    });
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === "/v1/videos/generations") {
      send({ task_id: "task-1" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/generations/task-1") {
      // 聚合平台常见的嵌套结构：状态与成片地址都在 data.output 下。
      send({ code: 0, message: "ok", data: { task_id: "task-1", status: "completed", output: { video_url: "/files/clip.mp4" } } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/files/clip.mp4") {
      const buffer = await fs.readFile(clipPath);
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
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function jsonRequest(
  requestImpl: typeof fetch,
  url: string,
  body: unknown,
  method = "POST",
): Promise<Response> {
  return requestImpl(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "网页与 API：静态资源、设置、素材、脚本预览、任务与抖音发布",
  { timeout: 240_000 },
  async (t) => {
    const dir = await makeTempDir();
    const douyin = await startDouyinMock();
    const videoGenClip = path.join(dir, "source", "settings-test-source.mp4");
    await generateTestClip(videoGenClip, { durationSec: 1, size: "160x160" });
    const videoGen = await startVideoGenMock(videoGenClip);
    const config = makeTestConfig(dir, {
      server: { port: 0 },
      douyin: {
        clientKey: "client-key",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/api/douyin/callback",
        scope: "user_info,video.create",
        apiBaseUrl: douyin.url,
      },
    });
    const app = await startServer(config, silentLogger, { cwd: dir, env: {}, webDir: WEB_DIR });
    t.after(async () => {
      await app.close();
      await douyin.close();
      await videoGen.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const session = await setupTestAdmin(app.url);
    const request = withCookie(session.cookie);

    const home = await request(`${app.url}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await home.text(), /视频创作智能体/);

    const css = await request(`${app.url}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    const script = await request(`${app.url}/js/app.js`);
    assert.equal(script.status, 200);
    const scriptText = await script.text();
    assert.match(scriptText, /renderCreate/);
    assert.match(scriptText, /renderAuth/);
    assert.match(scriptText, /usersCardHtml/);
    assert.match(scriptText, /data-test="videogen"/);
    assert.match(scriptText, /data-resume="videogen"/);
    assert.match(scriptText, /videogen-test-task/);
    assert.match(scriptText, /data-test="douyin"/);

    const apiIndex = (await (await request(`${app.url}/api`)).json()) as { name: string; endpoints: unknown };
    assert.equal(apiIndex.name, "video-agent");
    assert.ok(apiIndex.endpoints);

    const settingsResponse = await request(`${app.url}/api/settings`);
    const initial = (await settingsResponse.json()) as {
      settings: { script: { apiKeySet: boolean; provider: string; model: string } };
    };
    assert.equal(initial.settings.script.apiKeySet, false);
    assert.equal(initial.settings.script.provider, "offline");

    const putResponse = await jsonRequest(request, `${app.url}/api/settings`, {
      script: { provider: "offline", model: "ui-model" },
      tts: { provider: "silent" },
    }, "PUT");
    assert.equal(putResponse.status, 200, await putResponse.clone().text());
    const updated = (await putResponse.json()) as {
      settings: { script: { model: string }; tts: { provider: string } };
    };
    assert.equal(updated.settings.script.model, "ui-model");
    assert.equal(updated.settings.tts.provider, "silent");
    assert.equal(config.script.model, "ui-model");

    const secretPut = await jsonRequest(request, `${app.url}/api/settings`, {
      script: { apiKey: "sk-test-abcdef" },
    }, "PUT");
    assert.equal(secretPut.status, 200);
    const settingsText = await (await request(`${app.url}/api/settings`)).text();
    assert.equal(settingsText.includes("sk-test-abcdef"), false);
    assert.equal(settingsText.includes('"apiKeySet": true'), true);

    const invalid = await jsonRequest(request, `${app.url}/api/settings`, {
      videoGen: { provider: "http", pollPath: "/api/v1/tasks" },
    }, "PUT");
    assert.equal(invalid.status, 400);

    const scriptTest = await jsonRequest(request, `${app.url}/api/settings/test`, { kind: "script" });
    assert.equal(scriptTest.status, 200);
    assert.equal(((await scriptTest.json()) as { provider: string }).provider, "offline");
    const ttsTest = await jsonRequest(request, `${app.url}/api/settings/test`, { kind: "tts" });
    assert.equal(ttsTest.status, 200);
    const ttsResult = (await ttsTest.json()) as { provider: string; durationSec: number };
    assert.equal(ttsResult.provider, "silent");
    assert.equal(ttsResult.durationSec >= 0, true);

    const disabledVideoGen = await jsonRequest(request, `${app.url}/api/settings/test`, { kind: "videogen" });
    assert.equal(disabledVideoGen.status, 400);

    const videoGenPut = await jsonRequest(request, `${app.url}/api/settings`, {
      videoGen: {
        provider: "http",
        baseUrl: videoGen.url,
        model: "test-model",
        apiKey: "videogen-key",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5000,
        clipDurationSec: 2,
      },
    }, "PUT");
    assert.equal(videoGenPut.status, 200, await videoGenPut.clone().text());
    const videoGenTest = await jsonRequest(request, `${app.url}/api/settings/test`, {
      kind: "videogen",
      prompt: "一只橘猫在窗台上看雨",
      durationSec: 3,
    });
    assert.equal(videoGenTest.status, 200, await videoGenTest.clone().text());
    const videoGenResult = (await videoGenTest.json()) as {
      provider: string;
      model: string;
      prompt: string;
      durationSec: number;
      videoUrl: string;
    };
    assert.equal(videoGenResult.provider, "http");
    assert.equal(videoGenResult.model, "test-model");
    assert.equal(videoGenResult.prompt, "一只橘猫在窗台上看雨");
    assert.equal(videoGenResult.durationSec > 0.5, true);
    assert.match(videoGenResult.videoUrl, /^\/api\/settings\/test\/video\/[a-zA-Z0-9_-]+\.mp4$/);
    const submitCall = videoGen.calls.find((call) => call.method === "POST");
    assert.ok(submitCall);
    assert.equal(submitCall.authorization, "Bearer videogen-key");
    const submitBody = JSON.parse(submitCall.body) as { prompt: string; duration_sec: number };
    assert.equal(submitBody.prompt, "一只橘猫在窗台上看雨");
    assert.equal(submitBody.duration_sec, 3);

    const testVideo = await request(`${app.url}${videoGenResult.videoUrl}`);
    assert.equal(testVideo.status, 200);
    assert.equal(testVideo.headers.get("content-type"), "video/mp4");
    assert.equal((await testVideo.arrayBuffer()).byteLength > 0, true);
    const anonymousVideo = await fetch(`${app.url}${videoGenResult.videoUrl}`);
    assert.equal(anonymousVideo.status, 401);

    const badDuration = await jsonRequest(request, `${app.url}/api/settings/test`, {
      kind: "videogen",
      durationSec: 4,
    });
    assert.equal(badDuration.status, 400);

    // 测试完成后关闭 AI 画面，避免影响后面的完整任务流程。
    const videoGenReset = await jsonRequest(request, `${app.url}/api/settings`, {
      videoGen: { provider: "none" },
    }, "PUT");
    assert.equal(videoGenReset.status, 200, await videoGenReset.clone().text());

    const douyinTest = await jsonRequest(request, `${app.url}/api/settings/test`, { kind: "douyin" });
    assert.equal(douyinTest.status, 200, await douyinTest.clone().text());
    const douyinTestResult = (await douyinTest.json()) as { expiresInSec: number; authorized: boolean };
    assert.equal(douyinTestResult.expiresInSec, 7200);
    assert.equal(douyinTestResult.authorized, false);
    assert.equal(douyin.calls.some((call) => call.path === "/oauth/client_token/"), true);

    const clip = path.join(dir, "source", "city-night.mp4");
    await generateTestClip(clip, { durationSec: 1.5, size: "160x160" });
    const form = new FormData();
    form.append("file", new Blob([await fs.readFile(clip)], { type: "video/mp4" }), "city-night.mp4");
    form.append("tags", "城市,夜景");
    form.append("title", "城市夜景空镜");
    const uploadResponse = await request(`${app.url}/api/materials`, { method: "POST", body: form });
    assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
    const uploaded = (await uploadResponse.json()) as {
      material: { id: string; tags: string[]; url: string };
    };
    assert.equal(uploaded.material.tags.includes("城市"), true);
    assert.equal(uploaded.material.tags.some((tag) => /^[0-9a-f]{6}$/.test(tag)), false);

    const imagePath = path.join(dir, "source", "城市夜景.jpg");
    await generateTestImage(imagePath);
    const imageForm = new FormData();
    imageForm.append("file", new Blob([await fs.readFile(imagePath)], { type: "image/jpeg" }), "城市夜景.jpg");
    imageForm.append("title", "城市夜景海报");
    const imageUpload = await request(`${app.url}/api/materials`, { method: "POST", body: imageForm });
    assert.equal(imageUpload.status, 201, await imageUpload.clone().text());
    const imageMaterial = (await imageUpload.json()) as { material: { tags: string[] } };
    assert.equal(imageMaterial.material.tags.includes("城市夜景"), true);
    assert.equal(imageMaterial.material.tags.some((tag) => tag.includes("å")), false);

    const fileResponse = await request(`${app.url}${uploaded.material.url}`, {
      headers: { range: "bytes=0-99" },
    });
    assert.equal(fileResponse.status, 206);
    assert.equal(fileResponse.headers.get("content-type"), "video/mp4");
    assert.equal((await fileResponse.arrayBuffer()).byteLength, 100);

    const previewResponse = await jsonRequest(request, `${app.url}/api/scripts/generate`, {
      topic: "城市夜景",
      targetDurationSec: 10,
      maxSegments: 2,
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as {
      script: { segments: Array<{ narration: string; keywords: string[] }> };
      provider: string;
    };
    assert.equal(preview.provider, "offline");
    assert.equal(preview.script.segments.length, 2);

    const createResponse = await jsonRequest(request, `${app.url}/api/videos`, {
      topic: "城市夜景",
      targetDurationSec: 10,
      maxSegments: 2,
      ttsProvider: "silent",
      subtitlesEnabled: true,
    });
    assert.equal(createResponse.status, 202, await createResponse.clone().text());
    const created = (await createResponse.json()) as { id: string };
    let job: {
      id: string;
      state: string;
      error?: string;
      videoUrl?: string;
      posterUrl?: string;
      script?: { title: string };
      segments?: Array<{ source: string; material: unknown }>;
    } = created as never;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      job = (await (await request(`${app.url}/api/videos/${created.id}`)).json()) as typeof job;
      if (job.state === "succeeded" || job.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(job.state, "succeeded", job.error);
    assert.ok(job.script?.title);
    assert.equal(job.segments?.length, 2);
    assert.equal(job.segments?.[0]?.source, "material");
    assert.ok(job.segments?.[0]?.material);

    const videoRange = await request(`${app.url}${job.videoUrl}`, { headers: { range: "bytes=0-99" } });
    assert.equal(videoRange.status, 206);
    assert.equal((await videoRange.arrayBuffer()).byteLength, 100);

    assert.ok(job.posterUrl);
    const poster = await request(`${app.url}${job.posterUrl}`);
    assert.equal(poster.status, 200);
    assert.equal(poster.headers.get("content-type"), "image/jpeg");
    assert.equal((await poster.arrayBuffer()).byteLength > 500, true);

    const douyinStatus = (await (await request(`${app.url}/api/douyin/status`)).json()) as {
      configured: boolean;
      authorized: boolean;
    };
    assert.equal(douyinStatus.configured, true);
    assert.equal(douyinStatus.authorized, false);

    const authorize = (await (await request(`${app.url}/api/douyin/authorize`)).json()) as { url: string };
    const state = new URL(authorize.url).searchParams.get("state");
    assert.ok(state);
    const callback = await request(`${app.url}/api/douyin/callback?code=code-1&state=${state}`, {
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") ?? "", /douyin=connected/);

    const authorized = (await (await request(`${app.url}/api/douyin/status`)).json()) as {
      authorized: boolean;
      token?: { nickname?: string };
    };
    assert.equal(authorized.authorized, true);
    assert.equal(authorized.token?.nickname, "测试抖音号");

    const publishResponse = await jsonRequest(request, `${app.url}/api/videos/${job.id}/publish`, {
      text: "城市夜景测试",
      coverTsp: 1000,
    });
    assert.equal(publishResponse.status, 201, await publishResponse.clone().text());
    const published = (await publishResponse.json()) as { publish: { itemId: string; videoId: string } };
    assert.equal(published.publish.itemId, "item-1");
    assert.equal(published.publish.videoId, "video-1");

    const publishes = (await (await request(`${app.url}/api/publishes`)).json()) as {
      publishes: Array<{ itemId: string }>;
    };
    assert.equal(publishes.publishes.length, 1);
    assert.equal(publishes.publishes[0]!.itemId, "item-1");

    await request(`${app.url}/api/douyin/disconnect`, { method: "POST" });
    const publishAgain = await jsonRequest(request, `${app.url}/api/videos/${job.id}/publish`, {
      text: "再次发布",
    });
    assert.equal(publishAgain.status, 401);
  },
);

interface SlowVideoGenMock {
  url: string;
  state: { done: boolean; submits: number; polls: number };
  close(): Promise<void>;
}

/** 第一次查询一直“生成中”，用于验证超时后复用任务而不是重新提交。 */
async function startSlowVideoGenMock(clipPath: string): Promise<SlowVideoGenMock> {
  const state = { done: false, submits: 0, polls: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === "/v1/videos/generations") {
      state.submits += 1;
      send({ task_id: "task-slow" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/generations/task-slow") {
      state.polls += 1;
      send(
        state.done
          ? { data: { status: "succeeded", video_url: "/files/clip.mp4" } }
          : { data: { status: "running" } },
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/files/clip.mp4") {
      const buffer = await fs.readFile(clipPath);
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
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

test(
  "网页与 API：AI 画面测试超时后复用已提交任务，不重复扣费",
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir();
    const clip = path.join(dir, "source", "slow-source.mp4");
    await generateTestClip(clip, { durationSec: 1, size: "160x160" });
    const mock = await startSlowVideoGenMock(clip);
    const config = makeTestConfig(dir, {
      server: { port: 0 },
      videoGen: {
        provider: "http",
        baseUrl: mock.url,
        model: "slow-model",
        apiKey: "slow-key",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5_000,
        clipDurationSec: 3,
      },
    });
    const app = await startServer(config, silentLogger, { cwd: dir, env: {}, webDir: WEB_DIR });
    t.after(async () => {
      await app.close();
      await mock.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const session = await setupTestAdmin(app.url);
    const request = withCookie(session.cookie);
    const payload = { kind: "videogen", prompt: "一只慢动作的猫", durationSec: 3 };

    const first = await jsonRequest(request, `${app.url}/api/settings/test`, payload);
    assert.equal(first.status, 200, await first.clone().text());
    const firstResult = (await first.json()) as {
      ok: boolean;
      pending: boolean;
      submitted: boolean;
      taskId: string | null;
      message: string;
    };
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.pending, true);
    assert.equal(firstResult.submitted, true);
    assert.equal(firstResult.taskId, "task-slow");
    assert.match(firstResult.message, /已提交/);
    assert.equal(mock.state.submits, 1);

    // 同样的描述与时长再点一次：复用原任务，不产生第二次提交（也就不会重复扣费）。
    const resumed = await jsonRequest(request, `${app.url}/api/settings/test`, payload);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const resumedPending = (await resumed.json()) as { pending: boolean; reused: boolean; taskId: string };
    assert.equal(resumedPending.pending, true);
    assert.equal(resumedPending.reused, true);
    assert.equal(mock.state.submits, 1);

    // 任务在平台侧完成后再点一次：返回同一条任务的成片。
    mock.state.done = true;
    const done = await jsonRequest(request, `${app.url}/api/settings/test`, payload);
    assert.equal(done.status, 200, await done.clone().text());
    const doneResult = (await done.json()) as {
      pending?: boolean;
      reused: boolean;
      videoUrl: string;
      durationSec: number;
    };
    assert.equal(doneResult.pending, undefined);
    assert.equal(doneResult.reused, true);
    assert.match(doneResult.videoUrl, /^\/api\/settings\/test\/video\//);
    assert.equal(doneResult.durationSec > 0.5, true);
    assert.equal(mock.state.submits, 1);

    const video = await request(`${app.url}${doneResult.videoUrl}`);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");

    // 也可以直接按任务 ID 取回（用于平台侧已生成、但本地记录丢失的场景）。
    const byId = await jsonRequest(request, `${app.url}/api/settings/test`, {
      kind: "videogen",
      resumeTaskId: "task-slow",
    });
    assert.equal(byId.status, 200, await byId.clone().text());
    const byIdResult = (await byId.json()) as { reused: boolean; videoUrl: string; pending?: boolean };
    assert.equal(byIdResult.pending, undefined);
    assert.equal(byIdResult.reused, true);
    assert.match(byIdResult.videoUrl, /^\/api\/settings\/test\/video\//);
    assert.equal(mock.state.submits, 1);
  },
);

test(
  "网页与 API：同一测试并发请求只提交一次，避免平台重复扣费",
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir();
    const clip = path.join(dir, "source", "slow-source.mp4");
    await generateTestClip(clip, { durationSec: 1, size: "160x160" });
    const mock = await startSlowVideoGenMock(clip);
    const config = makeTestConfig(dir, {
      server: { port: 0 },
      videoGen: {
        provider: "http",
        baseUrl: mock.url,
        model: "slow-model",
        apiKey: "slow-key",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
        pollIntervalMs: 200,
        timeoutMs: 5_000,
        clipDurationSec: 3,
      },
    });
    const app = await startServer(config, silentLogger, { cwd: dir, env: {}, webDir: WEB_DIR });
    t.after(async () => {
      await app.close();
      await mock.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const session = await setupTestAdmin(app.url);
    const request = withCookie(session.cookie);
    const payload = { kind: "videogen", prompt: "同一个提示词", durationSec: 3 };

    // 连点两下 / 两个标签页同时点：两次请求共享同一次提交。
    const [a, b] = await Promise.all([
      jsonRequest(request, `${app.url}/api/settings/test`, payload),
      jsonRequest(request, `${app.url}/api/settings/test`, payload),
    ]);
    assert.equal(a.status, 200, await a.clone().text());
    assert.equal(b.status, 200, await b.clone().text());
    const first = (await a.json()) as { pending: boolean; taskId: string };
    const second = (await b.json()) as { pending: boolean; taskId: string };
    assert.equal(first.taskId, "task-slow");
    assert.equal(second.taskId, "task-slow");
    assert.equal(mock.state.submits, 1, "并发测试请求不应重复提交到平台");
  },
);

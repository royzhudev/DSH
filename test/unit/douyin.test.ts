import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { DouyinClient } from "../../src/publish/douyin.js";
import { AppError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import type { DouyinToken } from "../../src/types.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

interface MockServer {
  url: string;
  calls: Array<{ method: string; path: string; query: URLSearchParams; body: Buffer; contentType: string }>;
  close(): Promise<void>;
}

async function startMock(options: { failCreate?: boolean } = {}): Promise<MockServer> {
  const calls: MockServer["calls"] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body,
      contentType: String(req.headers["content-type"] ?? ""),
    });
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/oauth/access_token/") {
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
    if (url.pathname === "/oauth/refresh_token/") {
      send({
        data: {
          access_token: "access-2",
          refresh_token: "refresh-2",
          open_id: "open-1",
          scope: "user_info,video.create",
          expires_in: 7200,
          error_code: 0,
        },
      });
      return;
    }
    if (url.pathname === "/oauth/userinfo/") {
      send({ data: { nickname: "测试抖音号", avatar: "https://example.com/avatar.png", error_code: 0 } });
      return;
    }
    if (url.pathname === "/api/douyin/v1/video/upload_video/") {
      send({ data: { error_code: 0, video: { video_id: "video-1" } } });
      return;
    }
    if (url.pathname === "/api/douyin/v1/video/create_video/") {
      if (options.failCreate) {
        send({ data: { error_code: 10001, description: "视频不存在" } });
        return;
      }
      send({ data: { error_code: 0, item_id: "item-1" } });
      return;
    }
    send({ data: { error_code: 404, description: "not found" } }, 404);
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

function makeClient(dir: string, apiBaseUrl: string): DouyinClient {
  const config = makeTestConfig(dir, {
    douyin: {
      clientKey: "client-key",
      clientSecret: "client-secret",
      redirectUri: "http://127.0.0.1:8787/api/douyin/callback",
      scope: "user_info,video.create",
      apiBaseUrl,
    },
  });
  return new DouyinClient(config, silentLogger);
}

test("抖音授权 URL 与令牌交换、刷新、用户信息", async () => {
  const dir = await makeTempDir();
  const mock = await startMock();
  try {
    const client = makeClient(dir, mock.url);
    assert.equal(client.configured, true);
    const url = new URL(client.authorizeUrl("state-1"));
    assert.equal(url.searchParams.get("client_key"), "client-key");
    assert.equal(url.searchParams.get("state"), "state-1");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/api/douyin/callback");
    assert.equal(url.searchParams.get("scope"), "user_info,video.create");

    const token = await client.exchangeCode("code-1");
    assert.equal(token.accessToken, "access-1");
    assert.equal(token.refreshToken, "refresh-1");
    assert.equal(token.openId, "open-1");
    assert.equal(Date.parse(token.expiresAt) > Date.now(), true);

    const refreshed = await client.refresh(token);
    assert.equal(refreshed.accessToken, "access-2");
    assert.equal(refreshed.refreshToken, "refresh-2");

    const info = await client.fetchUserInfo(refreshed);
    assert.equal(info.nickname, "测试抖音号");
    assert.equal(info.avatar, "https://example.com/avatar.png");
    const infoCall = mock.calls.find((call) => call.path === "/oauth/userinfo/");
    assert.ok(infoCall);
    assert.equal(infoCall.method, "GET");
    assert.equal(infoCall.query.get("access_token"), "access-2");
    assert.equal(infoCall.query.get("open_id"), "open-1");

    const tokenCall = mock.calls.find((call) => call.path === "/oauth/access_token/");
    assert.ok(tokenCall);
    assert.match(tokenCall.contentType, /application\/json/);
    assert.equal(JSON.parse(tokenCall.body.toString("utf8")).code, "code-1");
  } finally {
    await mock.close();
  }
});

test("抖音发布：上传视频并创建作品", async () => {
  const dir = await makeTempDir();
  const mock = await startMock();
  try {
    const clip = path.join(dir, "video.mp4");
    await generateTestClip(clip, { durationSec: 0.6, size: "120x120" });
    const client = makeClient(dir, mock.url);
    const token: DouyinToken = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      openId: "open-1",
      scope: "user_info,video.create",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await client.publish(
      token,
      { id: "job-1", topic: "城市夜景", videoPath: clip },
      { text: "城市夜景 #测试", coverTsp: 1500 },
    );
    assert.equal(result.record.itemId, "item-1");
    assert.equal(result.record.videoId, "video-1");
    assert.equal(result.record.jobId, "job-1");

    const upload = mock.calls.find((call) => call.path === "/api/douyin/v1/video/upload_video/");
    assert.ok(upload);
    assert.equal(upload.query.get("open_id"), "open-1");
    assert.equal(upload.query.get("access_token"), "access-1");
    assert.match(upload.contentType, /multipart\/form-data/);
    assert.equal(upload.body.includes(Buffer.from("video.mp4")), true);

    const create = mock.calls.find((call) => call.path === "/api/douyin/v1/video/create_video/");
    assert.ok(create);
    const createBody = JSON.parse(create.body.toString("utf8"));
    assert.equal(createBody.video_id, "video-1");
    assert.equal(createBody.text, "城市夜景 #测试");
    assert.equal(createBody.cover_tsp, 1500);
  } finally {
    await mock.close();
  }
});

test("抖音未配置或接口报错时给出明确错误", async () => {
  const dir = await makeTempDir();
  const unconfigured = new DouyinClient(makeTestConfig(dir), silentLogger);
  assert.equal(unconfigured.configured, false);
  assert.throws(
    () => unconfigured.authorizeUrl("state"),
    (error: unknown) => error instanceof AppError && error.code === "DOUYIN_NOT_CONFIGURED",
  );

  const mock = await startMock({ failCreate: true });
  try {
    const client = makeClient(dir, mock.url);
    const token: DouyinToken = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      openId: "open-1",
      scope: "user_info,video.create",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const clip = path.join(dir, "video.mp4");
    await generateTestClip(clip, { durationSec: 0.5, size: "120x120" });
    await assert.rejects(
      client.publish(token, { id: "job-1", topic: "主题", videoPath: clip }, { text: "标题" }),
      (error: unknown) => error instanceof AppError && error.code === "DOUYIN_API_ERROR",
    );
  } finally {
    await mock.close();
  }
});

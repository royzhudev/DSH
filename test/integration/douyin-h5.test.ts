import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { loginTestUser, makeTempDir, makeTestConfig, setupTestAdmin, withCookie } from "../helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startDouyinMock(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const send = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/oauth/client_token/") {
      send({ data: { access_token: "client-token", expires_in: 7200 } });
      return;
    }
    if (url.pathname === "/open/getticket/") {
      send({ data: { ticket: "open-ticket", expires_in: 7200 } });
      return;
    }
    if (url.pathname === "/share-id/") {
      send({ data: { share_id: "share-integration" } });
      return;
    }
    if (url.pathname === "/api/douyin/v1/schema/get_share/") {
      send({ data: { schema: "snssdk1128://openplatform/share?share_id=share-integration" } });
      return;
    }
    send({ data: { error_code: 404, description: "not found" } });
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

test("HTTP API：抖音 H5 分享与 Webhook 回调更新状态", { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir();
  const mock = await startDouyinMock();
  const config = makeTestConfig(dir, { server: { port: 0 } });
  config.douyin.apiBaseUrl = mock.url;
  config.douyin.clientKey = "test-key";
  config.douyin.clientSecret = "test-secret";
  const app = await startServer(config, silentLogger);
  t.after(async () => {
    await app.close();
    await mock.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const session = await setupTestAdmin(app.url);
  const request = withCookie(session.cookie);

  const create = await request(`${app.url}/api/douyin/h5/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId: "external-1",
      videoUrl: "https://cdn.example.com/video.mp4",
      title: "短剧标题",
      hashtags: ["#短剧", "AI"],
    }),
  });
  assert.equal(create.status, 201, await create.clone().text());
  const created = (await create.json()) as {
    share: { shareId: string; schema: string; state: string; taskId?: string };
  };
  assert.equal(created.share.shareId, "share-integration");
  assert.equal(created.share.taskId, "external-1");
  assert.match(created.share.schema, /openplatform\/share/);
  assert.equal(created.share.state, "pending");

  const pending = await request(`${app.url}/api/douyin/h5/shares/share-integration`);
  assert.equal(pending.status, 200);

  const raw = JSON.stringify({
    event: "create_video",
    client_key: "test-key",
    from_user_id: "open-user-1",
    content: { share_id: "share-integration", item_id: "item-1", video_id: "video-1" },
  });
  const signature = crypto.createHash("sha1").update("test-secret").update(raw).digest("hex");
  const bad = await fetch(`${app.url}/api/douyin/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-douyin-signature": "bad" },
    body: raw,
  });
  assert.equal(bad.status, 401);

  const webhook = await fetch(`${app.url}/api/douyin/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-douyin-signature": signature },
    body: raw,
  });
  assert.equal(webhook.status, 200, await webhook.clone().text());

  let share: { state: string; itemId?: string; videoId?: string; openId?: string } | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(`${app.url}/api/douyin/h5/shares/share-integration`);
    share = ((await response.json()) as { share: typeof share }).share;
    if (share?.state === "success") break;
    await sleep(50);
  }
  assert.equal(share?.state, "success");
  assert.equal(share?.itemId, "item-1");
  assert.equal(share?.videoId, "video-1");
  assert.equal(share?.openId, "open-user-1");

  const challenge = await fetch(`${app.url}/api/douyin/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "verify_webhook", client_key: "test-key", content: { challenge: 12345 } }),
  });
  assert.equal(challenge.status, 200);
  assert.deepEqual(await challenge.json(), { challenge: 12345 });

  // 没有 publish 权限的成员不能创建 H5 投稿。
  const memberResponse = await request(`${app.url}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "editor",
      password: "editor-password-1",
      role: "member",
      permissions: ["create", "jobs"],
    }),
  });
  assert.equal(memberResponse.status, 201);
  const member = await loginTestUser(app.url, "editor", "editor-password-1");
  const memberRequest = withCookie(member.cookie);
  const forbidden = await memberRequest(`${app.url}/api/douyin/h5/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoUrl: "https://cdn.example.com/video.mp4" }),
  });
  assert.equal(forbidden.status, 403);
});

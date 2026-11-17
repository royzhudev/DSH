import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { makeTestConfig, makeTempDir } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";
import { DouyinH5Client, signCallback } from "../../src/publish/douyin-h5.js";

interface MockCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startMock(): Promise<{
  url: string;
  calls: MockCall[];
  close(): Promise<void>;
}> {
  const calls: MockCall[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    calls.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
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
      send({ data: { share_id: "share-123" } });
      return;
    }
    if (url.pathname === "/api/douyin/v1/schema/get_share/") {
      send({ data: { schema: "snssdk1128://openplatform/share?share_id=share-123" } });
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

test("抖音 H5：生成分享链接、复用 client_token 与 ticket", async () => {
  const dir = await makeTempDir();
  const mock = await startMock();
  try {
    const config = makeTestConfig(dir, {});
    config.douyin.apiBaseUrl = mock.url;
    config.douyin.clientKey = "test-key";
    config.douyin.clientSecret = "test-secret";
    const client = new DouyinH5Client(config, silentLogger, fetch);
    const first = await client.createShare({
      videoUrl: "https://cdn.example.com/demo.mp4",
      title: "  短剧标题  ",
      hashtags: [" #短剧 ", "", "#AI"],
      taskId: "task-1",
    });
    assert.equal(first.shareId, "share-123");
    assert.equal(first.schema, "snssdk1128://openplatform/share?share_id=share-123");
    assert.ok(Date.parse(first.expiresAt) > Date.now());

    const getShare = mock.calls.find((call) => call.path === "/api/douyin/v1/schema/get_share/");
    assert.ok(getShare);
    assert.equal(getShare.headers["access-token"], "client-token");
    const body = JSON.parse(getShare.body) as Record<string, unknown>;
    assert.equal(body.client_ticket, "open-ticket");
    assert.equal(body.state, "share-123");
    assert.equal(body.video_path, "https://cdn.example.com/demo.mp4");
    assert.equal(body.title, "  短剧标题  ".trim());
    assert.deepEqual(body.hashtag_list, ["短剧", "AI"]);
    assert.equal(body.share_to_publish, 1);

    const shareIdCall = mock.calls.find((call) => call.path === "/share-id/");
    assert.equal(shareIdCall?.query.get("need_callback"), "true");

    await client.createShare({ videoUrl: "https://cdn.example.com/two.mp4", title: "第二条" });
    assert.equal(mock.calls.filter((call) => call.path === "/oauth/client_token/").length, 1);
    assert.equal(mock.calls.filter((call) => call.path === "/open/getticket/").length, 1);
    assert.equal(mock.calls.filter((call) => call.path === "/share-id/").length, 2);
  } finally {
    await mock.close();
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});

test("抖音 H5：只接受 https 公网地址并校验 Webhook 签名", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir, {});
    config.douyin.clientKey = "test-key";
    config.douyin.clientSecret = "test-secret";
    const client = new DouyinH5Client(config, silentLogger, fetch);
    await assert.rejects(
      client.createShare({ videoUrl: "http://cdn.example.com/demo.mp4" }),
      /必须是 https 地址/,
    );
    await assert.rejects(
      client.createShare({ videoUrl: "https://cdn.example.com/demo.mp4", callbackUrl: "http://hook.example.com" }),
      /callbackUrl必须是 https 地址/,
    );

    const raw = Buffer.from(JSON.stringify({ event: "create_video", content: { share_id: "share-123" } }));
    const signature = crypto.createHash("sha1").update("test-secret").update(raw).digest("hex");
    assert.equal(client.verifyWebhook(raw, signature), true);
    assert.equal(client.verifyWebhook(raw, "bad"), false);
    assert.equal(client.verifyWebhook(raw, undefined), false);
    assert.equal(signCallback("test-secret", "{}").length, 40);
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import type { JobRecord } from "../../src/server/jobs.js";
import { makeTempDir, makeTestConfig, setupTestAdmin, withCookie } from "../helpers.js";

test("HTTP API：个人号小程序投稿从成片生成手机下载二维码与公网视频链接", { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, { server: { port: 0 } });
  config.douyin.mode = "miniapp";
  config.videoGen.publicBaseUrl = "https://dsh.example.com";
  const app = await startServer(config, silentLogger);
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const jobDir = path.join(config.outputDir, "job-miniapp-1");
  await fs.mkdir(jobDir, { recursive: true });
  const videoPath = path.join(jobDir, "video.mp4");
  await fs.writeFile(videoPath, Buffer.from("fake-mp4"));
  const fake = {
    id: "job-miniapp-1",
    topic: "成片标题",
    state: "succeeded",
    result: { videoPath },
  } as unknown as JobRecord;
  const originalGet = app.jobs.get.bind(app.jobs);
  app.jobs.get = ((id: string) => (id === fake.id ? fake : originalGet(id))) as typeof app.jobs.get;

  const session = await setupTestAdmin(app.url);
  const request = withCookie(session.cookie);
  const response = await request(`${app.url}/api/videos/${fake.id}/douyin/miniapp`, {
    method: "POST",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const data = (await response.json()) as {
    videoUrl: string;
    qrDataUrl: string;
    expiresAt: string;
  };
  assert.match(data.videoUrl, /^https:\/\/dsh\.example\.com\/api\/public\/video\/job-miniapp-1\/video\.mp4\?/);
  assert.match(data.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(Number.isFinite(Date.parse(data.expiresAt)));

  const localPath = new URL(data.videoUrl);
  const video = await fetch(`${app.url}${localPath.pathname}${localPath.search}`);
  assert.equal(video.status, 200);
  assert.equal(Buffer.from(await video.arrayBuffer()).toString(), "fake-mp4");

  const status = await request(`${app.url}/api/douyin/status`);
  const statusData = (await status.json()) as {
    mode: string;
    configured: boolean;
    publicBaseUrlSet: boolean;
  };
  assert.equal(statusData.mode, "miniapp");
  assert.equal(statusData.configured, true);
  assert.equal(statusData.publicBaseUrlSet, true);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

test("HTTP API：公网视频签名链接支持播放与 Range，无效签名 404", async (t) => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, { server: { port: 0 } });
  const app = await startServer(config, silentLogger);
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const jobDir = path.join(config.outputDir, "job-public-1");
  await fs.mkdir(jobDir, { recursive: true });
  const video = path.join(jobDir, "video.mp4");
  const body = Buffer.from("0123456789abcdef");
  await fs.writeFile(video, body);

  const url = app.publicVideo.url("https://dsh.example.com", video);
  assert.ok(url);
  const pathname = new URL(url!).pathname + new URL(url!).search;

  const full = await fetch(`${app.url}${pathname}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(Buffer.from(await full.arrayBuffer()).toString(), body.toString());

  const range = await fetch(`${app.url}${pathname}`, { headers: { range: "bytes=0-3" } });
  assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), "0123");

  const bad = await fetch(`${app.url}${pathname.replace(/token=[^&]+/, "token=bad")}`);
  assert.equal(bad.status, 404);

  // 公告视频路由只接受输出目录里的视频，不能借签名访问其他文件。
  const outside = path.join(dir, "secret.mp4");
  await fs.writeFile(outside, body);
  assert.equal(app.publicVideo.url("https://dsh.example.com", outside), undefined);
});

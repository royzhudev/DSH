import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  PublicMediaHost,
  VIDEO_EXTENSIONS,
  isPublicHost,
  publicBaseUrlFromRequest,
} from "../../src/server/publicMedia.js";
import { makeTempDir } from "../helpers.js";

test("PublicMediaHost：只给角色库图片生成可校验的临时链接", async () => {
  const dir = await makeTempDir();
  const castDir = path.join(dir, "cast");
  await fs.mkdir(castDir, { recursive: true });
  const image = path.join(castDir, "char-1.png");
  await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const host = new PublicMediaHost(castDir, path.join(dir, "public-media-secret"));
  try {
    const url = host.url("https://dsh.example.com/", image);
    assert.ok(url);
    assert.match(
      url!,
      /^https:\/\/dsh\.example\.com\/api\/public\/media\/char-1\.png\?expires=\d+&token=[A-Za-z0-9_-]+$/,
    );
    const parsed = new URL(url!);
    const relative = decodeURIComponent(parsed.pathname.replace("/api/public/media/", ""));
    const expires = Number(parsed.searchParams.get("expires"));
    const token = parsed.searchParams.get("token")!;
    assert.equal(host.resolve(relative, expires, token), image);
    assert.equal(host.resolve(relative, expires, `${token}x`), undefined, "签名不符不能放行");
    assert.equal(host.resolve(relative, 1, token), undefined, "过期链接不能放行");
    assert.equal(host.resolve("../public-media-secret", expires, token), undefined);
    assert.equal(host.url("https://dsh.example.com", path.join(dir, "outside.png")), undefined);
    assert.equal(host.url("https://dsh.example.com", path.join(castDir, "note.txt")), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("PublicMediaHost：中文角色图文件名也能签名和取回", async () => {
  const dir = await makeTempDir();
  const castDir = path.join(dir, "cast");
  await fs.mkdir(castDir, { recursive: true });
  const image = path.join(castDir, "char-猪猪侠-9f613a.jpg");
  await fs.writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const host = new PublicMediaHost(castDir, path.join(dir, "public-media-secret"));
  try {
    const url = host.url("http://220.168.101.242:8088", image);
    assert.ok(url);
    assert.ok(url!.includes("char-%E7%8C%AA%E7%8C%AA%E4%BE%A0-9f613a.jpg"));
    const parsed = new URL(url!);
    const relative = decodeURIComponent(parsed.pathname.replace("/api/public/media/", ""));
    const expires = Number(parsed.searchParams.get("expires"));
    const token = parsed.searchParams.get("token")!;
    assert.equal(relative, "char-猪猪侠-9f613a.jpg");
    assert.equal(host.resolve(relative, expires, token), image);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("isPublicHost：拒绝本机/局域网地址，接受域名与公网 IP", () => {
  for (const host of [
    "127.0.0.1",
    "127.0.0.1:8787",
    "localhost:8787",
    "0.0.0.0",
    "10.0.0.5:8080",
    "192.168.1.2",
    "172.20.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "[::1]:8787",
    "dsh.local",
    "server.internal",
  ]) {
    assert.equal(isPublicHost(host), false, host);
  }
  for (const host of [
    "dsh.example.com",
    "dsh.example.com:8443",
    "8.8.8.8",
    "8.8.8.8:8787",
    "[2001:4860:4860::8888]:443",
  ]) {
    assert.equal(isPublicHost(host), true, host);
  }
});

test("publicBaseUrlFromRequest：按 Host 与反向代理协议生成对外地址", () => {
  const request = (host: string | undefined, proto?: string) =>
    ({
      headers: { host, ...(proto ? { "x-forwarded-proto": proto } : {}) },
      socket: {},
    }) as unknown as http.IncomingMessage;
  assert.equal(publicBaseUrlFromRequest(request("dsh.example.com", "https")), "https://dsh.example.com");
  assert.equal(
    publicBaseUrlFromRequest(request("dsh.example.com:8443", "https,http")),
    "https://dsh.example.com:8443",
  );
  assert.equal(publicBaseUrlFromRequest(request("127.0.0.1:8787")), undefined);
  assert.equal(publicBaseUrlFromRequest(request(undefined)), undefined);
});
test("PublicMediaHost：视频签名链接只放行输出目录里的视频", async () => {
  const dir = await makeTempDir();
  const outputDir = path.join(dir, "output");
  await fs.mkdir(path.join(outputDir, "job-1"), { recursive: true });
  const video = path.join(outputDir, "job-1", "video.mp4");
  await fs.writeFile(video, Buffer.from([0x00, 0x00, 0x00, 0x18]));
  const host = new PublicMediaHost(outputDir, path.join(dir, "public-video-secret"), undefined, {
    extensions: VIDEO_EXTENSIONS,
    publicPath: "/api/public/video/",
  });
  try {
    const url = host.url("https://dsh.example.com/", video);
    assert.ok(url);
    assert.match(
      url!,
      /^https:\/\/dsh\.example\.com\/api\/public\/video\/job-1\/video\.mp4\?expires=\d+&token=[A-Za-z0-9_-]+$/,
    );
    const parsed = new URL(url!);
    const relative = decodeURIComponent(parsed.pathname.replace("/api/public/video/", ""));
    const expires = Number(parsed.searchParams.get("expires"));
    const token = parsed.searchParams.get("token")!;
    assert.equal(host.resolve(relative, expires, token), video);
    assert.equal(host.resolve("job-1/image.png", expires, token), undefined);
    assert.equal(host.resolve("../public-video-secret", expires, token), undefined);
    assert.equal(host.url("https://dsh.example.com", path.join(dir, "outside.mp4")), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

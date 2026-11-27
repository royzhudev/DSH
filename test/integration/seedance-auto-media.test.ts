import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { CastLibrary } from "../../src/cast/library.js";
import { silentLogger } from "../../src/logger.js";
import { startServer } from "../../src/server/server.js";
import { generateTestClip, generateTestImage, makeTempDir, makeTestConfig, setupTestAdmin, withCookie } from "../helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJsonWithHost(
  base: URL,
  host: string,
  requestPath: string,
  cookie: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: requestPath,
        method: "POST",
        headers: {
          host,
          origin: `http://${host}`,
          cookie,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test(
  "Seedance 图生视频：公网 Host 自动生成签名角色图链接并提交给平台",
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir();
    const clip = path.join(dir, "nexus-clip.mp4");
    await generateTestClip(clip, { durationSec: 1.5, size: "160x160" });
    let submitBody: Record<string, unknown> | undefined;

    const nexus = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const send = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "POST" && url.pathname === "/api/v3/contents/generations/tasks") {
        submitBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        send({ id: "task-auto" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/v3/contents/generations/tasks/task-auto") {
        const address = nexus.address();
        const port = typeof address === "object" && address ? address.port : 0;
        send({
          id: "task-auto",
          status: "succeeded",
          content: { video_url: `http://127.0.0.1:${port}/files/clip.mp4` },
        });
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
    await new Promise<void>((resolve) => nexus.listen(0, "127.0.0.1", resolve));
    const nexusAddress = nexus.address();
    const nexusPort = typeof nexusAddress === "object" && nexusAddress ? nexusAddress.port : 0;

    const config = makeTestConfig(dir, {
      server: { port: 0 },
      script: { provider: "offline" },
      tts: { provider: "silent" },
      videoGen: {
        channel: "aggregator-seedance2",
        provider: "http",
        protocol: "seedance",
        baseUrl: `http://127.0.0.1:${nexusPort}`,
        model: "doubao-seedance-2-0-260128",
        apiKey: "sk-lumi",
        submitPath: "/api/v3/contents/generations/tasks",
        pollPath: "/api/v3/contents/generations/tasks/{id}",
        resultPath: "content.video_url",
        pollIntervalMs: 200,
        timeoutMs: 20_000,
        clipDurationSec: 2,
        fallbackToMaterials: false,
        publicBaseUrl: "",
        publicAssetToken: "",
      },
    });
    const app = await startServer(config, silentLogger);
    t.after(async () => {
      await app.close();
      await new Promise<void>((resolve) => {
        nexus.close(() => resolve());
        nexus.closeAllConnections?.();
      });
      await fs.rm(dir, { recursive: true, force: true });
    });

    const image = path.join(dir, "hero.png");
    await generateTestImage(image);
    const session = await setupTestAdmin(app.url);
    const library = new CastLibrary(path.join(config.castDir, "users", session.user.id), silentLogger);
    const hero = await library.add({
      kind: "character",
      name: "猪猪侠",
      description: "戴红色头盔的卡通角色",
      imagePath: image,
    });
    const publicHost = "220.168.101.242:8088";
    const response = await postJsonWithHost(
      new URL(app.url),
      publicHost,
      "/api/videos",
      session.cookie,
      {
        topic: "猪猪侠手冲咖啡",
        castIds: [hero.id],
        targetDurationSec: 5,
        maxSegments: 1,
        videoGenEnabled: true,
        subtitlesEnabled: false,
        script: {
          title: "猪猪侠手冲咖啡",
          summary: "猪猪侠在钟表店里演示手冲咖啡。",
          segments: [
            {
              id: 1,
              narration: "猪猪侠走进钟表店，抬手示意镜头。",
              keywords: ["钟表店"],
              durationHintSec: 4,
              scene: "暖光钟表店",
              shot: "猪猪侠中景，镜头缓慢推近",
              cast: ["猪猪侠"],
            },
          ],
        },
      },
    );
    assert.equal(response.status, 202, response.text);
    const created = JSON.parse(response.text) as { id: string };

    const request = withCookie(session.cookie);
    let job: { state: string; error?: string; warnings?: string[] } | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      job = (await (await request(`${app.url}/api/videos/${created.id}`)).json()) as {
        state: string;
        error?: string;
        warnings?: string[];
      };
      if (job.state === "succeeded" || job.state === "failed") break;
      await sleep(100);
    }
    assert.equal(job?.state, "succeeded", job?.error);
    assert.ok(submitBody, "应把任务提交给 Seedance 平台");
    const content = submitBody!.content as Array<{
      type: string;
      image_url?: { url: string };
      role?: string;
    }>;
    const imageInput = content.find((item) => item.type === "image_url");
    assert.ok(imageInput?.image_url?.url, "应提交角色参考图");
    assert.match(
      imageInput!.image_url!.url,
      /^http:\/\/220\.168\.101\.242:8088\/api\/public\/media\//,
      "应使用当前公网 Host 生成图片链接",
    );
    assert.match(imageInput!.image_url!.url, /[?&]expires=\d+/);
    assert.match(imageInput!.image_url!.url, /[?&]token=[A-Za-z0-9_-]+/);
    assert.equal(imageInput!.role, "reference_image");
    assert.equal(
      (job?.warnings ?? []).some((warning) => warning.includes("只接受公网参考图")),
      false,
      "自动生成公网链接后不应再提示纯文字生成",
    );
    const meta = JSON.parse(
      await fs.readFile(path.join(config.outputDir, "users", session.user.id, created.id, "job.json"), "utf8"),
    ) as { publicBaseUrl?: string };
    assert.equal(meta.publicBaseUrl, "http://220.168.101.242:8088");
  },
);
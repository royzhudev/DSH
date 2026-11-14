import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { generateTestClip, makeTempDir, makeTestConfig, setupTestAdmin, withCookie } from "../helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JobView {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  error?: string;
  videoUrl?: string;
  subtitlesUrl?: string;
  resultUrl?: string;
}

test(
  "HTTP API：上传素材、创建任务、轮询、播放成片与删除素材",
  { timeout: 240_000 },
  async (t) => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { server: { port: 0 } });
    const app = await startServer(config, silentLogger);
    t.after(async () => {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const session = await setupTestAdmin(app.url);
    const request = withCookie(session.cookie);

    const health = (await (await request(`${app.url}/healthz`)).json()) as { ok: boolean };
    assert.equal(health.ok, true);

    const clip = path.join(dir, "source", "city-night.mp4");
    await generateTestClip(clip, { durationSec: 1.5, size: "160x160" });
    const form = new FormData();
    form.append("file", new Blob([await fs.readFile(clip)], { type: "video/mp4" }), "city-night.mp4");
    form.append("tags", "城市,夜景");
    const uploadResponse = await request(`${app.url}/api/materials`, { method: "POST", body: form });
    assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
    const uploaded = (await uploadResponse.json()) as {
      material: { id: string; tags: string[]; type: string };
    };
    assert.equal(uploaded.material.type, "video");
    assert.ok(uploaded.material.tags.includes("城市"));

    const materialsResponse = await request(`${app.url}/api/materials`);
    const materials = (await materialsResponse.json()) as { materials: unknown[] };
    assert.equal(materials.materials.length, 1);

    const badScriptResponse = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "城市夜景", script: { title: "t", summary: "", segments: [] } }),
    });
    assert.equal(badScriptResponse.status, 400);

    const createResponse = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "城市夜景" }),
    });
    assert.equal(createResponse.status, 202);
    const created = (await createResponse.json()) as JobView;

    let job: JobView | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const statusResponse = await request(`${app.url}/api/videos/${created.id}`);
      job = (await statusResponse.json()) as JobView;
      if (job.state === "succeeded" || job.state === "failed") break;
      await sleep(200);
    }
    assert.ok(job, "没有拿到任务状态");
    assert.equal(job.state, "succeeded", job.error);

    const resultResponse = await request(`${app.url}${job.resultUrl}`);
    assert.equal(resultResponse.status, 200);
    const result = (await resultResponse.json()) as {
      segments: Array<{ material: unknown; ttsProvider: string }>;
    };
    assert.ok(result.segments.length >= 3);
    assert.ok(result.segments.some((segment) => segment.material !== null), "素材没有命中");
    assert.ok(result.segments.every((segment) => segment.ttsProvider === "silent"));

    const videoResponse = await request(`${app.url}${job.videoUrl}`, {
      headers: { range: "bytes=0-99" },
    });
    assert.equal(videoResponse.status, 206);
    assert.equal((await videoResponse.arrayBuffer()).byteLength, 100);

    const subtitlesResponse = await request(`${app.url}${job.subtitlesUrl}`);
    assert.equal(subtitlesResponse.status, 200);
    assert.match(await subtitlesResponse.text(), /-->/);

    const jobsResponse = await request(`${app.url}/api/videos`);
    const jobs = (await jobsResponse.json()) as { jobs: JobView[] };
    assert.equal(jobs.jobs.length, 1);

    const deleteResponse = await request(`${app.url}/api/materials/${uploaded.material.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);

    const missingResponse = await request(`${app.url}/api/videos/not-found`);
    assert.equal(missingResponse.status, 404);
  },
);
test(
  "HTTP API：创建任务时带上用户在预览里编辑过的脚本，成片按改后的内容走",
  { timeout: 180_000 },
  async (t) => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { server: { port: 0 } });
    const app = await startServer(config, silentLogger);
    t.after(async () => {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const session = await setupTestAdmin(app.url);
    const request = withCookie(session.cookie);
    const createResponse = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "钟表店编辑测试",
        videoGenEnabled: false,
        script: {
          title: "我改过的标题",
          summary: "手动修改后成片",
          segments: [
            { narration: "林小满推门进店，雨水滴下来。", keywords: ["钟表店"] },
            { narration: "黄乐把表推回柜台。", keywords: ["柜台"] },
          ],
        },
      }),
    });
    assert.equal(createResponse.status, 202, await createResponse.clone().text());
    const created = (await createResponse.json()) as JobView;
    let job: JobView | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      job = (await (await request(`${app.url}/api/videos/${created.id}`)).json()) as JobView;
      if (job.state === "succeeded" || job.state === "failed") break;
      await sleep(200);
    }
    assert.equal(job?.state, "succeeded", job?.error);
    const script = (await (await request(`${app.url}/api/videos/${created.id}/script`)).json()) as {
      title: string;
      segments: Array<{ narration: string }>;
    };
    assert.equal(script.title, "我改过的标题");
    assert.equal(script.segments.length, 2);
    assert.equal(script.segments[0]!.narration, "林小满推门进店，雨水滴下来。");
  },
);

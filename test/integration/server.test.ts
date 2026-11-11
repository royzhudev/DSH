import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

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

    const health = (await (await fetch(`${app.url}/healthz`)).json()) as { ok: boolean };
    assert.equal(health.ok, true);

    const clip = path.join(dir, "source", "city-night.mp4");
    await generateTestClip(clip, { durationSec: 1.5, size: "160x160" });
    const form = new FormData();
    form.append("file", new Blob([await fs.readFile(clip)], { type: "video/mp4" }), "city-night.mp4");
    form.append("tags", "城市,夜景");
    const uploadResponse = await fetch(`${app.url}/api/materials`, { method: "POST", body: form });
    assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
    const uploaded = (await uploadResponse.json()) as {
      material: { id: string; tags: string[]; type: string };
    };
    assert.equal(uploaded.material.type, "video");
    assert.ok(uploaded.material.tags.includes("城市"));

    const materialsResponse = await fetch(`${app.url}/api/materials`);
    const materials = (await materialsResponse.json()) as { materials: unknown[] };
    assert.equal(materials.materials.length, 1);

    const createResponse = await fetch(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "城市夜景" }),
    });
    assert.equal(createResponse.status, 202);
    const created = (await createResponse.json()) as JobView;

    let job: JobView | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const statusResponse = await fetch(`${app.url}/api/videos/${created.id}`);
      job = (await statusResponse.json()) as JobView;
      if (job.state === "succeeded" || job.state === "failed") break;
      await sleep(200);
    }
    assert.ok(job, "没有拿到任务状态");
    assert.equal(job.state, "succeeded", job.error);

    const resultResponse = await fetch(`${app.url}${job.resultUrl}`);
    assert.equal(resultResponse.status, 200);
    const result = (await resultResponse.json()) as {
      segments: Array<{ material: unknown; ttsProvider: string }>;
    };
    assert.ok(result.segments.length >= 3);
    assert.ok(result.segments.some((segment) => segment.material !== null), "素材没有命中");
    assert.ok(result.segments.every((segment) => segment.ttsProvider === "silent"));

    const videoResponse = await fetch(`${app.url}${job.videoUrl}`, {
      headers: { range: "bytes=0-99" },
    });
    assert.equal(videoResponse.status, 206);
    assert.equal((await videoResponse.arrayBuffer()).byteLength, 100);

    const subtitlesResponse = await fetch(`${app.url}${job.subtitlesUrl}`);
    assert.equal(subtitlesResponse.status, 200);
    assert.match(await subtitlesResponse.text(), /-->/);

    const jobsResponse = await fetch(`${app.url}/api/videos`);
    const jobs = (await jobsResponse.json()) as { jobs: JobView[] };
    assert.equal(jobs.jobs.length, 1);

    const deleteResponse = await fetch(`${app.url}/api/materials/${uploaded.material.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);

    const missingResponse = await fetch(`${app.url}/api/videos/not-found`);
    assert.equal(missingResponse.status, 404);
  },
);
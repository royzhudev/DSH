import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DashScopeLipsyncProvider } from "../../src/lipsync/dashscope.js";
import { generateSilentAudio } from "../../src/media/ffmpeg.js";
import { silentLogger } from "../../src/logger.js";
import type { LipsyncSettings } from "../../src/types.js";
import { generateTestClip, makeTempDir } from "../helpers.js";

function settings(overrides: Partial<LipsyncSettings> = {}): LipsyncSettings {
  return {
    provider: "dashscope",
    baseUrl: "https://dashscope.example",
    model: "videoretalk",
    apiKey: "sk-test",
    timeoutMs: 5000,
    pollIntervalMs: 1,
    fallbackToUnsynced: true,
    ...overrides,
  };
}

type Call = { url: string; method: string; body?: unknown; headers: Record<string, string> };

function fakeFetch(videoBytes: Buffer, calls: Call[]): typeof fetch {
  let polls = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers });
    if (url.includes("/api/v1/uploads") && url.includes("action=getPolicy")) {
      return new Response(
        JSON.stringify({
          data: {
            upload_dir: "upload/dir",
            upload_host: "https://oss.example/upload",
            oss_access_key_id: "ak",
            signature: "sig",
            policy: "policy",
            x_oss_object_acl: "private",
            x_oss_forbid_overwrite: "true",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://oss.example/upload")) {
      return new Response("", { status: 200 });
    }
    if (url.endsWith("/api/v1/services/aigc/image2video/video-synthesis")) {
      return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }), {
        status: 200,
      });
    }
    if (url.endsWith("/api/v1/tasks/task-1")) {
      polls += 1;
      if (polls < 2) {
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "RUNNING" } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          output: { task_id: "task-1", task_status: "SUCCEEDED", video_url: "https://result.example/out.mp4" },
        }),
        { status: 200 },
      );
    }
    if (url === "https://result.example/out.mp4") {
      return new Response(videoBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

test("口型同步：校验 VideoRetalk 的时长与分辨率要求", { timeout: 120_000 }, async () => {
  const dir = await makeTempDir();
  try {
    const video = path.join(dir, "small.mp4");
    const audio = path.join(dir, "voice.mp3");
    await generateTestClip(video, { durationSec: 3, size: "360x640" });
    await generateSilentAudio(audio, 3);
    const provider = new DashScopeLipsyncProvider(settings(), silentLogger, fakeFetch(Buffer.alloc(0), []));
    await assert.rejects(
      () => provider.sync({ videoFile: video, audioFile: audio }, path.join(dir, "out")),
      /边长 360x640 超出 640–2048/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("口型同步：上传视频与配音、提交任务并下载成片", { timeout: 180_000 }, async () => {
  const dir = await makeTempDir();
  try {
    const video = path.join(dir, "clip.mp4");
    const audio = path.join(dir, "voice.mp3");
    await generateTestClip(video, { durationSec: 3, size: "720x1280" });
    await generateSilentAudio(audio, 3);
    const videoBytes = await fs.readFile(video);
    const calls: Call[] = [];
    const provider = new DashScopeLipsyncProvider(
      settings(),
      silentLogger,
      fakeFetch(videoBytes, calls),
    );
    const result = await provider.sync({ videoFile: video, audioFile: audio }, path.join(dir, "out"));

    assert.equal(result.provider, "dashscope");
    assert.equal(result.model, "videoretalk");
    const stat = await fs.stat(result.file);
    assert.equal(stat.size, videoBytes.length);

    const policy = calls.find((call) => call.url.includes("action=getPolicy"));
    assert.ok(policy, "应先获取上传凭证");
    assert.match(policy.url, /model=videoretalk/);
    assert.equal(calls.filter((call) => call.url.startsWith("https://oss.example/upload")).length, 2);
    assert.equal(policy.headers.authorization, "Bearer sk-test");

    const submit = calls.find((call) => call.url.endsWith("/video-synthesis"));
    assert.ok(submit);
    assert.equal(submit.headers["X-DashScope-Async"], "enable");
    const body = JSON.parse(String(submit.body)) as {
      model: string;
      input: { video_url: string; audio_url: string };
      parameters: { video_extension: boolean };
    };
    assert.equal(body.model, "videoretalk");
    assert.match(body.input.video_url, /^oss:\/\//);
    assert.match(body.input.audio_url, /^oss:\/\//);
    assert.equal(body.parameters.video_extension, false, "不能倒放-正放补时长，否则同一镜头来回播放");

    const poll = calls.find((call) => call.url.endsWith("/api/v1/tasks/task-1"));
    assert.ok(poll);
    assert.equal(poll.headers["X-DashScope-Async"], undefined, "查询任务不能带异步头");
    assert.ok(calls.some((call) => call.url === "https://result.example/out.mp4"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("口型同步：没有 API Key 时给出可操作的报错", async () => {
  const provider = new DashScopeLipsyncProvider(settings({ apiKey: "" }), silentLogger, fakeFetch(Buffer.alloc(0), []));
  await assert.rejects(
    () => provider.sync({ videoFile: "/tmp/a.mp4", audioFile: "/tmp/a.mp3" }, "/tmp/out"),
    /还没有配置口型同步 API Key/,
  );
});
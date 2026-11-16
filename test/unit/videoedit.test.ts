import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DashScopeVideoEditProvider } from "../../src/videoedit/dashscope.js";
import { probeMedia, runFfmpeg } from "../../src/media/ffmpeg.js";
import { silentLogger } from "../../src/logger.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

async function makeClipWithAudio(file: string, color: string, durationSec: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=360x640:d=${durationSec}:r=15`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:duration=${durationSec}`,
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
}

test("视频局部编辑：上传分镜、提交编辑任务、保留原音轨并统一画幅", { timeout: 120_000 }, async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, {
    video: { fps: 24 },
    videoGen: {
      baseUrl: "https://dashscope.test",
      editModel: "wan2.7-videoedit",
      apiKey: "test-key",
      pollIntervalMs: 200,
      timeoutMs: 20_000,
    },
  });
  const source = path.join(dir, "segment.mp4");
  const edited = path.join(dir, "edited-source.mp4");
  const output = path.join(dir, "edited-segment.mp4");
  await makeClipWithAudio(source, "0x224466", 2);
  // 编辑结果故意不带音轨，验证会用原分镜台词音轨补上。
  await generateTestClip(edited, { durationSec: 3, size: "720x1280", color: "0x884422" });

  const bodies: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://dashscope.test/api/v1/uploads")) {
      return Response.json({
        data: {
          upload_dir: "tmp/video-edit",
          oss_access_key_id: "ak",
          signature: "sig",
          policy: "policy",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
          upload_host: "https://upload.test",
        },
      });
    }
    if (url === "https://upload.test") {
      return new Response("ok", { status: 200 });
    }
    if (url === "https://dashscope.test/api/v1/services/aigc/video-generation/video-synthesis") {
      bodies.push(String(init?.body ?? ""));
      return Response.json({ output: { task_id: "task-1" } });
    }
    if (url === "https://dashscope.test/api/v1/tasks/task-1") {
      return Response.json({
        output: { task_status: "SUCCEEDED", video_url: "https://result.test/edited.mp4" },
      });
    }
    if (url === "https://result.test/edited.mp4") {
      return new Response(await fs.readFile(edited), { status: 200 });
    }
    return new Response(`unexpected ${url}`, { status: 500 });
  }) as typeof fetch;

  const provider = new DashScopeVideoEditProvider(config.videoGen, silentLogger, { fetchImpl });
  const result = await provider.edit({
    sourceFile: source,
    prompt: "编辑视频，把画面改成夜景，保留人物动作",
    outputFile: output,
    durationSec: 2,
    config,
    logger: silentLogger,
  });

  assert.equal(bodies.length, 1);
  const body = JSON.parse(bodies[0]!) as {
    model: string;
    input: { prompt: string; media: Array<{ type: string; url: string }> };
    parameters: Record<string, unknown>;
  };
  assert.equal(body.model, "wan2.7-videoedit");
  assert.equal(body.input.media[0]?.type, "video");
  assert.match(body.input.media[0]?.url ?? "", /^oss:\/\/tmp\/video-edit\/video-edit-/);
  assert.equal(body.parameters.audio_setting, "origin");
  assert.equal(body.parameters.duration, undefined);
  assert.equal(result.model, "wan2.7-videoedit");

  const probe = await probeMedia(result.file);
  assert.equal(probe.hasAudio, true, "应保留原分镜音轨");
  assert.equal(probe.width, config.video.width);
  assert.equal(probe.height, config.video.height);
  assert.ok(Math.abs((probe.durationSec ?? 0) - 2) < 0.3);
  await fs.rm(dir, { recursive: true, force: true });
});

test("视频局部编辑：分镜短于 2 秒时给出明确错误", { timeout: 60_000 }, async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, { videoGen: { editModel: "wan2.7-videoedit", pollIntervalMs: 200 } });
  const source = path.join(dir, "short.mp4");
  await makeClipWithAudio(source, "0x224466", 1);
  const provider = new DashScopeVideoEditProvider(config.videoGen, silentLogger, {
    fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    provider.edit({
      sourceFile: source,
      prompt: "改成夜景",
      outputFile: path.join(dir, "out.mp4"),
      durationSec: 1,
      config,
      logger: silentLogger,
    }),
    (error: unknown) => error instanceof Error && error.message.includes("2–10 秒"),
  );
  await fs.rm(dir, { recursive: true, force: true });
});

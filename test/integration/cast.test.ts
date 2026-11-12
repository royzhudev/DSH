import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { runFfmpeg } from "../../src/media/ffmpeg.js";
import {
  generateTestClip,
  loginTestUser,
  makeTempDir,
  makeTestConfig,
  setupTestAdmin,
  withCookie,
} from "../helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CastView {
  id: string;
  kind: string;
  name: string;
  description: string;
  imageUrl?: string;
}

interface JobView {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  error?: string;
  errorStage?: string;
  warnings?: string[];
  story?: string;
  cast?: CastView[];
  segments?: Array<{ cast?: Array<{ name: string }>; imageToVideo?: boolean }>;
}

test(
  "HTTP API：角色库 CRUD、剧本预览与图生视频任务",
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

    const heroImage = path.join(dir, "input", "hero.png");
    await fs.mkdir(path.dirname(heroImage), { recursive: true });
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x884466:s=64x64", "-frames:v", "1", heroImage]);

    const form = new FormData();
    form.append("kind", "character");
    form.append("name", "林小满");
    form.append("description", "25 岁女性，齐肩短发，米色风衣");
    form.append("file", new Blob([await fs.readFile(heroImage)], { type: "image/png" }), "hero.png");
    const createResponse = await request(`${app.url}/api/cast`, { method: "POST", body: form });
    assert.equal(createResponse.status, 201, await createResponse.clone().text());
    const created = (await createResponse.json()) as { cast: CastView };
    assert.equal(created.cast.name, "林小满");
    assert.equal(created.cast.kind, "character");
    assert.ok(created.cast.imageUrl);

    const imageResponse = await request(`${app.url}${created.cast.imageUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");

    const duplicate = new FormData();
    duplicate.append("kind", "prop");
    duplicate.append("name", "林小满");
    const duplicateResponse = await request(`${app.url}/api/cast`, {
      method: "POST",
      body: duplicate,
    });
    assert.equal(duplicateResponse.status, 409);
    assert.equal(
      ((await duplicateResponse.json()) as { error: { code: string } }).error.code,
      "CAST_NAME_TAKEN",
    );

    const listResponse = await request(`${app.url}/api/cast`);
    const listed = (await listResponse.json()) as { cast: CastView[] };
    assert.equal(listed.cast.length, 1);

    const patchResponse = await request(`${app.url}/api/cast/${created.cast.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "红色围巾" }),
    });
    assert.equal(patchResponse.status, 200);
    assert.equal(((await patchResponse.json()) as { cast: CastView }).cast.description, "红色围巾");

    // 剧本预览：返回分镜的场景/镜头/角色，且在调用模型前完成预检。
    const previewResponse = await request(`${app.url}/api/scripts/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "钟表店",
        story: "林小满在钟表店遇到一位神秘客人。",
        castIds: [created.cast.id],
        maxSegments: 3,
        targetDurationSec: 12,
      }),
    });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = (await previewResponse.json()) as {
      cast: CastView[];
      script: { segments: Array<{ scene?: string; shot?: string; cast?: string[] }> };
    };
    assert.equal(preview.cast.length, 1);
    assert.equal(preview.cast[0]!.name, "林小满");
    assert.ok(preview.script.segments.every((segment) => segment.scene && segment.shot));
    assert.ok(preview.script.segments.some((segment) => segment.cast?.includes("林小满")));

    // 预检失败要在入队前返回 400，不能先扣费。
    const badCast = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "钟表店", castIds: ["missing-cast"] }),
    });
    assert.equal(badCast.status, 400);
    assert.equal(((await badCast.json()) as { error: { code: string } }).error.code, "CAST_NOT_FOUND");

    const badStory = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "钟表店", story: "长".repeat(6001) }),
    });
    assert.equal(badStory.status, 400);
    const badStoryBody = (await badStory.json()) as { error: { code: string; message: string } };
    assert.equal(badStoryBody.error.code, "INVALID_OPTIONS");
    assert.match(badStoryBody.error.message, /剧本\/大纲不能超过 6000 个字符/);

    const createJob = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "钟表店",
        story: "林小满在钟表店遇到一位神秘客人。",
        castIds: [created.cast.id],
        maxSegments: 3,
        targetDurationSec: 12,
      }),
    });
    assert.equal(createJob.status, 202, await createJob.clone().text());
    const job = (await createJob.json()) as JobView;

    let current: JobView | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      current = (await (await request(`${app.url}/api/videos/${job.id}`)).json()) as JobView;
      if (current.state === "succeeded" || current.state === "failed") break;
      await sleep(200);
    }
    assert.ok(current);
    assert.equal(current.state, "succeeded", current.error);
    assert.ok(current.story?.includes("林小满"));
    assert.equal(current.cast?.[0]?.name, "林小满");
    assert.ok(current.segments?.some((segment) => segment.cast?.some((item) => item.name === "林小满")));
    assert.ok(current.warnings?.some((warning) => warning.includes("离线")), "缺少离线脚本提示");

    // 参考图在磁盘上丢失时，角色库会清理该设定，任务在调用模型前被拦下。
    const castFiles = await fs.readdir(config.castDir);
    const imageFile = castFiles.find((name) => name !== ".cast.json");
    assert.ok(imageFile);
    await fs.rm(path.join(config.castDir, imageFile));
    const missingImage = await request(`${app.url}/api/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "钟表店", castIds: [created.cast.id] }),
    });
    assert.equal(missingImage.status, 400);
    const missingBody = (await missingImage.json()) as { error: { code: string; message: string } };
    assert.equal(missingBody.error.code, "CAST_NOT_FOUND");
    assert.match(missingBody.error.message, /角色\/道具不存在/);

    // 没有角色库权限的成员不能访问角色库管理接口。
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
    assert.equal((await memberRequest(`${app.url}/api/cast`)).status, 403);

    const deleteResponse = await request(`${app.url}/api/cast/${created.cast.id}`, {
      method: "DELETE",
    });
    // 参考图丢失后该设定已被角色库自动清理。
    assert.equal(deleteResponse.status, 404);
    assert.equal((await request(`${app.url}${created.cast.imageUrl}`)).status, 404);
  },
);
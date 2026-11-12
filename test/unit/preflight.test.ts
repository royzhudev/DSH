import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AppError } from "../../src/errors.js";
import {
  STORY_MAX_LENGTH,
  preflightScript,
  preflightVideoJob,
} from "../../src/preflight.js";
import type { CastAsset } from "../../src/types.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

function castAsset(overrides: Partial<CastAsset> = {}): CastAsset {
  return {
    id: "cast-1",
    kind: "character",
    name: "林小满",
    description: "短发",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function isPreflightError(error: unknown): boolean {
  return error instanceof AppError && error.code === "PREFLIGHT_FAILED" && error.status === 400;
}

test("预检：本地离线配置通过，且不检查运行环境时不启动 ffmpeg", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir);
    await preflightVideoJob({
      config,
      topic: "城市夜景",
      story: "第一幕：主角走进钟表店。",
      options: { videoGenEnabled: false, castIds: [] },
      checkEnvironment: false,
    });
    await preflightScript({ config, topic: "城市夜景" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("预检：一次性列出配置、剧本与参考图问题", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir, {
      videoGen: {
        provider: "http",
        baseUrl: "http://127.0.0.1:9",
        model: "video-model",
        submitPath: "/v1/videos",
        pollPath: "/v1/videos/{id}",
      },
    });
    // loadConfig 会拒绝这些无效组合，这里模拟“保存后配置被改坏”的状态，
    // 验证预检能一次性把它们都列出来。
    config.script.provider = "openai";
    config.script.apiKey = "";
    config.videoGen.baseUrl = "not-a-url";
    config.videoGen.model = "";
    config.videoGen.submitPath = "v1/videos";
    config.videoGen.pollPath = "/v1/videos";
    const error = await preflightVideoJob({
      config,
      topic: "城市夜景",
      story: "长".repeat(STORY_MAX_LENGTH + 1),
      options: { videoGenEnabled: true },
      castAssets: [castAsset({ imageFile: "missing.jpg" })],
      checkEnvironment: false,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(isPreflightError(error), "应抛出 PREFLIGHT_FAILED");
    const message = (error as AppError).message;
    assert.match(message, /剧本\/大纲不能超过 6000 个字符/);
    assert.match(message, /还没有填写 API Key/);
    assert.match(message, /服务地址无效/);
    assert.match(message, /模型名称不能为空/);
    assert.match(message, /提交\/查询路径无效/);
    assert.match(message, /参考图丢失/);
    assert.equal((error as AppError).status, 400);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("预检：主题为空、参考图不可读、角色数量过多都会被拦截", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir);
    const emptyImage = path.join(config.castDir, "empty.png");
    await fs.mkdir(path.dirname(emptyImage), { recursive: true });
    await fs.writeFile(emptyImage, "");
    const tooMany = Array.from({ length: 31 }, (_, index) => castAsset({ id: `c${index}`, name: `角色${index}` }));
    const error = (await preflightVideoJob({
      config,
      topic: "  ",
      options: { castIds: tooMany.map((asset) => asset.id) },
      castAssets: [castAsset({ imageFile: "empty.png" })],
      checkEnvironment: false,
    }).then(
      () => null,
      (caught: unknown) => caught,
    )) as AppError;
    assert.ok(isPreflightError(error));
    assert.match(error.message, /主题不能为空/);
    assert.match(error.message, /最多选择 30 个角色\/道具/);
    assert.match(error.message, /参考图无法读取/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("预检：超过 8MB 的参考图会被提前拒绝", async () => {
  const dir = await makeTempDir();
  try {
    const config = makeTestConfig(dir);
    const big = path.join(config.castDir, "big.png");
    await fs.mkdir(config.castDir, { recursive: true });
    await fs.writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1));
    const error = (await preflightVideoJob({
      config,
      topic: "钟表店",
      castAssets: [castAsset({ imageFile: "big.png" })],
      checkEnvironment: false,
    }).then(
      () => null,
      (caught: unknown) => caught,
    )) as AppError;
    assert.ok(isPreflightError(error));
    assert.match(error.message, /参考图超过 8MB/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

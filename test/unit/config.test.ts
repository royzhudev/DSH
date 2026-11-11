import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConfig, resolveScriptProvider, summarizeConfig } from "../../src/config.js";
import { AppError } from "../../src/errors.js";
import { makeTempDir } from "../helpers.js";

test("loadConfig 合并配置文件、环境变量和命令行覆盖", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "video-agent.config.json"),
    JSON.stringify({ video: { width: 720 }, tts: { voice: "zh-CN-YunxiNeural" } }),
    "utf8",
  );
  const config = loadConfig({
    cwd: dir,
    env: { VIDEO_HEIGHT: "1000", TTS_PROVIDER: "silent" },
    overrides: { outputDir: "./custom-output" },
  });
  assert.equal(config.video.width, 720);
  assert.equal(config.video.height, 1000);
  assert.equal(config.tts.voice, "zh-CN-YunxiNeural");
  assert.equal(config.tts.provider, "silent");
  assert.equal(config.outputDir, path.join(dir, "custom-output"));
  assert.equal(config.libraryDir, path.join(dir, "materials"));
});

test("loadConfig 拒绝不存在的显式配置文件", async () => {
  const dir = await makeTempDir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: {}, configPath: "./missing.json" }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_NOT_FOUND",
  );
});

test("loadConfig 拒绝未知供应商", async () => {
  const dir = await makeTempDir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: { TTS_PROVIDER: "unknown" } }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_INVALID",
  );
});

test("openai 脚本供应商缺少密钥时给出明确错误", async () => {
  const dir = await makeTempDir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: { SCRIPT_PROVIDER: "openai" } }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_MISSING_API_KEY",
  );
});

test("auto 模式根据密钥选择大模型或离线模板", async () => {
  const dir = await makeTempDir();
  const noKey = loadConfig({ cwd: dir, env: {} });
  assert.equal(resolveScriptProvider(noKey), "offline");
  const withKey = loadConfig({ cwd: dir, env: { SCRIPT_API_KEY: "sk-test" } });
  assert.equal(resolveScriptProvider(withKey), "openai");
  const summary = summarizeConfig(withKey);
  assert.equal(summary.scriptProvider, "openai");
  assert.equal(summary.scriptModel, withKey.script.model);
});

test("视频尺寸会被校正为偶数", async () => {
  const dir = await makeTempDir();
  const config = loadConfig({
    cwd: dir,
    env: {},
    overrides: { video: { width: 721, height: 1081 } },
  });
  assert.equal(config.video.width, 722);
  assert.equal(config.video.height, 1082);
});
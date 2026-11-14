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

test("loadConfig 把阿里百炼的视频配置纠正为异步协议", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "video-agent.config.json"),
    JSON.stringify({
      videoGen: {
        provider: "http",
        // 用户手选过“通用 HTTP 契约”，服务地址却是阿里百炼：这种组合必然被平台拒绝。
        protocol: "generic",
        baseUrl: "  https://dashscope.aliyuncs.com  ",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
      },
    }),
    "utf8",
  );
  const config = loadConfig({ cwd: dir, env: {} });
  assert.equal(config.videoGen.baseUrl, "https://dashscope.aliyuncs.com");
  assert.equal(config.videoGen.protocol, "dashscope");
  assert.equal(
    config.videoGen.submitPath,
    "/api/v1/services/aigc/video-generation/video-synthesis",
  );
  assert.equal(config.videoGen.pollPath, "/api/v1/tasks/{id}");
});

test("loadConfig 给只填域名的百炼地址补上 https://", async () => {
  const dir = await makeTempDir();
  const config = loadConfig({
    cwd: dir,
    env: {},
    overrides: {
      videoGen: { provider: "http", protocol: "generic", baseUrl: "dashscope.aliyuncs.com" },
    },
  });
  assert.equal(config.videoGen.baseUrl, "https://dashscope.aliyuncs.com");
  assert.equal(config.videoGen.protocol, "dashscope");
});

test("loadConfig 收回被当成服务地址的百炼完整接口地址", async () => {
  const dir = await makeTempDir();
  const config = loadConfig({
    cwd: dir,
    env: {},
    overrides: {
      videoGen: {
        provider: "http",
        baseUrl:
          "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
        protocol: "auto",
      },
    },
  });
  assert.equal(config.videoGen.baseUrl, "https://dashscope.aliyuncs.com");
  assert.equal(config.videoGen.protocol, "auto");
});

test("loadConfig 不改动非阿里百炼地址上的通用协议", async () => {
  const dir = await makeTempDir();
  const config = loadConfig({
    cwd: dir,
    env: {},
    overrides: {
      videoGen: {
        provider: "http",
        protocol: "generic",
        baseUrl: "https://gateway.example.com",
        submitPath: "/v1/videos/generations",
        pollPath: "/v1/videos/generations/{id}",
      },
    },
  });
  assert.equal(config.videoGen.protocol, "generic");
  assert.equal(config.videoGen.submitPath, "/v1/videos/generations");
});

test("loadConfig 接受大小写混写的供应商名并统一成小写", async () => {
  const dir = await makeTempDir();
  // 设置页把选项标签（BAILIAN）原样存进配置 / 设置文件时，创建任务不应该被判为非法供应商。
  await fs.writeFile(
    path.join(dir, "video-agent.config.json"),
    JSON.stringify({
      script: { provider: "OFFLINE" },
      tts: { provider: " BAILIAN ", fallback: "SILENT" },
      videoGen: { provider: "HTTP", protocol: "DASHSCOPE" },
    }),
    "utf8",
  );
  const config = loadConfig({ cwd: dir, env: {} });
  assert.equal(config.script.provider, "offline");
  assert.equal(config.tts.provider, "bailian");
  assert.equal(config.tts.fallback, "silent");
  assert.equal(config.videoGen.provider, "http");
  assert.equal(config.videoGen.protocol, "dashscope");
});

test("loadConfig 仍然拒绝大小写归一化后依然未知的供应商", async () => {
  const dir = await makeTempDir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: { TTS_PROVIDER: "NOTAPROVIDER" } }),
    (error: unknown) => error instanceof AppError && error.code === "CONFIG_INVALID",
  );
});

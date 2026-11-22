import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { AppError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import { effectiveRedirectUri, SettingsStore } from "../../src/server/settings.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

async function makeStore(dir: string) {
  const config = makeTestConfig(dir);
  const store = new SettingsStore(config, {
    settingsPath: config.settingsFile,
    cwd: dir,
    env: {},
    logger: silentLogger,
  });
  return { config, store };
}

test("loadConfig 读取 data/settings.json，并让网页设置优先于环境变量", async () => {
  const dir = await makeTempDir();
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "data", "settings.json"),
    JSON.stringify({ script: { model: "ui-model" }, tts: { voice: "zh-CN-YunxiNeural" } }),
    "utf8",
  );
  const config = loadConfig({ cwd: dir, env: { SCRIPT_MODEL: "env-model" } });
  assert.equal(config.script.model, "ui-model");
  assert.equal(config.tts.voice, "zh-CN-YunxiNeural");
});

test("配置文件可以指定 settingsFile 路径", async () => {
  const dir = await makeTempDir();
  await fs.mkdir(path.join(dir, "custom"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "video-agent.config.json"),
    JSON.stringify({ settingsFile: "./custom/settings.json" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "custom", "settings.json"),
    JSON.stringify({ script: { model: "custom-model" } }),
    "utf8",
  );
  const config = loadConfig({ cwd: dir, env: {} });
  assert.equal(config.settingsFile, path.join(dir, "custom", "settings.json"));
  assert.equal(config.script.model, "custom-model");
});

test("SettingsStore 保存模型与密钥、屏蔽回显并应用 0600 权限", async () => {
  const dir = await makeTempDir();
  const { config, store } = await makeStore(dir);
  const initial = await store.view();
  assert.equal(initial.script.apiKeySet, false);

  const updated = await store.update({
    script: { model: "ui-model", apiKey: "sk-test-123456" },
    tts: { provider: "silent", voice: "zh-CN-YunxiNeural" },
  });
  assert.equal(config.script.model, "ui-model");
  assert.equal(config.tts.provider, "silent");
  assert.equal(updated.script.apiKeySet, true);
  assert.equal(updated.script.apiKeyHint, "…3456");
  assert.equal(JSON.stringify(updated).includes("sk-test-123456"), false);

  const raw = await fs.readFile(config.settingsFile, "utf8");
  assert.match(raw, /sk-test-123456/);
  const mode = (await fs.stat(config.settingsFile)).mode & 0o777;
  assert.equal(mode, 0o600);

  const cleared = await store.update({ script: { apiKey: null } });
  assert.equal(cleared.script.apiKeySet, false);
  assert.equal(config.script.apiKey, "");
});

test("SettingsStore 拒绝非法配置并保留原设置", async () => {
  const dir = await makeTempDir();
  const { config, store } = await makeStore(dir);
  await assert.rejects(
    store.update({ tts: { provider: "unknown" } }),
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
  await assert.rejects(
    store.update({ videoGen: { provider: "http", pollPath: "/api/v1/tasks" } }),
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
  assert.equal(config.tts.provider, "silent");
});

test("effectiveRedirectUri 处理空值与通配监听地址", () => {
  const dir = "/tmp";
  const config = makeTestConfig(dir, { server: { host: "0.0.0.0", port: 9000 } });
  assert.equal(config.douyin.redirectUri, "");
  assert.equal(effectiveRedirectUri(config), "http://127.0.0.1:9000/api/douyin/callback");
  config.douyin.redirectUri = "https://example.com/cb";
  assert.equal(effectiveRedirectUri(config), "https://example.com/cb");
});

test("SettingsStore 把大写供应商名保存成小写，创建任务不再报不支持的供应商", async () => {
  const dir = await makeTempDir();
  const { config, store } = await makeStore(dir);
  await store.update({ tts: { provider: "BAILIAN", model: "cosyvoice-v3-plus" } });
  assert.equal(config.tts.provider, "bailian");

  const raw = JSON.parse(await fs.readFile(config.settingsFile, "utf8")) as {
    tts?: { provider?: string };
  };
  assert.equal(raw.tts?.provider, "bailian");

  // 重新加载（等价于重启服务后创建任务）也要通过校验。
  const reloaded = loadConfig({ cwd: dir, env: {}, settingsPath: config.settingsFile });
  assert.equal(reloaded.tts.provider, "bailian");
});

test("SettingsStore 选中画面渠道后只填 API Key，其余参数自动生成并可重启恢复", async () => {
  const dir = await makeTempDir();
  const { config, store } = await makeStore(dir);
  const saved = await store.update({
    videoGen: { channel: "aggregator-seedance2", apiKey: "tk-seedance" },
  });
  assert.equal(config.videoGen.channel, "aggregator-seedance2");
  assert.equal(config.videoGen.provider, "http");
  assert.equal(config.videoGen.protocol, "seedance");
  assert.equal(config.videoGen.baseUrl, "https://tokease.cn");
  assert.equal(config.videoGen.model, "Seedance 2.0");
  assert.equal(config.videoGen.submitPath, "/v1/video/generations");
  assert.equal(config.videoGen.pollPath, "/v1/video/generations/{id}");
  assert.equal(config.videoGen.resultPath, "output.video_url");
  assert.equal(config.videoGen.apiKey, "tk-seedance");
  assert.equal(saved.videoGen.apiKeySet, true);
  assert.equal(saved.videoGen.model, "Seedance 2.0");
  assert.equal(saved.videoGenChannels.find((item) => item.channel === "aggregator-seedance2")?.fields?.model, "Seedance 2.0");

  // 重启服务后重新读取设置，渠道与自动参数都要保留。
  const reloaded = loadConfig({ cwd: dir, env: {}, settingsPath: config.settingsFile });
  assert.equal(reloaded.videoGen.channel, "aggregator-seedance2");
  assert.equal(reloaded.videoGen.model, "Seedance 2.0");
  assert.equal(reloaded.videoGen.protocol, "seedance");

  // 切回百炼同样只需要给渠道与 Key。
  await store.update({ videoGen: { channel: "bailian-wan3", apiKey: null } });
  assert.equal(config.videoGen.channel, "bailian-wan3");
  assert.equal(config.videoGen.protocol, "dashscope");
  assert.equal(config.videoGen.baseUrl, "https://dashscope.aliyuncs.com");
  assert.equal(config.videoGen.model, "wan3.0-video");
  assert.equal(config.videoGen.model, "wan3.0-video");
  assert.equal(config.videoGen.apiKey, "");
});

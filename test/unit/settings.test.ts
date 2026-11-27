import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { AppError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import {
  PlatformSettingsStore,
  effectiveRedirectUri,
  SettingsStore,
} from "../../src/server/settings.js";
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

test("SettingsStore 选中 One API Lumi 渠道后只填 API Key，模型可切换并可重启恢复", async () => {
  const dir = await makeTempDir();
  const { config, store } = await makeStore(dir);
  const saved = await store.update({
    videoGen: { channel: "aggregator-seedance2", apiKey: "sk-lumi" },
  });
  assert.equal(config.videoGen.channel, "aggregator-seedance2");
  assert.equal(config.videoGen.provider, "http");
  assert.equal(config.videoGen.protocol, "seedance");
  assert.equal(config.videoGen.baseUrl, "https://nexus.cytain.com");
  assert.equal(config.videoGen.model, "doubao-seedance-2-5-260628");
  assert.equal(config.videoGen.submitPath, "/api/v3/contents/generations/tasks");
  assert.equal(config.videoGen.pollPath, "/api/v3/contents/generations/tasks/{id}");
  assert.equal(config.videoGen.resultPath, "content.video_url");
  assert.equal(config.videoGen.apiKey, "sk-lumi");
  assert.equal(saved.videoGen.apiKeySet, true);
  assert.equal(saved.videoGen.model, "doubao-seedance-2-5-260628");
  const lumi = saved.videoGenChannels.find((item) => item.channel === "aggregator-seedance2");
  assert.equal(lumi?.fields?.model, "doubao-seedance-2-5-260628");
  assert.equal(lumi?.models?.length, 4);

  // 同一渠道下切换模型：只额外传 model，其余参数仍自动生成。
  await store.update({
    videoGen: { channel: "aggregator-seedance2", model: "doubao-seedance-2-0-260128" },
  });
  assert.equal(config.videoGen.model, "doubao-seedance-2-0-260128");
  const reloaded = loadConfig({ cwd: dir, env: {}, settingsPath: config.settingsFile });
  assert.equal(reloaded.videoGen.channel, "aggregator-seedance2");
  assert.equal(reloaded.videoGen.model, "doubao-seedance-2-0-260128");
  assert.equal(reloaded.videoGen.protocol, "seedance");
  assert.equal(reloaded.videoGen.baseUrl, "https://nexus.cytain.com");

  // 切回百炼同样只需要给渠道与 Key。
  await store.update({ videoGen: { channel: "bailian-wan3", apiKey: null } });
  assert.equal(config.videoGen.channel, "bailian-wan3");
  assert.equal(config.videoGen.protocol, "dashscope");
  assert.equal(config.videoGen.baseUrl, "https://dashscope.aliyuncs.com");
  assert.equal(config.videoGen.model, "wan3.0-video");
  assert.equal(config.videoGen.apiKey, "");
});

test("SettingsStore 保存公网素材地址时生成随机令牌，清除地址时一并清除", async () => {
  const dir = await makeTempDir();
  const { config, store } = await makeStore(dir);
  await store.update({
    videoGen: {
      channel: "aggregator-seedance2",
      apiKey: "sk-lumi",
      publicBaseUrl: "https://video.example.com/",
    },
  });
  assert.equal(config.videoGen.publicBaseUrl, "https://video.example.com");
  const firstToken = config.videoGen.publicAssetToken;
  assert.ok(firstToken.length >= 20);
  const view = await store.update({ videoGen: { publicBaseUrl: "https://video.example.com" } });
  assert.equal(view.videoGen.publicAssetToken, firstToken, "同一地址再次保存不应换令牌");

  await store.update({ videoGen: { publicBaseUrl: "" } });
  assert.equal(config.videoGen.publicAssetToken, "");
  const cleared = await store.update({ videoGen: { apiKey: "sk-lumi" } });
  assert.equal(cleared.videoGen.publicAssetToken, "");
});

test("PlatformSettingsStore：邮件通道、注册与抖音凭证保存后重启可恢复，密钥不回显", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const store = new PlatformSettingsStore(config, {
    settingsPath: config.settingsFile,
    cwd: dir,
    env: {},
    logger: silentLogger,
  });
  try {
    const view = await store.update({
      server: { publicBaseUrl: "https://video.example.com/" },
      mail: {
        enabled: true,
        host: "smtp.example.com",
        port: 587,
        secure: false,
        starttls: true,
        user: "noreply@example.com",
        from: "noreply@example.com",
        password: "smtp-secret",
      },
      registration: { enabled: true, allowedEmailDomains: ["Example.com", "@company.cn"] },
      douyin: { mode: "miniapp", clientKey: "miniapp-client-key", clientSecret: "miniapp-client-secret" },
    });
    assert.equal(config.douyin.mode, "miniapp");
    assert.equal(config.mail.host, "smtp.example.com");
    assert.equal(config.mail.starttls, true);
    assert.equal(config.server.publicBaseUrl, "https://video.example.com");
    assert.deepEqual(config.registration.allowedEmailDomains, ["example.com", "company.cn"]);
    assert.equal(view.mail.passwordSet, true);
    assert.equal((view.mail as Record<string, unknown>).password, undefined);
    assert.equal(view.douyin.clientSecretSet, true);
    assert.equal((view.douyin as Record<string, unknown>).clientSecret, undefined);

    const reloaded = loadConfig({ cwd: dir, env: {}, settingsPath: config.settingsFile });
    assert.equal(reloaded.douyin.mode, "miniapp");
    assert.equal(reloaded.mail.user, "noreply@example.com");
    assert.equal(reloaded.registration.enabled, true);

    await assert.rejects(() => store.update({ mail: { port: -1 } }), AppError);
    await assert.rejects(() => store.update({ douyin: { mode: "unknown" } }), AppError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("PlatformSettingsStore：旧版全局设置里的个人段不会污染平台默认配置", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  await fs.mkdir(path.dirname(config.settingsFile), { recursive: true });
  await fs.writeFile(
    config.settingsFile,
    JSON.stringify({
      script: { apiKey: "legacy-admin-key" },
      videoGen: { channel: "aggregator-seedance2", apiKey: "legacy-video-key" },
      douyin: { mode: "miniapp" },
    }),
    "utf8",
  );
  // 启动时 loadConfig 会把旧文件整份合并进来，个人段需要迁移后清理。
  const polluted = loadConfig({ cwd: dir, env: {} });
  assert.equal(polluted.script.apiKey, "legacy-admin-key");

  const store = new PlatformSettingsStore(polluted, {
    settingsPath: polluted.settingsFile,
    cwd: dir,
    env: {},
    logger: silentLogger,
  });
  await store.ensureLoaded();
  await store.resetPersonalSections(["script", "videoGen"]);
  assert.ok(!polluted.script.apiKey);
  assert.ok(!polluted.videoGen.apiKey);
  assert.equal(polluted.douyin.mode, "miniapp");

  // 之后保存平台设置，也不能把文件里的旧个人设置再带回来。
  await store.update({ registration: { enabled: false } });
  assert.ok(!polluted.script.apiKey);
  assert.equal(polluted.registration.enabled, false);
  await fs.rm(dir, { recursive: true, force: true });
});

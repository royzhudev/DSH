import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { silentLogger } from "../../src/logger.js";
import { migrateLegacyWorkspace } from "../../src/server/migrate.js";
import { UserStore } from "../../src/server/users.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

test("多租户迁移：旧数据搬进管理员工作区，个人设置与平台设置拆分，且可重复执行", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const dataDir = path.join(dir, "data");
  const usersPath = path.join(dataDir, "users.json");
  await fs.mkdir(dataDir, { recursive: true });

  const users = new UserStore(usersPath, silentLogger);
  const admin = await users.create({
    username: "legacy-admin",
    password: "legacy-password-1",
    role: "admin",
  });

  const legacyJobId = "20261101-120000-abcdef12";
  await fs.mkdir(path.join(config.outputDir, legacyJobId), { recursive: true });
  await fs.writeFile(path.join(config.outputDir, legacyJobId, "job.json"), '{"id":"legacy"}', "utf8");
  await fs.mkdir(config.libraryDir, { recursive: true });
  await fs.writeFile(path.join(config.libraryDir, "legacy.mp4"), "video", "utf8");
  await fs.mkdir(config.castDir, { recursive: true });
  await fs.writeFile(path.join(config.castDir, "legacy.png"), "image", "utf8");
  await fs.mkdir(config.cacheDir, { recursive: true });
  await fs.writeFile(path.join(config.cacheDir, "douyin-token.json"), '{"accessToken":"t"}', "utf8");
  await fs.writeFile(path.join(dataDir, "publishes.json"), "[]", "utf8");
  await fs.writeFile(path.join(dataDir, "douyin-h5-shares.json"), "[]", "utf8");
  await fs.writeFile(
    config.settingsFile,
    JSON.stringify({
      script: { model: "legacy-model" },
      videoGen: { publicBaseUrl: "https://legacy.example.com/", apiKey: "legacy-key" },
      douyin: { mode: "miniapp" },
      registration: { enabled: false },
    }),
    "utf8",
  );

  const result = await migrateLegacyWorkspace({
    dataDir,
    usersPath,
    config,
    logger: silentLogger,
  });
  assert.equal(result.status, "migrated");
  assert.equal(result.adminUserId, admin.id);

  const userDataDir = path.join(dataDir, "users", admin.id);
  assert.equal(
    await fs.readFile(path.join(config.outputDir, "users", admin.id, legacyJobId, "job.json"), "utf8"),
    '{"id":"legacy"}',
  );
  assert.equal(await fs.readFile(path.join(config.libraryDir, "users", admin.id, "legacy.mp4"), "utf8"), "video");
  assert.equal(await fs.readFile(path.join(config.castDir, "users", admin.id, "legacy.png"), "utf8"), "image");
  assert.equal(await fs.readFile(path.join(userDataDir, "publishes.json"), "utf8"), "[]");
  assert.equal(await fs.readFile(path.join(userDataDir, "douyin-token.json"), "utf8"), '{"accessToken":"t"}');

  const personal = JSON.parse(await fs.readFile(path.join(userDataDir, "settings.json"), "utf8")) as {
    script?: { model?: string };
    videoGen?: { publicBaseUrl?: string };
    douyin?: unknown;
  };
  assert.equal(personal.script?.model, "legacy-model");
  assert.equal(personal.douyin, undefined);

  const platform = JSON.parse(await fs.readFile(config.settingsFile, "utf8")) as {
    douyin?: { mode?: string };
    registration?: { enabled?: boolean };
    server?: { publicBaseUrl?: string };
    script?: unknown;
  };
  assert.equal(platform.douyin?.mode, "miniapp");
  assert.equal(platform.registration?.enabled, false);
  assert.equal(platform.server?.publicBaseUrl, "https://legacy.example.com");
  assert.equal(platform.script, undefined);

  const again = await migrateLegacyWorkspace({ dataDir, usersPath, config, logger: silentLogger });
  assert.equal(again.status, "already");
  assert.equal(again.adminUserId, admin.id);
});

test("多租户迁移：没有管理员时跳过", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const usersPath = path.join(dataDir, "users.json");
  const result = await migrateLegacyWorkspace({ dataDir, usersPath, config, logger: silentLogger });
  assert.equal(result.status, "no-admin");
});
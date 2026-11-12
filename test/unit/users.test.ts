import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { silentLogger } from "../../src/logger.js";
import { UserStore, verifyPassword } from "../../src/server/users.js";
import { makeTempDir } from "../helpers.js";

async function makeStore(): Promise<{ dir: string; store: UserStore }> {
  const dir = await makeTempDir();
  return { dir, store: new UserStore(path.join(dir, "data", "users.json"), silentLogger) };
}

test("用户存储：初始化管理员、密码哈希与持久化", async () => {
  const { dir, store } = await makeStore();
  try {
    assert.equal(await store.hasUsers(), false);
    const admin = await store.setup({
      username: "admin",
      displayName: "管理员",
      password: "admin-password-1",
    });
    assert.equal(admin.role, "admin");
    assert.deepEqual(admin.permissions, ["create", "jobs", "cast", "materials", "publish", "settings"]);
    assert.equal(await store.hasUsers(), true);

    const verified = await store.verify("admin", "admin-password-1");
    assert.ok(verified);
    assert.equal(await store.verify("admin", "wrong-password"), null);
    assert.equal(await store.verify("nobody", "admin-password-1"), null);

    const raw = await fs.readFile(path.join(dir, "data", "users.json"), "utf8");
    assert.ok(!raw.includes("admin-password-1"), "密码不应以明文写入文件");
    const parsed = JSON.parse(raw) as { users: Array<{ passwordHash: string }> };
    assert.match(parsed.users[0]!.passwordHash, /^scrypt\$/);
    assert.equal(await verifyPassword("admin-password-1", parsed.users[0]!.passwordHash), true);

    const reloaded = new UserStore(path.join(dir, "data", "users.json"), silentLogger);
    const users = await reloaded.list();
    assert.equal(users.length, 1);
    assert.equal(users[0]!.username, "admin");
    assert.ok(await reloaded.verify("admin", "admin-password-1"));

    await assert.rejects(
      () => store.setup({ username: "another", password: "another-password-1" }),
      (error: { code?: string; status?: number }) => error.code === "SETUP_ALREADY_DONE" && error.status === 409,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("用户权限：菜单归一化、编辑、禁用与最后管理员保护", async () => {
  const { dir, store } = await makeStore();
  try {
    const admin = await store.setup({ username: "admin", password: "admin-password-1" });
    const member = await store.create({
      username: "editor",
      displayName: "剪辑师",
      password: "editor-password-1",
      role: "member",
      permissions: ["create", "materials", "create"],
    });
    assert.deepEqual(member.permissions, ["create", "jobs", "cast", "materials"]);

    await assert.rejects(
      () => store.create({ username: "EDITOR", password: "editor-password-1" }),
      (error: { code?: string }) => error.code === "USERNAME_TAKEN",
    );
    await assert.rejects(
      () => store.create({ username: "x", password: "editor-password-1" }),
      (error: { code?: string }) => error.code === "USERNAME_INVALID",
    );
    await assert.rejects(
      () => store.create({ username: "shorty", password: "123" }),
      (error: { code?: string }) => error.code === "PASSWORD_INVALID",
    );

    const updated = await store.update(
      member.id,
      { permissions: ["jobs", "publish"], displayName: "新剪辑师" },
      admin.id,
    );
    assert.deepEqual(updated.permissions, ["jobs", "publish"]);
    assert.equal(updated.displayName, "新剪辑师");

    const disabled = await store.update(member.id, { disabled: true }, admin.id);
    assert.equal(disabled.disabled, true);
    assert.equal(await store.verify("editor", "editor-password-1"), null);

    await assert.rejects(
      () => store.update(admin.id, { role: "member" }, member.id),
      (error: { code?: string }) => error.code === "LAST_ADMIN",
    );
    await assert.rejects(
      () => store.update(admin.id, { disabled: true }, member.id),
      (error: { code?: string }) => error.code === "LAST_ADMIN",
    );
    await assert.rejects(
      () => store.update(admin.id, { role: "member" }, admin.id),
      (error: { code?: string }) => error.code === "SELF_ROLE_CHANGE",
    );
    await assert.rejects(
      () => store.remove(admin.id, admin.id),
      (error: { code?: string }) => error.code === "SELF_DELETE",
    );
    await assert.rejects(
      () => store.remove(admin.id, member.id),
      (error: { code?: string }) => error.code === "LAST_ADMIN",
    );

    const secondAdmin = await store.create({
      username: "ops",
      password: "ops-password-1",
      role: "admin",
    });
    assert.deepEqual(secondAdmin.permissions, ["create", "jobs", "cast", "materials", "publish", "settings"]);
    const demoted = await store.update(secondAdmin.id, { role: "member" }, admin.id);
    assert.equal(demoted.role, "member");
    assert.deepEqual(demoted.permissions, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("用户密码：重置后旧密码失效", async () => {
  const { dir, store } = await makeStore();
  try {
    const admin = await store.setup({ username: "admin", password: "admin-password-1" });
    const member = await store.create({
      username: "editor",
      password: "editor-password-1",
      role: "member",
      permissions: ["jobs"],
    });
    await store.update(member.id, { password: "editor-password-2" }, admin.id);
    assert.equal(await store.verify("editor", "editor-password-1"), null);
    assert.ok(await store.verify("editor", "editor-password-2"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("用户数据损坏时拒绝启动而不是当作空库", async () => {
  const { dir, store } = await makeStore();
  try {
    await fs.mkdir(path.dirname(store.usersPath), { recursive: true });
    await fs.writeFile(store.usersPath, "{ not json", "utf8");
    await assert.rejects(
      () => store.ensureLoaded(),
      (error: { code?: string; status?: number }) => error.code === "USERS_CORRUPTED" && error.status === 500,
    );
    await assert.rejects(
      () => store.hasUsers(),
      (error: { code?: string }) => error.code === "USERS_CORRUPTED",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
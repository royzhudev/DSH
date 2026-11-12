import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { loginTestUser, makeTempDir, makeTestConfig, setupTestAdmin, withCookie } from "../helpers.js";

function jsonRequest(
  requestImpl: typeof fetch,
  url: string,
  body: unknown,
  method = "POST",
): Promise<Response> {
  return requestImpl(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "用户体系：首次初始化、登录会话、菜单权限与用户管理",
  { timeout: 120_000 },
  async (t) => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { server: { port: 0 } });
    const app = await startServer(config, silentLogger);
    t.after(async () => {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const anonymousSession = (await (await fetch(`${app.url}/api/auth/session`)).json()) as {
      authenticated: boolean;
      needsSetup: boolean;
    };
    assert.equal(anonymousSession.authenticated, false);
    assert.equal(anonymousSession.needsSetup, true);

    const unauthorized = await fetch(`${app.url}/api/videos`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedBody = (await unauthorized.json()) as { error: { code: string } };
    assert.equal(unauthorizedBody.error.code, "AUTH_REQUIRED");

    const home = await fetch(`${app.url}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /视频创作智能体/);
    const appScript = await fetch(`${app.url}/js/app.js`);
    assert.equal(appScript.status, 200);
    const index = (await (await fetch(`${app.url}/api`)).json()) as {
      endpoints: Record<string, string>;
    };
    assert.ok(index.endpoints.login);
    assert.ok(index.endpoints.users);

    const invalidSetup = await jsonRequest(fetch, `${app.url}/api/auth/setup`, {
      username: "ab",
      password: "short",
    });
    assert.equal(invalidSetup.status, 400);

    const admin = await setupTestAdmin(app.url);
    assert.equal(admin.user.role, "admin");
    assert.deepEqual(admin.user.permissions, ["create", "jobs", "cast", "materials", "publish", "settings"]);

    const secondSetup = await jsonRequest(fetch, `${app.url}/api/auth/setup`, {
      username: "another",
      password: "another-password-1",
    });
    assert.equal(secondSetup.status, 409);

    const adminRequest = withCookie(admin.cookie);
    const adminSession = (await (await adminRequest(`${app.url}/api/auth/session`)).json()) as {
      authenticated: boolean;
      needsSetup: boolean;
      user: { username: string; role: string };
    };
    assert.equal(adminSession.authenticated, true);
    assert.equal(adminSession.needsSetup, false);
    assert.equal(adminSession.user.username, "admin");
    assert.equal(adminSession.user.role, "admin");

    const createMember = await jsonRequest(adminRequest, `${app.url}/api/users`, {
      username: "editor",
      displayName: "剪辑师",
      password: "editor-password-1",
      role: "member",
      permissions: ["create", "materials"],
    });
    assert.equal(createMember.status, 201, await createMember.clone().text());
    const member = ((await createMember.json()) as { user: { id: string; permissions: string[] } }).user;
    assert.deepEqual(member.permissions, ["create", "jobs", "cast", "materials"]);

    const memberLogin = await loginTestUser(app.url, "editor", "editor-password-1");
    assert.deepEqual(memberLogin.user.permissions, ["create", "jobs", "cast", "materials"]);
    const memberRequest = withCookie(memberLogin.cookie);

    assert.equal((await memberRequest(`${app.url}/api/videos`)).status, 200);
    assert.equal((await memberRequest(`${app.url}/api/settings`)).status, 200);
    const memberSettingsWrite = await jsonRequest(
      memberRequest,
      `${app.url}/api/settings`,
      { script: { temperature: 0.2 } },
      "PUT",
    );
    assert.equal(memberSettingsWrite.status, 403);

    const usersForbidden = await memberRequest(`${app.url}/api/users`);
    assert.equal(usersForbidden.status, 403);
    assert.equal(((await usersForbidden.json()) as { error: { code: string } }).error.code, "FORBIDDEN");

    const scriptPreview = await jsonRequest(memberRequest, `${app.url}/api/scripts/generate`, {
      topic: "城市夜景",
      targetDurationSec: 10,
      maxSegments: 2,
    });
    assert.equal(scriptPreview.status, 200, await scriptPreview.clone().text());

    assert.equal((await memberRequest(`${app.url}/api/douyin/status`)).status, 403);

    const updatePermissions = await jsonRequest(
      adminRequest,
      `${app.url}/api/users/${member.id}`,
      { permissions: ["jobs"] },
      "PATCH",
    );
    assert.equal(updatePermissions.status, 200);
    const refreshedSession = (await (await memberRequest(`${app.url}/api/auth/session`)).json()) as {
      menus: string[];
    };
    assert.deepEqual(refreshedSession.menus, ["jobs"]);
    assert.equal((await memberRequest(`${app.url}/api/materials`)).status, 403);

    const selfDemote = await jsonRequest(
      adminRequest,
      `${app.url}/api/users/${admin.user.id}`,
      { role: "member" },
      "PATCH",
    );
    assert.equal(selfDemote.status, 400);
    const selfDelete = await adminRequest(`${app.url}/api/users/${admin.user.id}`, { method: "DELETE" });
    assert.equal(selfDelete.status, 400);

    const disable = await jsonRequest(
      adminRequest,
      `${app.url}/api/users/${member.id}`,
      { disabled: true },
      "PATCH",
    );
    assert.equal(disable.status, 200);
    assert.equal((await memberRequest(`${app.url}/api/videos`)).status, 401);
    const disabledLogin = await jsonRequest(fetch, `${app.url}/api/auth/login`, {
      username: "editor",
      password: "editor-password-1",
    });
    assert.equal(disabledLogin.status, 401);

    const resetPassword = await jsonRequest(
      adminRequest,
      `${app.url}/api/users/${member.id}`,
      { disabled: false, password: "editor-password-2" },
      "PATCH",
    );
    assert.equal(resetPassword.status, 200);
    const oldLogin = await jsonRequest(fetch, `${app.url}/api/auth/login`, {
      username: "editor",
      password: "editor-password-1",
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await loginTestUser(app.url, "editor", "editor-password-2");
    assert.ok(newLogin.cookie);

    const logout = await adminRequest(`${app.url}/api/auth/logout`, { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal((await adminRequest(`${app.url}/api/videos`)).status, 401);

    const crossOrigin = await fetch(`${app.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ username: "admin", password: "admin-password-1" }),
    });
    assert.equal(crossOrigin.status, 403);

    const sameOrigin = await fetch(`${app.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(app.url).origin },
      body: JSON.stringify({ username: "admin", password: "admin-password-1" }),
    });
    assert.equal(sameOrigin.status, 200);
  },
);
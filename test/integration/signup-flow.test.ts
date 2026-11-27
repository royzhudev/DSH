import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import type { JobManager, JobRecord } from "../../src/server/jobs.js";
import { silentLogger } from "../../src/logger.js";
import type { MailTransport } from "../../src/server/mailer.js";
import {
  loginTestUser,
  makeTempDir,
  makeTestConfig,
  setupTestAdmin,
  withCookie,
} from "../helpers.js";

interface SentMessage {
  to: string;
  text: string;
}

function codeFrom(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  assert.ok(match, `邮件正文里没有验证码：${text}`);
  return match[1]!;
}

function json(fetchImpl: typeof fetch, url: string, body: unknown, method = "POST"): Promise<Response> {
  return fetchImpl(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("邮箱验证码注册、平台设置与账号隔离", { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, { server: { port: 0 } });
  const sent: SentMessage[] = [];
  const transport: MailTransport = {
    async sendMail(message) {
      sent.push({ to: message.to, text: message.text });
      return { messageId: "test", accepted: [message.to] };
    },
  };
  const app = await startServer(config, silentLogger, { mailTransportFactory: () => transport });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const admin = await setupTestAdmin(app.url);
  const adminFetch = withCookie(admin.cookie);

  // 默认关闭注册：没有 HTTPS/邮件通道前，匿名会话看不到注册入口。
  const beforeEnable = (await (await fetch(`${app.url}/api/auth/session`)).json()) as {
    registration: { enabled: boolean; mailConfigured: boolean };
  };
  assert.equal(beforeEnable.registration.enabled, false);
  assert.equal(beforeEnable.registration.mailConfigured, false);

  // 邮件通道 + 注册开关由管理员配置。
  const platformSave = await json(adminFetch, `${app.url}/api/settings/platform`, {
    server: { publicBaseUrl: "https://video.example.com/" },
    mail: {
      enabled: true,
      host: "smtp.example.com",
      port: 465,
      secure: true,
      starttls: false,
      user: "noreply@example.com",
      from: "noreply@example.com",
      fromName: "视频创作智能体",
      password: "not-a-real-password",
    },
    registration: { enabled: true, allowedEmailDomains: [] },
  }, "PUT");
  assert.equal(platformSave.status, 200, await platformSave.clone().text());
  const platformView = (await platformSave.json()) as {
    settings: { mail: { passwordSet: boolean; configured: boolean }; server: { publicBaseUrl: string } };
  };
  assert.equal(platformView.settings.mail.passwordSet, true);
  assert.equal(platformView.settings.mail.configured, true);
  assert.equal(platformView.settings.server.publicBaseUrl, "https://video.example.com");

  const anonymous = (await (await fetch(`${app.url}/api/auth/session`)).json()) as {
    registration: { enabled: boolean; mailConfigured: boolean };
  };
  assert.equal(anonymous.registration.enabled, true);
  assert.equal(anonymous.registration.mailConfigured, true);

  // 注册 Alice 并通过邮件里的验证码登录。
  const signupAlice = await json(fetch, `${app.url}/api/auth/signup`, {
    email: "Alice@Example.com",
    password: "alice-password-1",
    displayName: "Alice",
  });
  assert.equal(signupAlice.status, 202, await signupAlice.clone().text());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "alice@example.com");
  const aliceCode = codeFrom(sent[0]!.text);

  const verifyAlice = await json(fetch, `${app.url}/api/auth/verify-email`, {
    email: "alice@example.com",
    code: aliceCode,
  });
  assert.equal(verifyAlice.status, 200, await verifyAlice.clone().text());
  const aliceCookie =
    (verifyAlice.headers.getSetCookie?.()[0] ?? verifyAlice.headers.get("set-cookie") ?? "").split(";")[0]!;
  const alice = ((await verifyAlice.json()) as { user: { id: string; email: string; emailVerified: boolean } }).user;
  assert.equal(alice.email, "alice@example.com");
  assert.equal(alice.emailVerified, true);
  const aliceFetch = withCookie(aliceCookie);

  // 平台公网地址成为个人默认值，并生成独立的素材令牌。
  const aliceSettings = (await (await aliceFetch(`${app.url}/api/settings`)).json()) as {
    settings: {
      script: { apiKeySet: boolean };
      videoGen: { publicBaseUrl: string; publicAssetToken: string };
      server: { publicBaseUrl: string };
    };
  };
  assert.equal(aliceSettings.settings.script.apiKeySet, false);
  assert.equal(aliceSettings.settings.videoGen.publicBaseUrl, "https://video.example.com");
  assert.ok(aliceSettings.settings.videoGen.publicAssetToken);

  // 每个用户配置自己的 API Key，互不可见。
  const saveKey = await json(aliceFetch, `${app.url}/api/settings`, {
    script: { apiKey: "alice-only-key-123" },
  }, "PUT");
  assert.equal(saveKey.status, 200, await saveKey.clone().text());
  const aliceAfterSave = (await (await aliceFetch(`${app.url}/api/settings`)).json()) as {
    settings: { script: { apiKeySet: boolean; apiKeyHint?: string } };
  };
  assert.equal(aliceAfterSave.settings.script.apiKeySet, true);
  assert.equal("apiKey" in aliceAfterSave.settings.script, false);

  // 注册 Bob：看不到 Alice 的 Key 和令牌。
  const signupBob = await json(fetch, `${app.url}/api/auth/signup`, {
    email: "bob@example.com",
    password: "bob-password-11",
    displayName: "Bob",
  });
  assert.equal(signupBob.status, 202, await signupBob.clone().text());
  const bobCode = codeFrom(sent.at(-1)!.text);
  const verifyBob = await json(fetch, `${app.url}/api/auth/verify-email`, {
    email: "bob@example.com",
    code: bobCode,
  });
  assert.equal(verifyBob.status, 200, await verifyBob.clone().text());
  const bobCookie =
    (verifyBob.headers.getSetCookie?.()[0] ?? verifyBob.headers.get("set-cookie") ?? "").split(";")[0]!;
  const bobFetch = withCookie(bobCookie);
  const bobSettings = (await (await bobFetch(`${app.url}/api/settings`)).json()) as {
    settings: { script: { apiKeySet: boolean }; videoGen: { publicAssetToken: string } };
  };
  assert.equal(bobSettings.settings.script.apiKeySet, false);
  assert.notEqual(bobSettings.settings.videoGen.publicAssetToken, aliceSettings.settings.videoGen.publicAssetToken);

  // 普通成员不能看用户列表或改平台设置。
  assert.equal((await bobFetch(`${app.url}/api/users`)).status, 403);
  assert.equal((await bobFetch(`${app.url}/api/settings/platform`)).status, 403);
  assert.equal(
    (await json(bobFetch, `${app.url}/api/settings/platform`, { registration: { enabled: false } }, "PUT")).status,
    403,
  );

  // 管理员能看到成员的邮箱与验证状态。
  const users = (await (await adminFetch(`${app.url}/api/users`)).json()) as {
    users: Array<{ email?: string; emailVerified?: boolean }>;
  };
  assert.equal(users.users.filter((user) => user.email).length, 2);
  assert.ok(users.users.every((user) => !user.email || user.emailVerified));

  // 管理员测试邮件通道走同一个（假）发送后端。
  const beforeTest = sent.length;
  const mailTest = await json(adminFetch, `${app.url}/api/settings/mail/test`, { to: "admin@example.com" });
  assert.equal(mailTest.status, 200, await mailTest.clone().text());
  assert.equal(sent.length, beforeTest + 1);

  // 注册关闭时（方案要求 HTTPS 就绪前默认关闭），注册与验证码接口直接拒绝。
  assert.equal(
    (await json(adminFetch, `${app.url}/api/settings/platform`, { registration: { enabled: false } }, "PUT")).status,
    200,
  );
  const blockedSignup = await json(fetch, `${app.url}/api/auth/signup`, {
    email: "carol@example.com",
    password: "carol-password-1",
  });
  assert.equal(blockedSignup.status, 403);
  assert.equal(((await blockedSignup.json()) as { error: { code: string } }).error.code, "REGISTRATION_DISABLED");
  const blockedVerify = await json(fetch, `${app.url}/api/auth/verify-email`, {
    email: "alice@example.com",
    code: "123456",
  });
  assert.equal(blockedVerify.status, 403);
  assert.equal(
    (await json(adminFetch, `${app.url}/api/settings/platform`, { registration: { enabled: true } }, "PUT")).status,
    200,
  );

  // 任务详情按用户隔离：别人的任务 ID 一律 404。
  const fakeId = "20261127-000000-abcdef12";
  const fake = {
    id: fakeId,
    userId: alice.id,
    topic: "Alice 的任务",
    options: {},
    state: "succeeded",
    progress: { stage: "done", percent: 100, message: "成片已生成" },
    createdAt: new Date().toISOString(),
    config,
  } as unknown as JobRecord;
  const originalGet = app.jobs.get.bind(app.jobs);
  (app.jobs as JobManager).get = (id: string) => (id === fakeId ? fake : originalGet(id));
  assert.equal((await aliceFetch(`${app.url}/api/videos/${fakeId}`)).status, 200);
  assert.equal((await bobFetch(`${app.url}/api/videos/${fakeId}`)).status, 404);
  app.jobs.get = originalGet;

  // 忘记密码：重置后旧会话失效，新密码可登录。
  const forgot = await json(fetch, `${app.url}/api/auth/forgot-password`, { email: "alice@example.com" });
  assert.equal(forgot.status, 202, await forgot.clone().text());
  const resetCode = codeFrom(sent.at(-1)!.text);
  const reset = await json(fetch, `${app.url}/api/auth/reset-password`, {
    email: "alice@example.com",
    code: resetCode,
    password: "alice-password-2",
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal((await aliceFetch(`${app.url}/api/settings`)).status, 401);
  const relogin = await loginTestUser(app.url, "alice@example.com", "alice-password-2");
  assert.equal(relogin.user.role, "member");
});
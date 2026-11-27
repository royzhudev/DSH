import assert from "node:assert/strict";
import test from "node:test";
import { silentLogger } from "../../src/logger.js";
import { EmailCodeStore } from "../../src/server/emailCodes.js";
import { makeTempDir } from "../helpers.js";

function makeStore(dir: string, options: Partial<ConstructorParameters<typeof EmailCodeStore>[0]> = {}) {
  return new EmailCodeStore({ dataDir: dir, logger: silentLogger, ...options });
}

test("验证码：明文不落盘，验证成功后一次性作废", async () => {
  const dir = await makeTempDir();
  const store = makeStore(dir);
  const { code } = await store.issue("user@example.com", "signup", "127.0.0.1");
  assert.match(code, /^\d{6}$/);

  assert.equal(await store.verify("user@example.com", "signup", "000000" === code ? "111111" : "000000"), "invalid");
  assert.equal(await store.verify("user@example.com", "signup", code), "ok");
  // 已消费：同一个验证码不能再用。
  assert.equal(await store.verify("user@example.com", "signup", code), "invalid");
});

test("验证码：错误次数达到上限后直接作废", async () => {
  const dir = await makeTempDir();
  const store = makeStore(dir, { maxAttempts: 2 });
  const { code } = await store.issue("limit@example.com", "reset", "127.0.0.1");
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal(await store.verify("limit@example.com", "reset", wrong), "invalid");
  assert.equal(await store.verify("limit@example.com", "reset", wrong), "too_many");
  assert.equal(await store.verify("limit@example.com", "reset", code), "too_many");
});

test("验证码：过期后作废", async () => {
  const dir = await makeTempDir();
  const store = makeStore(dir, { ttlMs: 1 });
  const first = await store.issue("expire@example.com", "signup", "127.0.0.1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.verify("expire@example.com", "signup", first.code), "expired");
});

test("验证码：冷却期内不能重复发送", async () => {
  const dir = await makeTempDir();
  const store = makeStore(dir, { resendCooldownMs: 60_000 });
  await store.issue("cooldown@example.com", "signup", "127.0.0.1");
  await assert.rejects(
    () => store.issue("cooldown@example.com", "signup", "127.0.0.1"),
    (error: unknown) => (error as { code?: string }).code === "EMAIL_CODE_THROTTLED",
  );
});

test("验证码：同一 IP 一小时内超过上限会被限流", async () => {
  const dir = await makeTempDir();
  const store = makeStore(dir, { ipHourlyLimit: 1, resendCooldownMs: 0 });
  await store.issue("a@example.com", "signup", "10.0.0.1");
  await assert.rejects(
    () => store.issue("b@example.com", "signup", "10.0.0.1"),
    (error: unknown) => (error as { code?: string }).code === "EMAIL_CODE_THROTTLED",
  );
});

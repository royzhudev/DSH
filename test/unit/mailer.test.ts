import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { MailSender, type MailTransport } from "../../src/server/mailer.js";

interface SentMessage {
  to: string;
  subject: string;
  text: string;
}

function fakeTransport(sent: SentMessage[]): MailTransport {
  return {
    async sendMail(message) {
      sent.push({ to: message.to, subject: message.subject, text: message.text });
      return { messageId: "fake-1", accepted: [message.to] };
    },
  };
}

function mailSettings(patch: Partial<AppConfig["mail"]> = {}): AppConfig["mail"] {
  return { ...structuredClone(DEFAULT_CONFIG.mail), ...patch };
}

test("邮件发送器：验证码以纯文本+HTML 发出，日志不包含验证码", async () => {
  const sent: SentMessage[] = [];
  const logs: string[] = [];
  const logger = { ...silentLogger, warn: (message: string) => logs.push(message), info: (m: string) => logs.push(m) };
  const sender = new MailSender(
    () => mailSettings({ enabled: true, host: "smtp.example.com", from: "noreply@example.com" }),
    logger as unknown as typeof silentLogger,
    () => fakeTransport(sent),
  );
  await sender.sendVerificationCode("user@example.com", "123456", { purpose: "signup", ttlMinutes: 10 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "user@example.com");
  assert.match(sent[0]!.text, /123456/);
  assert.equal(logs.some((line) => line.includes("123456")), false);
});

test("邮件发送器：未配置时抛出 MAIL_NOT_CONFIGURED，不尝试连接", async () => {
  const sent: SentMessage[] = [];
  const sender = new MailSender(
    () => mailSettings({ enabled: false }),
    silentLogger,
    () => fakeTransport(sent),
  );
  assert.equal(sender.configured(), false);
  await assert.rejects(
    () => sender.sendTest("user@example.com"),
    (error: unknown) => (error as { code?: string }).code === "MAIL_NOT_CONFIGURED",
  );
  assert.equal(sent.length, 0);
});

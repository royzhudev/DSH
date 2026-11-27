import nodemailer from "nodemailer";
import type { Logger } from "../logger.js";
import type { MailSettings } from "../types.js";
import { AppError, toErrorMessage } from "../errors.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 发送结果只用于日志与测试断言，绝不包含凭据。 */
export interface MailSendResult {
  messageId?: string;
  accepted: string[];
}

/** 可注入的发送后端：默认用 nodemailer 走真实 SMTP，测试可替换为假实现。 */
export interface MailTransport {
  sendMail(message: {
    from: { name: string; address: string };
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<MailSendResult>;
}

export type MailTransportFactory = (settings: MailSettings) => MailTransport;

function createSmtpTransport(settings: MailSettings): MailTransport {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // 587/25 端口强制 STARTTLS；465 用隐式 TLS，由 secure 处理。
    requireTLS: settings.starttls,
    ...(settings.user
      ? {
          auth: {
            user: settings.user,
            pass: settings.password ?? "",
          },
        }
      : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { minVersion: "TLSv1.2" },
  });
  return {
    async sendMail(message) {
      const info = await transport.sendMail(message);
      return { messageId: info.messageId, accepted: (info.accepted ?? []).map(String) };
    },
  };
}

/**
 * 邮箱验证码发件器。配置来自平台设置（只有管理员能改），凭据只保存在本机文件，
 * 绝不写日志或响应。SMTP 连接按次创建、发送后释放，避免长连接泄漏。
 */
export class MailSender {
  constructor(
    private readonly settings: () => MailSettings,
    private readonly logger: Logger,
    private readonly transportFactory: MailTransportFactory = createSmtpTransport,
  ) {}

  /** 通道是否已启用且至少填了服务器与发件人。 */
  configured(): boolean {
    const settings = this.settings();
    return Boolean(settings.enabled && settings.host && settings.from);
  }

  /** 发送验证码；调用方负责限流与「不向客户端泄露发送失败细节」。 */
  async sendVerificationCode(
    to: string,
    code: string,
    options: { purpose: "signup" | "reset"; ttlMinutes: number },
  ): Promise<MailSendResult> {
    const action = options.purpose === "signup" ? "注册" : "重置密码";
    const subject = `【视频创作智能体】邮箱${options.purpose === "signup" ? "验证" : "重置密码"}验证码`;
    const text = [
      `你的${action}验证码是：${code}`,
      ``,
      `验证码 ${options.ttlMinutes} 分钟内有效，只能使用一次。`,
      `如果这不是你本人的操作，请忽略本邮件，你的账号不会有任何变化。`,
    ].join("\n");
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.7;color:#111">
  <p>你的${action}验证码是：</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>
  <p>验证码 ${options.ttlMinutes} 分钟内有效，只能使用一次。</p>
  <p style="color:#666">如果这不是你本人的操作，请忽略本邮件，你的账号不会有任何变化。</p>
</div>`;
    return this.send(to, subject, text, html);
  }

  /** 普通通知（例如“邮箱已注册”），不含任何验证码。 */
  async sendNotice(to: string, subject: string, text: string): Promise<MailSendResult> {
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.7">
  <p>${escapeHtml(text)}</p>
</div>`;
    return this.send(to, subject, text, html);
  }

  /** 管理员设置页的通道测试。 */
  async sendTest(to: string): Promise<MailSendResult> {
    const subject = "【视频创作智能体】邮件通道测试";
    const text = "这是一封测试邮件，说明 SMTP 配置可用。收到后无需回复。";
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.7">
  <p>这是一封测试邮件，说明 SMTP 配置可用。</p>
  <p style="color:#666">收到后无需回复。</p>
</div>`;
    return this.send(to, subject, text, html);
  }

  private async send(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<MailSendResult> {
    const settings = this.settings();
    if (!this.configured()) {
      throw new AppError("邮件通道尚未配置，请先在「设置 → 平台设置」填写 SMTP 服务器与发件地址", {
        code: "MAIL_NOT_CONFIGURED",
        status: 503,
      });
    }
    try {
      return await this.transportFactory(settings).sendMail({
        from: { name: settings.fromName, address: settings.from },
        to,
        subject,
        text,
        html,
      });
    } catch (error) {
      // 只记录错误类型与目标地址；不记录授权码或完整服务器响应。
      this.logger.warn(`验证码邮件发送失败（${to}）：${toErrorMessage(error)}`);
      throw new AppError("验证码邮件发送失败，请稍后再试", {
        code: "MAIL_SEND_FAILED",
        status: 502,
        cause: error,
      });
    }
  }
}
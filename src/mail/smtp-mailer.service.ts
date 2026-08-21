import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import { MailDeliveryError, type RenderedMail, type SmtpFailure } from './mail.types';

interface MailAddress {
  name: string;
  address: string;
}

export interface SmtpSendRequest {
  outboxId: string;
  recipientEmail: string;
  mail: RenderedMail;
}

export interface SmtpSendResult {
  messageId: string;
  smtpStatus: number | null;
}

@Injectable()
export class SmtpMailerService implements OnApplicationShutdown {
  private readonly enabled: boolean;
  private readonly from: MailAddress;
  private readonly replyTo?: string;
  private readonly messageIdDomain: string;
  private readonly transporter: Transporter<SMTPPool.SentMessageInfo> | null;

  constructor(config: ConfigService) {
    this.enabled = config.getOrThrow<boolean>('mail.enabled');
    const address = config.get<string>('mail.smtp.fromAddress') ?? 'disabled@invalid.local';
    this.from = {
      name: config.getOrThrow<string>('mail.smtp.fromName'),
      address,
    };
    this.replyTo = config.get<string>('mail.smtp.replyToAddress');
    this.messageIdDomain = address.split('@')[1] ?? 'invalid.local';
    if (!this.enabled) {
      this.transporter = null;
      return;
    }

    const tlsMode = config.getOrThrow<string>('mail.smtp.tlsMode');
    const username = config.get<string>('mail.smtp.username');
    const password = config.get<string>('mail.smtp.password');
    this.transporter = nodemailer.createTransport({
      host: config.getOrThrow<string>('mail.smtp.host'),
      port: config.getOrThrow<number>('mail.smtp.port'),
      secure: tlsMode === 'implicit',
      requireTLS: tlsMode === 'starttls',
      ignoreTLS: tlsMode === 'none',
      tls: {
        rejectUnauthorized: config.getOrThrow<boolean>('mail.smtp.rejectUnauthorized'),
      },
      auth: username && password ? { user: username, pass: password } : undefined,
      pool: true,
      maxConnections: config.getOrThrow<number>('mail.smtp.maxConnections'),
      maxMessages: 100,
      rateDelta: 60_000,
      rateLimit: config.getOrThrow<number>('mail.smtp.rateLimitPerMinute'),
      connectionTimeout: config.getOrThrow<number>('mail.smtp.connectionTimeoutMs'),
      greetingTimeout: config.getOrThrow<number>('mail.smtp.greetingTimeoutMs'),
      socketTimeout: config.getOrThrow<number>('mail.smtp.socketTimeoutMs'),
      logger: false,
      debug: false,
      transactionLog: false,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async verify(): Promise<void> {
    if (!this.transporter) throw disabledFailure();
    try {
      await this.transporter.verify();
    } catch (error) {
      throw classifySmtpFailure(error);
    }
  }

  async send(request: SmtpSendRequest): Promise<SmtpSendResult> {
    if (!this.transporter) throw disabledFailure();
    const messageId = `<danangmap-${request.outboxId}@${this.messageIdDomain}>`;
    try {
      const result = await this.transporter.sendMail({
        from: this.from,
        to: request.recipientEmail,
        replyTo: this.replyTo,
        subject: request.mail.subject,
        text: request.mail.text,
        messageId,
        headers: {
          'X-Auto-Response-Suppress': 'All',
        },
      });
      return {
        messageId: result.messageId || messageId,
        smtpStatus: responseStatus(result.response),
      };
    } catch (error) {
      throw classifySmtpFailure(error);
    }
  }

  onApplicationShutdown(): void {
    this.transporter?.close();
  }
}

export function classifySmtpFailure(error: unknown): SmtpFailure {
  const input = asSmtpError(error);
  const smtpStatus = numericStatus(input.responseCode) ?? responseStatus(input.response);
  const code = typeof input.code === 'string' ? input.code.toUpperCase() : '';
  const command = typeof input.command === 'string' ? input.command.toUpperCase() : '';

  if (code === 'EAUTH' || smtpStatus === 535) {
    return failure('MAIL_SMTP_AUTH_FAILED', 'permanent', smtpStatus);
  }
  if (code === 'ETLS' || code === 'EREQUIRETLS') {
    return failure('MAIL_SMTP_TLS_FAILED', 'permanent', smtpStatus);
  }
  if (smtpStatus !== null && smtpStatus >= 500 && command === 'RCPT TO') {
    return failure('MAIL_SMTP_RECIPIENT_REJECTED', 'permanent', smtpStatus);
  }
  if (smtpStatus !== null && smtpStatus >= 400 && smtpStatus < 500) {
    return failure(
      smtpStatus === 421 || smtpStatus === 450 || smtpStatus === 451 || smtpStatus === 452
        ? 'MAIL_SMTP_RATE_LIMITED'
        : 'MAIL_SMTP_TRANSIENT',
      'transient',
      smtpStatus,
    );
  }
  if (
    ['ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ETIMEDOUT', 'ESOCKET'].includes(code) &&
    ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(command)
  ) {
    return failure('MAIL_SMTP_UNREACHABLE', 'transient', smtpStatus);
  }
  return failure('SMTP_DELIVERY_UNKNOWN', 'ambiguous', smtpStatus);
}

function asSmtpError(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numericStatus(value: unknown): number | null {
  return typeof value === 'number' && value >= 200 && value <= 599 ? value : null;
}

function responseStatus(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /(?:^|\s)([245]\d\d)(?:\s|$|-)/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function failure(
  code: SmtpFailure['code'],
  classification: SmtpFailure['classification'],
  smtpStatus: number | null,
): SmtpFailure {
  return new MailDeliveryError(code, classification, smtpStatus);
}

function disabledFailure(): SmtpFailure {
  return failure('MAIL_CONFIG_DISABLED', 'permanent', null);
}

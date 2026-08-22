import { Injectable } from '@nestjs/common';
import { CryptoService } from '../common/crypto/crypto.service';
import {
  inviteMailPayloadSchema,
  resetMailPayloadSchema,
  type MailTemplateContext,
  type RenderedMail,
} from './mail.types';

export class MailTemplateError extends Error {
  constructor(readonly code: 'MAIL_PAYLOAD_INVALID' | 'MAIL_TEMPLATE_UNSUPPORTED') {
    super(code);
  }
}

@Injectable()
export class MailTemplateService {
  constructor(private readonly crypto: CryptoService) {}

  render(context: MailTemplateContext): RenderedMail {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.crypto.decrypt(context.payloadEncrypted));
    } catch {
      throw new MailTemplateError('MAIL_PAYLOAD_INVALID');
    }

    const name = this.safeName(context.displayName);
    const expires = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(context.expiresAt);

    if (context.templateKey === 'identity.invite') {
      const result = inviteMailPayloadSchema.safeParse(parsed);
      if (!result.success) throw new MailTemplateError('MAIL_PAYLOAD_INVALID');
      return {
        subject: 'Mã mời sử dụng Bản đồ số Đà Nẵng',
        text: [
          `Xin chào ${name},`,
          '',
          'Bạn được mời sử dụng hệ thống quản trị Bản đồ số Đà Nẵng.',
          'Hãy sao chép và dán mã mời sau vào màn hình chấp nhận lời mời:',
          '',
          result.data.token,
          '',
          `Mã hết hạn lúc ${expires}.`,
          'Nếu bạn không mong đợi thư này, hãy bỏ qua thư.',
        ].join('\n'),
      };
    }

    if (context.templateKey === 'identity.password-reset') {
      const result = resetMailPayloadSchema.safeParse(parsed);
      if (!result.success) throw new MailTemplateError('MAIL_PAYLOAD_INVALID');
      return {
        subject: 'Mã đặt lại mật khẩu Bản đồ số Đà Nẵng',
        text: [
          `Xin chào ${name},`,
          '',
          'Đã có yêu cầu đặt lại mật khẩu cho tài khoản của bạn.',
          'Hãy sao chép và dán mã sau vào màn hình đặt lại mật khẩu:',
          '',
          result.data.token,
          '',
          `Mã hết hạn lúc ${expires}.`,
          'Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua thư.',
        ].join('\n'),
      };
    }

    throw new MailTemplateError('MAIL_TEMPLATE_UNSUPPORTED');
  }

  private safeName(value: string): string {
    const normalized = Array.from(value)
      .map((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? ' ' : character;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized.slice(0, 120) || 'bạn';
  }
}

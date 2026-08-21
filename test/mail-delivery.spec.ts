import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { MailTemplateService } from '../src/mail/mail-template.service';
import { classifySmtpFailure } from '../src/mail/smtp-mailer.service';

describe('mail delivery security boundary', () => {
  const crypto = new CryptoService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: 'mail-template-field-encryption-key',
      SESSION_PEPPER: 'mail-template-session-pepper-value',
    }),
  );
  const templates = new MailTemplateService(crypto);

  it.each([
    [
      'identity.invite',
      { inviteId: 'e2149a33-c99e-4213-993a-7e39ff7db02d', token: 'invite-code-value-123456789' },
    ],
    [
      'identity.password-reset',
      {
        passwordResetTokenId: '717f65c2-89ee-46da-8db5-af2e2aaadbe3',
        token: 'reset-code-value-123456789',
      },
    ],
  ])('renders safe Vietnamese plaintext for %s', (templateKey, payload) => {
    const rendered = templates.render({
      templateKey,
      displayName: 'Nguyễn Văn A\r\nBcc: hidden@example.vn',
      expiresAt: new Date('2026-08-21T10:00:00.000Z'),
      payloadEncrypted: crypto.encrypt(JSON.stringify(payload)),
    });
    expect(rendered.text).toContain('sao chép và dán');
    expect(rendered.text).toContain(payload.token);
    expect(rendered.text).not.toMatch(/https?:\/\//i);
    expect(rendered.text).not.toContain('\r');
    expect(rendered.subject).not.toContain(payload.token);
  });

  it.each([
    [{ code: 'ECONNRESET', command: undefined }, 'ambiguous', 'SMTP_DELIVERY_UNKNOWN'],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'ambiguous', 'SMTP_DELIVERY_UNKNOWN'],
    [{ code: 'ECONNREFUSED', command: 'CONN' }, 'transient', 'MAIL_SMTP_UNREACHABLE'],
    [{ code: 'ETIMEDOUT', command: 'EHLO' }, 'transient', 'MAIL_SMTP_UNREACHABLE'],
    [{ responseCode: 451, command: 'RCPT TO' }, 'transient', 'MAIL_SMTP_RATE_LIMITED'],
    [{ responseCode: 550, command: 'RCPT TO' }, 'permanent', 'MAIL_SMTP_RECIPIENT_REJECTED'],
    [{ code: 'EAUTH', responseCode: 535 }, 'permanent', 'MAIL_SMTP_AUTH_FAILED'],
  ])('classifies SMTP failure %j conservatively', (error, classification, code) => {
    expect(classifySmtpFailure(error)).toEqual(expect.objectContaining({ classification, code }));
  });
});

import { z } from 'zod';
import type { MailErrorCode } from './mail.constants';

const token = z.string().regex(/^[A-Za-z0-9_-]{20,256}$/);

export const inviteMailPayloadSchema = z
  .object({
    inviteId: z.uuid(),
    token,
  })
  .strict();

export const resetMailPayloadSchema = z
  .object({
    passwordResetTokenId: z.uuid(),
    token,
  })
  .strict();

export interface RenderedMail {
  subject: string;
  text: string;
}

export interface MailTemplateContext {
  templateKey: string;
  displayName: string;
  expiresAt: Date;
  payloadEncrypted: string;
}

export interface ClaimedMail {
  id: string;
  claimToken: string;
}

export class MailDeliveryError extends Error {
  constructor(
    readonly code: MailErrorCode,
    readonly classification: 'transient' | 'permanent' | 'ambiguous',
    readonly smtpStatus: number | null,
  ) {
    super(code);
    this.name = 'MailDeliveryError';
  }
}

export type SmtpFailure = MailDeliveryError;

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import type { MailErrorCode } from './mail.constants';
import { MailTemplateError, MailTemplateService } from './mail-template.service';
import { SmtpMailerService } from './smtp-mailer.service';
import {
  MailDeliveryError,
  type ClaimedMail,
  type MailTemplateContext,
  type SmtpFailure,
} from './mail.types';

interface OutboxLinkRow {
  id: string;
  invite_id: string | null;
  password_reset_token_id: string | null;
}

interface LockedOutboxRow extends OutboxLinkRow {
  template_key: string;
  recipient_email: string;
  payload_encrypted: string | null;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  claim_token: string | null;
  lease_expires_at: Date | null;
}

interface CredentialContext {
  active: boolean;
  displayName: string;
  expiresAt: Date;
}

export interface MailSweepResult {
  due: Array<{ id: string; attempt: number }>;
  recoveredClaims: number;
  ambiguousDead: number;
  cancelled: number;
  retentionDead: number;
}

@Injectable()
export class MailDeliveryService {
  private readonly logger = new Logger(MailDeliveryService.name);
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly recipientIntervalSeconds: number;
  private readonly backoffBaseSeconds: number;
  private readonly backoffMaxSeconds: number;
  private readonly jitterPercent: number;
  private readonly retentionHours: number;
  private readonly probeIntervalMs: number;
  private nextProbeAt = 0;
  private smtpHealthy = false;
  private smtpHealthCode: MailErrorCode | null = 'MAIL_SMTP_UNREACHABLE';

  constructor(
    private readonly dataSource: DataSource,
    private readonly templates: MailTemplateService,
    private readonly smtp: SmtpMailerService,
    config: ConfigService,
  ) {
    this.leaseSeconds = config.getOrThrow<number>('mail.claimLeaseSeconds');
    this.maxAttempts = config.getOrThrow<number>('mail.maxAttempts');
    this.recipientIntervalSeconds = config.getOrThrow<number>('mail.perRecipientIntervalSeconds');
    this.backoffBaseSeconds = config.getOrThrow<number>('mail.backoffBaseSeconds');
    this.backoffMaxSeconds = config.getOrThrow<number>('mail.backoffMaxSeconds');
    this.jitterPercent = config.getOrThrow<number>('mail.backoffJitterPercent');
    this.retentionHours = config.getOrThrow<number>('mail.failedPayloadRetentionHours');
    this.probeIntervalMs = config.getOrThrow<number>('mail.smtpProbeIntervalMs');
  }

  isEnabled(): boolean {
    return this.smtp.isEnabled();
  }

  async verifySmtp(): Promise<void> {
    await this.smtp.verify();
  }

  async sweep(): Promise<MailSweepResult> {
    if (!this.isEnabled()) {
      await this.updateState('disabled', null);
      return { due: [], recoveredClaims: 0, ambiguousDead: 0, cancelled: 0, retentionDead: 0 };
    }

    await this.heartbeat();

    const result = await this.dataSource.transaction(async (manager) => {
      const recoveredClaims = await this.updateCount(
        manager,
        `UPDATE mail_outbox SET status='pending',claim_token=NULL,claimed_at=NULL,
           lease_expires_at=NULL,next_attempt_at=now(),last_error_code='MAIL_SMTP_TRANSIENT',
           updated_at=now()
         WHERE status='claimed' AND lease_expires_at < now()`,
      );
      const ambiguousDead = await this.updateCount(
        manager,
        `UPDATE mail_outbox SET status='dead',payload_encrypted=NULL,payload_scrubbed_at=now(),
           claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
           dead_at=now(),last_error_code='SMTP_DELIVERY_UNKNOWN',updated_at=now()
         WHERE status='sending' AND lease_expires_at < now()`,
      );
      const cancelled = await this.cancelInactiveCredentials(manager);
      const retentionDead = await this.updateCount(
        manager,
        `UPDATE mail_outbox SET status='dead',payload_encrypted=NULL,payload_scrubbed_at=now(),
           next_attempt_at=NULL,dead_at=now(),last_error_code=COALESCE(last_error_code,'MAIL_ATTEMPTS_EXHAUSTED'),
           updated_at=now()
         WHERE status='failed' AND failed_at < now() - ($1::text || ' hours')::interval`,
        [this.retentionHours],
      );
      const due = (await manager.query(
        `SELECT id,attempts AS attempt FROM mail_outbox
         WHERE status='pending' AND payload_encrypted IS NOT NULL
           AND COALESCE(next_attempt_at,created_at) <= now()
         ORDER BY COALESCE(next_attempt_at,created_at),id LIMIT 200`,
      )) as Array<{ id: string; attempt: number }>;
      return { due, recoveredClaims, ambiguousDead, cancelled, retentionDead };
    });
    if (
      result.due.length +
        result.recoveredClaims +
        result.ambiguousDead +
        result.cancelled +
        result.retentionDead >
      0
    ) {
      this.logger.log(
        JSON.stringify({
          event: 'mail.sweep',
          queued: result.due.length,
          recoveredClaims: result.recoveredClaims,
          ambiguousDead: result.ambiguousDead,
          cancelled: result.cancelled,
          retentionDead: result.retentionDead,
        }),
      );
    }
    return result;
  }

  private async heartbeat(): Promise<void> {
    let probed = false;
    if (Date.now() >= this.nextProbeAt) {
      probed = true;
      this.nextProbeAt = Date.now() + this.probeIntervalMs;
      try {
        await this.smtp.verify();
        this.smtpHealthy = true;
        this.smtpHealthCode = null;
      } catch (error) {
        const failure = this.safeFailure(error);
        this.smtpHealthy = false;
        this.smtpHealthCode = failure.code;
      }
    }
    await this.updateState(this.smtpHealthy ? 'up' : 'degraded', this.smtpHealthCode, probed);
  }

  async deliver(outboxId: string): Promise<void> {
    const claim = await this.claim(outboxId);
    if (!claim) return;
    try {
      if (!(await this.markSending(claim))) return;
      if (!(await this.sendAndConfirm(claim))) return;
      await this.incrementState('sent_count');
    } catch (error) {
      const failure = this.safeFailure(error);
      await this.settleFailure(claim, failure);
      if (
        ['MAIL_SMTP_UNREACHABLE', 'MAIL_SMTP_AUTH_FAILED', 'MAIL_SMTP_TLS_FAILED'].includes(
          failure.code,
        )
      ) {
        this.smtpHealthy = false;
        this.smtpHealthCode = failure.code;
        await this.updateState('degraded', failure.code).catch(() => undefined);
      }
      if (failure.classification === 'transient') await this.incrementState('retry_count');
      else await this.incrementState('failed_count');
      this.logger.warn(
        JSON.stringify({ event: 'mail.delivery_failed', outboxId, code: failure.code }),
      );
    }
  }

  async updateState(
    status: 'disabled' | 'up' | 'degraded',
    errorCode: MailErrorCode | null,
    smtpChecked = false,
  ): Promise<void> {
    const metrics = (await this.dataSource.query(
      `SELECT (count(*) FILTER (WHERE status IN ('pending','claimed','sending')))::integer AS queue_depth,
              COALESCE(EXTRACT(epoch FROM now()-(min(created_at) FILTER
                (WHERE status IN ('pending','claimed','sending')))),0)::integer AS oldest_age_seconds
       FROM mail_outbox`,
    )) as Array<{ queue_depth: number; oldest_age_seconds: number }>;
    const metric = metrics[0] ?? { queue_depth: 0, oldest_age_seconds: 0 };
    await this.dataSource.query(
      `UPDATE mail_delivery_state SET status=$1,worker_heartbeat_at=now(),
         last_smtp_check_at=CASE WHEN $5 THEN now() ELSE last_smtp_check_at END,
         last_error_code=$2,queue_depth=$3,oldest_age_seconds=$4,updated_at=now() WHERE id=1`,
      [status, errorCode, metric.queue_depth, metric.oldest_age_seconds, smtpChecked],
    );
  }

  private async claim(id: string): Promise<ClaimedMail | null> {
    return this.dataSource.transaction(async (manager) => {
      const link = await this.getLink(manager, id);
      if (!link) return null;
      const credential = await this.lockCredential(manager, link);
      const rows = (await manager.query('SELECT * FROM mail_outbox WHERE id=$1 FOR UPDATE', [
        id,
      ])) as LockedOutboxRow[];
      const row = rows[0];
      if (!row || row.status !== 'pending' || !row.payload_encrypted) return null;
      if (row.next_attempt_at && new Date(row.next_attempt_at) > new Date()) return null;
      if (!credential.active) {
        await this.cancel(manager, id);
        return null;
      }

      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `mail:recipient:${row.recipient_email.toLowerCase()}`,
      ]);
      const recent = (await manager.query(
        `SELECT max(last_attempt_at) AS last_attempt_at FROM mail_outbox
         WHERE id<>$1 AND lower(recipient_email)=lower($2)`,
        [id, row.recipient_email],
      )) as Array<{ last_attempt_at: Date | null }>;
      const last = recent[0]?.last_attempt_at;
      if (last && Date.now() - new Date(last).getTime() < this.recipientIntervalSeconds * 1_000) {
        await manager.query(
          `UPDATE mail_outbox SET next_attempt_at=$2,updated_at=now() WHERE id=$1`,
          [id, new Date(new Date(last).getTime() + this.recipientIntervalSeconds * 1_000)],
        );
        return null;
      }

      const claimToken = randomUUID();
      try {
        await manager.query(
          `UPDATE mail_outbox SET status='claimed',claim_token=$2,claimed_at=now(),
             lease_expires_at=now()+($3::text || ' seconds')::interval,attempts=attempts+1,
             last_attempt_at=now(),next_attempt_at=NULL,last_error_code=NULL,last_smtp_status=NULL,
             updated_at=now() WHERE id=$1`,
          [id, claimToken, this.leaseSeconds],
        );
      } catch (error) {
        if (this.isUniqueViolation(error)) return null;
        throw error;
      }
      return { id, claimToken };
    });
  }

  private async markSending(claim: ClaimedMail): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const link = await this.requireLink(manager, claim.id);
      const credential = await this.lockCredential(manager, link);
      const row = await this.lockOutbox(manager, claim);
      if (!credential.active) {
        await this.cancel(manager, row.id);
        return false;
      }
      if (row.status !== 'claimed') throw ambiguousFailure();
      await manager.query(
        `UPDATE mail_outbox SET status='sending',updated_at=now() WHERE id=$1 AND claim_token=$2`,
        [claim.id, claim.claimToken],
      );
      return true;
    });
  }

  private async sendAndConfirm(claim: ClaimedMail): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const link = await this.requireLink(manager, claim.id);
      const credential = await this.lockCredential(manager, link);
      const row = await this.lockOutbox(manager, claim);
      if (row.status !== 'sending') throw ambiguousFailure();
      if (!credential.active || !row.payload_encrypted) {
        await this.cancel(manager, row.id);
        return false;
      }
      const context: MailTemplateContext = {
        templateKey: row.template_key,
        displayName: credential.displayName,
        expiresAt: credential.expiresAt,
        payloadEncrypted: row.payload_encrypted,
      };
      const mail = this.templates.render(context);
      const result = await this.smtp.send({
        outboxId: row.id,
        recipientEmail: row.recipient_email,
        mail,
      });
      await manager.query(
        `UPDATE mail_outbox SET status='sent',payload_encrypted=NULL,payload_scrubbed_at=now(),
           claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,sent_at=now(),
           provider_message_id=$3,last_smtp_status=$4,last_error_code=NULL,updated_at=now()
         WHERE id=$1 AND claim_token=$2`,
        [row.id, claim.claimToken, result.messageId, result.smtpStatus],
      );
      return true;
    });
  }

  private async settleFailure(claim: ClaimedMail, failure: SmtpFailure): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const link = await this.getLink(manager, claim.id);
      if (!link) return;
      const credential = await this.lockCredential(manager, link);
      const rows = (await manager.query('SELECT * FROM mail_outbox WHERE id=$1 FOR UPDATE', [
        claim.id,
      ])) as LockedOutboxRow[];
      const row = rows[0];
      if (!row || row.claim_token !== claim.claimToken || row.status === 'sent') return;
      if (!credential.active) {
        await this.cancel(manager, row.id);
        return;
      }
      if (failure.classification === 'ambiguous') {
        await manager.query(
          `UPDATE mail_outbox SET status='dead',payload_encrypted=NULL,payload_scrubbed_at=now(),
             claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,dead_at=now(),
             last_error_code='SMTP_DELIVERY_UNKNOWN',last_smtp_status=$2,updated_at=now() WHERE id=$1`,
          [row.id, failure.smtpStatus],
        );
        return;
      }
      if (failure.classification === 'transient' && row.attempts < this.maxAttempts) {
        await manager.query(
          `UPDATE mail_outbox SET status='pending',claim_token=NULL,claimed_at=NULL,
             lease_expires_at=NULL,next_attempt_at=$2,last_error_code=$3,last_smtp_status=$4,
             updated_at=now() WHERE id=$1`,
          [row.id, this.nextAttempt(row.attempts), failure.code, failure.smtpStatus],
        );
        return;
      }
      await manager.query(
        `UPDATE mail_outbox SET status='failed',claim_token=NULL,claimed_at=NULL,
           lease_expires_at=NULL,next_attempt_at=NULL,failed_at=now(),last_error_code=$2,
           last_smtp_status=$3,updated_at=now() WHERE id=$1`,
        [
          row.id,
          row.attempts >= this.maxAttempts ? 'MAIL_ATTEMPTS_EXHAUSTED' : failure.code,
          failure.smtpStatus,
        ],
      );
    });
  }

  private async getLink(manager: EntityManager, id: string): Promise<OutboxLinkRow | null> {
    const rows = (await manager.query(
      'SELECT id,invite_id,password_reset_token_id FROM mail_outbox WHERE id=$1',
      [id],
    )) as OutboxLinkRow[];
    return rows[0] ?? null;
  }

  private async requireLink(manager: EntityManager, id: string): Promise<OutboxLinkRow> {
    const row = await this.getLink(manager, id);
    if (!row) throw ambiguousFailure();
    return row;
  }

  private async lockCredential(
    manager: EntityManager,
    link: OutboxLinkRow,
  ): Promise<CredentialContext> {
    if (link.invite_id) {
      const rows = (await manager.query(
        `SELECT display_name,expires_at,
           (used_at IS NULL AND revoked_at IS NULL AND expires_at>now()) AS active
         FROM invites WHERE id=$1 FOR UPDATE`,
        [link.invite_id],
      )) as Array<{ display_name: string; expires_at: Date; active: boolean }>;
      const row = rows[0];
      return row
        ? { active: row.active, displayName: row.display_name, expiresAt: row.expires_at }
        : { active: false, displayName: '', expiresAt: new Date(0) };
    }
    if (link.password_reset_token_id) {
      const rows = (await manager.query(
        `SELECT u.display_name,t.expires_at,
           (t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()) AS active
         FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
         WHERE t.id=$1 FOR UPDATE OF t`,
        [link.password_reset_token_id],
      )) as Array<{ display_name: string; expires_at: Date; active: boolean }>;
      const row = rows[0];
      return row
        ? { active: row.active, displayName: row.display_name, expiresAt: row.expires_at }
        : { active: false, displayName: '', expiresAt: new Date(0) };
    }
    return { active: false, displayName: '', expiresAt: new Date(0) };
  }

  private async lockOutbox(manager: EntityManager, claim: ClaimedMail): Promise<LockedOutboxRow> {
    const rows = (await manager.query(
      'SELECT * FROM mail_outbox WHERE id=$1 AND claim_token=$2 FOR UPDATE',
      [claim.id, claim.claimToken],
    )) as LockedOutboxRow[];
    const row = rows[0];
    if (!row) throw ambiguousFailure();
    return row;
  }

  private async cancel(manager: EntityManager, id: string): Promise<void> {
    await manager.query(
      `UPDATE mail_outbox SET status='cancelled',payload_encrypted=NULL,payload_scrubbed_at=now(),
         claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
         last_error_code='MAIL_CREDENTIAL_INVALID',updated_at=now()
       WHERE id=$1 AND status IN ('pending','claimed','sending','failed')`,
      [id],
    );
  }

  private async cancelInactiveCredentials(manager: EntityManager): Promise<number> {
    return this.updateCount(
      manager,
      `UPDATE mail_outbox o SET status='cancelled',payload_encrypted=NULL,payload_scrubbed_at=now(),
         claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
         last_error_code='MAIL_CREDENTIAL_INVALID',updated_at=now()
       WHERE o.status IN ('pending','claimed','failed') AND (
         (o.invite_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM invites i WHERE i.id=o.invite_id AND i.used_at IS NULL
             AND i.revoked_at IS NULL AND i.expires_at>now()
         )) OR
         (o.password_reset_token_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM password_reset_tokens t WHERE t.id=o.password_reset_token_id
             AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
         )) OR
         (o.invite_id IS NULL AND o.password_reset_token_id IS NULL)
       )`,
    );
  }

  private async updateCount(
    manager: EntityManager,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<number> {
    const result = (await manager.query(`${sql} RETURNING id`, parameters)) as unknown;
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
      return result[0].length;
    }
    return Array.isArray(result) ? result.length : 0;
  }

  private nextAttempt(attempt: number): Date {
    const base = Math.min(
      this.backoffMaxSeconds,
      this.backoffBaseSeconds * 2 ** Math.max(0, attempt - 1),
    );
    const range = Math.round((base * this.jitterPercent) / 100);
    const jitter = range === 0 ? 0 : randomInt(-range, range + 1);
    return new Date(Date.now() + Math.max(1, base + jitter) * 1_000);
  }

  private safeFailure(error: unknown): SmtpFailure {
    if (error instanceof MailTemplateError) return permanentFailure(error.code);
    if (error instanceof MailDeliveryError) return error;
    return ambiguousFailure();
  }

  private isUniqueViolation(error: unknown): boolean {
    if (error instanceof QueryFailedError) {
      return (error.driverError as { code?: string } | undefined)?.code === '23505';
    }
    return Boolean(
      error && typeof error === 'object' && (error as { code?: string }).code === '23505',
    );
  }

  private async incrementState(column: 'sent_count' | 'failed_count' | 'retry_count') {
    await this.dataSource.query(
      `UPDATE mail_delivery_state SET ${column}=${column}+1,last_success_at=CASE WHEN $1='sent_count'
         THEN now() ELSE last_success_at END,updated_at=now() WHERE id=1`,
      [column],
    );
  }
}

function permanentFailure(code: MailErrorCode): SmtpFailure {
  return new MailDeliveryError(code, 'permanent', null);
}

function ambiguousFailure(): SmtpFailure {
  return new MailDeliveryError('SMTP_DELIVERY_UNKNOWN', 'ambiguous', null);
}

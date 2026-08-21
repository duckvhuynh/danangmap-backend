import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { validateEnvironment } from '../src/config/environment';

interface Arguments {
  outboxId: string;
  reason: string;
}

async function main(): Promise<void> {
  validateEnvironment(process.env);
  const args = parseArguments(process.argv.slice(2));
  await AppDataSource.initialize();
  try {
    const outcome = await AppDataSource.transaction(async (manager) => {
      const links = (await manager.query(
        'SELECT invite_id,password_reset_token_id FROM mail_outbox WHERE id=$1',
        [args.outboxId],
      )) as Array<{ invite_id: string | null; password_reset_token_id: string | null }>;
      const link = links[0];
      if (!link) throw new Error('MAIL_OUTBOX_NOT_FOUND');

      let credentialActive = false;
      if (link.invite_id) {
        const rows = (await manager.query(
          `SELECT used_at IS NULL AND revoked_at IS NULL AND expires_at>now() AS active
           FROM invites WHERE id=$1 FOR UPDATE`,
          [link.invite_id],
        )) as Array<{ active: boolean }>;
        credentialActive = rows[0]?.active ?? false;
      } else if (link.password_reset_token_id) {
        const rows = (await manager.query(
          `SELECT used_at IS NULL AND revoked_at IS NULL AND expires_at>now() AS active
           FROM password_reset_tokens WHERE id=$1 FOR UPDATE`,
          [link.password_reset_token_id],
        )) as Array<{ active: boolean }>;
        credentialActive = rows[0]?.active ?? false;
      }

      const rows = (await manager.query(
        'SELECT status,payload_encrypted FROM mail_outbox WHERE id=$1 FOR UPDATE',
        [args.outboxId],
      )) as Array<{ status: string; payload_encrypted: string | null }>;
      const outbox = rows[0];
      if (!outbox || outbox.status !== 'failed' || !outbox.payload_encrypted) {
        throw new Error('MAIL_REQUEUE_NOT_ALLOWED');
      }
      if (!credentialActive) {
        await manager.query(
          `UPDATE mail_outbox SET status='cancelled',payload_encrypted=NULL,
             payload_scrubbed_at=now(),failed_at=NULL,last_error_code='MAIL_CREDENTIAL_INVALID',
             updated_at=now() WHERE id=$1`,
          [args.outboxId],
        );
        await insertAudit(manager, args, 'mail.outbox_requeue_rejected');
        return 'cancelled' as const;
      }
      await manager.query(
        `UPDATE mail_outbox SET status='pending',attempts=0,next_attempt_at=now(),failed_at=NULL,
           last_error_code=NULL,last_smtp_status=NULL,updated_at=now() WHERE id=$1`,
        [args.outboxId],
      );
      await insertAudit(manager, args, 'mail.outbox_requeued');
      return 'queued' as const;
    });
    if (outcome === 'cancelled') throw new Error('MAIL_CREDENTIAL_INVALID');
    process.stdout.write(`Mail outbox ${args.outboxId} queued for a guarded retry.\n`);
  } finally {
    await AppDataSource.destroy();
  }
}

function parseArguments(values: string[]): Arguments {
  const outboxId = argument(values, '--outbox-id');
  const reason = cleanReason(argument(values, '--reason'));
  if (!values.includes('--acknowledge-duplicate-risk')) {
    throw new Error('The --acknowledge-duplicate-risk flag is required.');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(outboxId)
  ) {
    throw new Error('The --outbox-id value must be a UUID.');
  }
  if (reason.length < 10)
    throw new Error('The --reason value must contain at least 10 characters.');
  return { outboxId, reason };
}

function argument(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`The ${name} option is required.`);
  return value;
}

function cleanReason(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

async function insertAudit(
  manager: { query: (sql: string, parameters?: unknown[]) => Promise<unknown> },
  args: Arguments,
  action: 'mail.outbox_requeued' | 'mail.outbox_requeue_rejected',
): Promise<void> {
  await manager.query(
    `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
     VALUES(NULL,NULL,$1,'mail_outbox',$2,$3,$4::jsonb)`,
    [
      action,
      args.outboxId,
      randomUUID(),
      JSON.stringify({
        acknowledgedDuplicateRisk: true,
        reason: args.reason,
        source: 'operator_cli',
      }),
    ],
  );
}

void main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'MAIL_REQUEUE_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});

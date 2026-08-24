import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { UserRole, UserStatus } from '../domain/enums';

@Entity({ name: 'users' })
@Index('uq_users_email_normalized', ['emailNormalized'], { unique: true })
@Index('uq_users_username_normalized', ['usernameNormalized'], { unique: true })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) email: string;
  @Column({ name: 'email_normalized', type: 'text' }) emailNormalized: string;
  @Column({ type: 'text' }) username: string;
  @Column({ name: 'username_normalized', type: 'text' }) usernameNormalized: string;
  @Column({ name: 'display_name', type: 'text' }) displayName: string;
  @Column({ type: 'text' }) role: UserRole;
  @Column({ type: 'text', default: 'inactive' }) status: UserStatus;
  @Column({ name: 'password_hash', type: 'text', nullable: true }) passwordHash: string | null;
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword: boolean;
  @Column({ name: 'mfa_enabled', type: 'boolean', default: false }) mfaEnabled: boolean;
  @Column({ name: 'mfa_secret_encrypted', type: 'text', nullable: true }) mfaSecretEncrypted:
    string | null;
  @Column({ name: 'failed_login_count', type: 'integer', default: 0 }) failedLoginCount: number;
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true }) lockedUntil: Date | null;
  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true }) disabledAt: Date | null;
  @Column({ name: 'lock_version', type: 'integer', default: 1 }) lockVersion: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'admin_sessions' })
@Index('uq_admin_sessions_token_hash', ['tokenHash'], { unique: true })
@Index('idx_admin_sessions_user_active', ['userId', 'expiresAt'])
export class AdminSessionEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'token_hash', type: 'text' }) tokenHash: string;
  @Column({ name: 'csrf_hash', type: 'text', nullable: true }) csrfHash: string | null;
  @Column({ type: 'text' }) kind: 'preauth' | 'authenticated';
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @Column({ name: 'ip_hash', type: 'text', nullable: true }) ipHash: string | null;
  @Column({ name: 'user_agent', type: 'text', nullable: true }) userAgent: string | null;
  @Column({ name: 'mfa_failed_attempts', type: 'integer', default: 0 })
  mfaFailedAttempts: number;
  @Column({ name: 'mfa_locked_until', type: 'timestamptz', nullable: true })
  mfaLockedUntil: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity({ name: 'user_mfa_methods' })
@Index('uq_user_mfa_methods_user_totp', ['userId'], { unique: true })
@Index('idx_user_mfa_methods_enrollment_session', ['enrollmentSessionId'])
export class UserMfaMethodEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ type: 'text', default: 'pending' }) status: 'pending' | 'verified';
  @Column({ name: 'secret_encrypted', type: 'text' }) secretEncrypted: string;
  @Column({ name: 'last_used_time_step', type: 'bigint', nullable: true })
  lastUsedTimeStep: string | null;
  @Column({ name: 'enrollment_session_id', type: 'uuid', nullable: true })
  enrollmentSessionId: string | null;
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true }) verifiedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'user_mfa_recovery_codes' })
@Index('uq_user_mfa_recovery_code_digest', ['codeDigest'], { unique: true })
@Index('idx_user_mfa_recovery_codes_active', ['userId', 'consumedAt'])
export class UserMfaRecoveryCodeEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'code_digest', type: 'text' }) codeDigest: string;
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true }) consumedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity({ name: 'invites' })
@Index('uq_invites_token_hash', ['tokenHash'], { unique: true })
export class InviteEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) email: string;
  @Column({ type: 'text' }) username: string;
  @Column({ name: 'display_name', type: 'text' }) displayName: string;
  @Column({ type: 'text' }) role: UserRole;
  @Column({ name: 'token_hash', type: 'text' }) tokenHash: string;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt: Date;
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true }) usedAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @Column({ name: 'accepted_user_id', type: 'uuid', nullable: true }) acceptedUserId: string | null;
  @Column({ name: 'supersedes_invite_id', type: 'uuid', nullable: true }) supersedesInviteId:
    string | null;
  @Column({ name: 'lock_version', type: 'integer', default: 1 }) lockVersion: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'password_reset_tokens' })
@Index('uq_password_reset_tokens_token_hash', ['tokenHash'], { unique: true })
@Index('idx_password_reset_tokens_user_active', ['userId'], {
  unique: true,
  where: 'used_at IS NULL AND revoked_at IS NULL',
})
export class PasswordResetTokenEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'token_hash', type: 'text' }) tokenHash: string;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt: Date;
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true }) usedAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @Column({ name: 'ip_hash', type: 'text', nullable: true }) ipHash: string | null;
  @Column({ name: 'user_agent', type: 'text', nullable: true }) userAgent: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity({ name: 'mail_outbox' })
export class MailOutboxEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'template_key', type: 'text' }) templateKey: string;
  @Column({ name: 'recipient_email', type: 'text' }) recipientEmail: string;
  @Column({ name: 'invite_id', type: 'uuid', nullable: true }) inviteId: string | null;
  @Column({ name: 'password_reset_token_id', type: 'uuid', nullable: true })
  passwordResetTokenId: string | null;
  @Column({ name: 'payload_encrypted', type: 'text', nullable: true }) payloadEncrypted:
    string | null;
  @Column({ type: 'text', default: 'pending' })
  status: 'pending' | 'claimed' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'dead';
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;
  @Column({ name: 'claim_token', type: 'uuid', nullable: true }) claimToken: string | null;
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true }) claimedAt: Date | null;
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;
  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;
  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true }) sentAt: Date | null;
  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true }) failedAt: Date | null;
  @Column({ name: 'dead_at', type: 'timestamptz', nullable: true }) deadAt: Date | null;
  @Column({ name: 'payload_scrubbed_at', type: 'timestamptz', nullable: true })
  payloadScrubbedAt: Date | null;
  @Column({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId: string | null;
  @Column({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode: string | null;
  @Column({ name: 'last_smtp_status', type: 'integer', nullable: true })
  lastSmtpStatus: number | null;
  @Column({ name: 'correlation_id', type: 'uuid' }) correlationId: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'audit_logs' })
@Index('idx_audit_resource', ['resourceType', 'resourceId', 'occurredAt'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'actor_id', type: 'uuid', nullable: true }) actorId: string | null;
  @Column({ name: 'actor_role', type: 'text', nullable: true }) actorRole: string | null;
  @Column({ type: 'text' }) action: string;
  @Column({ name: 'resource_type', type: 'text' }) resourceType: string;
  @Column({ name: 'resource_id', type: 'uuid', nullable: true }) resourceId: string | null;
  @Column({ name: 'request_id', type: 'uuid' }) requestId: string;
  @Column({ name: 'before_digest', type: 'text', nullable: true }) beforeDigest: string | null;
  @Column({ name: 'after_digest', type: 'text', nullable: true }) afterDigest: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) metadata: Record<string, unknown>;
  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
}

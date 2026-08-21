import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { AppException } from '../http/app.exception';

interface ReceiptRow<T> {
  state: 'pending' | 'completed';
  requestDigest: string;
  statusCode: number | null;
  responsePayload: T | null;
  responseEtag: string | null;
}

export interface ReceiptClaim<T> {
  owner: boolean;
  pending: boolean;
  response: T | null;
  statusCode: number | null;
  etag: string | null;
}

@Injectable()
export class IdempotencyService {
  digest(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(this.canonical(value)))
      .digest('hex');
  }

  async claim<T>(
    manager: EntityManager,
    actorId: string,
    operation: string,
    key: string,
    requestDigest: string,
  ): Promise<ReceiptClaim<T>> {
    const inserted = (await manager.query(
      `INSERT INTO command_receipts(actor_id,operation,idempotency_key,request_digest,state)
       VALUES($1,$2,$3,$4,'pending')
       ON CONFLICT(actor_id,operation,idempotency_key) DO NOTHING
       RETURNING id`,
      [actorId, operation, key, requestDigest],
    )) as Array<{ id: string }>;
    if (inserted.length) {
      return { owner: true, pending: true, response: null, statusCode: null, etag: null };
    }
    const rows = (await manager.query(
      `SELECT state,request_digest AS "requestDigest",status_code AS "statusCode",
              response_payload AS "responsePayload",response_etag AS "responseEtag"
       FROM command_receipts
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3
       FOR UPDATE`,
      [actorId, operation, key],
    )) as Array<ReceiptRow<T>>;
    const receipt = rows[0];
    if (!receipt) {
      throw new AppException(409, 'IDEMPOTENCY_RACE', 'Không thể xác nhận idempotency receipt.');
    }
    if (receipt.requestDigest !== requestDigest) {
      throw new AppException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key đã được dùng với payload khác.',
      );
    }
    return {
      owner: false,
      pending: receipt.state === 'pending',
      response: receipt.responsePayload,
      statusCode: receipt.statusCode,
      etag: receipt.responseEtag,
    };
  }

  async prepare<T>(
    manager: EntityManager,
    actorId: string,
    operation: string,
    key: string,
    response: T,
    statusCode: number,
    etag: string | null = null,
  ): Promise<void> {
    await manager.query(
      `UPDATE command_receipts SET response_payload=$4::jsonb,status_code=$5,response_etag=$6,updated_at=now()
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3 AND state='pending'`,
      [actorId, operation, key, JSON.stringify(response), statusCode, etag],
    );
  }

  async complete<T>(
    manager: EntityManager,
    actorId: string,
    operation: string,
    key: string,
    response: T,
    statusCode: number,
    etag: string | null = null,
  ): Promise<void> {
    await manager.query(
      `UPDATE command_receipts SET state='completed',response_payload=$4::jsonb,status_code=$5,
              response_etag=$6,updated_at=now()
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3`,
      [actorId, operation, key, JSON.stringify(response), statusCode, etag],
    );
  }

  private canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonical(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.canonical(item)]),
      );
    }
    return value;
  }
}

import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { AppException } from '../http/app.exception';

interface ReceiptRow<T, M> {
  state: 'pending' | 'completed';
  requestDigest: string;
  statusCode: number | null;
  responsePayload: T | null;
  responseEtag: string | null;
  responseMetadata: M | null;
}

export interface ReceiptClaim<T, M = Record<string, unknown>> {
  owner: boolean;
  pending: boolean;
  response: T | null;
  statusCode: number | null;
  etag: string | null;
  metadata: M | null;
}

@Injectable()
export class IdempotencyService {
  digest(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(this.canonical(value)))
      .digest('hex');
  }

  async claim<T, M = Record<string, unknown>>(
    manager: EntityManager,
    actorId: string,
    operation: string,
    key: string,
    requestDigest: string,
  ): Promise<ReceiptClaim<T, M>> {
    const inserted = (await manager.query(
      `INSERT INTO command_receipts(actor_id,operation,idempotency_key,request_digest,state)
       VALUES($1,$2,$3,$4,'pending')
       ON CONFLICT(actor_id,operation,idempotency_key) DO NOTHING
       RETURNING id`,
      [actorId, operation, key, requestDigest],
    )) as Array<{ id: string }>;
    if (inserted.length) {
      return {
        owner: true,
        pending: true,
        response: null,
        statusCode: null,
        etag: null,
        metadata: null,
      };
    }
    const rows = (await manager.query(
      `SELECT state,request_digest AS "requestDigest",status_code AS "statusCode",
              response_payload AS "responsePayload",response_etag AS "responseEtag",
              response_metadata AS "responseMetadata"
       FROM command_receipts
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3
       FOR UPDATE`,
      [actorId, operation, key],
    )) as Array<ReceiptRow<T, M>>;
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
      metadata: receipt.responseMetadata,
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
    metadata: Record<string, unknown> | null = null,
  ): Promise<void> {
    await manager.query(
      `UPDATE command_receipts SET response_payload=$4::jsonb,status_code=$5,response_etag=$6,
              response_metadata=$7::jsonb,updated_at=now()
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3 AND state='pending'`,
      [
        actorId,
        operation,
        key,
        JSON.stringify(response),
        statusCode,
        etag,
        metadata ? JSON.stringify(metadata) : null,
      ],
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
    metadata: Record<string, unknown> | null = null,
  ): Promise<void> {
    await manager.query(
      `UPDATE command_receipts SET state='completed',response_payload=$4::jsonb,status_code=$5,
              response_etag=$6,response_metadata=$7::jsonb,updated_at=now()
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3`,
      [
        actorId,
        operation,
        key,
        JSON.stringify(response),
        statusCode,
        etag,
        metadata ? JSON.stringify(metadata) : null,
      ],
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

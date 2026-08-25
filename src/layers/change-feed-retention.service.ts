import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';

@Injectable()
export class ChangeFeedRetentionService {
  private readonly changeRetention: number;

  constructor(config: ConfigService) {
    this.changeRetention = config.getOrThrow<number>('featureSync.changeRetention');
  }

  async prune(manager: EntityManager, revisionId: string, currentCursor: number): Promise<void> {
    const targetFloor = Math.max(0, currentCursor - this.changeRetention);
    if (targetFloor === 0) return;
    await manager.query(
      `WITH advanced AS (
         UPDATE layer_revisions
         SET change_cursor_floor=GREATEST(change_cursor_floor,$2)
         WHERE id=$1
         RETURNING change_cursor_floor
       )
       DELETE FROM revision_changes
       WHERE revision_id=$1
         AND server_cursor <= (SELECT change_cursor_floor FROM advanced)`,
      [revisionId, targetFloor],
    );
  }
}

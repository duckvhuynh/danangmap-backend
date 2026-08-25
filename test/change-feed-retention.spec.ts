import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { ChangeFeedRetentionService } from '../src/layers/change-feed-retention.service';

describe('change feed retention', () => {
  it('advances the floor and prunes every writer through one transaction-scoped policy', async () => {
    const service = new ChangeFeedRetentionService(
      new ConfigService({ featureSync: { changeRetention: 100 } }),
    );
    const query = jest.fn().mockResolvedValue([]);
    const manager = { query } as unknown as EntityManager;

    await service.prune(manager, '0192a793-f096-78f6-bad8-e18b9452f8c9', 103);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('change_cursor_floor=GREATEST'), [
      '0192a793-f096-78f6-bad8-e18b9452f8c9',
      3,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM revision_changes'), [
      '0192a793-f096-78f6-bad8-e18b9452f8c9',
      3,
    ]);
  });

  it('does not touch the database before the retention window is full', async () => {
    const service = new ChangeFeedRetentionService(
      new ConfigService({ featureSync: { changeRetention: 100 } }),
    );
    const query = jest.fn();

    await service.prune({ query } as unknown as EntityManager, 'revision-id', 100);

    expect(query).not.toHaveBeenCalled();
  });
});

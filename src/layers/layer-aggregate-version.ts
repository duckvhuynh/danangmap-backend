import type { EntityManager } from 'typeorm';

/**
 * Advances the layer aggregate version when a mutation changes which revision
 * the layer detail endpoint exposes. This keeps conditional GET responses from
 * serving a previously published revision after a new editorial draft exists.
 */
export async function touchLayerAggregate(
  manager: EntityManager,
  layerId: string,
): Promise<number> {
  const rows = (await manager.query(
    `UPDATE layers
     SET lock_version=lock_version+1,updated_at=now()
     WHERE id=$1
     RETURNING lock_version`,
    [layerId],
  )) as Array<{ lock_version: number }>;
  return Number(rows[0]?.lock_version ?? 0);
}

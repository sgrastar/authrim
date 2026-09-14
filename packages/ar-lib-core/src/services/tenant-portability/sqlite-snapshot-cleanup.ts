import type { DatabaseAdapter } from '../../db/adapter';

type Database = Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
function identity(snapshotId: string, tenantId: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(snapshotId) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(tenantId))
    throw new Error('backup_snapshot_cleanup_invalid_identity');
}
/**
 * Terminal transition for one authorized resource/snapshot. The coordinator must first persist its
 * cancellation or durable artifact receipt and validate cleanup ownership. IDs must never be reused.
 * Invalid snapshots cannot resume reads or collect more preimages through capture triggers.
 */
export async function invalidateSqliteBackupSnapshot(
  database: Database,
  snapshotId: string,
  tenantId: string
): Promise<void> {
  identity(snapshotId, tenantId);
  const result = await database.execute(
    "UPDATE tenant_backup_snapshots SET state='invalid' WHERE id=? AND tenant_id=?",
    [snapshotId, tenantId]
  );
  if (!result.success) throw new Error('backup_snapshot_cleanup_failed');
}

/** Delete at most 100 preimages; keep capture triggers installed for other concurrent snapshots. */
export async function cleanupSqliteBackupSnapshotPage(
  database: Database,
  snapshotId: string,
  tenantId: string,
  retainTombstone = false
): Promise<{ removed: number; complete: boolean }> {
  identity(snapshotId, tenantId);
  const snapshot = await database.queryOne<{ state: string }>(
    'SELECT state FROM tenant_backup_snapshots WHERE id=? AND tenant_id=?',
    [snapshotId, tenantId]
  );
  if (!snapshot) return { removed: 0, complete: true };
  if (snapshot.state !== 'invalid') throw new Error('backup_snapshot_cleanup_not_invalid');
  const deleted = await database.execute(
    `DELETE FROM tenant_backup_preimages WHERE snapshot_id=?
    AND (source_table,record_key) IN (
      SELECT p.source_table,p.record_key FROM tenant_backup_preimages p
      JOIN tenant_backup_snapshots s ON s.id=p.snapshot_id
      WHERE s.id=? AND s.tenant_id=? AND s.state='invalid'
      ORDER BY p.source_table,p.record_key LIMIT 100
    )`,
    [snapshotId, snapshotId, tenantId]
  );
  if (!deleted.success) throw new Error('backup_snapshot_cleanup_failed');
  if (retainTombstone) {
    const child = await database.queryOne<{ snapshot_id: string }>(
      'SELECT snapshot_id FROM tenant_backup_preimages WHERE snapshot_id=? LIMIT 1',
      [snapshotId]
    );
    return { removed: deleted.rowsAffected, complete: !child };
  }
  // Remove the header only after all children are gone; never invoke an unbounded FK cascade.
  const header = await database.execute(
    `DELETE FROM tenant_backup_snapshots WHERE id=? AND tenant_id=? AND state='invalid'
    AND NOT EXISTS(SELECT 1 FROM tenant_backup_preimages WHERE snapshot_id=?)`,
    [snapshotId, tenantId, snapshotId]
  );
  if (!header.success) throw new Error('backup_snapshot_cleanup_failed');
  const remaining = await database.queryOne<{ id: string }>(
    'SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id=?',
    [snapshotId, tenantId]
  );
  return { removed: deleted.rowsAffected, complete: !remaining };
}

/**
 * Cancellation may race an already dispatched source INSERT. Keep an invalid header even when
 * that INSERT has not arrived: unique identity plus the monotonic trigger reject late starts.
 * The tombstone must outlive all old source commands; do not expire it on a wall-clock guess.
 */
export async function tombstoneSqliteBackupSnapshot(
  database: Database,
  snapshotId: string,
  tenantId: string
): Promise<void> {
  identity(snapshotId, tenantId);
  const result = await database.execute(
    `INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES (?,?,'invalid')
    ON CONFLICT(id) DO UPDATE SET state='invalid' WHERE tenant_id=excluded.tenant_id`,
    [snapshotId, tenantId]
  );
  if (!result.success) throw new Error('backup_snapshot_cleanup_failed');
  const row = await database.queryOne<{ state: string }>(
    'SELECT state FROM tenant_backup_snapshots WHERE id=? AND tenant_id=?',
    [snapshotId, tenantId]
  );
  if (row?.state !== 'invalid') throw new Error('backup_snapshot_cleanup_identity_conflict');
}

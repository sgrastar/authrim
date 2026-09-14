import type { DatabaseAdapter } from '../../db/adapter';

/** Retains expiry evidence until every object and nonce receipt has been removed. */
export async function cleanupExpiredTenantBackupArtifact(input: {
  database: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
  bucket: { delete(key: string): Promise<void> };
  now: number;
}): Promise<{ objectsRemoved: number }> {
  if (!Number.isSafeInteger(input.now) || input.now < 0)
    throw new Error('backup_cleanup_invalid_time');
  const db = input.database;
  const attempt = await db.queryOne<{ id: string; tenant_id: string }>(
    `UPDATE tenant_backup_artifact_attempts SET state='deleting' WHERE id=(
      SELECT a.id FROM tenant_backup_artifact_attempts a
      LEFT JOIN tenant_backup_publications p ON a.id=p.attempt_id AND a.tenant_id=p.tenant_id
      WHERE (p.expires_at<=? AND a.state IN ('sealed','deleting'))
        OR (a.state='deleting' AND p.attempt_id IS NULL)
      ORDER BY COALESCE(p.expires_at,0),a.id LIMIT 1
    ) RETURNING id,tenant_id`,
    [input.now]
  );
  if (!attempt) return { objectsRemoved: 0 };
  let objectsRemoved = 0;
  for (let i = 0; i < 32; i++) {
    const part = await db.queryOne<{ ordinal: number; object_key: string }>(
      `SELECT ordinal,object_key FROM tenant_backup_artifact_parts
       WHERE attempt_id=? AND tenant_id=? ORDER BY ordinal LIMIT 1`,
      [attempt.id, attempt.tenant_id]
    );
    if (!part) break;
    if (!part.object_key.startsWith(`tenant-backup-staging/${attempt.id}/${part.ordinal}/`))
      throw new Error('backup_cleanup_invalid_object');
    // An uncertain delete leaves the receipt intact. Deleting the same immutable key is safe.
    await input.bucket.delete(part.object_key);
    await db.execute(
      `DELETE FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=? AND ordinal=? AND object_key=?`,
      [attempt.id, attempt.tenant_id, part.ordinal, part.object_key]
    );
    objectsRemoved++;
  }
  await db.execute(
    `DELETE FROM tenant_backup_cipher_frames WHERE attempt_id=? AND sequence IN (
      SELECT sequence FROM tenant_backup_cipher_frames WHERE attempt_id=? ORDER BY sequence LIMIT 100
    )`,
    [attempt.id, attempt.id]
  );
  await db.execute(
    `DELETE FROM tenant_backup_cipher_streams WHERE attempt_id=? AND tenant_id=?
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_cipher_frames WHERE attempt_id=?)`,
    [attempt.id, attempt.tenant_id, attempt.id]
  );
  await db.execute(
    `DELETE FROM tenant_backup_publications WHERE attempt_id=? AND tenant_id=? AND expires_at<=?
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_artifact_parts WHERE attempt_id=?)
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_cipher_streams WHERE attempt_id=?)`,
    [attempt.id, attempt.tenant_id, input.now, attempt.id, attempt.id]
  );
  await db.execute(
    `DELETE FROM tenant_backup_artifact_attempts WHERE id=? AND tenant_id=? AND state='deleting'
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_publications WHERE attempt_id=?)
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_artifact_parts WHERE attempt_id=?)
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_cipher_streams WHERE attempt_id=?)`,
    [attempt.id, attempt.tenant_id, attempt.id, attempt.id, attempt.id]
  );
  return { objectsRemoved };
}

import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext } from './operation-executor';

type Database = Pick<DatabaseAdapter, 'queryOne' | 'execute'>;

interface CleanupBucket {
  head(key: string): Promise<object | null>;
  delete(key: string): Promise<void>;
}

interface ArtifactAttempt {
  id: string;
  tenant_id: string;
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('backup_cleanup_invalid_time');
  return value;
}

async function assertCancellation(
  database: Database,
  context: TenantBackupStepContext,
  now: () => number
): Promise<void> {
  const current = timestamp(now);
  const row = await database.queryOne(
    `SELECT id FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND state='cancelling'
    AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?`,
    [
      context.lease.operationId,
      context.lease.tenantId,
      context.lease.owner,
      context.lease.fencingToken,
      current,
      current,
    ]
  );
  if (!row) throw new Error('backup_artifact_cleanup_fenced');
}

/**
 * Deletes ciphertext owned by one cancelled export operation. Receipts are retained until R2
 * confirms absence, so a lost delete response can be retried without guessing. One call handles
 * at most 32 objects and 100 nonce reservations.
 */
export async function cleanupCancelledTenantBackupArtifactPage(input: {
  database: Database;
  bucket?: CleanupBucket;
  context: TenantBackupStepContext;
  now?: () => number;
}): Promise<{ done: boolean; objectsRemoved: number }> {
  const now = input.now ?? Date.now;
  input.context.signal.throwIfAborted();
  await assertCancellation(input.database, input.context, now);
  const attempt = await input.database.queryOne<ArtifactAttempt>(
    `UPDATE tenant_backup_artifact_attempts SET state='deleting' WHERE id=(
      SELECT a.id FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
      ON o.id=a.operation_id AND o.tenant_id=a.tenant_id
      WHERE o.id=? AND o.tenant_id=? AND o.state='cancelling' AND o.lease_owner=?
      AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
      ORDER BY a.created_at,a.id LIMIT 1
    ) RETURNING id,tenant_id`,
    [
      input.context.lease.operationId,
      input.context.lease.tenantId,
      input.context.lease.owner,
      input.context.lease.fencingToken,
      timestamp(now),
      timestamp(now),
    ]
  );
  if (!attempt) {
    await assertCancellation(input.database, input.context, now);
    return { done: true, objectsRemoved: 0 };
  }
  if (!input.bucket) throw new Error('backup_artifact_cleanup_bucket_unavailable');

  let objectsRemoved = 0;
  for (let index = 0; index < 32; index += 1) {
    input.context.signal.throwIfAborted();
    await assertCancellation(input.database, input.context, now);
    const part = await input.database.queryOne<{ ordinal: number; object_key: string }>(
      `SELECT ordinal,object_key FROM tenant_backup_artifact_parts
      WHERE attempt_id=? AND tenant_id=? ORDER BY ordinal LIMIT 1`,
      [attempt.id, attempt.tenant_id]
    );
    if (!part) break;
    if (!part.object_key.startsWith(`tenant-backup-staging/${attempt.id}/${part.ordinal}/`))
      throw new Error('backup_artifact_cleanup_identity');
    if (await input.bucket.head(part.object_key)) {
      await input.bucket.delete(part.object_key);
      if (await input.bucket.head(part.object_key))
        throw new Error('backup_artifact_cleanup_failed');
    }
    await assertCancellation(input.database, input.context, now);
    const deleted = await input.database.execute(
      `DELETE FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=?
      AND ordinal=? AND object_key=? AND EXISTS (SELECT 1 FROM tenant_backup_operations o
        JOIN tenant_backup_artifact_attempts a ON a.operation_id=o.id AND a.tenant_id=o.tenant_id
        WHERE a.id=? AND o.id=? AND o.tenant_id=? AND o.state='cancelling'
        AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?)`,
      [
        attempt.id,
        attempt.tenant_id,
        part.ordinal,
        part.object_key,
        attempt.id,
        input.context.lease.operationId,
        input.context.lease.tenantId,
        input.context.lease.owner,
        input.context.lease.fencingToken,
        timestamp(now),
        timestamp(now),
      ]
    );
    if (deleted.rowsAffected !== 1) throw new Error('backup_artifact_cleanup_fenced');
    objectsRemoved += 1;
  }

  await assertCancellation(input.database, input.context, now);
  await input.database.execute(
    `DELETE FROM tenant_backup_cipher_frames WHERE attempt_id=? AND sequence IN (
      SELECT sequence FROM tenant_backup_cipher_frames WHERE attempt_id=? ORDER BY sequence LIMIT 100
    )`,
    [attempt.id, attempt.id]
  );
  await assertCancellation(input.database, input.context, now);
  await input.database.execute(
    `DELETE FROM tenant_backup_cipher_streams WHERE attempt_id=? AND tenant_id=?
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_cipher_frames WHERE attempt_id=?)`,
    [attempt.id, attempt.tenant_id, attempt.id]
  );
  await input.database.execute(
    `DELETE FROM tenant_backup_publications WHERE attempt_id=? AND tenant_id=?
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_artifact_parts WHERE attempt_id=?)
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_cipher_streams WHERE attempt_id=?)`,
    [attempt.id, attempt.tenant_id, attempt.id, attempt.id]
  );
  await input.database.execute(
    `DELETE FROM tenant_backup_artifact_attempts WHERE id=? AND tenant_id=? AND state='deleting'
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_publications WHERE attempt_id=?)
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_artifact_parts WHERE attempt_id=?)
    AND NOT EXISTS (SELECT 1 FROM tenant_backup_cipher_streams WHERE attempt_id=?)`,
    [attempt.id, attempt.tenant_id, attempt.id, attempt.id, attempt.id]
  );
  await assertCancellation(input.database, input.context, now);
  // Re-enter once more to prove there are no additional attempts for this operation.
  return { done: false, objectsRemoved };
}

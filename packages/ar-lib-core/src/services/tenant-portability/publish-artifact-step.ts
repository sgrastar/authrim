import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';

function fail(): never {
  throw new Error('backup_artifact_publication_failed');
}
/**
 * Publish a fully verified ciphertext artifact for seven days. The preparation/coordinator guard
 * must establish complete module coverage, the intended snapshot and released capture resources.
 * Download handlers must additionally require ready operation state, unexpired publication and auth.
 */
export async function runTenantBackupArtifactPublicationStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'queryOne'>;
    inventory: TenantBackupExecutionInventory;
    now: () => number;
    assertPublishable: (inventoryDigest: string) => Promise<void>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'publish_artifact' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId
  )
    fail();
  let cursor: { version: number; attemptId: string; nextPart: number; verifiedBytes: number };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !== 'attemptId,nextPart,verifiedBytes,version' ||
    cursor.version !== 1 ||
    typeof cursor.attemptId !== 'string' ||
    !cursor.attemptId ||
    !Number.isSafeInteger(cursor.nextPart) ||
    cursor.nextPart < 1 ||
    !Number.isSafeInteger(cursor.verifiedBytes) ||
    cursor.verifiedBytes < 1
  )
    fail();
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') fail();
  signal.throwIfAborted();
  await input.assertPublishable(head.chain_digest);
  const now = input.now();
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 604800000)) fail();
  await input.database.queryOne(
    `INSERT INTO tenant_backup_publications(operation_id,tenant_id,attempt_id,inventory_digest,published_at,expires_at)
    SELECT o.id,o.tenant_id,a.id,p.chain_digest,?,? FROM tenant_backup_operations o
    JOIN tenant_backup_artifact_attempts a ON a.operation_id=o.id AND a.tenant_id=o.tenant_id
    JOIN tenant_backup_cipher_streams s ON s.attempt_id=a.id AND s.tenant_id=a.tenant_id
    JOIN tenant_backup_execution_inventories p ON p.operation_id=o.id AND p.tenant_id=o.tenant_id
    WHERE o.id=? AND o.tenant_id=? AND o.state='running' AND o.kind='export' AND o.phase='publish_artifact' AND o.cursor_json=?
      AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
      AND a.id=? AND a.state='sealed' AND a.part_count=? AND a.byte_count=? AND s.finished=1
      AND p.state='sealed' AND p.chain_digest=?
      AND (SELECT count(*) FROM tenant_backup_artifact_parts t WHERE t.attempt_id=a.id AND t.uploaded=1)=a.part_count
      AND (SELECT sum(byte_count) FROM tenant_backup_artifact_parts t WHERE t.attempt_id=a.id)=a.byte_count
      AND (SELECT max(ordinal) FROM tenant_backup_artifact_parts t WHERE t.attempt_id=a.id)=a.part_count-1
    ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
    [
      now,
      now + 604800000,
      lease.operationId,
      lease.tenantId,
      operation.cursor_json,
      lease.owner,
      lease.fencingToken,
      now,
      now,
      cursor.attemptId,
      cursor.nextPart,
      cursor.verifiedBytes,
      head.chain_digest,
    ]
  );
  await input.inventory.headForLease(lease);
  await input.assertPublishable(head.chain_digest);
  const saved = await input.database.queryOne<{
    attempt_id: string;
    inventory_digest: string;
    published_at: number;
    expires_at: number;
  }>(
    `SELECT v.* FROM tenant_backup_publications v JOIN tenant_backup_artifact_attempts a ON a.id=v.attempt_id AND a.tenant_id=v.tenant_id
     JOIN tenant_backup_operations o ON o.id=v.operation_id AND o.tenant_id=v.tenant_id
     WHERE v.operation_id=? AND v.tenant_id=? AND a.state='sealed' AND a.part_count=? AND a.byte_count=?
     AND o.state='running' AND o.phase='publish_artifact' AND o.cursor_json=? AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>?`,
    [
      lease.operationId,
      lease.tenantId,
      cursor.nextPart,
      cursor.verifiedBytes,
      operation.cursor_json,
      lease.owner,
      lease.fencingToken,
      input.now(),
    ]
  );
  if (
    !saved ||
    saved.attempt_id !== cursor.attemptId ||
    saved.inventory_digest !== head.chain_digest ||
    saved.expires_at <= input.now() ||
    saved.published_at > input.now()
  )
    fail();
  signal.throwIfAborted();
  return {
    phase: 'export_complete',
    cursor: JSON.stringify({
      version: 1,
      attemptId: cursor.attemptId,
      expiresAt: saved.expires_at,
    }),
    disposition: 'ready',
  };
}

import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext } from './operation-executor';

type Database = Pick<DatabaseAdapter, 'queryOne'>;

export interface TenantBackupRestoreCleanupTarget {
  ordinal: number;
  targetId: string;
  resourceId: string;
  provisioningId: string;
  seedFingerprint: string;
  planDigest: string;
}

interface TargetRow {
  ordinal: number;
  item_id: string;
  payload_json: string;
  payload_digest: string;
  plan_digest: string;
}

function decode(row: TargetRow): TenantBackupRestoreCleanupTarget {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    throw new Error('backup_restore_cleanup_inventory');
  }
  const targetId = parsed.targetId;
  const resourceId = parsed.resourceId;
  const provisioningId = parsed.provisioningId;
  if (
    !parsed ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      'kind,provisioningId,resourceId,seedFingerprint,targetId,version' ||
    parsed.version !== 1 ||
    parsed.kind !== 'sqlite-restore-target' ||
    typeof targetId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(targetId) ||
    typeof resourceId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(resourceId) ||
    typeof provisioningId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(provisioningId) ||
    typeof parsed.seedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.seedFingerprint) ||
    row.item_id !== `restore-target:${targetId}` ||
    !/^[a-f0-9]{64}$/.test(row.payload_digest) ||
    !/^[a-f0-9]{64}$/.test(row.plan_digest)
  )
    throw new Error('backup_restore_cleanup_inventory');
  return {
    ordinal: row.ordinal,
    targetId,
    resourceId,
    provisioningId,
    seedFingerprint: parsed.seedFingerprint,
    planDigest: row.plan_digest,
  };
}

/**
 * Clean one restore-plan target and persist proof only after the installed adapter confirms that
 * its exact physical resource is absent. Provisioned resources missing from the plan are handled
 * by the adapter's broader operation inventory cleanup.
 */
export async function cleanupTenantBackupRestoreTargetPage(input: {
  database: Database;
  context: TenantBackupStepContext;
  cleanup(target: Readonly<TenantBackupRestoreCleanupTarget>): Promise<void>;
  now?: () => number;
}): Promise<{ done: boolean }> {
  const now = input.now ?? Date.now;
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('backup_restore_cleanup_clock');
  input.context.signal.throwIfAborted();
  const params = [
    input.context.lease.operationId,
    input.context.lease.tenantId,
    input.context.lease.owner,
    input.context.lease.fencingToken,
    timestamp,
    timestamp,
  ];
  const row = await input.database.queryOne<TargetRow>(
    `SELECT i.ordinal,i.item_id,i.payload_json,i.payload_digest,p.chain_digest AS plan_digest
    FROM tenant_backup_restore_plan_inventory_items i
    JOIN tenant_backup_restore_plan_inventories p ON p.operation_id=i.operation_id AND p.tenant_id=i.tenant_id
    JOIN tenant_backup_operations o ON o.id=p.operation_id AND o.tenant_id=p.tenant_id
    LEFT JOIN tenant_backup_restore_cleanup_receipts c
      ON c.operation_id=i.operation_id AND c.item_ordinal=i.ordinal
    WHERE o.id=? AND o.tenant_id=? AND o.state='cancelling' AND o.lease_owner=?
    AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
    AND i.item_id LIKE 'restore-target:%' AND c.operation_id IS NULL
    ORDER BY i.ordinal LIMIT 1`,
    params
  );
  if (!row) {
    const active = await input.database.queryOne(
      `SELECT id FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND state='cancelling'
      AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?`,
      params
    );
    if (!active) throw new Error('backup_restore_cleanup_fenced');
    return { done: true };
  }
  const target = Object.freeze(decode(row));
  await input.cleanup(target);
  input.context.signal.throwIfAborted();
  const saved = await input.database.queryOne<{ payload_digest: string }>(
    `INSERT INTO tenant_backup_restore_cleanup_receipts
    (operation_id,tenant_id,item_ordinal,item_id,payload_digest,cleaned_at)
    SELECT i.operation_id,i.tenant_id,i.ordinal,i.item_id,i.payload_digest,?
    FROM tenant_backup_restore_plan_inventory_items i JOIN tenant_backup_operations o
      ON o.id=i.operation_id AND o.tenant_id=i.tenant_id
    WHERE i.operation_id=? AND i.tenant_id=? AND i.ordinal=? AND i.item_id=? AND i.payload_digest=?
    AND o.state='cancelling' AND o.lease_owner=? AND o.fencing_token=?
    AND o.lease_expires_at>? AND o.updated_at<=?
    ON CONFLICT(operation_id,item_ordinal) DO NOTHING RETURNING payload_digest`,
    [
      timestamp,
      input.context.lease.operationId,
      input.context.lease.tenantId,
      row.ordinal,
      row.item_id,
      row.payload_digest,
      input.context.lease.owner,
      input.context.lease.fencingToken,
      timestamp,
      timestamp,
    ]
  );
  if (!saved) {
    const existing = await input.database.queryOne<{ payload_digest: string; item_id: string }>(
      `SELECT payload_digest,item_id FROM tenant_backup_restore_cleanup_receipts
      WHERE operation_id=? AND tenant_id=? AND item_ordinal=?`,
      [input.context.lease.operationId, input.context.lease.tenantId, row.ordinal]
    );
    if (existing?.payload_digest !== row.payload_digest || existing.item_id !== row.item_id)
      throw new Error('backup_restore_cleanup_fenced');
  }
  return { done: false };
}

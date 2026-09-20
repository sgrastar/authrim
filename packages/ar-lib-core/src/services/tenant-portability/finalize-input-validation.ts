import { TenantBackupContainerInputStore } from './container-input-store';
import { encodeTenantBundleManifest, type TenantBundleManifest } from './bundle-manifest';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';

function fail(): never {
  throw new Error('backup_input_validation_incomplete');
}

/**
 * Finalize only when every effective dataset has an inspection receipt and every pinned input is
 * completely authenticated. Overlaps use the newest snapshot, while reference paging must reach the
 * sealed index's actual end/count. This does not authorize target activation.
 * Keep the session and its evidence until restore and cleanup finish.
 */
export async function finalizeTenantBackupInputValidation(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
    inventory: TenantBackupExecutionInventory;
    now: () => number;
  }
): Promise<void> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'finalize_input_validation' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId
  )
    fail();
  let cursor: {
    version: number;
    sessionId: string;
    inputSetDigest: string;
    after: string;
    examined: number;
    unresolvedProvenance: number;
  };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !==
      'after,examined,inputSetDigest,sessionId,unresolvedProvenance,version' ||
    cursor.version !== 1 ||
    typeof cursor.sessionId !== 'string' ||
    !cursor.sessionId ||
    typeof cursor.after !== 'string' ||
    !Number.isSafeInteger(cursor.examined) ||
    cursor.examined < 0 ||
    !Number.isSafeInteger(cursor.unresolvedProvenance) ||
    cursor.unresolvedProvenance < 0 ||
    cursor.unresolvedProvenance > cursor.examined
  )
    fail();
  signal.throwIfAborted();
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed' || head.chain_digest !== cursor.inputSetDigest) fail();
  // Reference validation seals the session before checkpointing this phase. A later scheduler slice
  // owns a newer operation lease, so adopt that lease before checking the final evidence atomically.
  await DatabaseTenantBundleReferenceIndex.resume(
    input.database,
    cursor.sessionId,
    lease,
    input.now
  );
  const receipts = new TenantBackupContainerInputStore(input.database, lease, input.now);
  let inputCount = 0;
  for (let offset = 0; offset < head.item_count; ) {
    const page = await input.inventory.readPage(offset);
    if (!page.length) fail();
    for (const item of page) {
      const value = JSON.parse(item.payload_json) as {
        kind: string;
        manifest: TenantBundleManifest;
        identity: TenantBackupInputIdentity;
      };
      if (value.kind !== 'backup-input') continue;
      if (++inputCount > 32) fail();
      const decoded = await receipts.load(value.manifest.bundleId);
      const manifestHash = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new Uint8Array(encodeTenantBundleManifest(value.manifest, value.manifest))
          )
        ),
      ]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (
        decoded.manifest_sha256 !== manifestHash ||
        ['key', 'version', 'etag', 'size'].some(
          (key) =>
            decoded[`object_${key === 'key' ? 'key' : key}` as keyof typeof decoded] !==
            value.identity[key as keyof TenantBackupInputIdentity]
        )
      )
        fail();
    }
    offset += page.length;
  }
  if (!inputCount) fail();
  const now = input.now();
  if (!Number.isSafeInteger(now) || now < 0) fail();
  const coverage = `WITH inputs AS (
      SELECT i.ordinal,json_extract(payload_json,'$.manifest.bundleId') AS bundle_id,
        json_extract(payload_json,'$.manifest.boundaryUnixMs') AS boundary_unix_ms,
        json_extract(payload_json,'$.manifest.datasets') AS datasets
      FROM tenant_backup_execution_inventory_items i WHERE operation_id=? AND tenant_id=? AND json_extract(payload_json,'$.kind')='backup-input'
    ), ranked_expected AS (
      SELECT i.bundle_id,json_extract(d.value,'$.id') AS dataset_id,
        row_number() OVER (
          PARTITION BY json_extract(d.value,'$.id')
          ORDER BY i.boundary_unix_ms DESC,i.ordinal DESC
        ) AS owner_rank
      FROM inputs i,json_each(i.datasets) d
    ), expected AS (
      SELECT bundle_id,dataset_id FROM ranked_expected WHERE owner_rank=1
    )
    SELECT o.id,o.tenant_id,s.id,?,?,? FROM tenant_backup_operations o
      JOIN tenant_backup_validation_sessions s ON s.operation_id=o.id AND s.tenant_id=o.tenant_id
      JOIN tenant_backup_execution_inventories p ON p.operation_id=o.id AND p.tenant_id=o.tenant_id
    WHERE o.id=? AND o.tenant_id=? AND o.state='running' AND o.kind='import' AND o.phase='finalize_input_validation' AND o.cursor_json=?
      AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
      AND s.id=? AND s.state='sealed' AND s.fencing_token=o.fencing_token AND p.state='sealed' AND p.chain_digest=?
      AND (SELECT count(*) FROM inputs)>0 AND (SELECT count(*) FROM inputs)=(SELECT count(DISTINCT bundle_id) FROM inputs)
      AND NOT EXISTS (SELECT 1 FROM inputs i WHERE NOT EXISTS (
        SELECT 1 FROM tenant_backup_container_inputs r WHERE r.operation_id=o.id AND r.tenant_id=o.tenant_id AND r.bundle_id=i.bundle_id))
      AND NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (
        SELECT 1 FROM tenant_backup_dataset_inspections d JOIN tenant_backup_container_inputs r ON r.operation_id=o.id AND r.tenant_id=o.tenant_id AND r.bundle_id=d.bundle_id
        WHERE d.session_id=s.id AND d.tenant_id=s.tenant_id AND d.bundle_id=e.bundle_id AND d.dataset_id=e.dataset_id
        AND d.manifest_sha256=r.manifest_sha256))
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_dataset_inspections d WHERE d.session_id=s.id AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.bundle_id=d.bundle_id AND e.dataset_id=d.dataset_id))
      AND (SELECT count(*) FROM tenant_backup_validation_references r WHERE r.session_id=s.id)=?
      AND COALESCE((SELECT max(id) FROM tenant_backup_validation_references r WHERE r.session_id=s.id),'')=?`;
  const parameters = [
    lease.operationId,
    lease.tenantId,
    head.chain_digest,
    cursor.examined,
    cursor.unresolvedProvenance,
    lease.operationId,
    lease.tenantId,
    operation.cursor_json,
    lease.owner,
    lease.fencingToken,
    now,
    now,
    cursor.sessionId,
    head.chain_digest,
    cursor.examined,
    cursor.after,
  ];
  if (!(await input.database.queryOne(coverage, parameters))) fail();
  await input.database.queryOne(
    `INSERT INTO tenant_backup_input_validations(operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance) ${coverage} ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
    parameters
  );
  await input.inventory.headForLease(lease);
  const saved = await input.database.queryOne<{
    session_id: string;
    input_inventory_digest: string;
    examined_references: number;
    unresolved_provenance: number;
  }>(`SELECT * FROM tenant_backup_input_validations WHERE operation_id=? AND tenant_id=?`, [
    lease.operationId,
    lease.tenantId,
  ]);
  if (
    !saved ||
    saved.session_id !== cursor.sessionId ||
    saved.input_inventory_digest !== head.chain_digest ||
    saved.examined_references !== cursor.examined ||
    saved.unresolved_provenance !== cursor.unresolvedProvenance
  )
    fail();
  signal.throwIfAborted();
}

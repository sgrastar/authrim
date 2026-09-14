import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { TenantBackupSnapshotResources } from './snapshot-resources';
import type { TenantPortableDataset } from './module-contract';
import { TENANT_DATASET_POLICIES } from './dataset-registry';
import { verifyLiveSqliteTenantDatasetPlan } from './sqlite-dataset-plan';
import { readNextSqliteSnapshotChunk } from './sqlite-dataset-source';

type Plan = Parameters<typeof verifyLiveSqliteTenantDatasetPlan>[0];

/**
 * Raw SQL reader for installed module adapters. Field transformations, log windows and complete
 * module coverage remain the adapter's responsibility; this does not declare a module supported.
 * Both the physical source and the continuation position are pinned to the persisted operation.
 */
export async function readNextPlannedSqliteDatasetChunk(
  input: {
    context: TenantBackupStepContext;
    inventory: TenantBackupExecutionInventory;
    resources: TenantBackupSnapshotResources;
    dataset: TenantPortableDataset;
    table: string;
    family: Plan['family'];
    resourceId: string;
    firstOrdinal: number;
    snapshotId: string;
    selection: Plan['selection'];
    resolveSource: () => Promise<{ resourceId: string; database: Plan['database'] }>;
    assertSourceStable: () => Promise<void>;
  },
  cursorJson: string | null
): Promise<{ bytes: Uint8Array; nextCursor: string } | null> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.dataset.store !== 'database' ||
    input.dataset.disposition !== 'include'
  )
    throw new Error('backup_sqlite_reader_context');
  const policy = TENANT_DATASET_POLICIES.filter(
    (p) => p.family === input.family && p.table === input.table
  );
  if (policy.length !== 1 || policy[0].kind !== input.dataset.kind)
    throw new Error('backup_sqlite_reader_policy');
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') throw new Error('backup_sqlite_reader_unsealed');
  const identity = {
    version: 1,
    operationId: lease.operationId,
    tenantId: lease.tenantId,
    inventoryDigest: head.chain_digest,
    datasetId: input.dataset.id,
    resourceId: input.resourceId,
    table: input.table,
    snapshotId: input.snapshotId,
  };
  let sourceCursor: string | null = null;
  if (cursorJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cursorJson);
    } catch {
      throw new Error('backup_sqlite_reader_cursor');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('backup_sqlite_reader_cursor');
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).length !== 9 ||
      Object.entries(identity).some(([key, expected]) => value[key] !== expected) ||
      typeof value.sourceCursor !== 'string'
    )
      throw new Error('backup_sqlite_reader_cursor');
    sourceCursor = value.sourceCursor;
  }
  const guard = async () => {
    signal.throwIfAborted();
    await input.inventory.headForLease(lease);
    await input.resources.assertCaptureOwner(lease, input.resourceId, input.snapshotId);
    await input.assertSourceStable();
    signal.throwIfAborted();
  };
  await guard();
  const source = await input.resolveSource();
  if (source.resourceId !== input.resourceId)
    throw new Error('backup_resource_destination_changed');
  const schemas = await verifyLiveSqliteTenantDatasetPlan({
    inventory: input.inventory,
    database: source.database,
    family: input.family,
    resourceId: input.resourceId,
    firstOrdinal: input.firstOrdinal,
    selection: input.selection,
    signal,
  });
  const schema = schemas.find((schema) => schema.table === input.table);
  if (!schema) throw new Error('backup_sqlite_reader_dataset_unselected');
  await guard();
  const chunk = await readNextSqliteSnapshotChunk(
    {
      database: source.database,
      schema,
      snapshotId: input.snapshotId,
      tenantId: lease.tenantId,
      signal,
    },
    sourceCursor
  );
  await guard();
  if (!chunk) return null;
  const nextCursor = JSON.stringify({ ...identity, sourceCursor: chunk.nextCursor });
  if (nextCursor.length > 16384) throw new Error('backup_sqlite_reader_cursor_limit');
  return { bytes: chunk.bytes, nextCursor };
}

import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { TenantBackupSnapshotResources } from './snapshot-resources';
import type { TenantPortableDataset } from './module-contract';
import { TENANT_DATASET_POLICIES, TENANT_DATASET_ROW_PARTITIONS } from './dataset-registry';
import { readNextSqliteSnapshotChunk } from './sqlite-dataset-source';
import { sqliteCapturePlan } from './sqlite-capture-plan';
import type { CaptureSchema } from './sqlite-snapshot';

type Plan = {
  family: import('../control-plane/migration-stream-contract').MigrationSchemaFamily;
  database: Pick<
    import('../../db/adapter').DatabaseAdapter,
    'query' | 'queryOne' | 'execute' | 'batch'
  >;
  selection: import('./selection-contract').TenantBackupSelection;
};

type SealedHead = { state: string; chain_digest: string };
const readSessionHeads = new WeakMap<object, Promise<SealedHead>>();
const readSessionResourceGuards = new WeakMap<object, Map<string, Promise<void>>>();
const readSessionSnapshotChecks = new WeakMap<object, Map<string, Promise<void>>>();

function cachedMap(
  cache: WeakMap<object, Map<string, Promise<void>>>,
  context: object
): Map<string, Promise<void>> {
  let value = cache.get(context);
  if (!value) {
    value = new Map();
    cache.set(context, value);
  }
  return value;
}

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
    capture: CaptureSchema;
    family: Plan['family'];
    resourceId: string;
    firstOrdinal: number;
    snapshotId: string;
    partitions?: readonly string[];
    selection: Plan['selection'];
    resolveSource: () => Promise<{ resourceId: string; database: Plan['database'] }>;
    assertSourceStable: () => Promise<void>;
    filterRow?: (rowJson: string) => Promise<boolean>;
    transformRow?: (rowJson: string) => Promise<string>;
    /** Unique to one artifact assembly attempt; omitted callers retain per-call revalidation. */
    readSession?: object;
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
  const partition = TENANT_DATASET_ROW_PARTITIONS.find(
    (item) => item.family === input.family && item.table === input.table
  );
  const allowedKinds = new Set([
    ...policy.map((item) => item.kind),
    ...(partition?.values.map((item) => item.kind) ?? []),
  ]);
  if (policy.length !== 1 || !allowedKinds.has(input.dataset.kind))
    throw new Error('backup_sqlite_reader_policy');
  let headPromise = input.readSession ? readSessionHeads.get(input.readSession) : undefined;
  if (!headPromise) {
    headPromise = input.inventory.headForLease(lease);
    if (input.readSession) readSessionHeads.set(input.readSession, headPromise);
  }
  const head = await headPromise;
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
    partitions: input.partitions ? [...input.partitions].sort().join(',') : '',
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
      Object.keys(value).length !== 10 ||
      Object.entries(identity).some(([key, expected]) => value[key] !== expected) ||
      typeof value.sourceCursor !== 'string'
    )
      throw new Error('backup_sqlite_reader_cursor');
    sourceCursor = value.sourceCursor;
  }
  const guardKey = `${input.resourceId}\u0000${input.snapshotId}`;
  const guard = async () => {
    signal.throwIfAborted();
    const guards = input.readSession
      ? cachedMap(readSessionResourceGuards, input.readSession)
      : undefined;
    let proof = guards?.get(guardKey);
    if (!proof) {
      proof = (async () => {
        const current = await input.inventory.headForLease(lease);
        if (current.state !== 'sealed' || current.chain_digest !== head.chain_digest)
          throw new Error('backup_sqlite_reader_unsealed');
        await input.resources.assertCaptureOwner(lease, input.resourceId, input.snapshotId);
        await input.assertSourceStable();
      })();
      guards?.set(guardKey, proof);
    }
    await proof;
    signal.throwIfAborted();
  };
  await guard();
  const source = await input.resolveSource();
  if (source.resourceId !== input.resourceId)
    throw new Error('backup_resource_destination_changed');
  // Snapshot admission already reconciled this capture schema with the live database and sealed it
  // in the execution inventory. Export reads that immutable plan instead of rescanning the complete
  // live schema for every logical dataset frame.
  const schema = sqliteCapturePlan([input.capture]).schemas.find(
    (candidate) => candidate.table === input.table
  );
  if (!schema) throw new Error('backup_sqlite_reader_dataset_unselected');
  const assertSnapshotActive = async () => {
    signal.throwIfAborted();
    const checks = input.readSession
      ? cachedMap(readSessionSnapshotChecks, input.readSession)
      : undefined;
    let proof = checks?.get(guardKey);
    if (!proof) {
      proof = source.database
        .queryOne<{
          id: string;
        }>(
          "SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id=? AND state='capturing'",
          [input.snapshotId, lease.tenantId]
        )
        .then((snapshot) => {
          if (!snapshot) throw new Error('backup_snapshot_unavailable');
        });
      checks?.set(guardKey, proof);
    }
    await proof;
    signal.throwIfAborted();
  };
  await guard();
  const chunk = await readNextSqliteSnapshotChunk(
    {
      database: source.database,
      schema,
      snapshotId: input.snapshotId,
      tenantId: lease.tenantId,
      signal,
      partitions: input.partitions,
      filterRow: input.filterRow,
      transformRow: input.transformRow,
      assertSnapshotActive,
    },
    sourceCursor
  );
  await guard();
  if (!chunk) return null;
  const nextCursor = JSON.stringify({ ...identity, sourceCursor: chunk.nextCursor });
  if (nextCursor.length > 16384) throw new Error('backup_sqlite_reader_cursor_limit');
  return { bytes: chunk.bytes, nextCursor };
}

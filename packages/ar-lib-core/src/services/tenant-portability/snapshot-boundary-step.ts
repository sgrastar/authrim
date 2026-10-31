import type {
  TenantBackupBoundaryAdmissionPort,
  TenantBackupBoundaryReceiptsPort,
} from './boundary-rpc-contract';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { TenantBackupSqliteCaptureInput } from './sqlite-operation-capture';
import {
  sqliteBoundaryParticipant,
  startTenantBackupSnapshotBoundary,
  type TenantBackupBoundaryStart,
} from './snapshot-boundary';
import {
  validateSqliteResourceDiscoveryCursor,
  type SqliteResourceDiscoveryCursor,
  type SqliteCaptureResource,
} from './sqlite-resource-discovery';

async function identityHash(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parts))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable Control boundary identity used by start and cancellation recovery. */
export function tenantBackupBoundaryId(input: {
  environmentId: string;
  tenantId: string;
  operationId: string;
  inventoryDigest: string;
}): Promise<string> {
  return identityHash([
    'authrim-backup-boundary-v1',
    input.environmentId,
    input.tenantId,
    input.operationId,
    input.inventoryDigest,
  ]);
}

/**
 * Consume the completed preparation cursor through the ordinary leased operation executor.
 * Boundary and SQL snapshot identities exclude the worker/fence so lost checkpoint recovery uses
 * the same persisted release. An aborted attempt requires cleanup, not a new hidden snapshot.
 */
export async function runPreparedSnapshotBoundaryStep(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupExecutionInventory;
  environmentId: string;
  /** Authenticated Control namespace; it may differ from the raw tenant ID used in source rows. */
  boundaryTenantId: string;
  admission: TenantBackupBoundaryAdmissionPort;
  receipts: TenantBackupBoundaryReceiptsPort;
  resources: TenantBackupSqliteCaptureInput['resources'];
  selection: TenantBackupSqliteCaptureInput['selection'];
  tenantKey?: string;
  resolveSource(
    resource: Readonly<SqliteCaptureResource>
  ): Promise<TenantBackupSqliteCaptureInput['source']>;
  additionalParticipants: readonly TenantBackupBoundaryStart[];
  /** Compare the complete participant set with the real required SQL/KV/DO/R2 inventory. */
  assertCoverage(
    resources: readonly SqliteCaptureResource[],
    participants: readonly TenantBackupBoundaryStart[]
  ): Promise<void>;
  /** Hold routing/DDL exclusion and check operation-owned resource availability across the call. */
  assertReady(): Promise<void>;
  now(): number;
}): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'admit_snapshot_boundary' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId
  )
    throw new Error('backup_boundary_step_context');
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') throw new Error('backup_boundary_step_unsealed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.cursor_json ?? 'null');
  } catch {
    throw new Error('backup_boundary_step_cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('backup_boundary_step_cursor');
  const cursor = parsed as {
    discovery: SqliteResourceDiscoveryCursor;
    resourceIndex: number;
    tableOrdinal: number;
  };
  if (Object.keys(cursor).length !== 3 || !cursor.discovery)
    throw new Error('backup_boundary_step_cursor');
  validateSqliteResourceDiscoveryCursor(cursor.discovery, head.chain_digest, head.item_count);
  if (
    cursor.resourceIndex !== cursor.discovery.resources.length ||
    cursor.tableOrdinal !== 0 ||
    cursor.discovery.nextOrdinal !== head.item_count
  )
    throw new Error('backup_boundary_step_preparation_incomplete');
  const boundaryId = await tenantBackupBoundaryId({
    environmentId: input.environmentId,
    tenantId: input.boundaryTenantId,
    operationId: operation.id,
    inventoryDigest: head.chain_digest,
  });
  const assertReady = async () => {
    signal.throwIfAborted();
    await input.inventory.headForLease(lease);
    await input.assertReady();
    signal.throwIfAborted();
  };
  await assertReady();
  const participants: TenantBackupBoundaryStart[] = [];
  for (const resource of cursor.discovery.resources) {
    if (resource.captureCount === 0) continue;
    if (!resource.boundarySchemaDigest)
      throw new Error('backup_boundary_step_preparation_incomplete');
    const source = await input.resolveSource(Object.freeze({ ...resource }));
    signal.throwIfAborted();
    if (source.resourceId !== resource.resourceId)
      throw new Error('backup_resource_destination_changed');
    const snapshotId = await identityHash([
      'authrim-backup-snapshot-v1',
      boundaryId,
      resource.resourceId,
    ]);
    participants.push(
      await sqliteBoundaryParticipant({
        context: input.context,
        inventory: input.inventory,
        resources: input.resources,
        resourceId: resource.resourceId,
        family: resource.family,
        firstOrdinal: resource.firstOrdinal,
        tableCount: resource.tableCount,
        captureCount: resource.captureCount,
        expectedBoundarySchemaDigest: resource.boundarySchemaDigest,
        selection: input.selection,
        tenantKey: input.tenantKey,
        source,
        snapshotId,
        assertBoundary: assertReady,
      })
    );
  }
  for (const participant of input.additionalParticipants)
    participants.push({
      resourceId: participant.resourceId,
      snapshotId: participant.snapshotId,
      start: participant.start.bind(participant),
    });
  // The callback can inspect identities, but cannot silently remove a required SQL resource.
  const frozenParticipants = Object.freeze(
    participants.map((participant) => Object.freeze(participant))
  );
  await input.assertCoverage(
    Object.freeze(cursor.discovery.resources.map((resource) => Object.freeze({ ...resource }))),
    frozenParticipants
  );
  await assertReady();
  const resultCursor = {
    version: 1,
    boundaryId,
    inventoryDigest: head.chain_digest,
    releasedAt: 0,
    participants: frozenParticipants.map(({ resourceId, snapshotId }) => ({
      resourceId,
      snapshotId,
    })),
  };
  // Reserve room for the largest safe timestamp before starting any snapshot.
  if (JSON.stringify({ ...resultCursor, releasedAt: Number.MAX_SAFE_INTEGER }).length > 16384)
    throw new Error('backup_boundary_step_cursor_limit');
  const released = await startTenantBackupSnapshotBoundary({
    identity: {
      environmentId: input.environmentId,
      tenantId: input.boundaryTenantId,
      boundaryId,
      operationId: operation.id,
      inventoryDigest: head.chain_digest,
    },
    admission: input.admission,
    receipts: input.receipts,
    participants: frozenParticipants,
    signal,
    now: () => input.now(),
    assertReady,
  });
  await assertReady();
  return {
    phase: 'prepare_export_artifact',
    disposition: 'continue',
    cursor: JSON.stringify({ ...resultCursor, releasedAt: released.held_at }),
  };
}

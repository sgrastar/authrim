import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import {
  prepareTenantBackupSqliteCapture,
  type TenantBackupSqliteCaptureInput,
  type TenantBackupSqlitePreparationInput,
} from './sqlite-operation-capture';
import { verifyLiveSqliteTenantDatasetPlan } from './sqlite-dataset-plan';
import {
  validateSqliteResourceDiscoveryCursor,
  type SqliteCaptureResource,
  type SqliteResourceDiscoveryCursor,
} from './sqlite-resource-discovery';

type Capture = Omit<
  TenantBackupSqlitePreparationInput,
  'context' | 'resourceId' | 'family' | 'firstOrdinal' | 'source'
>;

/** Prepare all SQL resources before asking the coordinator to admit a cross-store boundary. */
export async function runSqliteResourcePreparationStep(
  input: Capture & {
    context: TenantBackupStepContext;
    resolveSource: (
      resource: Readonly<SqliteCaptureResource>
    ) => Promise<TenantBackupSqliteCaptureInput['source']>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'prepare_capture_resources' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId
  )
    throw new Error('backup_resource_preparation_context');
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') throw new Error('backup_resource_preparation_unsealed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.cursor_json ?? 'null');
  } catch {
    throw new Error('backup_resource_preparation_cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('backup_resource_preparation_cursor');
  let cursor: {
    discovery: SqliteResourceDiscoveryCursor;
    resourceIndex: number;
    tableOrdinal: number;
  };
  if ('nextOrdinal' in parsed)
    cursor = {
      discovery: parsed as SqliteResourceDiscoveryCursor,
      resourceIndex: 0,
      tableOrdinal: 0,
    };
  else cursor = parsed as typeof cursor;
  if (
    Object.keys(cursor).length !== 3 ||
    !cursor.discovery ||
    !Number.isSafeInteger(cursor.resourceIndex) ||
    cursor.resourceIndex < 0 ||
    !Number.isSafeInteger(cursor.tableOrdinal) ||
    cursor.tableOrdinal < 0
  )
    throw new Error('backup_resource_preparation_cursor');
  validateSqliteResourceDiscoveryCursor(cursor.discovery, head.chain_digest, head.item_count);
  if (
    cursor.discovery.nextOrdinal !== head.item_count ||
    cursor.resourceIndex > cursor.discovery.resources.length
  )
    throw new Error('backup_resource_preparation_incomplete_inventory');
  const resource = cursor.discovery.resources[cursor.resourceIndex];
  if (resource) {
    await input.assertBoundary();
    const source = await input.resolveSource(Object.freeze({ ...resource }));
    signal.throwIfAborted();
    if (source.resourceId !== resource.resourceId)
      throw new Error('backup_resource_destination_changed');
    const capture = {
      ...input,
      source,
      resourceId: resource.resourceId,
      family: resource.family,
      firstOrdinal: resource.firstOrdinal,
    };
    if (resource.captureCount === 0) {
      const schemas = await verifyLiveSqliteTenantDatasetPlan({
        ...capture,
        database: source.database,
        signal,
      });
      if (schemas.length || cursor.tableOrdinal !== 0)
        throw new Error('backup_resource_capture_count_changed');
      cursor.resourceIndex++;
    } else {
      const prepared = await prepareTenantBackupSqliteCapture(capture, cursor.tableOrdinal);
      if (prepared.complete) {
        if (!prepared.boundarySchemaDigest)
          throw new Error('backup_resource_schema_digest_missing');
        resource.boundarySchemaDigest = prepared.boundarySchemaDigest;
        cursor.resourceIndex++;
        cursor.tableOrdinal = 0;
      } else cursor.tableOrdinal = prepared.nextTableOrdinal;
    }
  }
  signal.throwIfAborted();
  await input.inventory.headForLease(lease);
  await input.assertBoundary();
  const serialized = JSON.stringify(cursor);
  if (new TextEncoder().encode(serialized).length > 16384)
    throw new Error('backup_resource_preparation_cursor_limit');
  return {
    phase:
      cursor.resourceIndex === cursor.discovery.resources.length
        ? 'admit_snapshot_boundary'
        : operation.phase,
    cursor: serialized,
    disposition: 'continue',
  };
}

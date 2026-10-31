import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';

export interface SqliteCaptureResource {
  resourceId: string;
  family: MigrationSchemaFamily;
  firstOrdinal: number;
  tableCount: number;
  captureCount: number;
  /** Schema fingerprint recorded after the final live verification and trigger installation. */
  boundarySchemaDigest?: string;
}
export interface SqliteResourceDiscoveryCursor {
  version: 1;
  inventoryDigest: string;
  nextOrdinal: number;
  resources: SqliteCaptureResource[];
}
const families = ['core', 'pii', 'admin', 'control', 'lookup', 'plugin_runner'];
function fail(): never {
  throw new Error('backup_sqlite_resource_inventory_invalid');
}
function validResource(value: unknown): value is SqliteCaptureResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as SqliteCaptureResource;
  return (
    (Object.keys(r).length === 5 || Object.keys(r).length === 6) &&
    typeof r.resourceId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(r.resourceId) &&
    families.includes(r.family) &&
    Number.isSafeInteger(r.firstOrdinal) &&
    r.firstOrdinal >= 0 &&
    Number.isSafeInteger(r.tableCount) &&
    r.tableCount > 0 &&
    Number.isSafeInteger(r.captureCount) &&
    r.captureCount >= 0 &&
    r.captureCount <= r.tableCount &&
    (r.boundarySchemaDigest === undefined || /^[a-f0-9]{64}$/.test(r.boundarySchemaDigest))
  );
}

/** Validate persisted discovery metadata before a later phase consumes it. */
export function validateSqliteResourceDiscoveryCursor(
  cursor: SqliteResourceDiscoveryCursor,
  digest: string,
  itemCount: number
): void {
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Object.keys(cursor).length !== 4 ||
    cursor.version !== 1 ||
    cursor.inventoryDigest !== digest ||
    !Number.isSafeInteger(cursor.nextOrdinal) ||
    cursor.nextOrdinal < 0 ||
    cursor.nextOrdinal > itemCount ||
    !Array.isArray(cursor.resources) ||
    cursor.resources.length > 64 ||
    !cursor.resources.every(validResource) ||
    new Set(cursor.resources.map((r) => r.resourceId)).size !== cursor.resources.length
  )
    fail();
  let previousEnd = 0;
  for (const resource of cursor.resources) {
    const end = resource.firstOrdinal + resource.tableCount;
    if (resource.firstOrdinal < previousEnd || end > cursor.nextOrdinal) fail();
    previousEnd = end;
  }
}

/** Enumerate every SQL plan entry, including unselected tables, without an external target list. */
export async function runSqliteResourceDiscoveryStep(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupExecutionInventory;
}): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'discover_sqlite_resources' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId
  )
    fail();
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') fail();
  let cursor: SqliteResourceDiscoveryCursor;
  if (operation.cursor_json === null) {
    cursor = { version: 1, inventoryDigest: head.chain_digest, nextOrdinal: 0, resources: [] };
  } else {
    try {
      cursor = JSON.parse(operation.cursor_json) as SqliteResourceDiscoveryCursor;
    } catch {
      return fail();
    }
    validateSqliteResourceDiscoveryCursor(cursor, head.chain_digest, head.item_count);
  }
  const page = await input.inventory.readPage(cursor.nextOrdinal);
  for (const item of page) {
    const entry = JSON.parse(item.payload_json) as Record<string, unknown>;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail();
    // Other inventory entries describe physical assignments, input handles or restore targets.
    if (!('table' in entry) && !('schemaDigest' in entry) && !('capture' in entry)) continue;
    if (
      entry.version !== 1 ||
      typeof entry.resourceId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(entry.resourceId) ||
      typeof entry.table !== 'string' ||
      !entry.table ||
      item.item_id !== `${entry.resourceId}:${entry.table}` ||
      typeof entry.family !== 'string' ||
      !families.includes(entry.family) ||
      typeof entry.schemaDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.schemaDigest) ||
      (entry.capture !== null &&
        (typeof entry.capture !== 'object' || Array.isArray(entry.capture)))
    )
      fail();
    const existing = cursor.resources.find((r) => r.resourceId === entry.resourceId);
    if (existing) {
      if (
        existing.family !== entry.family ||
        existing.firstOrdinal + existing.tableCount !== item.ordinal
      )
        fail();
      existing.tableCount++;
      if (entry.capture) existing.captureCount++;
    } else {
      if (cursor.resources.length >= 64) fail();
      cursor.resources.push({
        resourceId: entry.resourceId,
        family: entry.family as MigrationSchemaFamily,
        firstOrdinal: item.ordinal,
        tableCount: 1,
        captureCount: entry.capture ? 1 : 0,
      });
    }
  }
  cursor.nextOrdinal += page.length;
  signal.throwIfAborted();
  await input.inventory.headForLease(lease);
  const serialized = JSON.stringify(cursor);
  if (new TextEncoder().encode(serialized).length > 16384) fail();
  return {
    phase: cursor.nextOrdinal === head.item_count ? 'prepare_capture_resources' : operation.phase,
    cursor: serialized,
    disposition: 'continue',
  };
}

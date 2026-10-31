import type { DatabaseAdapter } from '../../db/adapter';
import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupSelection } from './selection-contract';
import { persistSqliteTenantDatasetPlanPage } from './sqlite-dataset-plan';
import { readBackupSqliteDatabaseSchema } from './sqlite-schema-reader';

export interface TenantBackupSqlitePlanResource {
  resourceId: string;
  family: MigrationSchemaFamily;
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
  descriptor: { id: string; payload: string };
}

interface Cursor {
  version: 1;
  resourceSetDigest: string;
  descriptorIndex: number;
  resourceIndex: number;
  entryOffset: number;
  resourceFirstOrdinal: number;
  nextOrdinal: number;
}

function fail(): never {
  throw new Error('backup_export_plan_step_invalid');
}

async function digestResources(resources: readonly TenantBackupSqlitePlanResource[]) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      resources.map((resource) => [
        resource.resourceId,
        resource.family,
        resource.descriptor.id,
        resource.descriptor.payload,
      ])
    )
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCursor(value: string | null, resourceSetDigest: string): Cursor {
  if (value === null)
    return {
      version: 1,
      resourceSetDigest,
      descriptorIndex: 0,
      resourceIndex: 0,
      entryOffset: 0,
      resourceFirstOrdinal: 0,
      nextOrdinal: 0,
    };
  let cursor: Cursor;
  try {
    cursor = JSON.parse(value) as Cursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !==
      'descriptorIndex,entryOffset,nextOrdinal,resourceFirstOrdinal,resourceIndex,resourceSetDigest,version' ||
    cursor.version !== 1 ||
    cursor.resourceSetDigest !== resourceSetDigest ||
    [
      cursor.descriptorIndex,
      cursor.resourceIndex,
      cursor.entryOffset,
      cursor.resourceFirstOrdinal,
      cursor.nextOrdinal,
    ].some((part) => !Number.isSafeInteger(part) || part < 0) ||
    cursor.resourceFirstOrdinal > cursor.nextOrdinal
  )
    fail();
  return cursor;
}

/**
 * Build one bounded page of a trusted physical SQLite inventory. A response can be lost after the
 * Admin D1 append; the same outer cursor then replays the exact descriptor or table-plan page.
 * The inventory is sealed only after every resolved resource has been completely assessed.
 */
export async function runTenantBackupSqliteExportPlanStep(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupExecutionInventory;
  selection: TenantBackupSelection;
  resources: readonly TenantBackupSqlitePlanResource[];
  assertSources(): Promise<void>;
}): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'prepare' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    !input.resources.length ||
    input.resources.length > 70
  )
    fail();
  const resources = [...input.resources].sort((left, right) =>
    left.descriptor.id.localeCompare(right.descriptor.id)
  );
  if (
    new Set(resources.map((resource) => resource.resourceId)).size !== resources.length ||
    new Set(resources.map((resource) => resource.descriptor.id)).size !== resources.length ||
    resources.some(
      (resource) =>
        !/^[A-Za-z0-9_-]{1,128}$/.test(resource.resourceId) ||
        !/^(database|fixed-database):[A-Za-z0-9_-]{1,128}$/.test(resource.descriptor.id)
    )
  )
    fail();
  await input.assertSources();
  const resourceSetDigest = await digestResources(resources);
  const cursor = parseCursor(operation.cursor_json, resourceSetDigest);
  if (
    cursor.descriptorIndex > resources.length ||
    cursor.resourceIndex > resources.length ||
    (cursor.descriptorIndex < resources.length &&
      (cursor.resourceIndex !== 0 || cursor.entryOffset !== 0)) ||
    (cursor.descriptorIndex === resources.length &&
      cursor.resourceIndex === 0 &&
      cursor.entryOffset === 0 &&
      cursor.resourceFirstOrdinal !== resources.length)
  )
    fail();
  await input.inventory.create();
  if (cursor.descriptorIndex < resources.length) {
    const descriptor = resources[cursor.descriptorIndex].descriptor;
    await input.inventory.append(cursor.nextOrdinal, descriptor.id, descriptor.payload);
    cursor.descriptorIndex++;
    cursor.nextOrdinal++;
    if (cursor.descriptorIndex === resources.length)
      cursor.resourceFirstOrdinal = cursor.nextOrdinal;
  } else if (cursor.resourceIndex < resources.length) {
    const resource = resources[cursor.resourceIndex];
    const tables = await readBackupSqliteDatabaseSchema(resource.database, resource.family, signal);
    const page = await persistSqliteTenantDatasetPlanPage(
      {
        inventory: input.inventory,
        family: resource.family,
        resourceId: resource.resourceId,
        firstOrdinal: cursor.resourceFirstOrdinal,
        tables,
        selection: input.selection,
      },
      cursor.entryOffset
    );
    cursor.entryOffset = page.nextEntryOffset;
    cursor.nextOrdinal = page.nextOrdinal;
    if (page.complete) {
      cursor.resourceIndex++;
      cursor.entryOffset = 0;
      cursor.resourceFirstOrdinal = cursor.nextOrdinal;
    }
  }
  signal.throwIfAborted();
  await input.assertSources();
  const head = await input.inventory.headForLease(lease);
  if (head.item_count !== cursor.nextOrdinal) fail();
  if (cursor.descriptorIndex === resources.length && cursor.resourceIndex === resources.length) {
    await input.inventory.seal(head.item_count, head.chain_digest);
    return { phase: 'discover_sqlite_resources', cursor: null, disposition: 'continue' };
  }
  const serialized = JSON.stringify(cursor);
  if (new TextEncoder().encode(serialized).length > 4096) fail();
  return { phase: 'prepare', cursor: serialized, disposition: 'continue' };
}

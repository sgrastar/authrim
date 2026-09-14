import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import type { TenantPortableDataset } from './module-contract';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import { sqliteCapturePlan } from './sqlite-capture-plan';
import type { CaptureSchema } from './sqlite-snapshot';

type Inventory = Pick<TenantBackupExecutionInventory, 'headForLease' | 'readPage'>;
export interface InstalledSqliteDatasetRegistration {
  family: MigrationSchemaFamily;
  table: string;
  dataset: TenantPortableDataset;
}

export interface PlannedInstalledSqliteDataset {
  ordinal: number;
  firstOrdinal: number;
  resourceId: string;
  family: MigrationSchemaFamily;
  table: string;
  capture: CaptureSchema;
  dataset: TenantPortableDataset;
}

const families = ['core', 'pii', 'admin', 'control', 'lookup', 'plugin_runner'];

function fail(): never {
  throw new Error('backup_installed_sqlite_dataset_invalid');
}

/**
 * Join every captured SQL table in the sealed physical plan to server-installed module metadata.
 * A selected table without a registration fails the whole adapter instead of producing a partial
 * bundle. Unselected plan entries are retained only to derive each resource's first ordinal.
 */
export async function resolveInstalledSqliteDatasets(input: {
  inventory: Inventory;
  lease: Parameters<Inventory['headForLease']>[0];
  registrations: readonly InstalledSqliteDatasetRegistration[];
}): Promise<PlannedInstalledSqliteDataset[]> {
  const registrations = input.registrations.map((registration) => structuredClone(registration));
  if (
    !registrations.length ||
    registrations.length > 4096 ||
    new Set(registrations.map((registration) => `${registration.family}:${registration.table}`))
      .size !== registrations.length ||
    new Set(registrations.map((registration) => registration.dataset.id)).size !==
      registrations.length ||
    registrations.some(
      ({ family, table, dataset }) =>
        !families.includes(family) ||
        !/^[a-z][a-z0-9_]*$/.test(table) ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(dataset.id) ||
        dataset.store !== 'database' ||
        dataset.disposition !== 'include'
    )
  )
    fail();
  const byTable = new Map(
    registrations.map((registration) => [
      `${registration.family}:${registration.table}`,
      registration,
    ])
  );
  const head = await input.inventory.headForLease(input.lease);
  if (head.state !== 'sealed') fail();
  const firstOrdinals = new Map<string, number>();
  const planned: PlannedInstalledSqliteDataset[] = [];
  for (let from = 0; from < head.item_count; from += 16) {
    const page = await input.inventory.readPage(from);
    if (!page.length && from < head.item_count) fail();
    for (const item of page) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(item.payload_json) as Record<string, unknown>;
      } catch {
        fail();
      }
      if (!('table' in value) && !('capture' in value) && !('schemaDigest' in value)) continue;
      if (
        value.version !== 1 ||
        typeof value.resourceId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.resourceId) ||
        typeof value.family !== 'string' ||
        !families.includes(value.family) ||
        typeof value.table !== 'string' ||
        !/^[a-z][a-z0-9_]*$/.test(value.table) ||
        item.item_id !== `${value.resourceId}:${value.table}` ||
        typeof value.kind !== 'string' ||
        typeof value.schemaDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.schemaDigest) ||
        !('selection' in value) ||
        !('capture' in value)
      )
        fail();
      const family = value.family as MigrationSchemaFamily;
      const firstOrdinal = firstOrdinals.get(value.resourceId) ?? item.ordinal;
      firstOrdinals.set(value.resourceId, firstOrdinal);
      if (value.capture === null) continue;
      if (typeof value.capture !== 'object' || Array.isArray(value.capture)) fail();
      let capture: CaptureSchema;
      try {
        capture = sqliteCapturePlan([value.capture as CaptureSchema]).schemas[0];
      } catch {
        fail();
      }
      if (!capture || capture.table !== value.table) fail();
      const registration = byTable.get(`${family}:${value.table}`);
      if (!registration || registration.dataset.kind !== value.kind) fail();
      planned.push({
        ordinal: item.ordinal,
        firstOrdinal,
        resourceId: value.resourceId,
        family,
        table: value.table,
        capture,
        dataset: registration.dataset,
      });
    }
  }
  if (!planned.length || new Set(planned.map((entry) => entry.dataset.id)).size !== planned.length)
    fail();
  await input.inventory.headForLease(input.lease);
  return planned;
}

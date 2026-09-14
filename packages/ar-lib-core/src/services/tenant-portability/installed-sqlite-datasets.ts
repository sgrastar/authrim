import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import type { TenantPortableDataset } from './module-contract';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import { sqliteCapturePlan } from './sqlite-capture-plan';
import { tenantDatasetSelectionRule, type TenantBackupSelection } from './selection-contract';
import type { CaptureSchema } from './sqlite-snapshot';

type Inventory = Pick<TenantBackupExecutionInventory, 'headForLease' | 'readPage'>;
export interface InstalledSqliteDatasetRegistration {
  family: MigrationSchemaFamily;
  table: string;
  dataset: TenantPortableDataset;
  /** Exact trusted row-partition values when one physical table backs multiple datasets. */
  partitions?: readonly string[];
}

export interface PlannedInstalledSqliteDataset {
  ordinal: number;
  firstOrdinal: number;
  resourceId: string;
  family: MigrationSchemaFamily;
  table: string;
  capture: CaptureSchema;
  dataset: TenantPortableDataset;
  partitions?: readonly string[];
}

const families = ['core', 'pii', 'admin', 'control', 'lookup', 'plugin_runner'];

function fail(): never {
  throw new Error('backup_installed_sqlite_dataset_invalid');
}

/** Select installed logical datasets from the persisted operator categories. */
export function selectInstalledSqliteDatasets(
  registrations: readonly InstalledSqliteDatasetRegistration[],
  selection: TenantBackupSelection
): TenantPortableDataset[] {
  const selected = registrations
    .filter((registration) => {
      const rule = tenantDatasetSelectionRule(registration.dataset.kind, selection);
      return rule.action === 'selected' || rule.action === 'resolve_references';
    })
    .map((registration) => structuredClone(registration.dataset));
  if (!selected.length || new Set(selected.map((dataset) => dataset.id)).size !== selected.length)
    fail();
  return selected;
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
    new Set(registrations.map((registration) => registration.dataset.id)).size !==
      registrations.length ||
    registrations.some(
      (registration) =>
        !families.includes(registration.family) ||
        !/^[a-z][a-z0-9_]*$/.test(registration.table) ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(registration.dataset.id) ||
        registration.dataset.store !== 'database' ||
        registration.dataset.disposition !== 'include' ||
        (registration.partitions !== undefined &&
          (!registration.partitions.length ||
            new Set(registration.partitions).size !== registration.partitions.length ||
            registration.partitions.some((value) => !/^[A-Za-z0-9_.:-]{1,64}$/.test(value))))
    )
  )
    fail();
  const byTable = new Map<string, InstalledSqliteDatasetRegistration[]>();
  for (const registration of registrations) {
    const key = `${registration.family}:${registration.table}`;
    byTable.set(key, [...(byTable.get(key) ?? []), registration]);
  }
  for (const group of byTable.values()) {
    if (group.length === 1) continue;
    const values = group.flatMap((registration) => registration.partitions ?? []);
    if (
      group.some((registration) => !registration.partitions?.length) ||
      new Set(values).size !== values.length
    )
      fail();
  }
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
      const tableRegistrations = byTable.get(`${family}:${value.table}`) ?? [];
      if (capture.rowPartition) {
        if (!Array.isArray(value.rowPartitions)) fail();
        const rowPartitions = value.rowPartitions as Array<Record<string, unknown>>;
        if (
          rowPartitions.length !== capture.rowPartition.values.length ||
          rowPartitions.some(
            (partition) =>
              !partition ||
              typeof partition !== 'object' ||
              typeof partition.value !== 'string' ||
              typeof partition.kind !== 'string' ||
              !partition.selection ||
              typeof partition.selection !== 'object'
          )
        )
          fail();
        const selected = rowPartitions.filter((partition) =>
          ['selected', 'resolve_references'].includes(
            (partition.selection as Record<string, unknown>).action as string
          )
        );
        const selectedValues = selected.map((partition) => partition.value as string).sort();
        const selectedRegistrations = tableRegistrations.filter((registration) =>
          registration.partitions?.some((partition) => selectedValues.includes(partition))
        );
        const registeredValues = selectedRegistrations
          .flatMap((registration) => registration.partitions ?? [])
          .sort();
        if (
          JSON.stringify(selectedValues) !== JSON.stringify(registeredValues) ||
          selectedRegistrations.some((registration) =>
            registration.partitions?.some((partition) => {
              const plannedPartition = selected.find((entry) => entry.value === partition);
              return plannedPartition?.kind !== registration.dataset.kind;
            })
          )
        )
          fail();
        for (const registration of selectedRegistrations)
          planned.push({
            ordinal: item.ordinal,
            firstOrdinal,
            resourceId: value.resourceId,
            family,
            table: value.table,
            capture,
            dataset: registration.dataset,
            partitions: [...(registration.partitions ?? [])],
          });
      } else {
        if ('rowPartitions' in value) fail();
        if (tableRegistrations.length !== 1 || tableRegistrations[0].partitions) fail();
        const registration = tableRegistrations[0];
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
  }
  if (!planned.length || new Set(planned.map((entry) => entry.dataset.id)).size !== planned.length)
    fail();
  await input.inventory.headForLease(input.lease);
  return planned;
}

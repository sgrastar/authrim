import { readBackupSqliteDatabaseSchema } from './sqlite-schema-reader';
import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import {
  TENANT_DATASET_POLICIES,
  TENANT_DATASET_ROW_PARTITIONS,
  type TenantDatasetKind,
} from './dataset-registry';
import { TENANT_BACKUP_OWNERSHIP_RULES } from './ownership-registry';
import type { BackupRowOwnership } from './row-ownership';
import {
  parseTenantBackupSelection,
  tenantDatasetSelectionRule,
  type TenantBackupSelection,
  type TenantDatasetSelectionRule,
} from './selection-contract';
import { sqliteCapturePlan } from './sqlite-capture-plan';
import { assessSqliteCaptureStructure } from './sqlite-schema-assessment';
import type { BackupSchemaTable } from './sqlite-schema-types';
import type { CaptureSchema } from './sqlite-snapshot';

export interface SqliteDatasetPlanEntry {
  table: string;
  kind: TenantDatasetKind;
  selection: TenantDatasetSelectionRule;
  capture: CaptureSchema | null;
  concerns: string[];
  rowPartitions?: readonly {
    value: string;
    kind: Extract<TenantDatasetKind, 'settings' | 'users' | 'admin'>;
    selection: TenantDatasetSelectionRule;
  }[];
}

/**
 * Resolve trusted deployed schemas against installed classification/ownership rules.
 * This is an input to the module planner, not export authorization. Log-window,
 * secret/field policies and dependency selection remain module responsibilities.
 * Missing support is explicit; consumers must never export only the successful entries.
 */
export function planSqliteTenantDatasets(
  family: MigrationSchemaFamily,
  tables: readonly BackupSchemaTable[],
  requestedSelection: TenantBackupSelection
): { entries: SqliteDatasetPlanEntry[]; captureSchemas: CaptureSchema[] } {
  const selection = parseTenantBackupSelection(requestedSelection);
  const byName = new Map(tables.map((table) => [table.name, table]));
  if (byName.size !== tables.length) throw new Error('backup_plan_duplicate_table');
  function ownership(table: BackupSchemaTable): BackupRowOwnership {
    const matches = TENANT_BACKUP_OWNERSHIP_RULES.filter(
      (rule) => rule.family === family && rule.table === table.name
    );
    if (matches.length > 1) throw new Error('backup_plan_duplicate_ownership');
    if (matches.length === 1) return matches[0].ownership;
    // Direct tenant_id is the reviewed default only within the classified registry.
    if (table.columns.some((column) => column.name === 'tenant_id' && !column.generated))
      return { kind: 'tenant', column: 'tenant_id', identity: 'tenantId' };
    throw new Error('backup_plan_ownership_unresolved');
  }
  function classification(name: string) {
    const policies = TENANT_DATASET_POLICIES.filter(
      (policy) => policy.family === family && policy.table === name
    );
    if (policies.length !== 1) throw new Error('backup_plan_unclassified_table');
    return policies[0];
  }
  function rowPartition(table: BackupSchemaTable) {
    const matches = TENANT_DATASET_ROW_PARTITIONS.filter(
      (entry) => entry.family === family && entry.table === table.name
    );
    if (matches.length > 1) throw new Error('backup_plan_duplicate_row_partition');
    const partition = matches[0];
    if (!partition) return undefined;
    if (
      !table.columns.some((column) => column.name === partition.column && !column.generated) ||
      partition.values.length < 2 ||
      new Set(partition.values.map((entry) => entry.value)).size !== partition.values.length
    )
      throw new Error('backup_plan_invalid_row_partition');
    return partition;
  }
  function capture(
    table: BackupSchemaTable,
    rule: BackupRowOwnership,
    partition = rowPartition(table)
  ): CaptureSchema {
    const structure = assessSqliteCaptureStructure(table);
    if (!structure.schema) throw new Error(`backup_plan_structure:${structure.concerns.join(',')}`);
    if (rule.kind === 'tenant') {
      if (!table.columns.some((column) => column.name === rule.column && !column.generated))
        throw new Error('backup_plan_ownership_column_missing');
      return {
        ...structure.schema,
        tenantColumn: rule.column,
        ...(rule.identity === 'tenantKey' ? { tenantIdentity: 'tenantKey' as const } : {}),
        ...(partition
          ? {
              rowPartition: {
                column: partition.column,
                values: partition.values.map((entry) => entry.value),
              },
            }
          : {}),
      };
    }
    if (rule.kind === 'scope') {
      if (
        ![rule.typeColumn, rule.idColumn].every((name) =>
          table.columns.some((column) => column.name === name && !column.generated)
        )
      )
        throw new Error('backup_plan_ownership_column_missing');
      return {
        ...structure.schema,
        tenantColumn: rule.idColumn,
        scopeTypeColumn: rule.typeColumn,
        ...(partition
          ? {
              rowPartition: {
                column: partition.column,
                values: partition.values.map((entry) => entry.value),
              },
            }
          : {}),
      };
    }
    const parent = byName.get(rule.table);
    if (!parent) throw new Error('backup_plan_parent_missing');
    classification(parent.name);
    if (rule.ownership.kind === 'parent') throw new Error('backup_plan_parent_adapter_required');
    const parentSchema = capture(parent, rule.ownership);
    if ('parent' in parentSchema) throw new Error('backup_plan_parent_adapter_required');
    if (
      rule.keys.length !== parentSchema.primaryKey.length ||
      new Set(rule.keys.map((key) => key.parent)).size !== rule.keys.length ||
      new Set(rule.keys.map((key) => key.child)).size !== rule.keys.length ||
      rule.keys.some(
        (key) => !table.columns.some((column) => column.name === key.child && !column.generated)
      ) ||
      parentSchema.primaryKey.some((column) => !rule.keys.some((key) => key.parent === column))
    )
      throw new Error('backup_plan_parent_key_mismatch');
    return {
      ...structure.schema,
      parent: {
        schema: parentSchema,
        childColumns: parentSchema.primaryKey.map((column) => {
          const key = rule.keys.find((candidate) => candidate.parent === column);
          if (!key) throw new Error('backup_plan_parent_key_mismatch');
          return key.child;
        }),
      },
    };
  }
  const entries = [...tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((table): SqliteDatasetPlanEntry => {
      const policy = classification(table.name);
      const partition = rowPartition(table);
      const rowPartitions = partition?.values.map((entry) => ({
        ...entry,
        selection: tenantDatasetSelectionRule(entry.kind, selection),
      }));
      const partitionSelected = rowPartitions?.some(
        (entry) =>
          entry.selection.action === 'selected' || entry.selection.action === 'resolve_references'
      );
      const rule = partitionSelected
        ? ({ action: 'selected', timeFilter: 'none' } as const)
        : partition
          ? ({ action: 'excluded', reason: 'not_selected' } as const)
          : tenantDatasetSelectionRule(policy.kind, selection);
      const entry: SqliteDatasetPlanEntry = {
        table: table.name,
        kind: policy.kind,
        selection: rule,
        capture: null,
        concerns: [],
        ...(rowPartitions ? { rowPartitions } : {}),
      };
      if (rule.action !== 'selected' && rule.action !== 'resolve_references') return entry;
      try {
        entry.capture = capture(table, ownership(table), partition);
        // Validate graph/identifier/SQL size using the actual trigger compiler.
        sqliteCapturePlan([entry.capture]);
      } catch (error) {
        entry.capture = null;
        entry.concerns.push(
          error instanceof Error && /^(backup_plan_|snapshot_|migration_sql_)/.test(error.message)
            ? error.message
            : 'backup_plan_capture_unsupported'
        );
      }
      return entry;
    });
  const selected = entries.flatMap((entry) => (entry.capture ? [entry.capture] : []));
  // No partial executable plan when a required adapter is unresolved.
  const captureSchemas =
    entries.some((entry) => entry.concerns.length) || !selected.length
      ? []
      : sqliteCapturePlan(selected).schemas;
  return { entries, captureSchemas };
}

/** Exact deployed schema fingerprint, including defaults, foreign keys and all indexes. */
export async function sqliteBackupSchemaDigest(table: BackupSchemaTable): Promise<string> {
  const json = JSON.stringify({
    name: table.name,
    sql: table.sql,
    strict: table.strict,
    withoutRowid: table.withoutRowid,
    columns: table.columns,
    // Capture triggers are installed after planning and separately checked by atomic start.
    triggers: [...(table.triggers ?? [])]
      .filter(
        (trigger) =>
          !['insert', 'update', 'delete'].some(
            (kind) => trigger.name === `tenant_backup_${table.name}_${kind}`
          )
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: [...table.foreignKeys].sort((a, b) => a.id - b.id || a.position - b.position),
    indexes: [...table.indexes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((index) => ({
        ...index,
        columns: [...index.columns].sort((a, b) => a.position - b.position),
      })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Persist one authorized physical resource's complete classification/capture plan in stable order. */
export async function persistSqliteTenantDatasetPlan(input: {
  inventory: import('./execution-inventory').TenantBackupExecutionInventory;
  family: MigrationSchemaFamily;
  resourceId: string;
  firstOrdinal: number;
  tables: readonly BackupSchemaTable[];
  selection: TenantBackupSelection;
}): Promise<number> {
  let entryOffset = 0;
  let nextOrdinal = input.firstOrdinal;
  for (;;) {
    const page = await persistSqliteTenantDatasetPlanPage(input, entryOffset);
    entryOffset = page.nextEntryOffset;
    nextOrdinal = page.nextOrdinal;
    if (page.complete) return nextOrdinal;
  }
}

/**
 * Persist at most one inventory page. Product operation handlers use this boundary so a large
 * physical schema cannot turn one scheduler slice into hundreds of Admin D1 writes. The complete
 * plan is assessed before the first append, so unsupported selected tables never leave a partial
 * executable plan that a retry could seal.
 */
export async function persistSqliteTenantDatasetPlanPage(
  input: {
    inventory: import('./execution-inventory').TenantBackupExecutionInventory;
    family: MigrationSchemaFamily;
    resourceId: string;
    firstOrdinal: number;
    tables: readonly BackupSchemaTable[];
    selection: TenantBackupSelection;
  },
  entryOffset: number
): Promise<{ nextEntryOffset: number; nextOrdinal: number; complete: boolean }> {
  if (
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.resourceId) ||
    !Number.isInteger(input.firstOrdinal) ||
    input.firstOrdinal < 0 ||
    !Number.isInteger(entryOffset) ||
    entryOffset < 0
  )
    throw new Error('backup_plan_invalid_resource');
  const plan = planSqliteTenantDatasets(input.family, input.tables, input.selection);
  if (plan.entries.some((entry) => entry.concerns.length))
    throw new Error('backup_plan_adapters_unresolved');
  if (input.firstOrdinal + plan.entries.length > 4096 || entryOffset > plan.entries.length)
    throw new Error('backup_plan_inventory_limit');
  const entries = plan.entries.slice(entryOffset, entryOffset + 100);
  if (entries.length)
    await input.inventory.appendBatch(
      await Promise.all(
        entries.map(async (entry, offset) => ({
          ordinal: input.firstOrdinal + entryOffset + offset,
          itemId: `${input.resourceId}:${entry.table}`,
          // Only installed metadata; no credentials, row bodies, bindings or uploaded SQL.
          payloadJson: await sqlitePlanPayload(input, entry),
        }))
      )
    );
  const nextEntryOffset = entryOffset + entries.length;
  return {
    nextEntryOffset,
    nextOrdinal: input.firstOrdinal + nextEntryOffset,
    complete: nextEntryOffset === plan.entries.length,
  };
}

async function sqlitePlanPayload(
  input: {
    resourceId: string;
    family: MigrationSchemaFamily;
    tables: readonly BackupSchemaTable[];
  },
  entry: SqliteDatasetPlanEntry
): Promise<string> {
  const schema = input.tables.find((table) => table.name === entry.table);
  if (!schema) throw new Error('backup_plan_schema_missing');
  return JSON.stringify({
    version: 1,
    resourceId: input.resourceId,
    family: input.family,
    table: entry.table,
    kind: entry.kind,
    selection: entry.selection,
    ...(entry.rowPartitions ? { rowPartitions: entry.rowPartitions } : {}),
    capture: entry.capture,
    schemaDigest: await sqliteBackupSchemaDigest(schema),
  });
}

/**
 * Reconcile a sealed inventory with a COMPLETE, freshly inspected physical schema.
 * The caller resolves/authorizes the resource and keeps DDL fenced after inspection.
 * Nothing is returned for execution until every saved entry and schema fingerprint matches.
 */
export async function verifyPersistedSqliteTenantDatasetPlan(input: {
  inventory: import('./execution-inventory').TenantBackupExecutionInventory;
  family: MigrationSchemaFamily;
  resourceId: string;
  firstOrdinal: number;
  tables: readonly BackupSchemaTable[];
  selection: TenantBackupSelection;
}): Promise<CaptureSchema[]> {
  if (
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.resourceId) ||
    !Number.isInteger(input.firstOrdinal) ||
    input.firstOrdinal < 0 ||
    !input.tables.length
  )
    throw new Error('backup_plan_invalid_resource');
  const plan = planSqliteTenantDatasets(input.family, input.tables, input.selection);
  if (plan.entries.some((entry) => entry.concerns.length))
    throw new Error('backup_plan_adapters_unresolved');
  const head = await input.inventory.head();
  if (head.state !== 'sealed') throw new Error('backup_inventory_not_sealed');
  if (input.firstOrdinal + plan.entries.length > head.item_count)
    throw new Error('backup_plan_inventory_changed');
  if (input.firstOrdinal > 0) {
    const previous = (await input.inventory.readPage(input.firstOrdinal - 1))[0];
    if (
      previous &&
      previous.item_id.slice(0, previous.item_id.lastIndexOf(':')) === input.resourceId
    )
      throw new Error('backup_plan_inventory_changed');
  }
  for (let offset = 0; offset < plan.entries.length; offset += 16) {
    const page = await input.inventory.readPage(input.firstOrdinal + offset);
    for (const [index, entry] of plan.entries.slice(offset, offset + 16).entries()) {
      const stored = page[index];
      if (
        !stored ||
        stored.item_id !== `${input.resourceId}:${entry.table}` ||
        stored.payload_json !== (await sqlitePlanPayload(input, entry))
      )
        throw new Error('backup_plan_inventory_changed');
    }
  }
  const next = input.firstOrdinal + plan.entries.length;
  if (next < head.item_count) {
    const following = (await input.inventory.readPage(next))[0];
    if (
      following &&
      following.item_id.slice(0, following.item_id.lastIndexOf(':')) === input.resourceId
    )
      throw new Error('backup_plan_inventory_changed');
  }
  await input.inventory.head();
  return plan.captureSchemas;
}

/**
 * Load the capture program from the sealed inventory after a resource was verified live during
 * preparation. Callers must pair this with the preparation-time schema digest and recheck that
 * digest immediately before starting the snapshot.
 */
export async function readPersistedSqliteCaptureSchemas(input: {
  inventory: import('./execution-inventory').TenantBackupExecutionInventory;
  lease: import('./operation-store').TenantBackupLease;
  family: MigrationSchemaFamily;
  resourceId: string;
  firstOrdinal: number;
  tableCount: number;
  captureCount: number;
}): Promise<CaptureSchema[]> {
  if (
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.resourceId) ||
    !Number.isSafeInteger(input.firstOrdinal) ||
    input.firstOrdinal < 0 ||
    !Number.isSafeInteger(input.tableCount) ||
    input.tableCount < 1 ||
    !Number.isSafeInteger(input.captureCount) ||
    input.captureCount < 1 ||
    input.captureCount > input.tableCount
  )
    throw new Error('backup_plan_invalid_resource');
  const head = await input.inventory.headForLease(input.lease);
  if (head.state !== 'sealed' || input.firstOrdinal + input.tableCount > head.item_count)
    throw new Error('backup_plan_inventory_changed');
  const captures: CaptureSchema[] = [];
  let ordinal = input.firstOrdinal;
  const end = input.firstOrdinal + input.tableCount;
  while (ordinal < end) {
    const page = await input.inventory.readPage(ordinal);
    const bounded = page.slice(0, end - ordinal);
    if (!bounded.length) throw new Error('backup_plan_inventory_changed');
    for (const item of bounded) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(item.payload_json) as Record<string, unknown>;
      } catch {
        throw new Error('backup_plan_inventory_changed');
      }
      if (
        value.version !== 1 ||
        value.resourceId !== input.resourceId ||
        value.family !== input.family ||
        typeof value.table !== 'string' ||
        !/^[a-z][a-z0-9_]*$/.test(value.table) ||
        item.item_id !== `${input.resourceId}:${value.table}` ||
        typeof value.schemaDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.schemaDigest) ||
        !('selection' in value) ||
        !('capture' in value)
      )
        throw new Error('backup_plan_inventory_changed');
      if (value.capture === null) continue;
      if (typeof value.capture !== 'object' || Array.isArray(value.capture))
        throw new Error('backup_plan_inventory_changed');
      let capture: CaptureSchema | undefined;
      try {
        capture = sqliteCapturePlan([value.capture as CaptureSchema]).schemas.find(
          (schema) => schema.table === value.table
        );
      } catch {
        throw new Error('backup_plan_inventory_changed');
      }
      if (!capture) throw new Error('backup_plan_inventory_changed');
      captures.push(capture);
    }
    ordinal += bounded.length;
  }
  if (captures.length !== input.captureCount) throw new Error('backup_plan_inventory_changed');
  const schemas = sqliteCapturePlan(captures).schemas;
  await input.inventory.headForLease(input.lease);
  return schemas;
}

/** Read the authorized physical DB afresh and reconcile it against the sealed operation plan. */
export async function verifyLiveSqliteTenantDatasetPlan(input: {
  inventory: import('./execution-inventory').TenantBackupExecutionInventory;
  database: Pick<import('../../db/adapter').DatabaseAdapter, 'query' | 'queryOne'>;
  family: MigrationSchemaFamily;
  resourceId: string;
  firstOrdinal: number;
  selection: TenantBackupSelection;
  signal: AbortSignal;
}): Promise<CaptureSchema[]> {
  const tables = await readBackupSqliteDatabaseSchema(input.database, input.family, input.signal);
  const schemas = await verifyPersistedSqliteTenantDatasetPlan({ ...input, tables });
  input.signal.throwIfAborted();
  return schemas;
}

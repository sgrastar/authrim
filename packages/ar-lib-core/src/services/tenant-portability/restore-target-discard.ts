import type { DatabaseAdapter } from '../../db/adapter';
import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract.js';
import type { TenantDatasetKind } from './dataset-registry';
import {
  backupOwnershipPredicate,
  type BackupRowOwnership,
  type BackupTenantIdentity,
} from './row-ownership';
import type { CaptureSchema } from './sqlite-snapshot';
import type { BackupSchemaTable } from './sqlite-schema-types';
import { BACKUP_SQLITE_SCHEMA_DEFINITIONS_SQL } from './sqlite-schema-reader';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;

/**
 * Dataset kinds a discarded restore keeps. The restoring environment appends its own rows to
 * these (the import's request, approval and cancellation audit among them), so they cannot be
 * told apart from restored rows and stay, like the restore itself treats them.
 */
export const TENANT_DISCARD_RETAINED_KINDS: ReadonlySet<TenantDatasetKind> = new Set([
  'audit',
  'history',
  'sensitive_logs',
  'delivery_state',
  'log_dependencies',
  // The object catalog indexes the stored bodies of externalized audit details; deleting it
  // would leave the kept audit rows unreadable.
  'artifacts',
]);

/**
 * Reference-only datasets the restore never writes but its own triggers fill (dynamic group
 * inputs). They are derived from the tenant's rows, so a discard deletes them.
 */
export const TENANT_DISCARD_DERIVED_REFERENCE_DATASETS: ReadonlySet<string> = new Set([
  'core.service_group_inputs',
  'pii.service_group_inputs',
]);

/**
 * Installed datasets a discard never deletes. The tenant row stays and is marked deleted; the
 * plugin metadata ledger cannot be deleted (a trigger forbids it) and its audit refers to it.
 */
export const TENANT_DISCARD_PROTECTED_DATASETS: ReadonlySet<string> = new Set([
  'core.tenants',
  'core.plugin_account_metadata_mutations',
]);

const byTenantId: BackupRowOwnership = {
  kind: 'tenant',
  column: 'tenant_id',
  identity: 'tenantId',
};

/**
 * Every core and PII table outside the installed SQL datasets: either the trusted owner of its
 * tenant rows, which a discard deletes, or `null` for migration, placement, backup and shared
 * rows it must leave alone. A table missing here stops planning, so a new table is reviewed.
 */
export const TENANT_DISCARD_UNPLANNED_TABLES: Readonly<
  Partial<Record<MigrationSchemaFamily, Readonly<Record<string, BackupRowOwnership | null>>>>
> = {
  core: {
    authrim_migrations: null,
    migration_metadata: null,
    tenant_database_migration_state: null,
    authrim_control_plane_shard_metadata: null,
    refresh_token_shard_configs: null,
    tenant_database_probe_results: null,
    tenant_placement_migration_captures: null,
    tenant_placement_migration_outbox: null,
    did_document_cache: null,
    directory_auth_release_advisories: null,
    profile_registry: null,
    tenant_backup_restore_targets: null,
    tenant_backup_snapshots: null,
    tenant_backup_preimages: null,
    authrim_runtime_probes: null,
    account_routing_outbox: byTenantId,
    contact_point_search_indexes: byTenantId,
    identity_binding_lookup_indexes: byTenantId,
    legal_hold_projection_outbox: byTenantId,
    lookup_retention_policy_projection_outbox: byTenantId,
    relationship_closure: byTenantId,
    service_group_catalog: byTenantId,
    service_group_epoch: byTenantId,
    service_group_results: byTenantId,
    service_group_revisions: byTenantId,
    service_group_scans: byTenantId,
    ciba_requests: byTenantId,
    credential_offers: byTenantId,
    device_codes: byTenantId,
    external_idp_auth_states: byTenantId,
    flow_interaction_steps: byTenantId,
    flow_interactions: byTenantId,
    password_reset_tokens: byTenantId,
    sessions: byTenantId,
    user_token_families: byTenantId,
    vp_requests: byTenantId,
  },
  pii: {
    authrim_migrations: null,
    migration_metadata: null,
    tenant_database_migration_state: null,
    authrim_control_plane_shard_metadata: null,
    tenant_placement_migration_captures: null,
    tenant_placement_migration_outbox: null,
    tenant_backup_restore_targets: null,
    tenant_backup_snapshots: null,
    tenant_backup_preimages: null,
    authrim_runtime_probes: null,
    identity_identifier_replacement_outbox: byTenantId,
    identity_identifier_replacement_projections: {
      kind: 'parent',
      table: 'identity_identifier_replacement_operations',
      keys: [{ child: 'operation_id', parent: 'operation_id' }],
      ownership: byTenantId,
    },
  },
};

/** One installed SQL dataset of the discarded database, with its trusted restore policy facts. */
export interface TenantDiscardDataset {
  id: string;
  kind: TenantDatasetKind;
  capture: CaptureSchema;
  /** Restore-only identity of a tenantKey-owned dataset (the target tenant key). */
  tenantKey?: string;
  referenceOnly: boolean;
  /** Nullable references the restore completes later; cleared before the rows are deleted. */
  deferredColumns: readonly string[];
}

interface Guard {
  sql: string;
  params: string[];
}

export interface TenantDiscardTable {
  table: string;
  owner: Guard;
  detachColumns: readonly string[];
  /** Rows referenced by a row the tenant does not own stay; deleting them would reach that row. */
  foreignChildren: Guard;
}

export interface TenantDiscardPlan {
  family: MigrationSchemaFamily;
  /** Children before their parents, by foreign key and by ownership. */
  tables: readonly TenantDiscardTable[];
}

const fail = (code = 'backup_import_discard_plan_invalid') => new Error(code);
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw fail();
  return value;
};
const PAGE_ROWS = 50;
const STATEMENT_PARAMETERS = 90;
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw fail();
  return `"${value}"`;
};

function captureOwnership(schema: CaptureSchema): BackupRowOwnership {
  if ('parent' in schema)
    return {
      kind: 'parent',
      table: schema.parent.schema.table,
      keys: schema.parent.schema.primaryKey.map((parent, index) => ({
        parent,
        child: schema.parent.childColumns[index],
      })),
      ownership: captureOwnership(schema.parent.schema),
    };
  return schema.scopeTypeColumn
    ? { kind: 'scope', typeColumn: schema.scopeTypeColumn, idColumn: schema.tenantColumn }
    : {
        kind: 'tenant',
        column: schema.tenantColumn,
        identity: schema.tenantIdentity ?? 'tenantId',
      };
}

function ownershipTables(ownership: BackupRowOwnership): string[] {
  return ownership.kind === 'parent'
    ? [ownership.table, ...ownershipTables(ownership.ownership)]
    : [];
}

function foreignKeys(table: BackupSchemaTable) {
  const grouped = new Map<
    number,
    { parentTable: string; columns: string[]; parentColumns: (string | null)[]; onDelete: string }
  >();
  for (const key of [...table.foreignKeys].sort(
    (left, right) => left.id - right.id || left.position - right.position
  )) {
    const current = grouped.get(key.id) ?? {
      parentTable: key.parentTable,
      columns: [],
      parentColumns: [],
      onDelete: key.onDelete.toUpperCase(),
    };
    current.columns.push(key.column);
    current.parentColumns.push(key.parentColumn);
    grouped.set(key.id, current);
  }
  return [...grouped.values()];
}

function primaryKey(table: BackupSchemaTable): string[] {
  const key = table.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
    .map((column) => column.name);
  if (!key.length) throw fail();
  return key;
}

/**
 * Plan the deletion of one tenant from one database. Only trusted ownership selects rows; the
 * live schema supplies the foreign keys a deletion reaches, so a cascade or SET NULL that would
 * touch a row of another tenant, or of a table without a known owner, leaves that parent row.
 */
export function planTenantDiscard(input: {
  family: MigrationSchemaFamily;
  schema: readonly BackupSchemaTable[];
  datasets: readonly TenantDiscardDataset[];
  identity: BackupTenantIdentity;
}): TenantDiscardPlan {
  const tables = new Map(input.schema.map((table) => [table.name, table]));
  if (tables.size !== input.schema.length) throw fail();
  const owners = new Map<string, { ownership: BackupRowOwnership; tenantKey?: string }>();
  const purge = new Map<
    string,
    { ownership: BackupRowOwnership; tenantKey?: string; detach: Set<string>; planned: boolean }
  >();
  const datasetTables = new Set<string>();
  // Row-partitioned datasets share one table; the discard deletes the tenant's rows of every
  // partition, so one deletable partition makes the whole table deletable.
  for (const dataset of input.datasets) {
    const table = dataset.capture.table;
    if (!tables.has(table)) throw fail();
    const ownership = captureOwnership(dataset.capture);
    const known = owners.get(table);
    if (
      known &&
      (JSON.stringify(known.ownership) !== JSON.stringify(ownership) ||
        known.tenantKey !== dataset.tenantKey)
    )
      throw fail();
    datasetTables.add(table);
    owners.set(table, { ownership, tenantKey: dataset.tenantKey });
    const retained =
      TENANT_DISCARD_RETAINED_KINDS.has(dataset.kind) ||
      TENANT_DISCARD_PROTECTED_DATASETS.has(dataset.id);
    if (retained && purge.has(table)) throw fail();
    if (
      retained ||
      (dataset.referenceOnly && !TENANT_DISCARD_DERIVED_REFERENCE_DATASETS.has(dataset.id))
    )
      continue;
    const current = purge.get(table);
    if (current) for (const column of dataset.deferredColumns) current.detach.add(column);
    else
      purge.set(table, {
        ownership,
        tenantKey: dataset.tenantKey,
        detach: new Set(dataset.deferredColumns),
        planned: true,
      });
  }
  for (const dataset of input.datasets)
    if (
      (TENANT_DISCARD_RETAINED_KINDS.has(dataset.kind) ||
        TENANT_DISCARD_PROTECTED_DATASETS.has(dataset.id)) &&
      purge.has(dataset.capture.table)
    )
      throw fail();
  const unplanned = TENANT_DISCARD_UNPLANNED_TABLES[input.family] ?? {};
  for (const table of tables.keys()) {
    if (datasetTables.has(table)) continue;
    if (!(table in unplanned)) {
      // Admin keeps its platform and backup tables; core and PII must classify every table.
      if (input.family === 'admin') continue;
      throw fail('backup_import_discard_unclassified_table');
    }
    const ownership = unplanned[table];
    if (!ownership) continue;
    owners.set(table, { ownership });
    purge.set(table, { ownership, detach: new Set(), planned: false });
  }

  const ownerGuard = (table: string, alias: string): Guard | null => {
    // A table the discard does not delete from still has an owner when it carries tenant_id
    // (Admin sessions and grants, for example); that is enough to see whose row a cascade reaches.
    const owner =
      owners.get(table) ??
      (tables.get(table)?.columns.some((column) => column.name === 'tenant_id')
        ? { ownership: byTenantId }
        : undefined);
    if (!owner) return null;
    return backupOwnershipPredicate(
      owner.ownership,
      { tenantId: input.identity.tenantId, tenantKey: owner.tenantKey ?? input.identity.tenantKey },
      alias
    );
  };

  // A nullable self reference is cleared first, so rows of one table never wait for each other.
  for (const [table, entry] of purge) {
    const schema = required(tables.get(table));
    for (const key of foreignKeys(schema))
      if (
        key.parentTable === table &&
        key.columns.every(
          (column) =>
            schema.columns.find((candidate) => candidate.name === column)?.notNull === false
        )
      )
        for (const column of key.columns) entry.detach.add(column);
    for (const column of entry.detach)
      if (
        !schema.columns.some((candidate) => candidate.name === column && !candidate.notNull) ||
        primaryKey(schema).includes(column)
      )
        throw fail();
  }

  // Children (by foreign key or by ownership) are deleted before their parents.
  const before = new Map<string, Set<string>>([...purge.keys()].map((table) => [table, new Set()]));
  for (const [table, entry] of purge) {
    for (const parent of ownershipTables(entry.ownership))
      if (purge.has(parent) && parent !== table) required(before.get(parent)).add(table);
    for (const key of foreignKeys(required(tables.get(table)))) {
      if (!purge.has(key.parentTable) || key.parentTable === table) continue;
      if (key.columns.every((column) => entry.detach.has(column))) continue;
      required(before.get(key.parentTable)).add(table);
    }
  }
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (table: string) => {
    const current = state.get(table);
    if (current === 'done') return;
    if (current === 'visiting') throw fail('backup_import_discard_plan_cycle');
    state.set(table, 'visiting');
    for (const child of [...required(before.get(table))].sort()) visit(child);
    state.set(table, 'done');
    ordered.push(table);
  };
  // Installed datasets first and derived tables last: deleting datasets refills derived rows.
  const roots = [...purge.keys()].sort(
    (left, right) =>
      Number(!required(purge.get(left)).planned) - Number(!required(purge.get(right)).planned) ||
      left.localeCompare(right)
  );
  for (const table of roots) visit(table);

  // Who references a table, and what deleting its row does to the referencing row.
  const referencing = new Map<
    string,
    { child: string; columns: string[]; parentColumns: string[]; onDelete: string }[]
  >();
  for (const schema of tables.values())
    for (const key of foreignKeys(schema)) {
      const parent = tables.get(key.parentTable);
      if (!parent) continue;
      const parentKey = primaryKey(parent);
      const parentColumns = key.parentColumns.map(
        (column, index) => column ?? parentKey[index] ?? ''
      );
      if (parentColumns.some((column) => !column) || parentColumns.length !== key.columns.length)
        throw fail();
      const list = referencing.get(key.parentTable) ?? [];
      list.push({
        child: schema.name,
        columns: key.columns,
        parentColumns,
        onDelete: key.onDelete,
      });
      referencing.set(key.parentTable, list);
    }

  let aliasCounter = 0;
  const foreignReach = (table: string, alias: string, depth: number): Guard => {
    if (depth > 4) throw fail('backup_import_discard_cascade_too_deep');
    const parts: Guard[] = [];
    for (const edge of referencing.get(table) ?? []) {
      // RESTRICT and NO ACTION make the delete itself fail, which stops the discard.
      if (!['CASCADE', 'SET NULL', 'SET DEFAULT'].includes(edge.onDelete)) continue;
      const child = `discard_child_${aliasCounter++}`;
      const join = edge.columns
        .map(
          (column, index) =>
            `${identifier(child)}.${identifier(column)} = ${identifier(alias)}.${identifier(edge.parentColumns[index])}`
        )
        .join(' AND ');
      const owned = ownerGuard(edge.child, child);
      // NULL ownership counts as foreign, like a table whose owner is unknown.
      const foreign: Guard = owned
        ? { sql: `CASE WHEN ${owned.sql} THEN 0 ELSE 1 END = 1`, params: owned.params }
        : { sql: '1', params: [] };
      // A cascade deletes the child too, so whatever reaches out from the child counts as well.
      const deeper =
        edge.onDelete === 'CASCADE' ? foreignReach(edge.child, child, depth + 1) : null;
      const condition =
        deeper && deeper.sql !== '0' ? `(${foreign.sql}) OR (${deeper.sql})` : foreign.sql;
      parts.push({
        sql: `EXISTS (SELECT 1 FROM ${identifier(edge.child)} AS ${identifier(child)} WHERE ${join} AND (${condition}))`,
        params: [...foreign.params, ...(deeper && deeper.sql !== '0' ? deeper.params : [])],
      });
    }
    if (!parts.length) return { sql: '0', params: [] };
    return {
      sql: parts.map(({ sql }) => `(${sql})`).join(' OR '),
      params: parts.flatMap(({ params }) => params),
    };
  };

  return {
    family: input.family,
    tables: ordered.map((table) => {
      const owner = ownerGuard(table, 'backup_row');
      if (!owner) throw fail();
      const foreignChildren = foreignReach(table, 'backup_row', 0);
      // D1 binds at most 100 parameters per statement; the delete carries both guards.
      if (owner.params.length + foreignChildren.params.length > STATEMENT_PARAMETERS)
        throw fail('backup_import_discard_statement_too_wide');
      return {
        table,
        owner,
        detachColumns: [...required(purge.get(table)).detach].sort(),
        foreignChildren,
      };
    }),
  };
}

const EXISTS_PARAMETERS = 90;

/** Index of the first table that still holds rows of the tenant, or -1. */
async function firstRemaining(database: Database, plan: TenantDiscardPlan): Promise<number> {
  for (let offset = 0; offset < plan.tables.length; ) {
    const group: { index: number; sql: string; params: string[] }[] = [];
    let parameters = 0;
    while (
      offset < plan.tables.length &&
      (!group.length ||
        parameters + plan.tables[offset].owner.params.length <= EXISTS_PARAMETERS) &&
      group.length < 16
    ) {
      const table = plan.tables[offset];
      group.push({
        index: offset,
        sql: `SELECT ${offset} AS position WHERE EXISTS (SELECT 1 FROM ${identifier(table.table)} AS backup_row WHERE ${table.owner.sql})`,
        params: table.owner.params,
      });
      parameters += table.owner.params.length;
      offset++;
    }
    const row = await database.queryOne<{ position: number }>(
      `SELECT position FROM (${group.map(({ sql }) => sql).join(' UNION ALL ')}) ORDER BY position LIMIT 1`,
      group.flatMap(({ params }) => params)
    );
    if (row) return Number(row.position);
  }
  return -1;
}

async function remainingRows(database: Database, table: TenantDiscardTable): Promise<number> {
  const row = await database.queryOne<{ total: number }>(
    `SELECT count(*) AS total FROM ${identifier(table.table)} AS backup_row WHERE ${table.owner.sql}`,
    table.owner.params
  );
  return Number(row?.total ?? 0);
}

export type TenantDiscardPageResult =
  | { done: true }
  | { done: false }
  | { done: false; blocked: { table: string; reason: 'foreign_reference' | 'restricted' } };

const RESTRICTED =
  /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY|legal_hold|immutable/i;

/**
 * Delete one bounded slice of the tenant's rows. Stateless: the first table that still holds rows
 * is worked on, so an interrupted or repeated call resumes where the data says it stands.
 * `authorize` must prove the caller's cleanup lease before every write.
 */
export async function runTenantDiscardPage(input: {
  database: Database;
  plan: TenantDiscardPlan;
  authorize: () => Promise<void>;
  signal: AbortSignal;
  statements?: number;
  /**
   * The schema definitions the plan was checked against (readBackupSqliteSchemaDefinitions).
   * Every write compares them inside the statement, so DDL that lands after the check (a new
   * cascade, say) makes the write change nothing instead of reaching rows the plan never saw.
   */
  schemaDefinitions?: string;
}): Promise<TenantDiscardPageResult> {
  let budget = input.statements ?? 8;
  const schema =
    input.schemaDefinitions === undefined
      ? { sql: '', params: [] as string[] }
      : {
          sql: ` AND ${BACKUP_SQLITE_SCHEMA_DEFINITIONS_SQL} = ?`,
          params: [input.schemaDefinitions],
        };
  while (budget > 0) {
    input.signal.throwIfAborted();
    const index = await firstRemaining(input.database, input.plan);
    if (index < 0) return { done: true };
    const table = input.plan.tables[index];
    const name = identifier(table.table);
    if (table.detachColumns.length) {
      const attached = table.detachColumns
        .map((column) => `backup_row.${identifier(column)} IS NOT NULL`)
        .join(' OR ');
      await input.authorize();
      const detached = await input.database.execute(
        `UPDATE ${name} SET ${table.detachColumns.map((column) => `${identifier(column)}=NULL`).join(', ')}
        WHERE rowid IN (SELECT backup_row.rowid FROM ${name} AS backup_row
          WHERE ${table.owner.sql} AND (${attached}) LIMIT ${PAGE_ROWS})${schema.sql}`,
        [...table.owner.params, ...schema.params]
      );
      if (!detached.success) throw fail('backup_import_discard_failed');
      budget--;
      const pending = await input.database.queryOne(
        `SELECT 1 AS pending FROM ${name} AS backup_row WHERE ${table.owner.sql} AND (${attached}) LIMIT 1`,
        table.owner.params
      );
      if (pending) continue;
    }
    const before = await remainingRows(input.database, table);
    await input.authorize();
    try {
      const deleted = await input.database.execute(
        `DELETE FROM ${name} WHERE rowid IN (SELECT backup_row.rowid FROM ${name} AS backup_row
          WHERE ${table.owner.sql} AND NOT (${table.foreignChildren.sql}) LIMIT ${PAGE_ROWS})${schema.sql}`,
        [...table.owner.params, ...table.foreignChildren.params, ...schema.params]
      );
      if (!deleted.success) throw fail('backup_import_discard_failed');
    } catch (cause) {
      if (cause instanceof Error && RESTRICTED.test(cause.message))
        return { done: false, blocked: { table: table.table, reason: 'restricted' } };
      throw cause;
    }
    budget--;
    // D1 change counts include trigger writes, so progress is measured on the rows themselves.
    // No progress is a blocker only when every remaining row is held by a foreign reference; an
    // earlier cleanup lease deleting the same rows concurrently is just another pass.
    if ((await remainingRows(input.database, table)) >= before) {
      const deletable = await input.database.queryOne(
        `SELECT 1 AS deletable FROM ${name} AS backup_row
        WHERE ${table.owner.sql} AND NOT (${table.foreignChildren.sql}) LIMIT 1`,
        [...table.owner.params, ...table.foreignChildren.params]
      );
      if (deletable) return { done: false };
      if (
        await input.database.queryOne(
          `SELECT 1 AS held FROM ${name} AS backup_row WHERE ${table.owner.sql} LIMIT 1`,
          table.owner.params
        )
      )
        return { done: false, blocked: { table: table.table, reason: 'foreign_reference' } };
    }
  }
  return { done: false };
}

/** Whether any table the plan deletes from still holds a row of the tenant. */
export async function hasTenantDiscardRemaining(
  database: Database,
  plan: TenantDiscardPlan
): Promise<boolean> {
  return (await firstRemaining(database, plan)) >= 0;
}

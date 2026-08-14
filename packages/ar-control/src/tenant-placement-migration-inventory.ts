import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import type { TenantShardDataRole } from './types';

const SAFE_SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,127}$/u;
const MAX_SCHEMA_TABLES = 500;
const MAX_TABLE_COLUMNS = 256;
const SCHEMA_BATCH_SIZE = 32;

export interface TenantMigrationSchemaExecutor {
  queryD1(databaseId: string, sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult[]>;
  queryD1Batch(
    databaseId: string,
    batch: readonly { sql: string; params?: unknown[] }[]
  ): Promise<CloudflareD1QueryResult[]>;
}

export interface TenantMigrationTableColumn {
  name: string;
  primaryKeyPosition: number;
}

export interface TenantMigrationForeignKey {
  column: string;
  parentTable: string;
  parentColumn: string;
}

export interface TenantMigrationTableSchema {
  name: string;
  columns: TenantMigrationTableColumn[];
  foreignKeys?: TenantMigrationForeignKey[];
}

export type TenantMigrationOwnershipRule =
  | { kind: 'tenant_column'; column: 'tenant_id' }
  | { kind: 'tenant_row'; column: 'id' }
  | { kind: 'tenant_key'; column: 'tenant_key' }
  | { kind: 'tenant_or_key'; tenantColumn: 'tenant_id'; tenantKeyColumn: 'tenant_key' }
  | { kind: 'tenant_scope'; scopeTypeColumn: 'scope_type'; scopeIdColumn: 'scope_id' }
  | {
      kind: 'parent';
      foreignKeyColumn: string;
      parentTable: string;
      parentKeyColumn: string;
      parentTenantColumn: 'tenant_id';
    }
  | { kind: 'shard_local' }
  | { kind: 'global_reference' };

export interface TenantMigrationTableInventory {
  table: string;
  columns: TenantMigrationTableColumn[];
  primaryKey: string[];
  ownership: TenantMigrationOwnershipRule;
  disposition: 'migrate' | 'retain_target_local';
  foreignKeys?: TenantMigrationForeignKey[];
}

export interface TenantMigrationInventoryResult {
  state: 'ready' | 'blocked';
  dataRole: TenantShardDataRole;
  tables: TenantMigrationTableInventory[];
  blockedReasons: string[];
}

const COMMON_SPECIAL_RULES: Readonly<Record<string, TenantMigrationOwnershipRule>> = {
  authrim_control_plane_shard_metadata: { kind: 'shard_local' },
  authrim_migrations: { kind: 'shard_local' },
  tenant_database_migration_state: { kind: 'shard_local' },
  tenant_placement_migration_captures: { kind: 'shard_local' },
  tenant_placement_migration_outbox: { kind: 'shard_local' },
};

const CORE_SPECIAL_RULES: Readonly<Record<string, TenantMigrationOwnershipRule>> = {
  tenants: { kind: 'tenant_row', column: 'id' },
  did_document_cache: { kind: 'global_reference' },
  directory_auth_release_advisories: { kind: 'global_reference' },
  profile_registry: { kind: 'global_reference' },
  internal_notification_delivery_attempts: {
    kind: 'parent',
    foreignKeyColumn: 'event_id',
    parentTable: 'internal_notification_events',
    parentKeyColumn: 'id',
    parentTenantColumn: 'tenant_id',
  },
  internal_notification_delivery_routes: {
    kind: 'tenant_scope',
    scopeTypeColumn: 'scope_type',
    scopeIdColumn: 'scope_id',
  },
  object_catalog_objects: {
    kind: 'parent',
    foreignKeyColumn: 'catalog_id',
    parentTable: 'object_catalog',
    parentKeyColumn: 'id',
    parentTenantColumn: 'tenant_id',
  },
  log_object_catalog: { kind: 'tenant_key', column: 'tenant_key' },
  log_chunk_record_index: { kind: 'tenant_key', column: 'tenant_key' },
  log_chunk_manifests: { kind: 'tenant_key', column: 'tenant_key' },
  logging_catalog_repair_jobs: { kind: 'tenant_key', column: 'tenant_key' },
  logging_quota_policies: {
    kind: 'tenant_scope',
    scopeTypeColumn: 'scope_type',
    scopeIdColumn: 'scope_id',
  },
  logging_usage_aggregates: {
    kind: 'tenant_or_key',
    tenantColumn: 'tenant_id',
    tenantKeyColumn: 'tenant_key',
  },
  logging_quota_evaluations: {
    kind: 'tenant_or_key',
    tenantColumn: 'tenant_id',
    tenantKeyColumn: 'tenant_key',
  },
};

const PII_SPECIAL_RULES: Readonly<Record<string, TenantMigrationOwnershipRule>> = {
  subject_identifiers: {
    kind: 'parent',
    foreignKeyColumn: 'user_id',
    parentTable: 'users_pii',
    parentKeyColumn: 'id',
    parentTenantColumn: 'tenant_id',
  },
  identity_identifier_replacement_history: {
    kind: 'parent',
    foreignKeyColumn: 'operation_id',
    parentTable: 'identity_identifier_replacement_operations',
    parentKeyColumn: 'operation_id',
    parentTenantColumn: 'tenant_id',
  },
  identity_identifier_replacement_projections: {
    kind: 'parent',
    foreignKeyColumn: 'operation_id',
    parentTable: 'identity_identifier_replacement_operations',
    parentKeyColumn: 'operation_id',
    parentTenantColumn: 'tenant_id',
  },
};

function rows(result: CloudflareD1QueryResult[] | CloudflareD1QueryResult): unknown[] {
  const item = Array.isArray(result) ? result[0] : result;
  if (!item || item.success !== true || !Array.isArray(item.results)) {
    throw new Error('tenant_migration_schema_response_invalid');
  }
  return item.results;
}

function safeTableName(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_SQL_IDENTIFIER.test(value)) {
    throw new Error('tenant_migration_schema_identifier_invalid');
  }
  return value;
}

function parseTableColumns(
  table: string,
  result: CloudflareD1QueryResult
): TenantMigrationTableColumn[] {
  const parsed = rows(result);
  if (parsed.length === 0 || parsed.length > MAX_TABLE_COLUMNS) {
    throw new Error('tenant_migration_schema_columns_invalid');
  }
  const columns = parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('tenant_migration_schema_columns_invalid');
    }
    const row = value as Record<string, unknown>;
    const name = safeTableName(row.name);
    if (typeof row.pk !== 'number' || !Number.isInteger(row.pk) || row.pk < 0) {
      throw new Error('tenant_migration_schema_columns_invalid');
    }
    return { name, primaryKeyPosition: row.pk };
  });
  if (new Set(columns.map((column) => column.name)).size !== columns.length) {
    throw new Error('tenant_migration_schema_columns_invalid');
  }
  if (columns.every((column) => column.primaryKeyPosition === 0)) {
    throw new Error(`tenant_migration_table_primary_key_missing:${table}`);
  }
  return columns;
}

function parseForeignKeys(result: CloudflareD1QueryResult): TenantMigrationForeignKey[] {
  const parsed = rows(result);
  return parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('tenant_migration_schema_foreign_key_invalid');
    }
    const row = value as Record<string, unknown>;
    return {
      column: safeTableName(row.from),
      parentTable: safeTableName(row.table),
      parentColumn: safeTableName(row.to),
    };
  });
}

export async function inspectTenantMigrationSchema(
  executor: TenantMigrationSchemaExecutor,
  databaseId: string
): Promise<TenantMigrationTableSchema[]> {
  const tableRows = rows(
    await executor.queryD1(
      databaseId,
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name
       LIMIT ?`,
      [MAX_SCHEMA_TABLES + 1]
    )
  );
  if (tableRows.length === 0 || tableRows.length > MAX_SCHEMA_TABLES) {
    throw new Error('tenant_migration_schema_table_count_invalid');
  }
  const tableNames = tableRows.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('tenant_migration_schema_response_invalid');
    }
    return safeTableName((value as Record<string, unknown>).name);
  });
  if (new Set(tableNames).size !== tableNames.length) {
    throw new Error('tenant_migration_schema_response_invalid');
  }

  const schemas: TenantMigrationTableSchema[] = [];
  for (let offset = 0; offset < tableNames.length; offset += SCHEMA_BATCH_SIZE) {
    const batchNames = tableNames.slice(offset, offset + SCHEMA_BATCH_SIZE);
    const results = await executor.queryD1Batch(
      databaseId,
      batchNames.flatMap((table) => [
        { sql: `PRAGMA table_info("${table}")` },
        { sql: `PRAGMA foreign_key_list("${table}")` },
      ])
    );
    if (results.length !== batchNames.length * 2) {
      throw new Error('tenant_migration_schema_response_invalid');
    }
    for (let index = 0; index < batchNames.length; index += 1) {
      schemas.push({
        name: batchNames[index],
        columns: parseTableColumns(batchNames[index], results[index * 2]),
        foreignKeys: parseForeignKeys(results[index * 2 + 1]),
      });
    }
  }
  return schemas;
}

function requiredColumns(rule: TenantMigrationOwnershipRule): string[] {
  switch (rule.kind) {
    case 'tenant_column':
    case 'tenant_row':
    case 'tenant_key':
      return [rule.column];
    case 'tenant_or_key':
      return [rule.tenantColumn, rule.tenantKeyColumn];
    case 'tenant_scope':
      return [rule.scopeTypeColumn, rule.scopeIdColumn];
    case 'parent':
      return [rule.foreignKeyColumn];
    case 'global_reference':
    case 'shard_local':
      return [];
  }
}

function specialRule(
  dataRole: TenantShardDataRole,
  table: string
): TenantMigrationOwnershipRule | undefined {
  return (
    COMMON_SPECIAL_RULES[table] ??
    (dataRole === 'tenant_pii' ? PII_SPECIAL_RULES[table] : CORE_SPECIAL_RULES[table])
  );
}

export function classifyTenantMigrationSchema(
  dataRole: TenantShardDataRole,
  schemas: readonly TenantMigrationTableSchema[]
): TenantMigrationInventoryResult {
  const schemaByName = new Map(schemas.map((schema) => [schema.name, schema]));
  const blockedReasons: string[] = [];
  const tables: TenantMigrationTableInventory[] = [];

  for (const schema of [...schemas].sort((left, right) => left.name.localeCompare(right.name))) {
    const columnNames = new Set(schema.columns.map((column) => column.name));
    const rule =
      specialRule(dataRole, schema.name) ??
      (columnNames.has('tenant_id')
        ? ({ kind: 'tenant_column', column: 'tenant_id' } as const)
        : undefined);
    if (!rule) {
      blockedReasons.push(`tenant_migration_table_unclassified:${schema.name}`);
      continue;
    }
    if (requiredColumns(rule).some((column) => !columnNames.has(column))) {
      blockedReasons.push(`tenant_migration_table_rule_mismatch:${schema.name}`);
      continue;
    }
    if (rule.kind === 'parent') {
      const parent = schemaByName.get(rule.parentTable);
      const parentColumns = new Set(parent?.columns.map((column) => column.name) ?? []);
      if (
        !parent ||
        !parentColumns.has(rule.parentKeyColumn) ||
        !parentColumns.has(rule.parentTenantColumn)
      ) {
        blockedReasons.push(`tenant_migration_table_parent_missing:${schema.name}`);
        continue;
      }
    }
    for (const foreignKey of schema.foreignKeys ?? []) {
      const parent = schemaByName.get(foreignKey.parentTable);
      const parentColumns = new Set(parent?.columns.map((column) => column.name) ?? []);
      if (
        !columnNames.has(foreignKey.column) ||
        !parent ||
        !parentColumns.has(foreignKey.parentColumn)
      ) {
        blockedReasons.push(`tenant_migration_table_foreign_key_invalid:${schema.name}`);
        break;
      }
    }
    const primaryKey = schema.columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map((column) => column.name);
    if (primaryKey.length === 0) {
      blockedReasons.push(`tenant_migration_table_primary_key_missing:${schema.name}`);
      continue;
    }
    tables.push({
      table: schema.name,
      columns: schema.columns,
      primaryKey,
      ownership: rule,
      foreignKeys: schema.foreignKeys ?? [],
      disposition:
        rule.kind === 'shard_local' || rule.kind === 'global_reference'
          ? 'retain_target_local'
          : 'migrate',
    });
  }

  return {
    state: blockedReasons.length === 0 ? 'ready' : 'blocked',
    dataRole,
    tables,
    blockedReasons,
  };
}

export function orderTenantMigrationTables(
  tables: readonly TenantMigrationTableInventory[]
): TenantMigrationTableInventory[] {
  const migratable = new Map(
    tables.filter((table) => table.disposition === 'migrate').map((table) => [table.table, table])
  );
  const remaining = new Set(migratable.keys());
  const ordered: TenantMigrationTableInventory[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((tableName) => {
        const table = migratable.get(tableName);
        if (!table) throw new Error('tenant_migration_table_inventory_invalid');
        const dependencies = new Set([
          ...(table.foreignKeys ?? []).map((foreignKey) => foreignKey.parentTable),
          ...(table.ownership.kind === 'parent' ? [table.ownership.parentTable] : []),
        ]);
        dependencies.delete(tableName);
        return [...dependencies].every(
          (dependency) => !migratable.has(dependency) || !remaining.has(dependency)
        );
      })
      .sort();
    if (ready.length === 0) throw new Error('tenant_migration_table_dependency_cycle');
    for (const tableName of ready) {
      remaining.delete(tableName);
      const table = migratable.get(tableName);
      if (!table) throw new Error('tenant_migration_table_inventory_invalid');
      ordered.push(table);
    }
  }
  return ordered;
}

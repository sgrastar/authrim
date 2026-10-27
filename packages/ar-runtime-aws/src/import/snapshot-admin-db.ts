import { createRequire } from 'node:module';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { rowSqliteValue, rowText } from './verified-rows';

const require = createRequire(import.meta.url);

interface SqliteStatement {
  all(...values: readonly (string | number | null)[]): unknown[];
  get(...values: readonly (string | number | null)[]): unknown;
  run(...values: readonly (string | number | null)[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const MINIMUM_COLUMNS = {
  field_mapping_sets: ['id', 'tenant_id', 'lifecycle_state'],
  field_mapping_activations: [
    'id',
    'tenant_id',
    'field_mapping_set_id',
    'field_mapping_version_id',
    'activation_scope_json',
    'lifecycle_state',
    'activated_at',
    'created_at',
  ],
  field_mapping_versions: [
    'id',
    'tenant_id',
    'field_mapping_set_id',
    'version_label',
    'field_mapping_hash',
    'compatibility_range',
  ],
  compiled_mapping_snapshots: [
    'tenant_id',
    'field_mapping_version_id',
    'catalog_version_id',
    'snapshot_hash',
    'lifecycle_state',
  ],
  field_catalogs: ['id', 'tenant_id', 'lifecycle_state'],
  field_catalog_versions: [
    'id',
    'tenant_id',
    'catalog_id',
    'version_label',
    'bundle_hash',
    'compatibility_range',
    'lifecycle_state',
    'created_at',
  ],
  field_catalog_entries: [
    'id',
    'tenant_id',
    'catalog_version_id',
    'namespace',
    'path',
    'stable_field_id',
    'aliases_json',
    'target_taxonomy',
    'value_type',
    'cardinality',
    'classification',
    'validation_json',
  ],
  mapping_rules: [
    'id',
    'tenant_id',
    'field_mapping_version_id',
    'priority',
    'created_at',
    'action',
    'scope_json',
    'metadata_json',
  ],
  mapping_rule_edges: [
    'id',
    'tenant_id',
    'rule_id',
    'source_ref_json',
    'target_ref_json',
    'edge_kind',
    'display_order',
  ],
  mapping_transform_steps: [
    'id',
    'tenant_id',
    'rule_id',
    'edge_id',
    'step_order',
    'operation',
    'parameters_json',
  ],
  mapping_validation_rules: [
    'id',
    'tenant_id',
    'rule_id',
    'target_ref_json',
    'validation_kind',
    'severity',
    'parameters_json',
    'created_at',
  ],
  destination_profiles: [
    'id',
    'tenant_id',
    'active_version_id',
    'destination_type',
    'lifecycle_state',
  ],
  destination_profile_versions: ['id', 'tenant_id', 'profile_id', 'schema_json', 'lifecycle_state'],
} as const;

export type SnapshotAdminMappingTable = keyof typeof MINIMUM_COLUMNS;
export const SNAPSHOT_ADMIN_MAPPING_TABLES = Object.keys(
  MINIMUM_COLUMNS
) as SnapshotAdminMappingTable[];

const NUMERIC_COLUMNS = new Set([
  'activated_at',
  'created_at',
  'display_order',
  'priority',
  'step_order',
]);
const SAFE_COLUMN = /^[a-z][a-z0-9_]{0,127}$/u;

function invalid(): never {
  throw new Error('aws_admin_snapshot_invalid');
}

function sqliteValues(values: unknown[]): Array<string | number | null> {
  return values.map((value) => {
    if (value === null || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    return invalid();
  });
}

class SnapshotAdminAdapter implements DatabaseAdapter {
  constructor(private readonly db: SqliteDatabase) {}

  async query<T>(sql: string, params: unknown[] = [], _options?: QueryOptions): Promise<T[]> {
    return this.db.prepare(sql).all(...sqliteValues(params)) as T[];
  }

  async queryOne<T>(
    sql: string,
    params: unknown[] = [],
    _options?: QueryOptions
  ): Promise<T | null> {
    return (this.db.prepare(sql).get(...sqliteValues(params)) as T | undefined) ?? null;
  }

  async execute(_sql: string, _params?: unknown[]): Promise<ExecuteResult> {
    return invalid();
  }

  async transaction<T>(_fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return invalid();
  }

  async batch(_statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return invalid();
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'sqlite-snapshot' };
  }

  getType(): string {
    return 'sqlite-snapshot';
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Materialize only the mapping tables needed by the unchanged SAML release compiler. */
export function createSnapshotAdminAdapter(input: {
  tenantId: string;
  rows: Readonly<Record<SnapshotAdminMappingTable, readonly PortableSqliteRow[]>>;
  platformRows?: Partial<Readonly<Record<SnapshotAdminMappingTable, readonly PortableSqliteRow[]>>>;
}): DatabaseAdapter {
  const module = require('node:sqlite') as SqliteModule;
  const db = new module.DatabaseSync(':memory:');
  try {
    for (const table of SNAPSHOT_ADMIN_MAPPING_TABLES) {
      const tenantRows = input.rows[table];
      const platformRows = input.platformRows?.[table] ?? [];
      if (
        platformRows.length &&
        !['destination_profiles', 'destination_profile_versions'].includes(table)
      ) {
        invalid();
      }
      const rows = [...tenantRows, ...platformRows];
      const columns = new Set<string>(MINIMUM_COLUMNS[table]);
      for (const row of rows) {
        const owner = rowText(row, 'tenant_id');
        if (owner !== input.tenantId && !(platformRows.includes(row) && owner === 'platform')) {
          invalid();
        }
        for (const column of Object.keys(row)) {
          if (!SAFE_COLUMN.test(column)) invalid();
          columns.add(column);
        }
      }
      const names = [...columns].sort();
      const definitions = names.map(
        (name) => `"${name}" ${NUMERIC_COLUMNS.has(name) ? 'INTEGER' : 'TEXT'}`
      );
      db.exec(`CREATE TABLE "${table}" (${definitions.join(', ')})`);
      if (rows.length === 0) continue;
      const sql = `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
      const statement = db.prepare(sql);
      const seen = new Set<string>();
      for (const row of rows) {
        const id = row.id?.[0] === 'text' ? row.id[1] : null;
        const identity = `${rowText(row, 'tenant_id')}\0${id ?? JSON.stringify(row)}`;
        if (seen.has(identity)) invalid();
        seen.add(identity);
        statement.run(...names.map((name) => (row[name] ? rowSqliteValue(row, name) : null)));
      }
    }
    return new SnapshotAdminAdapter(db);
  } catch {
    db.close();
    return invalid();
  }
}

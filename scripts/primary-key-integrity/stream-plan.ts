import {
  LEGACY_RUNTIME_PROBES_SQL,
  LEGACY_MIGRATION_METADATA_SQL,
} from './runtime-schema-fixtures.js';
import { inspectSchema, type SchemaInventory } from './schema-inventory.js';
import { buildPrimaryKeyMigration } from './rebuild.js';
import {
  FROZEN_AUTHRIM_MIGRATIONS_TABLE_SQL as AUTHRIM_MIGRATIONS_TABLE_SQL,
  FROZEN_TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL as TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL,
} from './runtime-schema-fixtures.js';

/** Cover migration metadata created by Setup/Control outside the stream SQL. */
export function infrastructureDefinitions(stream: SchemaInventory['inspectedStreams'][number]) {
  const definitions = [
    AUTHRIM_MIGRATIONS_TABLE_SQL,
    ...[LEGACY_RUNTIME_PROBES_SQL, LEGACY_MIGRATION_METADATA_SQL].map((sql) =>
      sql.replace('TEXT PRIMARY KEY', 'TEXT PRIMARY KEY NOT NULL')
    ),
  ];
  // Admin owns a different table with this name; its baseline definition is authoritative.
  if (!stream.tables.some((table) => table.name === 'tenant_database_migration_state'))
    definitions.push(TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL);
  return definitions;
}

export function buildStreamPrimaryKeyMigration(
  stream: SchemaInventory['inspectedStreams'][number]
) {
  const definitions = infrastructureDefinitions(stream);
  const current = inspectSchema(definitions);
  const legacy = inspectSchema(
    definitions.map((sql) => sql.replace('TEXT PRIMARY KEY NOT NULL', 'TEXT PRIMARY KEY'))
  );
  const plan = buildPrimaryKeyMigration({
    tables: [...stream.tables, ...legacy.tables].sort((a, b) => a.name.localeCompare(b.name)),
    objects: stream.objects,
    alternateTableSql: new Map(current.tables.map((table) => [table.name, table.sql])),
  });
  // IF NOT EXISTS supports fresh installs, Setup-only DBs and pre-existing Control metadata.
  return { ...plan, sql: definitions.map((sql) => sql + ';').join('\n\n') + '\n\n' + plan.sql };
}

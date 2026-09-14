import type { BackupSchemaTable } from './schema-inventory.js';
import type { SnapshotTableSchema } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';

export type SnapshotSchemaConcern =
  | 'unsupported_identifier'
  | 'ownership_adapter_required'
  | 'missing_primary_key'
  | 'nullable_primary_key'
  | 'generated_primary_key'
  | 'rowid_allocation'
  | 'expression_unique_index'
  | 'nonbinary_unique_index';

/**
 * Conservative structural check, not tenant ownership authorization or D1 certification.
 * A successful result still needs a reviewed ownership policy and coordinated capture boundary.
 * Refuse automatic rowids: NEW.rowid is not the allocated identity in a BEFORE INSERT trigger.
 */
export function assessSnapshotTable(
  table: BackupSchemaTable,
  tenantColumn = 'tenant_id'
): { concerns: SnapshotSchemaConcern[]; schema: SnapshotTableSchema | null } {
  const concerns = new Set<SnapshotSchemaConcern>();
  const identifier = /^[a-z][a-z0-9_]*$/;
  if (
    !identifier.test(table.name) ||
    table.name.startsWith('tenant_backup_') ||
    table.columns.some((column) => !identifier.test(column.name))
  ) {
    concerns.add('unsupported_identifier');
  }
  if (!table.columns.some((column) => column.name === tenantColumn && !column.generated)) {
    concerns.add('ownership_adapter_required');
  }
  const primary = table.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
  if (primary.length === 0) concerns.add('missing_primary_key');
  const rowidAlias =
    !table.withoutRowid &&
    primary.length === 1 &&
    primary[0].type.toUpperCase() === 'INTEGER' &&
    !table.indexes.some((index) => index.origin === 'pk');
  for (const column of primary) {
    if (column.generated) concerns.add('generated_primary_key');
    // STRICT and WITHOUT ROWID enforce NOT NULL on the declared primary key.
    if (!column.notNull && !table.withoutRowid && !table.strict && !rowidAlias) {
      concerns.add('nullable_primary_key');
    }
  }
  if (rowidAlias) concerns.add('rowid_allocation');
  const uniqueKeys: string[][] = [];
  for (const index of table.indexes.filter((candidate) => candidate.unique)) {
    const keys = index.columns.filter((column) => column.key);
    if (keys.some((column) => column.name === null)) concerns.add('expression_unique_index');
    if (keys.some((column) => column.collation.toUpperCase() !== 'BINARY')) {
      concerns.add('nonbinary_unique_index');
    }
    if (keys.every((column) => column.name !== null)) {
      // Ignoring a partial predicate captures a superset of conflicting preimages safely.
      // It does not cause export of an inserted row: the absent marker still wins first.
      uniqueKeys.push(keys.flatMap((column) => (column.name === null ? [] : [column.name])));
    }
  }
  return {
    concerns: [...concerns],
    schema:
      concerns.size > 0
        ? null
        : {
            table: table.name,
            tenantColumn,
            columns: table.columns.map((column) => column.name),
            primaryKey: primary.map((column) => column.name),
            uniqueKeys,
          },
  };
}

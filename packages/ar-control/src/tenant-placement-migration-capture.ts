import type {
  TenantMigrationTableInventory,
  TenantMigrationOwnershipRule,
} from './tenant-placement-migration-inventory';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const MAX_TENANT_KEY_LENGTH = 256;

export interface TenantMigrationCaptureQuery {
  sql: string;
  params?: unknown[];
}

export interface TenantMigrationCapturePlan {
  install: TenantMigrationCaptureQuery[];
  uninstall: TenantMigrationCaptureQuery[];
  triggerNames: string[];
}

function safeId(value: string, code: string): string {
  if (!SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(value)) {
    throw new Error('tenant_migration_capture_identifier_invalid');
  }
  return `"${value}"`;
}

function sqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('tenant_migration_capture_literal_invalid');
  return `'${value.replaceAll("'", "''")}'`;
}

async function operationSuffix(operationId: string, table: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${operationId}\0${table}`)
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

function ownershipPredicate(
  rule: TenantMigrationOwnershipRule,
  alias: 'NEW' | 'OLD',
  tenantId: string,
  tenantKey: string
): string {
  const column = (name: string) => `${alias}.${sqlIdentifier(name)}`;
  switch (rule.kind) {
    case 'tenant_column':
      return `${column(rule.column)} = ${sqlLiteral(tenantId)}`;
    case 'tenant_row':
      return `${column(rule.column)} = ${sqlLiteral(tenantId)}`;
    case 'tenant_key':
      return `${column(rule.column)} = ${sqlLiteral(tenantKey)}`;
    case 'tenant_or_key':
      return `(${column(rule.tenantColumn)} = ${sqlLiteral(tenantId)} OR ${column(
        rule.tenantKeyColumn
      )} = ${sqlLiteral(tenantKey)})`;
    case 'tenant_scope':
      return `(${column(rule.scopeTypeColumn)} = 'tenant' AND ${column(
        rule.scopeIdColumn
      )} = ${sqlLiteral(tenantId)})`;
    case 'parent':
      return `EXISTS (
        SELECT 1 FROM ${sqlIdentifier(rule.parentTable)} parent
         WHERE parent.${sqlIdentifier(rule.parentKeyColumn)} = ${column(rule.foreignKeyColumn)}
           AND parent.${sqlIdentifier(rule.parentTenantColumn)} = ${sqlLiteral(tenantId)}
      )`;
    case 'global_reference':
    case 'shard_local':
      throw new Error('tenant_migration_capture_non_migrated_table');
  }
}

function jsonScalar(alias: 'NEW' | 'OLD', column: string): string {
  const value = `${alias}.${sqlIdentifier(column)}`;
  return `CASE WHEN typeof(${value}) = 'blob'
    THEN json_object('$authrim_blob_hex', hex(${value}))
    ELSE ${value} END`;
}

function jsonObject(alias: 'NEW' | 'OLD', columns: readonly string[]): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < columns.length; offset += 24) {
    const values = columns
      .slice(offset, offset + 24)
      .flatMap((column) => [sqlLiteral(column), jsonScalar(alias, column)]);
    chunks.push(`json_object(${values.join(', ')})`);
  }
  return chunks.length === 1
    ? chunks[0]
    : chunks.slice(1).reduce((result, chunk) => `json_patch(${result}, ${chunk})`, chunks[0]);
}

function outboxInsert(input: {
  operationId: string;
  tenantId: string;
  table: TenantMigrationTableInventory;
  alias: 'NEW' | 'OLD';
  mutationKind: 'upsert' | 'delete';
  predicate: string;
}): string {
  const keyJson = jsonObject(input.alias, input.table.primaryKey);
  const rowJson =
    input.mutationKind === 'upsert'
      ? jsonObject(
          input.alias,
          input.table.columns.map((column) => column.name)
        )
      : 'NULL';
  return `INSERT INTO tenant_placement_migration_outbox (
      operation_id, tenant_id, table_name, mutation_kind, mutation_key_json, row_json,
      capture_fencing_token, created_at
    )
    SELECT capture.operation_id, capture.tenant_id, ${sqlLiteral(input.table.table)},
           ${sqlLiteral(input.mutationKind)}, ${keyJson}, ${rowJson},
           capture.fencing_token, unixepoch()
      FROM tenant_placement_migration_captures capture
     WHERE capture.operation_id = ${sqlLiteral(input.operationId)}
       AND capture.tenant_id = ${sqlLiteral(input.tenantId)}
       AND capture.capture_state = 'capturing'
       AND (${input.predicate});`;
}

function createTrigger(
  name: string,
  timing: 'BEFORE' | 'AFTER',
  event: string,
  table: string,
  body: string
): string {
  return `CREATE TRIGGER IF NOT EXISTS ${sqlIdentifier(name)}
${timing} ${event} ON ${sqlIdentifier(table)}
BEGIN
  ${body}
END`;
}

export async function buildTenantMigrationCapturePlan(input: {
  operationId: string;
  tenantId: string;
  tenantKey: string;
  sourceShardId: string;
  migrationGeneration: number;
  fencingToken: number;
  inventory: readonly TenantMigrationTableInventory[];
  now: number;
}): Promise<TenantMigrationCapturePlan> {
  safeId(input.operationId, 'tenant_migration_capture_operation_invalid');
  safeId(input.tenantId, 'tenant_migration_capture_tenant_invalid');
  safeId(input.sourceShardId, 'tenant_migration_capture_shard_invalid');
  if (
    input.tenantKey.length < 1 ||
    input.tenantKey.length > MAX_TENANT_KEY_LENGTH ||
    input.tenantKey.includes('\0')
  ) {
    throw new Error('tenant_migration_capture_tenant_key_invalid');
  }
  if (
    !Number.isSafeInteger(input.migrationGeneration) ||
    input.migrationGeneration < 1 ||
    !Number.isSafeInteger(input.fencingToken) ||
    input.fencingToken < 1 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 1
  ) {
    throw new Error('tenant_migration_capture_generation_invalid');
  }

  const install: TenantMigrationCaptureQuery[] = [
    {
      sql: `INSERT INTO tenant_placement_migration_captures (
        operation_id, tenant_id, source_shard_id, migration_generation, capture_state,
        fencing_token, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, 'capturing', ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        fencing_token = excluded.fencing_token,
        updated_at = excluded.updated_at
      WHERE tenant_placement_migration_captures.tenant_id = excluded.tenant_id
        AND tenant_placement_migration_captures.source_shard_id = excluded.source_shard_id
        AND tenant_placement_migration_captures.migration_generation = excluded.migration_generation
        AND tenant_placement_migration_captures.capture_state = 'capturing'`,
      params: [
        input.operationId,
        input.tenantId,
        input.sourceShardId,
        input.migrationGeneration,
        input.fencingToken,
        input.now,
        input.now,
      ],
    },
  ];
  const triggerNames: string[] = [];

  for (const table of input.inventory) {
    if (table.disposition !== 'migrate') continue;
    const suffix = await operationSuffix(input.operationId, table.table);
    const prefix = `authrim_tpm_${suffix}`;
    const oldPredicate = ownershipPredicate(
      table.ownership,
      'OLD',
      input.tenantId,
      input.tenantKey
    );
    const newPredicate = ownershipPredicate(
      table.ownership,
      'NEW',
      input.tenantId,
      input.tenantKey
    );
    const oldKey = jsonObject('OLD', table.primaryKey);
    const newKey = jsonObject('NEW', table.primaryKey);
    const definitions = [
      {
        name: `${prefix}_bi`,
        timing: 'BEFORE' as const,
        event: 'INSERT',
        body: `SELECT RAISE(ABORT, 'tenant_placement_migration_write_fenced')
          WHERE (${newPredicate}) AND EXISTS (
            SELECT 1 FROM tenant_placement_migration_captures capture
             WHERE capture.operation_id = ${sqlLiteral(input.operationId)}
               AND capture.capture_state IN ('write_fenced', 'cutover_committed')
          );`,
      },
      {
        name: `${prefix}_bu`,
        timing: 'BEFORE' as const,
        event: 'UPDATE',
        body: `SELECT RAISE(ABORT, 'tenant_placement_migration_write_fenced')
          WHERE ((${oldPredicate}) OR (${newPredicate})) AND EXISTS (
            SELECT 1 FROM tenant_placement_migration_captures capture
             WHERE capture.operation_id = ${sqlLiteral(input.operationId)}
               AND capture.capture_state IN ('write_fenced', 'cutover_committed')
          );`,
      },
      {
        name: `${prefix}_bd`,
        timing: 'BEFORE' as const,
        event: 'DELETE',
        body: `SELECT RAISE(ABORT, 'tenant_placement_migration_write_fenced')
          WHERE (${oldPredicate}) AND EXISTS (
            SELECT 1 FROM tenant_placement_migration_captures capture
             WHERE capture.operation_id = ${sqlLiteral(input.operationId)}
               AND capture.capture_state IN ('write_fenced', 'cutover_committed')
          );`,
      },
      {
        name: `${prefix}_ai`,
        timing: 'AFTER' as const,
        event: 'INSERT',
        body: outboxInsert({
          operationId: input.operationId,
          tenantId: input.tenantId,
          table,
          alias: 'NEW',
          mutationKind: 'upsert',
          predicate: newPredicate,
        }),
      },
      {
        name: `${prefix}_au_del`,
        timing: 'AFTER' as const,
        event: 'UPDATE',
        body: outboxInsert({
          operationId: input.operationId,
          tenantId: input.tenantId,
          table,
          alias: 'OLD',
          mutationKind: 'delete',
          predicate: `(${oldPredicate}) AND (NOT (${newPredicate}) OR ${oldKey} <> ${newKey})`,
        }),
      },
      {
        name: `${prefix}_au_up`,
        timing: 'AFTER' as const,
        event: 'UPDATE',
        body: outboxInsert({
          operationId: input.operationId,
          tenantId: input.tenantId,
          table,
          alias: 'NEW',
          mutationKind: 'upsert',
          predicate: newPredicate,
        }),
      },
      {
        name: `${prefix}_ad`,
        timing: 'AFTER' as const,
        event: 'DELETE',
        body: outboxInsert({
          operationId: input.operationId,
          tenantId: input.tenantId,
          table,
          alias: 'OLD',
          mutationKind: 'delete',
          predicate: oldPredicate,
        }),
      },
    ];
    for (const definition of definitions) {
      triggerNames.push(definition.name);
      install.push({
        sql: createTrigger(
          definition.name,
          definition.timing,
          definition.event,
          table.table,
          definition.body
        ),
      });
    }
  }

  return {
    install,
    uninstall: triggerNames.map((name) => ({
      sql: `DROP TRIGGER IF EXISTS ${sqlIdentifier(name)}`,
    })),
    triggerNames,
  };
}

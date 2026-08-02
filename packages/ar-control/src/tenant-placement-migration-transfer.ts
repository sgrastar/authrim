import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import type {
  TenantMigrationOwnershipRule,
  TenantMigrationTableInventory,
} from './tenant-placement-migration-inventory';

const MAX_OUTBOX_BATCH = 100;
const MAX_OUTBOX_JSON_BYTES = 1024 * 1024;

export interface TenantMigrationTransferExecutor {
  queryD1(databaseId: string, sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult[]>;
  queryD1Batch(
    databaseId: string,
    batch: readonly { sql: string; params?: unknown[] }[]
  ): Promise<CloudflareD1QueryResult[]>;
}

export interface TenantMigrationOutboxRecord {
  sourceSequence: number;
  operationId: string;
  tenantId: string;
  tableName: string;
  mutationKind: 'upsert' | 'delete';
  mutationKey: Record<string, unknown>;
  row: Record<string, unknown> | null;
  captureFencingToken: number;
}

interface OutboxRow extends Record<string, unknown> {
  source_sequence: number;
  operation_id: string;
  tenant_id: string;
  table_name: string;
  mutation_kind: string;
  mutation_key_json: string;
  row_json: string | null;
  capture_fencing_token: number;
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(value)) {
    throw new Error('tenant_migration_transfer_identifier_invalid');
  }
  return `"${value}"`;
}

function resultRows(result: CloudflareD1QueryResult[]): Record<string, unknown>[] {
  if (result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0].results)) {
    throw new Error('tenant_migration_transfer_response_invalid');
  }
  return result[0].results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('tenant_migration_transfer_response_invalid');
    }
    return row as Record<string, unknown>;
  });
}

function parseJsonObject(value: string, code: string): Record<string, unknown> {
  if (new TextEncoder().encode(value).byteLength > MAX_OUTBOX_JSON_BYTES) throw new Error(code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}

function decodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>).$authrim_blob_hex === 'string'
  ) {
    const hex = (value as Record<string, string>).$authrim_blob_hex;
    if (!/^(?:[0-9A-F]{2})*$/u.test(hex)) {
      throw new Error('tenant_migration_outbox_blob_invalid');
    }
    return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new Error('tenant_migration_outbox_value_invalid');
}

export interface TenantMigrationBackfillPage {
  rows: Record<string, unknown>[];
  nextCursor: Record<string, unknown> | null;
  done: boolean;
}

function exactObject(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  code: string
): Record<string, unknown> {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, decodeValue(value[key])]));
}

export function decodeTenantMigrationOutboxRows(
  values: readonly Record<string, unknown>[],
  expected: { operationId: string; tenantId: string; fencingToken: number; afterSequence: number }
): TenantMigrationOutboxRecord[] {
  if (values.length > MAX_OUTBOX_BATCH) throw new Error('tenant_migration_outbox_batch_too_large');
  let previousSequence = expected.afterSequence;
  return values.map((value) => {
    const row = value as OutboxRow;
    if (
      !Number.isSafeInteger(row.source_sequence) ||
      row.source_sequence <= previousSequence ||
      row.operation_id !== expected.operationId ||
      row.tenant_id !== expected.tenantId ||
      row.capture_fencing_token !== expected.fencingToken ||
      typeof row.table_name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,127}$/u.test(row.table_name) ||
      (row.mutation_kind !== 'upsert' && row.mutation_kind !== 'delete') ||
      typeof row.mutation_key_json !== 'string' ||
      (row.row_json !== null && typeof row.row_json !== 'string') ||
      (row.mutation_kind === 'upsert' && row.row_json === null) ||
      (row.mutation_kind === 'delete' && row.row_json !== null)
    ) {
      throw new Error('tenant_migration_outbox_row_invalid');
    }
    previousSequence = row.source_sequence;
    return {
      sourceSequence: row.source_sequence,
      operationId: row.operation_id,
      tenantId: row.tenant_id,
      tableName: row.table_name,
      mutationKind: row.mutation_kind,
      mutationKey: parseJsonObject(
        row.mutation_key_json,
        'tenant_migration_outbox_mutation_key_invalid'
      ),
      row:
        row.row_json === null
          ? null
          : parseJsonObject(row.row_json, 'tenant_migration_outbox_row_json_invalid'),
      captureFencingToken: row.capture_fencing_token,
    };
  });
}

export async function readTenantMigrationOutboxBatch(input: {
  executor: TenantMigrationTransferExecutor;
  sourceDatabaseId: string;
  operationId: string;
  tenantId: string;
  fencingToken: number;
  afterSequence: number;
  limit?: number;
}): Promise<TenantMigrationOutboxRecord[]> {
  const limit = input.limit ?? MAX_OUTBOX_BATCH;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_BATCH) {
    throw new Error('tenant_migration_outbox_limit_invalid');
  }
  const values = resultRows(
    await input.executor.queryD1(
      input.sourceDatabaseId,
      `SELECT source_sequence, operation_id, tenant_id, table_name, mutation_kind,
              mutation_key_json, row_json, capture_fencing_token
         FROM tenant_placement_migration_outbox
        WHERE operation_id = ? AND tenant_id = ? AND capture_fencing_token = ?
          AND delivery_state = 'pending' AND source_sequence > ?
        ORDER BY source_sequence
        LIMIT ?`,
      [input.operationId, input.tenantId, input.fencingToken, input.afterSequence, limit]
    )
  );
  return decodeTenantMigrationOutboxRows(values, {
    operationId: input.operationId,
    tenantId: input.tenantId,
    fencingToken: input.fencingToken,
    afterSequence: input.afterSequence,
  });
}

export async function readTenantMigrationBackfillPage(input: {
  executor: TenantMigrationTransferExecutor;
  sourceDatabaseId: string;
  table: TenantMigrationTableInventory;
  tenantId: string;
  tenantKey: string;
  cursor: Record<string, unknown> | null;
  limit?: number;
}): Promise<TenantMigrationBackfillPage> {
  if (input.table.disposition !== 'migrate') {
    throw new Error('tenant_migration_backfill_table_not_migratable');
  }
  const limit = input.limit ?? MAX_OUTBOX_BATCH;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_BATCH) {
    throw new Error('tenant_migration_backfill_limit_invalid');
  }
  const columns = input.table.columns.map((column) => column.name);
  const cursor = input.cursor
    ? exactObject(input.cursor, input.table.primaryKey, 'tenant_migration_backfill_cursor_invalid')
    : null;
  const ownership = rowOwnershipPredicate(input.table.ownership);
  const cursorPredicate = cursor
    ? `AND (${input.table.primaryKey.map(sqlIdentifier).join(', ')}) > (${input.table.primaryKey
        .map(() => '?')
        .join(', ')})`
    : '';
  const rows = resultRows(
    await input.executor.queryD1(
      input.sourceDatabaseId,
      `SELECT ${columns.map(sqlIdentifier).join(', ')}
         FROM ${sqlIdentifier(input.table.table)} candidate
        WHERE (${ownership}) ${cursorPredicate}
        ORDER BY ${input.table.primaryKey.map(sqlIdentifier).join(', ')}
        LIMIT ?`,
      [
        ...ownerParams(input.table.ownership, input.tenantId, input.tenantKey),
        ...(cursor ? input.table.primaryKey.map((column) => cursor[column]) : []),
        limit,
      ]
    )
  ).map((row) => exactObject(row, columns, 'tenant_migration_backfill_row_invalid'));
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: last
      ? Object.fromEntries(input.table.primaryKey.map((column) => [column, last[column]]))
      : input.cursor,
    done: rows.length < limit,
  };
}

export async function applyTenantMigrationBackfillPage(input: {
  executor: TenantMigrationTransferExecutor;
  targetDatabaseId: string;
  table: TenantMigrationTableInventory;
  tenantId: string;
  tenantKey: string;
  rows: readonly Record<string, unknown>[];
}): Promise<number> {
  if (input.rows.length > MAX_OUTBOX_BATCH) {
    throw new Error('tenant_migration_backfill_batch_too_large');
  }
  const columns = input.table.columns.map((column) => column.name);
  for (const value of input.rows) {
    const row = exactObject(value, columns, 'tenant_migration_backfill_row_invalid');
    const owner = validateUpsertOwner(input.table.ownership, row, input.tenantId, input.tenantKey);
    if (owner === false) throw new Error('tenant_migration_backfill_owner_mismatch');
    if (owner === 'parent_check') {
      await assertParentOwner({
        executor: input.executor,
        targetDatabaseId: input.targetDatabaseId,
        rule: input.table.ownership as Extract<TenantMigrationOwnershipRule, { kind: 'parent' }>,
        row,
        tenantId: input.tenantId,
      });
    }
    const query = upsertQuery(input.table, row);
    const result = await input.executor.queryD1(input.targetDatabaseId, query.sql, query.params);
    if (result.length !== 1 || result[0]?.success !== true) {
      throw new Error('tenant_migration_backfill_target_apply_failed');
    }
  }
  return input.rows.length;
}

function validateUpsertOwner(
  rule: TenantMigrationOwnershipRule,
  row: Record<string, unknown>,
  tenantId: string,
  tenantKey: string
): boolean | 'parent_check' {
  switch (rule.kind) {
    case 'tenant_column':
      return row[rule.column] === tenantId;
    case 'tenant_row':
      return row[rule.column] === tenantId;
    case 'tenant_key':
      return row[rule.column] === tenantKey;
    case 'tenant_or_key':
      return row[rule.tenantColumn] === tenantId || row[rule.tenantKeyColumn] === tenantKey;
    case 'tenant_scope':
      return row[rule.scopeTypeColumn] === 'tenant' && row[rule.scopeIdColumn] === tenantId;
    case 'parent':
      return 'parent_check';
    case 'global_reference':
    case 'shard_local':
      return false;
  }
}

function pkWhere(table: TenantMigrationTableInventory): string {
  return table.primaryKey.map((column) => `${sqlIdentifier(column)} = ?`).join(' AND ');
}

function rowOwnershipPredicate(rule: TenantMigrationOwnershipRule, alias = 'candidate'): string {
  const column = (name: string) => `${alias}.${sqlIdentifier(name)}`;
  switch (rule.kind) {
    case 'tenant_column':
    case 'tenant_row':
      return `${column(rule.column)} = ?`;
    case 'tenant_key':
      return `${column(rule.column)} = ?`;
    case 'tenant_or_key':
      return `(${column(rule.tenantColumn)} = ? OR ${column(rule.tenantKeyColumn)} = ?)`;
    case 'tenant_scope':
      return `(${column(rule.scopeTypeColumn)} = 'tenant' AND ${column(rule.scopeIdColumn)} = ?)`;
    case 'parent':
      return `EXISTS (
        SELECT 1 FROM ${sqlIdentifier(rule.parentTable)} parent
         WHERE parent.${sqlIdentifier(rule.parentKeyColumn)} = ${column(rule.foreignKeyColumn)}
           AND parent.${sqlIdentifier(rule.parentTenantColumn)} = ?
      )`;
    case 'global_reference':
    case 'shard_local':
      throw new Error('tenant_migration_outbox_table_not_migratable');
  }
}

function ownerParams(
  rule: TenantMigrationOwnershipRule,
  tenantId: string,
  tenantKey: string
): unknown[] {
  switch (rule.kind) {
    case 'tenant_column':
    case 'tenant_row':
    case 'tenant_scope':
    case 'parent':
      return [tenantId];
    case 'tenant_key':
      return [tenantKey];
    case 'tenant_or_key':
      return [tenantId, tenantKey];
    case 'global_reference':
    case 'shard_local':
      return [];
  }
}

export function buildTenantMigrationPurgeQuery(input: {
  table: TenantMigrationTableInventory;
  tenantId: string;
  tenantKey: string;
  limit?: number;
}): { sql: string; params: unknown[] } {
  const limit = input.limit ?? MAX_OUTBOX_BATCH;
  if (
    input.table.disposition !== 'migrate' ||
    input.table.primaryKey.length === 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_OUTBOX_BATCH
  ) {
    throw new Error('tenant_migration_purge_input_invalid');
  }
  const table = sqlIdentifier(input.table.table);
  const keys = input.table.primaryKey.map(sqlIdentifier);
  const predicate = rowOwnershipPredicate(input.table.ownership, 'candidate');
  const order = keys.map((key) => `candidate.${key}`).join(', ');
  const match = keys.map((key) => `purge_keys.${key} IS source_row.${key}`).join(' AND ');
  return {
    sql: `WITH purge_keys AS (
      SELECT ${keys.map((key) => `candidate.${key}`).join(', ')}
        FROM ${table} AS candidate
       WHERE ${predicate}
       ORDER BY ${order}
       LIMIT ?
    )
    DELETE FROM ${table} AS source_row
     WHERE EXISTS (SELECT 1 FROM purge_keys WHERE ${match})`,
    params: [...ownerParams(input.table.ownership, input.tenantId, input.tenantKey), limit],
  };
}

async function assertDeleteOwner(input: {
  executor: TenantMigrationTransferExecutor;
  targetDatabaseId: string;
  table: TenantMigrationTableInventory;
  keyValues: unknown[];
  tenantId: string;
  tenantKey: string;
}): Promise<void> {
  const tableName = sqlIdentifier(input.table.table);
  const pk = pkWhere(input.table);
  const ownership = rowOwnershipPredicate(input.table.ownership);
  const rows = resultRows(
    await input.executor.queryD1(
      input.targetDatabaseId,
      `SELECT
         EXISTS (SELECT 1 FROM ${tableName} candidate WHERE ${pk}) AS row_exists,
         EXISTS (
           SELECT 1 FROM ${tableName} candidate
            WHERE ${pk} AND (${ownership})
         ) AS owner_match`,
      [
        ...input.keyValues,
        ...input.keyValues,
        ...ownerParams(input.table.ownership, input.tenantId, input.tenantKey),
      ]
    )
  );
  const row = rows[0];
  if (
    !row ||
    (row.row_exists !== 0 && row.row_exists !== 1) ||
    (row.owner_match !== 0 && row.owner_match !== 1)
  ) {
    throw new Error('tenant_migration_outbox_owner_response_invalid');
  }
  if (row.row_exists === 1 && row.owner_match !== 1) {
    throw new Error('tenant_migration_outbox_owner_mismatch');
  }
}

async function assertParentOwner(input: {
  executor: TenantMigrationTransferExecutor;
  targetDatabaseId: string;
  rule: Extract<TenantMigrationOwnershipRule, { kind: 'parent' }>;
  row: Record<string, unknown>;
  tenantId: string;
}): Promise<void> {
  const foreignValue = input.row[input.rule.foreignKeyColumn];
  const rows = resultRows(
    await input.executor.queryD1(
      input.targetDatabaseId,
      `SELECT 1 AS owner_match
         FROM ${sqlIdentifier(input.rule.parentTable)}
        WHERE ${sqlIdentifier(input.rule.parentKeyColumn)} = ?
          AND ${sqlIdentifier(input.rule.parentTenantColumn)} = ?
        LIMIT 1`,
      [foreignValue, input.tenantId]
    )
  );
  if (rows.length !== 1 || rows[0].owner_match !== 1) {
    throw new Error('tenant_migration_outbox_parent_owner_mismatch');
  }
}

function upsertQuery(table: TenantMigrationTableInventory, row: Record<string, unknown>) {
  const columns = table.columns.map((column) => column.name);
  const nonPrimary = columns.filter((column) => !table.primaryKey.includes(column));
  const conflict = table.primaryKey.map(sqlIdentifier).join(', ');
  return {
    sql: `INSERT INTO ${sqlIdentifier(table.table)} (${columns.map(sqlIdentifier).join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
      ON CONFLICT (${conflict}) ${
        nonPrimary.length === 0
          ? 'DO NOTHING'
          : `DO UPDATE SET ${nonPrimary
              .map((column) => `${sqlIdentifier(column)} = excluded.${sqlIdentifier(column)}`)
              .join(', ')}`
      }`,
    params: columns.map((column) => row[column]),
  };
}

export async function applyTenantMigrationOutboxBatch(input: {
  executor: TenantMigrationTransferExecutor;
  sourceDatabaseId: string;
  targetDatabaseId: string;
  operationId: string;
  tenantId: string;
  tenantKey: string;
  fencingToken: number;
  inventory: readonly TenantMigrationTableInventory[];
  records: readonly TenantMigrationOutboxRecord[];
  now: number;
}): Promise<{ appliedCount: number; lastAppliedSequence: number }> {
  if (input.records.length < 1 || input.records.length > MAX_OUTBOX_BATCH) {
    throw new Error('tenant_migration_outbox_batch_size_invalid');
  }
  const inventory = new Map(input.inventory.map((table) => [table.table, table]));
  let previousSequence = 0;
  for (const record of input.records) {
    if (
      record.sourceSequence <= previousSequence ||
      record.operationId !== input.operationId ||
      record.tenantId !== input.tenantId ||
      record.captureFencingToken !== input.fencingToken
    ) {
      throw new Error('tenant_migration_outbox_batch_identity_invalid');
    }
    previousSequence = record.sourceSequence;
    const table = inventory.get(record.tableName);
    if (!table || table.disposition !== 'migrate') {
      throw new Error('tenant_migration_outbox_table_unclassified');
    }
    const key = exactObject(
      record.mutationKey,
      table.primaryKey,
      'tenant_migration_outbox_mutation_key_invalid'
    );
    const keyValues = table.primaryKey.map((column) => key[column]);
    if (record.mutationKind === 'upsert') {
      if (!record.row) throw new Error('tenant_migration_outbox_row_json_invalid');
      const row = exactObject(
        record.row,
        table.columns.map((column) => column.name),
        'tenant_migration_outbox_row_json_invalid'
      );
      if (table.primaryKey.some((column) => row[column] !== key[column])) {
        throw new Error('tenant_migration_outbox_primary_key_mismatch');
      }
      const owner = validateUpsertOwner(table.ownership, row, input.tenantId, input.tenantKey);
      if (owner === false) throw new Error('tenant_migration_outbox_owner_mismatch');
      if (owner === 'parent_check') {
        await assertParentOwner({
          executor: input.executor,
          targetDatabaseId: input.targetDatabaseId,
          rule: table.ownership as Extract<TenantMigrationOwnershipRule, { kind: 'parent' }>,
          row,
          tenantId: input.tenantId,
        });
      }
      const result = await input.executor.queryD1(
        input.targetDatabaseId,
        upsertQuery(table, row).sql,
        upsertQuery(table, row).params
      );
      if (result.length !== 1 || result[0]?.success !== true) {
        throw new Error('tenant_migration_outbox_target_apply_failed');
      }
    } else {
      await assertDeleteOwner({
        executor: input.executor,
        targetDatabaseId: input.targetDatabaseId,
        table,
        keyValues,
        tenantId: input.tenantId,
        tenantKey: input.tenantKey,
      });
      const result = await input.executor.queryD1(
        input.targetDatabaseId,
        `DELETE FROM ${sqlIdentifier(table.table)} WHERE ${pkWhere(table)}`,
        keyValues
      );
      if (result.length !== 1 || result[0]?.success !== true) {
        throw new Error('tenant_migration_outbox_target_apply_failed');
      }
    }
  }

  const sequences = input.records.map((record) => record.sourceSequence);
  const acknowledgements = await input.executor.queryD1(
    input.sourceDatabaseId,
    `UPDATE tenant_placement_migration_outbox
        SET delivery_state = 'applied', applied_at = ?
      WHERE operation_id = ? AND tenant_id = ? AND capture_fencing_token = ?
        AND delivery_state = 'pending'
        AND source_sequence IN (${sequences.map(() => '?').join(', ')})`,
    [input.now, input.operationId, input.tenantId, input.fencingToken, ...sequences]
  );
  if (acknowledgements.length !== 1 || acknowledgements[0]?.success !== true) {
    throw new Error('tenant_migration_outbox_source_ack_failed');
  }
  return { appliedCount: input.records.length, lastAppliedSequence: previousSequence };
}

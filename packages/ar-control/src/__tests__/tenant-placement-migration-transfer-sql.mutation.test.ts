import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import type {
  TenantMigrationOwnershipRule,
  TenantMigrationTableInventory,
} from '../tenant-placement-migration-inventory';
import {
  applyTenantMigrationBackfillPage,
  buildTenantMigrationPurgeQuery,
  decodeTenantMigrationOutboxRows,
  readTenantMigrationBackfillPage,
  readTenantMigrationOutboxBatch,
} from '../tenant-placement-migration-transfer';

const ok = (results: unknown[] = []): CloudflareD1QueryResult[] => [{ success: true, results }];
const squash = (sql: string) => sql.replace(/\s+/gu, ' ').trim();

function executor(responses: CloudflareD1QueryResult[][] = []) {
  const queryD1 = vi.fn();
  for (const response of responses) queryD1.mockResolvedValueOnce(response);
  queryD1.mockResolvedValue(ok());
  return { queryD1, queryD1Batch: vi.fn() };
}

const column = (name: string) => ({ name }) as never;
function table(
  ownership: TenantMigrationOwnershipRule,
  overrides: Partial<TenantMigrationTableInventory> = {}
): TenantMigrationTableInventory {
  return {
    table: 'items',
    columns: ['id', 'tenant_id', 'payload'].map(column),
    primaryKey: ['id'],
    ownership,
    disposition: 'migrate',
    ...overrides,
  };
}
const TENANT_COLUMN: TenantMigrationOwnershipRule = { kind: 'tenant_column', column: 'tenant_id' };
const PARENT: TenantMigrationOwnershipRule = {
  kind: 'parent',
  foreignKeyColumn: 'event_id',
  parentTable: 'events',
  parentKeyColumn: 'id',
  parentTenantColumn: 'tenant_id',
};

describe('readTenantMigrationOutboxBatch', () => {
  const read = (exec: ReturnType<typeof executor>, extra: Record<string, unknown> = {}) =>
    readTenantMigrationOutboxBatch({
      executor: exec,
      sourceDatabaseId: 'source-db',
      operationId: 'op-1',
      tenantId: 'tenant-1',
      fencingToken: 4,
      afterSequence: 10,
      ...extra,
    });
  const row = (sequence: number, extra: Record<string, unknown> = {}) => ({
    source_sequence: sequence,
    operation_id: 'op-1',
    tenant_id: 'tenant-1',
    table_name: 'items',
    mutation_kind: 'upsert',
    mutation_key_json: '{"id":"a"}',
    row_json: '{"id":"a"}',
    capture_fencing_token: 4,
    ...extra,
  });

  it('queries pending rows after the sequence with a default limit of 100', async () => {
    const exec = executor([ok([row(11), row(12)])]);
    await expect(read(exec)).resolves.toEqual([
      {
        sourceSequence: 11,
        operationId: 'op-1',
        tenantId: 'tenant-1',
        tableName: 'items',
        mutationKind: 'upsert',
        mutationKey: { id: 'a' },
        row: { id: 'a' },
        captureFencingToken: 4,
      },
      expect.objectContaining({ sourceSequence: 12 }),
    ]);
    const [databaseId, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(databaseId).toBe('source-db');
    expect(squash(sql)).toBe(
      "SELECT source_sequence, operation_id, tenant_id, table_name, mutation_kind, mutation_key_json, row_json, capture_fencing_token FROM tenant_placement_migration_outbox WHERE operation_id = ? AND tenant_id = ? AND capture_fencing_token = ? AND delivery_state = 'pending' AND source_sequence > ? ORDER BY source_sequence LIMIT ?"
    );
    expect(params).toEqual(['op-1', 'tenant-1', 4, 10, 100]);
  });

  it('honours an explicit limit and rejects out of range limits', async () => {
    const exec = executor([ok()]);
    await read(exec, { limit: 7 });
    expect(exec.queryD1.mock.calls[0]?.[2]).toEqual(['op-1', 'tenant-1', 4, 10, 7]);
    for (const limit of [0, 101, 1.5, Number.NaN, -1]) {
      await expect(read(executor(), { limit })).rejects.toThrow(
        /^tenant_migration_outbox_limit_invalid$/u
      );
    }
    const exact = executor([ok()]);
    await read(exact, { limit: 100 });
    await read(exact, { limit: 1 });
  });

  it.each([
    ['no results array', [{ success: true }]],
    ['failed query', [{ success: false, results: [] }]],
    [
      'two results',
      [
        { success: true, results: [] },
        { success: true, results: [] },
      ],
    ],
    ['empty response', []],
    ['array row', [{ success: true, results: [[]] }]],
    ['null row', [{ success: true, results: [null] }]],
  ])('rejects an invalid response: %s', async (_name, response) => {
    await expect(
      read(executor([response as unknown as CloudflareD1QueryResult[]]))
    ).rejects.toThrow(/^tenant_migration_transfer_response_invalid$/u);
  });

  it('rejects batches over 100 rows', () => {
    const rows = Array.from({ length: 101 }, (_, index) => row(11 + index));
    expect(() =>
      decodeTenantMigrationOutboxRows(rows, {
        operationId: 'op-1',
        tenantId: 'tenant-1',
        fencingToken: 4,
        afterSequence: 10,
      })
    ).toThrow(/^tenant_migration_outbox_batch_too_large$/u);
    expect(
      decodeTenantMigrationOutboxRows(rows.slice(0, 100), {
        operationId: 'op-1',
        tenantId: 'tenant-1',
        fencingToken: 4,
        afterSequence: 10,
      })
    ).toHaveLength(100);
  });

  const decode = (rows: Record<string, unknown>[]) =>
    decodeTenantMigrationOutboxRows(rows, {
      operationId: 'op-1',
      tenantId: 'tenant-1',
      fencingToken: 4,
      afterSequence: 10,
    });

  it.each([
    ['sequence not after the cursor', { source_sequence: 10 }],
    ['fractional sequence', { source_sequence: 11.5 }],
    ['unsafe sequence', { source_sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['other operation', { operation_id: 'op-2' }],
    ['other tenant', { tenant_id: 'tenant-2' }],
    ['other fencing token', { capture_fencing_token: 5 }],
    ['non string table', { table_name: 5 }],
    ['uppercase table', { table_name: 'Items' }],
    ['digit first table', { table_name: '1items' }],
    ['table over 128 characters', { table_name: `a${'b'.repeat(128)}` }],
    ['unknown kind', { mutation_kind: 'merge' }],
    ['non string key', { mutation_key_json: {} }],
    ['non string row', { row_json: 5 }],
    ['upsert without row', { row_json: null }],
    ['delete with row', { mutation_kind: 'delete' }],
  ])('rejects a row with %s', (_name, patch) => {
    expect(() => decode([row(11, patch)])).toThrow(/^tenant_migration_outbox_row_invalid$/u);
  });

  it('accepts a delete without a row and a 128 character table name', () => {
    const decoded = decode([
      row(11, { mutation_kind: 'delete', row_json: null, table_name: `a${'b'.repeat(127)}` }),
    ]);
    expect(decoded[0]).toMatchObject({ mutationKind: 'delete', row: null });
  });

  it('requires strictly increasing sequences within the batch', () => {
    expect(() => decode([row(11), row(11)])).toThrow(/^tenant_migration_outbox_row_invalid$/u);
    expect(() => decode([row(12), row(11)])).toThrow(/^tenant_migration_outbox_row_invalid$/u);
    expect(decode([row(11), row(13)]).map((record) => record.sourceSequence)).toEqual([11, 13]);
  });

  it.each([
    ['key', { mutation_key_json: 'nope' }, 'tenant_migration_outbox_mutation_key_invalid'],
    ['key array', { mutation_key_json: '[]' }, 'tenant_migration_outbox_mutation_key_invalid'],
    ['key null', { mutation_key_json: 'null' }, 'tenant_migration_outbox_mutation_key_invalid'],
    ['row', { row_json: 'nope' }, 'tenant_migration_outbox_row_json_invalid'],
    ['row scalar', { row_json: '5' }, 'tenant_migration_outbox_row_json_invalid'],
    [
      'oversized row',
      { row_json: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }) },
      'tenant_migration_outbox_row_json_invalid',
    ],
    [
      'oversized key',
      { mutation_key_json: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }) },
      'tenant_migration_outbox_mutation_key_invalid',
    ],
  ])('rejects an unusable %s document', (_name, patch, code) => {
    expect(() => decode([row(11, patch)])).toThrow(new RegExp(`^${code}$`, 'u'));
  });
});

describe('readTenantMigrationBackfillPage', () => {
  const read = (exec: ReturnType<typeof executor>, extra: Record<string, unknown> = {}) =>
    readTenantMigrationBackfillPage({
      executor: exec,
      sourceDatabaseId: 'source-db',
      table: table(TENANT_COLUMN),
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      cursor: null,
      ...extra,
    });
  const item = (id: string) => ({ id, tenant_id: 'tenant-1', payload: `p-${id}` });

  it('selects owned rows ordered by primary key with the default limit', async () => {
    const exec = executor([ok([item('a'), item('b')])]);
    const page = await read(exec);
    expect(page).toEqual({ rows: [item('a'), item('b')], nextCursor: { id: 'b' }, done: true });
    const [databaseId, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(databaseId).toBe('source-db');
    expect(squash(sql)).toBe(
      'SELECT "id", "tenant_id", "payload" FROM "items" candidate WHERE (candidate."tenant_id" = ?) ORDER BY "id" LIMIT ?'
    );
    expect(params).toEqual(['tenant-1', 100]);
  });

  it('resumes after the cursor with a tuple comparison', async () => {
    const composite = table(TENANT_COLUMN, {
      columns: ['a', 'b', 'tenant_id'].map(column),
      primaryKey: ['a', 'b'],
    });
    const exec = executor([ok([{ a: 1, b: 3, tenant_id: 'tenant-1' }])]);
    const page = await read(exec, { table: composite, cursor: { b: 2, a: 1 }, limit: 5 });
    expect(page.nextCursor).toEqual({ a: 1, b: 3 });
    expect(page.done).toBe(true);
    const [, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(squash(sql)).toBe(
      'SELECT "a", "b", "tenant_id" FROM "items" candidate WHERE (candidate."tenant_id" = ?) AND ("a", "b") > (?, ?) ORDER BY "a", "b" LIMIT ?'
    );
    expect(params).toEqual(['tenant-1', 1, 2, 5]);
  });

  it('is not done when the page is full and keeps the cursor when it is empty', async () => {
    const full = await read(executor([ok([item('a'), item('b')])]), { limit: 2 });
    expect(full.done).toBe(false);
    expect(full.nextCursor).toEqual({ id: 'b' });
    const cursor = { id: 'z' };
    const empty = await read(executor([ok([])]), { cursor });
    expect(empty).toEqual({ rows: [], nextCursor: cursor, done: true });
    const noCursor = await read(executor([ok([])]));
    expect(noCursor.nextCursor).toBeNull();
  });

  it.each([
    ['tenant_row', { kind: 'tenant_row', column: 'id' }, 'candidate."id" = ?', ['tenant-1']],
    [
      'tenant_key',
      { kind: 'tenant_key', column: 'tenant_key' },
      'candidate."tenant_key" = ?',
      ['key-1'],
    ],
    [
      'tenant_or_key',
      { kind: 'tenant_or_key', tenantColumn: 'tenant_id', tenantKeyColumn: 'tenant_key' },
      '(candidate."tenant_id" = ? OR candidate."tenant_key" = ?)',
      ['tenant-1', 'key-1'],
    ],
    [
      'tenant_scope',
      { kind: 'tenant_scope', scopeTypeColumn: 'scope_type', scopeIdColumn: 'scope_id' },
      `(candidate."scope_type" = 'tenant' AND candidate."scope_id" = ?)`,
      ['tenant-1'],
    ],
    [
      'parent',
      PARENT,
      'EXISTS ( SELECT 1 FROM "events" parent WHERE parent."id" = candidate."event_id" AND parent."tenant_id" = ? )',
      ['tenant-1'],
    ],
  ])('builds the %s ownership predicate', async (_name, ownership, predicate, owner) => {
    const exec = executor([ok()]);
    await read(exec, { table: table(ownership as TenantMigrationOwnershipRule) });
    const [, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(squash(sql)).toContain(`WHERE (${predicate}) ORDER BY`);
    expect(params).toEqual([...owner, 100]);
  });

  it('refuses non migratable tables, bad limits, bad cursors and bad rows', async () => {
    await expect(
      read(executor(), { table: table(TENANT_COLUMN, { disposition: 'retain_target_local' }) })
    ).rejects.toThrow(/^tenant_migration_backfill_table_not_migratable$/u);
    for (const limit of [0, 101, 2.5]) {
      await expect(read(executor(), { limit })).rejects.toThrow(
        /^tenant_migration_backfill_limit_invalid$/u
      );
    }
    await expect(read(executor(), { cursor: { id: 'a', extra: 1 } })).rejects.toThrow(
      /^tenant_migration_backfill_cursor_invalid$/u
    );
    await expect(read(executor(), { cursor: {} })).rejects.toThrow(
      /^tenant_migration_backfill_cursor_invalid$/u
    );
    await expect(read(executor([ok([{ id: 'a' }])]))).rejects.toThrow(
      /^tenant_migration_backfill_row_invalid$/u
    );
    await expect(read(executor(), { table: table({ kind: 'shard_local' }) })).rejects.toThrow(
      /^tenant_migration_outbox_table_not_migratable$/u
    );
    await expect(
      read(executor(), { table: table(TENANT_COLUMN, { table: 'Items' }) })
    ).rejects.toThrow(/^tenant_migration_transfer_identifier_invalid$/u);
  });
});

describe('applyTenantMigrationBackfillPage', () => {
  const apply = (exec: ReturnType<typeof executor>, extra: Record<string, unknown> = {}) =>
    applyTenantMigrationBackfillPage({
      executor: exec,
      targetDatabaseId: 'target-db',
      table: table(TENANT_COLUMN),
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      rows: [{ id: 'a', tenant_id: 'tenant-1', payload: 'p' }],
      ...extra,
    });

  it('upserts each owned row and reports the count', async () => {
    const exec = executor();
    const rows = [
      { id: 'a', tenant_id: 'tenant-1', payload: 'p1' },
      { id: 'b', tenant_id: 'tenant-1', payload: 'p2' },
    ];
    await expect(apply(exec, { rows })).resolves.toBe(2);
    expect(exec.queryD1).toHaveBeenCalledTimes(2);
    const [databaseId, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(databaseId).toBe('target-db');
    expect(squash(sql)).toBe(
      'INSERT INTO "items" ("id", "tenant_id", "payload") VALUES (?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "tenant_id" = excluded."tenant_id", "payload" = excluded."payload" WHERE "items"."tenant_id" = ?'
    );
    expect(params).toEqual(['a', 'tenant-1', 'p1', 'tenant-1']);
    expect(exec.queryD1.mock.calls[1]?.[2]).toEqual(['b', 'tenant-1', 'p2', 'tenant-1']);
  });

  it('does nothing for no rows and refuses more than 100', async () => {
    const exec = executor();
    await expect(apply(exec, { rows: [] })).resolves.toBe(0);
    expect(exec.queryD1).not.toHaveBeenCalled();
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `r${index}`,
      tenant_id: 'tenant-1',
      payload: 'p',
    }));
    await expect(apply(exec, { rows })).rejects.toThrow(
      /^tenant_migration_backfill_batch_too_large$/u
    );
    await expect(apply(executor(), { rows: rows.slice(0, 100) })).resolves.toBe(100);
  });

  it('uses DO NOTHING for tables made only of key columns', async () => {
    const exec = executor();
    await apply(exec, {
      table: table({ kind: 'tenant_row', column: 'id' }, { columns: ['id'].map(column) }),
      rows: [{ id: 'a' }],
      tenantId: 'a',
    });
    expect(squash(exec.queryD1.mock.calls[0]?.[1] as string)).toContain(
      'ON CONFLICT ("id") DO NOTHING'
    );
  });

  it('binds blob values as hexadecimal literals, never as JSON encoded byte arrays', async () => {
    const exec = executor();
    await apply(exec, {
      rows: [{ id: 'a', tenant_id: 'tenant-1', payload: { $authrim_blob_hex: '00FF10' } }],
    });
    const [, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(squash(sql)).toContain("VALUES (?, ?, X'00ff10')");
    expect(params).toEqual(['a', 'tenant-1', 'tenant-1']);
    expect(JSON.stringify(params)).toBe('["a","tenant-1","tenant-1"]');
  });

  it.each([
    ['lowercase hex', { $authrim_blob_hex: 'ff' }],
    ['odd length', { $authrim_blob_hex: 'F' }],
    ['non hex', { $authrim_blob_hex: 'GG' }],
  ])('rejects a malformed blob (%s)', async (_name, value) => {
    await expect(
      apply(executor(), { rows: [{ id: 'a', tenant_id: 'tenant-1', payload: value }] })
    ).rejects.toThrow(/^tenant_migration_outbox_blob_invalid$/u);
  });

  it.each([
    ['object', { nested: true }],
    ['array', [1]],
    ['blob with extra key', { $authrim_blob_hex: 'FF', extra: 1 }],
    ['blob with non string', { $authrim_blob_hex: 5 }],
    ['undefined', undefined],
    ['function', () => 1],
  ])('rejects the unsupported value %s', async (_name, value) => {
    await expect(
      apply(executor(), { rows: [{ id: 'a', tenant_id: 'tenant-1', payload: value }] })
    ).rejects.toThrow(/^tenant_migration_outbox_value_invalid$/u);
  });

  it('accepts null, strings, numbers, booleans and byte arrays', async () => {
    const bytes = Uint8Array.from([1]);
    for (const value of [null, 's', 5, true, false]) {
      const exec = executor();
      await apply(exec, { rows: [{ id: 'a', tenant_id: 'tenant-1', payload: value }] });
      expect((exec.queryD1.mock.calls[0]?.[2] as unknown[])[2]).toEqual(value);
    }
    const exec = executor();
    await apply(exec, { rows: [{ id: 'a', tenant_id: 'tenant-1', payload: bytes }] });
    expect(squash(String(exec.queryD1.mock.calls[0]?.[1]))).toContain("X'01'");
  });

  it.each([
    ['extra column', { id: 'a', tenant_id: 'tenant-1', payload: 'p', extra: 1 }],
    ['missing column', { id: 'a', tenant_id: 'tenant-1' }],
  ])('rejects a row with a %s', async (_name, row) => {
    await expect(apply(executor(), { rows: [row] })).rejects.toThrow(
      /^tenant_migration_backfill_row_invalid$/u
    );
  });

  it.each([
    [
      'tenant_column',
      TENANT_COLUMN,
      { id: 'tenant-1', tenant_id: 'other', payload: 'p' },
      { id: 'a', tenant_id: 'tenant-1', payload: 'p' },
    ],
    [
      'tenant_row',
      { kind: 'tenant_row', column: 'id' },
      { id: 'other', tenant_id: 'x', payload: 'p' },
      { id: 'tenant-1', tenant_id: 'x', payload: 'p' },
    ],
    [
      'tenant_key',
      { kind: 'tenant_key', column: 'tenant_key' },
      { id: 'a', tenant_key: 'other' },
      { id: 'a', tenant_key: 'key-1' },
    ],
    [
      'tenant_or_key',
      {
        kind: 'tenant_or_key',
        tenantColumn: 'tenant_id',
        tenantKeyColumn: 'tenant_key',
      },
      { id: 'a', tenant_id: 'other', tenant_key: 'other' },
      { id: 'a', tenant_id: 'other', tenant_key: 'key-1' },
    ],
    [
      'tenant_scope',
      {
        kind: 'tenant_scope',
        scopeTypeColumn: 'scope_type',
        scopeIdColumn: 'scope_id',
      },
      { id: 'a', scope_type: 'global', scope_id: 'tenant-1' },
      { id: 'a', scope_type: 'tenant', scope_id: 'tenant-1' },
    ],
  ])('enforces %s ownership', async (_name, ownership, bad, good) => {
    const columns = Object.keys(good).map(column);
    const subject = table(ownership as TenantMigrationOwnershipRule, { columns });
    await expect(apply(executor(), { table: subject, rows: [bad] })).rejects.toThrow(
      /^tenant_migration_backfill_owner_mismatch$/u
    );
    await expect(apply(executor(), { table: subject, rows: [good] })).resolves.toBe(1);
  });

  it('accepts a tenant_or_key row owned only through the tenant column', async () => {
    const subject = table(
      { kind: 'tenant_or_key', tenantColumn: 'tenant_id', tenantKeyColumn: 'tenant_key' },
      { columns: ['id', 'tenant_id', 'tenant_key'].map(column) }
    );
    await expect(
      apply(executor(), {
        table: subject,
        rows: [{ id: 'a', tenant_id: 'tenant-1', tenant_key: 'x' }],
      })
    ).resolves.toBe(1);
  });

  it('never applies rows of tables without a tenant owner', async () => {
    for (const ownership of [{ kind: 'shard_local' }, { kind: 'global_reference' }] as const) {
      await expect(apply(executor(), { table: table(ownership) })).rejects.toThrow(
        /^tenant_migration_backfill_owner_mismatch$/u
      );
    }
  });

  it('verifies the parent owner on the target before inserting child rows', async () => {
    const child = table(PARENT, { columns: ['id', 'event_id'].map(column) });
    const exec = executor([ok([{ owner_match: 1 }])]);
    await apply(exec, { table: child, rows: [{ id: 'c', event_id: 'event-1' }] });
    const [databaseId, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(databaseId).toBe('target-db');
    expect(squash(sql)).toBe(
      'SELECT 1 AS owner_match FROM "events" WHERE "id" = ? AND "tenant_id" = ? LIMIT 1'
    );
    expect(params).toEqual(['event-1', 'tenant-1']);
    expect(exec.queryD1).toHaveBeenCalledTimes(2);
    for (const response of [
      ok([]),
      ok([{ owner_match: 0 }]),
      ok([{ owner_match: 1 }, { owner_match: 1 }]),
    ]) {
      const rejecting = executor([response]);
      await expect(
        apply(rejecting, { table: child, rows: [{ id: 'c', event_id: 'event-1' }] })
      ).rejects.toThrow(/^tenant_migration_outbox_parent_owner_mismatch$/u);
      expect(rejecting.queryD1).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['empty response', []],
    ['failed', [{ success: false }]],
    ['two results', [{ success: true }, { success: true }]],
  ])('fails the page when the target apply returns %s', async (_name, response) => {
    await expect(
      apply(executor([response as unknown as CloudflareD1QueryResult[]]))
    ).rejects.toThrow(/^tenant_migration_backfill_target_apply_failed$/u);
  });
});

describe('buildTenantMigrationPurgeQuery', () => {
  const build = (extra: Record<string, unknown> = {}) =>
    buildTenantMigrationPurgeQuery({
      table: table(TENANT_COLUMN),
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      ...extra,
    });

  it('deletes owned rows by primary key in bounded slices', () => {
    const query = build();
    expect(squash(query.sql)).toBe(
      'WITH purge_keys AS ( SELECT candidate."id" FROM "items" AS candidate WHERE candidate."tenant_id" = ? ORDER BY candidate."id" LIMIT ? ) DELETE FROM "items" AS source_row WHERE EXISTS (SELECT 1 FROM purge_keys WHERE purge_keys."id" IS source_row."id")'
    );
    expect(query.params).toEqual(['tenant-1', 100]);
  });

  it('supports composite keys, key based ownership and an explicit limit', () => {
    const composite = table(
      { kind: 'tenant_or_key', tenantColumn: 'tenant_id', tenantKeyColumn: 'tenant_key' },
      {
        primaryKey: ['a', 'b'],
        columns: ['a', 'b', 'tenant_id', 'tenant_key'].map(column),
      }
    );
    const query = build({ table: composite, limit: 3 });
    expect(squash(query.sql)).toContain('SELECT candidate."a", candidate."b" FROM');
    expect(squash(query.sql)).toContain('ORDER BY candidate."a", candidate."b" LIMIT ?');
    expect(squash(query.sql)).toContain(
      'purge_keys."a" IS source_row."a" AND purge_keys."b" IS source_row."b"'
    );
    expect(query.params).toEqual(['tenant-1', 'key-1', 3]);
    expect(build({ limit: 100 }).params).toEqual(['tenant-1', 100]);
    expect(build({ limit: 1 }).params).toEqual(['tenant-1', 1]);
  });

  it.each([
    ['retained table', { table: table(TENANT_COLUMN, { disposition: 'retain_target_local' }) }],
    ['no primary key', { table: table(TENANT_COLUMN, { primaryKey: [] }) }],
    ['zero limit', { limit: 0 }],
    ['oversized limit', { limit: 101 }],
    ['fractional limit', { limit: 1.5 }],
  ])('rejects %s', (_name, patch) => {
    expect(() => build(patch)).toThrow(/^tenant_migration_purge_input_invalid$/u);
  });

  it('rejects ownership kinds that cannot be purged by tenant', () => {
    expect(() => build({ table: table({ kind: 'shard_local' }) })).toThrow(
      /^tenant_migration_outbox_table_not_migratable$/u
    );
  });
});

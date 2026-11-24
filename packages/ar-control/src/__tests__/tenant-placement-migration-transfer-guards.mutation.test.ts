import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import type {
  TenantMigrationOwnershipRule,
  TenantMigrationTableInventory,
} from '../tenant-placement-migration-inventory';
import {
  applyTenantMigrationBackfillPage,
  applyTenantMigrationOutboxBatch,
  decodeTenantMigrationOutboxRows,
  readTenantMigrationBackfillPage,
  readTenantMigrationOutboxBatch,
  type TenantMigrationOutboxRecord,
} from '../tenant-placement-migration-transfer';

const ok = (results: unknown[] = []): CloudflareD1QueryResult[] => [{ success: true, results }];
const column = (name: string) => ({ name }) as never;

function executor(responses: CloudflareD1QueryResult[][] = []) {
  const queryD1 = vi.fn();
  for (const response of responses) queryD1.mockResolvedValueOnce(response);
  queryD1.mockResolvedValue(ok());
  return { queryD1, queryD1Batch: vi.fn() };
}

const tenantColumn: TenantMigrationOwnershipRule = { kind: 'tenant_column', column: 'tenant_id' };
const table = (
  overrides: Partial<TenantMigrationTableInventory> = {},
  ownership: TenantMigrationOwnershipRule = tenantColumn
): TenantMigrationTableInventory => ({
  table: 'items',
  columns: ['id', 'tenant_id', 'payload'].map(column),
  primaryKey: ['id'],
  ownership,
  disposition: 'migrate',
  ...overrides,
});

describe('identifier safety', () => {
  it.each([
    ['trailing statement', 'items; DROP TABLE users'],
    ['quote', 'items"'],
    ['trailing newline', 'items\n'],
    ['space', 'items x'],
    ['uppercase', 'Items'],
    ['leading digit', '1items'],
    ['leading underscore', '_items'],
    ['dash', 'it-ems'],
    ['empty', ''],
    ['129 characters', `a${'b'.repeat(128)}`],
  ])('never interpolates a table named with %s', async (_name, name) => {
    const exec = executor([ok()]);
    await expect(
      readTenantMigrationBackfillPage({
        executor: exec,
        sourceDatabaseId: 'source-db',
        table: table({ table: name }),
        tenantId: 'tenant-1',
        tenantKey: 'key-1',
        cursor: null,
      })
    ).rejects.toThrow(/^tenant_migration_transfer_identifier_invalid$/u);
    expect(exec.queryD1).not.toHaveBeenCalled();
  });

  it('accepts a 128 character table name and underscores and digits after the first letter', async () => {
    const name = `a${'b_1'.repeat(42)}b`.slice(0, 128);
    expect(name).toHaveLength(128);
    const exec = executor([ok()]);
    await readTenantMigrationBackfillPage({
      executor: exec,
      sourceDatabaseId: 'source-db',
      table: table({ table: name }),
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      cursor: null,
    });
    expect(String(exec.queryD1.mock.calls[0]?.[1])).toContain(`FROM "${name}" candidate`);
  });

  it('rejects an unsafe column name', async () => {
    await expect(
      readTenantMigrationBackfillPage({
        executor: executor([ok()]),
        sourceDatabaseId: 'source-db',
        table: table({ columns: ['id", "x'].map(column) }),
        tenantId: 'tenant-1',
        tenantKey: 'key-1',
        cursor: null,
      })
    ).rejects.toThrow(/^tenant_migration_transfer_identifier_invalid$/u);
  });
});

describe('document and cursor shape', () => {
  const read = (cursor: Record<string, unknown> | null, composite = false) =>
    readTenantMigrationBackfillPage({
      executor: executor([ok()]),
      sourceDatabaseId: 'source-db',
      table: composite
        ? table({ primaryKey: ['a', 'b'], columns: ['a', 'b', 'tenant_id'].map(column) })
        : table(),
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      cursor,
    });

  it.each([
    ['a differently named key', { other: 'a' }, false],
    ['one right and one wrong key', { a: 1, c: 2 }, true],
    ['only one of two keys', { a: 1 }, true],
  ])('rejects a cursor with %s', async (_name, cursor, composite) => {
    await expect(read(cursor, composite)).rejects.toThrow(
      /^tenant_migration_backfill_cursor_invalid$/u
    );
  });

  it('accepts a cursor naming every key column in any order', async () => {
    await expect(read({ b: 2, a: 1 }, true)).resolves.toMatchObject({ done: true });
  });

  it('rejects scalar rows from the database', async () => {
    const exec = executor([[{ success: true, results: ['text'] }] as never]);
    await expect(
      readTenantMigrationBackfillPage({
        executor: exec,
        sourceDatabaseId: 'source-db',
        table: table(),
        tenantId: 'tenant-1',
        tenantKey: 'key-1',
        cursor: null,
      })
    ).rejects.toThrow(/^tenant_migration_transfer_response_invalid$/u);
  });

  it('parses a key and row document of exactly one megabyte and refuses one byte more', () => {
    const expected = {
      operationId: 'op-1',
      tenantId: 'tenant-1',
      fencingToken: 4,
      afterSequence: 0,
    };
    const sized = (bytes: number) => `{"pad":"${'x'.repeat(bytes - 10)}"}`;
    const base = {
      source_sequence: 1,
      operation_id: 'op-1',
      tenant_id: 'tenant-1',
      table_name: 'items',
      mutation_kind: 'upsert',
      capture_fencing_token: 4,
    };
    const limit = 1024 * 1024;
    expect(
      decodeTenantMigrationOutboxRows(
        [{ ...base, mutation_key_json: sized(limit), row_json: sized(limit) }],
        expected
      )
    ).toHaveLength(1);
    expect(() =>
      decodeTenantMigrationOutboxRows(
        [{ ...base, mutation_key_json: sized(limit + 1), row_json: '{}' }],
        expected
      )
    ).toThrow(/^tenant_migration_outbox_mutation_key_invalid$/u);
    expect(() =>
      decodeTenantMigrationOutboxRows(
        [{ ...base, mutation_key_json: '{}', row_json: sized(limit + 1) }],
        expected
      )
    ).toThrow(/^tenant_migration_outbox_row_json_invalid$/u);
  });

  it('refuses to read the outbox with a limit of zero without querying', async () => {
    const exec = executor();
    await expect(
      readTenantMigrationOutboxBatch({
        executor: exec,
        sourceDatabaseId: 'source-db',
        operationId: 'op-1',
        tenantId: 'tenant-1',
        fencingToken: 4,
        afterSequence: 0,
        limit: 0,
      })
    ).rejects.toThrow(/^tenant_migration_outbox_limit_invalid$/u);
    expect(exec.queryD1).not.toHaveBeenCalled();
  });
});

describe('ownership edge cases', () => {
  const scope: TenantMigrationOwnershipRule = {
    kind: 'tenant_scope',
    scopeTypeColumn: 'scope_type',
    scopeIdColumn: 'scope_id',
  };
  const scoped = table({ columns: ['id', 'scope_type', 'scope_id'].map(column) }, scope);
  const backfill = (row: Record<string, unknown>) =>
    applyTenantMigrationBackfillPage({
      executor: executor(),
      targetDatabaseId: 'target-db',
      table: scoped,
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      rows: [row],
    });

  it('requires both the tenant scope type and the tenant id', async () => {
    await expect(backfill({ id: 'a', scope_type: 'tenant', scope_id: 'other' })).rejects.toThrow(
      /^tenant_migration_backfill_owner_mismatch$/u
    );
    await expect(backfill({ id: 'a', scope_type: 'global', scope_id: 'tenant-1' })).rejects.toThrow(
      /^tenant_migration_backfill_owner_mismatch$/u
    );
    await expect(backfill({ id: 'a', scope_type: 'tenant', scope_id: 'tenant-1' })).resolves.toBe(
      1
    );
  });

  it('upserts composite keys with a comma separated conflict target', async () => {
    const composite = table({
      primaryKey: ['a', 'b'],
      columns: ['a', 'b', 'tenant_id'].map(column),
    });
    const exec = executor();
    await applyTenantMigrationBackfillPage({
      executor: exec,
      targetDatabaseId: 'target-db',
      table: composite,
      tenantId: 'tenant-1',
      tenantKey: 'key-1',
      rows: [{ a: 1, b: 2, tenant_id: 'tenant-1' }],
    });
    expect(String(exec.queryD1.mock.calls[0]?.[1])).toContain(
      'ON CONFLICT ("a", "b") DO UPDATE SET "tenant_id"'
    );
  });

  it('rejects an outbox row whose key differs in any single key column', async () => {
    const composite = table({
      primaryKey: ['a', 'b'],
      columns: ['a', 'b', 'tenant_id'].map(column),
    });
    const record = (row: Record<string, unknown>): TenantMigrationOutboxRecord => ({
      sourceSequence: 1,
      operationId: 'op-1',
      tenantId: 'tenant-1',
      tableName: 'items',
      mutationKind: 'upsert',
      mutationKey: { a: 1, b: 2 },
      row,
      captureFencingToken: 4,
    });
    const apply = (row: Record<string, unknown>) =>
      applyTenantMigrationOutboxBatch({
        executor: executor(),
        sourceDatabaseId: 'source-db',
        targetDatabaseId: 'target-db',
        operationId: 'op-1',
        tenantId: 'tenant-1',
        tenantKey: 'key-1',
        fencingToken: 4,
        inventory: [composite],
        records: [record(row)],
        now: 1,
      });
    await expect(apply({ a: 1, b: 3, tenant_id: 'tenant-1' })).rejects.toThrow(
      /^tenant_migration_outbox_primary_key_mismatch$/u
    );
    await expect(apply({ a: 9, b: 2, tenant_id: 'tenant-1' })).rejects.toThrow(
      /^tenant_migration_outbox_primary_key_mismatch$/u
    );
    await expect(apply({ a: 1, b: 2, tenant_id: 'tenant-1' })).resolves.toMatchObject({
      appliedCount: 1,
    });
  });
});

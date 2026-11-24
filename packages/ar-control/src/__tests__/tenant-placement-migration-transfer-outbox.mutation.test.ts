import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import type {
  TenantMigrationOwnershipRule,
  TenantMigrationTableInventory,
} from '../tenant-placement-migration-inventory';
import {
  applyTenantMigrationOutboxBatch,
  type TenantMigrationOutboxRecord,
} from '../tenant-placement-migration-transfer';

const ok = (results: unknown[] = []): CloudflareD1QueryResult[] => [{ success: true, results }];
const squash = (sql: string) => sql.replace(/\s+/gu, ' ').trim();
const column = (name: string) => ({ name }) as never;

function executor(responses: CloudflareD1QueryResult[][] = []) {
  const queryD1 = vi.fn();
  for (const response of responses) queryD1.mockResolvedValueOnce(response);
  queryD1.mockResolvedValue(ok());
  return { queryD1, queryD1Batch: vi.fn() };
}

const ITEMS = (ownership: TenantMigrationOwnershipRule): TenantMigrationTableInventory => ({
  table: 'items',
  columns: ['id', 'tenant_id', 'payload'].map(column),
  primaryKey: ['id'],
  ownership,
  disposition: 'migrate',
});
const TENANT_COLUMN: TenantMigrationOwnershipRule = { kind: 'tenant_column', column: 'tenant_id' };

function record(
  sequence: number,
  overrides: Partial<TenantMigrationOutboxRecord> = {}
): TenantMigrationOutboxRecord {
  return {
    sourceSequence: sequence,
    operationId: 'op-1',
    tenantId: 'tenant-1',
    tableName: 'items',
    mutationKind: 'upsert',
    mutationKey: { id: `k${sequence}` },
    row: { id: `k${sequence}`, tenant_id: 'tenant-1', payload: `p${sequence}` },
    captureFencingToken: 4,
    ...overrides,
  };
}
const remove = (sequence: number): TenantMigrationOutboxRecord =>
  record(sequence, { mutationKind: 'delete', row: null });

function apply(
  exec: ReturnType<typeof executor>,
  records: TenantMigrationOutboxRecord[],
  extra: Record<string, unknown> = {}
) {
  return applyTenantMigrationOutboxBatch({
    executor: exec,
    sourceDatabaseId: 'source-db',
    targetDatabaseId: 'target-db',
    operationId: 'op-1',
    tenantId: 'tenant-1',
    tenantKey: 'key-1',
    fencingToken: 4,
    inventory: [ITEMS(TENANT_COLUMN)],
    records,
    now: 1_800_000_000,
    ...extra,
  });
}

describe('applyTenantMigrationOutboxBatch upserts', () => {
  it('applies each record to the target and acknowledges them on the source', async () => {
    const exec = executor();
    await expect(apply(exec, [record(11), record(12)])).resolves.toEqual({
      appliedCount: 2,
      lastAppliedSequence: 12,
    });
    expect(exec.queryD1).toHaveBeenCalledTimes(3);
    const [databaseId, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(databaseId).toBe('target-db');
    expect(squash(sql)).toBe(
      'INSERT INTO "items" ("id", "tenant_id", "payload") VALUES (?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "tenant_id" = excluded."tenant_id", "payload" = excluded."payload" WHERE "items"."tenant_id" = ?'
    );
    expect(params).toEqual(['k11', 'tenant-1', 'p11', 'tenant-1']);
    const [ackDatabase, ackSql, ackParams] = exec.queryD1.mock.calls[2] as [
      string,
      string,
      unknown[],
    ];
    expect(ackDatabase).toBe('source-db');
    expect(squash(ackSql)).toBe(
      "UPDATE tenant_placement_migration_outbox SET delivery_state = 'applied', applied_at = ? WHERE operation_id = ? AND tenant_id = ? AND capture_fencing_token = ? AND delivery_state = 'pending' AND source_sequence IN (?, ?)"
    );
    expect(ackParams).toEqual([1_800_000_000, 'op-1', 'tenant-1', 4, 11, 12]);
  });

  it('acknowledges in chunks of ninety sequences', async () => {
    const exec = executor();
    const records = Array.from({ length: 100 }, (_, index) => record(index + 1));
    await expect(apply(exec, records)).resolves.toEqual({
      appliedCount: 100,
      lastAppliedSequence: 100,
    });
    const acknowledgements = exec.queryD1.mock.calls.filter((call) => call[0] === 'source-db');
    expect(acknowledgements).toHaveLength(2);
    expect((acknowledgements[0]?.[2] as unknown[]).slice(4)).toEqual(
      Array.from({ length: 90 }, (_, index) => index + 1)
    );
    expect((acknowledgements[1]?.[2] as unknown[]).slice(4)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 91)
    );
    const ninety = executor();
    await apply(
      ninety,
      Array.from({ length: 90 }, (_, index) => record(index + 1))
    );
    expect(ninety.queryD1.mock.calls.filter((call) => call[0] === 'source-db')).toHaveLength(1);
  });

  it.each([[0], [101]])('rejects a batch of %i records', async (count) => {
    const records = Array.from({ length: count }, (_, index) => record(index + 1));
    await expect(apply(executor(), records)).rejects.toThrow(
      /^tenant_migration_outbox_batch_size_invalid$/u
    );
  });

  it.each([
    ['other operation', { operationId: 'op-2' }],
    ['other tenant', { tenantId: 'tenant-2' }],
    ['other fencing token', { captureFencingToken: 5 }],
    ['sequence zero', { sourceSequence: 0 }],
  ])('rejects a record from %s before any write', async (_name, patch) => {
    const exec = executor();
    await expect(apply(exec, [record(11, patch)])).rejects.toThrow(
      /^tenant_migration_outbox_batch_identity_invalid$/u
    );
    expect(exec.queryD1).not.toHaveBeenCalled();
  });

  it('requires strictly increasing sequences', async () => {
    await expect(apply(executor(), [record(5), record(5)])).rejects.toThrow(
      /^tenant_migration_outbox_batch_identity_invalid$/u
    );
    await expect(apply(executor(), [record(6), record(5)])).rejects.toThrow(
      /^tenant_migration_outbox_batch_identity_invalid$/u
    );
  });

  it('rejects unclassified and retained tables', async () => {
    await expect(apply(executor(), [record(1, { tableName: 'other' })])).rejects.toThrow(
      /^tenant_migration_outbox_table_unclassified$/u
    );
    const retained = { ...ITEMS(TENANT_COLUMN), disposition: 'retain_target_local' } as never;
    await expect(apply(executor(), [record(1)], { inventory: [retained] })).rejects.toThrow(
      /^tenant_migration_outbox_table_unclassified$/u
    );
  });

  it('validates the mutation key and the row document', async () => {
    await expect(
      apply(executor(), [record(1, { mutationKey: { id: 'a', extra: 1 } })])
    ).rejects.toThrow(/^tenant_migration_outbox_mutation_key_invalid$/u);
    await expect(apply(executor(), [record(1, { mutationKey: {} })])).rejects.toThrow(
      /^tenant_migration_outbox_mutation_key_invalid$/u
    );
    await expect(apply(executor(), [record(1, { row: null })])).rejects.toThrow(
      /^tenant_migration_outbox_row_json_invalid$/u
    );
    await expect(
      apply(executor(), [record(1, { row: { id: 'k1', tenant_id: 'tenant-1' } })])
    ).rejects.toThrow(/^tenant_migration_outbox_row_json_invalid$/u);
    await expect(
      apply(executor(), [
        record(1, { row: { id: 'k1', tenant_id: 'tenant-1', payload: 'p', extra: 1 } }),
      ])
    ).rejects.toThrow(/^tenant_migration_outbox_row_json_invalid$/u);
  });

  it('requires the row key to equal the mutation key', async () => {
    await expect(
      apply(executor(), [
        record(1, {
          mutationKey: { id: 'a' },
          row: { id: 'b', tenant_id: 'tenant-1', payload: 'p' },
        }),
      ])
    ).rejects.toThrow(/^tenant_migration_outbox_primary_key_mismatch$/u);
  });

  it('rejects rows owned by another tenant and tables without tenant ownership', async () => {
    await expect(
      apply(executor(), [record(1, { row: { id: 'k1', tenant_id: 'other', payload: 'p' } })])
    ).rejects.toThrow(/^tenant_migration_outbox_owner_mismatch$/u);
    await expect(
      apply(executor(), [record(1)], { inventory: [ITEMS({ kind: 'shard_local' })] })
    ).rejects.toThrow(/^tenant_migration_outbox_owner_mismatch$/u);
  });

  it.each([
    ['empty', []],
    ['failed', [{ success: false }]],
    ['two results', [{ success: true }, { success: true }]],
  ])('fails when the target answers %s', async (_name, response) => {
    await expect(
      apply(executor([response as unknown as CloudflareD1QueryResult[]]), [record(1)])
    ).rejects.toThrow(/^tenant_migration_outbox_target_apply_failed$/u);
  });

  it.each([
    ['empty', []],
    ['failed', [{ success: false }]],
    ['two results', [{ success: true }, { success: true }]],
  ])('fails when the source acknowledgement answers %s', async (_name, response) => {
    const exec = executor([ok(), response]);
    await expect(apply(exec, [record(1)])).rejects.toThrow(
      /^tenant_migration_outbox_source_ack_failed$/u
    );
  });

  it('checks the parent owner before upserting child rows', async () => {
    const child = {
      table: 'children',
      columns: ['id', 'event_id'].map(column),
      primaryKey: ['id'],
      ownership: {
        kind: 'parent',
        foreignKeyColumn: 'event_id',
        parentTable: 'events',
        parentKeyColumn: 'id',
        parentTenantColumn: 'tenant_id',
      },
      disposition: 'migrate',
    } as unknown as TenantMigrationTableInventory;
    const exec = executor([ok([{ owner_match: 1 }])]);
    await apply(
      exec,
      [
        record(1, {
          tableName: 'children',
          mutationKey: { id: 'c' },
          row: { id: 'c', event_id: 'e1' },
        }),
      ],
      { inventory: [child] }
    );
    expect(exec.queryD1.mock.calls[0]?.[2]).toEqual(['e1', 'tenant-1']);
    expect(squash(exec.queryD1.mock.calls[1]?.[1] as string)).toContain('INSERT INTO "children"');
    const rejecting = executor([ok([{ owner_match: 0 }])]);
    await expect(
      apply(
        rejecting,
        [
          record(1, {
            tableName: 'children',
            mutationKey: { id: 'c' },
            row: { id: 'c', event_id: 'e1' },
          }),
        ],
        { inventory: [child] }
      )
    ).rejects.toThrow(/^tenant_migration_outbox_parent_owner_mismatch$/u);
    expect(rejecting.queryD1).toHaveBeenCalledTimes(1);
  });
});

describe('applyTenantMigrationOutboxBatch deletes', () => {
  const ownerRow = (exists: unknown, match: unknown) =>
    ok([{ row_exists: exists, owner_match: match }]);

  it('checks ownership then deletes by primary key', async () => {
    const exec = executor([ownerRow(1, 1)]);
    await expect(apply(exec, [remove(11)])).resolves.toEqual({
      appliedCount: 1,
      lastAppliedSequence: 11,
    });
    const [databaseId, sql, params] = exec.queryD1.mock.calls[0] as [string, string, unknown[]];
    expect(databaseId).toBe('target-db');
    expect(squash(sql)).toBe(
      'SELECT EXISTS (SELECT 1 FROM "items" candidate WHERE "id" = ?) AS row_exists, EXISTS ( SELECT 1 FROM "items" candidate WHERE "id" = ? AND (candidate."tenant_id" = ?) ) AS owner_match'
    );
    expect(params).toEqual(['k11', 'k11', 'tenant-1']);
    const [deleteDatabase, deleteSql, deleteParams] = exec.queryD1.mock.calls[1] as [
      string,
      string,
      unknown[],
    ];
    expect(deleteDatabase).toBe('target-db');
    expect(deleteSql).toBe('DELETE FROM "items" WHERE "id" = ?');
    expect(deleteParams).toEqual(['k11']);
  });

  it('deletes by every primary key column in order', async () => {
    const composite = {
      ...ITEMS(TENANT_COLUMN),
      primaryKey: ['payload', 'id'],
    };
    const exec = executor([ownerRow(0, 0)]);
    await apply(exec, [{ ...remove(1), mutationKey: { id: 'a', payload: 'b' } }], {
      inventory: [composite],
    });
    expect(exec.queryD1.mock.calls[1]?.[1]).toBe(
      'DELETE FROM "items" WHERE "payload" = ? AND "id" = ?'
    );
    expect(exec.queryD1.mock.calls[1]?.[2]).toEqual(['b', 'a']);
  });

  it('allows deleting a row that is already gone', async () => {
    const exec = executor([ownerRow(0, 0)]);
    await expect(apply(exec, [remove(11)])).resolves.toMatchObject({ appliedCount: 1 });
    expect(exec.queryD1.mock.calls[1]?.[1]).toContain('DELETE FROM');
  });

  it('refuses to delete a row owned by someone else', async () => {
    const exec = executor([ownerRow(1, 0)]);
    await expect(apply(exec, [remove(11)])).rejects.toThrow(
      /^tenant_migration_outbox_owner_mismatch$/u
    );
    expect(exec.queryD1).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no rows', ok([])],
    ['bad exists flag', ownerRow(2, 1)],
    ['bad match flag', ownerRow(1, '1')],
    ['null flags', ownerRow(null, null)],
  ])('rejects an owner check answering %s', async (_name, response) => {
    await expect(apply(executor([response]), [remove(11)])).rejects.toThrow(
      /^tenant_migration_outbox_owner_response_invalid$/u
    );
  });

  it.each([
    ['empty', []],
    ['failed', [{ success: false }]],
    ['two results', [{ success: true }, { success: true }]],
  ])('fails when the delete answers %s', async (_name, response) => {
    const exec = executor([ownerRow(1, 1), response]);
    await expect(apply(exec, [remove(11)])).rejects.toThrow(
      /^tenant_migration_outbox_target_apply_failed$/u
    );
  });
});

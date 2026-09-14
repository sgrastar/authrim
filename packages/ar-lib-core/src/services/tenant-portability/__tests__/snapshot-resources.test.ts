import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupSnapshotResources } from '../snapshot-resources';
import { SQLITE_SNAPSHOT_SCHEMA } from '../sqlite-snapshot';
import { executeTenantBackupSlice } from '../operation-executor';
import { TenantBackupOperationStore, type TenantBackupLease } from '../operation-store';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
let store: TenantBackupOperationStore;
let lease: TenantBackupLease;
let resources: TenantBackupSnapshotResources;
let now: number;
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '011_tenant_backup_snapshot_resources.sql',
  ])
    db.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  store = new TenantBackupOperationStore(adapter);
  await store.create({
    id: 'op',
    tenantId: 'a',
    kind: 'export',
    idempotencyKey: 'request',
    requestDigest: 'a'.repeat(64),
    actorId: 'admin',
    now: 100,
  });
  const operation = await store.claim('a', 'op', 'worker', 101);
  if (!operation) throw new Error('missing_lease');
  lease = {
    tenantId: 'a',
    operationId: 'op',
    owner: 'worker',
    fencingToken: operation.fencing_token,
  };
  now = 102;
  resources = new TenantBackupSnapshotResources(adapter, () => now);
  db.exec(SQLITE_SNAPSHOT_SCHEMA);
});
afterEach(() => db.close());

it('reserves before source start and cancellation rejects a late start', async () => {
  await resources.reserve(lease, 'physical-a', 'snapshot-a');
  await resources.reserve(lease, 'physical-a', 'snapshot-a');
  expect(await resources.loadCapture(lease, 'physical-a')).toEqual({
    resourceId: 'physical-a',
    snapshotId: 'snapshot-a',
  });
  await expect(resources.loadCapture(lease, 'missing')).rejects.toThrow('fenced');
  await expect(resources.reserve(lease, 'physical-a', 'replacement')).rejects.toThrow('conflict');
  await store.requestCancel('a', 'op', now);
  await expect(resources.reserve(lease, 'physical-b', 'late')).rejects.toThrow('conflict');
  const handlers = {
    async run() {
      throw new Error('unexpected');
    },
    async cleanup(context: Parameters<typeof resources.cleanupCancellationPage>[0]) {
      const result = await resources.cleanupCancellationPage(context, async (resourceId) => ({
        resourceId,
        database: adapter,
      }));
      return { ...result, cursor: null };
    },
  };
  const input = {
    tenantId: 'a',
    operationId: 'op',
    workerId: 'cleanup',
    signal: new AbortController().signal,
  };
  await executeTenantBackupSlice(store, input, handlers, () => now);
  expect((await store.get('a', 'op'))?.state).toBe('cancelling');
  expect(db.prepare('SELECT state FROM tenant_backup_snapshots').get()?.state).toBe('invalid');
  expect(() =>
    db.exec(
      "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('snapshot-a','a','capturing')"
    )
  ).toThrow();
  expect(() =>
    db.exec("UPDATE tenant_backup_snapshots SET state='capturing' WHERE id='snapshot-a'")
  ).toThrow('state_regression');
  await executeTenantBackupSlice(store, input, handlers, () => now);
  expect((await store.get('a', 'op'))?.state).toBe('cancelled');
});

async function cancellationContext() {
  await store.requestCancel('a', 'op', now);
  const operation = await store.claimCancellation('a', 'op', 'cleanup', now);
  if (!operation) throw new Error('missing');
  return {
    operation,
    lease: { ...lease, owner: 'cleanup', fencingToken: operation.fencing_token },
    signal: new AbortController().signal,
  };
}

it('rejects a changed physical destination and expired cleanup lease without touching source', async () => {
  await resources.reserve(lease, 'physical-a', 'snapshot-a');
  const context = await cancellationContext();
  await expect(
    resources.cleanupCancellationPage(context, async () => ({
      resourceId: 'other',
      database: adapter,
    }))
  ).rejects.toThrow('destination_changed');
  await expect(
    resources.cleanupCancellationPage(context, async (resourceId) => {
      now += 31000;
      return { resourceId, database: adapter };
    })
  ).rejects.toThrow('fenced');
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_snapshots').get()?.n).toBe(0);
});

it('cleans in bounded slices, preserves another tenant, and resumes after uncertain receipt', async () => {
  await resources.reserve(lease, 'physical-a', 'snapshot-a');
  db.exec(
    "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('snapshot-a','a','capturing'),('foreign','b','capturing')"
  );
  for (let i = 0; i < 205; i++)
    db.prepare(
      "INSERT INTO tenant_backup_preimages(snapshot_id,source_table,record_key,present,row_json) VALUES ('snapshot-a','users',?,0,NULL)"
    ).run(String(i));
  db.exec(
    "INSERT INTO tenant_backup_preimages(snapshot_id,source_table,record_key,present,row_json) VALUES ('foreign','users','private',0,NULL)"
  );
  const context = await cancellationContext();
  const resolve = async (resourceId: string) => ({ resourceId, database: adapter });
  expect(await resources.cleanupCancellationPage(context, resolve)).toEqual({ done: false });
  expect(
    db
      .prepare("SELECT count(*) AS n FROM tenant_backup_preimages WHERE snapshot_id='snapshot-a'")
      .get()?.n
  ).toBe(105);
  expect(await resources.cleanupCancellationPage(context, resolve)).toEqual({ done: false });
  const uncertain = new TenantBackupSnapshotResources(
    {
      ...adapter,
      async queryOne<T>(sql: string, params?: unknown[]) {
        if (sql.startsWith('UPDATE tenant_backup_snapshot_resources'))
          throw new Error('connection_lost');
        return adapter.queryOne<T>(sql, params);
      },
    },
    () => now
  );
  await expect(uncertain.cleanupCancellationPage(context, resolve)).rejects.toThrow(
    'connection_lost'
  );
  expect(await resources.cleanupCancellationPage(context, resolve)).toEqual({ done: false });
  expect(await resources.cleanupCancellationPage(context, resolve)).toEqual({ done: true });
  expect(
    db.prepare("SELECT state FROM tenant_backup_snapshots WHERE id='foreign'").get()?.state
  ).toBe('capturing');
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').get()?.n).toBe(1);
});

it('does not treat a cross-tenant snapshot identity collision as successful cleanup', async () => {
  await resources.reserve(lease, 'physical-a', 'collision');
  db.exec(
    "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('collision','b','capturing')"
  );
  const context = await cancellationContext();
  await expect(
    resources.cleanupCancellationPage(context, async (resourceId) => ({
      resourceId,
      database: adapter,
    }))
  ).rejects.toThrow('identity_conflict');
  expect(db.prepare('SELECT cleaned FROM tenant_backup_snapshot_resources').get()?.cleaned).toBe(0);
  expect(db.prepare('SELECT state FROM tenant_backup_snapshots').get()?.state).toBe('capturing');
});

it('releases a verified running snapshot in bounded pages before publication', async () => {
  await resources.reserve(lease, 'physical-a', 'snapshot-a');
  db.exec(
    "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('snapshot-a','a','capturing')"
  );
  for (let i = 0; i < 101; i++)
    db.prepare(
      "INSERT INTO tenant_backup_preimages(snapshot_id,source_table,record_key,present,row_json) VALUES ('snapshot-a','users',?,0,NULL)"
    ).run(String(i));
  const operation = await store.get('a', 'op');
  const context = {
    operation: operation!,
    lease,
    signal: new AbortController().signal,
  };
  const resolve = async (resourceId: string) => ({ resourceId, database: adapter });
  expect(await resources.cleanupPublishedPage(context, resolve)).toEqual({ done: false });
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').get()?.n).toBe(1);
  expect(await resources.cleanupPublishedPage(context, resolve)).toEqual({ done: false });
  expect(await resources.cleanupPublishedPage(context, resolve)).toEqual({ done: true });
  expect(db.prepare('SELECT cleaned FROM tenant_backup_snapshot_resources').get()?.cleaned).toBe(1);
  expect((await store.get('a', 'op'))?.state).toBe('running');
});

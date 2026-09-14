import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupOperationStore, type TenantBackupLease } from '../operation-store';
import { runTenantBackupScheduler } from '../operation-scheduler';
import { DatabaseTenantBundleReferenceIndex } from '../validation-index';
import {
  executeTenantBackupSlice,
  type TenantBackupOperationHandlers,
} from '../operation-executor';

let db: DatabaseSync;
let store: TenantBackupOperationStore;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
const create = {
  id: 'operation-a',
  tenantId: 'tenant-a',
  kind: 'export' as const,
  idempotencyKey: 'request-a',
  requestDigest: 'ab'.repeat(32),
  actorId: 'admin-a',
  now: 100,
};
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/003_tenant_backup_operations.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/008_tenant_backup_retry_state.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
  };
  store = new TenantBackupOperationStore(adapter);
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/004_tenant_backup_validation_index.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/019_tenant_backup_input_validations.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
});
afterEach(() => db.close());

describe('durable backup operation leases', () => {
  it('recovers abandoned scratch generations without collecting the active validator', async () => {
    const database = {
      ...adapter,
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
    };
    await store.create(create);
    const run = await store.claim('tenant-a', 'operation-a', 'old', 101);
    const oldLease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'old',
      fencingToken: run!.fencing_token,
    };
    const old = await DatabaseTenantBundleReferenceIndex.create(database, oldLease, () => 102);
    const identity = {
      tenantId: 'tenant-a',
      module: 'applications',
      collection: 'clients',
      id: 'client',
    };
    for (let i = 0; i < 105; i++) await old.record('bundle', { ...identity, id: String(i) });
    const takeover = await store.claim('tenant-a', 'operation-a', 'new', 30101);
    const lease = { ...oldLease, owner: 'new', fencingToken: takeover!.fencing_token };
    const current = await DatabaseTenantBundleReferenceIndex.create(database, lease, () => 30102);
    await current.record('bundle', identity);
    await expect(
      DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, oldLease, () => 30102)
    ).rejects.toThrow(/fenced/);
    await expect(
      DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
        database,
        { ...lease, tenantId: 'tenant-b' },
        () => 30102
      )
    ).rejects.toThrow(/fenced/);
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, lease, () => 30102)
    ).toEqual({ found: true, done: false });
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, lease, () => 30102)
    ).toEqual({ found: true, done: true });
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, lease, () => 30102)
    ).toEqual({ found: false, done: true });
    expect(await current.hasRecord(identity)).toBe(true);
    await store.requestCancel('tenant-a', 'operation-a', 30103);
    const cancellation = await store.claimCancellation('tenant-a', 'operation-a', 'cleaner', 30104);
    const cleanupLease = { ...lease, owner: 'cleaner', fencingToken: cancellation!.fencing_token };
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
        database,
        cleanupLease,
        () => 30105
      )
    ).toEqual({ found: true, done: true });
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_validation_sessions').get()).toEqual(
      { n: 0 }
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('stores isolated unique identities and pages a sealed reference index with bounded cleanup', async () => {
    await store.create(create);
    const run = await store.claim('tenant-a', 'operation-a', 'worker', 101);
    const database = {
      ...adapter,
      async query<T>(sql: string, params: unknown[] = []) {
        const rows = db.prepare(sql).all(...(params as SQLInputValue[]));
        expect(rows.length).toBeLessThanOrEqual(100);
        return rows as T[];
      },
    };
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: run!.fencing_token,
    };
    const index = await DatabaseTenantBundleReferenceIndex.create(database, lease, () => 102);
    const record = {
      tenantId: 'tenant-a',
      module: 'applications',
      collection: 'clients',
      id: 'client-a',
    };
    expect(await index.record('bundle-a', record)).toBe(true);
    expect(await index.record('bundle-b', record)).toBe(false);
    expect(await index.hasRecord(record, 'bundle-a')).toBe(true);
    expect(await index.hasRecord(record, 'bundle-b')).toBe(false);
    await expect(index.record('bundle-a', { ...record, tenantId: 'tenant-b' })).rejects.toThrow();
    for (let i = 0; i < 205; i++)
      await index.reference('bundle-a', {
        from: record,
        to: { ...record, id: String(i), meaning: 'resource', requirement: 'required' },
      });
    let count = 0;
    for await (const reference of index.references()) {
      expect(reference.bundleId).toBe('bundle-a');
      count++;
    }
    expect(count).toBe(205);
    expect(await index.record('bundle-a', { ...record, id: 'after-seal' })).toBe(false);
    await expect(
      index.reference('bundle-a', {
        from: record,
        to: { ...record, meaning: 'resource', requirement: 'required' },
      })
    ).rejects.toThrow();
    await index.dispose();
    expect(
      db
        .prepare('SELECT state FROM tenant_backup_validation_sessions WHERE id=?')
        .get(index.sessionId)
    ).toEqual({ state: 'deleting' });
    expect(
      db.prepare('SELECT count(*) AS n FROM tenant_backup_validation_references').get()
    ).toEqual({ n: 105 });
    expect(await index.cleanupPage()).toBe(false);
    expect(await index.cleanupPage()).toBe(true);
    expect(await index.cleanupPage()).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects expired or cancelled validation writes without disturbing a newer session', async () => {
    await store.create(create);
    const run = await store.claim('tenant-a', 'operation-a', 'worker', 101);
    const database = {
      ...adapter,
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
    };
    let clock = 102;
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: run!.fencing_token,
    };
    const old = await DatabaseTenantBundleReferenceIndex.create(database, lease, () => clock);
    const record = { tenantId: 'tenant-a', module: 'users', collection: 'users', id: 'user' };
    expect(await old.record('bundle', record)).toBe(true);
    clock = 30101;
    expect(await old.record('bundle', { ...record, id: 'expired' })).toBe(false);
    await expect(old.hasRecord(record)).rejects.toThrow('backup_validation_index_fenced');
    const takeover = await store.claim('tenant-a', 'operation-a', 'new-worker', clock);
    const fresh = await DatabaseTenantBundleReferenceIndex.create(
      database,
      { ...lease, owner: 'new-worker', fencingToken: takeover!.fencing_token },
      () => clock
    );
    expect(await fresh.record('bundle', record)).toBe(true);
    await old.dispose();
    expect(await fresh.hasRecord(record)).toBe(true);
    await store.requestCancel('tenant-a', 'operation-a', ++clock);
    await expect(fresh.hasRecord(record)).rejects.toThrow();
    await fresh.dispose();
  });
  it('runs bounded slices across executor restarts using the persisted cursor', async () => {
    await store.create(create);
    let clock = 101;
    const handlers: TenantBackupOperationHandlers = {
      async run({ operation }) {
        const page = operation.cursor_json ? Number(JSON.parse(operation.cursor_json).page) : 0;
        return {
          phase: 'capture',
          cursor: JSON.stringify({ page: page + 1 }),
          disposition: page === 0 ? 'continue' : 'ready',
        };
      },
      async cleanup() {
        throw new Error('unexpected_cleanup');
      },
    };
    const input = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      workerId: 'worker-1',
      signal: new AbortController().signal,
    };
    const first = await executeTenantBackupSlice(store, input, handlers, () => clock++);
    expect(first).toMatchObject({
      outcome: 'yielded',
      operation: { state: 'queued', cursor_json: '{"page":1}', lease_owner: null },
    });
    const second = await executeTenantBackupSlice(
      new TenantBackupOperationStore(adapter),
      { ...input, workerId: 'worker-2' },
      handlers,
      () => clock++
    );
    expect(second).toMatchObject({
      outcome: 'yielded',
      operation: { state: 'ready', cursor_json: '{"page":2}', lease_owner: null },
    });
    expect(await executeTenantBackupSlice(store, input, handlers, () => clock++)).toEqual({
      outcome: 'unclaimed',
    });
  });

  it('fences a handler cancelled mid-slice and runs only resumable cleanup afterwards', async () => {
    await store.create(create);
    let clock = 101;
    let runCount = 0;
    const handlers: TenantBackupOperationHandlers = {
      async run() {
        runCount++;
        await store.requestCancel('tenant-a', 'operation-a', clock++);
        return { phase: 'capture', cursor: '{}', disposition: 'ready' };
      },
      async cleanup({ operation }) {
        return { cursor: '{"cleaned":1}', done: operation.cursor_json !== null };
      },
    };
    const input = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      workerId: 'worker',
      signal: new AbortController().signal,
    };
    expect(await executeTenantBackupSlice(store, input, handlers, () => clock++)).toEqual({
      outcome: 'fenced',
    });
    expect(await executeTenantBackupSlice(store, input, handlers, () => clock++)).toMatchObject({
      outcome: 'yielded',
      operation: { state: 'cancelling', cursor_json: '{"cleaned":1}', lease_owner: null },
    });
    expect(
      await executeTenantBackupSlice(
        new TenantBackupOperationStore(adapter),
        input,
        handlers,
        () => clock++
      )
    ).toMatchObject({ outcome: 'yielded', operation: { state: 'cancelled' } });
    expect(runCount).toBe(1);
  });

  it('does not advance on a handler exception and retries only after the lease expires', async () => {
    await store.create(create);
    let clock = 101;
    const input = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      workerId: 'worker',
      signal: new AbortController().signal,
    };
    const broken: TenantBackupOperationHandlers = {
      async run() {
        throw new Error('decrypted-private-material');
      },
      async cleanup() {
        return { done: true, cursor: null };
      },
    };
    await expect(executeTenantBackupSlice(store, input, broken, () => clock++)).rejects.toThrow(
      /^backup_operation_slice_failed$/
    );
    const persisted = await store.get('tenant-a', 'operation-a');
    expect(persisted?.cursor_json).toBeNull();
    expect(await executeTenantBackupSlice(store, input, broken, () => clock++)).toEqual({
      outcome: 'unclaimed',
    });
    clock = persisted!.lease_expires_at!;
    const fixed: TenantBackupOperationHandlers = {
      ...broken,
      async run() {
        return { phase: 'await-key', cursor: null, disposition: 'wait' };
      },
    };
    expect(await executeTenantBackupSlice(store, input, fixed, () => clock++)).toMatchObject({
      outcome: 'yielded',
      operation: { state: 'waiting', phase: 'await-key' },
    });
  });
  it('resumes cleanup after lease loss and only the current cleanup owner can finish', async () => {
    await store.create(create);
    const cancelled = await store.requestCancel('tenant-a', 'operation-a', 101);
    expect(cancelled).toMatchObject({ phase: 'cleanup', cursor_json: null });
    const cleanup = await store.claimCancellation('tenant-a', 'operation-a', 'cleaner-a', 102);
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'cleaner-a',
      fencingToken: cleanup!.fencing_token,
    };
    const saved = await store.checkpointCancellation(
      lease,
      cleanup!.revision,
      '{"resource":2}',
      103
    );
    expect(await store.claimCancellation('tenant-a', 'operation-a', 'cleaner-b', 104)).toBeNull();
    expect(await store.checkpoint(lease, saved!.revision, 'capture', '{}', 104)).toBeNull();
    const restarted = new TenantBackupOperationStore(adapter);
    const takeover = await restarted.claimCancellation(
      'tenant-a',
      'operation-a',
      'cleaner-b',
      30103
    );
    expect(takeover?.cursor_json).toBe('{"resource":2}');
    expect(await store.finishCancellation(lease, saved!.revision, 30104)).toBeNull();
    const finished = await restarted.finishCancellation(
      { ...lease, owner: 'cleaner-b', fencingToken: takeover!.fencing_token },
      takeover!.revision,
      30104
    );
    expect(finished).toMatchObject({
      state: 'cancelled',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(
      await restarted.claimCancellation('tenant-a', 'operation-a', 'cleaner-c', 70000)
    ).toBeNull();
    expect(await restarted.claim('tenant-a', 'operation-a', 'worker-c', 70000)).toBeNull();
  });

  it.each(['waiting', 'ready', 'failed'] as const)(
    'releases a run into %s without retaining execution rights',
    async (state) => {
      await store.create(create);
      const run = await store.claim('tenant-a', 'operation-a', 'worker', 101);
      const lease = {
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        owner: 'worker',
        fencingToken: run!.fencing_token,
      };
      expect(await store.finishCancellation(lease, run!.revision, 102)).toBeNull();
      const released = await store.release(lease, run!.revision, state, 102);
      expect(released).toMatchObject({
        state,
        lease_owner: null,
        fencing_token: run!.fencing_token + 1,
      });
      expect(await store.checkpoint(lease, run!.revision, 'capture', '{}', 103)).toBeNull();
      expect(await store.claim('tenant-a', 'operation-a', 'another', 70000)).toBeNull();
      if (state !== 'waiting')
        expect(
          await store.resumeWaiting(
            'tenant-a',
            'operation-a',
            released!.revision,
            create.requestDigest,
            103
          )
        ).toBeNull();
    }
  );

  it('requires the current revision, tenant and request digest to resume waiting work', async () => {
    await store.create(create);
    const run = await store.claim('tenant-a', 'operation-a', 'worker', 101);
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: run!.fencing_token,
    };
    const saved = await store.checkpoint(lease, run!.revision, 'validate', '{"page":1}', 102);
    const waiting = await store.release(lease, saved!.revision, 'waiting', 103);
    expect(
      await store.resumeWaiting(
        'tenant-b',
        'operation-a',
        waiting!.revision,
        create.requestDigest,
        104
      )
    ).toBeNull();
    expect(
      await store.resumeWaiting(
        'tenant-a',
        'operation-a',
        saved!.revision,
        create.requestDigest,
        104
      )
    ).toBeNull();
    expect(
      await store.resumeWaiting('tenant-a', 'operation-a', waiting!.revision, 'cd'.repeat(32), 104)
    ).toBeNull();
    const resumed = await store.resumeWaiting(
      'tenant-a',
      'operation-a',
      waiting!.revision,
      create.requestDigest,
      104
    );
    expect(resumed).toMatchObject({
      state: 'queued',
      phase: 'validate',
      cursor_json: '{"page":1}',
    });
    const acquired = await store.claim('tenant-a', 'operation-a', 'worker-new', 105);
    expect(acquired!.fencing_token).toBeGreaterThan(run!.fencing_token);
    expect(
      await store.resumeWaiting(
        'tenant-a',
        'operation-a',
        resumed!.revision,
        create.requestDigest,
        106
      )
    ).toBeNull();
  });

  it('cannot acknowledge a pause or cleanup after its lease expired', async () => {
    await store.create(create);
    const run = await store.claim('tenant-a', 'operation-a', 'worker', 101);
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: run!.fencing_token,
    };
    expect(await store.release(lease, run!.revision, 'ready', 30101)).toBeNull();
    await store.requestCancel('tenant-a', 'operation-a', 30102);
    const cleanup = await store.claimCancellation('tenant-a', 'operation-a', 'worker', 30103);
    expect(
      await store.finishCancellation(
        { ...lease, fencingToken: cleanup!.fencing_token },
        cleanup!.revision,
        60103
      )
    ).toBeNull();
    expect((await store.get('tenant-a', 'operation-a'))?.state).toBe('cancelling');
  });
  it('rejects contradictory running state and nullable identities at the database boundary', async () => {
    await store.create(create);
    expect(() =>
      db.prepare("UPDATE tenant_backup_operations SET state='running' WHERE id=?").run(create.id)
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE tenant_backup_operations SET id=NULL WHERE id=?').run(create.id)
    ).toThrow(/NOT NULL/);
    expect((await store.get(create.tenantId, create.id))?.state).toBe('queued');
  });
  it('makes creation idempotent but rejects changed intent or actor', async () => {
    const first = await store.create(create);
    expect(await store.create({ ...create, id: 'retry-id', now: 101 })).toEqual(first);
    for (const change of [
      { kind: 'import' as const },
      { requestDigest: 'cd'.repeat(32) },
      { actorId: 'admin-b' },
    ]) {
      await expect(store.create({ ...create, ...change })).rejects.toThrow(
        'backup_operation_idempotency_conflict'
      );
    }
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_operations').get()).toEqual({
      n: 1,
    });
  });
  it('recovers a persisted expired lease after process restart and rejects the old fence', async () => {
    await store.create(create);
    const claimed = await store.claim('tenant-a', 'operation-a', 'worker-a', 101);
    expect(claimed?.fencing_token).toBe(1);
    expect(await store.claim('tenant-a', 'operation-a', 'worker-b', 102)).toBeNull();
    const restarted = new TenantBackupOperationStore(adapter);
    const takeover = await restarted.claim('tenant-a', 'operation-a', 'worker-b', 30101);
    expect(takeover?.fencing_token).toBe(2);
    const old: TenantBackupLease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker-a',
      fencingToken: 1,
    };
    expect(
      await store.checkpoint(old, claimed!.revision, 'capture', '{"page":2}', 30102)
    ).toBeNull();
    expect(await restarted.get('tenant-a', 'operation-a')).toEqual(takeover);
  });
  it('updates the cursor and lease atomically and rejects a stale revision', async () => {
    await store.create(create);
    const claimed = await store.claim('tenant-a', 'operation-a', 'worker-a', 101);
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker-a',
      fencingToken: claimed!.fencing_token,
    };
    const checkpoint = await store.checkpoint(
      lease,
      claimed!.revision,
      'capture',
      '{"page":2}',
      102
    );
    expect(checkpoint).toMatchObject({
      cursor_json: '{"page":2}',
      phase: 'capture',
      revision: 2,
      lease_expires_at: 30102,
    });
    expect(
      await store.checkpoint(lease, claimed!.revision, 'capture', '{"page":1}', 103)
    ).toBeNull();
    expect(await store.checkpoint(lease, checkpoint!.revision, 'capture', '{}', 30102)).toBeNull();
  });
  it('persists cancellation, revokes running work and does not requeue it on claim', async () => {
    await store.create(create);
    const claimed = await store.claim('tenant-a', 'operation-a', 'worker-a', 101);
    const cancelled = await store.requestCancel('tenant-a', 'operation-a', 102);
    expect(cancelled).toMatchObject({
      state: 'cancelling',
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 2,
    });
    expect(
      await store.checkpoint(
        { tenantId: 'tenant-a', operationId: 'operation-a', owner: 'worker-a', fencingToken: 1 },
        claimed!.revision,
        'capture',
        '{}',
        103
      )
    ).toBeNull();
    expect(await store.claim('tenant-a', 'operation-a', 'worker-b', 40000)).toBeNull();
    expect(await store.requestCancel('tenant-a', 'operation-a', 104)).toBeNull();
    expect((await store.get('tenant-a', 'operation-a'))?.state).toBe('cancelling');
  });
  it('isolates all reads and mutations by tenant and rejects a backwards clock', async () => {
    await store.create(create);
    expect(await store.get('tenant-b', 'operation-a')).toBeNull();
    expect(await store.claim('tenant-b', 'operation-a', 'worker', 101)).toBeNull();
    expect(await store.requestCancel('tenant-b', 'operation-a', 101)).toBeNull();
    expect(await store.claim('tenant-a', 'operation-a', 'worker', 99)).toBeNull();
    expect((await store.get('tenant-a', 'operation-a'))?.revision).toBe(0);
  });
  it('keeps invalid cursors and invalid clocks from modifying durable state', async () => {
    await store.create(create);
    const claimed = await store.claim('tenant-a', 'operation-a', 'worker', 101);
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: 1,
    };
    for (const cursor of ['{broken', ' '.repeat(16385)])
      await expect(store.checkpoint(lease, 1, 'capture', cursor, 102)).rejects.toThrow();
    await expect(store.claim('tenant-a', 'operation-a', 'worker', Infinity)).rejects.toThrow();
    expect(await store.get('tenant-a', 'operation-a')).toEqual(claimed);
  });
});

it('bounds scheduler work and persists backoff without exposing handler errors', async () => {
  for (let i = 0; i < 7; i++)
    await store.create({ ...create, id: 'scheduled-' + i, idempotencyKey: 'scheduled-' + i });
  const calls: string[] = [];
  const handlers: TenantBackupOperationHandlers = {
    async run(ctx) {
      calls.push(ctx.operation.id);
      if (ctx.operation.id === 'scheduled-0') throw new Error('PRIVATE PAYLOAD');
      return { phase: 'capture', cursor: '{"page":1}', disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  expect(
    await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => 101)
  ).toEqual({ inspected: 5, advanced: 4, failures: 1 });
  const failed = await store.get('tenant-a', 'scheduled-0');
  expect(failed).toMatchObject({
    state: 'queued',
    failure_count: 1,
    next_attempt_at: 1101,
    cursor_json: null,
    last_error_code: 'backup_operation_slice_failed',
  });
  expect(JSON.stringify(failed)).not.toContain('PRIVATE');
  expect(await store.claim('tenant-a', 'scheduled-0', 'early', 1100)).toBeNull();
  calls.length = 0;
  await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => 102);
  expect(calls.slice(0, 2)).toEqual(['scheduled-5', 'scheduled-6']);
  expect(calls).not.toContain('scheduled-0');
});
it('stops normal retries after eight failures while cancellation remains recoverable', async () => {
  await store.create(create);
  let now = 101;
  const handlers: TenantBackupOperationHandlers = {
    async run() {
      throw new Error('private');
    },
    async cleanup() {
      throw new Error('private');
    },
  };
  for (let i = 0; i < 8; i++) {
    expect(
      (await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now))
        .failures
    ).toBe(1);
    const current = await store.get(create.tenantId, create.id);
    expect(current?.failure_count).toBe(i + 1);
    now = current!.next_attempt_at;
  }
  expect((await store.get(create.tenantId, create.id))?.state).toBe('waiting');
  expect(
    (await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now))
      .inspected
  ).toBe(0);
  await store.requestCancel(create.tenantId, create.id, now);
  expect(
    (await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now))
      .failures
  ).toBe(1);
  const cancelling = await store.get(create.tenantId, create.id);
  expect(cancelling).toMatchObject({ state: 'cancelling', failure_count: 1 });
  const success = {
    ...handlers,
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  expect(
    (
      await runTenantBackupScheduler(
        adapter,
        success,
        new AbortController().signal,
        () => cancelling!.next_attempt_at
      )
    ).advanced
  ).toBe(1);
  expect((await store.get(create.tenantId, create.id))?.state).toBe('cancelled');
});
it('does not overwrite cancellation with a failed stale handler retry', async () => {
  await store.create(create);
  const handlers: TenantBackupOperationHandlers = {
    async run() {
      await store.requestCancel(create.tenantId, create.id, 102);
      throw new Error('private handler failure');
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => 102);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'cancelling',
    failure_count: 0,
    next_attempt_at: 0,
    last_error_code: null,
  });
});

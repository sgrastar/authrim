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
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'>;
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
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/046_tenant_backup_operation_failure_reason.sql',
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
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const result = db.prepare(sql).run(...(params as SQLInputValue[]));
          return { success: true, rowsAffected: Number(result.changes) };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
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
  db.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/admin/d1/017_tenant_backup_validation_record_sources.sql',
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
    const takeover = await store.claim('tenant-a', 'operation-a', 'new', 600101);
    const lease = { ...oldLease, owner: 'new', fencingToken: takeover!.fencing_token };
    const current = await DatabaseTenantBundleReferenceIndex.create(database, lease, () => 600102);
    await current.record('bundle', identity);
    await expect(
      DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, oldLease, () => 600102)
    ).rejects.toThrow(/fenced/);
    await expect(
      DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
        database,
        { ...lease, tenantId: 'tenant-b' },
        () => 600102
      )
    ).rejects.toThrow(/fenced/);
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, lease, () => 600102)
    ).toEqual({ found: true, done: false });
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, lease, () => 600102)
    ).toEqual({ found: true, done: true });
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(database, lease, () => 600102)
    ).toEqual({ found: false, done: true });
    expect(await current.hasRecord(identity)).toBe(true);
    await store.requestCancel('tenant-a', 'operation-a', 600103);
    const cancellation = await store.claimCancellation(
      'tenant-a',
      'operation-a',
      'cleaner',
      600104
    );
    const cleanupLease = { ...lease, owner: 'cleaner', fencingToken: cancellation!.fencing_token };
    expect(
      await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
        database,
        cleanupLease,
        () => 600105
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
    await index.recordInspectionBatch({
      records: [
        {
          bundleId: 'bundle-a',
          sourceId: 'dataset:0:row:1',
          record: { ...record, id: 'client-b' },
        },
        {
          bundleId: 'bundle-a',
          sourceId: 'dataset:0:row:2',
          record: { ...record, id: 'client-c' },
        },
      ],
      references: [
        {
          bundleId: 'bundle-a',
          sourceEdgeId: 'dataset:0:row:1:edge:0',
          dependency: {
            from: { ...record, id: 'client-b' },
            to: {
              ...record,
              id: 'client-c',
              meaning: 'resource',
              requirement: 'required',
            },
          },
        },
      ],
    });
    expect(await index.hasRecord({ ...record, id: 'client-b' }, 'bundle-a')).toBe(true);
    await index.recordInspectionBatch({
      records: [
        {
          bundleId: 'bundle-a',
          sourceId: 'dataset:0:row:1',
          record: { ...record, id: 'client-b' },
        },
      ],
      references: [
        {
          bundleId: 'bundle-a',
          sourceEdgeId: 'dataset:0:row:1:edge:0',
          dependency: {
            from: { ...record, id: 'client-b' },
            to: {
              ...record,
              id: 'client-c',
              meaning: 'resource',
              requirement: 'required',
            },
          },
        },
      ],
    });
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
    expect(count).toBe(206);
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
    ).toEqual({ n: 106 });
    expect(await index.cleanupPage()).toBe(false);
    expect(await index.cleanupPage()).toBe(true);
    expect(await index.cleanupPage()).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('resolves reference endpoints in SQL exactly as hasRecord does, a thousand per page', async () => {
    await store.create(create);
    const run = await store.claim('tenant-a', 'operation-a', 'worker', 101);
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: run!.fencing_token,
    };
    const index = await DatabaseTenantBundleReferenceIndex.create(adapter, lease, () => 102);
    const record = (id: string) => ({
      tenantId: 'tenant-a',
      module: 'applications',
      collection: 'clients',
      id,
    });
    await index.record('bundle-a', record('a-1'));
    await index.record('bundle-b', record('b-1'));
    const edges = [
      { from: 'a-1', to: 'b-1', bundle: 'bundle-a', meaning: 'resource', requirement: 'required' },
      { from: 'b-1', to: 'a-1', bundle: 'bundle-a', meaning: 'resource', requirement: 'required' },
      { from: 'a-1', to: 'none', bundle: 'bundle-a', meaning: 'resource', requirement: 'required' },
      {
        from: 'a-1',
        to: 'none',
        bundle: 'bundle-a',
        meaning: 'admin_actor',
        requirement: 'provenance',
      },
    ] as const;
    for (let i = 0; i < 1003; i++) {
      const edge = edges[i % edges.length];
      await index.referenceOnce(edge.bundle, `dataset:0:row:${String(i).padStart(4, '0')}:edge:0`, {
        from: record(edge.from),
        to: { ...record(edge.to), meaning: edge.meaning, requirement: edge.requirement },
      });
    }
    const first = await index.resolvedReferencesPage('');
    expect(first.entries).toHaveLength(1000);
    expect(first.done).toBe(false);
    const second = await index.resolvedReferencesPage(first.nextCursor);
    expect(second.entries).toHaveLength(3);
    expect(second.done).toBe(true);
    for (const entry of [...first.entries, ...second.entries]) {
      expect(entry.sourceFound).toBe(await index.hasRecord(entry.dependency.from, entry.bundleId));
      expect(entry.targetFound).toBe(await index.hasRecord(entry.dependency.to));
    }
    expect(
      first.entries.slice(0, 4).map(({ sourceFound, targetFound }) => [sourceFound, targetFound])
    ).toEqual([
      [true, true],
      [false, true],
      [true, false],
      [true, false],
    ]);
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
    clock = 600101;
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
      600103
    );
    expect(takeover?.cursor_json).toBe('{"resource":2}');
    expect(await store.finishCancellation(lease, saved!.revision, 600104)).toBeNull();
    const finished = await restarted.finishCancellation(
      { ...lease, owner: 'cleaner-b', fencingToken: takeover!.fencing_token },
      takeover!.revision,
      600104
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
    expect(await store.release(lease, run!.revision, 'ready', 600101)).toBeNull();
    await store.requestCancel('tenant-a', 'operation-a', 600102);
    const cleanup = await store.claimCancellation('tenant-a', 'operation-a', 'worker', 600103);
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
    const takeover = await restarted.claim('tenant-a', 'operation-a', 'worker-b', 600101);
    expect(takeover?.fencing_token).toBe(2);
    const old: TenantBackupLease = {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker-a',
      fencingToken: 1,
    };
    expect(
      await store.checkpoint(old, claimed!.revision, 'capture', '{"page":2}', 600102)
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
      lease_expires_at: 180102,
    });
    expect(
      await store.checkpoint(lease, claimed!.revision, 'capture', '{"page":1}', 103)
    ).toBeNull();
    expect(await store.checkpoint(lease, checkpoint!.revision, 'capture', '{}', 600102)).toBeNull();
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
    expect(await store.claim('tenant-a', 'operation-a', 'worker-b', 700000)).toBeNull();
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
  ).toEqual({
    inspected: 5,
    advanced: 4,
    failures: 1,
    failureCodes: ['backup_operation_slice_failed'],
  });
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
it('claims only the explicitly enabled operation kind', async () => {
  await store.create({ ...create, id: 'export-only', idempotencyKey: 'export-only' });
  await store.create({
    ...create,
    id: 'import-held',
    idempotencyKey: 'import-held',
    kind: 'import',
  });
  const calls: string[] = [];
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      calls.push(context.operation.id);
      return { phase: 'capture', cursor: null, disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };

  await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => 101, [
    'export',
  ]);

  expect(calls).toEqual(['export-only']);
  expect(await store.get('tenant-a', 'import-held')).toMatchObject({ state: 'queued' });
});
it('stops starting transitions once the tick deadline has passed', async () => {
  await store.create(create);
  let clock = 101;
  let runs = 0;
  const handlers: TenantBackupOperationHandlers = {
    async run() {
      runs++;
      clock += 30;
      return { phase: 'capture', cursor: `{"page":${runs}}`, disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  const result = await runTenantBackupScheduler(
    adapter,
    handlers,
    new AbortController().signal,
    () => clock,
    ['export'],
    8,
    50
  );
  expect(result.advanced).toBe(2);
  expect(runs).toBe(2);
  expect(await store.get('tenant-a', 'operation-a')).toMatchObject({
    state: 'queued',
    cursor_json: '{"page":2}',
  });
});
it('shares one transition budget across every operation of a scheduler tick', async () => {
  for (const id of ['shared-a', 'shared-b', 'shared-c'])
    await store.create({ ...create, id, idempotencyKey: id });
  const runs: string[] = [];
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      runs.push(context.operation.id);
      return { phase: 'capture', cursor: '{}', disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  const result = await runTenantBackupScheduler(
    adapter,
    handlers,
    new AbortController().signal,
    () => 101,
    ['export'],
    4,
    60_000,
    5
  );
  expect(result.advanced).toBe(5);
  expect(runs).toEqual(['shared-a', 'shared-a', 'shared-a', 'shared-a', 'shared-b']);
  expect(await store.get('tenant-a', 'shared-c')).toMatchObject({ state: 'queued', revision: 0 });
});
it('advances one operation through a bounded number of durable scheduler transitions', async () => {
  await store.create(create);
  const calls: number[] = [];
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      calls.push(context.operation.fencing_token);
      return {
        phase: `capture-${calls.length}`,
        cursor: JSON.stringify({ transition: calls.length }),
        disposition: calls.length === 3 ? 'wait' : 'continue',
      };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };

  expect(
    await runTenantBackupScheduler(
      adapter,
      handlers,
      new AbortController().signal,
      () => 101,
      ['export', 'import'],
      8
    )
  ).toEqual({ inspected: 1, advanced: 3, failures: 0, failureCodes: [] });
  expect(calls).toEqual([1, 1, 1]);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'waiting',
    phase: 'capture-3',
  });
});
it('starts no transition or operation once the scheduler run budget has passed', async () => {
  await store.create({ ...create, id: 'budget-a', idempotencyKey: 'budget-a' });
  await store.create({ ...create, id: 'budget-b', idempotencyKey: 'budget-b' });
  let clock = 101;
  const calls: string[] = [];
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      calls.push(context.operation.id);
      clock += 30;
      return { phase: 'capture', cursor: null, disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };

  // 50 ms budget: the second transition starts at 131 and ends past the deadline at 161.
  expect(
    await runTenantBackupScheduler(
      adapter,
      handlers,
      new AbortController().signal,
      () => clock,
      ['export', 'import'],
      8,
      50
    )
  ).toEqual({ inspected: 2, advanced: 2, failures: 0, failureCodes: [] });
  expect(calls).toEqual(['budget-a', 'budget-a']);
  expect(await store.get('tenant-a', 'budget-a')).toMatchObject({ state: 'queued' });
  expect(await store.get('tenant-a', 'budget-b')).toMatchObject({ state: 'queued' });
  await expect(
    runTenantBackupScheduler(
      adapter,
      handlers,
      new AbortController().signal,
      () => clock,
      ['export'],
      8,
      0
    )
  ).rejects.toThrow('invalid_backup_scheduler_budget');
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
it('sends a permanent failure straight to cleanup and finishes it as failed', async () => {
  await store.create(create);
  const cleanups: string[] = [];
  const handlers: TenantBackupOperationHandlers = {
    async run() {
      throw new Error('backup_export_too_large');
    },
    async cleanup(context) {
      cleanups.push(context.operation.phase);
      return { cursor: null, done: true };
    },
  };
  const tick = (now: number) =>
    runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
  expect(await tick(101)).toMatchObject({
    failures: 1,
    failureCodes: ['backup_export_too_large'],
  });
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'cancelling',
    phase: 'cleanup',
    cursor_json: null,
    failure_reason: 'backup_export_too_large',
    failure_count: 0,
    last_error_code: null,
    lease_owner: null,
    next_attempt_at: 0,
  });
  expect((await tick(102)).advanced).toBe(1);
  expect(cleanups).toEqual(['cleanup']);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'failed',
    failure_reason: 'backup_export_too_large',
    lease_owner: null,
  });
  // A finished operation is not picked up again.
  expect((await tick(103)).inspected).toBe(0);
});
it('cleans up a permanent import failure during validation and finishes it as failed', async () => {
  await store.create({ ...create, kind: 'import' });
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      if (context.operation.phase === 'validate_sqlite_dataset')
        throw new Error('backup_sqlite_row_too_large');
      return { phase: 'validate_sqlite_dataset', cursor: null, disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  const tick = (now: number) =>
    runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
  expect((await tick(101)).advanced).toBe(1);
  expect((await tick(102)).failureCodes).toEqual(['backup_sqlite_row_too_large']);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'cancelling',
    phase: 'cleanup',
    failure_reason: 'backup_sqlite_row_too_large',
  });
  expect((await tick(103)).advanced).toBe(1);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'failed',
    failure_reason: 'backup_sqlite_row_too_large',
  });
});
it('cleans up a permanent import failure while the SQL restore writes and finishes it as failed', async () => {
  await store.create({ ...create, kind: 'import' });
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      if (context.operation.phase === 'apply_sqlite_dataset')
        throw new Error('backup_sqlite_row_too_large');
      return { phase: 'apply_sqlite_dataset', cursor: null, disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  const tick = (now: number) =>
    runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
  expect((await tick(101)).advanced).toBe(1);
  expect((await tick(102)).failureCodes).toEqual(['backup_sqlite_row_too_large']);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'cancelling',
    phase: 'cleanup',
    failure_reason: 'backup_sqlite_row_too_large',
  });
  expect((await tick(103)).advanced).toBe(1);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'failed',
    failure_reason: 'backup_sqlite_row_too_large',
  });
});
it('keeps retrying a permanent import failure once other stores are written and shows the reason', async () => {
  await store.create({ ...create, kind: 'import' });
  let cleanups = 0;
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      if (context.operation.phase === 'restore_other_stores')
        throw new Error('backup_sqlite_row_too_large');
      return { phase: 'restore_other_stores', cursor: null, disposition: 'continue' };
    },
    async cleanup() {
      cleanups++;
      return { cursor: null, done: true };
    },
  };
  let now = 101;
  await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
  now = 102;
  for (let i = 0; i < 8; i++) {
    await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
    const current = await store.get(create.tenantId, create.id);
    expect(current).toMatchObject({
      phase: 'restore_other_stores',
      failure_count: i + 1,
      last_error_code: 'backup_operation_slice_failed',
      failure_reason: 'backup_sqlite_row_too_large',
    });
    now = current!.next_attempt_at;
  }
  const waiting = (await store.get(create.tenantId, create.id))!;
  expect(waiting.state).toBe('waiting');
  expect(cleanups).toBe(0);
  // Resuming starts a fresh attempt, so the old reason no longer describes it.
  expect(
    await store.resumeWaiting(
      create.tenantId,
      create.id,
      waiting.revision,
      create.requestDigest,
      now
    )
  ).toMatchObject({ state: 'queued', failure_reason: null });
});
it('keeps a permanent failure reason when a later retry fails for a transient reason', async () => {
  await store.create({ ...create, kind: 'import' });
  let attempts = 0;
  const handlers: TenantBackupOperationHandlers = {
    async run(context) {
      if (context.operation.phase === 'restore_other_stores') {
        attempts++;
        throw new Error(attempts === 1 ? 'backup_sqlite_row_too_large' : 'd1_network_error');
      }
      return { phase: 'restore_other_stores', cursor: null, disposition: 'continue' };
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  let now = 101;
  await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
  now = 102;
  for (let i = 0; i < 3; i++) {
    await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => now);
    const current = (await store.get(create.tenantId, create.id))!;
    // Only a checkpoint, a resume or a cancel clears it; a transient failure does not.
    expect(current).toMatchObject({
      failure_count: i + 1,
      failure_reason: 'backup_sqlite_row_too_large',
    });
    now = current.next_attempt_at;
  }
  expect(attempts).toBe(3);
});
it('refuses to fail an import permanently once it writes other stores', async () => {
  await store.create({ ...create, kind: 'import' });
  const claimed = (await store.claim(create.tenantId, create.id, 'worker', 101))!;
  const lease = {
    tenantId: create.tenantId,
    operationId: create.id,
    owner: 'worker',
    fencingToken: claimed.fencing_token,
  };
  const applying = (await store.checkpoint(
    lease,
    claimed.revision,
    'restore_other_stores',
    null,
    102
  ))!;
  expect(
    await store.failPermanently(lease, applying.revision, 'backup_sqlite_row_too_large', 103)
  ).toBeNull();
  expect((await store.get(create.tenantId, create.id))?.state).toBe('running');
});
it.each(['restore_other_stores', 'verify_restore_targets', 'activate_restore'])(
  'refuses to cancel an import in %s',
  async (phase) => {
    await store.create({ ...create, kind: 'import' });
    const claimed = (await store.claim(create.tenantId, create.id, 'worker', 101))!;
    const lease = {
      tenantId: create.tenantId,
      operationId: create.id,
      owner: 'worker',
      fencingToken: claimed.fencing_token,
    };
    const running = (await store.checkpoint(lease, claimed.revision, phase, null, 102))!;
    expect(await store.requestCancel(create.tenantId, create.id, 103)).toBeNull();
    // The same holds after a failed attempt queues it again.
    await store.retryFailure(lease, running.revision, 103, null);
    expect(await store.requestCancel(create.tenantId, create.id, 104)).toBeNull();
    expect((await store.get(create.tenantId, create.id))?.phase).toBe(phase);
  }
);
it('refuses to cancel a ready import and still cancels an import that is applying SQL rows', async () => {
  await store.create({ ...create, kind: 'import' });
  const claimed = (await store.claim(create.tenantId, create.id, 'worker', 101))!;
  const lease = {
    tenantId: create.tenantId,
    operationId: create.id,
    owner: 'worker',
    fencingToken: claimed.fencing_token,
  };
  const applying = (await store.checkpoint(
    lease,
    claimed.revision,
    'apply_sqlite_dataset',
    null,
    102
  ))!;
  expect(await store.requestCancel(create.tenantId, create.id, 103)).toMatchObject({
    state: 'cancelling',
    phase: 'cleanup',
  });
  expect(applying.phase).toBe('apply_sqlite_dataset');

  const ready = {
    ...create,
    id: 'operation-ready',
    idempotencyKey: 'ready',
    kind: 'import' as const,
  };
  await store.create(ready);
  const readyClaim = (await store.claim(ready.tenantId, ready.id, 'worker', 104))!;
  const readyLease = { ...lease, operationId: ready.id, fencingToken: readyClaim.fencing_token };
  const verified = (await store.checkpoint(
    readyLease,
    readyClaim.revision,
    'advance_restore_dataset',
    null,
    105
  ))!;
  expect(await store.release(readyLease, verified.revision, 'ready', 106)).toMatchObject({
    state: 'ready',
  });
  expect(await store.requestCancel(ready.tenantId, ready.id, 107)).toBeNull();
});
it('keeps a user cancellation a cancellation when no permanent failure was recorded', async () => {
  await store.create(create);
  await store.requestCancel(create.tenantId, create.id, 101);
  const handlers: TenantBackupOperationHandlers = {
    async run() {
      throw new Error('unexpected');
    },
    async cleanup() {
      return { cursor: null, done: true };
    },
  };
  await runTenantBackupScheduler(adapter, handlers, new AbortController().signal, () => 102);
  expect(await store.get(create.tenantId, create.id)).toMatchObject({
    state: 'cancelled',
    failure_reason: null,
  });
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

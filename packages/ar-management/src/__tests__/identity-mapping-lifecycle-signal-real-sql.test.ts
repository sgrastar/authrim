import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
/**
 * Real FK-ON Core/Admin SQLite schemas, D1 atomic batches, canonical lifecycle helper and
 * actual authentication-state DO RPCs. Signed inventory resolution is the routing seam; the
 * bounded owner search and all account/journal SQL are real. Logout/audit delivery is observed.
 */
import { Hono, type Context } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { SessionRevocationStore } from '@authrim/ar-lib-core/durable-objects/SessionRevocationStore';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { d1OverSqlite } from './helpers/d1-over-sqlite';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import {
  adminIdentityMappingLifecycleSignalRecordHandler,
  hashStableJson,
} from '../identity-mapping-control-plane';
import {
  LifecycleSignalConflictError,
  recordAccountSuspensionSignal,
  resolveLifecycleSignalAccountOwner,
  type SuspensionSignalInput,
} from '../identity-mapping-lifecycle-signal';
import { transitionAccountLifecycle } from '../account-status';

const world = vi.hoisted(() => ({
  metadata: vi.fn(),
  context: vi.fn(),
  stores: vi.fn(),
  logout: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: world.metadata,
  getTenantMetadataContextFromHono: world.context,
}));
vi.mock('../compliance/tenant-stores', () => ({ tenantCoreStores: world.stores }));
vi.mock('../admin-session-end', async (original) => ({
  ...(await original<typeof import('../admin-session-end')>()),
  startAdminSessionEndLogout: world.logout,
}));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: world.audit,
}));

const TENANT = 'tenant-a';
const INPUT: SuspensionSignalInput = {
  sourceType: 'scim',
  sourceId: 'directory-1',
  sourceEventId: 'source-event-1',
  signalType: 'scim_active_false',
  targetType: 'account',
  targetId: 'internal-account',
};
const IDENTITY = {
  databaseId: 'physical-account',
  bindingRouteGeneration: 1,
  shardId: 'user-shard',
  assignmentGeneration: 1,
};
class Storage {
  readonly values = new Map<string, unknown>();
  private pending: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string | string[]) {
    const removed = (Array.isArray(key) ? key : [key]).reduce(
      (n, k) => n + Number(this.values.delete(k)),
      0
    );
    return Array.isArray(key) ? removed : removed > 0;
  }
  async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ''))
        .slice(0, options.limit)
        .map(([key, value]) => [key, value as T])
    );
  }
  async transaction<T>(run: (storage: Storage) => Promise<T>) {
    const operation = this.pending.then(async () => {
      const snapshot = structuredClone(this.values);
      try {
        return await run(this);
      } catch (error) {
        this.values.clear();
        for (const [key, value] of snapshot) this.values.set(key, value);
        throw error;
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
const dispose: Array<() => void> = [];
function seed(db: SQLiteDatabase, tenant = TENANT, account = INPUT.targetId, user = 'legacy-user') {
  db.prepare(
    "INSERT INTO identity_subjects(id,tenant_id,subject_type,lifecycle_state,created_at,updated_at) VALUES(?,?,'person','active',1,1)"
  ).run('subject-' + account, tenant);
  db.prepare(
    "INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,primary_subject_id,created_at,updated_at) VALUES(?,?,'user','active',?,?,1,1)"
  ).run(account, tenant, user, 'subject-' + account);
}
let testMode: 'scheduled' | 'pipeline' = 'scheduled';
async function fixture(single = false) {
  const metadata = openCoreStore(TENANT),
    accounts = single ? metadata : openCoreStore(TENANT);
  const other = openCoreStore(TENANT);
  dispose.push(() => {
    metadata.db.close();
    if (!single) accounts.db.close();
    other.db.close();
  });
  for (const store of new Set([metadata, accounts, other])) store.db.exec('PRAGMA foreign_keys=ON');
  seed(accounts.db);
  if (!single) seed(metadata.db, TENANT, INPUT.targetId, 'metadata-decoy');
  const storage = new Storage();
  const rpc = new SessionRevocationStore({ storage } as unknown as DurableObjectState, {} as Env);
  await rpc.registerSessionRpc(
    TENANT,
    'legacy-user',
    'account:legacy-user',
    1,
    'session-1',
    Date.now() + 100000
  );
  const mutate = vi.spyOn(rpc, 'setAccountLifecycleEndingSessionsRpc');
  const logs = await logProducerFixture(testMode, {
    separateAdmin: true,
    corePublicationAdapter: metadata.adapter,
  });
  dispose.push(() => logs.close());
  logs.publicationSource.databaseId = IDENTITY.databaseId;
  const env = {
    ...logs.env,
    SESSION_REVOCATION_STORE: { idFromName: (value: string) => value, get: () => rpc },
  } as unknown as Env;
  const route = {
    bindingRef: 'ACCOUNT',
    tenantId: TENANT,
    generation: 1,
    dataRole: 'tenant_core/default',
    residencyPartition: 'default',
    shardGroup: 'default',
    shardIndex: 0,
    registryRow: { database_id: IDENTITY.databaseId, provider: 'd1' },
    ...IDENTITY,
    ...(single ? {} : { allocationScope: 'shared_pool' }),
  };
  world.metadata.mockReturnValue({ coreAdapter: metadata.adapter });
  world.context.mockReturnValue({ tenantId: TENANT, coreDb: metadata.adapter, route });
  const stores = [
    { bindingRef: 'ACCOUNT', identity: { ...IDENTITY }, adapter: accounts.adapter },
    {
      bindingRef: 'OTHER',
      identity: { ...IDENTITY, databaseId: 'physical-other', shardId: 'other-shard' },
      adapter: other.adapter,
    },
  ];
  world.stores.mockResolvedValue(stores);
  const c = { env } as Context<{ Bindings: Env }>;
  let clock = 1000;
  const audit = vi.fn(async () => undefined),
    ended = vi.fn(async () => undefined);
  const run = async (input = INPUT) =>
    recordAccountSuspensionSignal({
      env,
      metadata: metadata.adapter,
      publicationSource: logs.publicationSource,
      tenantId: TENANT,
      input,
      requestHash: await hashStableJson(input),
      now: () => clock,
      actorId: 'original-admin',
      actorType: 'admin_user',
      resolveOwner: () => resolveLifecycleSignalAccountOwner(c, TENANT, input.targetId),
      audit,
      sessionsEnded: ended,
    });
  const event = () =>
    metadata.db.prepare('SELECT * FROM external_lifecycle_signal_events').get() as
      | { id: string; observed_at: number; processing_state: string }
      | undefined;
  const state = () =>
    accounts.db
      .prepare('SELECT lifecycle_state,metadata_json,updated_at FROM identity_accounts WHERE id=?')
      .get(INPUT.targetId) as {
      lifecycle_state: string;
      metadata_json: string | null;
      updated_at: number;
    };
  return {
    logs,
    metadata,
    accounts,
    other,
    rpc,
    mutate,
    env,
    c,
    stores,
    run,
    event,
    state,
    audit,
    ended,
    clock: (value: number) => {
      clock = value;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  dispose.splice(0).forEach((close) => close());
});

describe.each(['scheduled', 'pipeline'] as const)(
  'account suspension signal storage and retry boundaries (%s)',
  (mode) => {
    beforeEach(() => {
      testMode = mode;
    });
    it.each([true, false])(
      'keeps metadata journal apart from the actual canonical owner (single=%s)',
      async (single) => {
        const f = await fixture(single);
        await expect(f.run()).resolves.toMatchObject({ decision: 'suspend_account' });
        expect(f.state().lifecycle_state).toBe('suspended');
        expect(f.event()?.processing_state).toBe('processed');
        expect(await f.logs.rows('core.provisioning_revocation_events')).toHaveLength(1);
        expect(
          f.metadata.db.prepare('SELECT count(*) AS n FROM provisioning_revocation_events').get()
        ).toEqual({ n: 0 });
        expect(
          f.metadata.db
            .prepare('SELECT count(*) AS n FROM external_lifecycle_signal_decisions')
            .get()
        ).toEqual({ n: 1 });
        expect(
          f.metadata.db.prepare('SELECT count(*) AS n FROM provisioning_revocation_receipts').get()
        ).toEqual({ n: 1 });
        if (!single)
          expect(
            f.metadata.db
              .prepare('SELECT lifecycle_state FROM identity_accounts WHERE id=?')
              .get(INPUT.targetId)
          ).toEqual({ lifecycle_state: 'active' });
        expect(f.ended).toHaveBeenCalledWith(
          f.event()?.id,
          expect.objectContaining({ userId: 'legacy-user' }),
          'original-admin',
          ['session-1']
        );
        await expect(f.run()).resolves.toMatchObject({ idempotent: true });
        expect(f.mutate).toHaveBeenCalledTimes(1);
      }
    );
    it('persists a stable pending operation before DO mutation and resumes after Core SQL failure without clock rewind', async () => {
      const f = await fixture();
      f.accounts.db.exec(
        "CREATE TRIGGER refuse_suspend BEFORE UPDATE ON identity_accounts BEGIN SELECT RAISE(ABORT,'account write blocked'); END"
      );
      await expect(f.run()).rejects.toThrow('account write blocked');
      const first = f.event();
      if (!first) throw new Error('pending_event_not_persisted');
      expect(first.processing_state).toBe('processing');
      expect(f.state().lifecycle_state).toBe('active');
      expect(
        await f.rpc.getAccountStateRpc(TENANT, 'legacy-user', 'account:legacy-user')
      ).toMatchObject({
        lifecycle: 'suspended',
        lifecycleOperationId: first.id,
        lifecycleVersionMs: first.observed_at,
      });
      f.accounts.db.exec(
        'DROP TRIGGER refuse_suspend; UPDATE identity_accounts SET updated_at=9000'
      );
      f.clock(8000);
      await expect(f.run()).resolves.toMatchObject({ signalEventId: first.id });
      expect(f.event()?.observed_at).toBe(1000);
      expect(f.state().updated_at).toBe(9000);
      expect(f.mutate.mock.calls.every((call) => call[4] === 1000 && call[5] === first.id)).toBe(
        true
      );
    });
    it('never treats a persisted decision or a newer activation as a completed suspension', async () => {
      const f = await fixture();
      f.metadata.db.exec(
        "CREATE TRIGGER refuse_processed BEFORE UPDATE ON external_lifecycle_signal_events BEGIN SELECT RAISE(ABORT,'final journal blocked'); END"
      );
      await expect(f.run()).rejects.toThrow('final journal blocked');
      expect(f.event()?.processing_state).toBe('processing');
      expect(
        f.metadata.db.prepare('SELECT count(*) AS n FROM provisioning_revocation_receipts').get()
      ).toEqual({ n: 0 });
      await transitionAccountLifecycle(f.env, f.accounts.adapter, {
        tenantId: TENANT,
        userId: 'legacy-user',
        lifecycle: 'active',
        status: 'active',
        versionMs: 2000,
        operationId: 'newer-activation',
        revokeSessions: false,
      });
      f.metadata.db.exec('DROP TRIGGER refuse_processed');
      f.clock(3000);
      await expect(f.run()).rejects.toBeInstanceOf(LifecycleSignalConflictError);
      expect(f.state().lifecycle_state).toBe('active');
      expect(f.event()?.processing_state).toBe('processing');
    });
    it('recovers a lost canonical batch response only from its exact primary result', async () => {
      const f = await fixture();
      const original = f.accounts.adapter.batch.bind(f.accounts.adapter);
      vi.spyOn(f.accounts.adapter, 'batch').mockImplementationOnce(async (statements) => {
        await original(statements);
        throw new Error('lost commit response');
      });
      await expect(f.run()).resolves.toMatchObject({ decision: 'suspend_account' });
      expect(f.event()?.processing_state).toBe('processed');
    });
    it('rejects placement changes on pending retry before another authentication-state mutation', async () => {
      const f = await fixture();
      f.accounts.db.exec(
        "CREATE TRIGGER refuse_suspend BEFORE UPDATE ON identity_accounts BEGIN SELECT RAISE(ABORT,'account write blocked'); END"
      );
      await expect(f.run()).rejects.toThrow();
      const mutations = f.mutate.mock.calls.length;
      f.stores[0].identity.databaseId = 'restored-different-physical-database';
      await expect(f.run()).rejects.toBeInstanceOf(LifecycleSignalConflictError);
      expect(f.mutate).toHaveBeenCalledTimes(mutations);
      expect(f.event()?.processing_state).toBe('processing');
    });
    it.each([
      'missing',
      'ambiguous',
      'duplicate_legacy',
      'unreadable',
      'over_limit',
      'unsupported',
      'deleted',
    ] as const)('refuses %s ownership before DO mutation', async (mode) => {
      const f = await fixture();
      if (mode === 'missing') f.accounts.db.exec('DELETE FROM identity_accounts');
      if (mode === 'ambiguous') seed(f.other.db);
      if (mode === 'duplicate_legacy') seed(f.accounts.db, TENANT, 'second-account');
      if (mode === 'unreadable')
        vi.spyOn(f.other.adapter, 'queryOne').mockRejectedValueOnce(new Error('unreadable shard'));
      if (mode === 'over_limit')
        world.stores.mockResolvedValue(Array.from({ length: 65 }, () => f.stores[0]));
      if (mode === 'unsupported')
        vi.spyOn(f.accounts.adapter, 'getType').mockReturnValue('postgres');
      if (mode === 'deleted')
        f.accounts.db.exec("UPDATE identity_accounts SET lifecycle_state='deleted'");
      await expect(f.run()).rejects.toThrow();
      expect(f.mutate).not.toHaveBeenCalled();
      expect(f.event()).toBeUndefined();
    });
    it('rejects alternate-body replay and legacy descriptor-less events without changing effects', async () => {
      const f = await fixture();
      await f.run();
      await expect(f.run({ ...INPUT, bindingVersion: 'different' })).rejects.toBeInstanceOf(
        LifecycleSignalConflictError
      );
      expect(f.mutate).toHaveBeenCalledTimes(1);
      f.metadata.db.exec('DELETE FROM external_lifecycle_signal_decisions');
      await expect(f.run()).rejects.toBeInstanceOf(LifecycleSignalConflictError);
      expect(f.mutate).toHaveBeenCalledTimes(1);
    });
    it('converges simultaneous distinct-key preparations to one event, decision and revocation', async () => {
      const f = await fixture();
      const results = await Promise.all([f.run(), f.run()]);
      expect(results[0].signalEventId).toBe(results[1].signalEventId);
      for (const table of [
        'external_lifecycle_signal_events',
        'external_lifecycle_signal_decisions',
        'provisioning_revocation_receipts',
      ]) {
        expect(f.metadata.db.prepare('SELECT count(*) AS n FROM ' + table).get()).toEqual({ n: 1 });
      }
      expect(
        f.mutate.mock.calls.every(
          (call) => call[4] === 1000 && call[5] === results[0].signalEventId
        )
      ).toBe(true);
    });
    it.each(['pending', 'processing', 'processed'])(
      'blocks legacy %s without an execution descriptor',
      async (status) => {
        const f = await fixture();
        const key = [
          INPUT.sourceType,
          INPUT.sourceId,
          INPUT.sourceEventId,
          INPUT.signalType,
          INPUT.targetType,
          INPUT.targetId,
        ].join(':');
        f.metadata.db
          .prepare(
            `INSERT INTO external_lifecycle_signal_events(id,tenant_id,source_type,source_id,source_event_id,observed_at,signal_type,dedupe_key,processing_state,created_at,updated_at) VALUES('legacy',?,?,?,?,1000,?,?,?,1000,1000)`
          )
          .run(
            TENANT,
            INPUT.sourceType,
            INPUT.sourceId,
            INPUT.sourceEventId,
            INPUT.signalType,
            key,
            status
          );
        await expect(f.run()).rejects.toBeInstanceOf(LifecycleSignalConflictError);
        expect(f.mutate).not.toHaveBeenCalled();
        expect(f.event()?.processing_state).toBe(status);
      }
    );
    it('does not prepare or mutate the DO when descriptor insertion aborts the atomic batch', async () => {
      const f = await fixture();
      f.metadata.db.exec(
        "CREATE TRIGGER refuse_descriptor BEFORE INSERT ON external_lifecycle_signal_decisions BEGIN SELECT RAISE(ABORT,'descriptor blocked'); END"
      );
      await expect(f.run()).rejects.toThrow('descriptor blocked');
      expect(f.event()).toBeUndefined();
      expect(f.mutate).not.toHaveBeenCalled();
    });
    it('recovers the original prepare after an atomic batch response is lost', async () => {
      const f = await fixture();
      const original = f.metadata.adapter.batch.bind(f.metadata.adapter);
      vi.spyOn(f.metadata.adapter, 'batch').mockImplementationOnce(async (statements) => {
        await original(statements);
        throw new Error('prepare commit response lost');
      });
      await expect(f.run()).resolves.toMatchObject({ decision: 'suspend_account' });
      expect(f.event()?.observed_at).toBe(1000);
      expect(f.mutate.mock.calls[0][4]).toBe(1000);
    });
    it('leaves an unknown or unavailable DO result pending without generating a new operation', async () => {
      const f = await fixture();
      const binding = f.env.SESSION_REVOCATION_STORE;
      Reflect.deleteProperty(f.env, 'SESSION_REVOCATION_STORE');
      await expect(f.run()).rejects.toThrow('session_revocation_store_unavailable');
      const pending = f.event();
      expect(pending?.processing_state).toBe('processing');
      expect(f.state().lifecycle_state).toBe('active');
      f.env.SESSION_REVOCATION_STORE = binding;
      f.clock(5000);
      await expect(f.run()).resolves.toMatchObject({ signalEventId: pending?.id });
      expect(f.event()?.observed_at).toBe(1000);
    });
    it('rejects a same-ID account belonging only to another tenant and preserves it', async () => {
      const f = await fixture();
      f.accounts.db.exec('DELETE FROM identity_accounts');
      seed(f.other.db, 'tenant-b', INPUT.targetId, 'other-tenant-user');
      await expect(f.run()).rejects.toThrow('lifecycle_signal_account_owner_not_unique');
      expect(f.mutate).not.toHaveBeenCalled();
      expect(
        f.other.db
          .prepare('SELECT lifecycle_state FROM identity_accounts WHERE id=?')
          .get(INPUT.targetId)
      ).toEqual({ lifecycle_state: 'active' });
    });
    it.each([{ accountId: 'different-account' }, { subjectId: 'different-subject' }])(
      'rejects caller identity mismatch %j before DO effects',
      async (mismatch) => {
        const f = await fixture();
        await expect(f.run({ ...INPUT, ...mismatch })).rejects.toThrow('canonical owner');
        expect(f.event()).toBeUndefined();
        expect(f.mutate).not.toHaveBeenCalled();
      }
    );
    it('does not infer success when the canonical account disappears after the DO transition', async () => {
      const f = await fixture();
      const original = SessionRevocationStore.prototype.setAccountLifecycleEndingSessionsRpc.bind(
        f.rpc
      );
      f.mutate.mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        f.accounts.db.exec('DELETE FROM identity_accounts');
        return result;
      });
      await expect(f.run()).rejects.toBeInstanceOf(LifecycleSignalConflictError);
      expect(f.event()?.processing_state).toBe('processing');
      expect(
        f.metadata.db.prepare('SELECT count(*) AS n FROM provisioning_revocation_receipts').get()
      ).toEqual({ n: 0 });
      expect(f.ended).toHaveBeenCalledWith(
        f.event()?.id,
        expect.objectContaining({ userId: 'legacy-user' }),
        'original-admin',
        ['session-1']
      );
    });
    it('never updates another internal account if a duplicate legacy ID appears after the owner check', async () => {
      const f = await fixture();
      const original = SessionRevocationStore.prototype.setAccountLifecycleEndingSessionsRpc.bind(
        f.rpc
      );
      f.mutate.mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        seed(f.accounts.db, TENANT, 'competing-account');
        // The legacy index is deliberately made to return the competing account first.
        f.accounts.db.exec("UPDATE identity_accounts SET rowid=-1 WHERE id='competing-account'");
        return result;
      });
      await expect(f.run()).rejects.toBeInstanceOf(LifecycleSignalConflictError);
      expect(f.state().lifecycle_state).toBe('suspended');
      expect(
        f.accounts.db
          .prepare("SELECT lifecycle_state FROM identity_accounts WHERE id='competing-account'")
          .get()
      ).toEqual({ lifecycle_state: 'active' });
      expect(f.event()?.processing_state).toBe('processing');
    });
    it('rejects conflicting physical owner preparations while retaining a single durable descriptor', async () => {
      const f = await fixture();
      const different = f.stores.map((store) => ({
        ...store,
        identity: { ...store.identity, databaseId: 'different-' + store.identity.databaseId },
      }));
      world.stores.mockResolvedValueOnce(f.stores).mockResolvedValueOnce(different);
      const outcomes = await Promise.allSettled([f.run(), f.run()]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(
        f.metadata.db.prepare('SELECT count(*) AS n FROM external_lifecycle_signal_decisions').get()
      ).toEqual({ n: 1 });
    });
    it('rejects a colon-joined dedupe collision using original fields and the pinned target', async () => {
      const f = await fixture();
      const target = 'internal-account:scim_active_false:account:tail';
      f.accounts.db
        .prepare('UPDATE identity_accounts SET id=? WHERE id=?')
        .run(target, INPUT.targetId);
      await f.run({ ...INPUT, targetId: target });
      const mutations = f.mutate.mock.calls.length;
      await expect(
        f.run({
          ...INPUT,
          sourceEventId: INPUT.sourceEventId + ':scim_active_false:account:internal-account',
          targetId: 'tail',
        })
      ).rejects.toBeInstanceOf(LifecycleSignalConflictError);
      expect(f.mutate).toHaveBeenCalledTimes(mutations);
      expect(
        f.metadata.db.prepare('SELECT count(*) AS n FROM external_lifecycle_signal_events').get()
      ).toEqual({ n: 1 });
    });
    it('keeps the confirmed suspension response when best-effort audit/logout delivery fails', async () => {
      const f = await fixture();
      f.audit.mockRejectedValueOnce(new Error('audit delivery failed'));
      f.ended.mockRejectedValueOnce(new Error('logout delivery failed'));
      await expect(f.run()).resolves.toMatchObject({ decision: 'suspend_account' });
      expect(f.state().lifecycle_state).toBe('suspended');
      expect(f.event()?.processing_state).toBe('processed');
    });
    it('keeps Admin idempotency in Admin and records original actor/logout operation through the actual handler', async () => {
      const f = await fixture();
      const db = new DatabaseSync(':memory:');
      dispose.push(() => db.close());
      const directory = new URL('../../../../migrations/admin/d1/', import.meta.url);
      for (const name of readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort())
        db.exec(
          renderPortableMigrationSql(readFileSync(new URL(name, directory), 'utf8'), 'sqlite')
        );
      db.exec('PRAGMA foreign_keys=ON');
      const env = { ...f.env, DB_ADMIN: d1OverSqlite(db) };
      expect(ensureDatabaseAdapter(env.DB_ADMIN, 'test').getType()).toBe('d1');
      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        (c as unknown as { set(name: string, value: unknown): void }).set('adminAuth', {
          userId: 'executing-admin',
          authMethod: 'session',
        });
        await next();
      });
      app.post(
        '/api/admin/field-mapping/lifecycle-signals',
        adminIdentityMappingLifecycleSignalRecordHandler
      );
      const response = await app.request(
        '/api/admin/field-mapping/lifecycle-signals',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': TENANT,
            'Idempotency-Key': 'request-1',
          },
          body: JSON.stringify(INPUT),
        },
        env
      );
      expect(response.status).toBe(200);
      const responseText = await response.text();
      const result = JSON.parse(responseText) as { result: { signalEventId: string } };
      expect(
        db.prepare('SELECT status FROM idempotency_records WHERE tenant_id=?').get(TENANT)
      ).toEqual({ status: 'complete' });
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='external_lifecycle_signal_events'")
          .get()
      ).toBeUndefined();
      expect(world.audit).toHaveBeenCalledTimes(1);
      const auditInput: unknown = world.audit.mock.calls[0][1];
      expect(auditInput).toMatchObject({
        result: 'success',
        metadata: {
          signal_event_id: result.result.signalEventId,
          original_actor_id: 'executing-admin',
          original_actor_type: 'admin_user',
        },
      });
      expect(world.logout).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          trigger: {
            action: 'user.suspend',
            operationId: result.result.signalEventId,
            actorId: 'executing-admin',
          },
          sessions: [{ userId: 'legacy-user', sessionId: 'session-1' }],
        })
      );
      expect(responseText).not.toContain('physical-account');
      // Completed HTTP idempotency still requires the metadata completion, but never the
      // account's present state: a later legitimate activation must remain active.
      const first = f.event();
      await transitionAccountLifecycle(f.env, f.accounts.adapter, {
        tenantId: TENANT,
        userId: 'legacy-user',
        lifecycle: 'active',
        status: 'active',
        versionMs: (first?.observed_at ?? 0) + 1,
        operationId: 'normal-reactivation',
        revokeSessions: false,
      });
      const mutations = f.mutate.mock.calls.length;
      const inventories = world.stores.mock.calls.length;
      const replay = () =>
        app.request(
          '/api/admin/field-mapping/lifecycle-signals',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id': TENANT,
              'Idempotency-Key': 'request-1',
            },
            body: JSON.stringify(INPUT),
          },
          env
        );
      expect((await replay()).status).toBe(200);
      expect(f.state().lifecycle_state).toBe('active');
      expect(f.mutate).toHaveBeenCalledTimes(mutations);
      expect(world.stores).toHaveBeenCalledTimes(inventories);
      f.metadata.db.exec('DELETE FROM external_lifecycle_signal_events');
      expect((await replay()).status).toBe(409);
      expect(f.event()).toBeUndefined();
      expect(f.mutate).toHaveBeenCalledTimes(mutations);
      expect(world.stores).toHaveBeenCalledTimes(inventories);
      // A legacy event without the pinned descriptor cannot rescue an old cached success.
      const key = [
        INPUT.sourceType,
        INPUT.sourceId,
        INPUT.sourceEventId,
        INPUT.signalType,
        INPUT.targetType,
        INPUT.targetId,
      ].join(':');
      f.metadata.db
        .prepare(
          `INSERT INTO external_lifecycle_signal_events(id,tenant_id,source_type,source_id,source_event_id,observed_at,signal_type,dedupe_key,processing_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'processed',?,?)`
        )
        .run(
          result.result.signalEventId,
          TENANT,
          INPUT.sourceType,
          INPUT.sourceId,
          INPUT.sourceEventId,
          first?.observed_at ?? 1,
          INPUT.signalType,
          key,
          first?.observed_at ?? 1,
          first?.observed_at ?? 1
        );
      expect((await replay()).status).toBe(409);
      expect(f.event()?.processing_state).toBe('processed');
      expect(f.mutate).toHaveBeenCalledTimes(mutations);
      expect(world.stores).toHaveBeenCalledTimes(inventories);
      expect(
        db.prepare('SELECT status FROM idempotency_records WHERE tenant_id=?').get(TENANT)
      ).toEqual({ status: 'complete' });
    });
  }
);

import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GuestLifecycleRepository,
  type DatabaseAdapter,
  type Env,
  type GuestLifecycleRow,
} from '@authrim/ar-lib-core';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  piiSource: vi.fn(),
  piiExecute: vi.fn(),
  piiQuery: vi.fn(),
  transition: vi.fn(),
  state: vi.fn(),
  prepare: vi.fn(),
  erase: vi.fn(),
  writeDelete: vi.fn(),
  ready: vi.fn(),
  remove: vi.fn(),
  cache: vi.fn(),
  audit: vi.fn(),
  hold: vi.fn(),
  recover: vi.fn(),
  events: [] as string[],
}));
vi.mock('../account-guest-upgrade', () => ({ recoverAccountGuestUpgrade: mocks.recover }));
vi.mock('../account-legal-hold-guard', () => ({ findActiveAccountLegalHold: mocks.hold }));
vi.mock('../account-directory-removal-producer', () => ({
  prepareAccountDirectoryRemoval: mocks.prepare,
  eraseAccountPiiAfterDirectoryRemovalPrepared: mocks.erase,
  markAccountDirectoryRemovalsReady: mocks.ready,
  attemptImmediateAccountDirectoryRemovals: mocks.remove,
}));
vi.mock('../account-identifier-addition', () => ({
  buildAccountEmailAddition: vi.fn(),
  buildAccountExternalSubjectAddition: vi.fn(),
}));
vi.mock('../account-directory-reservation', () => ({
  InitialAccountIdentifierReservationService: vi.fn(),
}));
vi.mock('../lookup-bucket-write-route', () => ({ createLookupBucketWriteResolver: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveAccountDataContext: mocks.resolve,
  resolveTenantDatabaseSourceFromRegistry: mocks.piiSource,
  ensureDatabaseAdapter: () => ({ execute: mocks.piiExecute, query: mocks.piiQuery }),
  transitionAccountAuthenticationState: mocks.transition,
  getSessionRevocationStore: () => ({ getAccountStateRpc: mocks.state }),
  CanonicalIdentityRepository: vi.fn(function () {}),
  CanonicalRuntimeUserWriter: vi.fn(function () {
    return { deleteRuntimeUser: mocks.writeDelete };
  }),
  invalidateUserCache: mocks.cache,
  createAuditLog: mocks.audit,
}));
import {
  deleteOneGuestAccount,
  cleanupExpiredGuestProofs,
  processGuestLifecycleMaintenance,
} from '../guest-lifecycle-scheduled';

describe('hourly guest deletion state transitions', () => {
  let db: SQLiteDatabase;
  let core: DatabaseAdapter;
  let lifecycle: GuestLifecycleRepository;
  let candidate: GuestLifecycleRow;
  const env = {} as Env;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE identity_accounts (tenant_id TEXT, legacy_user_id TEXT, account_type TEXT, deleted_at INTEGER, registration_state TEXT, updated_at INTEGER);
    INSERT INTO identity_accounts VALUES ('tenant', 'guest', 'user', NULL, 'guest', 0);
    CREATE TABLE guest_devices (tenant_id TEXT, user_id TEXT);
    INSERT INTO guest_devices VALUES ('tenant', 'guest');
    INSERT INTO guest_devices VALUES ('other', 'guest');
    CREATE TABLE passkeys (tenant_id TEXT, user_id TEXT);`);
    db.exec(
      readFileSync(
        new URL('../../../../migrations/core/d1/002_guest_account_lifecycle.sql', import.meta.url),
        'utf8'
      )
    );
    core = {
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null;
      },
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
    } as DatabaseAdapter;
    lifecycle = new GuestLifecycleRepository(core, 'tenant');
    candidate = await lifecycle.enroll({
      userId: 'guest',
      clientId: 'client',
      createdAt: 1,
      deletionAfterDays: 1,
      policyVersion: 'policy',
    });
    mocks.resolve.mockResolvedValue({
      tenantId: 'tenant',
      legacyUserId: 'guest',
      coreBindingRef: 'CORE',
      piiBindingRef: 'PII',
      piiResidencyPartition: 'default',
      membership: { routeProjection: { schemaVersion: 1 } },
    });
    mocks.piiSource.mockResolvedValue({ source: {} });
    mocks.piiQuery.mockResolvedValue([]);
    mocks.hold.mockResolvedValue(null);
    mocks.state.mockResolvedValue({ lifecycle: 'active' });
    mocks.transition.mockImplementation(async (_env: unknown, input: { lifecycle: string }) => {
      mocks.events.push(input.lifecycle);
    });
    mocks.prepare.mockImplementation(async () => {
      mocks.events.push('prepare');
      return [];
    });
    mocks.erase.mockImplementation(async () => {
      mocks.events.push('erase');
    });
    mocks.writeDelete.mockImplementation(async () => {
      mocks.events.push('delete-account');
    });
    mocks.ready.mockImplementation(async () => {
      mocks.events.push('ready');
    });
    mocks.audit.mockImplementation(async () => {
      mocks.events.push('audit');
    });
  });
  afterEach(() => db.close());
  const run = (now = 90000) =>
    deleteOneGuestAccount(env, {
      tenantId: 'tenant',
      core,
      coreBindingRef: 'CORE',
      candidate,
      now,
    });
  it('cleans abandoned proof with retention disabled while retaining the account', async () => {
    await lifecycle.applyRetention('guest', candidate.revision, null, 'off', 2);
    mocks.piiQuery.mockResolvedValue([
      {
        operation_id: 'expired',
        user_id: 'guest',
        expires_at: 500,
        state: 'verified',
        reservation_publication_json: null,
      },
    ]);
    await cleanupExpiredGuestProofs(env, 'tenant', core, 'CORE', 'guest', 1000);
    expect((await lifecycle.get('guest'))?.phase).toBe('active');
    expect((await lifecycle.get('guest'))?.deletion_due_at).toBeNull();
    expect(await lifecycle.beginUpgrade('guest', 'expired', 499, 500)).toBe(false);
    expect(mocks.piiExecute).toHaveBeenCalledWith(
      expect.stringContaining('proof_payload_json = NULL'),
      [1000, 'tenant', 'expired', 1000]
    );
    expect(mocks.writeDelete).not.toHaveBeenCalled();
  });
  it('rejects cleanup across a mismatched tenant route before touching proof', async () => {
    await expect(
      cleanupExpiredGuestProofs(env, 'other', core, 'CORE', 'guest', 1000)
    ).rejects.toThrow('guest_proof_cleanup_route_mismatch');
    expect(mocks.piiQuery).not.toHaveBeenCalled();
    expect(mocks.piiExecute).not.toHaveBeenCalled();
  });
  it('does not erase proof accepted for crash recovery', async () => {
    await lifecycle.beginUpgrade('guest', 'accepted', 400, 500);
    mocks.piiQuery.mockResolvedValue([
      {
        operation_id: 'accepted',
        user_id: 'guest',
        expires_at: 500,
        state: 'verified',
        reservation_publication_json: null,
      },
    ]);
    await cleanupExpiredGuestProofs(env, 'tenant', core, 'CORE', 'guest', 1000);
    expect(mocks.piiExecute).not.toHaveBeenCalled();
  });
  it('records a failed deletion attempt and replaces it after successful retry', async () => {
    const values = new Map<string, string>();
    const config = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    mocks.erase.mockRejectedValueOnce(new Error('unavailable'));
    const targets = [{ tenantId: 'tenant', adapters: [{ bindingRef: 'CORE', adapter: core }] }];
    await processGuestLifecycleMaintenance(
      { ...env, AUTHRIM_CONFIG: config } as unknown as Env,
      targets,
      log
    );
    expect(JSON.parse(values.get('guest-maintenance-status:tenant:guest')!)).toMatchObject({
      state: 'retrying',
      attempted_at: expect.any(Number) as unknown,
    });
    expect((await lifecycle.get('guest'))?.phase).toBe('deleting');
    await processGuestLifecycleMaintenance(
      { ...env, AUTHRIM_CONFIG: config } as unknown as Env,
      targets,
      log
    );
    expect(JSON.parse(values.get('guest-maintenance-status:tenant:guest')!)).toMatchObject({
      state: 'completed',
    });
    expect((await lifecycle.get('guest'))?.phase).toBe('deleted');
  });
  it.each(['processing', 'completed', 'all'])(
    'finishes deletion when optional %s observation writes fail',
    async (failedState) => {
      const config = {
        get: async () => null,
        put: vi.fn(async (key: string, value: string) => {
          if (
            key.startsWith('guest-maintenance-status:') &&
            (failedState === 'all' ||
              (JSON.parse(value) as { state: string }).state === failedState)
          ) {
            throw new Error('private provider failure');
          }
        }),
      };
      const log = { info: vi.fn(), warn: vi.fn() };
      await processGuestLifecycleMaintenance(
        { ...env, AUTHRIM_CONFIG: config } as unknown as Env,
        [{ tenantId: 'tenant', adapters: [{ bindingRef: 'CORE', adapter: core }] }],
        log
      );
      expect((await lifecycle.get('guest'))?.phase).toBe('deleted');
      expect(mocks.writeDelete).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith('Guest lifecycle maintenance completed', {
        upgraded: 0,
        deleted: 1,
        failed: 0,
      });
      expect(log.warn).not.toHaveBeenCalled();
      expect(
        config.put.mock.calls.filter(([key]) => key.startsWith('guest-maintenance-status:'))
      ).toHaveLength(2);
    }
  );
  it('advances the shard cursor before a failed shard so later work still runs', async () => {
    const values = new Map<string, string>();
    const config = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const broken = {
      query: vi.fn(async () => {
        throw new Error('offline');
      }),
    } as unknown as DatabaseAdapter;
    const healthyQuery = vi.fn(async () => []);
    const healthy = { query: healthyQuery } as unknown as DatabaseAdapter;
    const log = { info: vi.fn(), warn: vi.fn() };
    await processGuestLifecycleMaintenance(
      { AUTHRIM_CONFIG: config } as unknown as Env,
      [
        {
          tenantId: 'tenant',
          adapters: [
            { bindingRef: 'bad', adapter: broken },
            { bindingRef: 'good', adapter: healthy },
          ],
        },
      ],
      log
    );
    expect(healthyQuery).toHaveBeenCalledTimes(3);
    expect(config.put.mock.calls.map((call) => call[1])).toEqual(['1', '0']);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { failed: 1 });
  });
  it('revokes authentication before erasure, preserves another tenant and records completion', async () => {
    expect(await run()).toBe('deleted');
    expect(mocks.events).toEqual([
      'deleting',
      'prepare',
      'erase',
      'delete-account',
      'deleted',
      'ready',
      'audit',
    ]);
    expect(await lifecycle.get('guest')).toMatchObject({ phase: 'deleted', deleted_at: 90000 });
    expect(db.prepare('SELECT * FROM guest_devices').all()).toEqual([
      { tenant_id: 'other', user_id: 'guest' },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ tenantId: 'tenant', userId: 'guest', action: 'user.deleted' })
    );
  });
  it.each(['registered', 'upgrading'])('does not delete a guest that became %s', async (phase) => {
    await core.execute('UPDATE guest_account_lifecycle SET phase = ?', [phase]);
    expect(await run()).toBe('skipped');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.erase).not.toHaveBeenCalled();
  });
  it('honors a legal hold without claiming deletion', async () => {
    mocks.hold.mockResolvedValue({ holdId: 'hold' });
    expect(await run()).toBe('held');
    expect((await lifecycle.get('guest'))?.phase).toBe('active');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('never applies human deletion to a machine or registered identity', async () => {
    await core.execute("UPDATE identity_accounts SET account_type = 'device'");
    expect(await run()).toBe('skipped');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('does not delete before the deadline or during the one-time hold', async () => {
    expect(await run(86400)).toBe('skipped');
    await lifecycle.acquireHold('guest', 90000, 10);
    expect(await run(90001)).toBe('skipped');
    expect(mocks.erase).not.toHaveBeenCalled();
  });
  it('loses safely if registration wins while resolving the route', async () => {
    mocks.resolve.mockImplementationOnce(async () => {
      await lifecycle.beginUpgrade('guest', 'upgrade', 90000, 90600);
      return {
        tenantId: 'tenant',
        legacyUserId: 'guest',
        coreBindingRef: 'CORE',
        piiBindingRef: 'PII',
        piiResidencyPartition: 'default',
        membership: { routeProjection: {} },
      };
    });
    expect(await run()).toBe('skipped');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('retries using the pinned PII target without an account lookup after erasure failure', async () => {
    mocks.erase.mockRejectedValueOnce(new Error('pii_temporarily_unavailable'));
    await expect(run()).rejects.toThrow('pii_temporarily_unavailable');
    expect((await lifecycle.get('guest'))?.phase).toBe('deleting');
    mocks.resolve.mockRejectedValue(new Error('account_route_removed'));
    expect(await run(93600)).toBe('deleted');
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.piiSource).toHaveBeenLastCalledWith(
      env,
      expect.objectContaining({ tenantId: 'tenant', bindingRef: 'PII', role: 'tenant_pii' })
    );
  });
  it('does not regress deleted authentication when retrying the final audit step', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit_unavailable'));
    await expect(run()).rejects.toThrow('audit_unavailable');
    mocks.state.mockResolvedValue({ lifecycle: 'deleted' });
    mocks.transition.mockClear();
    expect(await run(93600)).toBe('deleted');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('rejects a corrupted cross-tenant recovery route before PII access', async () => {
    await lifecycle.beginDeletion(
      'guest',
      'delete',
      90000,
      JSON.stringify({ schemaVersion: 1, tenantId: 'other' }),
      90000000
    );
    await expect(run()).rejects.toThrow('guest_deletion_route_invalid');
    expect(mocks.piiSource).not.toHaveBeenCalled();
    expect(mocks.erase).not.toHaveBeenCalled();
  });
});

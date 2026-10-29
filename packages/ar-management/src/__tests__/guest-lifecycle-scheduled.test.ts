import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GuestLifecycleRepository,
  GuestUpgradeRepository,
  lookupVirtualBucket,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { GuestCoreOwner } from '../guest-account-storage';
import { openGuestStore, guestReceiptFixture } from './helpers/guest-erasure-fixture';

// This suite covers the scheduler/step boundary. Worker authorization and erasure effects are
// exercised by guest-deletion-worker.integration.test.ts, not approved through mocked SQL here.
const mocks = vi.hoisted(() => ({
  step: vi.fn<typeof import('../guest-deletion-worker').runGuestDeletionStep>(),
  stores: vi.fn<typeof import('../guest-account-storage').guestCoreStores>(),
  storage: vi.fn<typeof import('../guest-account-storage').resolveGuestOwnerStorage>(),
  route: vi.fn<typeof import('../guest-account-storage').makeGuestDeletionRoute>(),
  verify: vi.fn<typeof import('../guest-deletion-route').verifyGuestDeletionPins>(),
  recover: vi.fn<typeof import('../account-guest-upgrade').recoverAccountGuestUpgrade>(),
  release: vi.fn<(publication: AccountDirectoryPublication) => Promise<void>>(),
  lookup: vi.fn(),
}));
vi.mock('../guest-deletion-worker', () => ({ runGuestDeletionStep: mocks.step }));
vi.mock('../guest-account-storage', async (original) => ({
  ...(await original<typeof import('../guest-account-storage')>()),
  guestCoreStores: mocks.stores,
  resolveGuestOwnerStorage: mocks.storage,
  makeGuestDeletionRoute: mocks.route,
}));
vi.mock('../guest-deletion-route', async (original) => ({
  ...(await original<typeof import('../guest-deletion-route')>()),
  verifyGuestDeletionPins: mocks.verify,
}));
vi.mock('../account-guest-upgrade', () => ({ recoverAccountGuestUpgrade: mocks.recover }));
vi.mock('../account-directory-reservation', () => ({
  InitialAccountIdentifierReservationService: vi.fn(function () {
    return { release: mocks.release };
  }),
}));
vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: mocks.lookup,
}));
import {
  createGuestDeletionRoute,
  deleteOneGuestAccount,
  cleanupExpiredGuestProofs,
  processGuestLifecycleMaintenance,
} from '../guest-lifecycle-scheduled';

const stores: ReturnType<typeof openGuestStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(90_000_000);
  mocks.step.mockResolvedValue('pending');
  mocks.recover.mockResolvedValue('pending');
  mocks.release.mockResolvedValue(undefined);
  mocks.lookup.mockResolvedValue(async () => {
    throw new Error('unused_lookup_transport');
  });
});
async function fixture() {
  const core = openGuestStore('core'),
    pii = openGuestStore('pii');
  stores.push(core, pii);
  const raw = guestReceiptFixture();
  const route = GuestLifecycleRepository.parseDeletionRouteV2(JSON.stringify(raw), {
    tenantId: raw.tenantId,
    userId: raw.userId,
  });
  core.db
    .prepare(
      "INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,'Fixture',1,1)"
    )
    .run(route.tenantId, route.tenantId, 'key-guest');
  core.db
    .prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at) VALUES(?,?,'user','active',?,'guest','active',1,1,1)`
    )
    .run(route.accountId, route.tenantId, route.userId);
  const lifecycle = new GuestLifecycleRepository(core.adapter, route.tenantId);
  const candidate = await lifecycle.enroll({
    userId: route.userId,
    clientId: 'app',
    createdAt: 1,
    deletionAfterDays: 1,
    policyVersion: 'policy',
  });
  const source = {
    adapter: core.adapter,
    bindingRef: route.corePin.bindingRef,
    pin: route.corePin,
  };
  mocks.stores.mockResolvedValue([source]);
  mocks.storage.mockImplementation(async (_env: Env, owner: GuestCoreOwner, tenantId: string) => {
    if (!owner.account || tenantId !== route.tenantId)
      throw new Error('fixture_storage_scope_mismatch');
    return {
      account: owner.account,
      core: core.adapter,
      pii: pii.adapter,
      routeProjection: route.routeProjection,
      corePin: route.corePin,
      piiPin: route.piiPin,
    };
  });
  mocks.route.mockResolvedValue(route);
  mocks.verify.mockResolvedValue({ core: core.adapter, pii: pii.adapter });
  const operations = new GuestUpgradeRepository(pii.adapter, route.tenantId);
  const seedProof = async (
    operationId = 'expired',
    publication: AccountDirectoryPublication | null = null
  ) => {
    await operations.create({
      operationId,
      userId: route.userId,
      clientId: 'app',
      sessionId: 'session',
      requestTokenHash: 'a'.repeat(64),
      method: 'email',
      payloadJson: '{"fixtureProof":true}',
      verifier: 'verifier',
      now: 1,
      expiresAt: 500,
    });
    await pii.adapter.execute(
      "UPDATE guest_upgrade_operations SET state='verified',reservation_publication_json=? WHERE operation_id=?",
      [publication === null ? null : JSON.stringify(publication), operationId]
    );
  };
  return { core, pii, route, source, lifecycle, candidate, operations, seedProof };
}
function configFixture(failState?: string) {
  const values = new Map<string, string>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    if (
      key.startsWith('guest-maintenance-status:') &&
      (failState === 'all' || (JSON.parse(value) as { state: string }).state === failState)
    )
      throw new Error('observation_unavailable');
    values.set(key, value);
  });
  const env = { AUTHRIM_CONFIG: { get, put } } as unknown as Env;
  return { env, values, get, put };
}
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
function readStatus(
  values: Map<string, string>,
  tenantId: string,
  userId: string
): { state: string; attempted_at: number } {
  const value = values.get(`guest-maintenance-status:${tenantId}:${userId}`);
  if (!value) throw new Error('missing_status');
  return JSON.parse(value) as { state: string; attempted_at: number };
}
async function publication(
  f: Awaited<ReturnType<typeof fixture>>
): Promise<AccountDirectoryPublication> {
  const digest = 'ab'.repeat(32);
  return {
    operationId: 'upgrade-reservation',
    idempotencyKey: 'upgrade-reservation',
    tenantId: f.route.tenantId,
    accountId: f.route.accountId,
    routeProjection: f.route.routeProjection,
    indexes: [
      {
        indexKind: 'account_id',
        normalizationVersion: 1,
        hmacKeyGeneration: 1,
        digest,
        virtualBucket: await lookupVirtualBucket('account_id', digest),
      },
    ],
  };
}

describe('v2 deletion step wrapper', () => {
  it.each(['pending', 'deleted', 'held', 'skipped'] as const)(
    'passes %s through without inventing bulk erasure effects',
    async (result) => {
      const f = await fixture(),
        env = {} as Env;
      const input = {
        tenantId: f.route.tenantId,
        core: f.core.adapter,
        coreBindingRef: f.route.corePin.bindingRef,
        candidate: f.candidate,
        now: 90000,
      };
      mocks.step.mockResolvedValueOnce(result);
      expect(await deleteOneGuestAccount(env, input)).toBe(result);
      expect(mocks.step).toHaveBeenCalledExactlyOnceWith(env, input);
      expect(mocks.step.mock.calls[0]?.[1]).toBe(input);
      // A boundary mock is not evidence of a durable deletion, even when its return value is deleted.
      expect((await f.lifecycle.get(f.route.userId))?.phase).toBe('active');
      expect(mocks.storage).not.toHaveBeenCalled();
    }
  );
  it('preserves step failure so the scheduler can retry the pinned durable job', async () => {
    const f = await fixture(),
      error = new Error('pii_temporarily_unavailable');
    mocks.step.mockRejectedValueOnce(error);
    await expect(
      deleteOneGuestAccount({} as Env, {
        tenantId: f.route.tenantId,
        core: f.core.adapter,
        coreBindingRef: f.route.corePin.bindingRef,
        candidate: f.candidate,
        now: 90000,
      })
    ).rejects.toBe(error);
    expect((await f.lifecycle.get(f.route.userId))?.phase).toBe('active');
  });
  it('constructs a v2 route from the canonical owner and verifies actual PII schema before returning it', async () => {
    const f = await fixture(),
      env = {} as Env;
    const input = {
      tenantId: f.route.tenantId,
      userId: f.route.userId,
      operationId: f.route.operationId,
      completionAuditId: f.route.completionAuditId,
      origin: 'admin' as const,
    };
    expect(await createGuestDeletionRoute(env, input)).toEqual(f.route);
    expect(mocks.route.mock.calls[0]?.[1]).toMatchObject({
      userId: f.route.userId,
      account: { id: f.route.accountId },
      bindingRef: f.route.corePin.bindingRef,
      pin: f.route.corePin,
    });
    expect(mocks.route.mock.calls[0]?.[2]).toEqual(input);
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(env, f.route);
    expect(f.route.accountId).not.toBe(f.route.userId);
  });
  it('rejects a v2 route whose physical PII schema lacks a source guard', async () => {
    const f = await fixture();
    f.pii.db.exec('DROP TRIGGER trg_guest_pii_users_pii_delete');
    await expect(
      createGuestDeletionRoute({} as Env, {
        tenantId: f.route.tenantId,
        userId: f.route.userId,
        operationId: f.route.operationId,
        completionAuditId: f.route.completionAuditId,
        origin: 'admin',
      })
    ).rejects.toThrow('guest_pii_erasure_schema_unsupported');
  });
});

describe('expired Guest proof cleanup on actual Core and PII repositories', () => {
  it('fences abandoned proof with retention disabled and keeps the account', async () => {
    const f = await fixture();
    await f.seedProof();
    await f.lifecycle.applyRetention(f.route.userId, f.candidate.revision, null, 'off', 2);
    await cleanupExpiredGuestProofs(
      {} as Env,
      f.route.tenantId,
      f.core.adapter,
      f.route.corePin.bindingRef,
      f.route.userId,
      1000
    );
    expect(await f.lifecycle.get(f.route.userId)).toMatchObject({
      phase: 'active',
      deletion_due_at: null,
      upgrade_admission_floor: 500,
    });
    expect(await f.operations.get('expired')).toMatchObject({
      state: 'canceled',
      proof_payload_json: null,
      challenge_verifier: null,
      reservation_publication_json: null,
    });
    expect(await f.lifecycle.beginUpgrade(f.route.userId, 'expired', 499, 500)).toBe(false);
    expect(mocks.step).not.toHaveBeenCalled();
  });
  it('rejects a mismatched tenant or binding before proof access', async () => {
    const f = await fixture();
    await f.seedProof();
    const query = vi.spyOn(f.pii.adapter, 'query'),
      execute = vi.spyOn(f.pii.adapter, 'execute');
    for (const [tenant, binding] of [
      ['other', f.route.corePin.bindingRef],
      [f.route.tenantId, 'DB_OTHER'],
    ])
      await expect(
        cleanupExpiredGuestProofs({} as Env, tenant, f.core.adapter, binding, f.route.userId, 1000)
      ).rejects.toThrow('guest_proof_cleanup_route_mismatch');
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.storage).not.toHaveBeenCalled();
  });
  it('preserves same-operation proof already accepted for upgrade recovery', async () => {
    const f = await fixture();
    await f.seedProof('accepted');
    expect(await f.lifecycle.beginUpgrade(f.route.userId, 'accepted', 400, 500)).toBe(true);
    await cleanupExpiredGuestProofs(
      {} as Env,
      f.route.tenantId,
      f.core.adapter,
      f.route.corePin.bindingRef,
      f.route.userId,
      1000
    );
    expect(await f.operations.get('accepted')).toMatchObject({
      state: 'verified',
      proof_payload_json: '{"fixtureProof":true}',
      challenge_verifier: 'verifier',
    });
    expect((await f.lifecycle.get(f.route.userId))?.phase).toBe('upgrading');
  });
  it('releases a validated canonical-account reservation after the Core fence and before clearing PII', async () => {
    const f = await fixture(),
      reserved = await publication(f);
    await f.seedProof('reserved', reserved);
    const events: string[] = [];
    mocks.release.mockImplementation(async (value) => {
      events.push('release');
      expect(value).toEqual(reserved);
      expect((await f.lifecycle.get(f.route.userId))?.upgrade_admission_floor).toBe(500);
      expect((await f.operations.get('reserved'))?.proof_payload_json).not.toBeNull();
    });
    const execute = f.pii.adapter.execute.bind(f.pii.adapter);
    vi.spyOn(f.pii.adapter, 'execute').mockImplementation(async (sql, params) => {
      if (sql.includes('proof_payload_json = NULL')) events.push('clear');
      return execute(sql, params);
    });
    await cleanupExpiredGuestProofs(
      {} as Env,
      f.route.tenantId,
      f.core.adapter,
      f.route.corePin.bindingRef,
      f.route.userId,
      1000
    );
    expect(events).toEqual(['release', 'clear']);
    expect((await f.operations.get('reserved'))?.reservation_publication_json).toBeNull();
  });
  it('keeps raw proof after release failure and safely clears it on retry', async () => {
    const f = await fixture();
    await f.seedProof('reserved', await publication(f));
    mocks.release.mockRejectedValueOnce(new Error('lookup_unavailable'));
    await expect(
      cleanupExpiredGuestProofs(
        {} as Env,
        f.route.tenantId,
        f.core.adapter,
        f.route.corePin.bindingRef,
        f.route.userId,
        1000
      )
    ).rejects.toThrow('lookup_unavailable');
    expect((await f.operations.get('reserved'))?.proof_payload_json).not.toBeNull();
    await cleanupExpiredGuestProofs(
      {} as Env,
      f.route.tenantId,
      f.core.adapter,
      f.route.corePin.bindingRef,
      f.route.userId,
      1001
    );
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect((await f.operations.get('reserved'))?.proof_payload_json).toBeNull();
  });
  it('does not confuse the legacy user ID with the canonical reservation account', async () => {
    const f = await fixture(),
      reserved = await publication(f);
    await f.seedProof('reserved', { ...reserved, accountId: f.route.userId });
    await expect(
      cleanupExpiredGuestProofs(
        {} as Env,
        f.route.tenantId,
        f.core.adapter,
        f.route.corePin.bindingRef,
        f.route.userId,
        1000
      )
    ).rejects.toThrow('guest_proof_cleanup_publication_mismatch');
    expect(mocks.release).not.toHaveBeenCalled();
    expect((await f.operations.get('reserved'))?.proof_payload_json).not.toBeNull();
  });
});

describe('hourly scheduler cursor, attempt and observation contracts', () => {
  it('records a failed step attempt and replaces retrying with completed only on the worker result', async () => {
    const f = await fixture(),
      config = configFixture(),
      log = logger();
    const targets = [
      {
        tenantId: f.route.tenantId,
        adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
      },
    ];
    mocks.step.mockRejectedValueOnce(new Error('private failure: person@example.invalid'));
    await processGuestLifecycleMaintenance(config.env, targets, log);
    expect(readStatus(config.values, f.route.tenantId, f.route.userId)).toEqual({
      state: 'retrying',
      attempted_at: 90000,
    });
    expect(log.warn).toHaveBeenCalledWith('Guest lifecycle deletion failed', {
      tenantId: f.route.tenantId,
      userId: f.route.userId,
      bindingRef: f.source.bindingRef,
      errorCode: 'guest_maintenance_internal_error',
    });
    // Proof cleanup and the deletion attempt each advance the Core scheduling priority.
    // The observation above deliberately keeps wall-clock attempted_at=90000.
    expect((await f.lifecycle.get(f.route.userId))?.updated_at).toBe(90001);
    mocks.step.mockResolvedValueOnce('deleted');
    vi.setSystemTime(93_600_000);
    await processGuestLifecycleMaintenance(config.env, targets, log);
    expect(readStatus(config.values, f.route.tenantId, f.route.userId)).toEqual({
      state: 'completed',
      attempted_at: 93600,
    });
    expect(log.info).toHaveBeenLastCalledWith('Guest lifecycle maintenance completed', {
      upgraded: 0,
      deleted: 1,
      failed: 0,
    });
  });
  it.each(['pending', 'held', 'skipped'] as const)(
    'does not report %s as a completed deletion',
    async (result) => {
      const f = await fixture(),
        config = configFixture(),
        log = logger();
      mocks.step.mockResolvedValueOnce(result);
      await processGuestLifecycleMaintenance(
        config.env,
        [
          {
            tenantId: f.route.tenantId,
            adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
          },
        ],
        log
      );
      expect(readStatus(config.values, f.route.tenantId, f.route.userId).state).toBe('pending');
      expect(log.info).toHaveBeenCalledWith('Guest lifecycle maintenance completed', {
        upgraded: 0,
        deleted: 0,
        failed: 0,
      });
    }
  );
  it.each(['processing', 'completed', 'all'])(
    'keeps step results authoritative when optional %s status writes fail',
    async (failedState) => {
      const f = await fixture(),
        config = configFixture(failedState),
        log = logger();
      mocks.step.mockResolvedValueOnce('deleted');
      await processGuestLifecycleMaintenance(
        config.env,
        [
          {
            tenantId: f.route.tenantId,
            adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
          },
        ],
        log
      );
      expect(mocks.step).toHaveBeenCalledTimes(1);
      expect(
        config.put.mock.calls.filter(([key]) => key.startsWith('guest-maintenance-status:'))
      ).toHaveLength(2);
      expect(log.info).toHaveBeenCalledWith('Guest lifecycle maintenance completed', {
        upgraded: 0,
        deleted: 1,
        failed: 0,
      });
      expect(log.warn).not.toHaveBeenCalled();
    }
  );
  it('persists the next shard cursor before a failed shard and still visits a healthy actual-SQL shard', async () => {
    const f = await fixture(),
      config = configFixture(),
      log = logger();
    const brokenQuery = vi.fn(async () => {
      throw new Error('offline');
    });
    const broken = { query: brokenQuery } as unknown as DatabaseAdapter;
    const healthy = openGuestStore('core');
    stores.push(healthy);
    const query = vi.spyOn(healthy.adapter, 'query');
    const targets = [
      {
        tenantId: f.route.tenantId,
        adapters: [
          { bindingRef: 'bad', adapter: broken },
          { bindingRef: 'good', adapter: healthy.adapter },
        ],
      },
    ];
    await processGuestLifecycleMaintenance(config.env, targets, log);
    expect(query).toHaveBeenCalledTimes(3);
    expect(config.put.mock.calls.map(([, value]) => value)).toEqual(['1', '0']);
    expect(config.put.mock.invocationCallOrder[0]).toBeLessThan(
      brokenQuery.mock.invocationCallOrder[0]
    );
    expect(config.put.mock.invocationCallOrder[1]).toBeLessThan(query.mock.invocationCallOrder[0]);
    expect(log.warn).toHaveBeenCalledWith('Guest lifecycle operations remain pending for retry', {
      failed: 1,
    });
  });
  it('resumes at the saved shard after the deadline expires on a failed shard', async () => {
    const f = await fixture(),
      config = configFixture(),
      log = logger();
    const healthy = openGuestStore('core');
    stores.push(healthy);
    const query = vi.spyOn(healthy.adapter, 'query');
    const broken = {
      query: vi.fn(async () => {
        vi.setSystemTime(Date.now() + 21000);
        throw new Error('offline');
      }),
    } as unknown as DatabaseAdapter;
    const targets = [
      {
        tenantId: f.route.tenantId,
        adapters: [
          { bindingRef: 'bad', adapter: broken },
          { bindingRef: 'good', adapter: healthy.adapter },
        ],
      },
    ];
    await processGuestLifecycleMaintenance(config.env, targets, log);
    expect(query).not.toHaveBeenCalled();
    expect(config.put.mock.calls.map(([, value]) => value)).toEqual(['1']);
    await processGuestLifecycleMaintenance(config.env, targets, log);
    expect(query).toHaveBeenCalledTimes(3);
    expect(config.put.mock.calls.map(([, value]) => value)).toEqual(['1', '0', '1']);
  });
  it('records upgrade attempts and counts only a completed recovery', async () => {
    const f = await fixture(),
      config = configFixture(),
      log = logger();
    expect(await f.lifecycle.beginUpgrade(f.route.userId, 'accepted', 80000, 100000)).toBe(true);
    mocks.recover.mockResolvedValueOnce('pending');
    await processGuestLifecycleMaintenance(
      config.env,
      [
        {
          tenantId: f.route.tenantId,
          adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
        },
      ],
      log
    );
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(
      config.env,
      f.route.tenantId,
      f.route.userId,
      'accepted'
    );
    expect((await f.lifecycle.get(f.route.userId))?.updated_at).toBe(90000);
    expect(log.info).toHaveBeenLastCalledWith('Guest lifecycle maintenance completed', {
      upgraded: 0,
      deleted: 0,
      failed: 0,
    });
    mocks.recover.mockResolvedValueOnce('completed');
    await processGuestLifecycleMaintenance(
      config.env,
      [
        {
          tenantId: f.route.tenantId,
          adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
        },
      ],
      log
    );
    expect(log.info).toHaveBeenLastCalledWith('Guest lifecycle maintenance completed', {
      upgraded: 1,
      deleted: 0,
      failed: 0,
    });
    expect(mocks.step).not.toHaveBeenCalled();
  });
  it('contains upgrade/proof-cleanup failure to its candidate and continues deletion work', async () => {
    const f = await fixture(),
      config = configFixture(),
      log = logger();
    await f.seedProof('reserved', await publication(f));
    mocks.release.mockRejectedValueOnce(new Error('private provider failure'));
    mocks.step.mockResolvedValueOnce('pending');
    await processGuestLifecycleMaintenance(
      config.env,
      [
        {
          tenantId: f.route.tenantId,
          adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
        },
      ],
      log
    );
    expect(log.warn).toHaveBeenCalledWith('Guest lifecycle proof cleanup failed', {
      tenantId: f.route.tenantId,
      userId: f.route.userId,
      bindingRef: f.source.bindingRef,
      errorCode: 'guest_maintenance_internal_error',
    });
    expect(mocks.step).toHaveBeenCalledTimes(1);
    expect(readStatus(config.values, f.route.tenantId, f.route.userId).state).toBe('pending');
    expect((await f.operations.get('reserved'))?.proof_payload_json).not.toBeNull();
  });
  it.each(['fixed', 'backward'] as const)(
    'continues revisiting all 21 held guests when the clock is %s',
    async (clock) => {
      const f = await fixture(),
        config = configFixture(),
        log = logger();
      mocks.step.mockResolvedValue('held');
      const userIds = [f.route.userId];
      for (let n = 2; n <= 21; n++) {
        const suffix = String(n).padStart(12, '0'),
          userId = `10000000-0000-4000-8000-${suffix}`,
          accountId = `20000000-0000-4000-8000-${suffix}`;
        f.core.db
          .prepare(
            "INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at) VALUES(?,?,'user','active',?,'guest','active',1,1,1)"
          )
          .run(accountId, f.route.tenantId, userId);
        await f.lifecycle.enroll({
          userId,
          clientId: 'app',
          createdAt: 1,
          deletionAfterDays: 1,
          policyVersion: 'policy',
        });
        userIds.push(userId);
      }
      const targets = [
        {
          tenantId: f.route.tenantId,
          adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
        },
      ];
      await processGuestLifecycleMaintenance(config.env, targets, log);
      expect(mocks.step).toHaveBeenCalledTimes(20);
      if (clock === 'backward') vi.setSystemTime(89_000_000);
      await processGuestLifecycleMaintenance(config.env, targets, log);
      if (clock === 'backward') vi.setSystemTime(88_000_000);
      await processGuestLifecycleMaintenance(config.env, targets, log);
      const counts = new Map<string, number>();
      for (const [, input] of mocks.step.mock.calls)
        counts.set(input.candidate.user_id, (counts.get(input.candidate.user_id) ?? 0) + 1);
      for (const userId of userIds)
        expect(counts.get(userId) ?? 0, userId).toBeGreaterThanOrEqual(2);
      for (const userId of userIds)
        expect(await f.lifecycle.get(userId)).toMatchObject({
          phase: 'active',
          deletion_due_at: 86401,
          deletion_started_at_ms: null,
          deleted_at: null,
        });
      expect(log.warn).not.toHaveBeenCalled();
    }
  );
  it('requires persistent scheduler cursor storage before doing work', async () => {
    const f = await fixture();
    await expect(
      processGuestLifecycleMaintenance(
        {} as Env,
        [
          {
            tenantId: f.route.tenantId,
            adapters: [{ bindingRef: f.source.bindingRef, adapter: f.core.adapter }],
          },
        ],
        logger()
      )
    ).rejects.toThrow('guest_maintenance_config_unavailable');
    expect(mocks.step).not.toHaveBeenCalled();
  });
});

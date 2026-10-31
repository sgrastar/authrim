import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuestLifecycleRepository } from '../guest-lifecycle';
import type { PreparedStatement } from '../../db/adapter';
import {
  createAccountLegalHold,
  releaseAccountLegalHold,
} from '../../db/account-governance-mutations';
import {
  guestErasureBoundaryId,
  parseGuestDeletionReceiptV2,
} from '../../services/guest-deletion-receipt';
import { guestDeletionReceiptFixture } from '../../services/__tests__/guest-deletion-receipt-fixture';
import { sqliteAdapter } from './sqlite-core-schema';

const stores: ReturnType<typeof sqliteAdapter>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.db.close()));
async function fixture() {
  const store = sqliteAdapter();
  stores.push(store);
  const route = guestDeletionReceiptFixture();
  store.db
    .prepare(
      'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,1,1)'
    )
    .run(route.tenantId, route.tenantId, 'key-guest', 'Fixture');
  store.db
    .prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at) VALUES(?,?,'user','active',?,'guest','active',1,1,1)`
    )
    .run(route.accountId, route.tenantId, route.userId);
  store.db
    .prepare(
      `INSERT INTO guest_account_lifecycle(tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at) VALUES(?,?,?,1,100,'policy:1',1)`
    )
    .run(route.tenantId, route.userId, 'app');
  const adapter = { ...store.adapter, getType: () => 'd1' };
  const repository = new GuestLifecycleRepository(adapter, route.tenantId);
  const admission = {
    userId: route.userId,
    accountId: route.accountId,
    operationId: route.operationId,
    routeJson: JSON.stringify(route),
    expectedRevision: 1,
    accountRouteGeneration: 1,
    now: 2000,
    startedAtMs: 2000000,
    origin: 'admin' as const,
    task: {
      auditId: route.completionAuditId,
      actorUserId: 'original-admin',
      ipAddress: 'fixture',
      userAgent: 'fixture',
      metadataJson: JSON.stringify({ guestDeletionVersion: 2, operationId: route.operationId }),
      createdAt: 2000,
    },
  };
  const started = {
    ...route,
    execution: {
      phase: 'erasure_started' as const,
      boundaryId: await guestErasureBoundaryId(route.operationId),
      erasureStartedAtMs: 2000001,
    },
  };
  const start = async () =>
    repository.confirmErasureStart({
      userId: route.userId,
      accountId: route.accountId,
      operationId: route.operationId,
      expectedRevision: (await repository.get(route.userId))?.revision ?? 0,
      acceptedRouteJson: JSON.stringify(route),
      erasureStartedRouteJson: JSON.stringify(started),
      accountRouteGeneration: 1,
      now: 2001,
    });
  const hold = () =>
    createAccountLegalHold(adapter, {
      tenantId: route.tenantId,
      accountId: route.accountId,
      holdId: 'hold',
      eventId: 'hold-event',
      operationId: 'hold-projection',
      actor: 'hold-admin',
      reasonCode: 'support_case',
      caseReference: null,
      expiresAt: 10,
      now: 1,
    });
  return { ...store, adapter, repository, route, admission, start, hold, started };
}

describe('Guest accepted intent and same-Core irreversible boundary', () => {
  it('atomically retains one original task and accepts lost admission ACK only with primary proof', async () => {
    const f = await fixture();
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = vi.fn(async (statements: PreparedStatement[]) => {
      await batch(statements);
      throw new Error('lost_commit_ack');
    });
    const row = await f.repository.admitDeletion(f.admission);
    expect(row?.phase).toBe('deleting');
    expect(f.db.prepare('SELECT lifecycle_state FROM identity_accounts').get()).toEqual({
      lifecycle_state: 'active',
    });
    expect(
      f.db.prepare('SELECT operation_id,actor_user_id FROM guest_deletion_audit_outbox').all()
    ).toEqual([{ operation_id: f.route.operationId, actor_user_id: 'original-admin' }]);
    f.adapter.batch = batch;
    expect((await f.repository.admitDeletion(f.admission))?.deletion_operation_id).toBe(
      f.route.operationId
    );
    await expect(
      f.repository.admitDeletion({
        ...f.admission,
        task: { ...f.admission.task, actorUserId: 'another-admin' },
      })
    ).rejects.toThrow('guest_deletion_admission_unknown');
  });
  it('rolls back the intent if the durable task cannot be stored', async () => {
    const f = await fixture();
    f.db.exec(
      "CREATE TRIGGER fail_guest_task BEFORE INSERT ON guest_deletion_audit_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END"
    );
    await expect(f.repository.admitDeletion(f.admission)).rejects.toThrow(
      'guest_deletion_admission_unknown'
    );
    expect((await f.repository.get(f.route.userId))?.phase).toBe('active');
    expect(f.db.prepare('SELECT * FROM guest_deletion_audit_outbox').all()).toEqual([]);
  });
  it('honors an active hold whose expiry is past without admitting deletion', async () => {
    const f = await fixture();
    await f.hold();
    expect(await f.repository.admitDeletion(f.admission)).toBeNull();
    expect((await f.repository.get(f.route.userId))?.phase).toBe('active');
  });
  it('accepts a hold after admission and resumes the same operation only after its audited release', async () => {
    const f = await fixture();
    await f.repository.admitDeletion(f.admission);
    await f.hold();
    expect(
      parseGuestDeletionReceiptV2((await f.start()).deletion_route_json, f.route).execution.phase
    ).toBe('accepted');
    expect(f.db.prepare('SELECT lifecycle_state FROM identity_accounts').get()).toEqual({
      lifecycle_state: 'active',
    });
    await releaseAccountLegalHold(f.adapter, {
      tenantId: f.route.tenantId,
      accountId: f.route.accountId,
      holdId: 'hold',
      eventId: 'release-event',
      operationId: 'release-projection',
      actor: 'hold-admin',
      reasonCode: 'case_closed',
      expectedVersion: 1,
      now: 2002,
    });
    const row = await f.start();
    expect(parseGuestDeletionReceiptV2(row.deletion_route_json, f.route).execution).toEqual(
      f.started.execution
    );
    expect(row.deletion_operation_id).toBe(f.admission.operationId);
    expect(f.db.prepare('SELECT actor_user_id FROM guest_deletion_audit_outbox').get()).toEqual({
      actor_user_id: 'original-admin',
    });
  });
  it('fences a new hold after the positive erasure boundary', async () => {
    const f = await fixture();
    await f.repository.admitDeletion(f.admission);
    await f.start();
    await f.hold();
    expect(f.db.prepare('SELECT * FROM legal_holds').all()).toEqual([]);
    expect(
      f.db
        .prepare('SELECT lifecycle_state,directory_publication_state FROM identity_accounts')
        .get()
    ).toEqual({ lifecycle_state: 'deleting', directory_publication_state: 'disabled' });
  });
  it('does not infer permission from successful row counts, and recovers a lost committed boundary ACK', async () => {
    const f = await fixture();
    await f.repository.admitDeletion(f.admission);
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = vi.fn(async (statements: PreparedStatement[]) =>
      statements.map(() => ({ success: true, rowsAffected: 1 }))
    );
    expect(
      parseGuestDeletionReceiptV2((await f.start()).deletion_route_json, f.route).execution.phase
    ).toBe('accepted');
    f.adapter.batch = vi.fn(async (statements: PreparedStatement[]) => {
      await batch(statements);
      throw new Error('lost_boundary_ack');
    });
    expect(
      parseGuestDeletionReceiptV2((await f.start()).deletion_route_json, f.route).execution.phase
    ).toBe('erasure_started');
  });
  it('never authorizes on a failed primary read, even when the batch committed', async () => {
    const f = await fixture();
    await f.repository.admitDeletion(f.admission);
    const queryOne = f.adapter.queryOne.bind(f.adapter);
    // The first lookup in start selects revision, then the primary result read must fail.
    let reads = 0;
    f.adapter.queryOne = vi.fn(async (...args: Parameters<typeof f.adapter.queryOne>) => {
      if (args[0].includes('FROM guest_account_lifecycle') && ++reads > 1)
        throw new Error('primary_unavailable');
      return queryOne(...args);
    });
    await expect(f.start()).rejects.toThrow('primary_unavailable');
    f.adapter.queryOne = queryOne;
    expect(
      parseGuestDeletionReceiptV2(
        (await f.repository.get(f.route.userId))?.deletion_route_json ?? null,
        f.route
      ).execution.phase
    ).toBe('erasure_started');
  });
  it.each(['postgres', 'mysql'])('rejects unsupported %s mutation before I/O', async (backend) => {
    const f = await fixture();
    const adapter = {
      ...f.adapter,
      getType: () => backend,
      batch: vi.fn(f.adapter.batch.bind(f.adapter)),
    };
    await expect(
      new GuestLifecycleRepository(adapter, f.route.tenantId).admitDeletion(f.admission)
    ).rejects.toThrow('guest_deletion_backend_unsupported');
    expect(adapter.batch).not.toHaveBeenCalled();
  });
});

describe('closed Guest receipt decoder', () => {
  it('accepts a canonical internal account ID distinct from the authentication DO sentinel', () => {
    const route = guestDeletionReceiptFixture();
    expect(parseGuestDeletionReceiptV2(JSON.stringify(route), route).accountId).toBe(
      route.accountId
    );
    expect(route.accountId).not.toBe(`account:${route.userId}`);
  });
  it.each([
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({ ...route, extra: true }),
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({
      ...route,
      execution: { ...route.execution, extra: true },
    }),
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({
      ...route,
      corePin: { ...route.corePin, assignmentGeneration: 0 },
    }),
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({
      ...route,
      corePin: { ...route.corePin, extra: true },
    }),
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({
      ...route,
      routeProjection: { ...route.routeProjection, accountRouteGeneration: 2 },
    }),
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({ ...route, userId: 'other-user' }),
    (route: ReturnType<typeof guestDeletionReceiptFixture>) => ({
      ...route,
      execution: { phase: 'erasure_started', boundaryId: null, erasureStartedAtMs: 1 },
    }),
  ])('rejects malformed, foreign or extra fields', (mutate) => {
    const route = guestDeletionReceiptFixture();
    expect(() => parseGuestDeletionReceiptV2(JSON.stringify(mutate(route)), route)).toThrow(
      'guest_deletion_route_unverified'
    );
  });
});

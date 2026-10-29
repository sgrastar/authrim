import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAccountLegalHold } from '../../../ar-lib-core/dist/db/account-governance-mutations';
import {
  cacheAnonymizedUserId,
  getCachedAnonymizedUserId,
  clearAnonymizedUserIdCache,
} from '../../../ar-lib-core/dist/services/audit/anonymized-user-id-cache';
import { GUEST_PII_ERASURE_TABLES } from '@authrim/ar-lib-core/services/guest-pii-erasure';
import {
  GuestLifecycleRepository,
  GuestUpgradeRepository,
  parseGuestDeletionProgress,
  createLookupBlindIndexes,
  type Env,
  type GuestDeletionReceiptV2,
  type PreparedStatement,
} from '@authrim/ar-lib-core';
import { openGuestStore, guestReceiptFixture } from './helpers/guest-erasure-fixture';
import { d1OverSqlite } from './helpers/d1-over-sqlite';
const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  source: vi.fn(),
  keys: vi.fn(),
  assignments: vi.fn(),
  state: vi.fn(),
  transition: vi.fn(),
  audit: vi.fn(),
  contextAudit: vi.fn(),
  cache: vi.fn(),
  writeResolver: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.sources,
  resolveTenantDatabaseSourceFromRegistry: mocks.source,
  loadVerifiedLookupBucketAssignmentProvider: mocks.assignments,
  getSessionRevocationStore: () => ({ getAccountStateRpc: mocks.state }),
  transitionAccountAuthenticationState: mocks.transition,
  createAuditLog: mocks.audit,
  createAuditLogFromContext: mocks.contextAudit,
  invalidateUserCache: mocks.cache,
}));
vi.mock('../lookup-hmac-runtime', () => ({ loadLookupHmacRuntimeKeys: mocks.keys }));
vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: mocks.writeResolver,
}));
import { runGuestDeletionStep } from '../guest-deletion-worker';
import { deleteGuestUser, cleanupExpiredGuestUsers } from '../routes/guest-users';
import { parseGuestDeletionRoute } from '../guest-deletion-route';
import { requireCurrentGuestAccountProjection } from '../guest-account-lookup';
import { InitialAccountIdentifierReservationService } from '../account-directory-reservation';
import { releaseGuestReservationPage } from '../account-directory-removal-producer';

const stores: ReturnType<typeof openGuestStore>[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.db.close());
  clearAnonymizedUserIdCache();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  clearAnonymizedUserIdCache();
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000_000);
  mocks.audit.mockResolvedValue(undefined);
  mocks.contextAudit.mockResolvedValue(undefined);
  mocks.cache.mockResolvedValue(undefined);
});
async function fixture(size = 1) {
  const core = openGuestStore('core'),
    pii = openGuestStore('pii'),
    lookup = openGuestStore('lookup');
  stores.push(core, pii, lookup);
  const rawRoute = guestReceiptFixture(),
    route = GuestLifecycleRepository.parseDeletionRouteV2(JSON.stringify(rawRoute), {
      tenantId: rawRoute.tenantId,
      userId: rawRoute.userId,
    }),
    t = route.tenantId,
    u = route.userId;
  core.db
    .prepare(
      `INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,'Fixture',1,1)`
    )
    .run(t, t, 'key-guest');
  core.db
    .prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at) VALUES(?,?,'user','active',?,'guest','active',1,1,1)`
    )
    .run(route.accountId, t, u);
  const repo = new GuestLifecycleRepository(core.adapter, t);
  await repo.enroll({
    userId: u,
    clientId: 'app',
    createdAt: 1,
    deletionAfterDays: 1,
    policyVersion: 'policy',
  });
  for (let n = 0; n < size; n++) {
    const id = n.toString().padStart(3, '0');
    core.db
      .prepare(
        `INSERT INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at,expires_at) VALUES(?,?,?,?,1,1,100)`
      )
      .run(`device-${id}`, t, u, n.toString(16).padStart(64, '0'));
    core.db
      .prepare(
        `INSERT INTO passkeys(id,tenant_id,user_id,credential_id,public_key,created_at,rp_id) VALUES(?,?,?,?,?,1,'passkey.example.invalid')`
      )
      .run(`passkey-${id}`, t, u, `credential-${id}`, 'public-key');
    pii.db
      .prepare(
        `INSERT INTO linked_identities(id,tenant_id,user_id,provider_id,provider_user_id,linked_at) VALUES(?,?,?,?,?,1)`
      )
      .run(`linked-${id}`, t, u, 'issuer', `subject-${id}`);
  }
  core.db
    .prepare(
      `INSERT INTO totp_credentials(id,tenant_id,user_id,secret_encrypted,created_at) VALUES('totp',?,?,?,1)`
    )
    .run(t, u, 'encrypted-secret');
  core.db
    .prepare(
      `INSERT INTO totp_backup_codes(id,tenant_id,user_id,credential_id,code_hash,code_prefix,created_at) VALUES('backup',?,?,'totp','code-hash','prefix',1)`
    )
    .run(t, u);
  pii.db
    .prepare(`INSERT INTO users_pii(id,tenant_id,email,created_at,updated_at) VALUES(?,?,?,1,1)`)
    .run(u, t, 'guest@example.invalid');
  pii.db
    .prepare(
      `INSERT INTO identity_sensitive_values(id,tenant_id,owner_type,owner_id,value_key,value_json,created_at,updated_at) VALUES('email',?,'runtime_user',?,'email',?,1,1)`
    )
    .run(t, u, JSON.stringify('guest@example.invalid'));
  const keys = [{ generation: 1, secret: '0123456789abcdef0123456789abcdef' }];
  mocks.keys.mockResolvedValue({ readKeys: keys, writeKeys: keys });
  const indexes = await createLookupBlindIndexes('account_id', route.accountId, keys);
  const publication = {
    operationId: 'original-create',
    idempotencyKey: 'original-create',
    tenantId: t,
    accountId: route.accountId,
    routeProjection: route.routeProjection,
    indexes,
  };
  core.db
    .prepare(
      `INSERT INTO account_routing_outbox(outbox_id,tenant_id,account_id,event_kind,route_schema_version,route_generation,hmac_key_generation,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES('original-create',?,?,'account_created',1,1,1,?,'succeeded',0,1,1,1)`
    )
    .run(t, route.accountId, JSON.stringify(publication));
  for (const i of indexes)
    lookup.db
      .prepare(
        `INSERT INTO lookup_identifiers(virtual_bucket,index_kind,normalization_version,hmac_key_generation,identifier_blind_digest,tenant_id,account_id,route_schema_version,account_route_generation,required_binding_route_generation,residency_policy_id,route_projection_json,tenant_lifecycle_state,runtime_route_status,lifecycle_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1,1,?,?,'active','active','active',1,1)`
      )
      .run(
        i.virtualBucket,
        i.indexKind,
        i.normalizationVersion,
        i.hmacKeyGeneration,
        i.digest,
        t,
        route.accountId,
        route.routeProjection.residencyPolicyId,
        JSON.stringify(route.routeProjection)
      );
  const lookupBinding = d1OverSqlite(lookup.db);
  const withSession = vi.fn(() => ({ ...lookupBinding, getBookmark: () => null }));
  Object.assign(lookupBinding, { withSession });
  mocks.assignments.mockResolvedValue({
    resolveActiveAssignment: async (bucket: number) => ({
      state: 'active',
      virtualBucket: bucket,
      bindingRef: 'LOOKUP',
    }),
  });
  mocks.writeResolver.mockResolvedValue(async () => lookupBinding);
  const physical = (pin: GuestDeletionReceiptV2['corePin'], adapter: typeof core.adapter) => ({
    tenantId: t,
    source: adapter,
    ...pin,
    registryRow: { database_id: pin.databaseId },
    residencyPolicyId: route.routeProjection.residencyPolicyId,
  });
  const coreSource = physical(route.corePin, core.adapter),
    piiSource = physical(route.piiPin, pii.adapter);
  mocks.sources.mockResolvedValue([coreSource]);
  mocks.source.mockImplementation(async (_env: unknown, input: { dataRole: string }) =>
    input.dataRole === 'tenant_pii' ? piiSource : coreSource
  );
  let authentication = {
    lifecycle: 'active',
    lifecycleVersionMs: 1,
    lifecycleOperationId: null as string | null,
    revokedAfterMs: null,
    lastLoginAtMs: null,
  };
  mocks.state.mockImplementation(async () => ({ ...authentication }));
  mocks.transition.mockImplementation(
    async (
      _env: unknown,
      input: { lifecycle: string; sourceVersionMs: number; operationId: string }
    ) => {
      authentication = {
        ...authentication,
        lifecycle: input.lifecycle,
        lifecycleVersionMs: input.sourceVersionMs,
        lifecycleOperationId: input.operationId,
      };
      return { ...authentication };
    }
  );
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'fixture',
    TENANT_RUNTIME_REGISTRY: {},
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: {},
    LOOKUP: lookupBinding,
  } as unknown as Env;
  const app = new Hono<{
    Bindings: Env;
    Variables: { tenantId: string; adminAuth: { userId: string }; tenantMetadataContext: unknown };
  }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', t);
    c.set('adminAuth', { userId: 'request-admin' });
    c.set('tenantMetadataContext', { route: { allocationScope: 'shared_pool' } });
    await next();
  });
  app.delete('/guests/:id', deleteGuestUser);
  app.post('/cleanup', cleanupExpiredGuestUsers);
  const request = (path: string, method = 'DELETE', body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env
    );
  const row = () => repo.get(u);
  const readRoute = async () => {
    const r = await row();
    return parseGuestDeletionRoute(r?.deletion_route_json ?? null, { tenantId: t, userId: u });
  };
  const step = async () => {
    const candidate = await row();
    if (!candidate) throw new Error('missing');
    return runGuestDeletionStep(env, {
      tenantId: t,
      core: core.adapter,
      coreBindingRef: route.corePin.bindingRef,
      candidate,
      now: Math.floor(Date.now() / 1000),
    });
  };
  const admit = async () =>
    repo.admitDeletion({
      userId: u,
      accountId: route.accountId,
      operationId: route.operationId,
      routeJson: JSON.stringify(route),
      accountRouteGeneration: 1,
      expectedRevision: (await row())?.revision ?? 0,
      now: 2_000_000,
      startedAtMs: 2_000_000_000,
      origin: 'admin',
      task: {
        auditId: route.completionAuditId,
        actorUserId: 'original-admin',
        ipAddress: 'original-ip',
        userAgent: 'original-agent',
        metadataJson: JSON.stringify({ guestDeletionVersion: 2, operationId: route.operationId }),
        createdAt: 2_000_000,
      },
    });
  const hold = () =>
    createAccountLegalHold(core.adapter, {
      tenantId: t,
      accountId: route.accountId,
      holdId: 'hold-a',
      eventId: 'hold-event',
      operationId: 'hold-op',
      actor: 'hold-admin',
      reasonCode: 'support_case',
      caseReference: null,
      expiresAt: null,
      now: 2_000_000,
    });
  const finish = async () => {
    for (let n = 0; n < 120; n++) if ((await step()) === 'deleted') return;
    throw new Error('did_not_finish');
  };
  return {
    core,
    pii,
    lookup,
    route,
    repo,
    env,
    request,
    row,
    step,
    admit,
    hold,
    finish,
    readRoute,
    withSession,
    lookupBinding,
    piiSource,
    getAuthentication: () => authentication,
  };
}

async function pinConflictedUpgrade(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'foreign' | 'owned' | 'absent' = 'foreign'
) {
  const operationId = 'upgrade-conflict',
    now = Math.floor(Date.now() / 1000),
    requestTokenHash = 'c'.repeat(64);
  const operations = new GuestUpgradeRepository(f.pii.adapter, f.route.tenantId);
  await operations.create({
    operationId,
    userId: f.route.userId,
    clientId: 'app',
    sessionId: 'session',
    requestTokenHash,
    method: 'email',
    payloadJson: JSON.stringify({ email: 'taken@example.invalid' }),
    verifier: 'verifier',
    now,
    expiresAt: now + 300,
  });
  expect(
    await operations.verifyEmail({
      operationId,
      userId: f.route.userId,
      sessionId: 'session',
      requestTokenHash,
      verifier: 'verifier',
      now,
    })
  ).toBe(true);
  const keys = [{ generation: 1, secret: '0123456789abcdef0123456789abcdef' }];
  const indexes = [
    ...(await createLookupBlindIndexes('account_id', f.route.accountId, keys)),
    ...(await createLookupBlindIndexes('email_exact', 'taken@example.invalid', keys)),
  ];
  const publication = {
    operationId: `account-email-addition:${operationId}`,
    idempotencyKey: requestTokenHash,
    tenantId: f.route.tenantId,
    accountId: f.route.accountId,
    routeProjection: f.route.routeProjection,
    indexes,
  };
  expect(await operations.pinReservation(operationId, JSON.stringify(publication))).toBe(
    JSON.stringify(publication)
  );
  const otherAccount = '20000000-0000-4000-8000-000000000099';
  f.core.db
    .prepare(
      `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at) VALUES(?,?,'user','active','10000000-0000-4000-8000-000000000099','registered','active',1,1,1)`
    )
    .run(otherAccount, f.route.tenantId);
  const otherPublication = {
    ...publication,
    accountId: otherAccount,
    operationId: 'legitimate-other-operation',
    idempotencyKey: 'other-idempotency-key',
    indexes: [
      ...(await createLookupBlindIndexes('account_id', otherAccount, keys)),
      ...indexes.filter((index) => index.indexKind !== 'account_id'),
    ],
  };
  const reservations = new InitialAccountIdentifierReservationService({
    lookupForBucket: async () => f.lookupBinding,
    now: () => now,
  });
  if (mode === 'foreign') {
    await reservations.reserve(otherPublication);
    await expect(reservations.reserve(publication)).rejects.toThrow(
      'directory_identifier_reservation_conflict'
    );
  } else if (mode === 'owned') await reservations.reserve(publication);
  const before = f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all();
  if (mode === 'foreign')
    expect(before).toMatchObject([
      {
        account_id: otherAccount,
        operation_id: otherPublication.operationId,
        reservation_state: 'reserved',
      },
    ]);

  return { operations, operationId, publication, otherPublication, before, reservations };
}
async function reachReservationPage(f: Awaited<ReturnType<typeof fixture>>) {
  await f.admit();
  for (let n = 0; n < 20; n++) {
    const task = f.core.db
      .prepare('SELECT execution_progress_json FROM guest_deletion_audit_outbox')
      .get() as { execution_progress_json: string | null };
    if (task.execution_progress_json) {
      const progress = parseGuestDeletionProgress(task.execution_progress_json);
      if (progress.stage === 'release_reservations')
        return { route: await f.readRoute(), progress };
    }
    await f.step();
  }
  throw new Error('reservation_stage_missing');
}

describe('Guest bounded erasure with current Core, PII and Lookup SQL', () => {
  it('captures all pages before raw drain, revokes the logical account, compacts PII, then ACK deletes the original task', async () => {
    const f = await fixture(33);
    await f.admit();
    await f.step();
    const started = await f.readRoute();
    expect(started.accountId).not.toBe(`account:${started.userId}`);
    let maxCoreDelete = 0;
    const batch = f.core.adapter.batch.bind(f.core.adapter);
    f.core.adapter.batch = vi.fn(async (statements: PreparedStatement[]) => {
      for (const s of statements)
        if (
          s.sql.startsWith('DELETE FROM passkeys') ||
          s.sql.startsWith('DELETE FROM guest_devices')
        )
          maxCoreDelete = Math.max(
            maxCoreDelete,
            s.sql.match(/id IN \(([^)]+)\)/u)?.[1].split(',').length ?? 0
          );
      return batch(statements);
    });
    await f.finish();
    expect(maxCoreDelete).toBeLessThanOrEqual(16);
    expect(maxCoreDelete).toBeGreaterThan(0);
    expect(f.core.db.prepare('SELECT lifecycle_state FROM identity_accounts').get()).toEqual({
      lifecycle_state: 'deleted',
    });
    for (const table of ['guest_devices', 'passkeys', 'totp_credentials', 'totp_backup_codes'])
      expect(f.core.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(f.pii.db.prepare('SELECT COUNT(*) AS n FROM linked_identities').get()).toEqual({ n: 0 });
    const marker = f.pii.db.prepare('SELECT * FROM guest_pii_erasure_markers').get();
    expect(marker).toMatchObject({
      state: 'deleted',
      operation_id: null,
      boundary_id: null,
      source_started_at_ms: null,
      permit_table: null,
      permit_keys_json: null,
    });
    expect(
      f.core.db
        .prepare(
          "SELECT COUNT(*) AS n FROM account_routing_outbox WHERE event_kind='account_deleted' AND status='pending'"
        )
        .get()
    ).toEqual({ n: 100 });
    expect(mocks.state).toHaveBeenCalledWith(
      started.tenantId,
      started.userId,
      `account:${started.userId}`
    );
    expect(f.withSession).toHaveBeenCalledWith('first-primary');
    const response = await f.request(`/guests/${started.userId}`);
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      f.env,
      expect.objectContaining({
        userId: 'original-admin',
        ipAddress: 'original-ip',
        userAgent: 'original-agent',
        action: 'user.deleted',
      })
    );
    expect(f.core.db.prepare('SELECT * FROM guest_deletion_audit_outbox').all()).toEqual([]);
    expect((await f.request(`/guests/${started.userId}`)).status).toBe(200);
  });
  it('keeps accepted credentials intact when a new hold wins before B', async () => {
    const f = await fixture();
    await f.admit();
    await f.hold();
    expect(await f.step()).toBe('held');
    expect((await f.readRoute()).execution.phase).toBe('accepted');
    expect(f.pii.db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([]);
    expect(mocks.transition).not.toHaveBeenCalled();
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(409);
  });
  it('rejects stale actual Lookup ownership before admission and changed saved physical pins before raw effects', async () => {
    const f = await fixture();
    f.lookup.db.exec('DELETE FROM lookup_identifiers');
    await expect(
      requireCurrentGuestAccountProjection(f.env, f.route.tenantId, f.route.accountId, 1)
    ).rejects.toThrow('guest_account_owner_unverified');
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(503);
    expect((await f.row())?.phase).toBe('active');
    await f.admit();
    mocks.source.mockResolvedValue({ ...f.piiSource, registryRow: { database_id: 'foreign' } });
    await expect(f.step()).rejects.toThrow('guest_deletion_route_unverified');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it.each(['wrong-operation', 'wrong-version', 'missing'])(
    'rejects a successful-shaped but unproven DO result: %s',
    async (fault) => {
      const f = await fixture();
      await f.admit();
      await f.step();
      mocks.transition.mockResolvedValue(
        fault === 'missing'
          ? undefined
          : {
              lifecycle: 'deleting',
              lifecycleOperationId:
                fault === 'wrong-operation' ? 'other' : `${f.route.operationId}:begin`,
              lifecycleVersionMs: fault === 'wrong-version' ? 1 : Date.now(),
            }
      );
      await expect(f.step()).rejects.toThrow('guest_deletion_authentication_unverified');
      expect(f.pii.db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([]);
    }
  );
  it('does not renew an expired webhook window or read fresh email while resuming capture', async () => {
    const f = await fixture();
    await f.admit();
    await f.step();
    await f.step();
    vi.setSystemTime(Date.now() + 7 * 86400000);
    const query = f.pii.adapter.queryOne.bind(f.pii.adapter);
    let emailReads = 0;
    f.pii.adapter.queryOne = async <T>(
      sql: string,
      p?: unknown[],
      o?: Parameters<typeof query>[2]
    ) => {
      if (sql.includes('FROM identity_sensitive_values')) emailReads++;
      return query<T>(sql, p, o);
    };
    await f.step();
    expect(emailReads).toBe(1); // bounded blind-index capture only; no new webhook body copy
    expect(f.pii.db.prepare('SELECT * FROM account_webhook_snapshots').all()).toEqual([]);
    await f.finish();
  });
  it('rejects a conflicting webhook payload with the same ID and original timestamp', async () => {
    const f = await fixture();
    await f.admit();
    await f.step();
    await f.step();
    const r = await f.readRoute();
    f.pii.db
      .prepare(
        `INSERT INTO account_webhook_snapshots(id,tenant_id,user_id,account_id,event_type,registration_state,email_before_json,email_after_json,created_at,expires_at) VALUES(?,?,?,?,'account.deleted','guest',?,'null',?,?)`
      )
      .run(
        `account-deletion:${r.tenantId}:${r.userId}`,
        r.tenantId,
        r.userId,
        r.accountId,
        JSON.stringify('foreign@example.invalid'),
        Date.now(),
        Date.now() + 7 * 86400000
      );
    await expect(f.step()).rejects.toThrow('guest_deletion_snapshot_unverified');
    expect(f.pii.db.prepare('SELECT COUNT(*) AS n FROM linked_identities').get()).toEqual({ n: 1 });
  });
  it('reports pending while a terminal Core job still needs PII compact even without any credential rows', async () => {
    const f = await fixture();
    await f.admit();
    for (let n = 0; n < 100; n++) {
      await f.step();
      if ((await f.row())?.phase === 'deleted') break;
    }
    expect(f.core.db.prepare('SELECT * FROM guest_devices').all()).toEqual([]);
    const response = await f.request('/cleanup', 'POST', { dry_run: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: false,
      has_more: true,
      pending_users: 1,
      deleted_users: 0,
    });
    await f.finish();
    expect((await f.request('/cleanup', 'POST', { dry_run: false })).status).toBe(200);
  });
  it('does not accept deletion before the required start audit or durable original task succeeds', async () => {
    const f = await fixture();
    mocks.contextAudit.mockRejectedValueOnce(new Error('audit_offline'));
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(500);
    expect((await f.row())?.phase).toBe('active');
    expect(mocks.transition).not.toHaveBeenCalled();
    f.core.db.exec(
      `CREATE TRIGGER fail_guest_task BEFORE INSERT ON guest_deletion_audit_outbox BEGIN SELECT RAISE(ABORT,'task_unavailable');END;`
    );
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(503);
    expect((await f.row())?.phase).toBe('active');
    expect(f.core.db.prepare('SELECT * FROM guest_deletion_audit_outbox').all()).toEqual([]);
  });
  it('does no destructive work when registration wins the initial admission race', async () => {
    const f = await fixture();
    mocks.contextAudit.mockImplementationOnce(async () => {
      f.core.db.exec(`UPDATE guest_account_lifecycle SET phase='registered',revision=revision+1`);
    });
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(409);
    expect(f.pii.db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([]);
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('returns pending instead of completion until all stages finish and retains the first request actor', async () => {
    const f = await fixture();
    let response = await f.request(`/guests/${f.route.userId}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    const row = await f.row();
    expect(row?.phase).toBe('deleting');
    const operation = row?.deletion_operation_id;
    response = await f.request(`/guests/${f.route.userId}`);
    expect(response.status).toBe(503);
    expect((await f.row())?.deletion_operation_id).toBe(operation);
    expect(mocks.contextAudit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(
      f.core.db.prepare('SELECT actor_user_id FROM guest_deletion_audit_outbox').all()
    ).toEqual([{ actor_user_id: 'request-admin' }]);
  });
  it('retains an original completion task when audit delivery fails after erasure and retries it without re-erasing', async () => {
    const f = await fixture();
    await f.admit();
    await f.finish();
    mocks.audit.mockRejectedValueOnce(new Error('audit_offline'));
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(200);
    expect(
      f.core.db
        .prepare('SELECT status,actor_user_id,ip_address FROM guest_deletion_audit_outbox')
        .all()
    ).toEqual([{ status: 'retry', actor_user_id: 'original-admin', ip_address: 'original-ip' }]);
    const transitions = mocks.transition.mock.calls.length;
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledTimes(transitions);
    expect(f.core.db.prepare('SELECT * FROM guest_deletion_audit_outbox').all()).toEqual([]);
  });
  it('deactivates only expired credentials while another remains valid and accepts an atomic hold winner', async () => {
    const f = await fixture();
    f.core.db
      .prepare(
        `INSERT INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at,expires_at) VALUES('valid',?,?,?,1,1,?)`
      )
      .run(f.route.tenantId, f.route.userId, 'a'.repeat(64), Date.now() + 1000);
    let response = await f.request('/cleanup', 'POST', { dry_run: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: true,
      deactivated_credentials: 1,
      deleted_users: 0,
    });
    expect(f.core.db.prepare('SELECT id,is_active FROM guest_devices ORDER BY id').all()).toEqual([
      { id: 'device-000', is_active: 0 },
      { id: 'valid', is_active: 1 },
    ]);
    f.core.db.exec(`UPDATE guest_devices SET is_active=1 WHERE id='device-000'`);
    const execute = f.core.adapter.execute.bind(f.core.adapter);
    f.core.adapter.execute = async (sql, params) => {
      if (sql.startsWith('UPDATE guest_devices SET is_active=0')) await f.hold();
      return execute(sql, params);
    };
    response = await f.request('/cleanup', 'POST', { dry_run: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: false,
      has_more: true,
      held_users: 1,
      deactivated_credentials: 0,
    });
    expect(
      f.core.db.prepare("SELECT is_active FROM guest_devices WHERE id='device-000'").get()
    ).toEqual({ is_active: 1 });
  });
  it('resumes an accepted job before considering still-valid credentials', async () => {
    const f = await fixture();
    f.core.db
      .prepare(
        `INSERT INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at,expires_at) VALUES('valid',?,?,?,1,1,?)`
      )
      .run(f.route.tenantId, f.route.userId, 'a'.repeat(64), Date.now() + 1000);
    await f.admit();
    const response = await f.request('/cleanup', 'POST', { dry_run: false });
    expect(await response.json()).toMatchObject({
      complete: false,
      pending_users: 1,
      deactivated_credentials: 0,
    });
    expect((await f.readRoute()).execution.phase).toBe('erasure_started');
  });
  it.each(['registered', 'upgrading'] as const)(
    'does not erase a candidate that became %s',
    async (phase) => {
      const f = await fixture();
      f.core.db.prepare('UPDATE guest_account_lifecycle SET phase=?').run(phase);
      expect(await f.step()).toBe('skipped');
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.transition).not.toHaveBeenCalled();
    }
  );
  it('rejects an incomplete Core freeze installation before the first audit or acceptance', async () => {
    const f = await fixture();
    f.core.db.exec('DROP TRIGGER trg_guest_core_passkeys_insert');
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(503);
    expect((await f.row())?.phase).toBe('active');
    expect(mocks.contextAudit).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it.each(['not-due', 'disabled', 'upgrade-hold'] as const)(
    'does not admit a retention candidate with %s',
    async (state) => {
      const f = await fixture();
      f.core.db
        .prepare('UPDATE guest_account_lifecycle SET deletion_due_at=?,upgrade_hold_until=?')
        .run(
          state === 'disabled' ? null : state === 'not-due' ? Math.floor(Date.now() / 1000) + 1 : 1,
          state === 'upgrade-hold' ? Math.floor(Date.now() / 1000) + 1 : null
        );
      expect(await f.step()).toBe('skipped');
      expect((await f.row())?.phase).toBe('active');
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.transition).not.toHaveBeenCalled();
    }
  );
  it('rejects another operation already marked deleted instead of accepting it as this operation proof', async () => {
    const f = await fixture();
    await f.admit();
    await f.step();
    mocks.state.mockResolvedValue({
      ...f.getAuthentication(),
      lifecycle: 'deleted',
      lifecycleOperationId: 'different:complete',
      lifecycleVersionMs: Date.now() + 1,
    });
    await expect(f.step()).rejects.toThrow('guest_deletion_authentication_unverified');
    expect(f.pii.db.prepare('SELECT * FROM guest_pii_erasure_markers').all()).toEqual([]);
  });
  it('advances a manual cleanup cursor beyond sixteen held guests with retention disabled', async () => {
    const f = await fixture();
    for (let n = 0; n < 16; n++) {
      const suffix = (n + 100).toString().padStart(12, '0'),
        user = `10000000-0000-4000-8000-${suffix}`,
        account = `20000000-0000-4000-8000-${suffix}`;
      f.core.db
        .prepare(
          `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,registration_state,directory_publication_state,account_route_generation,created_at,updated_at) VALUES(?,?,'user','active',?,'guest','active',1,1,1)`
        )
        .run(account, f.route.tenantId, user);
      await f.repo.enroll({
        userId: user,
        clientId: 'app',
        createdAt: 1,
        deletionAfterDays: null,
        policyVersion: 'disabled',
      });
      f.core.db
        .prepare(
          `INSERT INTO guest_devices(id,tenant_id,user_id,resume_credential_hash,created_at,last_used_at,expires_at) VALUES(?,?,?,?,1,1,100)`
        )
        .run(
          `a-held-${n.toString().padStart(2, '0')}`,
          f.route.tenantId,
          user,
          (n + 100).toString(16).padStart(64, '0')
        );
      await createAccountLegalHold(f.core.adapter, {
        tenantId: f.route.tenantId,
        accountId: account,
        holdId: `hold-${n}`,
        eventId: `event-${n}`,
        operationId: `hold-op-${n}`,
        actor: 'hold-admin',
        reasonCode: 'support_case',
        caseReference: null,
        expiresAt: null,
        now: 2000000,
      });
    }
    const first = await f.request('/cleanup', 'POST', { dry_run: false });
    expect(first.status).toBe(200);
    const body: unknown = await first.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('next_cursor' in body) ||
      typeof body.next_cursor !== 'string'
    )
      throw new Error('missing_cleanup_cursor');
    expect(body).toMatchObject({ has_more: true, held_users: 16 });
    expect(body.next_cursor).toBeTypeOf('string');
    const decoded = atob(body.next_cursor.replaceAll('-', '+').replaceAll('_', '/'));
    expect(decoded).not.toContain('physical-core');
    expect(decoded).not.toContain('DB_USERS_A');
    const second = await f.request('/cleanup', 'POST', {
      dry_run: false,
      cursor: body.next_cursor,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ complete: false, pending_users: 1, held_users: 0 });
    expect((await f.row())?.phase).toBe('deleting');
    const forged = JSON.parse(decoded) as Record<string, unknown>;
    forged.at = Number.MAX_SAFE_INTEGER;
    const skip = btoa(JSON.stringify(forged))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    const skipped = await f.request('/cleanup', 'POST', { dry_run: false, cursor: skip });
    expect(await skipped.json()).toMatchObject({ complete: false, has_more: true });
    forged.tenantId = 'different-tenant';
    const crossTenant = btoa(JSON.stringify(forged))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    expect(
      (await f.request('/cleanup', 'POST', { dry_run: false, cursor: crossTenant })).status
    ).toBe(400);
  });
  it('advances past seventeen RP-less passkeys, captures a later valid RP and drains every credential', async () => {
    const f = await fixture(0);
    for (let n = 0; n < 18; n++)
      f.core.db
        .prepare(
          `INSERT INTO passkeys(id,tenant_id,user_id,credential_id,public_key,created_at,rp_id) VALUES(?,?,?,?,?,1,?)`
        )
        .run(
          `passkey-${n.toString().padStart(3, '0')}`,
          f.route.tenantId,
          f.route.userId,
          `credential-${n}`,
          'public-key',
          n === 17 ? 'passkey.example.invalid' : n % 2 === 0 ? null : ''
        );
    await f.admit();
    await f.finish();
    expect(f.core.db.prepare('SELECT * FROM passkeys').all()).toEqual([]);
    expect(
      f.core.db
        .prepare(
          "SELECT COUNT(*) AS n FROM account_routing_outbox WHERE event_kind='account_deleted'"
        )
        .get()
    ).toEqual({ n: 2 });
    expect(f.pii.db.prepare('SELECT state FROM guest_pii_erasure_markers').get()).toEqual({
      state: 'deleted',
    });
  });
  it('returns 404 for a missing Guest without audit or authentication effects', async () => {
    const f = await fixture();
    expect((await f.request('/guests/30000000-0000-4000-8000-000000000099')).status).toBe(404);
    expect(mocks.contextAudit).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('returns 400 for a registered account without creating a Guest deletion intent', async () => {
    const f = await fixture();
    f.core.db.exec("UPDATE identity_accounts SET registration_state='registered'");
    expect((await f.request(`/guests/${f.route.userId}`)).status).toBe(400);
    expect((await f.row())?.phase).toBe('active');
    expect(f.core.db.prepare('SELECT * FROM guest_deletion_audit_outbox').all()).toEqual([]);
    expect(mocks.contextAudit).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it.each(['reserved', 'committed', 'releasing', 'released'] as const)(
    'finishes deletion after an upgrade conflict without changing another owner in %s through retries',
    async (state) => {
      const f = await fixture();
      const conflict = await pinConflictedUpgrade(f);
      if (state !== 'reserved') {
        const at = Math.floor(Date.now() / 1000);
        f.lookup.db
          .prepare(
            'UPDATE lookup_identifier_reservations SET reservation_state=?,lease_expires_at=NULL,committed_at=?,released_at=?'
          )
          .run(state, state === 'committed' ? at : null, state === 'released' ? at : null);
        conflict.before = f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all();
      }
      const input = await reachReservationPage(f);
      for (let n = 0; n < 2; n++) {
        expect(
          await releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
        ).toMatchObject({ done: true });
        expect(f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
          conflict.before
        );
      }
      await f.finish();
      expect((await f.row())?.phase).toBe('deleted');
      expect(await conflict.operations.get(conflict.operationId)).toMatchObject({
        state: 'canceled',
        proof_payload_json: null,
        challenge_verifier: null,
        reservation_publication_json: null,
      });
      expect(f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
        conflict.before
      );
      expect(
        f.core.db
          .prepare('SELECT lifecycle_state FROM identity_accounts WHERE id=?')
          .get(conflict.otherPublication.accountId)
      ).toEqual({ lifecycle_state: 'active' });
    }
  );
  it('requires matching primary/migration-mirror ownership before treating a foreign reservation as unowned', async () => {
    const f = await fixture();
    const conflict = await pinConflictedUpgrade(f);
    const input = await reachReservationPage(f);
    const mirror = openGuestStore('lookup');
    stores.push(mirror);
    const row = conflict.before[0] as Record<string, string | number | null>;
    mirror.db
      .prepare(
        `INSERT INTO lookup_identifier_reservations(${Object.keys(row).join(',')}) VALUES(${Object.keys(
          row
        )
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row));
    mirror.db.exec(
      "UPDATE lookup_identifier_reservations SET operation_id='different-mirror-operation'"
    );
    const base = d1OverSqlite(mirror.db);
    const mirrorBinding = Object.assign(base, {
      withSession: () => ({ ...base, getBookmark: () => null }),
    });
    Object.assign(f.env, {
      LOOKUP_MIRROR: mirrorBinding,
      CONTROL: {
        getLookupBucketWriteRoute: async ({ virtualBucket }: { virtualBucket: number }) => ({
          virtualBucket,
          primary: {
            lookupShardId: 'lookup-primary',
            bindingRef: 'LOOKUP',
            assignmentGeneration: 1,
          },
          mirrors: [
            {
              lookupShardId: 'lookup-mirror',
              bindingRef: 'LOOKUP_MIRROR',
              assignmentGeneration: 2,
            },
          ],
          migration: { operationId: 'lookup-migration', state: 'copying' },
        }),
      },
    });
    mocks.assignments.mockResolvedValue({
      resolveActiveAssignment: async (virtualBucket: number) => ({
        state: 'active',
        virtualBucket,
        lookupShardId: 'lookup-primary',
        bindingRef: 'LOOKUP',
        assignmentGeneration: 1,
      }),
    });
    const actualResolver = await vi.importActual<typeof import('../lookup-bucket-write-route')>(
      '../lookup-bucket-write-route'
    );
    mocks.writeResolver.mockImplementation(actualResolver.createLookupBucketWriteResolver);
    await expect(
      releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
    ).rejects.toThrow('lookup_write_reflection_mismatch');
    expect(f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
      conflict.before
    );
    expect(await conflict.operations.get(conflict.operationId)).toMatchObject({
      state: 'verified',
      reservation_publication_json: JSON.stringify(conflict.publication),
    });
    mirror.db
      .prepare('UPDATE lookup_identifier_reservations SET operation_id=?')
      .run(conflict.otherPublication.operationId);
    for (let n = 0; n < 2; n++)
      expect(
        await releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
      ).toMatchObject({ done: true });
    await f.finish();
    expect((await f.row())?.phase).toBe('deleted');
    expect(f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
      conflict.before
    );
    expect(mirror.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
      conflict.before
    );
  });
  it.each(['same-operation-different-owner', 'repair-required'] as const)(
    'rejects ambiguous reservation proof without changing it: %s',
    async (fault) => {
      const f = await fixture();
      const conflict = await pinConflictedUpgrade(f);
      const input = await reachReservationPage(f);
      if (fault === 'repair-required')
        f.lookup.db.exec(
          "UPDATE lookup_identifier_reservations SET reservation_state='repair_required'"
        );
      else
        f.lookup.db
          .prepare('UPDATE lookup_identifier_reservations SET operation_id=?')
          .run(conflict.publication.operationId);
      const before = f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all();
      for (let n = 0; n < 2; n++)
        await expect(
          releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
        ).rejects.toThrow('guest_reservation_release_unverified');
      expect(f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
        before
      );
      expect((await conflict.operations.get(conflict.operationId))?.state).toBe('verified');
    }
  );
  it.each(['owned', 'absent'] as const)(
    'retains the original-operation released sentinel for %s reservations through retries',
    async (mode) => {
      const f = await fixture();
      const upgrade = await pinConflictedUpgrade(f, mode);
      const input = await reachReservationPage(f);
      for (let n = 0; n < 2; n++)
        expect(
          await releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
        ).toMatchObject({ done: true });
      expect(
        f.lookup.db
          .prepare(
            'SELECT account_id,operation_id,reservation_state,lease_expires_at FROM lookup_identifier_reservations'
          )
          .all()
      ).toEqual([
        {
          account_id: f.route.accountId,
          operation_id: upgrade.publication.operationId,
          reservation_state: 'released',
          lease_expires_at: null,
        },
      ]);
      await expect(upgrade.reservations.reserve(upgrade.publication)).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      await f.finish();
      expect((await f.row())?.phase).toBe('deleted');
    }
  );
  it('resumes an owned mirror release after one side committed earlier without requiring equal release timestamps', async () => {
    const f = await fixture();
    const upgrade = await pinConflictedUpgrade(f, 'owned');
    const input = await reachReservationPage(f);
    const mirror = openGuestStore('lookup');
    stores.push(mirror);
    const row = upgrade.before[0] as Record<string, string | number | null>;
    mirror.db
      .prepare(
        `INSERT INTO lookup_identifier_reservations(${Object.keys(row).join(',')}) VALUES(${Object.keys(
          row
        )
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row));
    mirror.db.exec(
      `CREATE TABLE mirror_release_fault(remaining INTEGER);INSERT INTO mirror_release_fault VALUES(1);CREATE TRIGGER fail_owned_release BEFORE UPDATE ON lookup_identifier_reservations WHEN NEW.reservation_state='released' AND EXISTS(SELECT 1 FROM mirror_release_fault) BEGIN SELECT RAISE(ABORT,'mirror_offline');END;`
    );
    const base = d1OverSqlite(mirror.db);
    const mirrorBinding = Object.assign(base, {
      withSession: () => ({ ...base, getBookmark: () => null }),
    });
    Object.assign(f.env, {
      LOOKUP_MIRROR: mirrorBinding,
      CONTROL: {
        getLookupBucketWriteRoute: async ({ virtualBucket }: { virtualBucket: number }) => ({
          virtualBucket,
          primary: {
            lookupShardId: 'lookup-primary',
            bindingRef: 'LOOKUP',
            assignmentGeneration: 1,
          },
          mirrors: [
            {
              lookupShardId: 'lookup-mirror',
              bindingRef: 'LOOKUP_MIRROR',
              assignmentGeneration: 2,
            },
          ],
          migration: { operationId: 'lookup-migration', state: 'copying' },
        }),
      },
    });
    mocks.assignments.mockResolvedValue({
      resolveActiveAssignment: async (virtualBucket: number) => ({
        state: 'active',
        virtualBucket,
        lookupShardId: 'lookup-primary',
        bindingRef: 'LOOKUP',
        assignmentGeneration: 1,
      }),
    });
    const actualResolver = await vi.importActual<typeof import('../lookup-bucket-write-route')>(
      '../lookup-bucket-write-route'
    );
    mocks.writeResolver.mockImplementation(actualResolver.createLookupBucketWriteResolver);
    await expect(
      releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
    ).rejects.toThrow('mirror_offline');
    expect(
      f.lookup.db.prepare('SELECT reservation_state FROM lookup_identifier_reservations').get()
    ).toEqual({ reservation_state: 'released' });
    expect(
      mirror.db.prepare('SELECT reservation_state FROM lookup_identifier_reservations').get()
    ).toEqual({ reservation_state: 'reserved' });
    mirror.db.exec('DELETE FROM mirror_release_fault');
    vi.setSystemTime(Date.now() + 1000);
    expect(
      await releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
    ).toMatchObject({ done: true });
    expect(
      f.lookup.db.prepare('SELECT released_at FROM lookup_identifier_reservations').get()
    ).not.toEqual(
      mirror.db.prepare('SELECT released_at FROM lookup_identifier_reservations').get()
    );
    await f.finish();
    expect((await f.row())?.phase).toBe('deleted');
  });
  it('accepts a legitimate foreign mirrored reserve with different creation timestamps without modifying either owner row', async () => {
    const f = await fixture();
    const conflict = await pinConflictedUpgrade(f);
    const mirror = openGuestStore('lookup');
    stores.push(mirror);
    const base = d1OverSqlite(mirror.db);
    const mirrorBinding = Object.assign(base, {
      withSession: () => ({ ...base, getBookmark: () => null }),
    });
    Object.assign(f.env, {
      LOOKUP_MIRROR: mirrorBinding,
      CONTROL: {
        getLookupBucketWriteRoute: async ({ virtualBucket }: { virtualBucket: number }) => ({
          virtualBucket,
          primary: {
            lookupShardId: 'lookup-primary',
            bindingRef: 'LOOKUP',
            assignmentGeneration: 1,
          },
          mirrors: [
            {
              lookupShardId: 'lookup-mirror',
              bindingRef: 'LOOKUP_MIRROR',
              assignmentGeneration: 2,
            },
          ],
          migration: { operationId: 'lookup-migration', state: 'copying' },
        }),
      },
    });
    mocks.assignments.mockResolvedValue({
      resolveActiveAssignment: async (virtualBucket: number) => ({
        state: 'active',
        virtualBucket,
        lookupShardId: 'lookup-primary',
        bindingRef: 'LOOKUP',
        assignmentGeneration: 1,
      }),
    });
    const actualResolver = await vi.importActual<typeof import('../lookup-bucket-write-route')>(
      '../lookup-bucket-write-route'
    );
    mocks.writeResolver.mockImplementation(actualResolver.createLookupBucketWriteResolver);
    vi.setSystemTime(Date.now() + 1000);
    const reservations = new InitialAccountIdentifierReservationService({
      lookupForBucket: await actualResolver.createLookupBucketWriteResolver(f.env),
      now: () => Math.floor(Date.now() / 1000),
    });
    expect(await reservations.reserve(conflict.otherPublication)).toEqual({ reservedCount: 1 });
    await expect(reservations.reserve(conflict.publication)).rejects.toThrow(
      'directory_identifier_reservation_conflict'
    );
    const primaryBefore = f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all(),
      mirrorBefore = mirror.db.prepare('SELECT * FROM lookup_identifier_reservations').all();
    expect(primaryBefore).not.toEqual(mirrorBefore);
    const input = await reachReservationPage(f);
    for (let n = 0; n < 2; n++)
      expect(
        await releaseGuestReservationPage(f.env, { ...input, pii: f.pii.adapter })
      ).toMatchObject({ done: true });
    await f.finish();
    expect((await f.row())?.phase).toBe('deleted');
    expect(f.lookup.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
      primaryBefore
    );
    expect(mirror.db.prepare('SELECT * FROM lookup_identifier_reservations').all()).toEqual(
      mirrorBefore
    );
  });
  it.each(['successful-page', 'lost-ack-empty-page'] as const)(
    'forgets this isolate anonymization cache after the mapping stage: %s',
    async (mode) => {
      const f = await fixture(),
        anonymous = '40000000-0000-4000-8000-000000000001';
      f.pii.db
        .prepare(
          'INSERT INTO user_anonymization_map(id,tenant_id,user_id,anonymized_user_id,created_at) VALUES(?,?,?,?,1)'
        )
        .run('mapping-a', f.route.tenantId, f.route.userId, anonymous);
      await f.admit();
      let found = false;
      for (let n = 0; n < 100; n++) {
        const task = f.core.db
          .prepare('SELECT execution_progress_json FROM guest_deletion_audit_outbox')
          .get() as { execution_progress_json: string | null };
        if (task.execution_progress_json) {
          const progress = parseGuestDeletionProgress(task.execution_progress_json);
          if (
            progress.stage === 'drain_pii' &&
            GUEST_PII_ERASURE_TABLES[progress.sourceOrdinal] === 'user_anonymization_map'
          ) {
            found = true;
            break;
          }
        }
        await f.step();
      }
      expect(found).toBe(true);
      cacheAnonymizedUserId(f.route.tenantId, f.route.userId, anonymous);
      cacheAnonymizedUserId('other-tenant', f.route.userId, 'other-anonymous');
      expect(getCachedAnonymizedUserId(f.route.tenantId, f.route.userId)).toBe(anonymous);
      if (mode === 'lost-ack-empty-page') {
        const batch = f.pii.adapter.batch.bind(f.pii.adapter);
        let failed = false;
        f.pii.adapter.batch = async (statements) => {
          const result = await batch(statements);
          if (
            !failed &&
            statements.some((statement) =>
              statement.sql.startsWith('DELETE FROM user_anonymization_map')
            )
          ) {
            failed = true;
            throw new Error('lost_pii_commit_ack');
          }
          return result;
        };
        await expect(f.step()).rejects.toThrow('lost_pii_commit_ack');
        f.pii.adapter.batch = batch;
        expect(f.pii.db.prepare('SELECT * FROM user_anonymization_map').all()).toEqual([]);
        expect(getCachedAnonymizedUserId(f.route.tenantId, f.route.userId)).toBe(anonymous);
      }
      expect(await f.step()).toBe('pending');
      expect(f.pii.db.prepare('SELECT * FROM user_anonymization_map').all()).toEqual([]);
      expect(getCachedAnonymizedUserId(f.route.tenantId, f.route.userId)).toBeUndefined();
      expect(getCachedAnonymizedUserId('other-tenant', f.route.userId)).toBe('other-anonymous');
      await f.finish();
    }
  );
});

/**
 * Admin actions that end a user's sessions → downstream relying parties.
 *
 * Suspending or locking an account and revoking all of a user's sessions end those sessions by
 * moving the user's session revocation epoch. The relying parties signed in through them are
 * told as on a user logout: one logout token per client with that client's sid. The sessions are
 * kept as admin jobs before the admin response and the first job is sent after it; a job that
 * could not be sent is left for the scheduled run to retry.
 *
 * The user's session index and epoch are the real SessionRevocationStore (in-memory storage),
 * the jobs are run by the real admin job executor over an in-memory admin_jobs table, and the
 * logout tokens are signed with an OP key from the KeyManager and verified here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import type { LogoutConfig, SessionClientWithDetails } from '@authrim/ar-lib-core';

const OP_ISSUER = 'https://op.example.com';
const RP_A = 'https://rp-a.example.com/backchannel-logout';
const RP_B = 'https://rp-b.example.com/backchannel-logout';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), execute: vi.fn(), query: vi.fn(), batch: vi.fn() },
  contextAudit: vi.fn(),
  audit:
    vi.fn<
      (
        env: unknown,
        entry: { action: string; resourceId?: string; metadata: string }
      ) => Promise<void>
    >(),
  scheduleAdminAudit: vi.fn(),
  resolveTargets: vi.fn(),
  resolveLogoutConfig: vi.fn(),
  resolveLogoutWebhookConfig: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  tenantAdapter: { queryOne: vi.fn(), execute: vi.fn(), query: vi.fn(), batch: vi.fn() },
  backchannelFanout: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.adapter,
      repositories: { sessionClient: {} },
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocks.adapter })),
    CanonicalRuntimeUserStore: vi.fn(function () {
      return { findById: vi.fn(async (id: string) => ({ id })) };
    }),
    createAuditLogFromContext: mocks.contextAudit,
    createAuditLog: mocks.audit,
    buildCanonicalTenantIssuerUrl: vi.fn(
      async (_env: unknown, _tenantId: string, fallback: string) => fallback
    ),
    resolveLogoutTargetsFromSessionClientStore: mocks.resolveTargets,
    resolveLogoutConfig: mocks.resolveLogoutConfig,
    resolveLogoutWebhookConfig: mocks.resolveLogoutWebhookConfig,
    // The admin database binding is the in-memory admin_jobs table itself.
    ensureDatabaseAdapter: vi.fn((source: unknown) => source),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.tenantAdapter),
    emitRuntimeLogRecords: vi.fn(async () => ({ tenantKey: 'tk', targetResults: [] })),
    sendBackchannelLogoutFanout: mocks.backchannelFanout,
  };
});

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return {
    ...actual,
    scheduleAdminAuditLog: mocks.scheduleAdminAudit,
    logSanitizedError: vi.fn(),
  };
});

import {
  buildCanonicalTenantIssuerUrl,
  DEFAULT_LOGOUT_CONFIG,
  DEFAULT_LOGOUT_WEBHOOK_CONFIG,
  SessionRevocationStore,
} from '@authrim/ar-lib-core';
import { adminUserActivateHandler, adminUserLockHandler, adminUserSuspendHandler } from '../admin';
import { adminUserRevokeAllSessionsHandler } from '../admin-user-sessions';
import { processGenericAdminJobNow } from '../admin-job-executor';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key: string | string[]) => {
      if (Array.isArray(key)) return key.filter((item) => data.delete(item)).length;
      return data.delete(key);
    },
    list: async <T>(options?: { prefix?: string; limit?: number }) =>
      new Map(
        [...data.entries()]
          .filter(([key]) => (options?.prefix ? key.startsWith(options.prefix) : true))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, options?.limit) as [string, T][]
      ),
    transaction: async <T>(closure: (txn: unknown) => Promise<T>) => closure(storage),
  };
  return storage;
}

/** One real SessionRevocationStore per user, as the namespace addresses them. */
function revocationNamespace() {
  const stores = new Map<string, SessionRevocationStore>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let store = stores.get(id);
      if (!store) {
        store = new SessionRevocationStore(
          {
            storage: memoryStorage(),
            blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
          } as never,
          {} as never
        );
        stores.set(id, store);
      }
      return store;
    },
  };
}

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    })),
  };
}

type JobRow = Record<string, unknown> & { id: string; status: string; config: string };

/** The admin_jobs table, as far as the job executor and the enqueue use it. */
function adminJobsDb() {
  const jobs = new Map<string, JobRow>();
  return {
    jobs,
    failInserts: false,
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      if (this.failInserts) throw new Error('admin database unavailable');
      for (const { sql, params } of statements) {
        if (!sql.includes('INSERT INTO admin_jobs')) continue;
        const [id, tenantId, jobType, progress, config, createdBy] = params as string[];
        jobs.set(id, {
          id,
          tenant_id: tenantId,
          job_type: jobType,
          status: 'pending',
          progress,
          config,
          created_by: createdBy,
          created_at: 1,
          attempt_count: 0,
          max_attempts: 3,
          next_run_at: null,
        });
      }
      return statements.map(() => ({ success: true, rowsAffected: 1 }));
    },
    async queryOne(sql: string, params: unknown[]) {
      if (!sql.includes('FROM admin_jobs')) return null;
      const job = jobs.get(params[1] as string);
      return job && job.status === 'pending' && job.tenant_id === params[2] ? { ...job } : null;
    },
    async query() {
      return [];
    },
    transaction: vi.fn(),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'memory'),
    close: vi.fn(),
    async execute(sql: string, params: unknown[]) {
      const at = (index: number) => jobs.get(params[index] as string);
      if (sql.includes("SET status = 'processing', started_at")) {
        const job = at(2);
        if (job?.status !== 'pending') return { rowsAffected: 0 };
        job.status = 'processing';
      } else if (sql.includes('SET status = ?, progress = ?, result = ?')) {
        Object.assign(at(7)!, { status: params[0], result: params[2] });
      } else if (sql.includes("SET status = 'pending', error_message")) {
        Object.assign(at(5)!, {
          status: 'pending',
          error_message: params[0],
          attempt_count: params[1],
        });
      } else if (sql.includes("SET status = 'failed'")) {
        Object.assign(at(7)!, { status: 'failed', error_message: params[0] });
      }
      return { success: true, rowsAffected: 1 };
    },
  };
}

type Keys = { privateKey: CryptoKey; publicJwk: jose.JWK };
let op: Keys;
let opPrivatePem: string;

function createEnv() {
  return {
    ISSUER_URL: OP_ISSUER,
    SETTINGS: memoryKv(),
    SESSION_REVOCATION_STORE: revocationNamespace(),
    DB_ADMIN: adminJobsDb(),
    KEY_MANAGER: {
      idFromName: vi.fn(() => 'km'),
      get: vi.fn(() => ({
        getAllPublicKeysRpc: vi.fn().mockResolvedValue([op.publicJwk]),
        getActiveKeyWithPrivateRpc: vi
          .fn()
          .mockResolvedValue({ kid: 'op-key', privatePEM: opPrivatePem }),
      })),
    },
  };
}

type TestEnv = ReturnType<typeof createEnv>;

function context(
  env: TestEnv,
  options: { body?: unknown; executionCtx?: boolean; adminId?: string; host?: string } = {}
) {
  const pending: Promise<unknown>[] = [];
  const c = {
    get: vi.fn((name: string) =>
      name === 'adminAuth' ? { userId: options.adminId ?? 'admin-1' } : undefined
    ),
    req: {
      param: vi.fn(() => 'user-1'),
      json: vi.fn().mockResolvedValue(options.body ?? { reason_code: 'security_incident' }),
      header: vi.fn(() => undefined),
      raw: new Request(`${options.host ?? OP_ISSUER}/api/admin/users/user-1`),
    },
    env,
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
    ...(options.executionCtx === false
      ? {}
      : { executionCtx: { waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)) } }),
  };
  return { c: c as never, pending };
}

async function settle(pending: Promise<unknown>[]) {
  for (let i = 0; i < pending.length; i++) await pending[i];
}

/** A session the user signed in with before the admin action, with its relying parties. */
async function signIn(env: TestEnv, sessionId: string, clients: Array<[string, string]>, at = 0) {
  const now = Date.now() - 60_000 + at;
  await env.SESSION_REVOCATION_STORE.get('tenant:tenant-a:user-session:user-1').registerSessionRpc(
    'tenant-a',
    'user-1',
    'account:user-1',
    now,
    sessionId,
    now + 3_600_000
  );
  sessionClients.set(
    sessionId,
    clients.map(([clientId, uri]) => backchannelClient(sessionId, clientId, uri))
  );
}

const sessionClients = new Map<string, SessionClientWithDetails[]>();

function backchannelClient(sessionId: string, clientId: string, uri: string) {
  return {
    id: `sc-${sessionId}-${clientId}`,
    tenant_id: 'tenant-a',
    session_id: sessionId,
    client_id: clientId,
    oidc_sid: `sid-${sessionId}-${clientId}`,
    first_token_at: 1,
    last_token_at: 1,
    last_seen_at: null,
    client_name: clientId,
    backchannel_logout_uri: uri,
    backchannel_logout_session_required: true,
    frontchannel_logout_uri: null,
    frontchannel_logout_session_required: false,
  } satisfies SessionClientWithDetails;
}

type Sent = { url: string; token: string };
type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

function captureDownstream(statusFor: (url: string) => number = () => 200) {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: FetchInput, init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    sent.push({ url, token: body.get('logout_token') ?? '' });
    return new Response(null, { status: statusFor(url) });
  }) as typeof fetch;
  return sent;
}

async function verified(token: string) {
  const { payload } = await jose.jwtVerify(token, await jose.importJWK(op.publicJwk, 'RS256'), {
    issuer: OP_ISSUER,
    algorithms: ['RS256'],
  });
  return payload;
}

function config(overrides: Partial<LogoutConfig['backchannel']> = {}): LogoutConfig {
  return {
    ...DEFAULT_LOGOUT_CONFIG,
    backchannel: {
      ...DEFAULT_LOGOUT_CONFIG.backchannel,
      retry: { ...DEFAULT_LOGOUT_CONFIG.backchannel.retry, max_attempts: 0 },
      ...overrides,
    },
  };
}

function queueAccount(status: string) {
  mocks.adapter.queryOne
    .mockResolvedValueOnce({
      id: 'account-1',
      lifecycle_state: status,
      metadata_json: JSON.stringify({ status }),
    })
    .mockResolvedValueOnce({ id: 'account-1', primary_subject_id: 'subject-1' });
}

function auditEntries(action: string) {
  return mocks.audit.mock.calls
    .map(([, entry]) => entry)
    .filter((entry) => entry.action === action)
    .map((entry) => ({
      ...entry,
      metadata: JSON.parse(entry.metadata) as Record<string, unknown>,
    }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin actions that end sessions notify downstream relying parties', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sessionClients.clear();
    if (!op) {
      const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
      op = {
        privateKey: privateKey as CryptoKey,
        publicJwk: { ...(await jose.exportJWK(publicKey)), kid: 'op-key', alg: 'RS256' },
      };
      opPrivatePem = await jose.exportPKCS8(op.privateKey);
    }
    mocks.tenantAdapter.queryOne.mockReset().mockResolvedValue({ lifecycle_state: 'active' });
    const actualCore =
      await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
    mocks.backchannelFanout.mockReset().mockImplementation(actualCore.sendBackchannelLogoutFanout);
    mocks.adapter.queryOne.mockReset().mockResolvedValue(null);
    mocks.adapter.query.mockReset().mockResolvedValue([]);
    mocks.adapter.execute.mockReset().mockResolvedValue({ success: true, rowsAffected: 0 });
    mocks.adapter.batch
      .mockReset()
      .mockImplementation(async (statements: unknown[]) =>
        statements.map(() => ({ success: true, rowsAffected: 1 }))
      );
    mocks.audit.mockResolvedValue(undefined);
    mocks.contextAudit.mockResolvedValue(undefined);
    mocks.resolveLogoutConfig.mockResolvedValue(config());
    mocks.resolveLogoutWebhookConfig.mockResolvedValue(DEFAULT_LOGOUT_WEBHOOK_CONFIG);
    mocks.resolveTargets.mockImplementation(
      async (_env: unknown, _tenantId: string, sessionId: string) => ({
        backchannelClients: sessionClients.get(sessionId) ?? [],
        frontchannelClients: [],
        webhookClients: [],
      })
    );
  });

  it.each([
    ['suspend', adminUserSuspendHandler, 'user.suspend'],
    ['lock', adminUserLockHandler, 'user.lock'],
  ] as const)(
    '%s sends each client of each ended session its own logout token',
    async (_name, handler, triggerAction) => {
      const env = createEnv();
      await signIn(env, 'session-1', [
        ['client-a', RP_A],
        ['client-b', RP_B],
      ]);
      await signIn(env, 'session-2', [['client-a', RP_A]], 1);
      const sent = captureDownstream();
      queueAccount('active');

      const { c, pending } = context(env);
      const response = await handler(c);
      expect(response.status).toBe(200);
      // Nothing is sent before the admin response.
      expect(sent).toHaveLength(0);
      await settle(pending);

      expect(sent.map((s) => s.url).sort()).toEqual([RP_A, RP_A, RP_B]);
      const claims = await Promise.all(sent.map((s) => verified(s.token)));
      expect(claims.map((claim) => [claim.aud, claim.sid]).sort()).toEqual([
        ['client-a', 'sid-session-1-client-a'],
        ['client-a', 'sid-session-2-client-a'],
        ['client-b', 'sid-session-1-client-b'],
      ]);
      for (const claim of claims) {
        expect(claim.sub).toBe('user-1');
        expect(claim.events).toEqual({ 'http://schemas.openid.net/event/backchannel-logout': {} });
        expect(claim).not.toHaveProperty('nonce');
      }

      // The admin audit records that the fan-out was started and by which action.
      expect(mocks.scheduleAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        'user.downstream_logout',
        'user-1',
        'success',
        expect.objectContaining({
          trigger_action: triggerAction,
          operation_id: expect.any(String),
          user_count: 1,
          session_count: 2,
          job_ids: [expect.any(String)],
        })
      );
      // The job holding the sessions ran to its end.
      expect([...env.DB_ADMIN.jobs.values()].map((job) => job.status)).toEqual(['completed']);
      const logouts = auditEntries('user.logout');
      expect(logouts.map((entry) => entry.resourceId).sort()).toEqual(['session-1', 'session-2']);
      expect(logouts[0].metadata).toMatchObject({
        reason: 'admin_session_end',
        trigger_action: triggerAction,
        actor_id: 'admin-1',
      });
    }
  );

  it('revoking all sessions of a user tells their relying parties', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();

    const { c, pending } = context(env);
    const response = await adminUserRevokeAllSessionsHandler(c);
    expect(response.status).toBe(200);
    await settle(pending);

    expect(sent).toHaveLength(1);
    expect(await verified(sent[0].token)).toMatchObject({
      aud: 'client-a',
      sid: 'sid-session-1-client-a',
      sub: 'user-1',
    });
    expect(mocks.scheduleAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.downstream_logout',
      'user-1',
      'success',
      expect.objectContaining({ trigger_action: 'user.sessions_revoked' })
    );
  });

  it('does not tell again the sessions an earlier revocation ended', async () => {
    const env = createEnv();
    await signIn(env, 'session-old', [['client-old', RP_B]]);
    captureDownstream();
    const first = context(env);
    await adminUserRevokeAllSessionsHandler(first.c);
    await settle(first.pending);

    await signIn(env, 'session-new', [['client-new', RP_A]], 59_999);
    const sent = captureDownstream();
    queueAccount('active');
    const { c, pending } = context(env);
    await adminUserSuspendHandler(c);
    await settle(pending);

    expect(sent.map((s) => s.url)).toEqual([RP_A]);
    expect((await verified(sent[0].token)).aud).toBe('client-new');
  });

  it('records a relying party that refuses the logout token in the failure list', async () => {
    const env = createEnv();
    mocks.resolveLogoutConfig.mockResolvedValue(config({ on_final_failure: 'alert' }));
    await signIn(env, 'session-1', [
      ['client-a', RP_A],
      ['client-b', RP_B],
    ]);
    captureDownstream((url) => (url === RP_B ? 400 : 200));
    queueAccount('active');

    const { c, pending } = context(env);
    await adminUserSuspendHandler(c);
    await settle(pending);

    const failureKeys = [...env.SETTINGS.store.keys()].filter((key) =>
      key.startsWith('logout:failures:')
    );
    expect(failureKeys).toEqual(['logout:failures:client-b']);
    expect(auditEntries('backchannel_logout.failed')).toEqual([
      expect.objectContaining({
        resourceId: 'session-1',
        metadata: expect.objectContaining({
          client_id: 'client-b',
          trigger: 'admin_session_end',
          trigger_action: 'user.suspend',
        }),
      }),
    ]);
  });

  it('still tells the relying parties when the account update fails after the sessions ended', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    queueAccount('active');
    mocks.adapter.batch.mockRejectedValueOnce(new Error('database unavailable'));

    const { c, pending } = context(env);
    expect((await adminUserLockHandler(c)).status).toBe(500);
    await settle(pending);
    expect(sent.map((s) => s.url)).toEqual([RP_A]);
  });

  it("signs with the tenant's canonical issuer, not the admin request's host", async () => {
    const env = createEnv();
    vi.mocked(buildCanonicalTenantIssuerUrl).mockResolvedValueOnce('https://login.example.com');
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();

    const { c, pending } = context(env, { host: 'https://admin.example.com' });
    await adminUserRevokeAllSessionsHandler(c);
    await settle(pending);
    const { payload } = await jose.jwtVerify(
      sent[0].token,
      await jose.importJWK(op.publicJwk, 'RS256')
    );
    expect(payload.iss).toBe('https://login.example.com');
  });

  it('answers the admin request without waiting for a slow relying party', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    queueAccount('active');

    const { c, pending } = context(env);
    const response = await adminUserSuspendHandler(c);
    expect(response.status).toBe(200);
    expect(pending.length).toBeGreaterThan(0);
    release();
    await settle(pending);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('without an execution context, keeps the job for the scheduled run', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    queueAccount('active');

    const { c } = context(env, { executionCtx: false });
    expect((await adminUserSuspendHandler(c)).status).toBe(200);
    expect(sent).toHaveLength(0);
    const [job] = [...env.DB_ADMIN.jobs.values()];
    expect(job.status).toBe('pending');

    // The scheduled run sends it.
    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);
    expect(sent.map((s) => s.url)).toEqual([RP_A]);
    expect(job.status).toBe('completed');
  });

  it('retries a job whose logout targets could not be read, sending nothing first', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    await signIn(env, 'session-2', [['client-b', RP_B]], 1);
    const sent = captureDownstream();
    mocks.resolveTargets.mockRejectedValueOnce(new Error('session client store unavailable'));
    queueAccount('active');

    const { c, pending } = context(env);
    await adminUserSuspendHandler(c);
    await settle(pending);
    const [job] = [...env.DB_ADMIN.jobs.values()];
    expect(sent).toHaveLength(0);
    expect(job).toMatchObject({ status: 'pending', attempt_count: 1 });

    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);
    expect(sent.map((s) => s.url).sort()).toEqual([RP_A, RP_B]);
    expect(job.status).toBe('completed');
  });

  it('retries instead of signing with another issuer when the tenant issuer cannot be read', async () => {
    const env = createEnv();
    vi.mocked(buildCanonicalTenantIssuerUrl).mockRejectedValueOnce(new Error('lookup failed'));
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();

    const { c, pending } = context(env);
    await adminUserRevokeAllSessionsHandler(c);
    await settle(pending);
    expect(sent).toHaveLength(0);
    expect([...env.DB_ADMIN.jobs.values()][0].status).toBe('pending');
    expect(vi.mocked(buildCanonicalTenantIssuerUrl)).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      OP_ISSUER,
      { strict: true }
    );
  });

  it('retries a job the fan-out could not send (no signing key)', async () => {
    const env = createEnv();
    const keyManager = {
      getAllPublicKeysRpc: vi.fn().mockResolvedValue([op.publicJwk]),
      getActiveKeyWithPrivateRpc: vi
        .fn()
        .mockRejectedValueOnce(new Error('key manager unavailable'))
        .mockResolvedValue({ kid: 'op-key', privatePEM: opPrivatePem }),
    };
    env.KEY_MANAGER.get.mockReturnValue(keyManager);
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    queueAccount('active');

    const { c, pending } = context(env);
    await adminUserSuspendHandler(c);
    await settle(pending);
    const [job] = [...env.DB_ADMIN.jobs.values()];
    expect(sent).toHaveLength(0);
    expect(job.status).toBe('pending');

    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);
    expect(sent.map((s) => s.url)).toEqual([RP_A]);
  });

  it('retries a job whose logout settings could not be read', async () => {
    const env = createEnv();
    mocks.resolveLogoutConfig.mockRejectedValueOnce(new Error('settings unavailable'));
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();

    const { c, pending } = context(env);
    await adminUserRevokeAllSessionsHandler(c);
    await settle(pending);
    const [job] = [...env.DB_ADMIN.jobs.values()];
    expect(sent).toHaveLength(0);
    expect(job.status).toBe('pending');

    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);
    expect(sent.map((s) => s.url)).toEqual([RP_A]);
  });

  it('retries a job when a session broke off while being sent', async () => {
    const env = createEnv();
    mocks.backchannelFanout.mockResolvedValueOnce({ succeeded: 0, failed: 0, sessionErrors: 1 });
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    captureDownstream();

    const { c, pending } = context(env);
    await adminUserRevokeAllSessionsHandler(c);
    await settle(pending);
    expect([...env.DB_ADMIN.jobs.values()][0]).toMatchObject({
      status: 'pending',
      error_message: expect.stringContaining('session_end_logout_sessions_not_sent'),
    });
  });

  it('records in the audit a job that failed for the last time', async () => {
    const env = createEnv();
    mocks.resolveTargets.mockRejectedValue(new Error('session client store unavailable'));
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    queueAccount('active');

    const { c, pending } = context(env);
    await adminUserSuspendHandler(c);
    await settle(pending);
    const [job] = [...env.DB_ADMIN.jobs.values()];
    expect(auditEntries('user.downstream_logout_failed')).toEqual([]);
    // Two retries more use up the job's three attempts.
    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);
    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);

    expect(job.status).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(auditEntries('user.downstream_logout_failed')).toEqual([
      expect.objectContaining({
        resourceId: 'user-1',
        metadata: {
          trigger_action: 'user.suspend',
          operation_id: expect.any(String),
          actor_id: 'admin-1',
          job_id: job.id,
          session_count: 1,
          // The store's own message is not recorded.
          error_code: 'unexpected',
        },
      }),
    ]);
  });

  it("retries when the tenant's state cannot be read, and sends for a suspended tenant", async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    mocks.tenantAdapter.queryOne.mockRejectedValueOnce(new Error('tenant route unavailable'));

    const { c, pending } = context(env);
    await adminUserRevokeAllSessionsHandler(c);
    await settle(pending);
    const [job] = [...env.DB_ADMIN.jobs.values()];
    expect(sent).toHaveLength(0);
    expect(job.status).toBe('pending');

    mocks.tenantAdapter.queryOne.mockResolvedValueOnce({ lifecycle_state: 'suspended' });
    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', job.id);
    expect(sent.map((s) => s.url)).toEqual([RP_A]);
    expect(job.status).toBe('completed');
  });

  it('splits many ended sessions into jobs, sending the first at once', async () => {
    const env = createEnv();
    for (let i = 0; i < 12; i++) {
      await signIn(env, `session-${String(i).padStart(2, '0')}`, [[`client-${i}`, RP_A]], i);
    }
    const sent = captureDownstream();
    queueAccount('active');

    const { c, pending } = context(env);
    await adminUserLockHandler(c);
    await settle(pending);
    const jobs = [...env.DB_ADMIN.jobs.values()];
    expect(
      jobs.map((job) => (JSON.parse(job.config) as { sessions: unknown[] }).sessions.length)
    ).toEqual([10, 2]);
    expect(jobs.map((job) => job.status)).toEqual(['completed', 'pending']);
    expect(sent).toHaveLength(10);

    await processGenericAdminJobNow(env as never, mocks.logger, 'tenant-a', jobs[1].id);
    expect(sent).toHaveLength(12);
  });

  it('sends once after the response when the job cannot be kept', async () => {
    const env = createEnv();
    env.DB_ADMIN.failInserts = true;
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    queueAccount('active');

    const { c, pending } = context(env);
    expect((await adminUserSuspendHandler(c)).status).toBe(200);
    await settle(pending);
    expect(sent.map((s) => s.url)).toEqual([RP_A]);
    expect(mocks.scheduleAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.downstream_logout',
      'user-1',
      'failure',
      expect.objectContaining({ trigger_action: 'user.suspend', job_ids: [] })
    );
  });

  it('activating an account ends no session and tells no one', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    captureDownstream();
    queueAccount('active');
    const suspended = context(env);
    await adminUserSuspendHandler(suspended.c);
    await settle(suspended.pending);
    mocks.scheduleAdminAudit.mockClear();

    const sent = captureDownstream();
    queueAccount('suspended');

    const { c, pending } = context(env, { body: { reason_code: 'admin_action' } });
    expect((await adminUserActivateHandler(c)).status).toBe(200);
    await settle(pending);
    expect(sent).toHaveLength(0);
    expect(mocks.scheduleAdminAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      'user.downstream_logout',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('sends nothing when back-channel logout is disabled', async () => {
    const env = createEnv();
    mocks.resolveLogoutConfig.mockResolvedValue(config({ enabled: false }));
    await signIn(env, 'session-1', [['client-a', RP_A]]);
    const sent = captureDownstream();
    queueAccount('active');

    const { c, pending } = context(env);
    await adminUserSuspendHandler(c);
    await settle(pending);
    expect(sent).toHaveLength(0);
    expect(auditEntries('user.logout')[0].metadata).toMatchObject({ backchannel_client_ids: [] });
  });
});

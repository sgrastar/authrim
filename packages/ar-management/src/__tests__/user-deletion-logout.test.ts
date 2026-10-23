/**
 * Deleting or anonymizing a user → downstream relying parties.
 *
 * Deleting an account (DELETE /api/admin/users/:id, routed or not) and anonymizing it end the
 * user's sessions when the account moves to `deleting`. The relying parties signed in through
 * those sessions are told as on an admin suspension: the sessions the revocation ended are kept
 * as admin jobs before the response, the first job is sent after it, and each session's client
 * records are removed once every relying party was told.
 *
 * The user record is gone by the time the logout tokens are sent, so each token's sub must be
 * the one recorded with the session-client when the client's ID token was issued, never derived
 * from the user. The user's session index is the real SessionRevocationStore, the session-client
 * records the real SessionClientStore (in-memory storage), the jobs run through the real admin
 * job executor, and the logout tokens are signed with an OP key and verified here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import type { LogoutConfig, SessionClient } from '@authrim/ar-lib-core';

const OP_ISSUER = 'https://op.example.com';
const RP_A = 'https://rp-a.example.com/backchannel-logout';
const RP_B = 'https://rp-b.example.com/backchannel-logout';
const LOGOUT_URIS: Record<string, string> = { 'client-a': RP_A, 'client-b': RP_B };
const WEBHOOK_W = 'https://rp-w.example.com/logout-webhook';
const WEBHOOK_X = 'https://rp-x.example.com/logout-webhook';
/** Clients registered for the Simple Logout Webhook instead of the back-channel. */
const WEBHOOK_URIS: Record<string, string> = { 'client-w': WEBHOOK_W, 'client-x': WEBHOOK_X };

const mocks = vi.hoisted(() => ({
  /** The user records the deletion removes. */
  users: new Set<string>(),
  routed: false,
  /** The account's route refuses it: the account is not active (suspended, locked). */
  accountInactive: false,
  /** The account was left `deleting` by an anonymization that failed: the deletion lookup finds it. */
  leftDeleting: false,
  metadataRoleRemoval: vi.fn(async () => undefined),
  failUserRemoval: false,
  coreAdapter: { queryOne: vi.fn(), execute: vi.fn(), query: vi.fn(), batch: vi.fn() },
  piiAdapter: { queryOne: vi.fn(), execute: vi.fn(), query: vi.fn(), batch: vi.fn() },
  tenantAdapter: { queryOne: vi.fn(), execute: vi.fn(), query: vi.fn(), batch: vi.fn() },
  contextAudit: vi.fn(),
  audit:
    vi.fn<
      (
        env: unknown,
        entry: { action: string; userId: string; resourceId?: string; metadata: string }
      ) => Promise<void>
    >(),
  scheduleAdminAudit: vi.fn(),
  resolveLogoutConfig: vi.fn(),
  resolveLogoutWebhookConfig: vi.fn(),
  logSanitizedError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function removeUser(userId: string) {
  if (mocks.failUserRemoval) throw new Error('user removal failed');
  mocks.users.delete(userId);
  return true;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const projection = (userId: string) =>
    mocks.users.has(userId)
      ? { id: userId, tenant_id: 'tenant-a', registration_state: 'registered' }
      : null;
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getTenantMetadataContextFromHono: vi.fn(() => undefined),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    hasPIIDatabase: vi.fn(() => true),
    isDatabaseSource: vi.fn(() => true),
    // Every binding is the one in-memory adapter its test gives.
    // The tenant inventory, where a scheduled run reads the tenant's lifecycle state.
    ensureDatabaseAdapter: vi.fn((source: unknown, partition?: string) =>
      partition === 'management-generic-job-lifecycle' ? mocks.tenantAdapter : source
    ),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        passkey: { deleteByUserId: vi.fn(async () => undefined) },
        role: { removeAllRolesFromUser: mocks.metadataRoleRemoval },
      },
    })),
    // A routed account's databases: the same in-memory adapter, its own role repository.
    resolveAccountDataContextFromHono: vi.fn(async () => {
      if (mocks.accountInactive) {
        throw new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
      }
      return {};
    }),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    createPIIContextFromHono: vi.fn(() => ({
      defaultPiiAdapter: mocks.piiAdapter,
      piiRepositories: {
        tombstone: {
          findByUserId: vi.fn(async () => null),
          createTombstone: vi.fn(async (input: { id: string }) => ({
            id: input.id,
            retention_until: 1,
          })),
        },
        linkedIdentity: { deleteByUserId: vi.fn(async () => undefined) },
        identifier: { deleteByUserId: vi.fn(async () => undefined) },
      },
    })),
    CanonicalRuntimeUserStore: vi.fn(function () {
      return {
        findById: vi.fn(async (userId: string) =>
          mocks.users.has(userId) ? { id: userId, active: 1, lifecycle_state: 'active' } : null
        ),
        deleteUser: vi.fn(async (userId: string) => removeUser(userId)),
      };
    }),
    CanonicalRuntimeUserProjectionRepository: vi.fn(function () {
      return {
        findByLegacyUserId: vi.fn(async (userId: string) => projection(userId)),
        findByAccountId: vi.fn(async (accountId: string) =>
          projection(accountId.replace(/^account:/u, ''))
        ),
      };
    }),
    CanonicalRuntimeUserWriter: vi.fn(function () {
      return { deleteRuntimeUser: vi.fn(async (userId: string) => removeUser(userId)) };
    }),
    CanonicalIdentityRepository: vi.fn(function () {
      return {};
    }),
    CanonicalSensitiveValueResolver: vi.fn(function () {
      return {};
    }),
    TombstoneRepository: vi.fn(function () {
      return {
        findByUserId: vi.fn(async () => null),
        createTombstone: vi.fn(async () => ({})),
      };
    }),
    invalidateUserCache: vi.fn(async () => undefined),
    publishEvent: vi.fn(async () => undefined),
    createAuditLogFromContext: mocks.contextAudit,
    createAuditLog: mocks.audit,
    // The tenant's canonical issuer (its own tests are in ar-lib-core): the configured one here.
    resolveLogoutIssuer: vi.fn(
      async (env: Parameters<typeof actual.buildIssuerUrl>[0], tenantId: string) =>
        actual.buildIssuerUrl(env, tenantId)
    ),
    resolveLogoutConfig: mocks.resolveLogoutConfig,
    resolveLogoutWebhookConfig: mocks.resolveLogoutWebhookConfig,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.tenantAdapter),
    emitRuntimeLogRecords: vi.fn(async () => ({ tenantKey: 'tk', targetResults: [] })),
    // The clients' registrations: every recorded client is a back-channel target.
    SessionClientRepository: vi.fn(function () {
      return {
        listLogoutCandidateClientIds: vi.fn(async () => []),
        hydrateLogoutTargetsFromSessionClients: vi.fn(async (clients: SessionClient[]) => ({
          backchannelClients: clients
            .filter((client) => LOGOUT_URIS[client.client_id])
            .map((client) => ({
              ...client,
              client_name: client.client_id,
              backchannel_logout_uri: LOGOUT_URIS[client.client_id],
              backchannel_logout_session_required: true,
              frontchannel_logout_uri: null,
              frontchannel_logout_session_required: false,
            })),
          frontchannelClients: [],
          webhookClients: clients
            .filter((client) => WEBHOOK_URIS[client.client_id])
            .map((client) => ({
              ...client,
              client_name: client.client_id,
              logout_webhook_uri: WEBHOOK_URIS[client.client_id],
              // A secret stored before encryption was introduced is used as it is.
              logout_webhook_secret_encrypted: 'webhook-secret',
            })),
        })),
      };
    }),
  };
});

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return {
    ...actual,
    scheduleAdminAuditLog: mocks.scheduleAdminAudit,
    logSanitizedError: mocks.logSanitizedError,
  };
});

vi.mock('../account-legal-hold-guard', () => ({
  findActiveAccountLegalHold: vi.fn(async () => null),
}));

vi.mock('../account-directory-removal-producer', () => ({
  prepareAccountDirectoryRemoval: vi.fn(async () => []),
  eraseAccountPiiAfterDirectoryRemovalPrepared: vi.fn(async () => undefined),
  markAccountDirectoryRemovalsReady: vi.fn(async () => undefined),
  attemptImmediateAccountDirectoryRemovals: vi.fn(async () => undefined),
}));

vi.mock('../tenant-routed-storage', () => ({
  usesRoutedAccountStorage: vi.fn(() => mocks.routed),
}));

vi.mock('../cross-shard-account-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cross-shard-account-list')>();
  return {
    ...actual,
    CrossShardAccountExactSearchService: vi.fn(function () {
      return {
        // A suspended account is not found by the deletion lookup; one left deleting is.
        find: vi.fn(async ({ identifier }: { identifier: string }) =>
          mocks.accountInactive && !mocks.leftDeleting
            ? []
            : [
                {
                  id: `account:${identifier}`,
                  legacyUserId: identifier,
                  tenantId: 'tenant-a',
                  accountType: 'user',
                  lifecycleState: 'active',
                  displayLabel: null,
                  createdAt: 1,
                  coreBindingRef: 'DB',
                  piiBindingRef: 'DB_PII',
                },
              ]
        ),
      };
    }),
  };
});

import {
  DEFAULT_LOGOUT_CONFIG,
  DEFAULT_LOGOUT_WEBHOOK_CONFIG,
  SessionRevocationStore,
  listSessionClientsFromStore,
  registerSessionClientInStore,
} from '@authrim/ar-lib-core';
import { SessionClientStore } from '@authrim/ar-lib-core/durable-objects/SessionClientStore';
import { adminUserAnonymizeHandler } from '../admin';
import { adminUserDeleteHandler } from '../admin-users';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') data.set(keyOrEntries, structuredClone(value));
      else for (const [key, entry] of Object.entries(keyOrEntries)) data.set(key, entry);
    },
    delete: async (key: string | string[]) => {
      if (Array.isArray(key)) return key.filter((item) => data.delete(item)).length;
      return data.delete(key);
    },
    deleteAll: async () => data.clear(),
    list: async <T>(options?: { prefix?: string; limit?: number }) =>
      new Map(
        [...data.entries()]
          .filter(([key]) => (options?.prefix ? key.startsWith(options.prefix) : true))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, options?.limit) as [string, T][]
      ),
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    transaction: async <T>(closure: (txn: unknown) => Promise<T>) => closure(storage),
  };
  return storage;
}

/** One real Durable Object per name, as a namespace addresses them. */
function namespace<T>(create: (state: never) => T) {
  const stores = new Map<string, T>();
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => {
      const name = id.toString();
      let store = stores.get(name);
      if (!store) {
        store = create({
          storage: memoryStorage(),
          blockConcurrencyWhile: <R>(callback: () => Promise<R>) => callback(),
        } as never);
        stores.set(name, store);
      }
      return store;
    },
  };
}

function memoryKv() {
  const store = new Map<string, string>();
  return {
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
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
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
        Object.assign(at(5)!, { status: 'pending', error_message: params[0] });
      } else if (sql.includes("SET status = 'failed'")) {
        Object.assign(at(7)!, { status: 'failed', error_message: params[0] });
      }
      return { success: true, rowsAffected: 1 };
    },
  };
}

let op: { privateKey: CryptoKey; publicJwk: jose.JWK };
let opPrivatePem: string;

function createEnv() {
  return {
    ISSUER_URL: OP_ISSUER,
    RP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    SETTINGS: memoryKv(),
    SESSION_REVOCATION_STORE: namespace((state) => new SessionRevocationStore(state, {} as never)),
    SESSION_CLIENT_STORE: namespace((state) => new SessionClientStore(state, {} as never)),
    DB_ADMIN: adminJobsDb(),
    DB: mocks.coreAdapter,
    DB_PII: mocks.piiAdapter,
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

function context(env: TestEnv, body: unknown = { reason_code: 'user_request', confirm: true }) {
  const pending: Promise<unknown>[] = [];
  const c = {
    get: vi.fn((name: string) => (name === 'adminAuth' ? { userId: 'admin-1' } : undefined)),
    set: vi.fn(),
    req: {
      param: vi.fn(() => 'user-1'),
      json: vi.fn().mockResolvedValue(body),
      header: vi.fn(() => undefined),
      raw: new Request(`${OP_ISSUER}/api/admin/users/user-1`),
    },
    env,
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
    executionCtx: { waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)) },
  };
  return { c: c as never, pending };
}

async function settle(pending: Promise<unknown>[]) {
  for (let i = 0; i < pending.length; i++) await pending[i];
}

/**
 * A session the user signed in with, and the relying parties it signed in to: each client's
 * record carries the sid and the sub its ID token was issued with (a per-client sub here).
 */
async function signIn(
  env: TestEnv,
  sessionId: string,
  clientIds: string[],
  at = 0,
  options: { withoutSub?: string[] } = {}
) {
  const now = Date.now() - 60_000 + at;
  await env.SESSION_REVOCATION_STORE.get(
    env.SESSION_REVOCATION_STORE.idFromName('tenant:tenant-a:user-session:user-1')
  ).registerSessionRpc('tenant-a', 'user-1', 'account:user-1', now, sessionId, now + 3_600_000);
  for (const clientId of clientIds) {
    await registerSessionClientInStore(env as never, 'tenant-a', {
      session_id: sessionId,
      client_id: clientId,
      oidc_sid: `sid-${sessionId}-${clientId}`,
      // A record from before the sub was recorded carries none.
      ...(options.withoutSub?.includes(clientId) ? {} : { oidc_sub: `pairwise-${clientId}` }),
    });
  }
}

type Sent = { url: string; token: string; body: string; userPresent: boolean };
type FetchInput = Parameters<typeof fetch>[0];

function captureDownstream() {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: FetchInput, init?: Parameters<typeof fetch>[1]) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    sent.push({
      url,
      token: body.get('logout_token') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
      userPresent: mocks.users.has('user-1'),
    });
    return new Response(null, { status: 200 });
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

function config(): LogoutConfig {
  return {
    ...DEFAULT_LOGOUT_CONFIG,
    backchannel: {
      ...DEFAULT_LOGOUT_CONFIG.backchannel,
      retry: { ...DEFAULT_LOGOUT_CONFIG.backchannel.retry, max_attempts: 0 },
    },
  };
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

async function userIdHash(userId: string, tenantId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId + tenantId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What the session's client records hold once the deletion's work has ended. */
async function storedClients(env: TestEnv, sessionId: string) {
  return (await listSessionClientsFromStore(env as never, 'tenant-a', sessionId)) ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DELETIONS = [
  ['deleting a user', adminUserDeleteHandler, 'user.deleted', false],
  ['deleting a user in routed account storage', adminUserDeleteHandler, 'user.deleted', true],
  ['anonymizing a user', adminUserAnonymizeHandler, 'user.anonymized', false],
  [
    'anonymizing a user in routed account storage',
    adminUserAnonymizeHandler,
    'user.anonymized',
    true,
  ],
] as const;

describe('deleting or anonymizing a user notifies downstream relying parties', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (!op) {
      const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
      op = {
        privateKey: privateKey as CryptoKey,
        publicJwk: { ...(await jose.exportJWK(publicKey)), kid: 'op-key', alg: 'RS256' },
      };
      opPrivatePem = await jose.exportPKCS8(op.privateKey);
    }
    mocks.users.clear();
    mocks.users.add('user-1');
    mocks.routed = false;
    mocks.accountInactive = false;
    mocks.leftDeleting = false;
    mocks.failUserRemoval = false;
    for (const adapter of [mocks.coreAdapter, mocks.piiAdapter]) {
      adapter.queryOne.mockReset().mockResolvedValue(null);
      adapter.query.mockReset().mockResolvedValue([]);
      adapter.execute.mockReset().mockResolvedValue({ success: true, rowsAffected: 1 });
      adapter.batch
        .mockReset()
        .mockImplementation(async (statements: unknown[]) =>
          statements.map(() => ({ success: true, rowsAffected: 1 }))
        );
    }
    mocks.tenantAdapter.queryOne.mockReset().mockResolvedValue({ lifecycle_state: 'active' });
    mocks.audit.mockResolvedValue(undefined);
    mocks.contextAudit.mockResolvedValue(undefined);
    mocks.resolveLogoutConfig.mockResolvedValue(config());
    mocks.resolveLogoutWebhookConfig.mockResolvedValue(DEFAULT_LOGOUT_WEBHOOK_CONFIG);
  });

  it.each(DELETIONS)(
    '%s sends each relying party of each session its own logout token',
    async (_name, handler, triggerAction, routed) => {
      mocks.routed = routed;
      const env = createEnv();
      await signIn(env, 'session-1', ['client-a', 'client-b']);
      await signIn(env, 'session-2', ['client-a'], 1);
      const sent = captureDownstream();

      const { c, pending } = context(env);
      const response = await handler(c);
      expect(response.status).toBe(200);
      expect(mocks.users.has('user-1')).toBe(false);
      // Nothing is sent before the admin response.
      expect(sent).toHaveLength(0);
      await settle(pending);

      expect(sent.map((s) => s.url).sort()).toEqual([RP_A, RP_A, RP_B]);
      // Sent after the user record was removed.
      expect(sent.every((s) => !s.userPresent)).toBe(true);
      const claims = await Promise.all(sent.map((s) => verified(s.token)));
      expect(claims.map((claim) => [claim.aud, claim.sid, claim.sub]).sort()).toEqual([
        ['client-a', 'sid-session-1-client-a', 'pairwise-client-a'],
        ['client-a', 'sid-session-2-client-a', 'pairwise-client-a'],
        ['client-b', 'sid-session-1-client-b', 'pairwise-client-b'],
      ]);
      for (const claim of claims) {
        // The sub the client's ID token carried, never the user's internal id.
        expect(JSON.stringify(claim)).not.toContain('user-1');
        expect(claim.events).toEqual({ 'http://schemas.openid.net/event/backchannel-logout': {} });
      }

      // The job holding the sessions ran to its end, and the records it read are removed.
      expect([...env.DB_ADMIN.jobs.values()].map((job) => job.status)).toEqual(['completed']);
      expect(JSON.parse([...env.DB_ADMIN.jobs.values()][0].config)).toMatchObject({
        trigger: { action: triggerAction, actorId: 'admin-1' },
      });
      expect(await storedClients(env, 'session-1')).toEqual([]);
      expect(await storedClients(env, 'session-2')).toEqual([]);
      expect(mocks.logSanitizedError).not.toHaveBeenCalled();
    }
  );

  it.each(DELETIONS)(
    '%s sends each webhook client the sub recorded for it, never the internal id',
    async (_name, handler, _triggerAction, routed) => {
      mocks.routed = routed;
      mocks.resolveLogoutWebhookConfig.mockResolvedValue({
        ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
        enabled: true,
        include_sub_claim: true,
        include_sid_claim: false,
      });
      const env = createEnv();
      await signIn(env, 'session-1', ['client-w', 'client-x'], 0, { withoutSub: ['client-x'] });
      const sent = captureDownstream();

      const { c, pending } = context(env);
      expect((await handler(c)).status).toBe(200);
      await settle(pending);

      const payloads = new Map(
        sent.map((s) => [s.url, JSON.parse(s.body) as Record<string, unknown>])
      );
      expect([...payloads.keys()].sort()).toEqual([WEBHOOK_W, WEBHOOK_X]);
      expect(sent.every((s) => !s.userPresent)).toBe(true);
      // The sub the client's ID token carried.
      expect(payloads.get(WEBHOOK_W)).toMatchObject({
        issuer: OP_ISSUER,
        client_id: 'client-w',
        sub: 'pairwise-client-w',
      });
      // No sub recorded: none is sent, and the session is named by its sid instead.
      expect(payloads.get(WEBHOOK_X)).not.toHaveProperty('sub');
      expect(payloads.get(WEBHOOK_X)).toMatchObject({
        client_id: 'client-x',
        sid: 'sid-session-1-client-x',
      });
      for (const s of sent) expect(s.body).not.toContain('user-1');
      expect(await storedClients(env, 'session-1')).toEqual([]);
    }
  );

  it('a deletion records the downstream logout in the admin and tenant audits', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', ['client-a', 'client-b']);
    captureDownstream();

    const { c, pending } = context(env);
    await adminUserDeleteHandler(c);
    await settle(pending);

    expect(mocks.scheduleAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.downstream_logout',
      'user-1',
      'success',
      expect.objectContaining({
        trigger_action: 'user.deleted',
        operation_id: expect.any(String),
        user_count: 1,
        session_count: 1,
        job_ids: [expect.any(String)],
      })
    );
    const logouts = auditEntries('user.logout');
    expect(logouts.map((entry) => entry.resourceId)).toEqual(['session-1']);
    expect(logouts[0]).toMatchObject({ userId: 'user-1' });
    expect(logouts[0].metadata).toMatchObject({
      reason: 'admin_session_end',
      trigger_action: 'user.deleted',
      actor_id: 'admin-1',
      backchannel_client_ids: ['client-a', 'client-b'],
    });
  });

  it('an anonymization names the user in the audits by its hash only', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', ['client-a']);
    captureDownstream();
    const hash = await userIdHash('user-1', 'tenant-a');

    const { c, pending } = context(env);
    await adminUserAnonymizeHandler(c);
    await settle(pending);

    expect(mocks.scheduleAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.downstream_logout',
      hash,
      'success',
      expect.objectContaining({ trigger_action: 'user.anonymized', session_count: 1 })
    );
    const logouts = auditEntries('user.logout');
    expect(logouts).toHaveLength(1);
    expect(logouts[0]).toMatchObject({ userId: hash });
    // Every audit record of the downstream logout (the tenant audit's entries are all its own).
    expect(mocks.audit).toHaveBeenCalled();
    for (const [, entry] of mocks.audit.mock.calls) {
      expect(JSON.stringify(entry)).not.toContain('user-1');
    }
    const adminAudits = mocks.scheduleAdminAudit.mock.calls.filter(
      ([, action]) => action === 'user.downstream_logout'
    );
    expect(adminAudits).toHaveLength(1);
    expect(JSON.stringify(adminAudits[0].slice(1))).not.toContain('user-1');

    // The anonymization's own audits too: the tombstone (keyed by the user id) by the same hash.
    expect(mocks.contextAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.anonymized',
      'user',
      hash,
      expect.objectContaining({ tombstone_id: hash })
    );
    expect(mocks.scheduleAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.anonymized',
      hash,
      'success',
      expect.objectContaining({ tombstone_id: hash })
    );
    for (const call of [
      ...mocks.contextAudit.mock.calls,
      ...mocks.scheduleAdminAudit.mock.calls.map((args) => args.slice(1)),
    ]) {
      expect(JSON.stringify(call.slice(1))).not.toContain('user-1');
    }
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain('user-1');
  });

  it.each(DELETIONS)(
    '%s that fails after the sessions ended still tells their relying parties',
    async (_name, handler, _triggerAction, routed) => {
      mocks.routed = routed;
      mocks.failUserRemoval = true;
      const env = createEnv();
      await signIn(env, 'session-1', ['client-a']);
      const sent = captureDownstream();

      const { c, pending } = context(env);
      const response = await handler(c);
      expect(response.status).toBe(500);
      await settle(pending);

      expect(sent.map((s) => s.url)).toEqual([RP_A]);
      expect((await verified(sent[0].token)).sub).toBe('pairwise-client-a');
    }
  );

  it('a deletion retried after its sessions ended does not tell them again', async () => {
    const env = createEnv();
    await signIn(env, 'session-1', ['client-a']);
    mocks.failUserRemoval = true;
    captureDownstream();
    const first = context(env);
    await adminUserDeleteHandler(first.c);
    await settle(first.pending);

    mocks.failUserRemoval = false;
    // A retry comes later than the attempt it retries (the lifecycle versions are milliseconds).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sent = captureDownstream();
    const { c, pending } = context(env);
    const response = await adminUserDeleteHandler(c);
    expect(response.status).toBe(200);
    await settle(pending);

    expect(sent).toEqual([]);
  });
  it("anonymizing a routed user removes its roles and memberships in the account's database", async () => {
    mocks.routed = true;
    const env = createEnv();
    const { c } = context(env);
    expect((await adminUserAnonymizeHandler(c)).status).toBe(200);
    const statements = mocks.coreAdapter.execute.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain(
      'DELETE FROM role_assignments WHERE tenant_id = ? AND subject_id = ?'
    );
    expect(statements).toContain(
      'DELETE FROM subject_org_membership WHERE tenant_id = ? AND subject_id = ?'
    );
    // Its SCIM roles, in the account's database and in the metadata database SCIM keeps them in.
    expect(statements).toContain('DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ?');
    expect(mocks.metadataRoleRemoval).toHaveBeenCalledWith('user-1');
  });

  it('finishes anonymizing a routed account a failed anonymization left deleting', async () => {
    mocks.routed = true;
    mocks.accountInactive = true;
    mocks.leftDeleting = true;
    const env = createEnv();
    const { c } = context(env);
    expect((await adminUserAnonymizeHandler(c)).status).toBe(200);
    expect(mocks.users.has('user-1')).toBe(false);
    const statements = mocks.coreAdapter.execute.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain(
      'DELETE FROM role_assignments WHERE tenant_id = ? AND subject_id = ?'
    );
  });

  it('refuses to anonymize a routed account that is not active, changing nothing', async () => {
    mocks.routed = true;
    mocks.accountInactive = true;
    const env = createEnv();
    const { c } = context(env);
    const response = await adminUserAnonymizeHandler(c);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'account_not_active' });
    expect(mocks.users.has('user-1')).toBe(true);
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalled();
  });
});

/**
 * Device flow and CIBA approval with the real browser-session check and account routing.
 *
 * Nothing on the authentication path is mocked: the session id is parsed and routed to the
 * SessionStore namespace, the session's user is resolved to its account through the signed
 * runtime registry and lookup directory, and the user and its consent withdrawals are read from
 * the account's own core database (a real SQLite database built from migrations/core). Only the
 * lookup HMAC/bucket plumbing is stubbed, as in ar-lib-core's runtime-data-context tests, and
 * Durable Objects other than UserCodeRateLimiter are in-memory fakes.
 *
 * The tenant metadata database (DB) holds no users: an authentication that read the user from
 * it (as getAuthenticatedAsyncUser did before account routing) is refused with 401.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('../../packages/ar-lib-core/src/services/lookup-directory', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../packages/ar-lib-core/src/services/lookup-directory')
    >();
  return {
    ...original,
    createLookupBlindIndexes: vi.fn(async () => [
      {
        indexKind: 'account_id',
        normalizationVersion: 1,
        hmacKeyGeneration: 1,
        digest: 'a'.repeat(64),
        virtualBucket: 42,
      },
    ]),
    loadVerifiedLookupHmacKeyState: vi.fn(async () => ({})),
    resolveLookupHmacKeys: vi.fn(async () => ({ readKeys: [{}], writeKeys: [{}] })),
    loadVerifiedLookupBucketAssignmentProvider: vi.fn(async () => ({
      resolveActiveAssignment: vi.fn(async () => ({
        virtualBucket: 42,
        assignmentGeneration: 1,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
        state: 'active',
      })),
    })),
  };
});

import {
  clearLookupRouteMemoryCache,
  clearTenantDatabaseResolverMemoryCache,
  signTenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';
import { UserCodeRateLimiter } from '../../packages/ar-lib-core/src/durable-objects/UserCodeRateLimiter';
import { CIBARequestStore } from '../../packages/ar-lib-core/src/durable-objects/CIBARequestStore';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability';
import { deviceLookupApiHandler } from '../../packages/ar-async/src/device-lookup-api';
import { deviceVerifyApiHandler } from '../../packages/ar-async/src/device-verify-api';
import { cibaApproveHandler } from '../../packages/ar-async/src/ciba-approve';
import { cibaPendingHandler } from '../../packages/ar-async/src/ciba-pending';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TENANT = 'tenant-a';
const USER_ID = 'user-a';
const SESSION_ID = 'g1:apac:0:session_abc123';
const CORE_BINDING = 'TEST_TDB_USERS_A';
const PII_BINDING = 'TEST_TDB_PII_A';

// ---------------------------------------------------------------------------------------------
// D1 over node:sqlite
// ---------------------------------------------------------------------------------------------

type SqlValue = string | number | null | Uint8Array;

function bindValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value as SqlValue;
  });
}

function statement(db: DatabaseSync, sql: string) {
  let values: SqlValue[] = [];
  let prepared: StatementSync | null = null;
  const get = () => (prepared ??= db.prepare(sql));
  const bound = {
    bind(...args: unknown[]) {
      values = bindValues(args);
      return bound;
    },
    async first<T>(column?: string): Promise<T | null> {
      const row = (get().get(...values) as Record<string, unknown> | undefined) ?? null;
      if (row && column) return (row[column] as T) ?? null;
      return (row as T) ?? null;
    },
    async all<T>() {
      return { success: true, results: get().all(...values) as T[], meta: {} };
    },
    async run() {
      const result = get().run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
    async raw<T>() {
      get().setReturnArrays(true);
      return get().all(...values) as T[];
    },
  };
  return bound;
}

function d1(db: DatabaseSync): D1Database {
  const api = {
    prepare: (sql: string) => statement(db, sql),
    batch: async (statements: Array<{ all(): Promise<unknown> }>) =>
      Promise.all(statements.map((entry) => entry.all())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: vi.fn(),
  };
  return {
    ...api,
    withSession: () => ({ ...api, getBookmark: () => 'bookmark' }),
  } as unknown as D1Database;
}

function migrated(dir: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const folder = path.join(REPO_ROOT, 'migrations', dir, 'd1');
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(path.join(folder, file), 'utf8'), 'sqlite'));
  }
  return db;
}

function shardMetadata(db: DatabaseSync, bindingRef: string, dataRole: string) {
  db.prepare(
    `INSERT INTO authrim_control_plane_shard_metadata (
       singleton_id, binding_ref, data_role, residency_partition, migration_generation,
       release_id, manifest_digest, expected_file_count, last_filename, updated_at
     ) VALUES (1, ?, ?, 'default', 1, 'test', ?, 1, 'test.sql', 1)`
  ).run(bindingRef, dataRole, '0'.repeat(64));
}

// ---------------------------------------------------------------------------------------------
// Account routing fixtures (signed runtime registry + lookup directory row)
// ---------------------------------------------------------------------------------------------

let signedSnapshot = '';
let publicJwks = '';

function storeEntry(dataRole: 'tenant_core/users' | 'tenant_pii', bindingRef: string) {
  return {
    tenantId: TENANT,
    role: dataRole === 'tenant_pii' ? 'tenant_pii' : 'tenant_core',
    dataRole,
    residencyPolicyId: 'default-policy',
    residencyPartition: 'default',
    shardId: dataRole === 'tenant_pii' ? 'pii-a' : 'users-a',
    assignmentGeneration: 1,
    bindingRouteGeneration: dataRole === 'tenant_pii' ? 9 : 8,
    placementPolicyGeneration: 1,
    allocationScope: 'tenant_exclusive',
    ownerTenantId: TENANT,
    generation: dataRole === 'tenant_pii' ? 9 : 8,
    runtimeGeneration: 7,
    schemaVersion: 1,
    shardGroup: 'default',
    shardIndex: 0,
    shardCount: 1,
    shardKeyStrategy: 'none',
    provider: 'd1',
    driver: 'd1',
    bindingRef,
    connectionRef: null,
    deploymentTarget: null,
    status: 'active',
    healthStatus: 'active',
    databaseId: `${bindingRef}-id`,
    databaseName: bindingRef,
    regionHint: null,
    jurisdiction: null,
  } as const;
}

function lookupRow() {
  return {
    virtual_bucket: 42,
    index_kind: 'account_id',
    normalization_version: 1,
    hmac_key_generation: 1,
    identifier_blind_digest: 'a'.repeat(64),
    tenant_id: TENANT,
    account_id: `account:${USER_ID}`,
    route_schema_version: 1,
    account_route_generation: 3,
    required_binding_route_generation: 9,
    residency_policy_id: 'default-policy',
    route_projection_json: JSON.stringify({
      schemaVersion: 1,
      accountRouteGeneration: 3,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-a',
          bindingRef: CORE_BINDING,
          requiredBindingRouteGeneration: 8,
        },
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-a',
          bindingRef: PII_BINDING,
          requiredBindingRouteGeneration: 9,
        },
      ],
    }),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

/** The lookup directory shard: answers the account-id route query with the account's row. */
function lookupDirectory(): D1Database {
  const statementApi = {
    bind: () => statementApi,
    all: async () => ({ success: true, results: [lookupRow()], meta: {} }),
    first: async () => lookupRow(),
    run: async () => ({ success: true, results: [], meta: {} }),
  };
  const api = { prepare: () => statementApi, batch: vi.fn() };
  return {
    ...api,
    withSession: () => ({ ...api, getBookmark: () => 'bookmark' }),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------------------------
// Durable Objects
// ---------------------------------------------------------------------------------------------

function namespace<T>(create: (name: string) => T) {
  const instances = new Map<string, T>();
  return {
    idFromName: (name: string) => ({ name, toString: () => name }),
    idFromString: (name: string) => ({ name, toString: () => name }),
    jurisdiction() {
      return this;
    },
    get(id: { name: string }) {
      if (!instances.has(id.name)) instances.set(id.name, create(id.name));
      return instances.get(id.name)!;
    },
  };
}

function storage() {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    delete: async (key: string) => data.delete(key),
    setAlarm: async () => {},
  };
}

interface DeviceRecord {
  device_code: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: number;
  expires_at: number;
  user_id?: string;
  sub?: string;
  consent_generation?: number;
}

const devices = new Map<string, DeviceRecord>();
/** Durable Storage of the tenant's CIBARequestStore, shared by every instance a test creates. */
let cibaStorage = memoryStorage();

function deviceStore() {
  return {
    async fetch(request: Request) {
      const route = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      const record = devices.get(String(body.user_code));
      if (route === '/get-by-user-code') return Response.json(record ?? null);
      if (!record) return Response.json({ error: 'not_found' }, { status: 404 });
      if (route === '/approve') {
        Object.assign(record, {
          status: 'approved',
          user_id: body.user_id,
          sub: body.sub,
          consent_generation: body.consent_generation,
        });
      } else if (route === '/deny') {
        record.status = 'denied';
      }
      return Response.json({ success: true });
    },
  };
}

/** In-memory Durable Storage: sorted list with limit/startAfter, multi-key get/put/delete. */
function memoryStorage() {
  const data = new Map<string, unknown>();
  const batch = (count: number) => {
    if (count > 128) throw new RangeError('Durable Storage batch exceeds 128 keys');
  };
  return {
    data,
    get: async (key: string | string[]) => {
      if (!Array.isArray(key)) return data.get(key);
      batch(key.length);
      return new Map(
        key.filter((entry) => data.has(entry)).map((entry) => [entry, data.get(entry)])
      );
    },
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      const entries = typeof key === 'string' ? [[key, value] as const] : Object.entries(key);
      batch(entries.length);
      for (const [entryKey, entryValue] of entries) {
        data.set(entryKey, structuredClone(entryValue));
      }
    },
    delete: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      batch(list.length);
      return list.map((key) => data.delete(key)).some(Boolean);
    },
    list: async (options?: { prefix?: string; limit?: number; startAfter?: string }) => {
      const keys = [...data.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .filter((key) => options?.startAfter === undefined || key > options.startAfter)
        .sort()
        .slice(0, options?.limit);
      return new Map(keys.map((key) => [key, data.get(key)]));
    },
    setAlarm: async () => {},
    getAlarm: async () => null,
  };
}

/** The real CIBARequestStore Durable Object over the shared in-memory Durable Storage. */
function cibaStore() {
  return new CIBARequestStore(
    {
      storage: cibaStorage,
      blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
    } as unknown as DurableObjectState,
    {} as unknown as Env
  );
}

async function storeCibaRequest(overrides: Record<string, unknown>) {
  const now = Date.now();
  await cibaStore().fetch(
    new Request('https://internal/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': TENANT },
      body: JSON.stringify({
        tenant_id: TENANT,
        client_id: 'client-1',
        scope: 'openid',
        status: 'pending',
        delivery_mode: 'poll',
        created_at: now - 5_000,
        expires_at: now + 300_000,
        poll_count: 0,
        interval: 5,
        token_issued: false,
        ...overrides,
      }),
    })
  );
}

function cibaRequest(authReqId: string) {
  return cibaStorage.data.get(`r:${authReqId}`) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------------------------
// Environment and app
// ---------------------------------------------------------------------------------------------

/** The tenant metadata database: the schema, but no users and no consent withdrawals. */
let metadata: DatabaseSync;
let core: DatabaseSync;
let pii: DatabaseSync;
let sessionExpiresAt: number;

function createEnv(): Env {
  const registry = {
    get: vi.fn(async (key: string) =>
      key.includes(':runtime-registry:generation:')
        ? JSON.stringify({
            runtimeGeneration: 7,
            routeStatus: 'active',
            quarantineDenyGeneration: 0,
            publishedAt: '2026-05-16T00:00:00.000Z',
            expiresAt: '2099-05-23T00:00:00.000Z',
          })
        : signedSnapshot
    ),
  };
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY: registry,
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: publicJwks,
    LOOKUP_HMAC_KEY_SLOT_A: 'secret-a',
    LOOKUP_A: lookupDirectory(),
    [CORE_BINDING]: d1(core),
    [PII_BINDING]: d1(pii),
    DB: d1(metadata),
    SESSION_STORE: namespace(() => ({
      getSessionRpc: async (sessionId: string) =>
        sessionId === SESSION_ID
          ? { id: SESSION_ID, userId: USER_ID, expiresAt: sessionExpiresAt, data: {} }
          : null,
    })),
    USER_CODE_RATE_LIMITER: namespace(
      () =>
        new UserCodeRateLimiter(
          { storage: storage() } as unknown as DurableObjectState,
          {} as unknown as Env
        )
    ),
    DEVICE_CODE_STORE: namespace(deviceStore),
    CIBA_REQUEST_STORE: namespace(cibaStore),
    RATE_LIMITER: namespace(() => ({
      incrementRpc: async () => ({ allowed: true, limit: 10, current: 1, resetAt: 0 }),
    })),
  } as unknown as Env;
}

function createApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    // What requestContextMiddleware sets for the tenant: its id and its metadata database.
    const vars = c as unknown as { set(key: string, value: unknown): void };
    vars.set('tenantId', TENANT);
    vars.set('tenantMetadataContext', { tenantId: TENANT, coreDb: env.DB });
    await next();
  });
  app.post('/api/devices/lookup', deviceLookupApiHandler);
  app.post('/api/devices/verify', deviceVerifyApiHandler);
  app.post('/api/ciba/approve', cibaApproveHandler);
  app.get('/api/ciba/pending', cibaPendingHandler);
  return app;
}

async function post(
  env: Env,
  route: string,
  body: unknown,
  cookie = `authrim_session=${SESSION_ID}`
) {
  const response = await createApp(env).request(
    `https://auth.example.com${route}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.20',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getPending(env: Env, query = '', cookie = `authrim_session=${SESSION_ID}`) {
  const response = await createApp(env).request(
    `https://auth.example.com/api/ciba/pending${query}`,
    { headers: cookie ? { Cookie: cookie } : {} },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  for (const jwk of [privateJwk, publicJwk]) {
    Object.assign(jwk, { kid: 'runtime-registry-key-1', alg: 'EdDSA', use: 'sig' });
  }
  const snapshot = await signTenantRuntimeRegistrySnapshot(
    {
      version: 4,
      tenantId: TENANT,
      snapshotScope: 'tenant',
      deploymentTarget: 'default',
      runtimeGeneration: 7,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
      publishedAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2099-05-16T00:30:00.000Z',
      stores: [
        storeEntry('tenant_core/users', CORE_BINDING),
        storeEntry('tenant_pii', PII_BINDING),
      ],
      metadata: {
        storeCount: 2,
        roles: ['tenant_core', 'tenant_pii'],
        signature: null,
        signatureKeyId: null,
        signatureAlgorithm: null,
        signedAt: null,
      },
    },
    { privateJwk, keyId: 'runtime-registry-key-1' },
    '2026-05-16T00:00:00.000Z'
  );
  signedSnapshot = JSON.stringify(snapshot);
  publicJwks = JSON.stringify({ keys: [publicJwk] });

  metadata = migrated('core');
  core = migrated('core');
  pii = migrated('pii');
  shardMetadata(core, CORE_BINDING, 'tenant_core/users');
  shardMetadata(pii, PII_BINDING, 'tenant_pii');
});

beforeEach(async () => {
  clearLookupRouteMemoryCache();
  clearTenantDatabaseResolverMemoryCache();
  devices.clear();
  cibaStorage = memoryStorage();
  sessionExpiresAt = Date.now() + 60_000;

  core.exec(
    `DELETE FROM oauth_client_consent_revocations;
     DELETE FROM identity_accounts;
     DELETE FROM identity_subjects;`
  );
  core
    .prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, created_at, updated_at)
       VALUES ('subject-a', ?, 'person', 'active', 1, 1)`
    )
    .run(TENANT);
  core
    .prepare(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, legacy_user_id, primary_subject_id,
         created_at, updated_at, directory_publication_state, account_route_generation
       ) VALUES (?, ?, 'end_user', 'active', ?, 'subject-a', 1, 1, 'active', 3)`
    )
    .run(`account:${USER_ID}`, TENANT, USER_ID);

  const now = Date.now();
  devices.set('WDJB-MJHT', {
    device_code: 'device-1',
    user_code: 'WDJB-MJHT',
    client_id: 'client-1',
    scope: 'openid profile',
    status: 'pending',
    created_at: now - 5_000,
    expires_at: now + 600_000,
  });
  await storeCibaRequest({ auth_req_id: 'auth-req-1', login_hint: `sub:${USER_ID}` });
});

describe('device and CIBA approval with the account-routed browser session', () => {
  it('looks a device code up for the signed-in account', async () => {
    const response = await post(createEnv(), '/api/devices/lookup', { user_code: 'wdjbmjht' });

    expect(response).toMatchObject({
      status: 200,
      body: { client_id: 'client-1', scopes: ['openid', 'profile'] },
    });
  });

  it("approves a device code as the session's account, under its consent generation", async () => {
    core
      .prepare(
        `INSERT INTO oauth_client_consent_revocations (tenant_id, user_id, client_id, generation, revoked_at)
         VALUES (?, ?, 'client-1', 4, ?)`
      )
      .run(TENANT, USER_ID, Date.now() - 60_000);

    const response = await post(createEnv(), '/api/devices/verify', {
      user_code: 'WDJB-MJHT',
      approve: true,
      user_id: 'victim',
    });

    expect(response).toEqual({
      status: 200,
      body: { success: true, message: 'Device authorized successfully' },
    });
    expect(devices.get('WDJB-MJHT')).toMatchObject({
      status: 'approved',
      user_id: USER_ID,
      sub: USER_ID,
      consent_generation: 4,
    });
  });

  it('refuses a device code requested before the account withdrew the consent', async () => {
    core
      .prepare(
        `INSERT INTO oauth_client_consent_revocations (tenant_id, user_id, client_id, generation, revoked_at)
         VALUES (?, ?, 'client-1', 1, ?)`
      )
      .run(TENANT, USER_ID, Date.now());

    const response = await post(createEnv(), '/api/devices/verify', { user_code: 'WDJB-MJHT' });

    expect(response).toMatchObject({ status: 400, body: { error: 'consent_withdrawn' } });
    expect(devices.get('WDJB-MJHT')?.status).toBe('pending');
  });

  it("approves a CIBA request addressed to the session's account", async () => {
    const response = await post(createEnv(), '/api/ciba/approve', { auth_req_id: 'auth-req-1' });

    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(cibaRequest('auth-req-1')).toMatchObject({
      status: 'approved',
      user_id: USER_ID,
      sub: USER_ID,
    });
  });

  it("lists every pending CIBA request addressed to the session's account", async () => {
    await storeCibaRequest({
      auth_req_id: 'auth-req-other-client',
      client_id: 'client-2',
      login_hint: USER_ID,
    });
    await storeCibaRequest({ auth_req_id: 'auth-req-not-mine', login_hint: 'sub:someone-else' });
    await storeCibaRequest({ auth_req_id: 'auth-req-resolved', resolved_subject_id: USER_ID });

    const response = await getPending(createEnv());

    expect(response.status).toBe(200);
    const requests = response.body.requests as Array<Record<string, unknown>>;
    expect(requests.map((request) => request.auth_req_id).sort()).toEqual([
      'auth-req-1',
      'auth-req-other-client',
      'auth-req-resolved',
    ]);
    // Epoch milliseconds, as the store keeps them.
    expect(requests[0].expires_at).toBeGreaterThan(Date.now());
  });

  it('does not let the signed-in account list requests addressed to someone else', async () => {
    await storeCibaRequest({ auth_req_id: 'auth-req-not-mine', login_hint: 'sub:someone-else' });

    const response = await getPending(createEnv(), '?user_id=someone-else');

    expect(response.status).toBe(403);
  });

  it('lists nothing without a session', async () => {
    const response = await getPending(createEnv(), '', '');

    expect(response.status).toBe(401);
  });

  it('refuses a CIBA request addressed to another account', async () => {
    await storeCibaRequest({ auth_req_id: 'auth-req-2', login_hint: 'sub:someone-else' });

    const response = await post(createEnv(), '/api/ciba/approve', { auth_req_id: 'auth-req-2' });

    expect(response.status).toBe(403);
    expect(cibaRequest('auth-req-2')?.status).toBe('pending');
  });

  describe('without an authenticated account', () => {
    it.each([
      ['no session cookie', () => {}, ''],
      [
        'an expired session',
        () => {
          sessionExpiresAt = Date.now() - 1;
        },
        undefined,
      ],
      [
        'an account that is no longer active',
        () => {
          core.prepare(`UPDATE identity_accounts SET lifecycle_state = 'disabled'`).run();
        },
        undefined,
      ],
    ])('refuses the decisions for %s', async (_label, arrange, cookie) => {
      arrange();
      const env = createEnv();

      const lookup = await post(env, '/api/devices/lookup', { user_code: 'WDJB-MJHT' }, cookie);
      const device = await post(env, '/api/devices/verify', { user_code: 'WDJB-MJHT' }, cookie);
      const ciba = await post(env, '/api/ciba/approve', { auth_req_id: 'auth-req-1' }, cookie);

      expect([lookup.status, device.status, ciba.status]).toEqual([401, 401, 401]);
      expect(devices.get('WDJB-MJHT')?.status).toBe('pending');
      expect(cibaRequest('auth-req-1')?.status).toBe('pending');
    });
  });
});

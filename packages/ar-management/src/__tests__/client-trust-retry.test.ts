import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  ClientRepository,
  idempotencyMiddleware,
  issueAdminStepUpReceipt,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';

const seams = vi.hoisted(() => ({
  context: vi.fn(),
  adapter: null as DatabaseAdapter | null,
  challenges: new Map<string, Record<string, unknown>>(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: seams.context,
  requireAdminDatabaseAdapter: () => seams.adapter,
  ensureAdminDatabaseAdapter: () => seams.adapter,
  createAuditLogFromContext: vi.fn(),
  invalidateClientCache: vi.fn(),
  invalidateWebOriginRegistryCache: vi.fn(),
  publishEvent: vi.fn(async () => undefined),
}));
vi.mock('../redirect-uri-policy', () => ({
  redirectUriRefusedByPolicy: async () => null,
  REDIRECT_URI_POLICY_DESCRIPTION: '',
}));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  scheduleAdminAuditLog: vi.fn(),
}));
import { adminClientRegenerateSecretHandler, adminClientUpdateHandler } from '../admin-clients';
import { adminIdentityMappingHistoryRestoreHandler } from '../identity-mapping-history';

let store: ReturnType<typeof openCoreStore>;
let repository: ClientRepository;
let app: Hono<{ Bindings: Env; Variables: { tenantId: string; adminAuth: AdminAuthContext } }>;
let auth: AdminAuthContext;
const env = {
  CLIENTS_CACHE: { delete: async () => undefined },
  AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
  AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY: 'true',
  AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'test-generation',
  AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
  AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: '2026-01-01T00:00:00.000Z',
  AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
  AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
  ISSUER_URL: 'http://localhost:8787',
  OBJECT_ENCRYPTION_ROOT_KEY: 'ab'.repeat(32),
  LOG_ARCHIVE_CONTENT_HMAC_KEY: 'cd'.repeat(32),
  LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
    schema_version: 1,
    current_version: 1,
    roots: { 1: 'ab'.repeat(32) },
  }),
  LOG_ARCHIVE_WRITER: { resolveTenantKey: async () => 'tenant-key-a' },
  SETTINGS: { get: async () => null },
  CHALLENGE_STORE: {
    idFromName: (name: string) => name,
    get: () => ({
      storeChallengeRpc: async (request: Record<string, unknown>) => {
        seams.challenges.set(String(request.id), { ...request, expiresAt: Date.now() + 300000 });
      },
      getChallengeRpc: async (id: string) => seams.challenges.get(id) ?? null,
      consumeChallengeRpc: async ({ id }: { id: string }) => {
        const record = seams.challenges.get(id);
        if (!record) throw new Error('missing');
        seams.challenges.delete(id);
        return record;
      },
    }),
  },
} as unknown as Env;
beforeEach(async () => {
  store = openCoreStore();
  seams.adapter = store.adapter;
  env.DB_ADMIN = store.adapter as unknown as NonNullable<Env['DB_ADMIN']>;
  store.db
    .exec(`CREATE TABLE admin_second_factors (id TEXT, admin_user_id TEXT, revoked_at INTEGER);
    INSERT INTO admin_second_factors VALUES ('factor','admin',NULL)`);
  seams.challenges.clear();
  const baseline = readFileSync(
    new URL('../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql', import.meta.url),
    'utf8'
  );
  // The restore writes its business ledger and encrypted log in the same adapter batch.
  for (const match of baseline.matchAll(
    /CREATE TABLE (identity_mapping_level_history|log_iceberg_\w+) \([\s\S]*?\n\)(?: STRICT)?;/g
  )) {
    const exists = await store.adapter.queryOne(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [match[1]]
    );
    if (!exists) store.db.exec(match[0]);
  }
  repository = new ClientRepository(store.adapter, 'tenant-a');
  seams.context.mockReturnValue({
    coreAdapter: store.adapter,
    repositories: { client: repository },
  });
  auth = {
    userId: 'admin',
    actorType: 'human',
    authMethod: 'session',
    tenantId: 'tenant-a',
    sessionTenantId: 'default',
    sessionId: 'session',
    roles: [ADMIN_ROLES.SUPER_ADMIN],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_UPDATE],
    mfaVerified: true,
    authenticationTimeMs: Date.now(),
    secondFactorId: 'factor',
    secondFactorVerifiedAtMs: Date.now(),
  };
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    c.set('adminAuth', auth);
    c.set(
      'tenantMetadataContext' as never,
      { tenantId: 'tenant-a', coreDb: store.adapter, route: {} } as never
    );
    await next();
  });
  app.use(
    '*',
    idempotencyMiddleware({ reserveBeforeExecution: true, failClosedOnStorageError: true })
  );
  app.put('/clients/:id', adminClientUpdateHandler);
  app.post('/clients/:id/rotate', adminClientRegenerateSecretHandler);
  app.post('/history/:id/restore', adminIdentityMappingHistoryRestoreHandler);
  await repository.create({
    client_id: 'app',
    client_name: 'App',
    enabled: true,
    redirect_uris: ['https://app.example/cb'],
    client_secret_hash: 'synthetic',
    require_pkce: true,
    identity_mapping: { mode: 'none' },
  });
});
afterEach(() => store.db.close());

function request(path: string, method: string, body: object, receipt?: string) {
  return app.request(
    path,
    {
      method,
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'same-operation',
        ...(receipt ? { 'authrim-step-up-receipt': receipt } : {}),
      },
      body: JSON.stringify(body),
    },
    env
  );
}
async function approve(response: Response) {
  expect(response.status, await response.clone().text()).toBe(403);
  const { step_up_id } = await response.json<{ step_up_id: string }>();
  return (
    await issueAdminStepUpReceipt(env, {
      auth,
      stepUpId: step_up_id,
      isSecondFactorActive: async () => true,
    })
  ).receipt;
}

describe('client routes with the real gate and idempotency middleware', () => {
  it('retries an origin-only update and rejects evidence after another configuration write', async () => {
    const body = { web_origin_registry: { origins: ['https://app.example'] } };
    const before = await repository.findByClientId('app');
    const proof = await approve(await request('/clients/app', 'PUT', body));
    expect(await repository.findByClientId('app')).toEqual(before);
    expect(await store.adapter.query('SELECT * FROM web_origin_registry')).toEqual([]);
    await repository.update('app', { scope: 'email' });
    const nextProof = await approve(await request('/clients/app', 'PUT', body, proof));
    expect((await request('/clients/app', 'PUT', body, nextProof)).status).toBe(200);
    expect(await store.adapter.query('SELECT origin FROM web_origin_registry')).toEqual([
      { origin: 'https://app.example' },
    ]);
  });
  it('rotates once after the approved retry, preserving the successful response', async () => {
    const before = (await repository.findByClientId('app'))!;
    const proof = await approve(await request('/clients/app/rotate', 'POST', {}));
    expect((await repository.findByClientId('app'))!.client_secret_hash).toBe(
      before.client_secret_hash
    );
    const rotated = await request('/clients/app/rotate', 'POST', {}, proof);
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    const response = await rotated.json<Record<string, unknown>>();
    const after = (await repository.findByClientId('app'))!;
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    expect(after.client_secret_hash).not.toBe(before.client_secret_hash);
    expect(await (await request('/clients/app/rotate', 'POST', {}, proof)).json()).toEqual({
      ...response,
      client_secret: '[REDACTED]',
    });
    expect((await repository.findByClientId('app'))!.updated_at).toBe(after.updated_at);
  });
  it('restores a mapping only after approval and commits the history receipt with the new version', async () => {
    const before = (await repository.findByClientId('app'))!;
    store.db
      .prepare(
        `INSERT INTO identity_mapping_level_history
      (id,tenant_id,tier,client_id,before_json,after_json,actor_id,actor_type,via,source_version,status,created_at,updated_at,committed_at)
      VALUES ('history-1','tenant-a','client','app','null','{"mode":"none"}','admin','human','client',?,'committed',1,1,1)`
      )
      .run(String(before.updated_at));
    const body = { expected_version: String(before.updated_at) };
    const proof = await approve(await request('/history/history-1/restore', 'POST', body));
    expect(await repository.findByClientId('app')).toEqual(before);
    expect(await store.adapter.query('SELECT id FROM identity_mapping_level_history')).toHaveLength(
      1
    );
    const restored = await request('/history/history-1/restore', 'POST', body, proof);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await repository.findByClientId('app'))!.identity_mapping).toBeNull();
    expect(
      await store.adapter.query(
        "SELECT via,status FROM identity_mapping_level_history WHERE via='restore'"
      )
    ).toEqual([{ via: 'restore', status: 'committed' }]);
    expect((await request('/history/history-1/restore', 'POST', body, proof)).status).toBe(200);
  });
});

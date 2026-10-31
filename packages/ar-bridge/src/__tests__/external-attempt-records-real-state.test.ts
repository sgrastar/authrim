import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '@authrim/ar-lib-core/control-plane';
import type { UpstreamProvider } from '../types';

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  identity: vi.fn(),
  complete: vi.fn(),
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
type TestEnv = Env & {
  TEST_CORE: DatabaseAdapter;
  TEST_ACCOUNT: DatabaseAdapter;
  TEST_PII: DatabaseAdapter;
  TEST_CHALLENGES: unknown;
};
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  resolveAuthCorePersistenceAdapterFromEnv: async (env: TestEnv) => env.TEST_CORE,
  createAccountAuthContextFromHono: (c: { env: TestEnv }) => ({ coreAdapter: c.env.TEST_ACCOUNT }),
  createPIIContextFromHono: (c: { env: TestEnv }) => ({ defaultPiiAdapter: c.env.TEST_PII }),
  resolveAccountDataContextByIdentifier: async (env: TestEnv) => ({
    coreDb: env.TEST_ACCOUNT,
    piiDb: env.TEST_PII,
    legacyUserId: 'user-a',
    accountId: 'account:user-a',
  }),
  getChallengeStoreByChallengeId: async (env: TestEnv) => env.TEST_CHALLENGES,
  getUIConfig: async () => ({ baseUrl: 'https://login.example.com' }),
  createDiagnosticLoggerFromContext: async () => null,
  getLogger: () => ({ module: () => mocks.logger }),
  publishEvent: async () => undefined,
}));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.provider }));
vi.mock('../services/identity-stitching', () => ({
  handleIdentity: mocks.identity,
  completeExternalIdpJIT: mocks.complete,
}));
vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: {
    fromProvider: () => ({
      exchangeCode: async () => ({
        tokens: { access_token: 'fixture-upstream-access', token_type: 'Bearer' },
        requestContext: {},
      }),
      fetchUserInfoWithMeta: async () => ({
        userInfo: { sub: 'upstream-sub', email: 'fixture@example.test', email_verified: true },
        endpoint: 'https://idp.example.com/userinfo',
        signedResponse: false,
      }),
    }),
  },
}));

import {
  computeInvestigationSubjectHash,
  loadInvestigationSubjectHmacKeysFromEnv,
  resolveSignInAttemptInteraction,
} from '@authrim/ar-lib-core';
import {
  handleExternalCallback,
  handleExternalProvisioningResume,
  handleExternalProvisioningStatus,
} from '../handlers/callback';
import { getAuthStateCookieName, storeAuthState } from '../utils/state';
import { encrypt } from '../utils/crypto';

// Deterministic test-only key accepted by the production weak-key validation.
const KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const KEYRING = JSON.stringify({ current: 1, keys: { '1': 'b'.repeat(43) } });
const STATE = 'fixture-upstream-state';
const TENANT = 'default';
const FLOW = 'flow-default-login-no-consent';
const VERSION = 'flow-version-default-login-no-consent-v1';
type SqlValue = string | number | bigint | Uint8Array | null;
interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number | bigint };
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
  };
}
// Node22+ provides SQLite; the supported Node ambient types predate that module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};
const opened: SqliteDatabase[] = [];
const openedArchives: Array<() => void> = [];

function database(family: 'core' | 'pii') {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  const directory = new URL(`../../../../migrations/${family}/d1/`, import.meta.url);
  for (const file of [`001_0_5_0_${family}_baseline.sql`])
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, directory), 'utf8'), 'sqlite'));
  const bind = (params: unknown[] = []) =>
    params.map((value) => (value ?? null) as string | number | null);
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...bind(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...bind(params)).changes),
    }),
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

/** SQL-backed challenge RPC boundary: reads may overlap, but only one consume UPDATE succeeds. */
function challenges(db: SqliteDatabase) {
  let consumeAttempts = 0;
  db.exec(`CREATE TABLE fixture_challenges (
    id TEXT PRIMARY KEY,tenant_id TEXT,type TEXT,user_id TEXT,challenge TEXT,
    expires_at INTEGER,consumed INTEGER DEFAULT 0,metadata_json TEXT
  )`);
  return {
    get consumeAttempts() {
      return consumeAttempts;
    },
    async storeChallengeRpc(input: {
      id: string;
      tenantId: string;
      type: string;
      userId: string;
      challenge: string;
      ttl: number;
      metadata: unknown;
    }) {
      db.prepare(
        'INSERT INTO fixture_challenges(id,tenant_id,type,user_id,challenge,expires_at,metadata_json) VALUES(?,?,?,?,?,?,?)'
      ).run(
        input.id,
        input.tenantId,
        input.type,
        input.userId,
        input.challenge,
        Date.now() + input.ttl * 1000,
        JSON.stringify(input.metadata)
      );
    },
    async getChallengeRpc(id: string) {
      const row = db.prepare('SELECT * FROM fixture_challenges WHERE id=?').get(id);
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            type: row.type,
            userId: row.user_id,
            challenge: row.challenge,
            expiresAt: row.expires_at,
            consumed: row.consumed === 1,
            metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
          }
        : null;
    },
    async consumeChallengeRpc(input: {
      id: string;
      tenantId: string;
      type: string;
      challenge: string;
    }) {
      consumeAttempts += 1;
      const result = db
        .prepare(
          'UPDATE fixture_challenges SET consumed=1 WHERE id=? AND tenant_id=? AND type=? AND challenge=? AND consumed=0 AND expires_at>?'
        )
        .run(input.id, input.tenantId, input.type, input.challenge, Date.now());
      if (Number(result.changes) !== 1) throw new Error('challenge_not_found_or_consumed');
      return {
        userId: db.prepare('SELECT user_id FROM fixture_challenges WHERE id=?').get(input.id)
          ?.user_id,
      };
    },
  };
}

async function fixture(
  options: {
    keyring?: string | null;
    interactionTenant?: string;
    flow?: boolean;
    enableSso?: boolean;
  } = {}
) {
  const core = database('core');
  const account = database('core');
  const pii = database('pii');
  const archive = await logProducerFixture('scheduled', { tenantId: TENANT });
  openedArchives.push(archive.close);
  const now = Math.floor(Date.now() / 1000);
  core.db
    .prepare(
      `INSERT INTO flow_interactions(id,tenant_id,flow_id,flow_version_id,state,contract_hash,signature,expires_at,created_at,updated_at)
    VALUES('int-external',?,?,?,'active','contract','signature',?,?,?)`
    )
    .run(options.interactionTenant ?? TENANT, FLOW, VERSION, now + 600, now, now);
  const secret = await encrypt('fixture-upstream-secret', KEY);
  core.db
    .prepare(
      `INSERT INTO upstream_providers(id,tenant_id,name,provider_type,client_id,client_secret_encrypted,created_at,updated_at)
    VALUES('provider-a',?,'Fixture IdP','oidc','upstream-client',?,1,1)`
    )
    .run(TENANT, secret);
  const provider: UpstreamProvider = {
    id: 'provider-a',
    tenantId: TENANT,
    slug: 'corp',
    name: 'Fixture IdP',
    providerType: 'oidc',
    enabled: true,
    priority: 0,
    issuer: 'https://idp.example.com',
    clientId: 'upstream-client',
    clientSecretEncrypted: secret,
    scopes: 'openid email',
    attributeMapping: {},
    autoLinkEmail: false,
    jitProvisioning: true,
    requireEmailVerified: true,
    providerQuirks: {},
    createdAt: 1,
    updatedAt: 1,
  };
  mocks.provider.mockResolvedValue(provider);
  const pending = {
    status: 'pending',
    userId: 'user-a',
    isNewUser: true,
    stitchedFromExisting: false,
    accountId: 'account:user-a',
    operationId: 'operation-a',
    providerId: 'provider-a',
    providerUserId: 'upstream-sub',
  };
  mocks.identity.mockResolvedValue(pending);
  mocks.complete.mockResolvedValue({ linkedIdentityId: 'linked-a' });
  let status: 'pending' | 'ready' | 'failed' = 'pending';
  const tasks: Promise<unknown>[] = [];
  const execution = {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
    passThroughOnException() {},
    props: {},
  };
  const challengeStore = challenges(core.db);
  const env = {
    ...archive.env,
    TEST_CORE: core.adapter,
    TEST_ACCOUNT: account.adapter,
    TEST_PII: pii.adapter,
    TEST_CHALLENGES: challengeStore,
    RP_TOKEN_ENCRYPTION_KEY: KEY,
    PII_ENCRYPTION_KEY: KEY,
    ISSUER_URL: 'https://auth.example.com',
    SETTINGS: { get: async () => null },
    ...(options.keyring === null
      ? {}
      : { INVESTIGATION_SUBJECT_HMAC_KEYRING: options.keyring ?? KEYRING }),
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
      getExternalIdpAccountProvisioningStatus: async () => ({
        status,
        operationId: 'operation-a',
        accountId: 'account:user-a',
        userId: 'user-a',
      }),
    },
  } as unknown as TestEnv;
  const interactionId =
    options.flow === false
      ? null
      : await resolveSignInAttemptInteraction(core.adapter, {
          tenantId: TENANT,
          interactionId: 'int-external',
        });
  const stateId = await storeAuthState(env, {
    tenantId: TENANT,
    providerId: 'provider-a',
    clientId: 'client-a',
    state: STATE,
    codeChallenge: 'fixture-code-challenge',
    codeVerifier: 'fixture-code-verifier',
    redirectUri: 'https://login.example.com/callback',
    enableSso: options.enableSso ?? true,
    ...(interactionId ? { attemptInteractionId: interactionId } : {}),
    expiresAt: Date.now() + 60_000,
  });
  const app = new Hono<{ Bindings: Env }>();
  // Match the Worker middleware that prepares the response before cookie-setting handlers.
  app.use('*', cors({ origin: 'https://login.example.com', credentials: true }));
  app.use('*', async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', TENANT);
    await next();
  });
  app.get('/auth/external/:provider/callback', handleExternalCallback);
  app.post('/status', handleExternalProvisioningStatus);
  app.get('/resume', handleExternalProvisioningResume);
  const request = async (url: string, init: RequestInit = {}): Promise<Response> =>
    app.request(url, init, env, execution);
  const flush = async () => {
    while (tasks.length) await Promise.all(tasks.splice(0));
  };
  const records = async () =>
    (await archive.rows('core.flow_audit_events', TENANT)).filter(
      (row) => row.event_type === 'flow.sign_in_attempt.failed'
    );
  const begin = async () => {
    const response = await request(
      `/auth/external/corp/callback?state=${STATE}&code=fixture-code`,
      {
        headers: { Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}` },
      }
    );
    expect({
      location: response.headers.get('location'),
      errors: mocks.logger.error.mock.calls,
    }).toMatchObject({ errors: [] });
    const token = new URL(
      response.headers.get('location') ?? 'https://invalid.example'
    ).searchParams.get('provisioning_token');
    expect(response.headers.getSetCookie().map((value) => value.split('=')[0])).toEqual(
      expect.arrayContaining([expect.stringMatching(/^authrim_external_provisioning_/u)])
    );
    const cookie = response.headers
      .get('set-cookie')
      ?.match(/authrim_external_provisioning_[^=;, ]+=[^;, ]+/)?.[0];
    return { response, token, cookie };
  };
  const poll = (token: string, cookie?: string, tenant = TENANT) =>
    request('/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ provisioning_token: token, tenant_id: tenant }),
    });
  const resume = (token: string, cookie?: string) =>
    request(`/resume?token=${token}&tenant=${TENANT}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
  return {
    core,
    account,
    archive,
    env,
    stateId,
    challengeStore,
    request,
    flush,
    records,
    begin,
    poll,
    resume,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const close of openedArchives.splice(0)) close();
});

describe('federated attempts with real state, canonical encrypted records and HMAC', () => {
  it('roundtrips state into pending and deduplicates concurrent terminal status polls and replay', async () => {
    const t = await fixture();
    const started = await t.begin();
    expect(started.response.status).toBe(302);
    expect(started.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.cookie).toBeDefined();
    expect((await t.poll(started.token!, started.cookie)).status).toBe(202);
    await t.flush();
    expect(await t.records()).toEqual([]);
    t.setStatus('failed');
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => t.poll(started.token!, started.cookie))
    );
    expect(responses.some((response) => response.status === 409)).toBe(true);
    await t.flush();
    const rows = await t.records();
    expect(rows).toHaveLength(1);
    const keys = loadInvestigationSubjectHmacKeysFromEnv({
      INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING,
    });
    expect(rows[0]).toMatchObject({
      reason_code: 'provisioning_failed',
      user_id: null,
      subject_hash: await computeInvestigationSubjectHash(keys!.writeKey, TENANT, 'user-a'),
    });
    expect((await t.poll(started.token!, started.cookie)).status).toBe(400);
    await t.resume(started.token!, started.cookie);
    await t.flush();
    expect(await t.records()).toHaveLength(1);
    for (const marker of [started.token!, STATE, 'user-a', 'fixture@example.test', t.stateId])
      expect(JSON.stringify(rows)).not.toContain(marker);
  }, 20_000);

  it('records a ready resume failure once and keeps the existing USER_INACTIVE response', async () => {
    const t = await fixture();
    const started = await t.begin();
    t.setStatus('ready');
    const response = await t.resume(started.token!, started.cookie);
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    await t.flush();
    expect(await t.records()).toHaveLength(1);
    expect((await t.records())[0]).toMatchObject({
      reason_code: 'account_unavailable',
      user_id: null,
    });
    await t.resume(started.token!, started.cookie);
    await t.flush();
    expect(await t.records()).toHaveLength(1);
  }, 20_000);

  it('does not record a concurrent resume that loses challenge consumption', async () => {
    const t = await fixture({ enableSso: false });
    const started = await t.begin();
    t.setStatus('ready');
    let reachedCompletion = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.complete.mockImplementation(async () => {
      reachedCompletion += 1;
      if (reachedCompletion === 2) release();
      await bothReady;
      return { linkedIdentityId: 'linked-a' };
    });

    const responses = await Promise.all([
      t.resume(started.token!, started.cookie),
      t.resume(started.token!, started.cookie),
    ]);

    expect(t.challengeStore.consumeAttempts).toBe(2);
    const redirects = responses.map((response) => new URL(response.headers.get('location')!));
    expect(redirects.filter((url) => url.searchParams.has('code'))).toHaveLength(1);
    expect(responses.every((response) => response.status === 302)).toBe(true);
    await t.flush();
    expect(await t.records()).toEqual([]);
  }, 20_000);

  it('records the non-provisioning callback runtime-user absence without changing USER_INACTIVE', async () => {
    const t = await fixture();
    mocks.identity.mockResolvedValue({
      status: 'ready',
      userId: 'user-a',
      isNewUser: false,
      linkedIdentityId: 'linked-a',
      stitchedFromExisting: false,
    });

    const response = await t.request(
      `/auth/external/corp/callback?state=${STATE}&code=fixture-code`,
      {
        headers: { Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}` },
      }
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    await t.flush();
    const keys = loadInvestigationSubjectHmacKeysFromEnv({
      INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING,
    });
    expect(await t.records()).toHaveLength(1);
    expect((await t.records())[0]).toMatchObject({
      reason_code: 'account_unavailable',
      user_id: null,
      subject_hash: await computeInvestigationSubjectHash(keys!.writeKey, TENANT, 'user-a'),
    });
    const replay = await t.request(
      `/auth/external/corp/callback?state=${STATE}&code=fixture-code`,
      {
        headers: { Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}` },
      }
    );
    expect(replay.status).toBe(302);
    await t.flush();
    expect(await t.records()).toHaveLength(1);
  }, 20_000);

  it('deduplicates resume failures before consume without changing their redirect response', async () => {
    const t = await fixture();
    const started = await t.begin();
    t.setStatus('ready');
    mocks.complete.mockRejectedValue(new Error('fixture-private-db-error'));
    const responses = await Promise.all([
      t.resume(started.token!, started.cookie),
      t.resume(started.token!, started.cookie),
    ]);
    expect(responses.every((response) => response.status === 302)).toBe(true);
    await t.flush();
    expect(await t.records()).toHaveLength(1);
    expect((await t.records())[0].reason_code).toBe('service_unavailable');
    expect(JSON.stringify(await t.records())).not.toContain('fixture-private-db-error');
  }, 20_000);

  it('does not record malformed, foreign-tenant, unbound or pending continuations', async () => {
    const t = await fixture();
    const started = await t.begin();
    expect((await t.poll(started.token!, started.cookie, 'tenant-b')).status).toBe(400);
    expect((await t.poll(started.token!)).status).toBe(400);
    expect((await t.poll('invalid', started.cookie)).status).toBe(400);
    await t.resume(started.token!, started.cookie);
    await t.flush();
    expect(await t.records()).toEqual([]);
  }, 20_000);

  it.each([{ flow: false }, { interactionTenant: 'tenant-b' }])(
    'records nothing outside the validated tenant Flow: %j',
    async (options) => {
      const t = await fixture(options);
      const started = await t.begin();
      t.setStatus('failed');
      expect((await t.poll(started.token!, started.cookie)).status).toBe(409);
      await t.flush();
      expect(await t.records()).toEqual([]);
    },
    20_000
  );

  it.each([null, '{invalid-keyring'])(
    'keeps optional/unreadable keyring independent of the protocol: %j',
    async (keyring) => {
      const t = await fixture({ keyring });
      const started = await t.begin();
      t.setStatus('failed');
      expect((await t.poll(started.token!, started.cookie)).status).toBe(409);
      await t.flush();
      expect(await t.records()).toHaveLength(1);
      expect((await t.records())[0].subject_hash).toBeNull();
    },
    20_000
  );

  it('keeps a failed-status response when the best-effort recording SQL fails', async () => {
    const t = await fixture();
    const started = await t.begin();
    const commit = vi.spyOn(t.archive.adminAdapter, 'batch');
    t.archive.adminDb
      .exec(`CREATE TRIGGER reject_record_fixture BEFORE INSERT ON log_iceberg_records
      BEGIN SELECT RAISE(ABORT,'fixture-private-record-error'); END`);
    t.setStatus('failed');
    expect((await t.poll(started.token!, started.cookie)).status).toBe(409);
    await t.flush();
    expect(await t.records()).toEqual([]);
    expect(
      commit.mock.calls.some(([statements]) =>
        statements.some((statement) => statement.sql.includes('INSERT INTO log_iceberg_records'))
      )
    ).toBe(true);
    expect(
      t.archive.adminDb
        .prepare('SELECT state FROM log_sign_in_attempt_receipts WHERE tenant_id=?')
        .get(TENANT)?.state
    ).toBe('reserved');
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'fixture-private-record-error'
    );
    expect((await t.poll(started.token!, started.cookie)).status).toBe(400);
  }, 20_000);
});

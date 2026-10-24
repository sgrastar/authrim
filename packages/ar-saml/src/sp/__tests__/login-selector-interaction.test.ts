/**
 * Real Flow SQL validation across the public selector -> selected-provider start. Protocol
 * generation and browser-binding cookies remain production code. Provider config, human checks
 * and the request-store transport are local doubles. The final record assertion exercises the
 * captured context with the real HMAC recorder; the separate ACS tests cover consumption.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeInvestigationSubjectHash,
  loadInvestigationSubjectHmacKeysFromEnv,
  scheduleSignInAttemptFailureRecord,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '@authrim/ar-lib-core/control-plane';

const provider = {
  entityId: 'https://idp.example.test',
  ssoUrl: 'https://idp.example.test/sso',
  certificate: 'fixture-certificate',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  attributeMapping: {},
  allowedBindings: ['post'],
};
const mocks = vi.hoisted(() => ({ getProvider: vi.fn(), listProviders: vi.fn() }));
type TestEnv = Env & { TEST_CORE: DatabaseAdapter };
vi.mock('../../admin/providers', () => ({
  getIdPConfig: mocks.getProvider,
  listIdPConfigs: mocks.listProviders,
}));
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: async () => ({
    issuerUrl: 'https://auth.example.test',
    spEntityId: 'https://auth.example.test/saml/sp/metadata',
  }),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  resolveAuthCorePersistenceAdapterFromEnv: async (env: TestEnv) => env.TEST_CORE,
  getUIConfig: async () => ({ baseUrl: 'https://auth.example.test' }),
  verifyHumanVerificationWithRunner: async () => ({ verified: true }),
  readExternalProviderUsagePolicy: async () => ({ loginEnabled: true, signupEnabled: true }),
  getLogger: () => ({
    module: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
import { handleSPLogin } from '../login';

type SqlValue = string | number | null;
type Sqlite = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...values: SqlValue[]): { changes: number | bigint };
    get(...values: SqlValue[]): unknown;
    all(...values: SqlValue[]): unknown[];
  };
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Sqlite;
};
const TENANT = 'default';
const ISSUER = 'https://auth.example.test';
const RETURN_URL = ISSUER + '/login?runtime_interaction_id=int-selector';
const KEYRING = JSON.stringify({ current: 1, keys: { '1': 'b'.repeat(43) } });
type StoredRequest = {
  requestId: string;
  issuer: string;
  destination: string;
  binding: string;
  type: string;
  relayState: string;
  context?: { attemptInteractionId?: string };
  expiresAt: number;
};

describe('SAML selector preserves only a revalidated Flow association', () => {
  let db: Sqlite;
  let adapter: DatabaseAdapter;
  let env: TestEnv;
  let app: Hono<{ Bindings: Env }>;
  beforeEach(() => {
    vi.clearAllMocks();
    db = new DatabaseSync(':memory:');
    const migrations = new URL('../../../../../migrations/core/d1/', import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((s) => s.endsWith('.sql'))
      .sort())
      db.exec(
        renderPortableMigrationSql(readFileSync(new URL(name, migrations), 'utf8'), 'sqlite')
      );
    db.exec('CREATE TABLE fixture_saml_requests(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    const values = (params: unknown[] = []) => params.map((value) => (value ?? null) as SqlValue);
    adapter = {
      query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
      queryOne: async (sql: string, params?: unknown[]) =>
        db.prepare(sql).get(...values(params)) ?? null,
      execute: async (sql: string, params?: unknown[]) => ({
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
      }),
    } as unknown as DatabaseAdapter;
    const now = Math.floor(Date.now() / 1000);
    for (const [id, tenantId, expiresAt] of [
      ['int-selector', TENANT, now + 600],
      ['int-foreign', 'foreign-tenant', now + 600],
      ['int-expired', TENANT, now - 1],
    ] as const) {
      db.prepare(
        `INSERT INTO flow_interactions(id,tenant_id,flow_id,flow_version_id,state,contract_hash,signature,expires_at,created_at,updated_at)
        VALUES(?,?,'flow-default-login-no-consent','flow-version-default-login-no-consent-v1','active','fixture-contract','fixture-signature',?,?,?)`
      ).run(id, tenantId, expiresAt, now, now);
    }
    mocks.getProvider.mockResolvedValue(provider);
    mocks.listProviders.mockResolvedValue([
      { id: 'idp-one', name: 'First provider', entityId: provider.entityId },
      { id: 'idp-two', name: 'Second provider', entityId: 'https://second.example.test' },
    ]);
    env = {
      TEST_CORE: adapter,
      ISSUER_URL: ISSUER,
      SETTINGS: { get: async () => null },
      INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING,
      SAML_REQUEST_STORE: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (_input: unknown, init: RequestInit) => {
            if (typeof init.body !== 'string') throw new Error('fixture-request-body-not-string');
            const payload = JSON.parse(init.body) as StoredRequest;
            db.prepare('INSERT INTO fixture_saml_requests(id,payload) VALUES(?,?)').run(
              payload.requestId,
              JSON.stringify(payload)
            );
            return new Response('OK');
          },
        }),
      },
    } as unknown as TestEnv;
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', TENANT);
      await next();
    });
    app.get('/saml/sp/login', handleSPLogin);
  });
  afterEach(() => {
    db.close();
  });
  const request = (url: URL) => app.request(url.toString(), {}, env);
  async function selection(value?: string) {
    const url = new URL('/saml/sp/login', ISSUER);
    url.searchParams.set('return_url', RETURN_URL);
    if (value !== undefined) url.searchParams.set('runtime_interaction_id', value);
    const response = await request(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    const links = [...html.matchAll(/<a href="([^"]+)"/gu)].map((match) => new URL(match[1]));
    expect(links).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fixture_saml_requests').get()).toMatchObject({
      n: 0,
    });
    return { html, links };
  }
  function stored(): StoredRequest {
    const row = db.prepare('SELECT payload FROM fixture_saml_requests').get() as {
      payload: string;
    };
    return JSON.parse(row.payload) as StoredRequest;
  }
  async function recordFromContext(context: StoredRequest['context'], requestId: string) {
    const tasks: Promise<unknown>[] = [];
    const onError = vi.fn();
    scheduleSignInAttemptFailureRecord(
      {
        env,
        core: () => adapter,
        waitUntil: (p) => {
          tasks.push(p);
        },
        onError,
      },
      {
        tenantId: TENANT,
        interactionId: context?.attemptInteractionId,
        method: 'saml',
        reasonCode: 'verification_failed',
        userId: 'fixture-user',
        dedupeKey: requestId,
      }
    );
    await Promise.all(tasks);
    expect(onError).not.toHaveBeenCalled();
  }
  function attempts() {
    return db
      .prepare("SELECT * FROM flow_audit_events WHERE event_type='flow.sign_in_attempt.failed'")
      .all() as Array<Record<string, unknown>>;
  }

  it('carries the Flow hint through every selection link, revalidates it, and preserves request/browser binding', async () => {
    const { links } = await selection('  int-selector  ');
    expect(links.map((url) => url.searchParams.get('runtime_interaction_id'))).toEqual([
      'int-selector',
      'int-selector',
    ]);
    expect(links[0].searchParams.get('return_url')).toBe(RETURN_URL);
    const response = await request(links[0]);
    expect(response.status).toBe(200);
    const body = stored();
    expect(body.context).toEqual({ attemptInteractionId: 'int-selector' });
    expect(body).toMatchObject({
      issuer: ISSUER + '/saml/sp/metadata',
      destination: provider.entityId,
      binding: 'post',
      type: 'authn_request',
      relayState: RETURN_URL,
    });
    expect(body.requestId).toMatch(/^_[0-9a-f]{32}$/u);
    const form = await response.text();
    expect(form).toContain(`name="RelayState" value="${body.requestId}"`);
    expect(form).not.toContain('int-selector');
    expect(response.headers.get('set-cookie')).toContain(
      `__Host-authrim_saml_request_${body.requestId}=1; Path=/; HttpOnly; Secure; SameSite=None;`
    );
    // The real callback recorder receives this validated context, without a query fallback.
    await recordFromContext(body.context, body.requestId);
    await recordFromContext(body.context, body.requestId);
    const keys = loadInvestigationSubjectHmacKeysFromEnv(env);
    if (!keys) throw new Error('fixture-keyring-missing');
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatchObject({
      tenant_id: TENANT,
      interaction_id: 'int-selector',
      method: 'saml',
      user_id: null,
      subject_hash: await computeInvestigationSubjectHash(keys.writeKey, TENANT, 'fixture-user'),
    });
    expect(JSON.stringify(attempts())).not.toContain('fixture-user');
  });

  it.each([undefined, '', 'not/a/flow', '"><script>alert(1)</script>', 'x'.repeat(129)])(
    'drops absent or malformed selector hint %s without changing ordinary sign-in',
    async (value) => {
      const { html, links } = await selection(value);
      expect(links.every((url) => !url.searchParams.has('runtime_interaction_id'))).toBe(true);
      expect(html).not.toContain('<script>');
      const response = await request(links[0]);
      expect(response.status).toBe(200);
      expect(stored().context).toBeUndefined();
      await recordFromContext(stored().context, stored().requestId);
      expect(attempts()).toEqual([]);
    }
  );

  it.each(['int-foreign', 'int-expired', 'int-unknown'])(
    'forwards an opaque %s hint but rejects the association against real tenant/expiry SQL after selection',
    async (id) => {
      const { links } = await selection(id);
      expect(links[0].searchParams.get('runtime_interaction_id')).toBe(id);
      const response = await request(links[0]);
      expect(response.status).toBe(200);
      expect(stored().context).toBeUndefined();
      await recordFromContext(stored().context, stored().requestId);
      expect(attempts()).toEqual([]);
    }
  );

  it.each(['completed', 'expired'])(
    'rechecks a hint that becomes %s after rendering the selector',
    async (state) => {
      const { links } = await selection('int-selector');
      if (state === 'completed')
        db.prepare("UPDATE flow_interactions SET state='completed' WHERE id='int-selector'").run();
      else
        db.prepare("UPDATE flow_interactions SET expires_at=? WHERE id='int-selector'").run(
          Math.floor(Date.now() / 1000) - 1
        );
      const response = await request(links[0]);
      expect(response.status).toBe(200);
      expect(stored().context).toBeUndefined();
      await recordFromContext(stored().context, stored().requestId);
      expect(attempts()).toEqual([]);
    }
  );

  it('continues without association when the selected start cannot check Flow storage', async () => {
    const { links } = await selection('int-selector');
    env.TEST_CORE = {
      ...adapter,
      queryOne: async () => {
        throw new Error('fixture-storage-unavailable');
      },
    };
    const response = await request(links[0]);
    expect(response.status).toBe(200);
    expect(stored().context).toBeUndefined();
    await recordFromContext(stored().context, stored().requestId);
    expect(attempts()).toEqual([]);
  });
});

/**
 * Writing a SAML federation trust source while the platform has `saml_metadata_url` off: a
 * tenant administrator cannot add a metadata URL the scheduled poller would fetch (a new or
 * changed `metadataUrl`, or an exact URL pattern), but may keep or clear the stored ones, write a
 * source without any URL, and delete. Global platform authority is exempt; an unreadable switch
 * refuses a write that adds a URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type {
  DatabaseAdapter,
  Env,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  TransactionContext,
} from '@authrim/ar-lib-core';
import {
  adminIdentityMappingFederationTrustSourceCreateHandler,
  adminIdentityMappingFederationTrustSourceDeleteHandler,
  adminIdentityMappingFederationTrustSourceUpdateHandler,
} from '../identity-mapping-control-plane';

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', () => ({
  emitLogIcebergRow: vi.fn(),
  prepareLogIcebergRowWrite: async () => ({ statements: [], dispatch: async () => {} }),
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-core-publication', async (original) => ({
  ...(await original<
    typeof import('@authrim/ar-lib-core/services/log-iceberg-core-publication')
  >()),
  prepareCoreLogPublication: async () => ({
    publicationId: 'unit-publication',
    state: 'prepared',
    wrapBusinessBatch: (statements: PreparedStatement[]) => statements,
    dispatch: async () => {},
  }),
}));
const stepUp = vi.hoisted(() => ({ require: vi.fn() }));
vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: stepUp.require }));

const CAPABILITIES_KEY = 'settings:platform:tenant-capabilities';
const STORED_URL = 'https://fed.example.test/stored.xml';
const NEW_URL = 'https://fed.example.test/new.xml';

function adapterFor(storedPayload: Record<string, unknown> | null) {
  const executes: string[] = [];
  const adapter: DatabaseAdapter = {
    async query<T>(): Promise<T[]> {
      return [];
    },
    async queryOne<T>(sql: string): Promise<T | null> {
      if (sql.includes('FROM log_iceberg_core_publications')) return { state: 'committed' } as T;
      if (sql.includes('SELECT protocol_payload_json')) {
        return (
          storedPayload ? { protocol_payload_json: JSON.stringify(storedPayload) } : null
        ) as T | null;
      }
      if (sql.includes('SELECT source.updated_at')) {
        return { updated_at: 2000, snapshot_hash: 'old' } as T;
      }
      if (sql.includes('SELECT id') && sql.includes('FROM federation_trust_sources')) {
        return { id: 'source-1' } as T;
      }
      return null;
    },
    async execute(sql: string): Promise<ExecuteResult> {
      executes.push(sql);
      return { rowsAffected: 1, success: true };
    },
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
      return Promise.all(statements.map((statement) => this.execute(statement.sql)));
    },
    async isHealthy(): Promise<HealthStatus> {
      return { healthy: true, latencyMs: 1, type: 'test' };
    },
    getType: () => 'test',
    async close() {},
  };
  return { adapter, executes };
}

const TENANT_ADMIN = {
  userId: 'admin-1',
  roles: ['ar_tenant_admin'],
  permissions: ['admin:*'],
  tenantScope: ['tenant_a'],
};
const PLATFORM_ADMIN = {
  userId: 'admin-2',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  permissions: ['admin:*'],
  globalPermissions: ['admin:*'],
  tenantScope: ['*'],
};

type Switch = boolean | 'down' | undefined;

function harness(input: {
  persona: Record<string, unknown>;
  switch: Switch;
  stored: Record<string, unknown> | null;
}) {
  const { adapter, executes } = adapterFor(input.stored);
  const values = new Map<string, string>();
  if (typeof input.switch === 'boolean') {
    values.set(
      CAPABILITIES_KEY,
      JSON.stringify({ 'tenant_capabilities.saml_metadata_url': input.switch })
    );
  }
  const settings = {
    get: vi.fn(async (key: string) => {
      if (input.switch === 'down' && key === CAPABILITIES_KEY) throw new Error('kv down');
      return values.get(key) ?? null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, 'tenant_a');
    c.set('adminAuth' as never, input.persona);
    c.set(
      'tenantMetadataContext' as never,
      { tenantId: 'tenant_a', coreDb: adapter, route: {} } as never
    );
    await next();
  });
  app.post(
    '/api/admin/field-mapping/federation-trust-sources',
    adminIdentityMappingFederationTrustSourceCreateHandler
  );
  app.put(
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId',
    adminIdentityMappingFederationTrustSourceUpdateHandler
  );
  app.delete(
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId',
    adminIdentityMappingFederationTrustSourceDeleteHandler
  );
  const env = { DB_ADMIN: adapter, SETTINGS: settings } as unknown as Env;
  const send = (method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env
    );
  const wroteSource = () =>
    executes.some(
      (sql) =>
        sql.includes('INSERT INTO federation_trust_sources') ||
        sql.includes('UPDATE federation_trust_sources')
    );
  return {
    create: (protocolPayload?: Record<string, unknown>) =>
      send('POST', '/api/admin/field-mapping/federation-trust-sources', source(protocolPayload)),
    update: (protocolPayload?: Record<string, unknown>) =>
      send('PUT', '/api/admin/field-mapping/federation-trust-sources/source-1', {
        ...source(protocolPayload),
        expectedUpdatedAt: 2000,
      }),
    remove: () => send('DELETE', '/api/admin/field-mapping/federation-trust-sources/source-1'),
    wroteSource,
  };
}

const source = (protocolPayload?: Record<string, unknown>) => ({
  sourceType: 'saml_metadata',
  sourceKey: 'federation',
  displayName: 'Federation',
  lifecycleState: 'draft',
  ...(protocolPayload ? { protocolPayload } : {}),
  anchors: [],
  scopeBindings: [],
});

beforeEach(() => {
  stepUp.require.mockReset();
  stepUp.require.mockResolvedValue(null);
});

describe('creating a federation source while saml_metadata_url is off', () => {
  it.each([
    ['a metadata URL', { metadataUrl: NEW_URL }],
    ['an exact URL pattern', { metadataUrlPatterns: [NEW_URL] }],
  ])(
    'refuses a tenant admin %s with 403 capability_disabled and writes nothing',
    async (_n, payload) => {
      const h = harness({ persona: TENANT_ADMIN, switch: false, stored: null });
      const response = await h.create(payload);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'capability_disabled',
        capability: 'saml_metadata_url',
      });
      expect(h.wroteSource()).toBe(false);
      expect(stepUp.require).not.toHaveBeenCalled();
    }
  );

  it('answers 503 with Retry-After when the switch cannot be read', async () => {
    const h = harness({ persona: TENANT_ADMIN, switch: 'down', stored: null });
    const response = await h.create({ metadataUrl: NEW_URL });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(h.wroteSource()).toBe(false);
  });

  it('writes a source without a URL, with a wildcard pattern only, or with the URL cleared', async () => {
    for (const payload of [
      undefined,
      { policy: 'strict' },
      { metadataUrlPatterns: ['https://fed.example.test/*'] },
      { metadataUrl: null },
    ]) {
      const h = harness({ persona: TENANT_ADMIN, switch: false, stored: null });
      const response = await h.create(payload);
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(h.wroteSource()).toBe(true);
    }
  });

  it('allows a URL while on, and for a caller with global platform authority while off', async () => {
    for (const [persona, value] of [
      [TENANT_ADMIN, true],
      [TENANT_ADMIN, undefined],
      [PLATFORM_ADMIN, false],
      [PLATFORM_ADMIN, 'down'],
    ] as const) {
      const h = harness({ persona, switch: value, stored: null });
      const response = await h.create({ metadataUrl: NEW_URL });
      expect(response.status, String(value)).toBe(200);
      expect(h.wroteSource()).toBe(true);
    }
  });
});

describe('a federation source URL that is not a string, while off', () => {
  const odd = [
    { metadataUrl: [NEW_URL] },
    { metadataUrl: { href: NEW_URL } },
    { metadataUrlPatterns: NEW_URL },
    { metadataUrlPatterns: [[NEW_URL]] },
  ];

  it('is refused on create and on update', async () => {
    for (const payload of odd) {
      const created = await harness({ persona: TENANT_ADMIN, switch: false, stored: null }).create(
        payload
      );
      expect(created.status, JSON.stringify(payload)).not.toBe(200);
      const h = harness({ persona: TENANT_ADMIN, switch: false, stored: { policy: 'strict' } });
      const updated = await h.update(payload);
      expect(updated.status, JSON.stringify(payload)).not.toBe(200);
      expect(h.wroteSource()).toBe(false);
    }
  });

  it('is refused with 403 when the payload itself is valid for the repository', async () => {
    const h = harness({ persona: TENANT_ADMIN, switch: false, stored: { policy: 'strict' } });
    const response = await h.update({ metadataUrlPatterns: [NEW_URL] });
    expect(response.status).toBe(403);
  });
});

describe('updating a federation source while saml_metadata_url is off', () => {
  const stored = { metadataUrl: STORED_URL, policy: 'strict' };

  it('refuses a tenant admin a new or changed URL, or an added exact pattern', async () => {
    for (const payload of [
      { metadataUrl: NEW_URL },
      { metadataUrl: STORED_URL, metadataUrlPatterns: [NEW_URL] },
    ]) {
      const h = harness({ persona: TENANT_ADMIN, switch: false, stored });
      const response = await h.update(payload);
      expect(response.status, JSON.stringify(payload)).toBe(403);
      expect(h.wroteSource()).toBe(false);
    }
  });

  it('lets a tenant admin keep the stored URL while changing other fields, or clear it', async () => {
    for (const payload of [
      { metadataUrl: STORED_URL, policy: 'warn' },
      { policy: 'strict' },
      undefined,
    ]) {
      const h = harness({ persona: TENANT_ADMIN, switch: false, stored });
      const response = await h.update(payload);
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(h.wroteSource()).toBe(true);
    }
  });

  it('answers 503 for a new URL when the switch cannot be read, but not for keeping one', async () => {
    const refused = await harness({ persona: TENANT_ADMIN, switch: 'down', stored }).update({
      metadataUrl: NEW_URL,
    });
    expect(refused.status).toBe(503);
    const kept = await harness({ persona: TENANT_ADMIN, switch: 'down', stored }).update(stored);
    expect(kept.status).toBe(200);
  });

  it('allows a new URL for a caller with global platform authority, and while on', async () => {
    for (const [persona, value] of [
      [PLATFORM_ADMIN, false],
      [TENANT_ADMIN, true],
    ] as const) {
      const response = await harness({ persona, switch: value, stored }).update({
        metadataUrl: NEW_URL,
      });
      expect(response.status).toBe(200);
    }
  });
});

describe('deleting a federation source while saml_metadata_url is off', () => {
  it('stays open for a tenant admin', async () => {
    const h = harness({
      persona: TENANT_ADMIN,
      switch: false,
      stored: { metadataUrl: STORED_URL },
    });
    const response = await h.remove();
    expect(response.status).toBe(200);
  });
});

/**
 * Check API: the resource registry routes (PUT / DELETE /api/check/resources/:type/:id,
 * POST /api/check/resources/batch) on the real D1 table (core migration 021), and the default
 * resolver of self-contract checks reading what they wrote.
 *
 * Authentication is stubbed to the result check-auth gives each credential; the operation, tenant
 * and contract rules that follow are the real ones.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core';

const spies = vi.hoisted(() => {
  const state: { adapter: unknown } = { adapter: undefined };
  return { authenticate: vi.fn(), platformSettings: vi.fn(), state };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolvePlatformSettingsWithSources: spies.platformSettings,
}));
vi.mock('../../middleware/check-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/check-auth')>()),
  authenticateCheckApiRequest: spies.authenticate,
}));
vi.mock('../../rebac-storage-adapter', () => ({
  getPolicyCoreAdapter: () => spies.state.adapter,
  createPolicyReBACService: () => ({ name: 'rebac' }),
}));

import { Hono } from 'hono';
import { parsePermission } from '@authrim/ar-lib-core';
import { createUnifiedCheckService } from '@authrim/ar-lib-core/services/unified-check-service';
import { createTenantRuleEvaluator } from '@authrim/ar-lib-policy';

type TenantPolicyRule = Parameters<typeof createTenantRuleEvaluator>[0][number];
import {
  CHECK_RESOURCE_BATCH_BODY_MAX_BYTES,
  CHECK_RESOURCE_BODY_MAX_BYTES,
  checkResourceRoutes,
} from '../check-resources';
import { createCheckResourceContextResolver } from '../../resource-context-resolvers';
import { createRateLimiterStub } from '../../__tests__/rate-limiter-stub';

type SqlValue = string | number | null;

/** The part of node:sqlite this test uses (its types are not in this package's lint program). */
interface LocalSqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: SqlValue[]): { changes: number | bigint };
    all(...values: SqlValue[]): Record<string, unknown>[];
    get(...values: SqlValue[]): Record<string, unknown> | undefined;
  };
}

const sqliteModule = 'node:sqlite';
const { DatabaseSync } = (await import(sqliteModule)) as {
  DatabaseSync: new (path: string) => LocalSqlite;
};

/** A response body (JSON). */
interface Json {
  [key: string]: unknown;
  items?: { resource_id: string }[];
}

function sqliteStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(
      new URL('../../../../../migrations/core/d1/021_check_resource_registry.sql', import.meta.url),
      'utf8'
    )
  );
  const values = (params: unknown[] = []) =>
    params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    batch: async (statements: PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

const API_KEY_AUTH = {
  authenticated: true,
  method: 'api_key',
  apiKeyId: 'key-1',
  clientId: 'app-1',
  tenantId: 'tenant-a',
  rateLimitTier: 'moderate',
  allowedOperations: ['check', 'resources'],
};

let store: ReturnType<typeof sqliteStore>;
let checkApiEnabled = true;
/** The tenant the request context resolved from the host (null: none set). */
let hostTenant: string | null = 'tenant-a';
/** One limiter for every request of a test (a fresh one per test). */
let limiter: ReturnType<typeof createRateLimiterStub>;

function app() {
  const wrapper = new Hono<{ Variables: { tenantId: string } }>();
  wrapper.use('*', async (c, next) => {
    if (hostTenant !== null) c.set('tenantId', hostTenant);
    await next();
  });
  wrapper.route('/api/check', checkResourceRoutes as never);
  return wrapper;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const response = await app().request(
    `https://${hostTenant ?? 'unknown'}.example.com${path}`,
    {
      method,
      headers: {
        Authorization: 'Bearer chk_key',
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body !== undefined && {
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    },
    { POLICY_API_SECRET: 'policy-secret', RATE_LIMITER: limiter }
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json<Json>(),
  };
}

function rows() {
  return store.db
    .prepare(
      'SELECT tenant_id, resource_type, resource_id, owner_id, group_id, attributes_json FROM check_resources ORDER BY resource_type, resource_id'
    )
    .all();
}

beforeEach(() => {
  vi.clearAllMocks();
  store = sqliteStore();
  spies.state.adapter = store.adapter;
  checkApiEnabled = true;
  hostTenant = 'tenant-a';
  limiter = createRateLimiterStub();
  spies.platformSettings.mockImplementation(async (_env: unknown, category: string) => ({
    values: category === 'feature-flags' ? { 'feature.enable_check_api': checkApiEnabled } : {},
  }));
  spies.authenticate.mockResolvedValue(API_KEY_AUTH);
});

describe('PUT /api/check/resources/:type/:id', () => {
  it('registers a resource in the key tenant and replaces it whole', async () => {
    const created = await call('PUT', '/api/check/resources/documents/doc_1', {
      owner_id: 'user-1',
      group_id: 'group-1',
      attributes: { classification: 'internal' },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      resource_type: 'documents',
      resource_id: 'doc_1',
      owner_id: 'user-1',
      group_id: 'group-1',
      attributes: { classification: 'internal' },
    });
    expect(typeof created.body.updated_at).toBe('number');
    expect(created.headers.get('X-RateLimit-Limit')).not.toBeNull();

    const replaced = await call('PUT', '/api/check/resources/documents/doc_1', {
      group_id: 'group-2',
    });
    expect(replaced.body).toMatchObject({ owner_id: null, group_id: 'group-2', attributes: null });
    expect(rows()).toEqual([
      {
        tenant_id: 'tenant-a',
        resource_type: 'documents',
        resource_id: 'doc_1',
        owner_id: null,
        group_id: 'group-2',
        attributes_json: null,
      },
    ]);
  });

  it.each([
    ['a type outside the grammar', '/api/check/resources/Documents/doc_1', {}],
    ['a type with a hyphen', '/api/check/resources/doc-s/doc_1', {}],
    ['an id with a colon', '/api/check/resources/documents/a%3Ab', {}],
    ['an id with a space', '/api/check/resources/documents/a%20b', {}],
    ['an id with a control character', '/api/check/resources/documents/a%7Fb', {}],
    ['an unknown field', '/api/check/resources/documents/doc_1', { owner: 'u' }],
    ['an owner that is not a string', '/api/check/resources/documents/doc_1', { owner_id: 1 }],
    ['attributes that are an array', '/api/check/resources/documents/doc_1', { attributes: [] }],
    [
      'attributes over 8 KiB',
      '/api/check/resources/documents/doc_1',
      { attributes: { x: 'y'.repeat(8200) } },
    ],
    ['a body that is not JSON', '/api/check/resources/documents/doc_1', '{'],
    ['a body that is not an object', '/api/check/resources/documents/doc_1', '[]'],
  ])('refuses %s with 400', async (_name, path, body) => {
    const response = await call('PUT', path, body);
    expect(response.status).toBe(400);
    expect(response.body.error_code ?? response.body.code).toBeDefined();
    expect(rows()).toEqual([]);
  });
});

describe('DELETE /api/check/resources/:type/:id', () => {
  it('removes a registered resource, idempotently, in the key tenant only', async () => {
    await call('PUT', '/api/check/resources/documents/doc_1', { owner_id: 'user-1' });
    store.db
      .prepare(
        `INSERT INTO check_resources (tenant_id, resource_type, resource_id, owner_id, updated_at)
         VALUES ('tenant-b', 'documents', 'doc_1', 'user-9', 1)`
      )
      .run();
    const removed = await call('DELETE', '/api/check/resources/documents/doc_1');
    expect(removed).toMatchObject({
      status: 200,
      body: { resource_type: 'documents', resource_id: 'doc_1', deleted: true },
    });
    expect((await call('DELETE', '/api/check/resources/documents/doc_1')).body.deleted).toBe(false);
    expect(rows()).toEqual([expect.objectContaining({ tenant_id: 'tenant-b' })]);
  });
});

describe('POST /api/check/resources/batch', () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    resource_type: 'documents',
    resource_id: id,
    ...extra,
  });

  it('registers every item in one batch', async () => {
    const response = await call('POST', '/api/check/resources/batch', {
      items: [item('doc_1', { owner_id: 'user-1' }), item('doc_2', { attributes: { a: 1 } })],
    });
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect(response.body.items?.map((i) => i.resource_id)).toEqual(['doc_1', 'doc_2']);
    expect(rows()).toHaveLength(2);
  });

  it.each([
    ['no items', { items: [] }],
    ['items that are not an array', { items: {} }],
    ['an unknown envelope key', { items: [item('doc_1')], stop: true }],
    ['more than 100 items', { items: Array.from({ length: 101 }, (_, i) => item(`d${i}`)) }],
    ['an item without a type', { items: [item('doc_1'), { resource_id: 'doc_2' }] }],
    ['an item with an invalid id', { items: [item('doc_1'), item('a b')] }],
    ['an item with an unknown key', { items: [item('doc_1'), item('doc_2', { extra: 1 })] }],
    ['the same resource twice', { items: [item('doc_1'), item('doc_1')] }],
  ])('refuses %s with 400 and writes nothing', async (_name, body) => {
    expect((await call('POST', '/api/check/resources/batch', body)).status).toBe(400);
    expect(rows()).toEqual([]);
  });

  it('writes none of the items when the second write fails (one atomic batch)', async () => {
    store.db.exec(
      `CREATE TRIGGER fail_second BEFORE INSERT ON check_resources
         WHEN NEW.resource_id = 'doc_2'
       BEGIN SELECT RAISE(ABORT, 'secret database detail'); END`
    );
    const response = await call('POST', '/api/check/resources/batch', {
      items: [item('doc_1'), item('doc_2')],
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('secret database detail');
    // doc_1 was written first and rolled back with the batch.
    expect(rows()).toEqual([]);
  });
});

describe('the tenant the request was sent to', () => {
  it('refuses a key of another tenant than the host, touching no row of either', async () => {
    // Two tenants on one core database: tenant-a's key at tenant-b's host.
    store.db
      .prepare(
        `INSERT INTO check_resources (tenant_id, resource_type, resource_id, owner_id, updated_at)
         VALUES ('tenant-b', 'documents', 'doc_1', 'user-9', 1), ('tenant-a', 'documents', 'doc_1', 'user-1', 1)`
      )
      .run();
    const before = rows();
    hostTenant = 'tenant-b';
    for (const [method, path, body] of [
      ['PUT', '/api/check/resources/documents/doc_1', { owner_id: 'attacker' }],
      ['DELETE', '/api/check/resources/documents/doc_1', undefined],
      [
        'POST',
        '/api/check/resources/batch',
        { items: [{ resource_type: 'documents', resource_id: 'doc_2' }] },
      ],
    ] as const) {
      expect((await call(method, path, body)).status).toBe(403);
    }
    expect(rows()).toEqual(before);

    // tenant-b's own key at tenant-b's host writes tenant-b's row only.
    spies.authenticate.mockResolvedValue({ ...API_KEY_AUTH, tenantId: 'tenant-b' });
    expect(
      (await call('PUT', '/api/check/resources/documents/doc_1', { owner_id: 'user-8' })).status
    ).toBe(200);
    expect(rows()).toHaveLength(2);
    expect(rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenant_id: 'tenant-a', owner_id: 'user-1' }),
        expect.objectContaining({ tenant_id: 'tenant-b', owner_id: 'user-8' }),
      ])
    );
  });

  it('refuses a request whose host tenant was not resolved (no default tenant stands in)', async () => {
    hostTenant = null;
    expect((await call('PUT', '/api/check/resources/documents/doc_1', {})).status).toBe(403);
    expect(rows()).toEqual([]);
  });
});

describe('request body limits', () => {
  it('answers 413 for a body past 16 KiB (single) or 1 MiB (batch), writing nothing', async () => {
    const single = JSON.stringify({ attributes: { x: 'y'.repeat(CHECK_RESOURCE_BODY_MAX_BYTES) } });
    expect((await call('PUT', '/api/check/resources/documents/doc_1', single)).status).toBe(413);
    const batch = JSON.stringify({
      items: [
        {
          resource_type: 'documents',
          resource_id: 'doc_1',
          attributes: { x: 'y'.repeat(CHECK_RESOURCE_BATCH_BODY_MAX_BYTES) },
        },
      ],
    });
    expect((await call('POST', '/api/check/resources/batch', batch)).status).toBe(413);
    // Counted in bytes, not characters: 6,000 three-byte characters are 18,000 bytes.
    const multibyte = JSON.stringify({ attributes: { x: 'あ'.repeat(6000) } });
    expect(multibyte.length).toBeLessThan(CHECK_RESOURCE_BODY_MAX_BYTES);
    expect((await call('PUT', '/api/check/resources/documents/doc_1', multibyte)).status).toBe(413);
    expect(rows()).toEqual([]);
  });

  it('answers 413 from a declared Content-Length past the limit', async () => {
    const response = await call('PUT', '/api/check/resources/documents/doc_1', '{}', {
      'Content-Length': String(CHECK_RESOURCE_BODY_MAX_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  it('answers 400 for a body within the limit that is not JSON', async () => {
    expect((await call('PUT', '/api/check/resources/documents/doc_1', 'not json')).status).toBe(
      400
    );
  });
});

describe('ids a check can name', () => {
  it.each(['doc_1', 'DOC-1_v2', 'DOC-1.v2', 'a~b', 'caf%C3%A9', 'a'.repeat(256)])(
    'accepts %s, which the permission parser also accepts',
    async (id) => {
      expect((await call('PUT', `/api/check/resources/documents/${id}`, {})).status).toBe(200);
      expect(() => parsePermission(`documents:${id}:read`)).not.toThrow();
    }
  );
});

describe('rate limit', () => {
  it('answers 429 once the key is over its limit, leaving the rows unchanged', async () => {
    spies.authenticate.mockResolvedValue({ ...API_KEY_AUTH, rateLimitTier: 'strict' });
    expect(
      (await call('PUT', '/api/check/resources/documents/doc_1', { owner_id: 'user-1' })).status
    ).toBe(200);
    // The strict tier allows 100 a minute on the shared limiter: 99 more, then one over.
    for (let index = 0; index < 99; index++) {
      expect((await call('DELETE', '/api/check/resources/documents/none')).status).toBe(200);
    }
    const before = rows();
    const limited = await call('PUT', '/api/check/resources/documents/doc_1', {
      owner_id: 'user-2',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect((await call('DELETE', '/api/check/resources/documents/doc_1')).status).toBe(429);
    expect(rows()).toEqual(before);
  });
});

describe('tenant rules on registered attributes (the standard evaluator)', () => {
  /**
   * The core database as the check reads it: the registry tables from SQLite, every other read
   * (roles, groups, ID-level grants, relationships) empty.
   */
  function checkDatabase(): DatabaseAdapter {
    const registry = store.adapter;
    const isRegistry = (sql: string) => /check_resource/.test(sql);
    return {
      query: (sql: string, params?: unknown[]) =>
        isRegistry(sql) ? registry.query(sql, params) : Promise.resolve([]),
      queryOne: (sql: string, params?: unknown[]) =>
        isRegistry(sql) ? registry.queryOne(sql, params) : Promise.resolve(null),
      execute: () => Promise.resolve({ success: true, rowsAffected: 0 }),
      batch: () => Promise.resolve([]),
      transaction: <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
      isHealthy: () => Promise.resolve({ healthy: true, latencyMs: 0 }),
      getType: () => 'sqlite',
      close: () => Promise.resolve(),
    } as unknown as DatabaseAdapter;
  }

  const rules: TenantPolicyRule[] = [
    {
      id: 'deny_secret',
      name: 'No secret documents',
      priority: 100,
      effect: 'deny',
      conditions: [
        {
          type: 'resource_attribute_in',
          params: { attribute: 'classification', values: ['secret'] },
        },
      ],
      resourceTypes: ['documents'],
      actions: [],
    },
    {
      id: 'allow_internal_read',
      name: 'Internal documents are readable',
      priority: 10,
      effect: 'allow',
      conditions: [
        {
          type: 'resource_attribute_equals',
          params: { attribute: 'classification', value: 'internal' },
        },
      ],
      resourceTypes: ['documents'],
      actions: ['read'],
    },
  ];

  async function selfCheck(permission: string) {
    const db = checkDatabase();
    const service = createUnifiedCheckService({
      db,
      subjectAccount: async (_tenant, subjectId) => ({ db, subjectId }),
      tenantPolicy: async () => ({
        abac: true,
        verifiedAttributes: false,
        rebac: false,
        logDecisions: false,
        evaluator: createTenantRuleEvaluator(rules),
      }),
      resourceContextResolver: createCheckResourceContextResolver(store.adapter),
    });
    return service.check(
      { subject_id: 'user-1', permission, tenant_id: 'tenant-a' },
      { contract: 'self' }
    );
  }

  it('allows and denies on what the server registered', async () => {
    await call('PUT', '/api/check/resources/documents/doc_1', {
      attributes: { classification: 'internal' },
    });
    await call('PUT', '/api/check/resources/documents/doc_2', {
      attributes: { classification: 'secret' },
    });
    await call('PUT', '/api/check/resources/documents/doc_3', { owner_id: 'user-1' });

    expect(await selfCheck('documents:doc_1:read')).toMatchObject({
      allowed: true,
      resolved_via: ['computed'],
    });
    expect((await selfCheck('documents:doc_1:write')).allowed).toBe(false);
    expect((await selfCheck('documents:doc_2:read')).allowed).toBe(false);
    // No classification registered: the deny cannot be decided, so nothing is granted.
    expect((await selfCheck('documents:doc_3:read')).allowed).toBe(false);
    expect((await selfCheck('documents:unregistered:read')).allowed).toBe(false);
  });
});

describe('who may write the registry', () => {
  it.each([
    ['a key without the resources operation', { ...API_KEY_AUTH, allowedOperations: ['check'] }],
    [
      'an end-user access token',
      {
        authenticated: true,
        method: 'access_token',
        tenantId: 'tenant-a',
        subjectId: 'user-1',
        allowedOperations: ['check', 'batch'],
      },
    ],
    [
      'the policy service secret',
      {
        authenticated: true,
        method: 'policy_secret',
        allowedOperations: ['check', 'batch', 'subscribe', 'resources'],
      },
    ],
    ['a key without a tenant', { ...API_KEY_AUTH, tenantId: undefined }],
  ])('refuses %s with 403', async (_name, auth) => {
    spies.authenticate.mockResolvedValue(auth);
    for (const [method, path, body] of [
      ['PUT', '/api/check/resources/documents/doc_1', {}],
      ['DELETE', '/api/check/resources/documents/doc_1', undefined],
      ['POST', '/api/check/resources/batch', { items: [] }],
    ] as const) {
      expect((await call(method, path, body)).status).toBe(403);
    }
    expect(rows()).toEqual([]);
  });

  it('answers 401 for a credential that does not authenticate', async () => {
    spies.authenticate.mockResolvedValue({
      authenticated: false,
      error: 'invalid_token',
      errorDescription: 'Invalid API key',
      statusCode: 401,
    });
    expect((await call('PUT', '/api/check/resources/documents/doc_1', {})).status).toBe(401);
  });

  it('is off while the Check API is off', async () => {
    checkApiEnabled = false;
    expect((await call('PUT', '/api/check/resources/documents/doc_1', {})).status).toBe(403);
    expect(spies.authenticate).not.toHaveBeenCalled();
  });
});

describe('the default resolver of self-contract checks', () => {
  it('reads the registry, unless the in-memory override names the type', async () => {
    await call('PUT', '/api/check/resources/documents/doc_1', { owner_id: 'user-1' });
    store.db
      .prepare(
        `INSERT INTO check_resource_types (tenant_id, resource_type, relations_json, row_token, created_at, updated_at)
         VALUES ('tenant-a', 'documents', '{"read":"viewer"}', 'token-1', 1, 1)`
      )
      .run();
    const resolver = createCheckResourceContextResolver(store.adapter);
    const lookup = {
      tenantId: 'tenant-a',
      resourceType: 'documents',
      resourceId: 'doc_1',
      action: 'read',
      subjectId: 'user-1',
    };
    expect(await resolver.resolve(lookup)).toEqual({
      owner_id: 'user-1',
      rebac: { relation: 'viewer', object_type: 'documents', object_id: 'doc_1' },
    });

    const { checkResourceContextResolvers } = await import('../../resource-context-resolvers');
    checkResourceContextResolvers.register('tenant-a', 'documents', async () => ({
      group_id: 'override',
    }));
    try {
      expect(await resolver.resolve(lookup)).toEqual({ group_id: 'override' });
    } finally {
      checkResourceContextResolvers.unregister('tenant-a', 'documents');
    }
  });
});

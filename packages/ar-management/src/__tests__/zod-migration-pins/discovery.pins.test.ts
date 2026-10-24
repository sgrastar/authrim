/**
 * zod 3 -> 4 migration pins for discovery.ts
 * (DISCOVERY_REQUEST_SCHEMA, DISCOVERY_GRANT_CREATE_SCHEMA, DISCOVERY_GRANT_VERIFY_SCHEMA,
 *  DISCOVERY_EMAIL_START_SCHEMA, DISCOVERY_EMAIL_VERIFY_SCHEMA).
 *
 * discovery.ts writes its own `{ error, message }` bodies with `c.json`, so no
 * `createErrorResponse` mock is involved. The fixture below is copied from ../discovery.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => {
  const state = {
    tenants: [
      { id: 'default', tenant_code: 'default', name: 'Default Tenant', lifecycle_state: 'active' },
      { id: 'acme', tenant_code: 'acme', name: 'Acme Tenant', lifecycle_state: 'active' },
      { id: 'beta', tenant_code: 'beta', name: 'Beta Tenant', lifecycle_state: 'active' },
      {
        id: 'inactive',
        tenant_code: 'inactive',
        name: 'Inactive Tenant',
        lifecycle_state: 'suspended',
      },
    ],
    users: [
      { id: 'user-1', tenant_id: 'acme', email: 'user@gmail.com', is_active: 1 },
      { id: 'user-2', tenant_id: 'beta', email: 'shared@gmail.com', is_active: 1 },
      { id: 'user-3', tenant_id: 'acme', email: 'shared@gmail.com', is_active: 1 },
    ],
    clients: [
      { client_id: 'acme-web', tenant_id: 'acme' },
      { client_id: 'inactive-web', tenant_id: 'inactive' },
    ],
    invitations: [
      {
        id: 'invite-1',
        token: 'token-12345678901234567890123456789012',
        tenant_id: 'acme',
        invited_email: 'invited@example.com',
        max_uses: 1,
        use_count: 0,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
  };

  class FakeD1Adapter {
    constructor(_options: { db: unknown }) {}

    async query<T>(query: string, params: unknown[]): Promise<T[]> {
      if (query.includes('FROM users_pii WHERE email = ?')) {
        const email = String(params[0] ?? '');
        return state.users
          .filter((user) => user.email === email && user.is_active === 1)
          .map((user) => ({ id: user.id, tenant_id: user.tenant_id })) as T[];
      }
      if (query.includes('FROM tenants') && query.includes("WHERE lifecycle_state = 'active'")) {
        if (!query.includes('LIMIT 2')) {
          return state.tenants
            .filter((tenant) => tenant.lifecycle_state === 'active')
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) as T[];
        }
        return state.tenants
          .filter((tenant) => tenant.lifecycle_state === 'active')
          .slice(0, 2) as T[];
      }
      if (query.includes('FROM oauth_clients WHERE client_id = ?')) {
        return state.clients.filter((client) => client.client_id === params[0]) as T[];
      }

      return [];
    }

    async queryOne<T>(query: string, params: unknown[]): Promise<T | null> {
      if (query.includes('FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1')) {
        return (state.users.find(
          (user) => user.id === params[0] && user.tenant_id === params[1] && user.is_active === 1
        ) ?? null) as T | null;
      }
      if (query.includes('FROM tenants WHERE tenant_code = ?')) {
        return (state.tenants.find((tenant) => tenant.tenant_code === params[0]) ??
          null) as T | null;
      }
      if (query.includes("FROM tenants WHERE id = ? AND lifecycle_state = 'active'")) {
        return (state.tenants.find(
          (tenant) => tenant.id === params[0] && tenant.lifecycle_state === 'active'
        ) ?? null) as T | null;
      }
      if (query.includes('FROM tenant_invitations')) {
        const token = params[0];
        const now = Number(params[1]);
        return (state.invitations.find(
          (invitation) => invitation.token === token && invitation.expires_at > now
        ) ?? null) as T | null;
      }
      if (query.includes('FROM oauth_clients WHERE tenant_id = ? AND client_id = ?')) {
        return (state.clients.find(
          (client) => client.tenant_id === params[0] && client.client_id === params[1]
        ) ?? null) as T | null;
      }
      return null;
    }
  }

  return {
    state,
    discoveryCandidatesMock: vi.fn(),
    tenantAliasResolveMock: vi.fn(),
    tenantAliasesResolveManyMock: vi.fn(),
    tenantStoreResolveMock: vi.fn(),
    lookupAssignmentsMock: vi.fn(),
    FakeD1Adapter,
  };
});

function discoveryRouteProjection(tenantId: string) {
  return {
    schemaVersion: 1,
    tenantRouteGeneration: 8,
    residencyPolicyId: 'default-policy',
    target: {
      dataRole: 'tenant_core/default' as const,
      residencyPartition: 'default',
      shardId: `default-${tenantId}`,
      bindingRef: `TDB_${tenantId.toUpperCase()}_DEFAULT`,
      requiredBindingRouteGeneration: 8,
    },
  };
}

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    D1Adapter: mocked.FakeD1Adapter,
    ensureDatabaseAdapter: vi.fn((source: unknown) => {
      if (
        source &&
        typeof source === 'object' &&
        'query' in source &&
        'queryOne' in source &&
        'execute' in source
      ) {
        return source;
      }

      return new mocked.FakeD1Adapter({ db: source });
    }),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (_env: Partial<Env>) => new mocked.FakeD1Adapter({ db: {} })
    ),
    loadVerifiedLookupBucketAssignmentProvider: mocked.lookupAssignmentsMock,
    LookupRouteResolver: class {
      async resolveAlias(input: unknown) {
        return mocked.tenantAliasResolveMock(input);
      }

      async resolveAliases(input: unknown) {
        return mocked.tenantAliasesResolveManyMock(input);
      }
    },
    resolveTenantDatabaseSourceFromRegistry: mocked.tenantStoreResolveMock,
    resolveTenantCandidatesFromEmailDomain: mocked.discoveryCandidatesMock,
    CanonicalRuntimeUserStore: class {
      private tenantId: string;

      constructor(options: { tenantId: string }) {
        this.tenantId = options.tenantId;
      }

      async findByEmail(email: string) {
        const user = mocked.state.users.find(
          (candidate) =>
            candidate.email === email &&
            candidate.tenant_id === this.tenantId &&
            candidate.is_active === 1
        );
        return user ? { id: user.id, tenant_id: user.tenant_id, email: user.email } : null;
      }
    },
  };
});

import {
  clearTenantCandidatePresentationCacheForTest,
  getDiscoveryConfigHandler,
  postDiscoveryEmailStartHandler,
  postDiscoveryEmailVerifyHandler,
  postDiscoveryGrantHandler,
  postDiscoveryGrantVerifyHandler,
  postDiscoveryHandler,
} from '../../discovery';

function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createMockAdapter(
  options: {
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
  } = {}
) {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn(
      async (sql: string, params: unknown[]) => options.queryOne?.(sql, params) ?? null
    ),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: any) => fn()),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createDiscoveryApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const host = (
      c.req.header('X-Authrim-Original-Host') ||
      c.req.header('X-Forwarded-Host') ||
      c.req.header('Host') ||
      ''
    )
      .split(':')[0]
      .toLowerCase();
    const tenantId =
      host === 'login.acme.example.com'
        ? 'acme'
        : host.startsWith('beta.')
          ? 'beta'
          : host.startsWith('acme.')
            ? 'acme'
            : 'default';
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    await next();
  });
  app.get('/api/auth/discovery', getDiscoveryConfigHandler);
  app.post('/api/auth/discovery', postDiscoveryHandler);
  app.post('/api/auth/discovery/email/start', postDiscoveryEmailStartHandler);
  app.post('/api/auth/discovery/email/verify', postDiscoveryEmailVerifyHandler);
  app.post('/api/auth/discovery/grant', postDiscoveryGrantHandler);
  app.post('/api/auth/discovery/grant/verify', postDiscoveryGrantVerifyHandler);

  const env = {
    DB: createMockAdapter(),
    DB_PII: createMockAdapter(),
    SETTINGS: createMockKV({
      'settings:tenant:default:login-entry': JSON.stringify({
        'login-entry.override_enabled': true,
        'login-entry.discovery_methods': '["email_exact","tenant_code","tenant_slug","app_hint"]',
      }),
      'settings:platform:tenant-discovery-ui': JSON.stringify({
        'tenant-discovery-ui.brand_name': 'Shared Discovery',
        'tenant-discovery-ui.theme': 'dark',
        'tenant-discovery-ui.variant': 'navy',
        'tenant-discovery-ui.title_text': 'Find your workspace',
      }),
      'settings:tenant:acme:login-ui': JSON.stringify({
        'login-ui.brand_name': 'Acme Brand',
        'login-ui.logo_url': 'https://cdn.example.com/acme-login.png',
      }),
      'settings:tenant:acme:tenant-discovery-ui': JSON.stringify({
        'tenant-discovery-ui.override_enabled': true,
        'tenant-discovery-ui.title_text': 'Find Acme',
        'tenant-discovery-ui.logo_url': 'https://cdn.example.com/acme-discovery.png',
      }),
      'settings:tenant:beta:login-ui': JSON.stringify({
        'login-ui.brand_name': 'Beta Brand',
      }),
    }),
    AUTHRIM_CONFIG: createMockKV({
      'settings:tenant:acme:tenant': JSON.stringify({
        'tenant.logo_uri': 'https://cdn.example.com/acme-tenant.png',
        'tenant.allowed_domains': 'login.acme.example.com',
        'tenant.allowed_identifiers': 'https://login.acme.example.com',
      }),
      'settings:tenant:beta:tenant': JSON.stringify({
        'tenant.logo_uri': 'https://cdn.example.com/beta-tenant.png',
      }),
    }),
    BASE_DOMAIN: 'auth.example.com',
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY: createMockKV(),
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
    DEFAULT_TENANT_ID: 'default',
    ISSUER_URL: 'https://default.auth.example.com',
    OTP_HMAC_SECRET: 'test-discovery-grant-secret',
    ...envOverrides,
  } as unknown as Env;

  return { app, env };
}

async function post(path: string, body: unknown, host = 'auth.example.com', raw?: string) {
  const { app, env } = createDiscoveryApp();
  const response = await app.request(
    `https://${host}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': host },
      body: raw ?? JSON.stringify(body),
    },
    env
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cacheControl: response.headers.get('Cache-Control'),
  };
}

const invalidRequest = (message: string) => ({
  status: 400,
  body: { error: 'invalid_request', message },
});
const MODE_ENUM = "'email' | 'tenant_code' | 'tenant_slug' | 'wayf' | 'invite_token' | 'app_hint'";

beforeEach(() => {
  clearTenantCandidatePresentationCacheForTest();
  mocked.discoveryCandidatesMock.mockReset();
  mocked.tenantAliasResolveMock.mockReset();
  mocked.tenantAliasesResolveManyMock.mockReset();
  mocked.tenantStoreResolveMock.mockReset();
  mocked.lookupAssignmentsMock.mockReset();
  mocked.lookupAssignmentsMock.mockResolvedValue({});
  mocked.tenantAliasResolveMock.mockImplementation(
    async (input: { index?: { aliasKind?: string } }) => {
      if (
        input.index?.aliasKind !== 'tenant_code' &&
        input.index?.aliasKind !== 'invitation_token'
      ) {
        return null;
      }
      return { tenantId: 'acme', routeProjection: discoveryRouteProjection('acme') };
    }
  );
  mocked.tenantAliasesResolveManyMock.mockImplementation(
    async (input: { index?: { aliasKind?: string } }) => {
      if (input.index?.aliasKind === 'environment_tenant') {
        return mocked.state.tenants
          .filter((tenant) => tenant.lifecycle_state === 'active')
          .map((tenant) => ({
            tenantId: tenant.id,
            routeProjection: discoveryRouteProjection(tenant.id),
          }));
      }
      if (input.index?.aliasKind === 'client_id') {
        return [{ tenantId: 'acme', routeProjection: discoveryRouteProjection('acme') }];
      }
      return [];
    }
  );
  mocked.tenantStoreResolveMock.mockImplementation(
    async (_env: Env, input: { tenantId: string }) => ({
      source: new mocked.FakeD1Adapter({ db: {} }),
      bindingRef: `TDB_${input.tenantId.toUpperCase()}_DEFAULT`,
      bindingRouteGeneration: 8,
      runtimeGeneration: 8,
      residencyPolicyId: 'default-policy',
      residencyPartition: 'default',
      shardId: `default-${input.tenantId}`,
    })
  );
});

describe('zod pins: DISCOVERY_REQUEST_SCHEMA (POST /api/auth/discovery)', () => {
  const discover = (body: unknown) => post('/api/auth/discovery', body);

  it('missing / wrong-typed / out-of-range fields', async () => {
    expect((await discover({})).body).toEqual({
      error: 'invalid_request',
      message: 'Required, Required',
    });
    expect(await discover(null)).toMatchObject(invalidRequest('Expected object, received null'));
    expect(await discover([])).toMatchObject(invalidRequest('Expected object, received array'));
    expect(await discover('x')).toMatchObject(invalidRequest('Expected object, received string'));
    expect(await discover({ mode: 'nope', value: 'x' })).toMatchObject(
      invalidRequest(`Invalid enum value. Expected ${MODE_ENUM}, received 'nope'`)
    );
    expect(await discover({ mode: 5, value: 'x' })).toMatchObject(
      invalidRequest(`Expected ${MODE_ENUM}, received number`)
    );
    expect(await discover({ mode: 'email' })).toMatchObject(invalidRequest('Required'));
    expect(await discover({ mode: 'email', value: '' })).toMatchObject(
      invalidRequest('String must contain at least 1 character(s)')
    );
    expect(await discover({ mode: 'email', value: 'x'.repeat(2049) })).toMatchObject(
      invalidRequest('String must contain at most 2048 character(s)')
    );
    expect(await discover({ mode: 'email', value: 5 })).toMatchObject(
      invalidRequest('Expected string, received number')
    );
    expect(await discover({ mode: 'x', value: 5 })).toMatchObject(
      invalidRequest(
        `Invalid enum value. Expected ${MODE_ENUM}, received 'x', Expected string, received number`
      )
    );
  });

  it('malformed JSON falls into the generic 500 handler', async () => {
    const result = await post('/api/auth/discovery', undefined, 'auth.example.com', '{oops');
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: 'server_error',
      message: 'Failed to resolve discovery request',
    });
  });

  it('valid bodies pass validation (unknown keys ignored, 2048-char value accepted)', async () => {
    const ok = await discover({ mode: 'app_hint', value: 'x', extra: 1 });
    expect(ok).toMatchObject({ status: 200 });
    const long = await discover({ mode: 'app_hint', value: 'x'.repeat(2048) });
    expect(long).toMatchObject({ status: 200 });
    expect(long.body).toEqual(ok.body);
  });
});

describe('zod pins: DISCOVERY_GRANT_CREATE_SCHEMA (POST /api/auth/discovery/grant)', () => {
  const grant = (body: unknown) => post('/api/auth/discovery/grant', body);

  it('required / length / url issues', async () => {
    expect(await grant({})).toMatchObject(invalidRequest('Required'));
    expect(await grant(null)).toMatchObject(invalidRequest('Expected object, received null'));
    expect(await grant({ tenant_id: '' })).toMatchObject(
      invalidRequest('String must contain at least 1 character(s)')
    );
    expect(await grant({ tenant_id: 't'.repeat(256) })).toMatchObject(
      invalidRequest('String must contain at most 255 character(s)')
    );
    expect(await grant({ tenant_id: 5 })).toMatchObject(
      invalidRequest('Expected string, received number')
    );
    expect(await grant({ tenant_id: 'acme', expected_tenant_id: '' })).toMatchObject(
      invalidRequest('String must contain at least 1 character(s)')
    );
    expect(await grant({ tenant_id: 'acme', return_to: 'not a url' })).toMatchObject(
      invalidRequest('Invalid url')
    );
    expect(await grant({ tenant_id: 'acme', return_to: '/relative/path' })).toMatchObject(
      invalidRequest('Invalid url')
    );
    expect(await grant({ tenant_id: 'acme', return_to: '' })).toMatchObject(
      invalidRequest('Invalid url')
    );
    expect(
      await grant({ tenant_id: 'acme', return_to: `https://example.com/${'a'.repeat(2048)}` })
    ).toMatchObject(invalidRequest('String must contain at most 2048 character(s)'));
    expect(await grant({ tenant_id: 'acme', login_hint: '' })).toMatchObject(
      invalidRequest('String must contain at least 1 character(s)')
    );
    expect(await grant({ tenant_id: 'acme', login_hint: 'h'.repeat(321) })).toMatchObject(
      invalidRequest('String must contain at most 320 character(s)')
    );
    expect(
      await grant({ tenant_id: 1, expected_tenant_id: 2, return_to: 3, login_hint: 4 })
    ).toMatchObject(
      invalidRequest(
        'Expected string, received number, Expected string, received number, Expected string, received number, Expected string, received number'
      )
    );
  });

  it('z.string().url() syntax edge cases: zod 3 accepts any WHATWG-parsable URL (status/error per value)', async () => {
    const values = [
      'https://login.acme.example.com/login',
      'http://example.com',
      'ftp://example.com/x',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'data:text/plain,hello',
      'file:///etc/passwd',
      'https://',
      '//example.com',
      'example.com',
      'https://exa mple.com',
      ' https://example.com',
    ];
    const outcome: Record<string, string> = {};
    for (const return_to of values) {
      const result = await grant({ tenant_id: 'acme', return_to });
      outcome[return_to] =
        result.status === 400 && result.body.message === 'Invalid url'
          ? 'zod-invalid-url'
          : `passed-zod:${result.status}`;
    }
    expect(outcome).toEqual({
      'https://login.acme.example.com/login': 'passed-zod:200',
      'http://example.com': 'passed-zod:200',
      'ftp://example.com/x': 'passed-zod:200',
      'javascript:alert(1)': 'passed-zod:200',
      'mailto:a@example.com': 'passed-zod:200',
      'data:text/plain,hello': 'passed-zod:200',
      'file:///etc/passwd': 'passed-zod:200',
      'https://': 'zod-invalid-url',
      '//example.com': 'zod-invalid-url',
      'example.com': 'zod-invalid-url',
      'https://exa mple.com': 'zod-invalid-url',
      // leading whitespace is tolerated because zod 3 validates with `new URL(value)`
      ' https://example.com': 'passed-zod:200',
    });
  });

  it('valid body issues a grant; optional fields and unknown keys are accepted', async () => {
    const result = await grant({
      tenant_id: 'acme',
      expected_tenant_id: 'acme',
      login_hint: 'a@b.co',
      extra: 1,
    });
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['grant', 'login_url']);
    expect(String(result.body.login_url)).toMatch(
      /^https:\/\/acme\.auth\.example\.com\/login\?.*discovery_grant=/
    );
  });

  it('unknown tenant after validation is a 404 with a hand-written body', async () => {
    expect(await grant({ tenant_id: 'missing' })).toMatchObject({
      status: 404,
      body: { error: 'not_found', message: 'Tenant not found' },
    });
  });
});

describe('zod pins: DISCOVERY_GRANT_VERIFY_SCHEMA (POST /api/auth/discovery/grant/verify)', () => {
  const verify = (body: unknown) =>
    post('/api/auth/discovery/grant/verify', body, 'login.acme.example.com');

  it('required / length / url issues', async () => {
    expect(await verify({})).toMatchObject(invalidRequest('Required, Required'));
    expect(await verify(null)).toMatchObject(invalidRequest('Expected object, received null'));
    expect(
      await verify({ grant: '', current_url: 'https://login.acme.example.com/login' })
    ).toMatchObject(invalidRequest('String must contain at least 1 character(s)'));
    expect(
      await verify({ grant: 'g'.repeat(8193), current_url: 'https://login.acme.example.com/login' })
    ).toMatchObject(invalidRequest('String must contain at most 8192 character(s)'));
    expect(await verify({ grant: 'g', current_url: 'nope' })).toMatchObject(
      invalidRequest('Invalid url')
    );
    expect(await verify({ grant: 5, current_url: 6 })).toMatchObject(
      invalidRequest('Expected string, received number, Expected string, received number')
    );
  });

  it('schema-valid but unverifiable grants reach jwtVerify and fail with invalid_grant (distinguishes validation from verification)', async () => {
    expect(
      await verify({ grant: 'g'.repeat(8192), current_url: 'https://login.acme.example.com/login' })
    ).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant', message: 'Invalid discovery grant' },
    });
    expect(await verify({ grant: 'not-a-jwt', current_url: 'javascript:alert(1)' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant', message: 'Invalid discovery grant' },
    });
  });
});

describe('zod pins: DISCOVERY_EMAIL_START_SCHEMA / DISCOVERY_EMAIL_VERIFY_SCHEMA', () => {
  const start = (body: unknown) =>
    post('/api/auth/discovery/email/start', body, 'login.example.com');
  const verify = (body: unknown) =>
    post('/api/auth/discovery/email/verify', body, 'login.example.com');

  it('email start: schema failures return a bare invalid_request with no-store', async () => {
    const expected = { status: 400, body: { error: 'invalid_request' }, cacheControl: 'no-store' };
    expect(await start({})).toEqual(expected);
    expect(await start(null)).toEqual(expected);
    expect(await start({ email: 5 })).toEqual(expected);
    expect(await start({ email: 'ab' })).toEqual(expected);
    expect(await start({ email: 'a'.repeat(321) })).toEqual(expected);
  });

  it('email start: min(3)/max(320) is not an email check (non-email strings pass the schema)', async () => {
    // 'abc' / 'not an email' pass zod and are then rejected by the OTP service
    // (`lookup_email_invalid`), which maps to the very same bare invalid_request body.
    const sameBody = { status: 400, body: { error: 'invalid_request' }, cacheControl: 'no-store' };
    expect(await start({ email: 'abc' })).toEqual(sameBody);
    expect(await start({ email: 'not an email', extra: 1 })).toEqual(sameBody);
    // a plausible address passes both and reaches the (unavailable) OTP provider
    const unavailable = {
      status: 503,
      body: { error: 'temporarily_unavailable' },
      cacheControl: 'no-store',
    };
    expect(await start({ email: 'person@example.com', extra: 1 })).toEqual(unavailable);
  });

  it('email verify: schema failures return a bare invalid_request', async () => {
    const expected = { status: 400, body: { error: 'invalid_request' }, cacheControl: 'no-store' };
    expect(await verify({})).toEqual(expected);
    expect(await verify({ challenge_id: '', code: '123456' })).toEqual(expected);
    expect(await verify({ challenge_id: 'c'.repeat(129), code: '123456' })).toEqual(expected);
    expect(await verify({ challenge_id: 'c', code: '12345' })).toEqual(expected);
    expect(await verify({ challenge_id: 'c', code: '1234567' })).toEqual(expected);
    expect(await verify({ challenge_id: 'c', code: '12345a' })).toEqual(expected);
    expect(await verify({ challenge_id: 'c', code: '123456\n' })).toEqual(expected);
    expect(
      await verify({ challenge_id: 'c', code: '\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16' })
    ).toEqual(expected);
    expect(await verify({ challenge_id: 'c', code: 123456 })).toEqual(expected);
  });

  it('email verify: schema-valid bodies move past validation (unknown challenge -> invalid_or_expired_code)', async () => {
    const unknownChallenge = {
      status: 400,
      body: { error: 'invalid_or_expired_code' },
      cacheControl: 'no-store',
    };
    expect(await verify({ challenge_id: 'c', code: '000000' })).toEqual(unknownChallenge);
    expect(await verify({ challenge_id: 'c'.repeat(128), code: '123456', extra: true })).toEqual(
      unknownChallenge
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

/**
 * Discovery API isolation and mode-switching integration tests.
 *
 * Complements the basic-behaviour coverage in discovery.test.ts by testing:
 * - Single-tenant vs. multi-tenant mode switching
 * - Host-based tenant context (is_common_entry_host)
 * - tenant_slug resolution
 * - Tenant data isolation (email / tenant_code / app_hint / invite_token)
 * - Settings-driven behaviour (allow_manual_tenant_entry, disabled methods)
 * - Resolved-candidate structure (login_url, display_name fallback)
 * - Request validation
 *
 * Design notes:
 * - resolveTenantCandidatesFromEmailDomain uses `INNER JOIN tenants … AND tenants.lifecycle_state = 'active'`
 *   so the email mock must never return inactive tenants (mirrors real DB behaviour).
 * - FakeD1Adapter applies lifecycle_state = 'active' on tenant_code lookups, fixing a gap in
 *   the existing discovery.test.ts fixture.
 */

const mocked = vi.hoisted(() => {
  // vi.hoisted() executes before any module-level statements, so NOW must be
  // defined here rather than at the top of the file.
  const NOW = Math.floor(Date.now() / 1000);

  const state = {
    tenants: [
      { id: 'default', tenant_code: 'default', name: 'Default Tenant', lifecycle_state: 'active' },
      { id: 'acme', tenant_code: 'acme-code', name: 'Acme Corp', lifecycle_state: 'active' },
      { id: 'beta', tenant_code: 'beta-code', name: 'Beta Inc', lifecycle_state: 'active' },
      {
        id: 'inactive',
        tenant_code: 'inactive-code',
        name: 'Gone Co',
        lifecycle_state: 'suspended',
      },
    ],
    users: [
      { id: 'user-1', tenant_id: 'acme', email: 'user@gmail.com', is_active: 1 },
      { id: 'user-2', tenant_id: 'acme', email: 'shared@gmail.com', is_active: 1 },
      { id: 'user-3', tenant_id: 'beta', email: 'shared@gmail.com', is_active: 1 },
      { id: 'user-4', tenant_id: 'inactive', email: 'inactive@gmail.com', is_active: 1 },
    ],
    clients: [
      { client_id: 'acme-app', tenant_id: 'acme' },
      { client_id: 'beta-app', tenant_id: 'beta' },
      { client_id: 'inactive-app', tenant_id: 'inactive' },
    ],
    invitations: [
      {
        id: 'inv-1',
        token: 'valid-token',
        tenant_id: 'acme',
        invited_email: 'user@acme.com',
        max_uses: -1,
        use_count: 0,
        expires_at: NOW + 3600,
      },
      {
        id: 'inv-2',
        token: 'expired-token',
        tenant_id: 'acme',
        invited_email: null,
        max_uses: -1,
        use_count: 0,
        expires_at: NOW - 1,
      },
      {
        id: 'inv-3',
        token: 'exhausted-token',
        tenant_id: 'acme',
        invited_email: null,
        max_uses: 1,
        use_count: 1,
        expires_at: NOW + 3600,
      },
      {
        id: 'inv-4',
        token: 'inactive-token',
        tenant_id: 'inactive',
        invited_email: null,
        max_uses: -1,
        use_count: 0,
        expires_at: NOW + 3600,
      },
    ],
  };

  /**
   * FakeD1Adapter accurately mirrors the SQL filters used in discovery.ts.
   *
   * Key difference from the existing discovery.test.ts fixture:
   * - tenant_code lookups apply AND lifecycle_state = 'active', matching the real SQL:
   *   `WHERE tenant_code = ? AND lifecycle_state = 'active'`
   */
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
        return state.tenants.filter((tenant) => tenant.lifecycle_state === 'active') as T[];
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
      // Tenant lookup by tenant_code — lifecycle_state = 'active' filter applied
      if (query.includes("FROM tenants WHERE tenant_code = ? AND lifecycle_state = 'active'")) {
        return (state.tenants.find(
          (t) => t.tenant_code === params[0] && t.lifecycle_state === 'active'
        ) ?? null) as T | null;
      }

      // Tenant lookup by id — lifecycle_state = 'active' filter applied
      if (query.includes("FROM tenants WHERE id = ? AND lifecycle_state = 'active'")) {
        return (state.tenants.find((t) => t.id === params[0] && t.lifecycle_state === 'active') ??
          null) as T | null;
      }

      // Invitation lookup — expires_at > now filter applied
      if (query.includes('FROM tenant_invitations')) {
        const token = params[0];
        const now = Number(params[1]);
        return (state.invitations.find((inv) => inv.token === token && inv.expires_at > now) ??
          null) as T | null;
      }

      return null;
    }
  }

  return {
    state,
    discoveryCandidatesMock: vi.fn(),
    resolveUserStoreRuntimeSourcesMock: vi.fn(),
    FakeD1Adapter,
  };
});

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
    resolveTenantCandidatesFromEmailDomain: mocked.discoveryCandidatesMock,
    resolveUserStoreRuntimeSourcesFromEnv: mocked.resolveUserStoreRuntimeSourcesMock,
  };
});

import { getDiscoveryConfigHandler, postDiscoveryHandler } from '../discovery';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a Hono test app wired to the discovery handlers.
 *
 * @param envOverrides  Fields to merge into the default Env.
 * @param tenantId      Tenant ID injected into Hono context, simulating
 *                      the subdomain resolved by validateHostHeader middleware.
 */
function createDiscoveryApp(envOverrides: Partial<Env> = {}, tenantId = 'default') {
  const app = new Hono<{ Bindings: Env }>();

  // Inject tenantId into context (replaces the real validateHostHeader middleware).
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    await next();
  });

  app.get('/api/auth/discovery', getDiscoveryConfigHandler);
  app.post('/api/auth/discovery', postDiscoveryHandler);

  const env = {
    DB: createMockAdapter(),
    DB_PII: createMockAdapter(),
    SETTINGS: createMockKV({
      'settings:platform:tenant-discovery-ui': JSON.stringify({
        'tenant-discovery-ui.brand_name': 'Shared Discovery',
        'tenant-discovery-ui.theme': 'dark',
      }),
      // Default tenant: all discovery methods enabled
      'settings:tenant:default:login-entry': JSON.stringify({
        'login-entry.override_enabled': true,
        'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug","app_hint"]',
      }),
      // Acme tenant branding (login-ui.brand_name takes precedence over tenant name)
      'settings:tenant:acme:login-ui': JSON.stringify({
        'login-ui.brand_name': 'Acme Brand',
      }),
      'settings:tenant:acme:tenant-discovery-ui': JSON.stringify({
        'tenant-discovery-ui.override_enabled': true,
        'tenant-discovery-ui.title_text': 'Find Acme',
      }),
      // Acme tenant login-entry: app_hint excluded (used by tenant-subdomain context tests)
      'settings:tenant:acme:login-entry': JSON.stringify({
        'login-entry.override_enabled': true,
        'login-entry.mode': 'discovery_optional',
        'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug"]',
      }),
      // Beta tenant: no branding configured — display_name falls back to tenant.name
    }),
    AUTHRIM_CONFIG: createMockKV(),
    BASE_DOMAIN: 'auth.example.com',
    DEFAULT_TENANT_ID: 'default',
    ISSUER_URL: 'https://default.auth.example.com',
    ...envOverrides,
  } as unknown as Env;

  return { app, env };
}

/** Helper: POST /api/auth/discovery with a JSON body. */
async function postDiscovery(
  app: ReturnType<typeof createDiscoveryApp>['app'],
  env: ReturnType<typeof createDiscoveryApp>['env'],
  body: Record<string, unknown>,
  host = 'login.auth.example.com'
) {
  return app.request(
    'https://login.auth.example.com/api/auth/discovery',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': host,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discovery API: single-tenant mode (BASE_DOMAIN not set)', () => {
  beforeEach(() => {
    mocked.discoveryCandidatesMock.mockReset();
  });

  it('GET returns single_tenant_mode: true', async () => {
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await app.request(
      'https://worker.example.com/api/auth/discovery',
      { method: 'GET' },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { single_tenant_mode: boolean };
    expect(body.single_tenant_mode).toBe(true);
  });

  it('GET populates default_candidate with the default tenant', async () => {
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await app.request(
      'https://worker.example.com/api/auth/discovery',
      { method: 'GET' },
      env
    );

    const body = (await res.json()) as {
      default_candidate: { tenant_id: string; source: string } | undefined;
    };
    expect(body.default_candidate).toBeDefined();
    expect(body.default_candidate?.tenant_id).toBe('default');
    expect(body.default_candidate?.source).toBe('tenant_slug');
  });

  it('GET returns is_common_entry_host: false (always false in single-tenant mode)', async () => {
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await app.request(
      'https://worker.example.com/api/auth/discovery',
      { method: 'GET' },
      env
    );

    const body = (await res.json()) as { is_common_entry_host: boolean };
    expect(body.is_common_entry_host).toBe(false);
  });

  it('POST mode email resolves to the default tenant regardless of input', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([]);
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await postDiscovery(app, env, { mode: 'email', value: 'user@acme.com' });
    const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

    // isSingleTenantMode short-circuit fires before the email branch
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('default');
  });

  it('POST mode tenant_code resolves to the default tenant regardless of code value', async () => {
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'any-code' });
    const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('default');
  });

  it('POST mode tenant_slug resolves to the default tenant regardless of slug value', async () => {
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await postDiscovery(app, env, { mode: 'tenant_slug', value: 'acme' });
    const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('default');
  });

  it('POST mode invite_token resolves to the actual tenant even in single-tenant mode', async () => {
    const { app, env } = createDiscoveryApp({ BASE_DOMAIN: undefined });

    const res = await postDiscovery(app, env, { mode: 'invite_token', value: 'valid-token' });
    const body = (await res.json()) as {
      result: string;
      candidate: { tenant_id: string };
      invited_email: string | null;
    };

    // invite_token is exempt from the isSingleTenantMode short-circuit
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('acme');
    expect(body.invited_email).toBe('user@acme.com');
  });
});

describe('Discovery API: multi-tenant GET response', () => {
  it('returns single_tenant_mode: false when BASE_DOMAIN is set', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await app.request(
      'https://auth.example.com/api/auth/discovery',
      { method: 'GET', headers: { 'X-Forwarded-Host': 'auth.example.com' } },
      env
    );

    const body = (await res.json()) as { single_tenant_mode: boolean };
    expect(body.single_tenant_mode).toBe(false);
  });

  it('omits default_candidate in multi-tenant mode', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await app.request(
      'https://auth.example.com/api/auth/discovery',
      { method: 'GET', headers: { 'X-Forwarded-Host': 'auth.example.com' } },
      env
    );

    const body = (await res.json()) as { default_candidate?: unknown };
    expect(body.default_candidate).toBeUndefined();
  });
});

describe('Discovery API: host-based tenant context (is_common_entry_host)', () => {
  it('returns is_common_entry_host: true when Host equals BASE_DOMAIN', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await app.request(
      'https://auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'auth.example.com' },
      },
      env
    );

    const body = (await res.json()) as { is_common_entry_host: boolean };
    expect(body.is_common_entry_host).toBe(true);
  });

  it('returns is_common_entry_host: false when Host equals BASE_DOMAIN in naked-domain issuer mode', async () => {
    const { app, env } = createDiscoveryApp(
      {
        NAKED_DOMAIN_AS_ISSUER: 'true',
        PRIMARY_TENANT_ID: 'default',
      },
      'default'
    );

    const res = await app.request(
      'https://auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'auth.example.com' },
      },
      env
    );

    const body = (await res.json()) as { is_common_entry_host: boolean };
    expect(body.is_common_entry_host).toBe(false);
  });

  it('returns is_common_entry_host: false when Host is a tenant subdomain', async () => {
    const { app, env } = createDiscoveryApp({}, 'acme');

    const res = await app.request(
      'https://acme.auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'acme.auth.example.com' },
      },
      env
    );

    const body = (await res.json()) as { is_common_entry_host: boolean };
    expect(body.is_common_entry_host).toBe(false);
  });

  it('returns is_common_entry_host: false for custom tenant domains when tenant context is resolved', async () => {
    const { app, env } = createDiscoveryApp({}, 'acme');

    const res = await app.request(
      'https://login.acme.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'login.acme.example.com' },
      },
      env
    );

    const body = (await res.json()) as { is_common_entry_host: boolean };
    expect(body.is_common_entry_host).toBe(false);
  });

  it("GET from a tenant subdomain applies that tenant's login-entry settings", async () => {
    const { app, env } = createDiscoveryApp({}, 'acme');

    const res = await app.request(
      'https://acme.auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'acme.auth.example.com' },
      },
      env
    );

    const body = (await res.json()) as {
      config: { tenant_id: string; discovery_methods: string[] };
    };
    expect(body.config.tenant_id).toBe('acme');
    // acme's login-entry settings exclude app_hint
    expect(body.config.discovery_methods).not.toContain('app_hint');
  });

  it("GET from a tenant subdomain applies that tenant's discovery UI override", async () => {
    const { app, env } = createDiscoveryApp({}, 'acme');

    const res = await app.request(
      'https://acme.auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'acme.auth.example.com' },
      },
      env
    );

    const body = (await res.json()) as {
      ui: { title_text: string; brand_name: string; theme: string };
    };
    expect(body.ui.title_text).toBe('Find Acme');
    expect(body.ui.brand_name).toBe('Shared Discovery');
    expect(body.ui.theme).toBe('dark');
  });
});

describe('Discovery API: tenant_slug resolution', () => {
  it('resolves a valid tenant slug', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_slug', value: 'acme' });
    const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

    expect(res.status).toBe(200);
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('acme');
  });

  it('returns not_found for an unknown slug', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_slug', value: 'nonexistent' });
    const body = (await res.json()) as { result: string; code: string };

    expect(body.result).toBe('not_found');
    expect(body.code).toBe('tenant_slug_not_found');
  });

  it('returns not_found for a suspended tenant slug', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_slug', value: 'inactive' });
    const body = (await res.json()) as { result: string; code: string };

    expect(body.result).toBe('not_found');
    expect(body.code).toBe('tenant_slug_not_found');
  });

  it('returns manual_required when tenant_slug is not in discovery_methods', async () => {
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods': '["email_domain","tenant_code"]',
        }),
      }),
    });

    const res = await postDiscovery(app, env, { mode: 'tenant_slug', value: 'acme' });
    const body = (await res.json()) as { result: string };

    expect(body.result).toBe('manual_required');
  });
});

describe('Discovery API: data isolation', () => {
  beforeEach(() => {
    mocked.discoveryCandidatesMock.mockReset();
    const defaultPiiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT id, tenant_id FROM users_pii WHERE email = ? AND tenant_id = ?')) {
          const email = String(params[0] ?? '');
          const tenantId = String(params[1] ?? '');
          const user =
            mocked.state.users.find(
              (candidate) =>
                candidate.email === email &&
                candidate.tenant_id === tenantId &&
                candidate.is_active === 1
            ) ?? null;
          return user ? { id: user.id, tenant_id: user.tenant_id } : null;
        }

        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesMock.mockImplementation(async (env: Partial<Env>) => ({
      storageProfile: {
        id: 'builtin:storage:standard',
        kind: 'storage',
        label: 'Standard D1 Split',
        slices: {},
      },
      coreDb: env.DB,
      piiDb: defaultPiiAdapter,
    }));
  });

  describe('email domain isolation', () => {
    it('resolves a unique exact email match even when the domain itself is shared', async () => {
      mocked.discoveryCandidatesMock.mockResolvedValue([
        { tenant_id: 'acme', priority: 20 },
        { tenant_id: 'beta', priority: 10 },
      ]);
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'email', value: 'user@gmail.com' });
      const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

      expect(body.result).toBe('resolved');
      expect(body.candidate.tenant_id).toBe('acme');
    });

    it('returns multiple candidates when the exact email exists in multiple active tenants', async () => {
      mocked.discoveryCandidatesMock.mockResolvedValue([]);
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'email', value: 'shared@gmail.com' });
      const body = (await res.json()) as {
        result: string;
        candidates: Array<{ tenant_id: string }>;
      };

      expect(body.result).toBe('multiple');
      expect(body.candidates.map((candidate) => candidate.tenant_id)).toEqual(['acme', 'beta']);
    });

    it('resolves to acme only when the domain maps exclusively to acme', async () => {
      mocked.discoveryCandidatesMock.mockResolvedValue([{ tenant_id: 'acme', priority: 10 }]);
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'email', value: 'user@acme.com' });
      const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

      expect(body.result).toBe('resolved');
      expect(body.candidate.tenant_id).toBe('acme');
    });

    it('returns multiple candidates when the domain maps to both acme and beta', async () => {
      mocked.discoveryCandidatesMock.mockResolvedValue([
        { tenant_id: 'acme', priority: 20 },
        { tenant_id: 'beta', priority: 10 },
      ]);
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'email', value: 'user@shared.com' });
      const body = (await res.json()) as {
        result: string;
        candidates: Array<{ tenant_id: string }>;
      };

      expect(body.result).toBe('multiple');
      expect(body.candidates).toHaveLength(2);
      expect(body.candidates.map((c) => c.tenant_id)).toEqual(['acme', 'beta']);
    });

    it('returns manual_required when no tenant maps to the email domain', async () => {
      // Real SQL already excludes inactive tenants, so unknown domains return []
      mocked.discoveryCandidatesMock.mockResolvedValue([]);
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'email', value: 'user@unknown.com' });
      const body = (await res.json()) as { result: string };

      expect(body.result).toBe('manual_required');
    });

    it('returns manual_required without querying the DB when email_domain is not in discovery_methods', async () => {
      const { app, env } = createDiscoveryApp({
        SETTINGS: createMockKV({
          'settings:tenant:default:login-entry': JSON.stringify({
            'login-entry.override_enabled': true,
            'login-entry.discovery_methods': '["tenant_code","tenant_slug"]',
          }),
        }),
      });

      const res = await postDiscovery(app, env, { mode: 'email', value: 'user@acme.com' });
      const body = (await res.json()) as { result: string };

      expect(body.result).toBe('manual_required');
      expect(mocked.discoveryCandidatesMock).not.toHaveBeenCalled();
    });
  });

  describe('tenant_code isolation', () => {
    it('resolves acme-code to acme only — not to beta', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'acme-code' });
      const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

      expect(body.result).toBe('resolved');
      expect(body.candidate.tenant_id).toBe('acme');
    });

    it('resolves beta-code to beta only — not to acme', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'beta-code' });
      const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

      expect(body.result).toBe('resolved');
      expect(body.candidate.tenant_id).toBe('beta');
    });

    it('returns not_found for inactive-code (tenant lifecycle_state is suspended)', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'inactive-code' });
      const body = (await res.json()) as { result: string; code: string };

      expect(body.result).toBe('not_found');
      expect(body.code).toBe('tenant_code_not_found');
    });

    it('returns not_found for a completely unknown tenant_code', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'does-not-exist' });
      const body = (await res.json()) as { result: string; code: string };

      expect(body.result).toBe('not_found');
      expect(body.code).toBe('tenant_code_not_found');
    });

    it('returns manual_required when tenant_code is not in discovery_methods', async () => {
      const { app, env } = createDiscoveryApp({
        SETTINGS: createMockKV({
          'settings:tenant:default:login-entry': JSON.stringify({
            'login-entry.override_enabled': true,
            'login-entry.discovery_methods': '["email_domain","tenant_slug"]',
          }),
        }),
      });

      const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'acme-code' });
      const body = (await res.json()) as { result: string };

      expect(body.result).toBe('manual_required');
    });
  });

  describe('app_hint isolation', () => {
    it('resolves acme-app to acme only — not to beta', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'app_hint', value: 'acme-app' });
      const body = (await res.json()) as {
        result: string;
        candidate: { tenant_id: string; source: string };
      };

      expect(body.result).toBe('resolved');
      expect(body.candidate.tenant_id).toBe('acme');
      expect(body.candidate.source).toBe('app_hint');
    });

    it('resolves beta-app to beta only — not to acme', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'app_hint', value: 'beta-app' });
      const body = (await res.json()) as { result: string; candidate: { tenant_id: string } };

      expect(body.result).toBe('resolved');
      expect(body.candidate.tenant_id).toBe('beta');
    });

    it('returns not_found for inactive-app (client exists but tenant is inactive)', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'app_hint', value: 'inactive-app' });
      const body = (await res.json()) as { result: string; code: string };

      // Client row is found, but getTenantRowById('inactive') returns null (not active).
      expect(body.result).toBe('not_found');
      expect(body.code).toBe('app_hint_not_found');
    });

    it('returns not_found for an unknown client_id', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'app_hint', value: 'no-such-client' });
      const body = (await res.json()) as { result: string; code: string };

      expect(body.result).toBe('not_found');
      expect(body.code).toBe('app_hint_not_found');
    });
  });

  describe('invite_token isolation', () => {
    it('returns not_found for an expired token', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'invite_token', value: 'expired-token' });
      const body = (await res.json()) as { result: string; code: string };

      expect(body.result).toBe('not_found');
      expect(body.code).toBe('invitation_not_found');
    });

    it('returns not_found when the token has reached its max_uses limit', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'invite_token', value: 'exhausted-token' });
      const body = (await res.json()) as { result: string; code: string };

      expect(body.result).toBe('not_found');
      expect(body.code).toBe('invitation_not_found');
    });

    it('returns not_found for a token targeting an inactive tenant', async () => {
      const { app, env } = createDiscoveryApp();

      const res = await postDiscovery(app, env, { mode: 'invite_token', value: 'inactive-token' });
      const body = (await res.json()) as { result: string; code: string };

      // Invitation is valid and non-expired, but getTenantRowById('inactive') returns null
      expect(body.result).toBe('not_found');
      expect(body.code).toBe('invitation_not_found');
    });
  });
});

describe('Discovery API: resolved candidate structure', () => {
  beforeEach(() => {
    mocked.discoveryCandidatesMock.mockReset();
  });

  it('login_url is formatted as https://{tenant}.{baseDomain}/login', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'acme-code' });
    const body = (await res.json()) as { result: string; candidate: { login_url: string } };

    expect(body.result).toBe('resolved');
    expect(body.candidate.login_url).toBe('https://acme.auth.example.com/login');
  });

  it('display_name uses login-ui.brand_name when configured', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'acme-code' });
    const body = (await res.json()) as { result: string; candidate: { display_name: string } };

    expect(body.result).toBe('resolved');
    expect(body.candidate.display_name).toBe('Acme Brand');
  });

  it('display_name falls back to tenant.name when no branding is configured', async () => {
    // Beta has no login-ui settings in the default KV fixture
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_code', value: 'beta-code' });
    const body = (await res.json()) as { result: string; candidate: { display_name: string } };

    expect(body.result).toBe('resolved');
    expect(body.candidate.display_name).toBe('Beta Inc');
  });
});

describe('Discovery API: settings-driven behaviour', () => {
  beforeEach(() => {
    mocked.discoveryCandidatesMock.mockReset();
  });

  it('returns not_found instead of manual_required when allow_manual_tenant_entry is false', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([]);
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods':
            '["email_domain","tenant_code","tenant_slug","app_hint"]',
          'login-entry.allow_manual_tenant_entry': false,
        }),
      }),
    });

    const res = await postDiscovery(app, env, { mode: 'email', value: 'user@unknown.com' });
    const body = (await res.json()) as { result: string; code: string };

    expect(body.result).toBe('not_found');
    expect(body.code).toBe('email_domain_not_found');
  });
});

describe('Discovery API: request validation', () => {
  it('returns HTTP 400 for an invalid mode value', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'unknown_mode', value: 'test' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns HTTP 400 when value is an empty string (min(1) constraint)', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { mode: 'tenant_code', value: '' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns HTTP 400 when the mode field is absent', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, { value: 'some-value' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns HTTP 400 when value exceeds the 2048-character maximum', async () => {
    const { app, env } = createDiscoveryApp();

    const res = await postDiscovery(app, env, {
      mode: 'tenant_code',
      value: 'a'.repeat(2049),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });
});

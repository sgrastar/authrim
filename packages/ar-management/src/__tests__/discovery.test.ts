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
} from '../discovery';

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

describe('discovery API', () => {
  it('emits secret-free timing only for an explicit Phase 0c test diagnostic session', async () => {
    const { app, env } = createDiscoveryApp({ AUTHRIM_ENVIRONMENT_NAME: 'test' });
    const response = await app.request(
      'https://login.example.com/api/auth/discovery/email/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': 'login.example.com',
          'X-Diagnostic-Session-Id': 'phase0c-20260731064204-a03bb4',
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe(
      'phase0c-20260731064204-a03bb4'
    );
    const serverTiming = response.headers.get('Server-Timing') ?? '';
    expect(serverTiming).toContain('discovery_settings;dur=');
    expect(serverTiming).toContain('handler_total;dur=');
    expect(serverTiming).not.toContain('login.example.com');
    expect(serverTiming).not.toContain('default');
  });

  it('does not enable Phase 0c diagnostic timing outside the test environment', async () => {
    const { app, env } = createDiscoveryApp({ AUTHRIM_ENVIRONMENT_NAME: 'production' });
    const response = await app.request(
      'https://login.example.com/api/auth/discovery/email/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': 'login.example.com',
          'X-Diagnostic-Session-Id': 'phase0c-20260731064204-a03bb4',
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Server-Timing')).toBeNull();
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });

  it('rejects malformed Phase 0c diagnostic session IDs in the test environment', async () => {
    const { app, env } = createDiscoveryApp({ AUTHRIM_ENVIRONMENT_NAME: 'test' });
    const response = await app.request(
      'https://login.example.com/api/auth/discovery/email/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': 'login.example.com',
          'X-Diagnostic-Session-Id': 'phase0c-not-a-run-id/../../x-leak',
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Server-Timing')).toBeNull();
    expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });

  it('rejects direct OTP API calls when exact-email discovery is disabled', async () => {
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:platform:login-entry': JSON.stringify({
          'login-entry.discovery_methods': '["tenant_code","tenant_slug"]',
          'login-entry.email_resolution_policy': 'disabled',
        }),
      }),
    });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ email: 'person@example.com' }),
      },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'discovery_disabled' });
  });

  it('fails closed without exposing membership when the OTP provider is unavailable', async () => {
    const { app, env } = createDiscoveryApp();
    const response = await app.request(
      'https://login.example.com/api/auth/discovery/email/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ email: 'person@example.com' }),
      },
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'temporarily_unavailable' });
    expect(mocked.discoveryCandidatesMock).not.toHaveBeenCalled();
  });
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

  it('returns public config for the current host', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'login.example.com' },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      is_common_entry_host: boolean;
      common_discover_url: string | null;
      config: {
        redirect_default_login_to_discovery: boolean;
        require_common_discovery_before_login: boolean;
        skip_discovery_if_only_one_tenant: boolean;
      };
      ui: {
        brand_name: string;
        theme: string;
        title_text: string;
      };
    };
    expect(body.is_common_entry_host).toBe(true);
    expect(body.common_discover_url).toBe('https://auth.example.com/discover');
    expect(body.config.redirect_default_login_to_discovery).toBe(true);
    expect(body.config.require_common_discovery_before_login).toBe(true);
    expect(body.config.skip_discovery_if_only_one_tenant).toBe(true);
    expect(body.ui.brand_name).toBe('Shared Discovery');
    expect(body.ui.theme).toBe('dark');
    expect(body.ui.title_text).toBe('Find your workspace');
  });

  it('resolves tenant codes through Lookup and revalidates the runtime route', async () => {
    const tenantAdapter = createMockAdapter({
      queryOne: (sql, params) =>
        sql.includes('FROM tenants WHERE id = ?') && params[0] === 'acme'
          ? mocked.state.tenants.find((tenant) => tenant.id === 'acme')
          : null,
    });
    mocked.tenantAliasResolveMock.mockResolvedValue({
      tenantId: 'acme',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 8,
        residencyPolicyId: 'default-policy',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          shardId: 'default-1',
          bindingRef: 'TDB_ACME_DEFAULT',
          requiredBindingRouteGeneration: 8,
        },
      },
    });
    mocked.tenantStoreResolveMock.mockResolvedValue({
      source: tenantAdapter,
      bindingRef: 'TDB_ACME_DEFAULT',
      bindingRouteGeneration: 8,
      runtimeGeneration: 8,
      residencyPolicyId: 'default-policy',
      residencyPartition: 'default',
      shardId: 'default-1',
    });
    const { app, env } = createDiscoveryApp({
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: createMockKV(),
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
    });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'tenant_code', value: 'ACME' }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: 'resolved',
      candidate: { tenant_id: 'acme', tenant_code: 'acme' },
    });
    expect(mocked.tenantStoreResolveMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: 'acme',
        role: 'tenant_core',
        shardGroup: 'default',
      })
    );
  });

  it('fails closed when a tenant alias generation disagrees with the runtime registry', async () => {
    mocked.tenantAliasResolveMock.mockResolvedValue({
      tenantId: 'acme',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 7,
        residencyPolicyId: 'default-policy',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          shardId: 'default-1',
          bindingRef: 'TDB_ACME_DEFAULT',
          requiredBindingRouteGeneration: 7,
        },
      },
    });
    mocked.tenantStoreResolveMock.mockResolvedValue({
      source: createMockAdapter(),
      bindingRef: 'TDB_ACME_DEFAULT',
      bindingRouteGeneration: 8,
      runtimeGeneration: 8,
      residencyPolicyId: 'default-policy',
      residencyPartition: 'default',
      shardId: 'default-1',
    });
    const { app, env } = createDiscoveryApp({
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: createMockKV(),
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
    });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'tenant_code', value: 'acme' }),
      },
      env
    );

    expect(response.status).toBe(500);
  });

  it('returns the dedicated Login UI URL for a workers.dev-only single tenant', async () => {
    const { app, env } = createDiscoveryApp({
      BASE_DOMAIN: undefined,
      ISSUER_URL: 'https://single-ar-router.example.workers.dev',
      UI_URL: 'https://single-ar-login-ui.example.workers.dev',
      LOGIN_UI_EXECUTION_HOST_MODE: 'dedicated',
    });

    const response = await app.request(
      'https://single-ar-login-ui.example.workers.dev/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'tenant_code', value: 'default' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { candidate: { login_url: string } };
    expect(body.candidate.login_url).toBe('https://single-ar-login-ui.example.workers.dev/login');
  });

  it('uses platform login-entry settings for the common entry host', async () => {
    const kv = createMockKV({
      'settings:platform:login-entry': JSON.stringify({
        'login-entry.discovery_methods': '["tenant_code"]',
        'login-entry.email_resolution_policy': 'disabled',
        'login-entry.selection_policy': 'manual_only',
      }),
    });
    const { app, env } = createDiscoveryApp({ SETTINGS: kv });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'login.example.com' },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      is_common_entry_host: boolean;
      config: {
        discovery_methods: string[];
        email_resolution_policy: string;
        selection_policy: string;
      };
    };
    expect(body.is_common_entry_host).toBe(true);
    expect(body.config.discovery_methods).toEqual(['tenant_code']);
    expect(body.config.email_resolution_policy).toBe('disabled');
    expect(body.config.selection_policy).toBe('manual_only');
  });

  it('returns active tenant candidates when WAYF is enabled', async () => {
    const kv = createMockKV({
      'settings:platform:login-entry': JSON.stringify({
        'login-entry.discovery_methods': '["wayf"]',
        'login-entry.email_resolution_policy': 'disabled',
        'login-entry.selection_policy': 'manual_only',
      }),
    });
    const { app, env } = createDiscoveryApp({ SETTINGS: kv });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'login.example.com' },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      config: { discovery_methods: string[] };
      wayf_candidates: Array<{ tenant_id: string; display_name: string; source: string }>;
    };
    expect(body.config.discovery_methods).toEqual(['wayf']);
    expect(body.wayf_candidates.map((candidate) => candidate.tenant_id)).toEqual([
      'acme',
      'beta',
      'default',
    ]);
    expect(body.wayf_candidates[0]).toMatchObject({
      tenant_id: 'acme',
      display_name: 'Acme Tenant',
      source: 'wayf',
    });
  });

  it('uses common login-entry settings on tenant hosts when tenant override is disabled', async () => {
    const kv = createMockKV({
      'settings:platform:login-entry': JSON.stringify({
        'login-entry.discovery_methods': '["tenant_code"]',
        'login-entry.email_resolution_policy': 'disabled',
      }),
      'settings:tenant:default:login-entry': JSON.stringify({
        'login-entry.override_enabled': false,
        'login-entry.discovery_methods': '["email_exact","tenant_slug"]',
        'login-entry.email_resolution_policy': 'exact_email_only',
      }),
    });
    const { app, env } = createDiscoveryApp({ SETTINGS: kv });

    const response = await app.request(
      'https://default.auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'default.auth.example.com' },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      config: { tenant_id: string; discovery_methods: string[]; email_resolution_policy: string };
    };
    expect(body.config.tenant_id).toBe('default');
    expect(body.config.discovery_methods).toEqual(['tenant_code']);
    expect(body.config.email_resolution_policy).toBe('disabled');
  });

  it('uses common discovery UI settings when tenant screen override is disabled', async () => {
    const kv = createMockKV({
      'settings:platform:tenant-discovery-ui': JSON.stringify({
        'tenant-discovery-ui.title_text': 'Shared Discovery',
        'tenant-discovery-ui.brand_name': 'Shared Brand',
      }),
      'settings:tenant:acme:tenant-discovery-ui': JSON.stringify({
        'tenant-discovery-ui.override_enabled': false,
        'tenant-discovery-ui.title_text': 'Acme Discovery',
        'tenant-discovery-ui.brand_name': 'Acme Discovery',
      }),
    });
    const { app, env } = createDiscoveryApp({ SETTINGS: kv });

    const response = await app.request(
      'https://acme.auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'acme.auth.example.com' },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ui: { title_text: string; brand_name: string };
    };
    expect(body.ui.title_text).toBe('Shared Discovery');
    expect(body.ui.brand_name).toBe('Shared Brand');
  });

  it('resolves a tenant by tenant_code with branding precedence', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'tenant_code', value: 'acme' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: 'resolved';
      candidate: { display_name: string; logo_url: string | null; login_url: string };
    };
    expect(body.result).toBe('resolved');
    expect(body.candidate.display_name).toBe('Acme Brand');
    expect(body.candidate.logo_url).toBe('https://cdn.example.com/acme-login.png');
    expect(body.candidate.login_url).toBe('https://acme.auth.example.com/login');
  });

  it('briefly caches only completed tenant candidate presentation values', async () => {
    const { app, env } = createDiscoveryApp();
    const request = () =>
      app.request(
        'https://login.example.com/api/auth/discovery',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
          body: JSON.stringify({ mode: 'tenant_code', value: 'acme' }),
        },
        env
      );

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const settingsGet = env.SETTINGS!.get as ReturnType<typeof vi.fn>;
    const configGet = env.AUTHRIM_CONFIG!.get as ReturnType<typeof vi.fn>;
    expect(
      settingsGet.mock.calls.filter(([key]) => key === 'settings:tenant:acme:login-ui')
    ).toHaveLength(1);
    expect(
      configGet.mock.calls.filter(([key]) => key === 'settings:tenant:acme:tenant')
    ).toHaveLength(1);

    clearTenantCandidatePresentationCacheForTest();
    expect((await request()).status).toBe(200);
    expect(
      settingsGet.mock.calls.filter(([key]) => key === 'settings:tenant:acme:login-ui')
    ).toHaveLength(2);
  });

  it('does not resolve raw email through the legacy generic discovery endpoint', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([
      { tenant_id: 'acme', priority: 20 },
      { tenant_id: 'beta', priority: 10 },
    ]);
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'email', value: 'user@example.com' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('manual_required');
    expect(mocked.discoveryCandidatesMock).not.toHaveBeenCalled();
  });

  it('requires the OTP endpoint even for an existing exact email', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([]);
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'email', value: 'user@gmail.com' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('manual_required');
  });

  it('does not fan out to tenant PII stores from raw email', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([]);
    const { app, env } = createDiscoveryApp({ DB_PII: undefined as any });
    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'email', value: 'user@gmail.com' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('manual_required');
  });

  it('resolves invitation tokens and returns invited_email', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({
          mode: 'invite_token',
          value: 'token-12345678901234567890123456789012',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: 'resolved';
      invited_email: string | null;
      candidate: { tenant_id: string };
    };
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('acme');
    expect(body.invited_email).toBe('invited@example.com');
  });

  it('falls back to manual entry when email discovery has no match', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([]);
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'email', value: 'user@example.com' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: 'manual_required';
      allow_manual_tenant_entry: boolean;
    };
    expect(body.result).toBe('manual_required');
    expect(body.allow_manual_tenant_entry).toBe(true);
  });

  it('does not expose exact-email existence through the legacy endpoint', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([{ tenant_id: 'acme', priority: 20 }]);
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods': '["email_exact","tenant_code","tenant_slug"]',
          'login-entry.email_resolution_policy': 'exact_email_only',
        }),
      }),
    });

    const response = await app.request(
      'https://default.auth.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': 'default.auth.example.com',
        },
        body: JSON.stringify({ mode: 'email', value: 'user@example.com' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('manual_required');
    expect(mocked.discoveryCandidatesMock).not.toHaveBeenCalled();
  });

  it('hides email discovery from public config when email policy is disabled', async () => {
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods': '["email_exact","tenant_code","tenant_slug"]',
          'login-entry.email_resolution_policy': 'disabled',
        }),
      }),
    });

    const response = await app.request(
      'https://default.auth.example.com/api/auth/discovery',
      {
        method: 'GET',
        headers: { 'X-Forwarded-Host': 'default.auth.example.com' },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { config: { discovery_methods: string[] } };
    expect(body.config.discovery_methods).toEqual(['tenant_code', 'tenant_slug']);
  });

  it('resolves app_hint via oauth client_id', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://default.auth.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': 'default.auth.example.com',
        },
        body: JSON.stringify({ mode: 'app_hint', value: 'acme-web' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: 'resolved';
      candidate: { tenant_id: string; source: string };
    };
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('acme');
    expect(body.candidate.source).toBe('app_hint');
  });

  it('resolves a WAYF tenant selection by tenant id', async () => {
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:platform:login-entry': JSON.stringify({
          'login-entry.discovery_methods': '["wayf"]',
          'login-entry.email_resolution_policy': 'disabled',
        }),
      }),
    });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'wayf', value: 'acme' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: 'resolved';
      candidate: { tenant_id: string; display_name: string; source: string };
    };
    expect(body.result).toBe('resolved');
    expect(body.candidate).toMatchObject({
      tenant_id: 'acme',
      display_name: 'Acme Tenant',
      source: 'wayf',
    });
  });

  it('returns multiple app_hint candidates when client_id exists in multiple tenants', async () => {
    mocked.state.clients.push({ client_id: 'shared-native', tenant_id: 'acme' });
    mocked.state.clients.push({ client_id: 'shared-native', tenant_id: 'beta' });
    mocked.tenantAliasesResolveManyMock.mockResolvedValue([
      { tenantId: 'acme', routeProjection: discoveryRouteProjection('acme') },
      { tenantId: 'beta', routeProjection: discoveryRouteProjection('beta') },
    ]);
    try {
      const { app, env } = createDiscoveryApp();

      const response = await app.request(
        'https://default.auth.example.com/api/auth/discovery',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-Host': 'default.auth.example.com',
          },
          body: JSON.stringify({ mode: 'app_hint', value: 'shared-native' }),
        },
        env
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: 'multiple';
        candidates: Array<{ tenant_id: string; source: string }>;
      };
      expect(body.result).toBe('multiple');
      expect(body.candidates.map((candidate) => candidate.tenant_id).sort()).toEqual([
        'acme',
        'beta',
      ]);
    } finally {
      mocked.state.clients.splice(-2, 2);
    }
  });

  it('returns not_found when app_hint resolves to an inactive tenant', async () => {
    mocked.tenantAliasesResolveManyMock.mockResolvedValue([
      { tenantId: 'inactive', routeProjection: discoveryRouteProjection('inactive') },
    ]);
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'app_hint', value: 'inactive-web' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: 'not_found'; code: string };
    expect(body.result).toBe('not_found');
    expect(body.code).toBe('app_hint_not_found');
  });

  it('returns not_found when app_hint is disabled in discovery methods', async () => {
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods': '["email_exact","tenant_code","tenant_slug"]',
        }),
      }),
    });

    const response = await app.request(
      'https://login.example.com/api/auth/discovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'login.example.com' },
        body: JSON.stringify({ mode: 'app_hint', value: 'acme-web' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: 'not_found'; code: string };
    expect(body.result).toBe('not_found');
    expect(body.code).toBe('app_hint_not_found');
  });

  it('issues a discovery grant for the canonical tenant login URL', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://auth.example.com/api/auth/discovery/grant',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'auth.example.com' },
        body: JSON.stringify({
          tenant_id: 'acme',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { grant: string; login_url: string };
    expect(body.grant).toBeTruthy();
    expect(body.login_url).toMatch(/^https:\/\/acme\.auth\.example\.com\/login\?discovery_grant=/);
  });

  it('carries login_hint into the discovery grant target URL', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://auth.example.com/api/auth/discovery/grant',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'auth.example.com' },
        body: JSON.stringify({
          tenant_id: 'acme',
          login_hint: 'user@example.com',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { login_url: string };
    expect(body.login_url).toContain('login_hint=user%40example.com');
  });

  it('reuses the original tenant login URL when return_to matches the resolved tenant binding', async () => {
    const { app, env } = createDiscoveryApp();

    const response = await app.request(
      'https://auth.example.com/api/auth/discovery/grant',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'auth.example.com' },
        body: JSON.stringify({
          tenant_id: 'acme',
          expected_tenant_id: 'acme',
          return_to: 'https://login.acme.example.com/login',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { login_url: string };
    expect(body.login_url).toMatch(/^https:\/\/login\.acme\.example\.com\/login\?discovery_grant=/);
  });

  it('verifies a discovery grant only for the bound tenant login URL', async () => {
    const { app, env } = createDiscoveryApp();

    const createResponse = await app.request(
      'https://auth.example.com/api/auth/discovery/grant',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'auth.example.com' },
        body: JSON.stringify({
          tenant_id: 'acme',
          expected_tenant_id: 'acme',
          return_to: 'https://login.acme.example.com/login',
        }),
      },
      env
    );
    const created = (await createResponse.json()) as { grant: string };

    const verifyResponse = await app.request(
      'https://login.acme.example.com/api/auth/discovery/grant/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Authrim-Original-Host': 'login.acme.example.com',
        },
        body: JSON.stringify({
          grant: created.grant,
          current_url: 'https://login.acme.example.com/login',
        }),
      },
      { ...env, AUTHRIM_CONFIG: env.AUTHRIM_CONFIG } as Env
    );

    expect(verifyResponse.status).toBe(200);
    const body = (await verifyResponse.json()) as {
      valid: boolean;
      tenant_id: string;
      target_url: string;
    };
    expect(body.valid).toBe(true);
    expect(body.tenant_id).toBe('acme');
    expect(body.target_url).toBe('https://login.acme.example.com/login');
  });
});

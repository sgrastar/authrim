import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => {
  const state = {
    tenants: [
      { id: 'default', tenant_code: 'default', name: 'Default Tenant', is_active: 1 },
      { id: 'acme', tenant_code: 'acme', name: 'Acme Tenant', is_active: 1 },
      { id: 'beta', tenant_code: 'beta', name: 'Beta Tenant', is_active: 1 },
      { id: 'inactive', tenant_code: 'inactive', name: 'Inactive Tenant', is_active: 0 },
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
      if (query.includes('FROM tenants') && query.includes('WHERE is_active = 1')) {
        if (!query.includes('LIMIT 2')) {
          return state.tenants
            .filter((tenant) => tenant.is_active === 1)
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) as T[];
        }
        return state.tenants.filter((tenant) => tenant.is_active === 1).slice(0, 2) as T[];
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
      if (query.includes('FROM tenants WHERE id = ? AND is_active = 1')) {
        return (state.tenants.find((tenant) => tenant.id === params[0] && tenant.is_active === 1) ??
          null) as T | null;
      }
      if (query.includes('FROM tenant_invitations')) {
        const token = params[0];
        const now = Number(params[1]);
        return (state.invitations.find(
          (invitation) => invitation.token === token && invitation.expires_at > now
        ) ?? null) as T | null;
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

import {
  getDiscoveryConfigHandler,
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
  app.post('/api/auth/discovery/grant', postDiscoveryGrantHandler);
  app.post('/api/auth/discovery/grant/verify', postDiscoveryGrantVerifyHandler);

  const env = {
    DB: createMockAdapter(),
    DB_PII: createMockAdapter(),
    SETTINGS: createMockKV({
      'settings:tenant:default:login-entry': JSON.stringify({
        'login-entry.override_enabled': true,
        'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug","app_hint"]',
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
    DEFAULT_TENANT_ID: 'default',
    ISSUER_URL: 'https://default.auth.example.com',
    KEY_MANAGER_SECRET: 'test-discovery-grant-secret',
    ...envOverrides,
  } as unknown as Env;

  return { app, env };
}

describe('discovery API', () => {
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
    expect(body.config.skip_discovery_if_only_one_tenant).toBe(false);
    expect(body.ui.brand_name).toBe('Shared Discovery');
    expect(body.ui.theme).toBe('dark');
    expect(body.ui.title_text).toBe('Find your workspace');
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
        'login-entry.discovery_methods': '["email_domain","tenant_slug"]',
        'login-entry.email_resolution_policy': 'exact_email_then_domain',
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

  it('returns multiple candidates for email-domain discovery', async () => {
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
    const body = (await response.json()) as {
      result: 'multiple';
      candidates: Array<{ tenant_id: string }>;
    };
    expect(body.result).toBe('multiple');
    expect(body.candidates.map((candidate) => candidate.tenant_id)).toEqual(['acme', 'beta']);
  });

  it('resolves a unique exact email match before falling back to domain mappings', async () => {
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
    const body = (await response.json()) as {
      result: 'resolved';
      candidate: { tenant_id: string };
    };
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('acme');
  });

  it('uses the runtime-resolved pii store for exact-email discovery', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([]);
    const { app, env } = createDiscoveryApp({ DB_PII: undefined as any });
    const acmePiiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT id, tenant_id FROM users_pii WHERE email = ? AND tenant_id = ?')) {
          return params[1] === 'acme' ? { id: 'user-1', tenant_id: 'acme' } : null;
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesMock.mockImplementation(
      async (_env: Partial<Env>, tenantId: string) => ({
        storageProfile: {
          id: 'builtin:storage:tenant-override',
          kind: 'storage',
          label: 'Tenant Override',
          slices: {},
        },
        coreDb: env.DB,
        piiDb: tenantId === 'acme' ? acmePiiAdapter : null,
      })
    );

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
    const body = (await response.json()) as {
      result: 'resolved';
      candidate: { tenant_id: string };
    };
    expect(body.result).toBe('resolved');
    expect(body.candidate.tenant_id).toBe('acme');
    expect(mocked.resolveUserStoreRuntimeSourcesMock).toHaveBeenCalledWith(env, 'acme');
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

  it('returns email_not_found when exact-email-only policy has no exact match', async () => {
    mocked.discoveryCandidatesMock.mockResolvedValue([{ tenant_id: 'acme', priority: 20 }]);
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug"]',
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
    const body = (await response.json()) as { result: 'not_found'; code: string };
    expect(body.result).toBe('not_found');
    expect(body.code).toBe('email_not_found');
    expect(mocked.discoveryCandidatesMock).not.toHaveBeenCalled();
  });

  it('hides email discovery from public config when email policy is disabled', async () => {
    const { app, env } = createDiscoveryApp({
      SETTINGS: createMockKV({
        'settings:tenant:default:login-entry': JSON.stringify({
          'login-entry.override_enabled': true,
          'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug"]',
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
          'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug"]',
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

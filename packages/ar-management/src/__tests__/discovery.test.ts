import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => {
  const state = {
    tenants: [
      { id: 'default', tenant_code: 'default', name: 'Default Tenant', is_active: 1 },
      { id: 'acme', tenant_code: 'acme', name: 'Acme Tenant', is_active: 1 },
      { id: 'beta', tenant_code: 'beta', name: 'Beta Tenant', is_active: 1 },
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

    async queryOne<T>(query: string, params: unknown[]): Promise<T | null> {
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
    FakeD1Adapter,
  };
});

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    D1Adapter: mocked.FakeD1Adapter,
    resolveTenantCandidatesFromEmailDomain: mocked.discoveryCandidatesMock,
  };
});

import { getDiscoveryConfigHandler, postDiscoveryHandler } from '../discovery';

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

function createDiscoveryApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'default');
    await next();
  });
  app.get('/api/auth/discovery', getDiscoveryConfigHandler);
  app.post('/api/auth/discovery', postDiscoveryHandler);

  const env = {
    DB: {},
    SETTINGS: createMockKV({
      'settings:tenant:default:login-entry': JSON.stringify({
        'login-entry.discovery_methods': '["email_domain","tenant_code","tenant_slug","app_hint"]',
      }),
      'settings:tenant:acme:login-ui': JSON.stringify({
        'login-ui.brand_name': 'Acme Brand',
        'login-ui.logo_url': 'https://cdn.example.com/acme-login.png',
      }),
      'settings:tenant:beta:login-ui': JSON.stringify({
        'login-ui.brand_name': 'Beta Brand',
      }),
    }),
    AUTHRIM_CONFIG: createMockKV({
      'settings:tenant:acme:tenant': JSON.stringify({
        'tenant.logo_uri': 'https://cdn.example.com/acme-tenant.png',
      }),
      'settings:tenant:beta:tenant': JSON.stringify({
        'tenant.logo_uri': 'https://cdn.example.com/beta-tenant.png',
      }),
    }),
    BASE_DOMAIN: 'auth.example.com',
    DEFAULT_TENANT_ID: 'default',
    ISSUER_URL: 'https://default.auth.example.com',
    ...envOverrides,
  } as unknown as Env;

  return { app, env };
}

describe('discovery API', () => {
  beforeEach(() => {
    mocked.discoveryCandidatesMock.mockReset();
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
      config: { redirect_default_login_to_discovery: boolean };
    };
    expect(body.is_common_entry_host).toBe(true);
    expect(body.config.redirect_default_login_to_discovery).toBe(true);
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
});

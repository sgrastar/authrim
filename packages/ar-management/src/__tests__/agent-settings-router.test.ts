import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  auth: {
    userId: 'admin-1',
    actorType: 'human',
    authMethod: 'session',
    tenantId: 'tenant-1',
    roles: ['admin'],
    permissions: [] as string[],
  } as AdminAuthContext,
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: () => async (c: any, next: () => Promise<void>) => {
      c.set('adminAuth', mocks.auth);
      await next();
    },
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.audit }));

import { agentSettingsRouter } from '../routes/admin-management/agent-settings';

function kv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    values,
  };
}

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/settings/agent', agentSettingsRouter as never);
  return result;
}

function validBody() {
  return {
    enabled: true,
    maxTokenTtlSeconds: 600,
    elevationMode: 'both',
    elevationTtlSeconds: 120,
    rateLimitPerMinute: 30,
    publicClientStandardRateLimitPerMinute: 5,
    highRiskPermissionsAdditional: [ADMIN_PERMISSIONS.CLIENTS_WRITE],
    publicClientStandardToolIds: ['admin.write.clients.metadata'],
    bulkCanaryProtected: false,
  };
}

describe('Agent Access settings routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      userId: 'admin-1',
      actorType: 'human',
      authMethod: 'session',
      tenantId: 'tenant-1',
      roles: ['admin'],
      permissions: [ADMIN_PERMISSIONS.AGENT_SETTINGS_READ, ADMIN_PERMISSIONS.AGENT_SETTINGS_WRITE],
    };
    mocks.audit.mockResolvedValue('audit-1');
  });

  it('stores all Agent settings in the dedicated tenant category and audits the change', async () => {
    const settings = kv({
      'settings:tenant:tenant-1:agent-access': JSON.stringify({ unrelated: 'preserved' }),
    });
    const response = await app().request(
      '/api/admin/settings/agent',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      },
      { SETTINGS: settings } as unknown as Env
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const stored = JSON.parse(
      settings.values.get('settings:tenant:tenant-1:agent-access') ?? '{}'
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      unrelated: 'preserved',
      'agent.mcp.enabled': true,
      'agent.mcp.max_token_ttl_seconds': 600,
      'agent.mcp.public_client_standard_rate_limit_per_minute': 5,
      'agent.mcp.public_client_standard_tool_ids': ['admin.write.clients.metadata'],
      'agent.mcp.settings_version': 1,
      'agent.mcp.settings_updated_by': 'admin-1',
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'agent.settings.updated', result: 'success' })
    );
  });

  it('rejects machine and Agent actors from changing settings', async () => {
    mocks.auth = { ...mocks.auth, actorType: 'agent' };
    const response = await app().request(
      '/api/admin/settings/agent',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      },
      { SETTINGS: kv() } as unknown as Env
    );
    expect(response.status).toBe(403);
  });

  it('rejects unknown permissions and out-of-range TTLs', async () => {
    const body = {
      ...validBody(),
      maxTokenTtlSeconds: 901,
      highRiskPermissionsAdditional: ['admin:invented:write'],
    };
    const response = await app().request(
      '/api/admin/settings/agent',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { SETTINGS: kv() } as unknown as Env
    );
    expect(response.status).toBe(400);
  });

  it('rejects a public Mode A write limit above the general Tool limit', async () => {
    const response = await app().request(
      '/api/admin/settings/agent',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...validBody(),
          rateLimitPerMinute: 4,
          publicClientStandardRateLimitPerMinute: 5,
        }),
      },
      { SETTINGS: kv() } as unknown as Env
    );
    expect(response.status).toBe(400);
  });

  it('rejects a public-client standard Tool that is not explicitly server eligible', async () => {
    const response = await app().request(
      '/api/admin/settings/agent',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...validBody(),
          publicClientStandardToolIds: ['admin.write.users.suspend'],
        }),
      },
      { SETTINGS: kv() } as unknown as Env
    );
    expect(response.status).toBe(400);
  });

  it('restores the prior settings record when the synchronous audit cannot be written', async () => {
    const key = 'settings:tenant:tenant-1:agent-access';
    const previous = JSON.stringify({ 'agent.mcp.enabled': false, sentinel: true });
    const settings = kv({ [key]: previous });
    mocks.audit.mockResolvedValue(null);
    const response = await app().request(
      '/api/admin/settings/agent',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      },
      { SETTINGS: settings } as unknown as Env
    );
    expect(response.status).toBe(503);
    expect(settings.values.get(key)).toBe(previous);
  });

  it('reads defaults and applies the environment fallback only when no tenant value exists', async () => {
    const response = await app().request('/api/admin/settings/agent', { method: 'GET' }, {
      SETTINGS: kv(),
      ENABLE_AGENT_MCP: 'true',
    } as unknown as Env);
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ settings: { enabled: true } });
  });
});

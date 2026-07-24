import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_ADMIN_READ_ROUTES,
  projectAgentGrantListResponse,
  projectAgentSessionPostureResponse,
  projectAgentSettingsResponse,
} from '../admin-read-routes';

function path(operation: string, input: Record<string, string | number | boolean>): string {
  const route = CLOUDFLARE_ADMIN_READ_ROUTES[operation];
  if (!route || typeof route.path !== 'function') throw new Error('missing route');
  return route.path(input);
}

function tenantPath(operation: string, tenantId: string): string {
  const route = CLOUDFLARE_ADMIN_READ_ROUTES[operation];
  if (!route || typeof route.path !== 'function') throw new Error('missing route');
  return route.path({}, { tenantId });
}

describe('Cloudflare Admin read route allowlist', () => {
  it('maps only reviewed operations to fixed Admin API paths', () => {
    expect(Object.keys(CLOUDFLARE_ADMIN_READ_ROUTES)).toEqual([
      'admin.read.users.search',
      'admin.read.users.get',
      'admin.read.clients.list',
      'admin.read.clients.get',
      'admin.read.agent-grants.list',
      'admin.read.audit.search',
      'admin.read.agent-settings.get',
      'admin.read.identity-providers.inspect',
      'admin.read.authorization.organizations',
      'admin.read.authorization.roles',
      'admin.read.authorization.policies',
      'admin.read.flows.inspect',
      'admin.read.consent.inspect',
      'admin.read.sessions.inspect',
      'admin.read.assurance.inspect',
      'admin.read.protocol-security.inspect',
      'admin.read.oauth.inspect',
      'admin.read.token-exchange.inspect',
      'admin.read.logout.inspect',
      'admin.read.webhooks.inspect',
      'admin.read.login-ui.inspect',
      'admin.read.conformance.inspect',
      'admin.read.flows.validate',
      'admin.read.authorization.simulate',
      'admin.read.tenant-policy.validate',
      'admin.read.clients.profile-validate',
    ]);
  });

  it('maps validation and simulation tools to fixed routes and forces non-persistent policy evaluation', () => {
    expect(path('admin.read.flows.validate', { resource_id: 'flow-1' })).toBe(
      '/api/admin/flows/flow-1/validate'
    );
    expect(path('admin.read.clients.profile-validate', { resource_id: 'client-1' })).toBe(
      '/api/admin/clients/client-1/profile/validate'
    );
    expect(() => path('admin.read.flows.validate', { resource_id: '../flow' })).toThrow();
    const route = CLOUDFLARE_ADMIN_READ_ROUTES['admin.read.authorization.simulate'];
    expect(
      route?.body?.({
        subject: { id: 'user-1', roles: [] },
        resource: { type: 'client', id: 'client-1' },
        action: { name: 'read' },
      })
    ).toMatchObject({
      context: {
        subject: { id: 'user-1', roles: [] },
        resource: { type: 'client', id: 'client-1' },
        action: { name: 'read' },
        timestamp: expect.any(Number),
      },
      save_history: false,
    });
  });

  it('projects inspection responses through a bounded secret and PII redactor', () => {
    const route = CLOUDFLARE_ADMIN_READ_ROUTES['admin.read.identity-providers.inspect'];
    expect(
      route?.response?.({
        providers: [
          {
            id: 'idp-1',
            issuer: 'https://idp.example/issuer?credential=leak',
            client_secret: 'never-return',
            clientSecret: 'also-never-return',
            apiKey: 'api-key-never-return',
            clientAssertion: 'assertion-never-return',
            accessToken: 'token-never-return',
            contact_email: 'owner@example.com',
            contactEmail: 'owner-2@example.com',
            callbackPath: '/callback?token=never-return#fragment',
          },
        ],
      })
    ).toEqual({
      snapshot: {
        providers: [
          {
            id: 'idp-1',
            issuer: 'https://idp.example/issuer',
            callbackPath: '/callback',
          },
        ],
      },
    });
  });

  it('wraps Agent settings in the public Tool output contract and redacts private fields', () => {
    expect(
      projectAgentSettingsResponse({
        settings: {
          enabled: true,
          rate_limit_per_minute: 60,
          signing_secret: 'never-return',
          supportUrl: 'https://support.example/path?credential=never-return',
        },
        version: 7,
      })
    ).toEqual({
      settings: {
        enabled: true,
        rate_limit_per_minute: 60,
        supportUrl: 'https://support.example/path',
      },
    });
    expect(projectAgentSettingsResponse(null)).toEqual({ settings: {} });
  });

  it('projects Sessions into aggregate posture without end-user or device data', () => {
    const projected = projectAgentSessionPostureResponse({
      snapshot: {
        total_sessions: 17,
        active_sessions: 10,
        expired_sessions: 7,
        window: {
          oldest_created_at: '2026-07-18T00:00:00.000Z',
          newest_last_accessed_at: '2026-07-20T01:00:00.000Z',
          next_expiration_at: '2026-07-21T00:00:00.000Z',
          latest_expiration_at: '2026-07-22T00:00:00.000Z',
        },
        user_email: 'alice@example.com',
      },
    });

    expect(projected).toEqual({
      snapshot: {
        total_sessions: 17,
        active_sessions: 10,
        expired_sessions: 7,
        window: {
          oldest_created_at: '2026-07-18T00:00:00.000Z',
          newest_last_accessed_at: '2026-07-20T01:00:00.000Z',
          next_expiration_at: '2026-07-21T00:00:00.000Z',
          latest_expiration_at: '2026-07-22T00:00:00.000Z',
        },
      },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('alice@example.com');
  });

  it('fails closed when the Sessions owner response does not match its contract', () => {
    expect(() =>
      projectAgentSessionPostureResponse({
        snapshot: {
          total_sessions: 2,
          active_sessions: 2,
          expired_sessions: 1,
          window: {
            oldest_created_at: null,
            newest_last_accessed_at: null,
            next_expiration_at: null,
            latest_expiration_at: null,
          },
        },
      })
    ).toThrow('Invalid Agent session posture response');
  });

  it('encodes filters and opaque cursors without accepting a caller-supplied path', () => {
    const cursor = btoa(JSON.stringify({ v: 1, p: 3 })).replace(/=+$/u, '');
    expect(
      path('admin.read.users.search', {
        query: 'alice+admin@example.com',
        verified: true,
        page_size: 50,
        cursor,
      })
    ).toBe(
      '/api/admin/agent-read/users?page=3&limit=50&search=alice%2Badmin%40example.com&verified=true'
    );
    expect(() => path('admin.read.users.get', { user_id: '../admin-audit-log' })).toThrow();
    expect(() => path('admin.read.users.search', { cursor: 'not-a-cursor' })).toThrow();
    expect(
      path('admin.read.clients.get', {
        client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
      })
    ).toBe(
      '/api/admin/agent-read/clients/https%3A%2F%2Fclaude.ai%2Foauth%2Fclaude-code-client-metadata'
    );
    expect(() =>
      path('admin.read.clients.get', { client_id: 'http://metadata.example/client' })
    ).toThrow('Invalid client_id');
    expect(() =>
      path('admin.read.clients.get', { client_id: 'https://metadata.example/client#fragment' })
    ).toThrow('Invalid client_id');
    expect(
      path('admin.read.agent-grants.list', {
        status: 'active',
        delegator_id: 'admin-1',
        page_size: 25,
        offset: 50,
      })
    ).toBe('/api/admin/agent-grants?limit=25&offset=50&status=active&delegator_id=admin-1');
    expect(CLOUDFLARE_ADMIN_READ_ROUTES['admin.read.sessions.inspect']?.path).toBe(
      '/api/admin/agent-read/session-posture'
    );
  });

  it('projects Agent Grant lists without authorization details or internal snapshot hashes', () => {
    const projected = projectAgentGrantListResponse({
      grants: [
        {
          id: 'grant-1',
          client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
          machine_principal_id: null,
          purpose: 'Test tenant configuration',
          status: 'active',
          delegation_mode: 'user_consent',
          permissions: ['admin:agent_grants:read'],
          scopes: ['agent:read'],
          task_set_id: 'builtin_agent_task_set_read_only_inspector',
          task_set_version: 8,
          scope_policy_id: 'scope-policy-1',
          scope_policy_version: 1,
          expires_at: 2_000,
          last_used_at: 1_500,
          created_at: 1_000,
          updated_at: 1_500,
          authorization_details: [{ type: 'authrim_agent_access' }],
          resolved_tools: [{ tool_name: 'secret-in-list' }],
          access_snapshot_hash: 'never-return',
        },
      ],
      pagination: { total: 1, limit: 25, offset: 0 },
    });
    expect(projected).toMatchObject({
      grants: [
        {
          id: 'grant-1',
          client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
          permissions: ['admin:agent_grants:read'],
          scopes: ['agent:read'],
        },
      ],
      pagination: { total: 1, limit: 25, offset: 0 },
    });
    expect(JSON.stringify(projected)).not.toContain('authorization_details');
    expect(JSON.stringify(projected)).not.toContain('access_snapshot_hash');
    expect(JSON.stringify(projected)).not.toContain('secret-in-list');
  });

  it('derives tenant settings paths from verified authorization context', () => {
    expect(tenantPath('admin.read.assurance.inspect', 'tenant-1')).toBe(
      '/api/admin/tenants/tenant-1/settings/assurance'
    );
    expect(tenantPath('admin.read.protocol-security.inspect', 'tenant-1')).toBe(
      '/api/admin/tenants/tenant-1/settings/security'
    );
    expect(tenantPath('admin.read.token-exchange.inspect', 'tenant-1')).toBe(
      '/api/admin/tenants/tenant-1/settings/tokens'
    );
    expect(tenantPath('admin.read.login-ui.inspect', 'tenant-1')).toBe(
      '/api/admin/tenants/tenant-1/settings/login-ui'
    );
    expect(() => tenantPath('admin.read.assurance.inspect', '../other')).toThrow(
      'Invalid tenant_id'
    );
  });
});

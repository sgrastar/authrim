import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_ADMIN_READ_ROUTES } from '../admin-read-routes';

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

import { describe, expect, it } from 'vitest';
import { createAdminToolCatalog } from '../../../protocol/mcp';
import { CLOUDFLARE_ADMIN_READ_ROUTES } from '../admin-read-routes';
import { CLOUDFLARE_ADMIN_WRITE_ROUTES } from '../admin-write-routes';

describe('Cloudflare Admin write operation routes', () => {
  it('maps the reviewed operation to a fixed owner-package path', () => {
    const route = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.users.suspend'];
    expect(route.method).toBe('POST');
    expect(typeof route.path === 'function' ? route.path({ user_id: 'user-1' }) : route.path).toBe(
      '/api/admin/agent-write/users/user-1/suspend'
    );
    expect(route.body?.({ user_id: 'user-1', reason_code: 'security_incident' })).toEqual({
      reason_code: 'security_incident',
    });
  });

  it('projects standard client metadata updates onto a fixed idempotent owner route', () => {
    const route = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.clients.metadata'];
    expect(route.method).toBe('PUT');
    expect(
      typeof route.path === 'function' ? route.path({ client_id: 'client-1' }) : route.path
    ).toBe('/api/admin/agent-write/clients/client-1/metadata');
    expect(route.body?.({ client_id: 'client-1', client_name: 'Updated' })).toEqual({
      client_name: 'Updated',
    });
    expect(
      route.response?.({
        success: true,
        client: {
          client_id: 'client-1',
          client_name: 'Updated',
          description: 'Safe',
          client_secret: 'must-not-leave-owner',
          requestable_scopes: ['agent:write'],
          updated_at: 1234,
        },
      })
    ).toEqual({
      client: {
        client_id: 'client-1',
        client_name: 'Updated',
        description: 'Safe',
        updated_at: 1234,
      },
    });
  });

  it('projects high-risk client protocol settings onto its operation-bound owner route', () => {
    const route = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.clients.protocol-security'];
    expect(
      typeof route.path === 'function' ? route.path({ client_id: 'client-1' }) : route.path
    ).toBe('/api/admin/agent-write/clients/client-1/protocol-security');
    expect(
      route.body?.({
        client_id: 'client-1',
        resource_version: 'version-1',
        require_pkce: true,
      })
    ).toEqual({ require_pkce: true });
    expect(route.headers?.({ resource_version: 'version-1' })).toEqual({
      'if-match': 'version-1',
    });
  });

  it('forces the secure public-client profile at the platform boundary', () => {
    const route = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.clients.public-create'];
    expect(
      route.body?.({
        client_name: 'SPA',
        application_type: 'spa',
        redirect_uris: ['https://client.example/callback'],
      })
    ).toMatchObject({
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_credentials_allowed: false,
      token_exchange_allowed: false,
      is_trusted: false,
      skip_consent: false,
    });
  });

  it('rejects path injection before a Service Binding request is created', () => {
    const route = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.users.suspend'];
    expect(() =>
      typeof route.path === 'function' ? route.path({ user_id: '../tenants/other' }) : route.path
    ).toThrow('Invalid user_id');
  });

  it('maps reviewed security setting mutations to fixed owner routes and redacts output', () => {
    const assurance = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.assurance.update'];
    expect(assurance.method).toBe('PATCH');
    expect(
      typeof assurance.path === 'function'
        ? assurance.path({}, { tenantId: 'tenant-1' })
        : assurance.path
    ).toBe('/api/admin/tenants/tenant-1/settings/assurance');
    expect(assurance.body?.({ resource_version: 'v1', defaultAAL: 'AAL2' })).toEqual({
      ifMatch: 'v1',
      set: { 'assurance.default_aal': 'AAL2' },
    });
    const security = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.protocol-security.update'];
    expect(security.method).toBe('PATCH');
    expect(
      security.body?.({ resource_version: 'v2', fapi: { enabled: true, strictDPoP: true } })
    ).toEqual({
      ifMatch: 'v2',
      set: { 'security.fapi_enabled': true, 'security.fapi_strict_dpop': true },
    });
    const tokenExchange = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.token-exchange.update'];
    expect(tokenExchange.method).toBe('PATCH');
    expect(tokenExchange.body?.({ resource_version: 'v3', enabled: true })).toEqual({
      ifMatch: 'v3',
      set: { 'tokens.exchange_enabled': true },
    });
    expect(tokenExchange.response?.({ success: true, accessToken: 'secret' })).toEqual({
      snapshot: { success: true },
    });
  });

  it('projects OAuth, session, and Login UI writes to bounded settings keys', () => {
    const oauth = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.oauth.update'];
    expect(oauth.body?.({ resource_version: 'v4', accessTokenExpiry: 900 })).toEqual({
      ifMatch: 'v4',
      set: { 'oauth.access_token_expiry': 900 },
    });
    const session = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.session.update'];
    expect(session.body?.({ resource_version: 'v5', refreshDefault: false })).toEqual({
      ifMatch: 'v5',
      set: { 'session.refresh_default': false },
    });
    const loginUi = CLOUDFLARE_ADMIN_WRITE_ROUTES['admin.write.login-ui.update'];
    expect(
      loginUi.body?.({
        resource_version: 'v6',
        brandName: 'Example',
        supportedLocales: ['en', 'ja'],
      })
    ).toEqual({
      ifMatch: 'v6',
      set: {
        'login-ui.brand_name': 'Example',
        'login-ui.supported_locales': 'en,ja',
      },
    });
  });

  it('maps every Management API catalog operation and no unpublished operation', () => {
    const published = createAdminToolCatalog()
      .list()
      .filter((tool) => !tool.executionTarget || tool.executionTarget === 'management_api')
      .map((tool) => tool.id)
      .sort();
    const routed = [
      ...Object.keys(CLOUDFLARE_ADMIN_READ_ROUTES),
      ...Object.keys(CLOUDFLARE_ADMIN_WRITE_ROUTES),
    ].sort();
    expect(routed).toEqual(published);
  });
});

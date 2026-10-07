import { describe, expect, it } from 'vitest';
import {
  classifyTenantRequestPath,
  extractTenantScopedPathTenantId,
} from '../tenant-request-policy';

describe('tenant request path classification', () => {
  it.each([
    '/api/admin/auth/passkey/options',
    '/api/admin/auth/passkey/verify',
    '/api/admin/setup-token/verify',
    '/api/admin/setup-token/passkey/options',
    '/api/admin/setup-token/passkey/complete',
    '/api/admin/me/session',
    '/api/admin/sessions/me',
    '/api/admin/logout',
    '/api/admin/me/passkeys',
    '/api/admin/me/passkeys/options',
    '/api/admin/me/passkeys/complete',
    '/api/admin/me/passkeys/credential-id',
    '/api/admin/me/agent-consents',
    '/api/admin/me/agent-consents/consent-id',
  ])('keeps Admin identity operations platform-owned: %s', (path) => {
    expect(classifyTenantRequestPath(path)).toBe('platform_admin');
  });

  it.each([
    '/api/admin/users',
    '/api/admin/clients',
    '/api/admin/sessions',
    '/api/admin/sessions/session-id',
    '/api/admin/admins',
    '/api/admin/admin-roles',
    '/api/admin/me/passkeys/credential-id/unknown',
  ])('retains tenant isolation for tenant operations and adjacent routes: %s', (path) => {
    expect(classifyTenantRequestPath(path)).toBe('tenant_scoped_admin');
  });

  it.each([
    '/admin-init-setup',
    '/api/admin-init-setup/status',
    '/api/admin-init-setup/initialize',
    '/api/admin-init-setup/complete',
  ])('classifies exact initial administrator setup routes as platform-owned: %s', (path) => {
    expect(classifyTenantRequestPath(path)).toBe('platform_admin');
  });

  it.each([
    '/admin-init-setup-other',
    '/api/admin-init-setup/unknown',
    '/api/admin-init-setup/initialize/extra',
    '/authorize',
  ])('does not exempt adjacent or protocol routes from tenant runtime resolution: %s', (path) => {
    expect(classifyTenantRequestPath(path)).toBe('public_protocol_or_rest');
  });

  it.each([
    '/.well-known/openid-configuration',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/jwks.json',
    '/.well-known/webfinger',
  ])(
    'classifies public metadata as discovery UI without tenant database resolution: %s',
    (path) => {
      expect(classifyTenantRequestPath(path)).toBe('discovery_ui');
    }
  );

  it('keeps non-metadata protocol routes tenant-runtime scoped', () => {
    expect(classifyTenantRequestPath('/authorize')).toBe('public_protocol_or_rest');
  });

  it.each([
    '/api/admin/tenants/fapi2/lifecycle/jobs',
    '/api/admin/tenants/fapi2/lifecycle/jobs/job-1/retry',
    '/api/admin/tenants/fapi2/lifecycle/suspend',
  ])('keeps platform-owned tenant lifecycle routes in tenant inventory: %s', (path) => {
    expect(classifyTenantRequestPath(path)).toBe('tenant_inventory_admin');
    expect(extractTenantScopedPathTenantId(path)).toBe('fapi2');
  });

  it('extracts the explicit tenant from tenant-managed subresources', () => {
    const path = '/api/admin/tenants/fapi2/placement-migrations/latest';
    expect(classifyTenantRequestPath(path)).toBe('tenant_scoped_admin');
    expect(extractTenantScopedPathTenantId(path)).toBe('fapi2');
  });
});

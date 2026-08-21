import { describe, expect, it } from 'vitest';
import {
  classifyTenantRequestPath,
  extractTenantScopedPathTenantId,
} from '../tenant-request-policy';

describe('tenant request path classification', () => {
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
    '/api/admin/tenants/fapi2/lifecycle/suspend',
    '/api/admin/tenants/fapi2/placement-migrations/latest',
  ])('extracts the explicit tenant from tenant management subresources: %s', (path) => {
    expect(classifyTenantRequestPath(path)).toBe('tenant_scoped_admin');
    expect(extractTenantScopedPathTenantId(path)).toBe('fapi2');
  });
});

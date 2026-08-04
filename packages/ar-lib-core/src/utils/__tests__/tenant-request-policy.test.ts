import { describe, expect, it } from 'vitest';
import { classifyTenantRequestPath } from '../tenant-request-policy';

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
});

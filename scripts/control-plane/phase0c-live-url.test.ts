import { describe, expect, it } from 'vitest';
import { resolvePhase0cTenantApiBaseUrl } from './phase0c-live-url.js';

describe('Phase 0c tenant API URL', () => {
  it('uses the tenant issuer host for multi-tenant live flows', () => {
    expect(
      resolvePhase0cTenantApiBaseUrl(
        {
          tenant: {
            name: 'first',
            multiTenant: true,
            baseDomain: 'test.authrim.com',
            nakedDomain: false,
          },
          urls: { api: { custom: 'https://test.authrim.com' } },
        },
        'test'
      )
    ).toBe('https://first.test.authrim.com');
  });

  it('preserves naked and single-tenant API origins', () => {
    expect(
      resolvePhase0cTenantApiBaseUrl(
        {
          tenant: {
            name: 'first',
            multiTenant: true,
            baseDomain: 'test.authrim.com',
            nakedDomain: true,
          },
        },
        'test'
      )
    ).toBe('https://test.authrim.com');
    expect(
      resolvePhase0cTenantApiBaseUrl(
        {
          tenant: { name: 'first', multiTenant: false },
          urls: { api: { custom: 'https://api.example.com/' } },
        },
        'test'
      )
    ).toBe('https://api.example.com');
  });
});

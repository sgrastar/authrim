import { describe, expect, it } from 'vitest';
import { normalizeTenantConfigForApiDomain } from '../core/tenant-mode.js';

describe('normalizeTenantConfigForApiDomain', () => {
  it('forces single-tenant defaults when API custom domain is absent', () => {
    const tenant = normalizeTenantConfigForApiDomain({
      name: 'acme',
      displayName: 'Acme',
      multiTenant: true,
      userIdFormat: 'uuid',
      nakedDomain: true,
      primaryTenant: 'acme',
    });

    expect(tenant).toEqual({
      name: 'default',
      displayName: 'Acme',
      multiTenant: false,
      baseDomain: undefined,
      userIdFormat: 'uuid',
      primaryTenant: undefined,
      nakedDomain: false,
    });
  });

  it('preserves multi-tenant options when API custom domain is configured', () => {
    const tenant = normalizeTenantConfigForApiDomain({
      name: 'acme',
      displayName: 'Acme',
      multiTenant: true,
      baseDomain: 'oidc.example.com',
      userIdFormat: 'nanoid',
      nakedDomain: true,
      primaryTenant: 'main',
    });

    expect(tenant).toEqual({
      name: 'acme',
      displayName: 'Acme',
      multiTenant: true,
      baseDomain: 'oidc.example.com',
      userIdFormat: 'nanoid',
      primaryTenant: 'main',
      nakedDomain: true,
    });
  });

  it('keeps custom-domain setups single-tenant when multiTenant is disabled', () => {
    const tenant = normalizeTenantConfigForApiDomain({
      name: 'acme',
      displayName: 'Acme',
      multiTenant: false,
      baseDomain: 'oidc.example.com',
      userIdFormat: 'nanoid',
      nakedDomain: true,
      primaryTenant: 'main',
    });

    expect(tenant).toEqual({
      name: 'default',
      displayName: 'Acme',
      multiTenant: false,
      baseDomain: undefined,
      userIdFormat: 'nanoid',
      primaryTenant: undefined,
      nakedDomain: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { getSingleTenantId, isSingleTenantMode } from '../single-tenant-guard';

describe('single-tenant guard helpers', () => {
  it('treats missing BASE_DOMAIN as single-tenant mode', () => {
    expect(
      isSingleTenantMode({
        ISSUER_URL: 'https://prod-ar-router.example.workers.dev',
      } as Partial<Env>)
    ).toBe(true);
  });

  it('treats BASE_DOMAIN environments as multi-tenant mode', () => {
    expect(
      isSingleTenantMode({
        BASE_DOMAIN: 'oidc.example.com',
        ISSUER_URL: 'https://prod-ar-router.example.workers.dev',
      } as Partial<Env>)
    ).toBe(false);
  });

  it('uses DEFAULT_TENANT_ID as the only supported tenant in single-tenant mode', () => {
    expect(
      getSingleTenantId({
        DEFAULT_TENANT_ID: 'main',
      } as Partial<Env>)
    ).toBe('main');
  });
});

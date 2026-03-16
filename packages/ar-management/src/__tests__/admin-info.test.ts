import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { buildTenantBaseUrl, usesNakedDomainIssuer } from '../admin-info';

describe('admin-info tenant base URL resolution', () => {
  it('uses the naked domain for the default tenant when configured', () => {
    const env = {
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      ISSUER_URL: 'https://fallback.example.workers.dev',
    } as Env;

    expect(usesNakedDomainIssuer(env, 'default')).toBe(true);
    expect(buildTenantBaseUrl(env, 'default')).toBe('https://auth.example.com');
  });

  it('uses the naked domain for PRIMARY_TENANT_ID when configured', () => {
    const env = {
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      PRIMARY_TENANT_ID: 'acme',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      ISSUER_URL: 'https://fallback.example.workers.dev',
    } as Env;

    expect(usesNakedDomainIssuer(env, 'acme')).toBe(true);
    expect(buildTenantBaseUrl(env, 'acme')).toBe('https://auth.example.com');
  });

  it('keeps subdomain URLs for non-primary tenants', () => {
    const env = {
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      PRIMARY_TENANT_ID: 'primary',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      ISSUER_URL: 'https://fallback.example.workers.dev',
    } as Env;

    expect(usesNakedDomainIssuer(env, 'other-tenant')).toBe(false);
    expect(buildTenantBaseUrl(env, 'other-tenant')).toBe('https://other-tenant.auth.example.com');
  });

  it('keeps subdomain URLs when naked-domain issuer mode is disabled', () => {
    const env = {
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      ISSUER_URL: 'https://fallback.example.workers.dev',
    } as Env;

    expect(usesNakedDomainIssuer(env, 'default')).toBe(false);
    expect(buildTenantBaseUrl(env, 'default')).toBe('https://default.auth.example.com');
  });
});

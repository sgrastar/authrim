import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  buildTenantBaseUrl,
  getComponentAvailability,
  getConfiguredUiUrls,
  usesNakedDomainIssuer,
} from '../admin-info';

describe('admin-info tenant base URL resolution', () => {
  it('uses the naked domain for the default tenant when configured', () => {
    const env = {
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      ISSUER_URL: 'https://fallback.example.workers.dev',
    } as unknown as Env;

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
    } as unknown as Env;

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

  it('returns configured Login/Admin UI URLs when present', async () => {
    const env = {
      UI_URL: 'https://nodomain-ar-login-ui.pages.dev',
      ADMIN_UI_URL: 'https://nodomain-ar-admin-ui.pages.dev',
    } as Env;

    await expect(getConfiguredUiUrls(env)).resolves.toEqual({
      loginUiUrl: 'https://nodomain-ar-login-ui.pages.dev',
      adminUiUrl: 'https://nodomain-ar-admin-ui.pages.dev',
    });
  });

  it('prefers UI config from SETTINGS over env UI_URL', async () => {
    const env = {
      UI_URL: 'https://nodomain-ar-login-ui.pages.dev',
      ADMIN_UI_URL: 'https://nodomain-ar-admin-ui.pages.dev',
      SETTINGS: {
        get: async () =>
          JSON.stringify({
            ui: {
              baseUrl: 'https://configured-login.example.com',
            },
          }),
      },
    } as unknown as Env;

    await expect(getConfiguredUiUrls(env)).resolves.toEqual({
      loginUiUrl: 'https://configured-login.example.com',
      adminUiUrl: 'https://nodomain-ar-admin-ui.pages.dev',
    });
  });

  it('keeps global Login UI URL available even when built-in Login UI is disabled', async () => {
    const env = {
      UI_URL: 'https://nodomain-ar-login-ui.pages.dev',
      ADMIN_UI_URL: 'https://nodomain-ar-admin-ui.pages.dev',
      LOGIN_UI_ENABLED: 'false',
    } as unknown as Env;

    await expect(getConfiguredUiUrls(env)).resolves.toEqual({
      loginUiUrl: 'https://nodomain-ar-login-ui.pages.dev',
      adminUiUrl: 'https://nodomain-ar-admin-ui.pages.dev',
    });
  });

  it('derives component availability from env flags', () => {
    const env = {
      LOGIN_UI_ENABLED: 'false',
      ADMIN_UI_ENABLED: 'true',
      SAML_ENABLED: 'false',
      ASYNC_ENABLED: 'false',
      VC_ENABLED: 'false',
    } as unknown as Env;

    expect(getComponentAvailability(env)).toEqual({
      login_ui: false,
      admin_ui: true,
      saml: false,
      async: false,
      vc: false,
    });
  });
});

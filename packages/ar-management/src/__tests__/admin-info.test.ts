import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminTenantInfoHandler,
  buildTenantBaseUrl,
  getComponentAvailability,
  getConfiguredUiUrls,
  usesNakedDomainIssuer,
} from '../admin-info';

describe('admin-info tenant base URL resolution', () => {
  it('uses ISSUER_URL directly in single-tenant mode', () => {
    const env = {
      ISSUER_URL: 'https://login.example.com',
    } as unknown as Env;

    expect(usesNakedDomainIssuer(env, 'default')).toBe(false);
    expect(buildTenantBaseUrl(env, 'default')).toBe('https://login.example.com');
  });

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
      PRIMARY_TENANT_ID: 'primary',
      ISSUER_URL: 'https://fallback.example.workers.dev',
    } as Env;

    expect(usesNakedDomainIssuer(env, 'default')).toBe(false);
    expect(buildTenantBaseUrl(env, 'default')).toBe('https://default.auth.example.com');
    expect(usesNakedDomainIssuer(env, 'primary')).toBe(false);
    expect(buildTenantBaseUrl(env, 'primary')).toBe('https://primary.auth.example.com');
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

  it('includes global_login_ui_url in tenant info responses', async () => {
    const env = {
      UI_URL: 'https://nodomain-ar-login-ui.pages.dev',
      ADMIN_UI_URL: 'https://nodomain-ar-admin-ui.pages.dev',
      BASE_DOMAIN: 'auth.example.com',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'default',
              name: 'Default Tenant',
            }),
          }),
        }),
      },
    } as unknown as Env;

    const response = await adminTenantInfoHandler({
      req: {
        param: () => 'default',
      },
      env,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      get: vi.fn(),
    } as any);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      login_ui_url: string | null;
      global_login_ui_url: string | null;
      discover_url: string | null;
    };
    expect(body.login_ui_url).toBe('https://default.auth.example.com/login');
    expect(body.global_login_ui_url).toBe('https://nodomain-ar-login-ui.pages.dev/login');
    expect(body.discover_url).toBe('https://nodomain-ar-login-ui.pages.dev/discover');
  });

  it('uses naked-domain issuer login URL for the primary tenant', async () => {
    const env = {
      UI_URL: 'https://login.example.pages.dev',
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_TENANT_ID: 'default',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'default',
              name: 'Default Tenant',
            }),
          }),
        }),
      },
    } as unknown as Env;

    const response = await adminTenantInfoHandler({
      req: {
        param: () => 'default',
      },
      env,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      get: vi.fn(),
    } as any);

    const body = (await response.json()) as { login_ui_url: string | null };
    expect(body.login_ui_url).toBe('https://auth.example.com/login');
  });

  it('omits common-entry URLs in single-tenant mode', async () => {
    const env = {
      UI_URL: 'https://login.example.com',
      ISSUER_URL: 'https://login.example.com',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'default',
              name: 'Default Tenant',
            }),
          }),
        }),
      },
    } as unknown as Env;

    const response = await adminTenantInfoHandler({
      req: {
        param: () => 'default',
      },
      env,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      get: vi.fn(),
    } as any);

    const body = (await response.json()) as {
      login_ui_url: string | null;
      global_login_ui_url: string | null;
      discover_url: string | null;
    };
    expect(body.login_ui_url).toBe('https://login.example.com/login');
    expect(body.global_login_ui_url).toBeNull();
    expect(body.discover_url).toBeNull();
  });

  it('uses the configured Login UI URL in single-tenant mode when it differs from issuer', async () => {
    const env = {
      UI_URL: 'https://single-ar-login-ui.pages.dev',
      ISSUER_URL: 'https://single-ar-router.sgrastar.workers.dev',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'default',
              name: 'Default Tenant',
            }),
          }),
        }),
      },
    } as unknown as Env;

    const response = await adminTenantInfoHandler({
      req: {
        param: () => 'default',
      },
      env,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      get: vi.fn(),
    } as any);

    const body = (await response.json()) as {
      login_ui_url: string | null;
      global_login_ui_url: string | null;
      discover_url: string | null;
    };
    expect(body.login_ui_url).toBe('https://single-ar-login-ui.pages.dev/login');
    expect(body.global_login_ui_url).toBeNull();
    expect(body.discover_url).toBeNull();
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

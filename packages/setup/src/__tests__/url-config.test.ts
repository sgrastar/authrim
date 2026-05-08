import { describe, expect, it } from 'vitest';
import {
  buildInitialAdminSetupUrl,
  buildUrlsConfig,
  ensureHttps,
  getUiWorkersDevUrl,
  getWorkersDevUrl,
  resolveAdminUiEntryUrl,
  resolveIssuerUrl,
  resolveLoginUiEntryUrl,
  resolveTenantDiscoverUrl,
  validateDomainRoutingConfig,
} from '../core/url-config.js';
import type { AuthrimConfig } from '../core/config.js';

describe('url-config helpers', () => {
  it('adds https to bare domains and preserves explicit schemes', () => {
    expect(ensureHttps('example.com')).toBe('https://example.com');
    expect(ensureHttps('https://example.com')).toBe('https://example.com');
    expect(ensureHttps('http://example.com')).toBe('http://example.com');
    expect(ensureHttps(null)).toBeNull();
  });

  it('builds workers.dev and UI workers.dev URLs', () => {
    expect(getWorkersDevUrl('prod-ar-router')).toBe('https://prod-ar-router.workers.dev');
    expect(getWorkersDevUrl('prod-ar-router', 'acct-subdomain')).toBe(
      'https://prod-ar-router.acct-subdomain.workers.dev'
    );
    expect(getUiWorkersDevUrl('prod-ar-admin-ui')).toBe('https://prod-ar-admin-ui.workers.dev');
  });

  it('auto-detects sameAsApi for login and admin UI', () => {
    const urls = buildUrlsConfig({
      env: 'conformance',
      apiDomain: 'conformance.authrim.com',
      loginUiDomain: 'conformance.authrim.com',
      adminUiDomain: 'conformance.authrim.com',
      zoneId: 'zone-123',
      customDomainBinding: true,
      workersSubdomain: 'acct-subdomain',
    });

    expect(urls.api).toEqual({
      custom: 'https://conformance.authrim.com',
      auto: 'https://conformance-ar-router.acct-subdomain.workers.dev',
      zoneId: 'zone-123',
      customDomainBinding: true,
    });
    expect(urls.loginUi.sameAsApi).toBe(true);
    expect(urls.adminUi.sameAsApi).toBe(true);
  });

  it('preserves existing auto URLs when recomputing edited custom domains', () => {
    const urls = buildUrlsConfig({
      env: 'prod',
      apiDomain: 'id.example.com',
      loginUiDomain: 'login.example.com',
      adminUiDomain: 'id.example.com',
      existingUrls: {
        api: {
          custom: null,
          auto: 'https://prod-ar-router.saved-subdomain.workers.dev',
          zoneId: 'existing-zone',
          customDomainBinding: false,
        },
        loginUi: {
          custom: null,
          auto: 'https://prod-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://prod-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
    });

    expect(urls.api.auto).toBe('https://prod-ar-router.saved-subdomain.workers.dev');
    expect(urls.api.zoneId).toBe('existing-zone');
    expect(urls.loginUi.sameAsApi).toBe(false);
    expect(urls.adminUi.sameAsApi).toBe(true);
  });

  it('resolves issuer and setup URLs to the initial tenant subdomain in multi-tenant mode', () => {
    const config = {
      tenant: {
        name: 'first',
        multiTenant: true,
        baseDomain: 'multi-tenant.authrim.com',
        nakedDomain: false,
      },
      urls: {
        api: {
          custom: 'https://multi-tenant.authrim.com',
          auto: 'https://mt-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://mt-ar-login-ui.workers.dev',
          auto: 'https://mt-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://mt-ar-admin-ui.workers.dev',
          auto: 'https://mt-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
    } as Partial<AuthrimConfig>;

    expect(resolveIssuerUrl(config, { env: 'mt' })).toBe('https://first.multi-tenant.authrim.com');
    expect(buildInitialAdminSetupUrl(resolveIssuerUrl(config, { env: 'mt' }), 'token-123')).toBe(
      'https://first.multi-tenant.authrim.com/admin-init-setup?token=token-123'
    );
    expect(resolveLoginUiEntryUrl(config, { env: 'mt' })).toBe(
      'https://first.multi-tenant.authrim.com/login'
    );
    expect(resolveTenantDiscoverUrl(config, { env: 'mt' })).toBe(
      'https://mt-ar-login-ui.workers.dev/discover'
    );
    expect(resolveAdminUiEntryUrl(config, { env: 'mt' })).toBe(
      'https://mt-ar-admin-ui.workers.dev/admin/info'
    );
  });

  it('resolves issuer to the naked domain when configured', () => {
    const config = {
      tenant: {
        name: 'first',
        multiTenant: true,
        baseDomain: 'multi-tenant.authrim.com',
        nakedDomain: true,
      },
      urls: {
        api: {
          custom: 'https://multi-tenant.authrim.com',
          auto: 'https://mt-ar-router.example.workers.dev',
        },
      },
    } as Partial<AuthrimConfig>;

    expect(resolveIssuerUrl(config, { env: 'mt' })).toBe('https://multi-tenant.authrim.com');
  });

  it('keeps single-tenant URLs on the configured custom domain', () => {
    const config = {
      tenant: {
        name: 'default',
        multiTenant: false,
      },
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://prod-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.example.com',
          auto: 'https://prod-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.example.com',
          auto: 'https://prod-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
    } as Partial<AuthrimConfig>;

    expect(resolveIssuerUrl(config, { env: 'prod' })).toBe('https://auth.example.com');
    expect(resolveLoginUiEntryUrl(config, { env: 'prod' })).toBe('https://login.example.com/login');
    expect(resolveTenantDiscoverUrl(config, { env: 'prod' })).toBeNull();
    expect(resolveAdminUiEntryUrl(config, { env: 'prod' })).toBe(
      'https://admin.example.com/admin/info'
    );
  });

  it('rejects UI domains that collide with the API domain in multi-tenant subdomain mode', () => {
    expect(
      validateDomainRoutingConfig({
        apiDomain: 'oidc.example.com',
        loginUiDomain: 'oidc.example.com',
        adminUiDomain: 'admin.example.com',
        multiTenant: true,
        nakedDomain: false,
      })
    ).toEqual([
      {
        field: 'loginUiDomain',
        message:
          'UI custom domain cannot match the API domain in multi-tenant mode unless naked domain is enabled.',
      },
    ]);
  });

  it('allows same-origin UI domains when naked-domain routing is enabled', () => {
    expect(
      validateDomainRoutingConfig({
        apiDomain: 'oidc.example.com',
        loginUiDomain: 'oidc.example.com',
        adminUiDomain: 'oidc.example.com',
        multiTenant: true,
        nakedDomain: true,
      })
    ).toEqual([]);
  });
});

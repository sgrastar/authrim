import { describe, expect, it } from 'vitest';
import {
  buildUrlsConfig,
  ensureHttps,
  getPagesDevUrl,
  getWorkersDevUrl,
} from '../core/url-config.js';

describe('url-config helpers', () => {
  it('adds https to bare domains and preserves explicit schemes', () => {
    expect(ensureHttps('example.com')).toBe('https://example.com');
    expect(ensureHttps('https://example.com')).toBe('https://example.com');
    expect(ensureHttps('http://example.com')).toBe('http://example.com');
    expect(ensureHttps(null)).toBeNull();
  });

  it('builds workers.dev and pages.dev URLs', () => {
    expect(getWorkersDevUrl('prod-ar-router')).toBe('https://prod-ar-router.workers.dev');
    expect(getWorkersDevUrl('prod-ar-router', 'acct-subdomain')).toBe(
      'https://prod-ar-router.acct-subdomain.workers.dev'
    );
    expect(getPagesDevUrl('prod-ar-admin-ui')).toBe('https://prod-ar-admin-ui.pages.dev');
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
          auto: 'https://prod-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://prod-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
    });

    expect(urls.api.auto).toBe('https://prod-ar-router.saved-subdomain.workers.dev');
    expect(urls.api.zoneId).toBe('existing-zone');
    expect(urls.loginUi.sameAsApi).toBe(false);
    expect(urls.adminUi.sameAsApi).toBe(true);
  });
});

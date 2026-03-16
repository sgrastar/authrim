import { describe, expect, it } from 'vitest';
import type { AuthrimConfig } from '../core/config.js';
import { DISABLED_API_BACKEND_URL, resolveUiDeploymentSettings } from '../core/ui-deployment.js';

function createConfig(overrides: Partial<AuthrimConfig> = {}): AuthrimConfig {
  return {
    version: '1.0.0',
    createdAt: '2026-03-10T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
    environment: {
      prefix: 'test',
      ...overrides.environment,
    },
    urls: overrides.urls || {
      api: {
        custom: null,
        auto: 'https://test-ar-router.example.workers.dev',
      },
      loginUi: {
        custom: null,
        auto: 'https://test-ar-login-ui.pages.dev',
        sameAsApi: false,
      },
      adminUi: {
        custom: null,
        auto: 'https://test-ar-admin-ui.pages.dev',
        sameAsApi: false,
      },
    },
    tenant: {
      name: 'default',
      displayName: 'Default Tenant',
      multiTenant: true,
      baseDomain: 'example.com',
      userIdFormat: 'nanoid',
      ...overrides.tenant,
    },
    components: {
      api: true,
      loginUi: true,
      adminUi: true,
      saml: false,
      async: false,
      vc: false,
      bridge: true,
      policy: true,
      ...overrides.components,
    },
    oidc: {
      accessTokenTtl: 3600,
      refreshTokenTtl: 604800,
      authCodeTtl: 600,
      pkceRequired: true,
      responseTypes: ['code'],
      grantTypes: ['authorization_code', 'refresh_token'],
      ...overrides.oidc,
    },
    sharding: {
      authCodeShards: 4,
      refreshTokenShards: 4,
      sessionShards: 4,
      challengeShards: 4,
      flowStateShards: 32,
      ...overrides.sharding,
    },
    features: {
      queue: { enabled: false },
      r2: { enabled: false },
      email: { provider: 'none', configured: false },
      ...overrides.features,
    },
    keys: {
      secretsPath: './keys/',
      includeSecrets: false,
      storageType: 'external',
      ...overrides.keys,
    },
    cloudflare: {
      ...overrides.cloudflare,
    },
    database: {
      core: { location: 'auto', jurisdiction: 'none' },
      pii: { location: 'auto', jurisdiction: 'none' },
      ...overrides.database,
    },
    security: {
      piiEncryptionEnabled: true,
      domainHashEnabled: true,
      ...overrides.security,
    },
    profile: overrides.profile || 'basic-op',
  };
}

describe('resolveUiDeploymentSettings', () => {
  it('uses same-origin proxy mode for pages.dev UIs against a custom API domain', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'test.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Test',
        multiTenant: true,
        baseDomain: 'test.authrim.com',
        userIdFormat: 'nanoid',
      },
    });

    const login = resolveUiDeploymentSettings({
      component: 'ar-login-ui',
      config,
      loginUiClientId: 'login-ui-client',
    });
    const admin = resolveUiDeploymentSettings({
      component: 'ar-admin-ui',
      config,
    });

    expect(login.apiBaseUrl).toBe('https://test.authrim.com');
    expect(login.useRelativeApi).toBe(true);
    expect(login.needsProxy).toBe(true);
    expect(login.serviceBindingName).toBe('AR_ROUTER');
    expect(login.uiEnv.PUBLIC_API_BASE_URL).toBe('');
    // When custom domain is set, workers_dev is false so workers.dev is unreachable.
    // runtimeApiBackendUrl should use the custom domain (apiBaseUrl), not the disabled workers.dev URL.
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBe('https://test.authrim.com');
    expect(login.uiEnv.API_BACKEND_URL).toBe('https://test.authrim.com');
    expect(login.uiEnv.PUBLIC_AUTHRIM_ISSUER).toBe('https://test.authrim.com');
    expect(login.uiEnv.PUBLIC_LOGIN_UI_CLIENT_ID).toBe('login-ui-client');
    expect(login.runtimeApiBackendUrl).toBe('https://test.authrim.com');

    expect(admin.useRelativeApi).toBe(true);
    expect(admin.needsProxy).toBe(true);
    expect(admin.serviceBindingName).toBe('AR_ROUTER');
    expect(admin.uiEnv.PUBLIC_API_BASE_URL).toBe('');
    expect(admin.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBe('https://test.authrim.com');
    expect(admin.uiEnv.API_BACKEND_URL).toBe('https://test.authrim.com');
    expect(admin.uiEnv.PUBLIC_AUTHRIM_ISSUER).toBe('https://test.authrim.com');
    expect(admin.runtimeApiBackendUrl).toBe('https://test.authrim.com');
  });

  it('uses Service Binding proxy mode for workers.dev API and pages.dev Login UI', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: null,
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default',
        multiTenant: false,
        baseDomain: undefined,
        userIdFormat: 'nanoid',
      },
    });

    const login = resolveUiDeploymentSettings({
      component: 'ar-login-ui',
      config,
      loginUiClientId: 'login-ui-client',
    });

    expect(login.apiBaseUrl).toBe('https://test-ar-router.example.workers.dev');
    expect(login.uiUrl).toBe('https://test-ar-login-ui.pages.dev');
    expect(login.useRelativeApi).toBe(true);
    expect(login.needsProxy).toBe(true);
    expect(login.serviceBindingName).toBe('AR_ROUTER');
    expect(login.uiEnv.PUBLIC_API_BASE_URL).toBe('');
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBe(
      'https://test-ar-router.example.workers.dev'
    );
    expect(login.uiEnv.API_BACKEND_URL).toBe('https://test-ar-router.example.workers.dev');
    expect(login.uiEnv.PUBLIC_AUTHRIM_ISSUER).toBe('https://test-ar-router.example.workers.dev');
    expect(login.uiEnv.PUBLIC_LOGIN_UI_CLIENT_ID).toBe('login-ui-client');
    expect(login.runtimeApiBackendUrl).toBe('https://test-ar-router.example.workers.dev');
  });

  it('uses direct cross-origin API calls for same-site custom domains', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.example.com',
          auto: 'https://test-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.example.com',
          auto: 'https://test-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Example',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid',
      },
    });

    const login = resolveUiDeploymentSettings({
      component: 'ar-login-ui',
      config,
    });
    const admin = resolveUiDeploymentSettings({
      component: 'ar-admin-ui',
      config,
    });

    expect(login.useRelativeApi).toBe(false);
    expect(login.needsProxy).toBe(false);
    expect(login.serviceBindingName).toBeUndefined();
    expect(login.uiEnv.PUBLIC_API_BASE_URL).toBe('https://auth.example.com');
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(login.runtimeApiBackendUrl).toBe(DISABLED_API_BACKEND_URL);

    expect(admin.useRelativeApi).toBe(false);
    expect(admin.needsProxy).toBe(false);
    expect(admin.serviceBindingName).toBeUndefined();
    expect(admin.uiEnv.PUBLIC_API_BASE_URL).toBe('https://auth.example.com');
    expect(admin.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(admin.runtimeApiBackendUrl).toBe(DISABLED_API_BACKEND_URL);
  });

  it('keeps relative same-origin API calls when the UI is served on the API domain', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-login-ui.pages.dev',
          sameAsApi: true,
        },
        adminUi: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-admin-ui.pages.dev',
          sameAsApi: true,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Example',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid',
      },
    });

    const login = resolveUiDeploymentSettings({
      component: 'ar-login-ui',
      config,
    });

    expect(login.useRelativeApi).toBe(true);
    expect(login.needsProxy).toBe(false);
    expect(login.serviceBindingName).toBeUndefined();
    expect(login.uiEnv.PUBLIC_API_BASE_URL).toBe('');
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(login.runtimeApiBackendUrl).toBe(DISABLED_API_BACKEND_URL);
  });

  it('falls back to the public API URL for proxy mode when no auto backend URL exists', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'https://auth.example.com',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Example',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid',
      },
    });

    const login = resolveUiDeploymentSettings({
      component: 'ar-login-ui',
      config,
    });

    expect(login.needsProxy).toBe(true);
    expect(login.serviceBindingName).toBe('AR_ROUTER');
    expect(login.runtimeApiBackendUrl).toBe('https://auth.example.com');
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBe('https://auth.example.com');
    expect(login.uiEnv.API_BACKEND_URL).toBe('https://auth.example.com');
    expect(login.uiEnv.PUBLIC_AUTHRIM_ISSUER).toBe('https://auth.example.com');
  });

  it('sets PUBLIC_AUTHRIM_ISSUER for admin-ui (Service Binding forwarded host)', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Example',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid',
      },
    });

    const admin = resolveUiDeploymentSettings({
      component: 'ar-admin-ui',
      config,
    });

    // PUBLIC_AUTHRIM_ISSUER must be set for admin-ui so hooks.server.ts can
    // derive the correct X-Authrim-Forwarded-Host for Service Binding requests.
    expect(admin.uiEnv.PUBLIC_AUTHRIM_ISSUER).toBe('https://auth.example.com');
    expect(admin.needsProxy).toBe(true);
    expect(admin.serviceBindingName).toBe('AR_ROUTER');
  });
});

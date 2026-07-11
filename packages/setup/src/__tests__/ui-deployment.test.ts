import { describe, expect, it } from 'vitest';
import type { AuthrimConfig } from '../core/config.js';
import {
  describeAdminUiApiMode,
  DISABLED_API_BACKEND_URL,
  resolveUiDeploymentSettings,
  uiCustomDomainRequiresOwnRoute,
} from '../core/ui-deployment.js';

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
        auto: 'https://test-ar-login-ui.workers.dev',
        sameAsApi: false,
      },
      adminUi: {
        custom: null,
        auto: 'https://test-ar-admin-ui.workers.dev',
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
  it('uses same-origin proxy mode for UI Workers against a custom API domain', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'test.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
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
    expect(admin.adminUiApiMode).toBe('cross-site-proxy');
    expect(admin.serviceBindingName).toBe('AR_ROUTER');
    expect(admin.uiEnv.PUBLIC_API_BASE_URL).toBe('');
    expect(admin.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBe('https://test.authrim.com');
    expect(admin.uiEnv.API_BACKEND_URL).toBe('https://test.authrim.com');
    expect(admin.uiEnv.PUBLIC_AUTHRIM_ISSUER).toBe('https://test.authrim.com');
    expect(admin.runtimeApiBackendUrl).toBe('https://test.authrim.com');
  });

  it('uses Service Binding proxy mode for workers.dev API and Login UI Worker', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: null,
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
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
    expect(login.uiUrl).toBe('https://test-ar-login-ui.workers.dev');
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

  it('generates origin-bound Email Verification Origin Trial vars only for Login UI', () => {
    const token = 'A'.repeat(64);
    const tokens = {
      'https://login.example.com': token,
      'https://tenant.example.com': 'B'.repeat(64),
    };
    const config = createConfig({
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: {
          provider: 'cloudflare',
          configured: true,
          verificationProtocolOriginTrial: { tokens },
        },
      },
    });

    const login = resolveUiDeploymentSettings({ component: 'ar-login-ui', config });
    const admin = resolveUiDeploymentSettings({ component: 'ar-admin-ui', config });

    expect(login.uiEnv.EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS).toBe(JSON.stringify(tokens));
    expect(login.uiEnv.EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN).toBeUndefined();
    expect(admin.uiEnv.EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS).toBeUndefined();
    expect(admin.uiEnv.EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN).toBeUndefined();
  });

  it('supports the single-origin Origin Trial token fallback', () => {
    const token = 'A'.repeat(64);
    const config = createConfig({
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: {
          provider: 'cloudflare',
          configured: true,
          verificationProtocolOriginTrial: { token },
        },
      },
    });

    const login = resolveUiDeploymentSettings({ component: 'ar-login-ui', config });

    expect(login.uiEnv.EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN).toBe(token);
    expect(login.uiEnv.EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS).toBeUndefined();
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
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.example.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
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
    expect(login.workersDev).toBe(false);
    expect(login.routes).toEqual([{ pattern: 'login.example.com', custom_domain: true }]);
    expect(login.serviceBindingName).toBe('AR_ROUTER');
    expect(login.uiEnv.PUBLIC_API_BASE_URL).toBe('https://auth.example.com');
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(login.runtimeApiBackendUrl).toBe(DISABLED_API_BACKEND_URL);

    expect(admin.useRelativeApi).toBe(false);
    expect(admin.needsProxy).toBe(false);
    expect(admin.workersDev).toBe(false);
    expect(admin.routes).toEqual([{ pattern: 'admin.example.com', custom_domain: true }]);
    expect(admin.adminUiApiMode).toBe('same-site-cross-origin');
    expect(admin.serviceBindingName).toBeUndefined();
    expect(admin.uiEnv.PUBLIC_API_BASE_URL).toBe('https://auth.example.com');
    expect(admin.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(admin.runtimeApiBackendUrl).toBe(DISABLED_API_BACKEND_URL);
  });

  it('keeps workers.dev enabled when UI has no custom domain', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
    });

    const login = resolveUiDeploymentSettings({ component: 'ar-login-ui', config });
    const admin = resolveUiDeploymentSettings({ component: 'ar-admin-ui', config });

    expect(login.workersDev).toBe(true);
    expect(login.routes).toEqual([]);
    expect(admin.workersDev).toBe(true);
    expect(admin.routes).toEqual([]);
  });

  it.each([
    {
      name: 'single tenant custom UI subdomains are routed directly to UI Workers',
      tenant: {
        name: 'default',
        displayName: 'Default',
        multiTenant: false,
        baseDomain: undefined,
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://auth.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.authrim.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.authrim.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login.authrim.com', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin.authrim.com', custom_domain: true }],
      expectedLoginProxy: false,
      expectedAdminProxy: false,
      expectedAdminMode: 'same-site-cross-origin',
    },
    {
      name: 'single tenant cross-site UI domains are routed directly and use the UI BFF',
      tenant: {
        name: 'default',
        displayName: 'Default',
        multiTenant: false,
        baseDomain: undefined,
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.example.net',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.example.net',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login.example.net', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin.example.net', custom_domain: true }],
      expectedLoginProxy: true,
      expectedAdminProxy: true,
      expectedAdminMode: 'cross-site-proxy',
    },
    {
      name: 'multi tenant first-level UI hosts need exact UI custom-domain routes',
      tenant: {
        name: 'first',
        displayName: 'First',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.example.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.example.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login.example.com', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin.example.com', custom_domain: true }],
      expectedLoginProxy: false,
      expectedAdminProxy: false,
      expectedAdminMode: 'same-site-cross-origin',
    },
    {
      name: 'multi tenant UI hosts under a multi-label base need exact UI custom-domain routes',
      tenant: {
        name: 'first',
        displayName: 'First',
        multiTenant: true,
        baseDomain: 'multi-tenant.authrim.com',
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://multi-tenant.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.multi-tenant.authrim.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.multi-tenant.authrim.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login.multi-tenant.authrim.com', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin.multi-tenant.authrim.com', custom_domain: true }],
      expectedLoginProxy: false,
      expectedAdminProxy: false,
      expectedAdminMode: 'same-site-cross-origin',
    },
    {
      name: 'multi tenant UI hosts outside a multi-label base need direct custom-domain routes',
      tenant: {
        name: 'first',
        displayName: 'First',
        multiTenant: true,
        baseDomain: 'multi-tenant.authrim.com',
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://multi-tenant.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.authrim.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.authrim.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login.authrim.com', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin.authrim.com', custom_domain: true }],
      expectedLoginProxy: false,
      expectedAdminProxy: false,
      expectedAdminMode: 'same-site-cross-origin',
    },
    {
      name: 'multi tenant hyphenated first-level UI hosts need exact UI custom-domain routes',
      tenant: {
        name: 'first',
        displayName: 'First',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login-first.example.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin-first.example.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login-first.example.com', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin-first.example.com', custom_domain: true }],
      expectedLoginProxy: false,
      expectedAdminProxy: false,
      expectedAdminMode: 'same-site-cross-origin',
    },
    {
      name: 'multi tenant second-level UI hosts need exact UI custom-domain routes',
      tenant: {
        name: 'first',
        displayName: 'First',
        multiTenant: true,
        baseDomain: 'example.com',
        userIdFormat: 'nanoid' as const,
      },
      urls: {
        api: {
          custom: 'https://example.com',
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://login.first.example.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.first.example.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      expectedLoginRoutes: [{ pattern: 'login.first.example.com', custom_domain: true }],
      expectedAdminRoutes: [{ pattern: 'admin.first.example.com', custom_domain: true }],
      expectedLoginProxy: false,
      expectedAdminProxy: false,
      expectedAdminMode: 'same-site-cross-origin',
    },
  ])('$name', (scenario) => {
    const config = createConfig({
      tenant: scenario.tenant,
      urls: scenario.urls,
    });

    const login = resolveUiDeploymentSettings({ component: 'ar-login-ui', config });
    const admin = resolveUiDeploymentSettings({ component: 'ar-admin-ui', config });

    expect(login.workersDev).toBe(false);
    expect(admin.workersDev).toBe(false);
    expect(login.routes).toEqual(scenario.expectedLoginRoutes);
    expect(admin.routes).toEqual(scenario.expectedAdminRoutes);
    expect(login.needsProxy).toBe(scenario.expectedLoginProxy);
    expect(admin.needsProxy).toBe(scenario.expectedAdminProxy);
    expect(admin.adminUiApiMode).toBe(scenario.expectedAdminMode);
    expect(login.serviceBindingName).toBe('AR_ROUTER');
    expect(admin.serviceBindingName).toBe(scenario.expectedAdminProxy ? 'AR_ROUTER' : undefined);
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
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: true,
        },
        adminUi: {
          custom: 'https://auth.example.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
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
    const admin = resolveUiDeploymentSettings({
      component: 'ar-admin-ui',
      config,
    });

    expect(login.useRelativeApi).toBe(true);
    expect(login.needsProxy).toBe(false);
    expect(login.serviceBindingName).toBe('AR_ROUTER');
    expect(login.uiEnv.PUBLIC_API_BASE_URL).toBe('');
    expect(login.uiEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(login.runtimeApiBackendUrl).toBe(DISABLED_API_BACKEND_URL);

    expect(admin.useRelativeApi).toBe(true);
    expect(admin.needsProxy).toBe(false);
    expect(admin.adminUiApiMode).toBe('same-origin');
    expect(admin.serviceBindingName).toBeUndefined();
    expect(admin.uiEnv.PUBLIC_API_BASE_URL).toBe('');
  });

  it('falls back to the public API URL for proxy mode when no auto backend URL exists', () => {
    const config = createConfig({
      urls: {
        api: {
          custom: 'https://auth.example.com',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
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
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
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
    expect(admin.adminUiApiMode).toBe('cross-site-proxy');
    expect(admin.serviceBindingName).toBe('AR_ROUTER');
  });

  it('describes Admin UI API modes for operator output', () => {
    expect(describeAdminUiApiMode('same-origin')).toContain('same origin');
    expect(describeAdminUiApiMode('same-site-cross-origin')).toContain('credentialed CORS');
    expect(describeAdminUiApiMode('cross-site-proxy')).toContain('Worker BFF');
  });

  it.each([
    {
      name: 'workers.dev UI origin does not need a custom route',
      uiDomain: null,
      apiDomain: null,
      baseDomain: null,
      multiTenant: false,
      expected: false,
    },
    {
      name: 'same-as-api UI domain is served through the API/router worker',
      uiDomain: 'auth.example.com',
      apiDomain: 'auth.example.com',
      baseDomain: null,
      multiTenant: false,
      expected: false,
    },
    {
      name: 'single-tenant separate UI custom domain needs a direct UI route',
      uiDomain: 'login.example.com',
      apiDomain: 'auth.example.com',
      baseDomain: null,
      multiTenant: false,
      expected: true,
    },
    {
      name: 'multi-tenant immediate UI host needs a direct UI route',
      uiDomain: 'login.multi-tenant.example.com',
      apiDomain: 'multi-tenant.example.com',
      baseDomain: 'multi-tenant.example.com',
      multiTenant: true,
      expected: true,
    },
    {
      name: 'multi-tenant external UI host needs a direct UI route',
      uiDomain: 'login.example.com',
      apiDomain: 'multi-tenant.authrim.com',
      baseDomain: 'multi-tenant.authrim.com',
      multiTenant: true,
      expected: true,
    },
    {
      name: 'multi-tenant immediate UI host under a multi-label base needs a direct UI route',
      uiDomain: 'login.multi-tenant.authrim.com',
      apiDomain: 'multi-tenant.authrim.com',
      baseDomain: 'multi-tenant.authrim.com',
      multiTenant: true,
      expected: true,
    },
    {
      name: 'same-zone UI host outside a multi-label base needs its own route',
      uiDomain: 'login.authrim.com',
      apiDomain: 'multi-tenant.authrim.com',
      baseDomain: 'multi-tenant.authrim.com',
      multiTenant: true,
      expected: true,
    },
    {
      name: 'multi-tenant two-label UI host needs a direct UI route if loaded from config',
      uiDomain: 'login.first.example.com',
      apiDomain: 'example.com',
      baseDomain: 'example.com',
      multiTenant: true,
      expected: true,
    },
  ])('$name', (scenario) => {
    expect(
      uiCustomDomainRequiresOwnRoute({
        uiDomain: scenario.uiDomain,
        apiDomain: scenario.apiDomain,
        baseDomain: scenario.baseDomain,
        multiTenant: scenario.multiTenant,
      })
    ).toBe(scenario.expected);
  });
});

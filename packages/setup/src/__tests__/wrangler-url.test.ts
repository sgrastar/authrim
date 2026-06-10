/**
 * Wrangler URL / Env Vars Matrix Tests v2
 *
 * Tests generateEnvVars() and deriveAllowedOrigins() across 27 representative scenarios.
 * All expected values are hardcoded in deployment-matrix.ts — no calculation here.
 */

import { describe, it, expect } from 'vitest';
import { generateEnvVars, deriveAllowedOrigins } from '../core/wrangler.js';
import type { AuthrimConfig } from '../core/config.js';
import type { WorkerComponent } from '../core/naming.js';
import { classifyUiApiSite } from '../core/site-classifier.js';
import {
  SCENARIOS,
  buildAuthrimConfig,
  scenarioLabel,
  WORKERS_SUBDOMAIN,
} from '../../../../test/fixtures/deployment-matrix.js';

function expectedPrimaryTenantId(config: AuthrimConfig): string | undefined {
  if (!config.tenant?.multiTenant || !config.tenant.baseDomain) {
    return undefined;
  }

  return (
    config.tenant.primaryTenant || (config.tenant.nakedDomain ? config.tenant.name : undefined)
  );
}

function isMultiTenantConfigured(config: AuthrimConfig): boolean {
  return config.tenant?.multiTenant === true && !!config.tenant.baseDomain;
}

function expectedAdminUiApiMode(config: AuthrimConfig): string {
  const multiTenant = isMultiTenantConfigured(config);
  const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
  const issuerUrl = multiTenant ? config.urls?.api?.auto || '' : apiUrl;
  const adminUiUrl = config.urls?.adminUi?.sameAsApi
    ? apiUrl
    : config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || issuerUrl;
  const classification = classifyUiApiSite(apiUrl, adminUiUrl, {
    baseDomain: multiTenant ? config.tenant?.baseDomain : undefined,
  });

  return classification === 'cross-site' ? 'cross-site-proxy' : classification;
}

// =============================================================================
// deriveAllowedOrigins — 27 tests
// =============================================================================

describe('deriveAllowedOrigins', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const origins = deriveAllowedOrigins(config, WORKERS_SUBDOMAIN);

    expect(origins.sort()).toEqual(scenario.expected.allowedOrigins.sort());
  });
});

// =============================================================================
// generateEnvVars — ar-auth × 27 tests
// =============================================================================

describe('generateEnvVars - ar-auth', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
    const expected = scenario.expected.arAuthEnvVars;
    const effectiveApiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    const expectedUiUrl = isMultiTenantConfigured(config) ? effectiveApiUrl : expected.UI_URL;
    const expectedCookieSameSite = isMultiTenantConfigured(config)
      ? 'Lax'
      : expected.COOKIE_SAME_SITE;

    expect(vars['ISSUER_URL']).toBe(expected.ISSUER_URL);
    expect(vars['UI_URL']).toBe(expectedUiUrl);
    expect(vars['ADMIN_UI_URL']).toBe(expected.ADMIN_UI_URL);
    expect(vars['COOKIE_SAME_SITE']).toBe(expectedCookieSameSite);
    expect(vars['ADMIN_UI_API_MODE']).toBe(expectedAdminUiApiMode(config));
    expect(vars['ADMIN_COOKIE_SAME_SITE']).toBe('Lax');
    expect(vars['DEFAULT_TENANT_ID']).toBe(expected.DEFAULT_TENANT_ID);

    // BASE_DOMAIN
    if (expected.BASE_DOMAIN) {
      expect(vars['BASE_DOMAIN']).toBe(expected.BASE_DOMAIN);
    } else {
      expect(vars['BASE_DOMAIN']).toBeUndefined();
    }

    // PRIMARY_TENANT_ID
    const expectedPrimaryTenant = expected.PRIMARY_TENANT_ID || expectedPrimaryTenantId(config);
    if (expectedPrimaryTenant) {
      expect(vars['PRIMARY_TENANT_ID']).toBe(expectedPrimaryTenant);
    } else {
      expect(vars['PRIMARY_TENANT_ID']).toBeUndefined();
    }

    // NAKED_DOMAIN_AS_ISSUER
    if (expected.NAKED_DOMAIN_AS_ISSUER) {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBe('true');
    } else {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBeUndefined();
    }

    // ALLOWED_ORIGINS (order-insensitive)
    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      expected.ALLOWED_ORIGINS.split(',').sort()
    );
  });
});

// =============================================================================
// generateEnvVars — ar-management × 27 tests
// =============================================================================

describe('generateEnvVars - ar-management', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-management', config, WORKERS_SUBDOMAIN);
    const expected = scenario.expected.arManagementEnvVars;
    const effectiveApiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    const expectedUiUrl = isMultiTenantConfigured(config)
      ? effectiveApiUrl
      : scenario.expected.arAuthEnvVars.UI_URL;

    expect(vars['ISSUER_URL']).toBe(expected.ISSUER_URL);
    expect(vars['UI_URL']).toBe(expectedUiUrl);
    expect(vars['LOGIN_UI_ENABLED']).toBe((config.components?.loginUi ?? true) ? 'true' : 'false');
    expect(vars['ADMIN_UI_ENABLED']).toBe((config.components?.adminUi ?? true) ? 'true' : 'false');
    expect(vars['SAML_ENABLED']).toBe('true');
    expect(vars['ASYNC_ENABLED']).toBe('true');
    expect(vars['VC_ENABLED']).toBe('true');
    expect(vars['DEFAULT_TENANT_ID']).toBe(expected.DEFAULT_TENANT_ID);
    expect(vars['ADMIN_UI_URL']).toBe(expected.ADMIN_UI_URL);
    expect(vars['ADMIN_UI_API_MODE']).toBe(expectedAdminUiApiMode(config));
    expect(vars['ADMIN_COOKIE_SAME_SITE']).toBe('Lax');

    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      expected.ALLOWED_ORIGINS.split(',').sort()
    );

    if (scenario.config.baseDomain) {
      expect(vars['BASE_DOMAIN']).toBe(scenario.config.baseDomain);
    } else {
      expect(vars['BASE_DOMAIN']).toBeUndefined();
    }

    const expectedPrimaryTenant = expectedPrimaryTenantId(config);
    if (expectedPrimaryTenant) {
      expect(vars['PRIMARY_TENANT_ID']).toBe(expectedPrimaryTenant);
    } else {
      expect(vars['PRIMARY_TENANT_ID']).toBeUndefined();
    }

    if (scenario.config.nakedDomain) {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBe('true');
    } else {
      expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBeUndefined();
    }
  });
});

describe('generateEnvVars - ar-saml', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-saml', config, WORKERS_SUBDOMAIN);
    const effectiveApiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    const expectedUiUrl = isMultiTenantConfigured(config)
      ? effectiveApiUrl
      : scenario.expected.arAuthEnvVars.UI_URL;

    if (scenario.config.baseDomain) {
      expect(vars['ISSUER_URL']).toBe(scenario.config.apiAuto);
    } else {
      expect(vars['ISSUER_URL']).toBe(scenario.expected.issuerUrl);
    }

    expect(vars['UI_URL']).toBe(expectedUiUrl);
    expect(vars['LOGIN_UI_ENABLED']).toBe((config.components?.loginUi ?? true) ? 'true' : 'false');
    expect(vars['ENABLE_CONFORMANCE_MODE']).toBe('false');
    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      [...scenario.expected.allowedOrigins].sort()
    );
  });

  it('includes runtime profile defaults and registry backend for profile-aware workers', () => {
    const config = buildAuthrimConfig(SCENARIOS[0]) as AuthrimConfig;
    config.profiles = {
      defaults: {
        storage: 'builtin:storage:external-postgres',
        audit: 'builtin:audit:standard',
        residency: 'builtin:residency:eu',
      },
      registry: {
        backend: 'database',
      },
    };

    const authVars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
    const samlVars = generateEnvVars('ar-saml', config, WORKERS_SUBDOMAIN);

    expect(authVars['PROFILE_REGISTRY_BACKEND']).toBe('database');
    expect(authVars['DEFAULT_STORAGE_PROFILE_ID']).toBe('builtin:storage:external-postgres');
    expect(authVars['DEFAULT_AUDIT_PROFILE_ID']).toBe('builtin:audit:standard');
    expect(authVars['DEFAULT_RESIDENCY_PROFILE_ID']).toBe('builtin:residency:eu');

    expect(samlVars['PROFILE_REGISTRY_BACKEND']).toBe('database');
    expect(samlVars['DEFAULT_STORAGE_PROFILE_ID']).toBe('builtin:storage:external-postgres');
    expect(samlVars['DEFAULT_AUDIT_PROFILE_ID']).toBe('builtin:audit:standard');
    expect(samlVars['DEFAULT_RESIDENCY_PROFILE_ID']).toBe('builtin:residency:eu');
  });

  it('passes through built-in single-db profile defaults for profile-aware workers', () => {
    const config = buildAuthrimConfig(SCENARIOS[0]) as AuthrimConfig;
    config.profiles = {
      defaults: {
        storage: 'builtin:storage:single-db',
        audit: 'custom:audit:external-primary',
        residency: 'builtin:residency:default',
      },
      registry: {
        backend: 'kv',
      },
    };

    const authVars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
    const managementVars = generateEnvVars('ar-management', config, WORKERS_SUBDOMAIN);

    expect(authVars['PROFILE_REGISTRY_BACKEND']).toBe('kv');
    expect(authVars['DEFAULT_STORAGE_PROFILE_ID']).toBe('builtin:storage:single-db');
    expect(authVars['DEFAULT_AUDIT_PROFILE_ID']).toBe('custom:audit:external-primary');
    expect(managementVars['DEFAULT_STORAGE_PROFILE_ID']).toBe('builtin:storage:single-db');
  });
});

// =============================================================================
// generateEnvVars — ar-router × 27 tests
// =============================================================================

describe('generateEnvVars - ar-router', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-router', config, WORKERS_SUBDOMAIN);
    const expected = scenario.expected.arRouterEnvVars;

    expect(vars['DEFAULT_TENANT_ID']).toBe(expected.DEFAULT_TENANT_ID);

    // ar-router does NOT get ISSUER_URL
    expect(vars['ISSUER_URL']).toBeUndefined();

    expect(vars['ALLOWED_ORIGINS']).toBeDefined();
    expect(vars['ALLOWED_ORIGINS'].split(',').sort()).toEqual(
      expected.ALLOWED_ORIGINS.split(',').sort()
    );

    // UI proxy flags — always present on ar-router
    const adminSameAsApi = scenario.config.adminUiSameAsApi;
    const adminProxyEnabled = adminSameAsApi || !!scenario.config.baseDomain;
    const loginProxyEnabled = scenario.config.loginUiSameAsApi || !!scenario.config.baseDomain;

    expect(vars['ENABLE_ADMIN_UI_PROXY']).toBe(adminProxyEnabled ? 'true' : 'false');
    expect(vars['ENABLE_LOGIN_UI_PROXY']).toBe(loginProxyEnabled ? 'true' : 'false');
    const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    const expectedLoginUiUrl =
      scenario.config.loginUiSameAsApi || !!scenario.config.baseDomain
        ? apiUrl
        : config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || apiUrl;
    expect(vars['LOGIN_UI_URL']).toBe(expectedLoginUiUrl);

    // AR_ADMIN_UI_URL is set when ar-router owns Admin UI paths.
    if (adminProxyEnabled) {
      const adminUiWorkerUrl = scenario.config.adminUiAuto ?? scenario.config.adminUiCustom;
      expect(vars['AR_ADMIN_UI_URL']).toBe(adminUiWorkerUrl ?? undefined);
    } else {
      expect(vars['AR_ADMIN_UI_URL']).toBeUndefined();
    }

    // AR_LOGIN_UI_URL is set only when loginSameAsApi=true
    if (loginProxyEnabled) {
      const loginUiWorkerUrl = scenario.config.loginUiAuto ?? scenario.config.loginUiCustom;
      expect(vars['AR_LOGIN_UI_URL']).toBe(loginUiWorkerUrl ?? undefined);
    } else {
      expect(vars['AR_LOGIN_UI_URL']).toBeUndefined();
    }
  });
});

// =============================================================================
// Setup URL base — 27 tests
// =============================================================================

describe('Setup URL base', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario);
    const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
    expect(apiUrl).toBe(scenario.expected.setupUrlBase);
  });
});

// =============================================================================
// sameAsApi UI_URL uses API domain (previously a spec gap, now fixed)
// =============================================================================

describe('sameAsApi produces UI_URL = API domain', () => {
  const sameAsApiScenarios = SCENARIOS.filter((s) => s.config.loginUiSameAsApi);

  it.each(sameAsApiScenarios.map((s) => [scenarioLabel(s), s] as const))(
    '%s - UI_URL should be API domain',
    (_label, scenario) => {
      const config = buildAuthrimConfig(scenario) as AuthrimConfig;
      const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
      const samlVars = generateEnvVars('ar-saml', config, WORKERS_SUBDOMAIN);
      const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
      expect(vars['UI_URL']).toBe(apiUrl);
      expect(samlVars['UI_URL']).toBe(apiUrl);
    }
  );
});

describe('multi-tenant login UI canonical routing', () => {
  it('uses the API domain as UI_URL and enables login UI proxy even when loginUi.sameAsApi is false', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
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
        displayName: 'Default Tenant',
        multiTenant: true,
        baseDomain: 'test.authrim.com',
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      cloudflare: {},
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const authVars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);
    const samlVars = generateEnvVars('ar-saml', config, WORKERS_SUBDOMAIN);
    const routerVars = generateEnvVars('ar-router', config, WORKERS_SUBDOMAIN);

    expect(authVars['UI_URL']).toBe('https://test.authrim.com');
    expect(samlVars['UI_URL']).toBe('https://test.authrim.com');
    expect(authVars['COOKIE_SAME_SITE']).toBe('Lax');
    expect(routerVars['ENABLE_LOGIN_UI_PROXY']).toBe('true');
    expect(routerVars['AR_LOGIN_UI_URL']).toBe('https://test-ar-login-ui.my-project.workers.dev');
  });
});

// =============================================================================
// ISSUER_URL consistency — verify wrangler ISSUER_URL aligns with issuer logic
// =============================================================================

describe('ISSUER_URL consistency with runtime issuer', () => {
  it.each(SCENARIOS.map((s) => [scenarioLabel(s), s] as const))('%s', (_label, scenario) => {
    const config = buildAuthrimConfig(scenario) as AuthrimConfig;
    const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);

    if (scenario.config.baseDomain) {
      // Multi-tenant mode: runtime issuer is built from BASE_DOMAIN and tenant context.
      // The ISSUER_URL env var remains the auto (workers.dev) fallback for internal routing.
      expect(vars['ISSUER_URL']).toBe(scenario.config.apiAuto);
    } else {
      // Single-tenant mode: buildIssuerUrl() uses env.ISSUER_URL directly.
      // The ISSUER_URL env var must equal the expected runtime issuer URL.
      expect(vars['ISSUER_URL']).toBe(scenario.expected.issuerUrl);
    }
  });
});

describe('generateEnvVars - explicit tenant mode toggles', () => {
  it('passes tenant resolution variables to every request-context worker', () => {
    const config = buildAuthrimConfig(
      SCENARIOS.find((scenario) => scenario.config.baseDomain) ?? SCENARIOS[0]
    ) as AuthrimConfig;
    config.tenant = {
      name: 'first',
      displayName: 'First Tenant',
      multiTenant: true,
      baseDomain: 'multi-tenant.authrim.com',
      primaryTenant: 'first',
      nakedDomain: false,
      userIdFormat: 'nanoid',
    };

    const tenantAwareComponents: WorkerComponent[] = [
      'ar-discovery',
      'ar-auth',
      'ar-token',
      'ar-userinfo',
      'ar-management',
      'ar-router',
      'ar-async',
      'ar-policy',
      'ar-saml',
      'ar-bridge',
      'ar-vc',
    ];

    for (const component of tenantAwareComponents) {
      const vars = generateEnvVars(component, config, WORKERS_SUBDOMAIN);
      expect(vars['DEFAULT_TENANT_ID']).toBe('first');
      expect(vars['BASE_DOMAIN']).toBe('multi-tenant.authrim.com');
      expect(vars['PRIMARY_TENANT_ID']).toBe('first');
    }
  });

  it('does not enable naked-domain issuer mode just because PRIMARY_TENANT_ID is set', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
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
        baseDomain: 'test.authrim.com',
        primaryTenant: 'acme',
        nakedDomain: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      cloudflare: {},
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);

    expect(vars['DEFAULT_TENANT_ID']).toBe('default');
    expect(vars['BASE_DOMAIN']).toBe('test.authrim.com');
    expect(vars['PRIMARY_TENANT_ID']).toBe('acme');
    expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBeUndefined();
  });

  it('defaults PRIMARY_TENANT_ID to the initial tenant when naked-domain mode is enabled', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
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
        name: 'acme',
        displayName: 'Acme',
        multiTenant: true,
        baseDomain: 'test.authrim.com',
        nakedDomain: true,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      cloudflare: {},
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const vars = generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN);

    expect(vars['DEFAULT_TENANT_ID']).toBe('acme');
    expect(vars['PRIMARY_TENANT_ID']).toBe('acme');
    expect(vars['NAKED_DOMAIN_AS_ISSUER']).toBe('true');
  });
});

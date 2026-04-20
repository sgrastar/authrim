import { describe, expect, it } from 'vitest';
import { generateRoutes, generateWranglerConfig, toToml } from '../core/wrangler.js';
import type { AuthrimConfig } from '../core/config.js';

describe('generateRoutes', () => {
  it('adds Cloudflare Email Service bindings only to ar-auth and ar-management', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'emailtest' },
      urls: {
        api: {
          custom: null,
          auto: 'https://emailtest-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://emailtest-ar-login-ui.pages.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://emailtest-ar-admin-ui.pages.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
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
        flowStateShards: 32,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: {
          provider: 'cloudflare',
          fromAddress: 'noreply@example.com',
          fromName: 'Authrim',
          configured: true,
        },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {},
    };

    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);
    const tokenConfig = generateWranglerConfig('ar-token', config, resourceIds);

    expect(authConfig.send_email).toEqual([{ name: 'EMAIL' }]);
    expect(managementConfig.send_email).toEqual([{ name: 'EMAIL' }]);
    expect(tokenConfig.send_email).toBeUndefined();
    expect(authConfig.vars.EMAIL_FROM).toBe('noreply@example.com');
    expect(authConfig.vars.EMAIL_FROM_NAME).toBe('Authrim');
  });

  it('serializes send_email bindings in env-scoped wrangler.toml output', () => {
    const config = {
      main: 'src/index.ts',
      compatibility_date: '2026-04-21',
      compatibility_flags: ['nodejs_compat'],
      name: 'authrim-email',
      workers_dev: false,
      vars: {},
      send_email: [
        {
          name: 'EMAIL',
        },
      ],
    };

    const toml = toToml(config, 'prod');

    expect(toml).toContain('[[env.prod.send_email]]');
    expect(toml).not.toContain('[[send_email]]');
    expect(toml).not.toContain('env.undefined.send_email');
  });

  it('serializes send_email bindings once in legacy wrangler.toml output', () => {
    const config = {
      main: 'src/index.ts',
      compatibility_date: '2026-04-21',
      compatibility_flags: ['nodejs_compat'],
      name: 'authrim-email',
      workers_dev: false,
      vars: {},
      send_email: [
        {
          name: 'EMAIL',
        },
      ],
    };

    const toml = toToml(config);

    expect((toml.match(/\[\[send_email\]\]/g) ?? [])).toHaveLength(1);
    expect(toml).not.toContain('env.undefined.send_email');
  });

  it('routes admin setup and admin auth endpoints to ar-auth', () => {
    const routes = generateRoutes('ar-auth', 'conformance.authrim.com', 'authrim.com');
    const patterns = routes.map((route) => route.pattern);

    expect(patterns).toContain('conformance.authrim.com/api/admin/setup-token/*');
    expect(patterns).toContain('conformance.authrim.com/api/admin/auth/*');
  });

  it('does not assign broad admin API routes to ar-management', () => {
    const routes = generateRoutes('ar-management', 'conformance.authrim.com', 'authrim.com');
    const patterns = routes.map((route) => route.pattern);

    expect(patterns).toContain('conformance.authrim.com/register');
    expect(patterns).not.toContain('conformance.authrim.com/api/admin/*');
  });

  it('assigns custom-domain routes only to ar-router in router mode', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'conformance' },
      urls: {
        api: {
          custom: 'https://conformance.authrim.com',
          auto: 'https://conformance-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://conformance.authrim.com',
          auto: 'https://conformance-ar-login-ui.pages.dev',
          sameAsApi: true,
        },
        adminUi: {
          custom: 'https://conformance.authrim.com',
          auto: 'https://conformance-ar-admin-ui.pages.dev',
          sameAsApi: true,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
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
        flowStateShards: 32,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {},
    };

    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);
    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);

    expect(routerConfig.routes).toEqual([
      { pattern: 'conformance.authrim.com/*', zone_name: 'authrim.com' },
    ]);
    expect(authConfig.routes).toBeUndefined();
    expect(managementConfig.routes).toBeUndefined();
  });

  it('uses custom_domain=true for the base domain and wildcard routes for tenant subdomains', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
          customDomainBinding: true,
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
        userIdFormat: 'nanoid',
        baseDomain: 'test.authrim.com',
        nakedDomain: true,
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
        flowStateShards: 32,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(routerConfig.routes).toEqual([
      { pattern: 'test.authrim.com', custom_domain: true },
      { pattern: '*.test.authrim.com/*', zone_name: 'authrim.com' },
    ]);
    // workers_dev should be false when custom domain is set
    expect(routerConfig.workers_dev).toBe(false);
  });

  it('adds wildcard tenant routes in route mode when BASE_DOMAIN is configured', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
          customDomainBinding: false,
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
        userIdFormat: 'nanoid',
        baseDomain: 'test.authrim.com',
        nakedDomain: false,
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
        flowStateShards: 32,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(routerConfig.routes).toEqual([
      { pattern: 'test.authrim.com/*', zone_name: 'authrim.com' },
      { pattern: '*.test.authrim.com/*', zone_name: 'authrim.com' },
    ]);
  });

  it('adds OP_VC service binding to ar-router when VC is enabled', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
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
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: true,
        bridge: false,
        policy: false,
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
        flowStateShards: 32,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(routerConfig.services).toEqual(
      expect.arrayContaining([{ binding: 'OP_VC', service: 'test-ar-vc' }])
    );
  });
});

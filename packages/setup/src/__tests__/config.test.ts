/**
 * Configuration Module Tests
 */

import { describe, it, expect } from 'vitest';
import { AuthrimConfigSchema, createDefaultConfig, parseConfig } from '../core/config.js';

describe('AuthrimConfigSchema', () => {
  it('should validate a minimal config', () => {
    const config = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'test' },
      tenant: { name: 'default' },
      components: { api: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      features: {},
      keys: {},
    };

    const result = AuthrimConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should reject invalid profile', () => {
    const config = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'test' },
      tenant: { name: 'default' },
      components: { api: true },
      profile: 'invalid-profile',
      oidc: {},
      sharding: {},
      features: {},
      keys: {},
    };

    const result = AuthrimConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('should validate URL configuration', () => {
    const config = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'prod' },
      tenant: { name: 'default' },
      components: { api: true },
      profile: 'basic-op',
      urls: {
        api: {
          custom: 'https://auth.example.com',
          auto: 'https://prod-ar-router.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://prod-ar-login-ui.workers.dev',
        },
        adminUi: {
          custom: null,
          auto: 'https://prod-ar-admin-ui.workers.dev',
        },
      },
      oidc: {},
      sharding: {},
      features: {},
      keys: {},
    };

    const result = AuthrimConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.urls?.api?.custom).toBe('https://auth.example.com');
    }
  });

  it('rejects tenant identifiers with uppercase characters', () => {
    const baseConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'prod' },
      components: { api: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      features: {},
      keys: {},
    };

    expect(
      AuthrimConfigSchema.safeParse({
        ...baseConfig,
        tenant: { name: 'OIDC' },
      }).success
    ).toBe(false);

    expect(
      AuthrimConfigSchema.safeParse({
        ...baseConfig,
        tenant: {
          name: 'default',
          multiTenant: true,
          baseDomain: 'conformance.authrim.com',
          nakedDomain: true,
          primaryTenant: 'OIDC',
        },
      }).success
    ).toBe(false);
  });
});

describe('createDefaultConfig', () => {
  it('should create a default config with prod prefix', () => {
    const config = createDefaultConfig('prod');

    expect(config.environment.prefix).toBe('prod');
    expect(config.profile).toBe('basic-op');
    expect(config.components.api).toBe(true);
    expect(config.components.loginUi).toBe(true);
    expect(config.components.adminUi).toBe(true);
    expect(config.components.saml).toBe(true);
    expect(config.components.async).toBe(true);
    expect(config.components.vc).toBe(true);
    expect(config.profiles.defaults.storage).toBe('builtin:storage:shared-d1');
    expect(config.profiles.registry.backend).toBe('kv');
  });

  it('should create a default config with custom prefix', () => {
    const config = createDefaultConfig('staging');

    expect(config.environment.prefix).toBe('staging');
  });
});

describe('parseConfig', () => {
  it('should parse and validate a config object', () => {
    const rawConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      tenant: { name: 'test-tenant' },
      components: { api: true, loginUi: true },
      profile: 'fapi-rw',
      oidc: { accessTokenTtl: 7200 },
      sharding: { authCodeShards: 32 },
      profiles: {
        defaults: {
          storage: 'builtin:storage:external-postgres',
          audit: 'builtin:audit:standard',
          residency: 'builtin:residency:eu',
        },
        registry: {
          backend: 'database',
        },
      },
      features: {},
      keys: {},
    };

    const config = parseConfig(rawConfig);

    expect(config.environment.prefix).toBe('dev');
    expect(config.tenant.name).toBe('test-tenant');
    expect(config.profile).toBe('fapi-rw');
    expect(config.components.saml).toBe(true);
    expect(config.components.async).toBe(true);
    expect(config.components.vc).toBe(true);
    expect(config.oidc.accessTokenTtl).toBe(7200);
    expect(config.profiles.defaults.storage).toBe('builtin:storage:external-postgres');
    expect(config.profiles.registry.backend).toBe('database');
  });

  it('should accept built-in shared, tenant, single-db, and eu-pii storage profile IDs', () => {
    const rawConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      tenant: { name: 'test-tenant' },
      components: { api: true, loginUi: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      profiles: {
        defaults: {
          storage: 'builtin:storage:single-db',
          audit: 'builtin:audit:standard',
          residency: 'builtin:residency:eu',
        },
        registry: {
          backend: 'kv',
        },
      },
      features: {},
      keys: {},
    };

    const config = parseConfig(rawConfig);
    expect(config.profiles.defaults.storage).toBe('builtin:storage:single-db');

    rawConfig.profiles.defaults.storage = 'builtin:storage:shared-d1';
    const sharedConfig = parseConfig(rawConfig);
    expect(sharedConfig.profiles.defaults.storage).toBe('builtin:storage:shared-d1');

    rawConfig.profiles.defaults.storage = 'builtin:storage:tenant-d1';
    const tenantConfig = parseConfig(rawConfig);
    expect(tenantConfig.profiles.defaults.storage).toBe('builtin:storage:tenant-d1');

    rawConfig.profiles.defaults.storage = 'builtin:storage:eu-pii-split';
    const euConfig = parseConfig(rawConfig);
    expect(euConfig.profiles.defaults.storage).toBe('builtin:storage:eu-pii-split');
  });

  it('should reject the removed built-in minimal audit profile', () => {
    const rawConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      tenant: { name: 'test-tenant' },
      components: { api: true, loginUi: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      profiles: {
        defaults: {
          storage: 'builtin:storage:shared-d1',
          audit: 'builtin:audit:minimal',
          residency: 'builtin:residency:default',
        },
      },
      features: {},
      keys: {},
    };

    const result = AuthrimConfigSchema.safeParse(rawConfig);
    expect(result.success).toBe(false);
  });

  it('should default tenant D1 preallocated slots to 3', () => {
    const config = parseConfig({
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      tenant: { name: 'test-tenant' },
      components: { api: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      features: {},
      keys: {},
    });

    expect(config.tenantD1.preallocatedSlots).toBe(3);
  });

  it('should constrain tenant D1 preallocated slots to 1 through 500', () => {
    const baseConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      tenant: { name: 'test-tenant' },
      components: { api: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      features: {},
      keys: {},
    };

    expect(
      AuthrimConfigSchema.safeParse({
        ...baseConfig,
        tenantD1: { preallocatedSlots: 1 },
      }).success
    ).toBe(true);
    expect(
      AuthrimConfigSchema.safeParse({
        ...baseConfig,
        tenantD1: { preallocatedSlots: 500 },
      }).success
    ).toBe(true);
    expect(
      AuthrimConfigSchema.safeParse({
        ...baseConfig,
        tenantD1: { preallocatedSlots: 0 },
      }).success
    ).toBe(false);
    expect(
      AuthrimConfigSchema.safeParse({
        ...baseConfig,
        tenantD1: { preallocatedSlots: 501 },
      }).success
    ).toBe(false);
  });

  it('should accept Hyperdrive reference catalog entries for external storage defaults', () => {
    const rawConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      tenant: { name: 'test-tenant' },
      components: { api: true, loginUi: true },
      profile: 'basic-op',
      oidc: {},
      sharding: {},
      profiles: {
        defaults: {
          storage: 'builtin:storage:external-postgres',
          audit: 'builtin:audit:standard',
          residency: 'builtin:residency:default',
        },
        registry: {
          backend: 'kv',
        },
        references: {
          hyperdrive: {
            'core-primary': {
              binding: 'HYPERDRIVE_CORE_PRIMARY',
              id: 'hyperdrive-core-id',
              driver: 'postgres',
            },
            'pii-primary': {
              binding: 'HYPERDRIVE_PII_PRIMARY',
              id: 'hyperdrive-pii-id',
              driver: 'postgres',
            },
          },
        },
      },
      features: {},
      keys: {},
    };

    const config = parseConfig(rawConfig);
    expect(config.profiles.references.hyperdrive['core-primary']).toEqual({
      binding: 'HYPERDRIVE_CORE_PRIMARY',
      id: 'hyperdrive-core-id',
      driver: 'postgres',
    });
  });

  it('should accept seeded audit profiles with generic HTTP sinks', () => {
    const rawConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      environment: { prefix: 'dev' },
      profiles: {
        defaults: {
          storage: 'builtin:storage:standard',
          audit: 'custom:audit:http-export',
          residency: 'builtin:residency:default',
        },
        registry: {
          backend: 'kv',
        },
        seed: {
          audit: [
            {
              id: 'custom:audit:http-export',
              label: 'HTTP Export',
              primary: null,
              archive: null,
              sinks: [
                {
                  type: 'http',
                  url: 'https://example.com/audit',
                  headers: {
                    'X-Authrim-Sink': 'enabled',
                  },
                },
              ],
            },
          ],
        },
      },
      features: {},
      keys: {},
    };

    const config = parseConfig(rawConfig);
    expect(config.profiles.defaults.audit).toBe('custom:audit:http-export');
    expect(config.profiles.seed.audit[0].sinks[0]).toEqual(
      expect.objectContaining({
        type: 'http',
        url: 'https://example.com/audit',
      })
    );
  });

  it('should throw on invalid config', () => {
    const invalidConfig = {
      version: '1.0.0',
      // Missing required fields
    };

    expect(() => parseConfig(invalidConfig)).toThrow();
  });
});

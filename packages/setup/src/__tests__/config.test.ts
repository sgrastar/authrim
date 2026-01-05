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
          auto: 'https://prod-ar-ui.pages.dev',
        },
        adminUi: {
          custom: null,
          auto: 'https://prod-ar-ui.pages.dev/admin',
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
});

describe('createDefaultConfig', () => {
  it('should create a default config with prod prefix', () => {
    const config = createDefaultConfig('prod');

    expect(config.environment.prefix).toBe('prod');
    expect(config.profile).toBe('basic-op');
    expect(config.components.api).toBe(true);
    expect(config.components.loginUi).toBe(true);
    expect(config.components.adminUi).toBe(true);
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
      features: {},
      keys: {},
    };

    const config = parseConfig(rawConfig);

    expect(config.environment.prefix).toBe('dev');
    expect(config.tenant.name).toBe('test-tenant');
    expect(config.profile).toBe('fapi-rw');
    expect(config.oidc.accessTokenTtl).toBe(7200);
  });

  it('should throw on invalid config', () => {
    const invalidConfig = {
      version: '1.0.0',
      // Missing required fields
    };

    expect(() => parseConfig(invalidConfig)).toThrow();
  });
});

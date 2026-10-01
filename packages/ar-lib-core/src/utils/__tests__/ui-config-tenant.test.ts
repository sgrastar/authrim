import { beforeEach, describe, expect, it, vi } from 'vitest';

const vanity = vi.hoisted(() => ({ primary: vi.fn() }));
vi.mock('../../services/tenant-vanity-domain-resolver', () => ({
  getPrimaryTenantVanityDomain: vanity.primary,
}));
import {
  DEFAULT_UI_PATHS,
  getTenantUIConfig,
  getUIConfig,
  isValidUIPath,
  validateTenantUIBaseUrl,
  validateTenantUIBaseUrlAsync,
} from '../ui-config';

function kv(values: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => {
      const value = values[key];
      if (value instanceof Error) throw value;
      return value === undefined ? null : JSON.stringify(value);
    },
  } as unknown as KVNamespace;
}

const platformUi = {
  system_settings: { ui: { baseUrl: 'https://login.example.com', paths: { login: '/signin' } } },
};

describe("a tenant's UI settings", () => {
  beforeEach(() => {
    vanity.primary.mockReset().mockResolvedValue(null);
  });

  it("accepts the tenant's own custom domain, and no other tenant's", async () => {
    vanity.primary.mockImplementation(async (_env: unknown, tenantId: string) =>
      tenantId === 'acme' ? { hostname: 'identity.acme.example' } : null
    );
    const env = {
      SETTINGS: kv({
        ...platformUi,
        'settings:tenant:acme:tenant': { 'tenant.ui_base_url': 'https://identity.acme.example' },
        'settings:tenant:other:tenant': { 'tenant.ui_base_url': 'https://identity.acme.example' },
      }),
      ISSUER_URL: 'https://id.example.com',
    };

    await expect(getTenantUIConfig(env, 'acme')).resolves.toMatchObject({
      config: { baseUrl: 'https://identity.acme.example' },
      tenantBaseUrl: true,
    });
    // Another tenant cannot point its UI at acme's domain.
    await expect(getTenantUIConfig(env, 'other')).resolves.toMatchObject({
      config: { baseUrl: 'https://login.example.com' },
      tenantBaseUrl: false,
    });
    expect(
      (await validateTenantUIBaseUrlAsync('https://identity.acme.example', env, 'other')).valid
    ).toBe(false);
  });

  it('keeps the platform UI when the tenant sets nothing', async () => {
    const env = { SETTINGS: kv(platformUi), ISSUER_URL: 'https://id.example.com' };
    await expect(getUIConfig(env, 'acme')).resolves.toEqual(await getUIConfig(env));
    await expect(getTenantUIConfig(env, 'acme')).resolves.toMatchObject({ tenantBaseUrl: false });
  });

  it("uses the tenant's base URL and paths over the platform's", async () => {
    const env = {
      SETTINGS: kv({
        ...platformUi,
        'settings:tenant:acme:tenant': {
          'tenant.ui_base_url': 'https://acme-login.example.org/',
          'tenant.ui_consent_path': '/approve',
        },
      }),
      ISSUER_URL: 'https://id.example.com',
      ALLOWED_ORIGINS: 'https://acme-login.example.org',
    };

    const { config, tenantBaseUrl } = await getTenantUIConfig(env, 'acme');
    expect(tenantBaseUrl).toBe(true);
    expect(config).toEqual({
      baseUrl: 'https://acme-login.example.org',
      // The platform's own paths still apply where the tenant sets none.
      paths: { ...DEFAULT_UI_PATHS, login: '/signin', consent: '/approve' },
    });
    // Other tenants keep the platform's UI.
    await expect(getUIConfig(env, 'other')).resolves.toMatchObject({
      baseUrl: 'https://login.example.com',
    });
  });

  it('accepts the tenant’s own issuer host as its UI origin', async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:tenant': { 'tenant.ui_base_url': 'https://acme.example.com' },
      }),
      BASE_DOMAIN: 'example.com',
      UI_URL: 'https://login.example.com',
    };
    await expect(getUIConfig(env, 'acme')).resolves.toMatchObject({
      baseUrl: 'https://acme.example.com',
    });
    expect(validateTenantUIBaseUrl('https://other.example.com', env, 'acme').valid).toBe(false);
  });

  it('skips a saved value that is not allowed', async () => {
    const env = {
      SETTINGS: kv({
        ...platformUi,
        'settings:tenant:acme:tenant': {
          'tenant.ui_base_url': 'https://evil.example.net',
          'tenant.ui_login_path': '//evil.example.net/login',
          'tenant.ui_error_path': '/oops',
        },
      }),
      ISSUER_URL: 'https://id.example.com',
    };
    const { config, tenantBaseUrl } = await getTenantUIConfig(env, 'acme');
    expect(tenantBaseUrl).toBe(false);
    expect(config).toMatchObject({
      baseUrl: 'https://login.example.com',
      paths: { login: '/signin', error: '/oops' },
    });
  });

  it('keeps the platform UI when the tenant saved a blank base URL', async () => {
    const env = {
      SETTINGS: kv({
        ...platformUi,
        'settings:tenant:acme:tenant': { 'tenant.ui_base_url': '   ' },
      }),
      ISSUER_URL: 'https://id.example.com',
    };
    await expect(getTenantUIConfig(env, 'acme')).resolves.toMatchObject({
      config: { baseUrl: 'https://login.example.com' },
      tenantBaseUrl: false,
    });
    expect(validateTenantUIBaseUrl(' https://id.example.com', env, 'acme').valid).toBe(false);
  });

  it('does not give a tenant a UI with paths alone', async () => {
    const env = {
      SETTINGS: kv({ 'settings:tenant:acme:tenant': { 'tenant.ui_login_path': '/in' } }),
    };
    await expect(getUIConfig(env, 'acme')).resolves.toBeNull();
    // The paths are still known, for callers that pick the host themselves.
    await expect(getTenantUIConfig(env, 'acme')).resolves.toMatchObject({
      config: null,
      paths: { login: '/in' },
    });
  });

  it("uses the platform's UI when the tenant's settings cannot be read", async () => {
    const env = {
      SETTINGS: kv({ ...platformUi, 'settings:tenant:acme:tenant': new Error('kv down') }),
    };
    await expect(getTenantUIConfig(env, 'acme')).resolves.toEqual({
      config: { baseUrl: 'https://login.example.com', paths: expect.any(Object) },
      tenantBaseUrl: false,
      paths: expect.objectContaining({ login: '/signin' }),
    });
  });
});

describe('isValidUIPath', () => {
  it('accepts only paths that stay on the UI host', () => {
    for (const path of ['/login', '/a/b-c_d.e', '/']) expect(isValidUIPath(path), path).toBe(true);
    for (const path of [
      'login',
      '//evil.example',
      '/\\evil.example',
      '/login?x=1',
      '/login#x',
      '/log in',
      '',
      42,
      `/${'a'.repeat(256)}`,
    ]) {
      expect(isValidUIPath(path), String(path)).toBe(false);
    }
  });
});

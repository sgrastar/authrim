import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  getIntrospectionExpectedAudience,
  getIntrospectionValidationConfig,
  getIntrospectionValidationSettings,
} from '../routes/settings/introspection-validation';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ISSUER_URL: 'https://legacy.example.com',
    SETTINGS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true }),
    } as unknown as KVNamespace,
    ...overrides,
  } as Env;
}

describe('introspection-validation settings', () => {
  it('uses the default tenant canonical issuer when expectedAudience is unset', async () => {
    const env = createEnv({
      BASE_DOMAIN: 'oidc.example.com',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      PRIMARY_TENANT_ID: 'default',
    });

    await expect(getIntrospectionExpectedAudience(env)).resolves.toBe('https://oidc.example.com');
  });

  it('preserves explicit expectedAudience from KV', async () => {
    const env = createEnv({
      BASE_DOMAIN: 'oidc.example.com',
      SETTINGS: {
        get: async () =>
          JSON.stringify({
            oidc: { introspectionValidation: { expectedAudience: 'https://api.example.com' } },
          }),
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
      } as unknown as KVNamespace,
    });

    const { settings } = await getIntrospectionValidationSettings(env);
    expect(settings.expectedAudience).toBe('https://api.example.com');
    await expect(getIntrospectionExpectedAudience(env)).resolves.toBe('https://api.example.com');
  });

  it('applies strict validation set for the tenant through the Settings API', async () => {
    const values: Record<string, string> = {
      'settings:tenant:acme:tokens': JSON.stringify({
        'tokens.introspection_strict_validation': true,
      }),
    };
    const env = createEnv({
      SETTINGS: { get: async (key: string) => values[key] ?? null } as unknown as KVNamespace,
    });

    const forTenant = await getIntrospectionValidationSettings(env, 'acme');
    expect(forTenant.settings.strictValidation).toBe(true);
    const forOther = await getIntrospectionValidationSettings(env, 'other');
    expect(forOther.settings.strictValidation).toBe(false);
  });

  it("shows the requested tenant's Settings API value in the older admin API", async () => {
    const values: Record<string, string> = {
      'settings:tenant:acme:tokens': JSON.stringify({
        'tokens.introspection_strict_validation': true,
      }),
    };
    const env = createEnv({
      SETTINGS: { get: async (key: string) => values[key] ?? null } as unknown as KVNamespace,
    });
    let body: any;
    const c = {
      env,
      req: {
        path: '/api/admin/settings/introspection-validation',
        header: (name: string) => (name.toLowerCase() === 'x-tenant-id' ? 'acme' : undefined),
      },
      get: () => undefined,
      json: (value: unknown) => {
        body = value;
        return new Response(JSON.stringify(value));
      },
    } as any;

    await getIntrospectionValidationConfig(c);

    expect(body.settings.strictValidation).toMatchObject({ value: true, source: 'kv' });
  });

  it('answers 503 in the older admin API when the tenant settings cannot be read', async () => {
    const env = createEnv({
      SETTINGS: {
        get: async (key: string) => (key === 'settings:tenant:default:tokens' ? '' : null),
      } as unknown as KVNamespace,
    });
    let status = 0;
    const c = {
      env,
      req: { path: '/api/admin/settings/introspection-validation', header: () => undefined },
      get: () => undefined,
      json: (value: unknown, code = 200) => {
        status = code;
        return new Response(JSON.stringify(value), { status: code });
      },
    } as any;

    await getIntrospectionValidationConfig(c);

    expect(status).toBe(503);
  });

  it('fails closed when the tenant settings cannot be read', async () => {
    const env = createEnv({
      SETTINGS: {
        get: async (key: string) => {
          if (key === 'settings:tenant:broken:tokens') throw new Error('kv unavailable');
          return null;
        },
      } as unknown as KVNamespace,
    });

    await expect(getIntrospectionValidationSettings(env, 'broken')).rejects.toThrow();
  });
});

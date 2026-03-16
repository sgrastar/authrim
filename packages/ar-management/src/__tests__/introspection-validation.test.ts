import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  getIntrospectionExpectedAudience,
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
});

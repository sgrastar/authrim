import { describe, expect, it } from 'vitest';
import { POLICY_FLAGS_OFF, resolvePolicyFlags } from '../policy-flags';

function kv(values: Record<string, string>): KVNamespace {
  return { get: async (key: string) => values[key] ?? null } as unknown as KVNamespace;
}

describe('resolvePolicyFlags', () => {
  it('keeps the defaults with nothing set', async () => {
    await expect(resolvePolicyFlags({ SETTINGS: kv({}) }, 'acme')).resolves.toEqual({
      ...POLICY_FLAGS_OFF,
      customRules: true,
    });
  });

  it("reads the platform's flags, env, and the tenant value over them", async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:feature-flags': JSON.stringify({
          'feature.enable_abac': true,
          'feature.enable_custom_rules': false,
        }),
        'settings:tenant:acme:feature-flags': JSON.stringify({
          'feature.enable_abac': false,
          'feature.enable_sd_jwt': true,
        }),
      }),
      ENABLE_REBAC: '1',
      ENABLE_SD_JWT: '1',
    };

    await expect(resolvePolicyFlags(env, 'acme')).resolves.toMatchObject({
      abac: false,
      rebac: true,
      customRules: false,
      sdJwt: true,
    });
    // SD-JWT from env is on only for exactly 'true', as token issuance has always read it.
    await expect(resolvePolicyFlags(env, 'other')).resolves.toMatchObject({
      abac: true,
      sdJwt: false,
    });
  });

  it('turns every flag off when they cannot be read', async () => {
    const env = {
      SETTINGS: {
        get: async (key: string) => {
          if (key === 'settings:tenant:acme:feature-flags') throw new Error('kv unavailable');
          return null;
        },
      } as unknown as KVNamespace,
      ENABLE_ABAC: 'true',
    };
    await expect(resolvePolicyFlags(env, 'acme')).resolves.toEqual(POLICY_FLAGS_OFF);
  });
});

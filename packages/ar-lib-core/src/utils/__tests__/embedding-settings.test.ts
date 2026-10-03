import { describe, expect, it } from 'vitest';
import { isPolicyEmbeddingEnabled } from '../policy-embedding';
import { getEmbeddingLimits } from '../resource-permissions';

function kv(values: Record<string, string>): KVNamespace {
  return { get: async (key: string) => values[key] ?? null } as unknown as KVNamespace;
}

describe('token embedding settings at runtime', () => {
  it("uses the platform's values with nothing set for the tenant", async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:feature-flags': JSON.stringify({
          'feature.enable_policy_embedding': true,
        }),
        'settings:platform:limits': JSON.stringify({ 'limits.max_embedded_permissions': 70 }),
        // The older stores are no longer read.
        'config:max_resource_permissions': '7',
      }),
      MAX_CUSTOM_CLAIMS: '30',
    };

    await expect(isPolicyEmbeddingEnabled(env, 'acme')).resolves.toBe(true);
    await expect(getEmbeddingLimits(env, 'acme')).resolves.toEqual({
      max_embedded_permissions: 70,
      max_resource_permissions: 100,
      max_custom_claims: 30,
    });
    await expect(
      isPolicyEmbeddingEnabled({ SETTINGS: kv({}), ENABLE_POLICY_EMBEDDING: 'TRUE' }, 'acme')
    ).resolves.toBe(false);
  });

  it("applies the tenant's Settings API values", async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:feature-flags': JSON.stringify({
          'feature.enable_policy_embedding': true,
        }),
        'settings:tenant:acme:feature-flags': JSON.stringify({
          'feature.enable_policy_embedding': false,
        }),
        'settings:tenant:acme:limits': JSON.stringify({ 'limits.max_resource_permissions': 10 }),
      }),
    };

    await expect(isPolicyEmbeddingEnabled(env, 'acme')).resolves.toBe(false);
    await expect(getEmbeddingLimits(env, 'acme')).resolves.toMatchObject({
      max_resource_permissions: 10,
    });
    await expect(isPolicyEmbeddingEnabled(env, 'other')).resolves.toBe(true);
  });

  it('turns embedding off and keeps the default limits when the settings cannot be read', async () => {
    const env = { SETTINGS: kv({ 'settings:tenant:acme:feature-flags': 'not json' }) };
    await expect(isPolicyEmbeddingEnabled(env, 'acme')).resolves.toBe(false);
    const broken = { SETTINGS: kv({ 'settings:tenant:acme:limits': 'not json' }) };
    await expect(getEmbeddingLimits(broken, 'acme')).resolves.toEqual({
      max_embedded_permissions: 50,
      max_resource_permissions: 100,
      max_custom_claims: 20,
    });
  });
});

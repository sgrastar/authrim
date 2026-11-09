import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  DEFAULT_REVOCATION_SHARD_COUNT,
  LEGACY_SHARD_COUNT,
  MAX_REVOCATION_PREVIOUS_GENERATIONS,
  REVOCATION_SHARD_CONFIG_KEY,
  REVOCATION_SHARDS_KEY,
  buildRegionAwareRevocationInstanceName,
  buildRevocationShardInstanceName,
  createNewRevocationGeneration,
  createRegionAwareRevocationJti,
  findRevocationGenerationShardCount,
  generateShardedJti,
  getAllRevocationShardNames,
  getRevocationShardConfig,
  getRevocationShardCount,
  getRevocationShardIndex,
  getRevocationStoreByJti,
  parseRevocationJti,
  resetRevocationShardCountCache,
  saveRevocationShardConfig,
  type RevocationShardConfig,
} from '../token-revocation-sharding';

const CURRENT_CONFIG: RevocationShardConfig = {
  currentGeneration: 3,
  currentShardCount: 8,
  previousGenerations: [
    { generation: 2, shardCount: 4 },
    { generation: 1, shardCount: 2 },
  ],
  updatedAt: 1_000,
};

function kv(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values[key] = JSON.parse(value);
    }),
  };
}

function namespace() {
  const stub = { fetch: vi.fn() };
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const get = vi.fn(() => stub);
  const jurisdiction = vi.fn();
  const binding = { idFromName, get, jurisdiction };
  jurisdiction.mockReturnValue(binding);
  return { binding, stub, idFromName, get, jurisdiction };
}

beforeEach(() => {
  resetRevocationShardCountCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRevocationShardCountCache();
});

describe('revocation JTI formats', () => {
  it('keeps region and shard routing data in a region-aware JTI', () => {
    const jti = createRegionAwareRevocationJti(3, 'weur_j_eu', 7, 'at_random');
    expect(jti).toBe('g3:weur_j_eu:7:at_random');
    expect(parseRevocationJti(jti)).toEqual({
      generation: 3,
      regionKey: 'weur_j_eu',
      shardIndex: 7,
      randomPart: 'at_random',
      isLegacy: false,
      isRegionAware: true,
    });
  });

  it('preserves the embedded shard in an older generation format', () => {
    expect(parseRevocationJti('rv2_3_at_existing')).toEqual({
      generation: 2,
      regionKey: null,
      shardIndex: 3,
      randomPart: 'at_existing',
      isLegacy: false,
      isRegionAware: false,
    });
  });

  it('uses legacy routing for tokens without a complete embedded location', () => {
    for (const jti of ['at_opaque', 'rv2_bad_at_opaque', 'g3:weur:0:']) {
      expect(parseRevocationJti(jti)).toMatchObject({
        generation: 0,
        shardIndex: null,
        regionKey: null,
        randomPart: jti,
        isLegacy: true,
      });
    }
  });
});

describe('revocation shard configuration', () => {
  it('prefers full KV configuration and reloads it after cache expiry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const values = { [REVOCATION_SHARD_CONFIG_KEY]: CURRENT_CONFIG };
    const configKv = kv(values);
    const env = {
      AUTHRIM_CONFIG: configKv,
      AUTHRIM_REVOCATION_SHARDS: '32',
    } as unknown as Env;

    expect(await getRevocationShardConfig(env)).toBe(CURRENT_CONFIG);
    expect(await getRevocationShardCount(env)).toBe(8);
    expect(configKv.get).toHaveBeenCalledTimes(1);
    expect(configKv.get).toHaveBeenCalledWith(REVOCATION_SHARD_CONFIG_KEY, { type: 'json' });

    values[REVOCATION_SHARD_CONFIG_KEY] = { ...CURRENT_CONFIG, currentShardCount: 16 };
    now.mockReturnValue(109_999);
    expect((await getRevocationShardConfig(env)).currentShardCount).toBe(8);
    expect(configKv.get).toHaveBeenCalledTimes(1);

    now.mockReturnValue(110_001);
    expect((await getRevocationShardConfig(env)).currentShardCount).toBe(16);
    expect(configKv.get).toHaveBeenCalledTimes(2);
  });

  it('converts the legacy KV count and retains generation-zero routing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(42_000);
    const configKv = kv({ [REVOCATION_SHARDS_KEY]: '12' });

    expect(await getRevocationShardConfig({ AUTHRIM_CONFIG: configKv } as unknown as Env)).toEqual({
      currentGeneration: 1,
      currentShardCount: 12,
      previousGenerations: [{ generation: 0, shardCount: LEGACY_SHARD_COUNT }],
      updatedAt: 42_000,
    });
    expect(configKv.get.mock.calls.map((call) => call[0])).toEqual([
      REVOCATION_SHARD_CONFIG_KEY,
      REVOCATION_SHARDS_KEY,
    ]);
  });

  it('uses an environment count when legacy KV data is invalid', async () => {
    const configKv = kv({ [REVOCATION_SHARDS_KEY]: 'not-a-count' });
    const config = await getRevocationShardConfig({
      AUTHRIM_CONFIG: configKv,
      AUTHRIM_REVOCATION_SHARDS: '6',
    } as unknown as Env);

    expect(config.currentShardCount).toBe(6);
    expect(config.previousGenerations).toEqual([{ generation: 0, shardCount: LEGACY_SHARD_COUNT }]);
  });

  it('falls back to the default when no valid count is configured', async () => {
    const config = await getRevocationShardConfig({
      AUTHRIM_REVOCATION_SHARDS: '0',
    } as unknown as Env);

    expect(config.currentShardCount).toBe(DEFAULT_REVOCATION_SHARD_COUNT);
    expect(config.previousGenerations).toEqual([]);
  });

  it('saves the entire config, invalidates the cache, and requires a KV binding', async () => {
    const values = { [REVOCATION_SHARD_CONFIG_KEY]: CURRENT_CONFIG };
    const configKv = kv(values);
    const env = { AUTHRIM_CONFIG: configKv } as unknown as Env;
    expect(await getRevocationShardConfig(env)).toBe(CURRENT_CONFIG);
    const next = { ...CURRENT_CONFIG, currentShardCount: 16 };

    await saveRevocationShardConfig(env, next);
    expect(configKv.put).toHaveBeenCalledWith(REVOCATION_SHARD_CONFIG_KEY, JSON.stringify(next));
    expect(await getRevocationShardConfig(env)).toEqual(next);
    expect(configKv.get).toHaveBeenCalledTimes(2);
    await expect(saveRevocationShardConfig({} as Env, next)).rejects.toThrow(
      'AUTHRIM_CONFIG KV binding not available'
    );
  });

  it('routes current, historical, and unknown generations to their respective shard counts', () => {
    expect(findRevocationGenerationShardCount(CURRENT_CONFIG, 3)).toBe(8);
    expect(findRevocationGenerationShardCount(CURRENT_CONFIG, 2)).toBe(4);
    expect(findRevocationGenerationShardCount(CURRENT_CONFIG, 1)).toBe(2);
    expect(findRevocationGenerationShardCount(CURRENT_CONFIG, 99)).toBe(LEGACY_SHARD_COUNT);
  });

  it('retains only the newest five historical generations without mutating the input', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12_345);
    const original = {
      ...CURRENT_CONFIG,
      previousGenerations: Array.from({ length: 6 }, (_, index) => ({
        generation: 2 - index,
        shardCount: 4,
      })),
    };
    const priorHistory = [...original.previousGenerations];

    const next = createNewRevocationGeneration(original, 16, 'operator-1');

    expect(next).toMatchObject({
      currentGeneration: 4,
      currentShardCount: 16,
      updatedAt: 12_345,
      updatedBy: 'operator-1',
    });
    expect(next.previousGenerations).toHaveLength(MAX_REVOCATION_PREVIOUS_GENERATIONS);
    expect(next.previousGenerations[0]).toEqual({
      generation: 3,
      shardCount: 8,
      deprecatedAt: 12_345,
    });
    expect(next.previousGenerations.slice(1)).toEqual(priorHistory.slice(0, 4));
    expect(original.previousGenerations).toEqual(priorHistory);
  });
});

describe('revocation store routing', () => {
  it('routes a region-aware JTI through the selected jurisdiction and location hint', async () => {
    const ns = namespace();
    const env = { TOKEN_REVOCATION_STORE: ns.binding } as unknown as Env;

    const result = await getRevocationStoreByJti(env, 'g3:weur_j_eu:2:at_existing', 'tenant-a');

    expect(result).toEqual({
      stub: ns.stub,
      shardIndex: 2,
      instanceName: 'tenant-a:weur_j_eu:rev:2',
      regionKey: 'weur_j_eu',
      isRegionAware: true,
    });
    expect(ns.jurisdiction).toHaveBeenCalledExactlyOnceWith('eu');
    expect(ns.idFromName).toHaveBeenCalledExactlyOnceWith('tenant-a:weur_j_eu:rev:2');
    expect(ns.get).toHaveBeenCalledExactlyOnceWith('id:tenant-a:weur_j_eu:rev:2', {
      locationHint: 'weur',
    });
  });

  it('uses the embedded shard for a historical generation without contacting another tenant', async () => {
    const ns = namespace();
    const configKv = kv({ [REVOCATION_SHARD_CONFIG_KEY]: CURRENT_CONFIG });
    const env = {
      TOKEN_REVOCATION_STORE: ns.binding,
      AUTHRIM_CONFIG: configKv,
    } as unknown as Env;

    const result = await getRevocationStoreByJti(env, 'rv2_3_at_existing', ' tenant-b ');

    expect(result).toEqual({
      stub: ns.stub,
      shardIndex: 3,
      instanceName: 'tenant:tenant-b:token-revocation:shard-3',
      regionKey: null,
      isRegionAware: false,
    });
    expect(ns.idFromName).toHaveBeenCalledExactlyOnceWith(
      'tenant:tenant-b:token-revocation:shard-3'
    );
    expect(ns.get).toHaveBeenCalledExactlyOnceWith('id:tenant:tenant-b:token-revocation:shard-3');
  });

  it('hashes invalid embedded shards within their original generation limit', async () => {
    const ns = namespace();
    const env = {
      TOKEN_REVOCATION_STORE: ns.binding,
      AUTHRIM_CONFIG: kv({ [REVOCATION_SHARD_CONFIG_KEY]: CURRENT_CONFIG }),
    } as unknown as Env;
    const expectedShard = getRevocationShardIndex('at_existing', 4);

    const result = await getRevocationStoreByJti(env, 'rv2_99_at_existing', 'tenant-a');

    expect(result.shardIndex).toBe(expectedShard);
    expect(result.instanceName).toBe(`tenant:tenant-a:token-revocation:shard-${expectedShard}`);
    expect(ns.idFromName).not.toHaveBeenCalledWith('tenant:tenant-a:token-revocation:shard-99');
  });

  it('keeps opaque legacy JTI routing stable across configuration changes', async () => {
    const ns = namespace();
    const configKv = kv({ [REVOCATION_SHARD_CONFIG_KEY]: CURRENT_CONFIG });
    const env = {
      TOKEN_REVOCATION_STORE: ns.binding,
      AUTHRIM_CONFIG: configKv,
    } as unknown as Env;
    const jti = 'at_opaque';
    const expectedShard = getRevocationShardIndex(jti, LEGACY_SHARD_COUNT);

    const result = await getRevocationStoreByJti(env, jti, 'tenant-a');

    expect(result.shardIndex).toBe(expectedShard);
    expect(result.instanceName).toBe(`tenant:tenant-a:token-revocation:shard-${expectedShard}`);
    expect(configKv.get).not.toHaveBeenCalled();
  });

  it('rejects an absent tenant before resolving a Durable Object', async () => {
    const ns = namespace();
    const env = { TOKEN_REVOCATION_STORE: ns.binding } as unknown as Env;

    await expect(getRevocationStoreByJti(env, 'at_opaque', '  ')).rejects.toThrow(
      'Revocation store routing requires tenantId'
    );
    expect(ns.idFromName).not.toHaveBeenCalled();
    expect(ns.get).not.toHaveBeenCalled();
    expect(() => buildRevocationShardInstanceName('', 0)).toThrow(
      'Revocation shard requires tenantId'
    );
  });

  it('creates only tenant-scoped names for shard inventory', () => {
    expect(getAllRevocationShardNames('tenant-a', 3)).toEqual([
      'tenant:tenant-a:token-revocation:shard-0',
      'tenant:tenant-a:token-revocation:shard-1',
      'tenant:tenant-a:token-revocation:shard-2',
    ]);
    expect(getAllRevocationShardNames('tenant-b', 1)).toEqual([
      'tenant:tenant-b:token-revocation:shard-0',
    ]);
    expect(buildRegionAwareRevocationInstanceName('tenant-a', 'apac', 2)).toBe(
      'tenant-a:apac:rev:2'
    );
  });

  it('generates a JTI that routes to its chosen shard', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const env = {
      AUTHRIM_CONFIG: kv({ [REVOCATION_SHARD_CONFIG_KEY]: CURRENT_CONFIG }),
    } as unknown as Env;

    const generated = await generateShardedJti(env);

    expect(generated).toMatchObject({ generation: 3, shardIndex: 7 });
    expect(generated.jti).toMatch(/^rv3_7_at_[0-9a-f-]{36}$/);
    expect(parseRevocationJti(generated.jti).shardIndex).toBe(7);
  });
});

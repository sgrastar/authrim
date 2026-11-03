import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPolicyConstrainedRegionShardConfig,
  clearRegionShardConfigCache,
} from '@authrim/ar-lib-core';
import type { Env } from '../../types';
import {
  isConfiguredShard,
  resetConfiguredShardRefreshes,
  ShardConfigUnavailableError,
} from '../configured-shard';

const CONFIG = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'policy-us',
    residencyPartition: 'default',
    policyGeneration: 1,
    allowedRegions: ['enam'],
    jurisdiction: null,
  },
  now: 0,
});

function envWith(config: unknown): Env {
  return {
    AUTHRIM_CONFIG: { get: vi.fn(async () => config) },
  } as unknown as Env;
}

describe('isConfiguredShard', () => {
  beforeEach(() => clearRegionShardConfigCache());

  it("accepts a shard of the tenant's configuration", async () => {
    await expect(
      isConfiguredShard(envWith(CONFIG), 'tenant-a', {
        generation: 1,
        regionKey: 'enam',
        shardIndex: CONFIG.currentTotalShards - 1,
      })
    ).resolves.toBe(true);
  });

  it('rejects a forged shard index', async () => {
    await expect(
      isConfiguredShard(envWith(CONFIG), 'tenant-a', {
        generation: 1,
        regionKey: 'enam',
        shardIndex: 999999,
      })
    ).resolves.toBe(false);
  });
});

describe('isConfiguredShard across configuration changes', () => {
  beforeEach(() => {
    clearRegionShardConfigCache();
    resetConfiguredShardRefreshes();
  });

  it('re-reads a cached configuration for an ID of a newer generation', async () => {
    const next = { ...CONFIG, currentGeneration: CONFIG.currentGeneration + 1 };
    const get = vi.fn().mockResolvedValueOnce(CONFIG).mockResolvedValue(next);
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;
    const nextId = { generation: next.currentGeneration, regionKey: 'enam', shardIndex: 0 };

    // The first call caches the old generation.
    await isConfiguredShard(env, 'tenant-a', { ...nextId, generation: CONFIG.currentGeneration });
    await expect(isConfiguredShard(env, 'tenant-a', nextId)).resolves.toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reports an unconfirmable newer generation as unavailable, and re-reads it only so often', async () => {
    const get = vi.fn().mockResolvedValue(CONFIG);
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;
    const ahead = { generation: CONFIG.currentGeneration + 5, regionKey: 'enam', shardIndex: 0 };

    await expect(isConfiguredShard(env, 'tenant-a', ahead)).rejects.toBeInstanceOf(
      ShardConfigUnavailableError
    );
    await expect(isConfiguredShard(env, 'tenant-a', ahead)).rejects.toBeInstanceOf(
      ShardConfigUnavailableError
    );
    // One read to cache, one forced re-read; the second ID within the interval reads nothing.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reports an unreadable configuration as unavailable, not as a forged ID', async () => {
    const env = {
      AUTHRIM_CONFIG: { get: vi.fn().mockRejectedValue(new Error('kv down')) },
    } as unknown as Env;
    await expect(
      isConfiguredShard(env, 'tenant-a', { generation: 1, regionKey: 'enam', shardIndex: 0 })
    ).rejects.toBeInstanceOf(ShardConfigUnavailableError);
  });
});

describe('isConfiguredShard under concurrency', () => {
  beforeEach(() => {
    clearRegionShardConfigCache();
    resetConfiguredShardRefreshes();
  });

  it('shares one re-read among concurrent IDs of a newer generation', async () => {
    const next = { ...CONFIG, currentGeneration: CONFIG.currentGeneration + 1 };
    let releaseRefresh: (value: unknown) => void = () => undefined;
    const get = vi
      .fn()
      .mockResolvedValueOnce(CONFIG)
      .mockImplementationOnce(() => new Promise((resolve) => (releaseRefresh = resolve)))
      .mockResolvedValue(next);
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;
    const nextId = { generation: next.currentGeneration, regionKey: 'enam', shardIndex: 0 };

    await isConfiguredShard(env, 'tenant-a', { ...nextId, generation: CONFIG.currentGeneration });
    const checks = [1, 2, 3, 4].map(() => isConfiguredShard(env, 'tenant-a', nextId));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseRefresh(next);

    await expect(Promise.all(checks)).resolves.toEqual([true, true, true, true]);
    // One read to cache the old generation, one shared re-read.
    expect(get).toHaveBeenCalledTimes(2);
  });
});

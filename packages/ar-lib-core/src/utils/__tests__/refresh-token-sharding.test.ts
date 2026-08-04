import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  buildShardConfigKvKey,
  clearShardConfigCache,
  getRefreshTokenShardConfig,
  saveRefreshTokenShardConfig,
  type RefreshTokenShardConfig,
} from '../refresh-token-sharding';

function config(generation: number, shardCount = 4): RefreshTokenShardConfig {
  return {
    currentGeneration: generation,
    currentShardCount: shardCount,
    previousGenerations: [],
    updatedAt: generation,
  };
}

describe('refresh-token-sharding config', () => {
  beforeEach(() => {
    clearShardConfigCache();
  });

  it('reads client and global configuration concurrently while preserving client priority', async () => {
    const resolvers = new Map<string, (value: RefreshTokenShardConfig | null) => void>();
    const get = vi.fn(
      (key: string) =>
        new Promise<RefreshTokenShardConfig | null>((resolve) => {
          resolvers.set(key, resolve);
        })
    );
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;
    const tenantId = 'tenant-a';
    const load = getRefreshTokenShardConfig(env, 'client-a', tenantId);

    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(2);
    resolvers.get(buildShardConfigKvKey(null, tenantId))?.(config(1));
    resolvers.get(buildShardConfigKvKey('client-a', tenantId))?.(config(2, 8));

    await expect(load).resolves.toMatchObject({ currentGeneration: 2, currentShardCount: 8 });
  });

  it('keeps concurrent cold loads request-local instead of sharing their promises', async () => {
    let release: ((value: RefreshTokenShardConfig | null) => void) | undefined;
    const pending = new Promise<RefreshTokenShardConfig | null>((resolve) => {
      release = resolve;
    });
    const get = vi.fn().mockReturnValue(pending);
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;

    const first = getRefreshTokenShardConfig(env, 'client-a', 'tenant-a');
    const second = getRefreshTokenShardConfig(env, 'client-a', 'tenant-a');
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(4);
    release?.(null);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ currentGeneration: 1 }),
      expect.objectContaining({ currentGeneration: 1 }),
    ]);
  });

  it('fails closed on malformed configured shard state', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        currentGeneration: 1,
        currentShardCount: 0,
        previousGenerations: [],
        updatedAt: 1,
      })
      .mockResolvedValueOnce(null);
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;

    await expect(getRefreshTokenShardConfig(env, 'client-a', 'tenant-a')).rejects.toThrow(
      'refresh_token_shard_config_invalid'
    );
  });

  it('invalidates every client fallback when the tenant global config changes', async () => {
    let globalConfig = config(1);
    const get = vi.fn(async (key: string) =>
      key.endsWith(':__global__') || key === 'refresh-token-shards:__global__' ? globalConfig : null
    );
    const put = vi.fn(async (_key: string, value: string) => {
      globalConfig = JSON.parse(value) as RefreshTokenShardConfig;
    });
    const env = { AUTHRIM_CONFIG: { get, put } } as unknown as Env;

    await getRefreshTokenShardConfig(env, 'client-a', 'tenant-a');
    await getRefreshTokenShardConfig(env, 'client-b', 'tenant-a');
    expect(get).toHaveBeenCalledTimes(4);

    await saveRefreshTokenShardConfig(env, null, config(2), 'tenant-a');
    await expect(getRefreshTokenShardConfig(env, 'client-a', 'tenant-a')).resolves.toMatchObject({
      currentGeneration: 2,
    });
    await expect(getRefreshTokenShardConfig(env, 'client-b', 'tenant-a')).resolves.toMatchObject({
      currentGeneration: 2,
    });
    expect(get).toHaveBeenCalledTimes(8);
  });

  it('does not let an older in-flight read replace cache state after a global save', async () => {
    let resolveOld: ((value: RefreshTokenShardConfig | null) => void) | undefined;
    const oldRead = new Promise<RefreshTokenShardConfig | null>((resolve) => {
      resolveOld = resolve;
    });
    let globalConfig = config(1);
    let useOldRead = true;
    const get = vi.fn(async (key: string) => {
      if (!key.endsWith(':__global__')) return null;
      return useOldRead ? oldRead : globalConfig;
    });
    const put = vi.fn(async (_key: string, value: string) => {
      globalConfig = JSON.parse(value) as RefreshTokenShardConfig;
      useOldRead = false;
    });
    const env = { AUTHRIM_CONFIG: { get, put } } as unknown as Env;

    const staleLoad = getRefreshTokenShardConfig(env, 'client-a', 'tenant-a');
    await Promise.resolve();
    await saveRefreshTokenShardConfig(env, null, config(2), 'tenant-a');
    const currentLoad = getRefreshTokenShardConfig(env, 'client-a', 'tenant-a');
    resolveOld?.(config(1));

    await expect(staleLoad).resolves.toMatchObject({ currentGeneration: 1 });
    await expect(currentLoad).resolves.toMatchObject({ currentGeneration: 2 });
    await expect(getRefreshTokenShardConfig(env, 'client-a', 'tenant-a')).resolves.toMatchObject({
      currentGeneration: 2,
    });
  });
});

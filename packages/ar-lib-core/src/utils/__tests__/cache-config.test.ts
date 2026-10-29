import { describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import {
  buildClientCacheModeKey,
  getCacheMode,
  getCacheTTL,
  getClientCacheMode,
  setClientCacheMode,
  FIXED_MODE_TTL,
  MAINTENANCE_MODE_TTL,
} from '../cache-config';
import { invalidateClientCacheOnDelete } from '../request-cache';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

function setup() {
  const kv = memoryKv();
  return { kv, env: { AUTHRIM_CONFIG: kv } as unknown as Env };
}

const a = { tenantId: 'tenant-a', clientId: 'shared' };
const b = { tenantId: 'tenant-b', clientId: 'shared' };

describe('the cache mode of a client is kept per tenant', () => {
  it('puts the tenant into the key', () => {
    expect(buildClientCacheModeKey(a)).toBe('v1:cache-mode:client:tenant-a:shared');
    expect(buildClientCacheModeKey(b)).not.toBe(buildClientCacheModeKey(a));
  });

  it('keeps two tenants with the same client ID apart on every read path', async () => {
    const { env } = setup();
    await setClientCacheMode(env, a, 'maintenance');

    expect(await getClientCacheMode(env, a)).toBe('maintenance');
    expect(await getClientCacheMode(env, b)).toBeNull();
    expect(await getCacheMode(env, a)).toBe('maintenance');
    expect(await getCacheMode(env, b)).toBe('fixed');
    expect(await getCacheTTL(env, 'policy', a)).toBe(MAINTENANCE_MODE_TTL.policy);
    expect(await getCacheTTL(env, 'policy', b)).toBe(FIXED_MODE_TTL.policy);
  });

  it('clears only the override of the tenant', async () => {
    const { env, kv } = setup();
    await setClientCacheMode(env, a, 'maintenance');
    await setClientCacheMode(env, b, 'maintenance');

    await setClientCacheMode(env, b, null);

    expect(await getClientCacheMode(env, a)).toBe('maintenance');
    expect(await getClientCacheMode(env, b)).toBeNull();
    expect([...kv.store.keys()]).toEqual([buildClientCacheModeKey(a)]);
  });

  it('falls back to the platform mode when the tenant has no override', async () => {
    const { env, kv } = setup();
    kv.store.set('v1:cache-mode:platform', 'maintenance');
    await setClientCacheMode(env, a, 'fixed');

    expect(await getCacheMode(env, a)).toBe('fixed');
    expect(await getCacheMode(env, b)).toBe('maintenance');
  });

  it('does not read the former un-tenanted key', async () => {
    const { env, kv } = setup();
    kv.store.set('v1:cache-mode:client:shared', 'maintenance');

    expect(await getClientCacheMode(env, a)).toBeNull();
    expect(await getClientCacheMode(env, b)).toBeNull();
    expect(await getCacheMode(env, a)).toBe('fixed');
  });

  it('removes only the deleted client of its own tenant', async () => {
    const { env, kv } = setup();
    await setClientCacheMode(env, a, 'maintenance');
    await setClientCacheMode(env, b, 'maintenance');

    await invalidateClientCacheOnDelete(env, a.clientId, a.tenantId);

    expect(await getClientCacheMode(env, a)).toBeNull();
    expect(await getClientCacheMode(env, b)).toBe('maintenance');
    expect([...kv.store.keys()]).toEqual([buildClientCacheModeKey(b)]);
  });
});

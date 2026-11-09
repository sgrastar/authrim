import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { KVPluginConfigStore } from '../core/context';

function memoryKV(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as KVNamespace & { values: Map<string, string> };
}

const schema = z.object({
  sender: z.string().email().default('default@example.test'),
  retryLimit: z.number().int().min(0).default(3),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KVPluginConfigStore', () => {
  it('prefers KV over environment settings and refreshes only after cache expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const kv = memoryKV({
      'plugins:config:mail-plugin': JSON.stringify({ sender: 'kv@example.test' }),
    });
    const store = new KVPluginConfigStore(kv, {
      PLUGIN_MAIL_PLUGIN_CONFIG: JSON.stringify({ sender: 'env@example.test' }),
    });

    await expect(store.get('mail-plugin', schema)).resolves.toEqual({
      sender: 'kv@example.test',
      retryLimit: 3,
    });
    kv.values.set(
      'plugins:config:mail-plugin',
      JSON.stringify({ sender: 'updated@example.test', retryLimit: 5 })
    );
    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
    await expect(store.get('mail-plugin', schema)).resolves.toMatchObject({
      sender: 'kv@example.test',
    });
    expect(kv.get).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    await expect(store.get('mail-plugin', schema)).resolves.toEqual({
      sender: 'updated@example.test',
      retryLimit: 5,
    });
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('falls back from malformed KV JSON to environment config and then schema defaults', async () => {
    const kv = memoryKV({ 'plugins:config:mail-plugin': '{invalid' });
    const fromEnv = new KVPluginConfigStore(kv, {
      PLUGIN_MAIL_PLUGIN_CONFIG: JSON.stringify({ sender: 'env@example.test' }),
    });
    await expect(fromEnv.get('mail-plugin', schema)).resolves.toEqual({
      sender: 'env@example.test',
      retryLimit: 3,
    });

    const fromDefaults = new KVPluginConfigStore(kv, {
      PLUGIN_MAIL_PLUGIN_CONFIG: '{invalid',
    });
    await expect(fromDefaults.get('mail-plugin', schema)).resolves.toEqual({
      sender: 'default@example.test',
      retryLimit: 3,
    });
  });

  it('rejects invalid parsed config and retries after the source is corrected', async () => {
    const kv = memoryKV({
      'plugins:config:mail-plugin': JSON.stringify({ retryLimit: -1 }),
    });
    const store = new KVPluginConfigStore(kv, {});

    await expect(store.get('mail-plugin', schema)).rejects.toThrow();
    kv.values.set(
      'plugins:config:mail-plugin',
      JSON.stringify({ sender: 'fixed@example.test', retryLimit: 1 })
    );
    await expect(store.get('mail-plugin', schema)).resolves.toEqual({
      sender: 'fixed@example.test',
      retryLimit: 1,
    });
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('merges tenant overrides with global config without leaking between tenants', async () => {
    const kv = memoryKV({
      'plugins:config:mail-plugin': JSON.stringify({
        sender: 'global@example.test',
        retryLimit: 4,
      }),
      'plugins:config:mail-plugin:tenant:tenant-a': JSON.stringify({ retryLimit: 1 }),
      'plugins:config:mail-plugin:tenant:tenant-b': JSON.stringify({
        sender: 'tenant-b@example.test',
      }),
    });
    const store = new KVPluginConfigStore(kv, {});

    await expect(store.getForTenant('mail-plugin', 'tenant-a', schema)).resolves.toEqual({
      sender: 'global@example.test',
      retryLimit: 1,
    });
    await expect(store.getForTenant('mail-plugin', 'tenant-b', schema)).resolves.toEqual({
      sender: 'tenant-b@example.test',
      retryLimit: 4,
    });
    await expect(store.getForTenant('mail-plugin', 'tenant-c', schema)).resolves.toEqual({
      sender: 'global@example.test',
      retryLimit: 4,
    });
    expect(kv.get).toHaveBeenCalledWith('plugins:config:mail-plugin:tenant:tenant-c');
  });

  it('does not hide an invalid tenant override by returning global config', async () => {
    const tenantKey = 'plugins:config:mail-plugin:tenant:tenant-a';
    const kv = memoryKV({
      'plugins:config:mail-plugin': JSON.stringify({ sender: 'global@example.test' }),
      [tenantKey]: JSON.stringify({ retryLimit: -2 }),
    });
    const store = new KVPluginConfigStore(kv, {});

    await expect(store.getForTenant('mail-plugin', 'tenant-a', schema)).rejects.toThrow();
    kv.values.set(tenantKey, JSON.stringify({ retryLimit: 2 }));
    await expect(store.getForTenant('mail-plugin', 'tenant-a', schema)).resolves.toEqual({
      sender: 'global@example.test',
      retryLimit: 2,
    });
  });

  it('writes global config to KV and invalidates its cached value', async () => {
    const kv = memoryKV({
      'plugins:config:mail-plugin': JSON.stringify({ sender: 'old@example.test' }),
    });
    const store = new KVPluginConfigStore(kv, {});
    await store.get('mail-plugin', schema);

    await store.set('mail-plugin', { sender: 'new@example.test', retryLimit: 7 });

    expect(kv.put).toHaveBeenCalledWith(
      'plugins:config:mail-plugin',
      JSON.stringify({ sender: 'new@example.test', retryLimit: 7 })
    );
    await expect(store.get('mail-plugin', schema)).resolves.toEqual({
      sender: 'new@example.test',
      retryLimit: 7,
    });
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('requires KV for writes and lets callers explicitly clear the read cache', async () => {
    const withoutKV = new KVPluginConfigStore(null, {});
    await expect(withoutKV.set('mail-plugin', { retryLimit: 1 })).rejects.toThrow(
      'KV namespace not available for config storage'
    );

    const kv = memoryKV({
      'plugins:config:mail-plugin': JSON.stringify({ sender: 'old@example.test' }),
    });
    const store = new KVPluginConfigStore(kv, {});
    await store.get('mail-plugin', schema);
    kv.values.set('plugins:config:mail-plugin', JSON.stringify({ sender: 'new@example.test' }));
    store.clearCache();
    await expect(store.get('mail-plugin', schema)).resolves.toMatchObject({
      sender: 'new@example.test',
    });
    expect(kv.get).toHaveBeenCalledTimes(2);
  });
});

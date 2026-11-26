import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConsoleLogger,
  KVPluginConfigStore,
  NoopAuditLogger,
  createPluginContext,
} from '../core/context';

const schema = z.object({ a: z.string().default('x'), n: z.number().default(1) });

function kv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as KVNamespace & { values: Map<string, string> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createPluginContext', () => {
  it('passes every part through unchanged', () => {
    const parts = {
      storage: {},
      policy: {},
      config: {},
      logger: {},
      audit: {},
      tenantId: 'tenant-a',
      env: { A: 1 },
    };
    const context = createPluginContext(parts as never);
    expect(context).toEqual(parts);
    expect(context.storage).toBe(parts.storage);
    expect(context.policy).toBe(parts.policy);
    expect(context.config).toBe(parts.config);
    expect(context.logger).toBe(parts.logger);
    expect(context.audit).toBe(parts.audit);
    expect(context.env).toBe(parts.env);
  });
});

describe('KVPluginConfigStore details', () => {
  it('builds the environment variable name from the plugin id', async () => {
    const store = new KVPluginConfigStore(null, {
      PLUGIN_NOTIFIER_MAIL_CONFIG: JSON.stringify({ a: 'from-env' }),
    });
    await expect(store.get('notifier-mail', schema)).resolves.toEqual({ a: 'from-env', n: 1 });
  });

  it('ignores an environment value that is not a string, and an empty KV value', async () => {
    const store = new KVPluginConfigStore(kv({ 'plugins:config:p': '' }), {
      PLUGIN_P_CONFIG: { a: 'object' },
    });
    await expect(store.get('p', schema)).resolves.toEqual({ a: 'x', n: 1 });
  });

  it('falls back to the environment when the KV value is the JSON null', async () => {
    const store = new KVPluginConfigStore(kv({ 'plugins:config:p': 'null' }), {
      PLUGIN_P_CONFIG: JSON.stringify({ a: 'env' }),
    });
    await expect(store.get('p', schema)).resolves.toEqual({ a: 'env', n: 1 });
  });

  it('caches a tenant configuration for a minute, and a tenant fallback separately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = kv({
      'plugins:config:p': JSON.stringify({ a: 'global' }),
      'plugins:config:p:tenant:t1': JSON.stringify({ n: 5 }),
    });
    const config = new KVPluginConfigStore(store, {});
    await expect(config.getForTenant('p', 't1', schema)).resolves.toEqual({ a: 'global', n: 5 });
    const reads = store.get.mock.calls.length;
    store.values.set('plugins:config:p:tenant:t1', JSON.stringify({ n: 6 }));
    vi.setSystemTime(59_999);
    await expect(config.getForTenant('p', 't1', schema)).resolves.toEqual({ a: 'global', n: 5 });
    expect(store.get.mock.calls.length).toBe(reads);
    vi.setSystemTime(60_000);
    await expect(config.getForTenant('p', 't1', schema)).resolves.toEqual({ a: 'global', n: 6 });
  });

  it('uses the global configuration for a tenant without KV and without its own value', async () => {
    const config = new KVPluginConfigStore(null, { PLUGIN_P_CONFIG: JSON.stringify({ a: 'env' }) });
    await expect(config.getForTenant('p', 't1', schema)).resolves.toEqual({ a: 'env', n: 1 });
  });

  it('ignores an unreadable tenant value and uses the global configuration', async () => {
    const store = kv({
      'plugins:config:p': JSON.stringify({ a: 'global' }),
      'plugins:config:p:tenant:t1': '{oops',
    });
    await expect(
      new KVPluginConfigStore(store, {}).getForTenant('p', 't1', schema)
    ).resolves.toEqual({
      a: 'global',
      n: 1,
    });
  });

  it('writes under the plugin key and drops only that plugin from the cache', async () => {
    const store = kv({
      'plugins:config:p': JSON.stringify({ a: 'old' }),
      'plugins:config:q': JSON.stringify({ a: 'q-old' }),
    });
    const config = new KVPluginConfigStore(store, {});
    await config.get('p', schema);
    await config.get('q', schema);
    store.values.set('plugins:config:q', JSON.stringify({ a: 'q-new' }));
    await config.set('p', { a: 'new' });
    expect(store.put).toHaveBeenCalledWith('plugins:config:p', '{"a":"new"}');
    await expect(config.get('q', schema)).resolves.toEqual({ a: 'q-old', n: 1 });
    await expect(config.get('p', schema)).resolves.toEqual({ a: 'new', n: 1 });
  });
});

describe('ConsoleLogger', () => {
  it.each([
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const)('writes %s through console.%s with the prefix and the data', (level, method) => {
    const spy = vi.spyOn(console, method).mockImplementation(() => undefined);
    const logger = new ConsoleLogger('[T]');
    logger[level]('message', { k: 1 });
    expect(spy).toHaveBeenCalledWith('[T]', 'message', { k: 1 });
    logger[level]('bare');
    expect(spy).toHaveBeenLastCalledWith('[T]', 'bare', '');
  });

  it('prefixes with [authrim] by default', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    new ConsoleLogger().info('hello');
    expect(spy).toHaveBeenCalledWith('[authrim]', 'hello', '');
  });
});

describe('NoopAuditLogger', () => {
  it('accepts events and does nothing', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
    ];
    await expect(new NoopAuditLogger().log({ action: 'x' } as never)).resolves.toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

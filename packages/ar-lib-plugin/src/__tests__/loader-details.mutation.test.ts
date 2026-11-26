import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PluginLoader } from '../core/loader';
import { CapabilityRegistry } from '../core/registry';
import type { AuthrimPlugin, HealthStatus, PluginContext } from '../core/types';

function context() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, ctx: { logger, tenantId: 't', env: {} } as unknown as PluginContext };
}

function plugin(overrides: Partial<AuthrimPlugin<{ value: string }>> = {}) {
  return {
    id: 'p1',
    version: '1.0.0',
    capabilities: ['notifier.test'],
    official: false,
    configSchema: z.object({ value: z.string().default('d') }),
    meta: { name: 'P', description: 'd', category: 'notification' },
    register: vi.fn(),
    ...overrides,
  } as AuthrimPlugin<{ value: string }>;
}

afterEach(() => vi.useRealTimers());

describe('PluginLoader defaults and messages', () => {
  it('is quiet by default: no debug or info logs while loading', async () => {
    const { logger, ctx } = context();
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(plugin({ initialize: vi.fn() }), {});
    await loader.shutdown();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('joins every validation message into one error', async () => {
    const { ctx } = context();
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    const result = await loader.loadPlugin(
      plugin({
        configSchema: z.object({
          a: z.string('a must be text'),
          b: z.number('b must be a number'),
        }) as never,
      }),
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Configuration validation failed: a must be text; b must be a number'
    );
  });

  it('reports a load failure through the default handler with the error message', async () => {
    const { logger, ctx } = context();
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(
      plugin({
        initialize: async () => {
          throw new Error('init failed');
        },
      }),
      {}
    );
    expect(logger.error).toHaveBeenCalledWith('[plugin-loader] Failed to load plugin: p1', {
      error: 'init failed',
    });
  });
});

describe('PluginLoader health reporting', () => {
  let ctx: PluginContext;
  beforeEach(() => {
    ctx = context().ctx;
  });

  const never = () => new Promise<HealthStatus>(() => undefined);

  it('reports a plugin as loaded and enabled, with its health', async () => {
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(plugin({ healthCheck: async () => ({ status: 'degraded' }) }), {});
    const status = await loader.getStatus('p1');
    expect(status).toMatchObject({
      pluginId: 'p1',
      loaded: true,
      enabled: true,
      health: { status: 'degraded' },
      capabilities: ['notifier.test'],
    });
  });

  it('passes the context and the validated config to the health check', async () => {
    const healthCheck = vi.fn(async () => ({ status: 'healthy' }) as HealthStatus);
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(plugin({ healthCheck }), {});
    await loader.getStatus('p1');
    expect(healthCheck).toHaveBeenCalledWith(ctx, { value: 'd' });
  });

  it('gives up on a health check after the configured timeout', async () => {
    vi.useFakeTimers();
    const loader = new PluginLoader(new CapabilityRegistry(), ctx, { healthCheckTimeoutMs: 100 });
    await loader.loadPlugin(plugin({ healthCheck: never }), {});
    const pending = loader.getStatus('p1');
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending)?.health).toEqual({
      status: 'unhealthy',
      message: 'Health check timeout',
    });
  });

  it('uses a five second timeout by default', async () => {
    vi.useFakeTimers();
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(plugin({ healthCheck: never }), {});
    const pending = loader.healthCheckAll();
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).get('p1')).toEqual({
      status: 'unhealthy',
      message: 'Health check timeout',
    });
  });

  it('describes a health check that throws something that is not an Error', async () => {
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(
      plugin({
        healthCheck: async () => {
          throw 'plain';
        },
      }),
      {}
    );
    expect((await loader.getStatus('p1'))?.health).toEqual({
      status: 'unhealthy',
      message: 'Health check failed',
    });
    expect((await loader.healthCheckAll()).get('p1')).toEqual({
      status: 'unhealthy',
      message: 'Health check failed',
    });
  });

  it('collects the health of every plugin, with the message of an exception', async () => {
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(
      plugin({ id: 'ok', healthCheck: async () => ({ status: 'healthy' }) }),
      {}
    );
    await loader.loadPlugin(
      plugin({
        id: 'boom',
        capabilities: ['notifier.boom'],
        healthCheck: async () => {
          throw new Error('db down');
        },
      }),
      {}
    );
    await loader.loadPlugin(plugin({ id: 'none', capabilities: ['notifier.none'] }), {});
    const results = await loader.healthCheckAll();
    expect([...results.keys()]).toEqual(['ok', 'boom', 'none']);
    expect(results.get('boom')).toEqual({ status: 'unhealthy', message: 'db down' });
    expect(results.get('none')).toEqual({ status: 'healthy', message: 'No health check defined' });
  });

  it('passes the context and the validated config to every health check', async () => {
    const healthCheck = vi.fn(async () => ({ status: 'healthy' }) as HealthStatus);
    const loader = new PluginLoader(new CapabilityRegistry(), ctx);
    await loader.loadPlugin(plugin({ healthCheck }), { value: 'given' });
    await loader.healthCheckAll();
    expect(healthCheck).toHaveBeenCalledWith(ctx, { value: 'given' });
  });
});

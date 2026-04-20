import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../types/env';
import {
  createPluginLoader,
  getTenantEmailSettings,
  invalidatePluginRuntimeCaches,
  pluginContextMiddleware,
  resetPluginRegistryCache,
} from '../plugin-context';

function createMockKV(values: Record<string, string | null> = {}): KVNamespace {
  const storage = new Map<string, string>(
    Object.entries(values).filter(([, value]) => value !== null) as [string, string][]
  );

  return {
    get: vi.fn(async (key: string) => storage.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [] })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

describe('createPluginLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPluginRegistryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls initialize() before register()', async () => {
    const schema = z.object({
      provider: z.string().default('initialized'),
    });
    const initialize = vi.fn(async () => undefined);
    const register = vi.fn((registry, config) => {
      registry.registerNotifier(
        'email',
        {
          send: vi.fn(async () => ({
            success: true,
            messageId: config.provider,
          })),
        },
        'notifier-test'
      );
    });

    const loadPlugins = createPluginLoader([
      {
        plugin: {
          id: 'notifier-test',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          configSchema: schema,
          initialize,
          register,
        },
        envConfigResolver: () => ({ provider: 'initialized' }),
        skipIfConfigEmpty: true,
      },
    ]);

    await loadPlugins({} as Env, 'tenant-a');

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(initialize.mock.invocationCallOrder[0] < register.mock.invocationCallOrder[0]).toBe(
      true
    );
  });

  it('provides a real config store and explicit unsupported infra during initialize()', async () => {
    const schema = z.object({
      provider: z.string().default('default-provider'),
    });
    const initialize = vi.fn(async (ctx: any) => {
      await expect(ctx.config.get('notifier-test', schema)).resolves.toEqual({
        provider: 'global-provider',
      });
      await expect(ctx.config.getForTenant('notifier-test', 'tenant-a', schema)).resolves.toEqual({
        provider: 'tenant-provider',
      });
      expect(() => ctx.storage.user).toThrow(/does not provide storage/);
      expect(() => ctx.policy.check).toThrow(/does not provide policy/);
    });

    const loadPlugins = createPluginLoader([
      {
        plugin: {
          id: 'notifier-test',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          configSchema: schema,
          initialize,
          register() {
            // No-op
          },
        },
        skipIfConfigEmpty: true,
      },
    ]);

    await loadPlugins(
      {
        SETTINGS: createMockKV({
          'plugins:config:notifier-test': JSON.stringify({
            provider: 'global-provider',
          }),
          'plugins:config:notifier-test:tenant:tenant-a': JSON.stringify({
            provider: 'tenant-provider',
          }),
        }),
      } as unknown as Env,
      'tenant-a'
    );

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('keeps tenant-specific plugin config isolated', async () => {
    const loadPlugins = createPluginLoader([
      {
        plugin: {
          id: 'notifier-tenant-aware',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          configSchema: z.object({
            label: z.string(),
          }),
          register(registry, config) {
            registry.registerNotifier(
              'email',
              {
                send: vi.fn(async () => ({
                  success: true,
                  messageId: config.label,
                })),
              },
              'notifier-tenant-aware'
            );
          },
        },
        skipIfConfigEmpty: true,
      },
    ]);

    const env = {
      SETTINGS: createMockKV({
        'plugins:config:notifier-tenant-aware:tenant:tenant-a': JSON.stringify({
          label: 'tenant-a',
        }),
        'plugins:config:notifier-tenant-aware:tenant:tenant-b': JSON.stringify({
          label: 'tenant-b',
        }),
      }),
    } as unknown as Env;

    const [registryA, registryB] = await Promise.all([
      loadPlugins(env, 'tenant-a'),
      loadPlugins(env, 'tenant-b'),
    ]);

    const resultA = await registryA.getNotifier('email')?.send({
      channel: 'email',
      to: 'user@example.com',
      subject: 'Test',
      body: 'A',
    });
    const resultB = await registryB.getNotifier('email')?.send({
      channel: 'email',
      to: 'user@example.com',
      subject: 'Test',
      body: 'B',
    });

    expect(resultA?.messageId).toBe('tenant-a');
    expect(resultB?.messageId).toBe('tenant-b');
  });

  it('applies provider order and failover for email notifiers', async () => {
    const loadPlugins = createPluginLoader([
      {
        plugin: {
          id: 'notifier-primary',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          configSchema: z.object({
            mode: z.enum(['fail', 'success']),
          }),
          register(registry, config) {
            registry.registerNotifier(
              'email',
              {
                send: vi.fn(async () =>
                  config.mode === 'success'
                    ? { success: true, messageId: 'primary-success' }
                    : { success: false, error: 'primary failed', retryable: true }
                ),
              },
              'notifier-primary'
            );
          },
        },
        envConfigResolver: () => ({ mode: 'fail' }),
        skipIfConfigEmpty: true,
      },
      {
        plugin: {
          id: 'notifier-secondary',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          configSchema: z.object({
            mode: z.enum(['fail', 'success']),
          }),
          register(registry, config) {
            registry.registerNotifier(
              'email',
              {
                send: vi.fn(async () =>
                  config.mode === 'success'
                    ? { success: true, messageId: 'secondary-success' }
                    : { success: false, error: 'secondary failed', retryable: true }
                ),
              },
              'notifier-secondary'
            );
          },
        },
        envConfigResolver: () => ({ mode: 'success' }),
        skipIfConfigEmpty: true,
      },
    ]);

    const env = {
      AUTHRIM_CONFIG: createMockKV({
        'settings:tenant:tenant-a:email-settings': JSON.stringify({
          strategy: 'priority_failover',
          providerOrder: ['notifier-primary', 'notifier-secondary'],
        }),
      }),
    } as unknown as Env;

    const registry = await loadPlugins(env, 'tenant-a');
    const result = await registry.getNotifier('email')?.send({
      channel: 'email',
      to: 'user@example.com',
      subject: 'Hello',
      body: 'World',
    });

    expect((await getTenantEmailSettings(env, 'tenant-a')).providerOrder).toEqual([
      'notifier-primary',
      'notifier-secondary',
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        messageId: 'secondary-success',
      })
    );
  });

  it('caches plugin registries per tenant and invalidates them correctly', async () => {
    vi.useFakeTimers();

    const loadPlugins = vi.fn(async (_env: Env, tenantId: string) => ({
      getNotifier: () => undefined,
      getIdP: () => undefined,
      getAuthenticator: () => undefined,
      listCapabilities: () => [`tenant:${tenantId}`],
    }));

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set('tenantId', c.req.header('X-Tenant-Id') ?? 'default');
      await next();
    });
    app.use('*', pluginContextMiddleware({ loadPlugins }));
    app.get('/', (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pluginContext = (c as any).get('pluginContext');
      return c.json({
        capabilities: pluginContext.registry.listCapabilities(),
      });
    });

    const env = {
      SETTINGS_CACHE_TTL: '60',
    } as unknown as Env;

    const request = async (tenantId: string) => {
      const response = await app.request(
        '/',
        {
          headers: {
            'X-Tenant-Id': tenantId,
          },
        },
        env
      );
      return response.json();
    };

    await expect(request('tenant-a')).resolves.toEqual({
      capabilities: ['tenant:tenant-a'],
    });
    await request('tenant-a');
    expect(loadPlugins).toHaveBeenCalledTimes(1);

    await expect(request('tenant-b')).resolves.toEqual({
      capabilities: ['tenant:tenant-b'],
    });
    expect(loadPlugins).toHaveBeenCalledTimes(2);

    invalidatePluginRuntimeCaches(env, { tenantId: 'tenant-a' });
    await request('tenant-a');
    expect(loadPlugins).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60_001);
    await request('tenant-b');
    expect(loadPlugins).toHaveBeenCalledTimes(4);
  });
});

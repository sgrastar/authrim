import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-plugin')>();
  return {
    ...actual,
    needsBuiltinRegistration: vi.fn().mockResolvedValue(false),
    registerBuiltinPlugins: vi.fn().mockResolvedValue({ registered: 0, skipped: 0, errors: [] }),
  };
});

import {
  getTenantEmailSettingsHandler,
  updateTenantEmailSettingsHandler,
} from '../routes/email-settings';

function createMockKV(values: Record<string, string | null> = {}) {
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

function createMockContext(options: {
  body?: Record<string, unknown>;
  settingsKv?: KVNamespace;
  configKv?: KVNamespace;
}) {
  const pluginRunner = {
    configureNotificationInstallation: vi.fn(async (input) => ({
      ...input,
      state: input.enabled ? ('enabled' as const) : ('disabled' as const),
      configVersion: 1,
    })),
    replacePluginCredentials: vi.fn(async (input) => ({
      operationId: input.operationId,
      installationId: input.installationId,
      configVersion: input.expectedConfigVersion + 1,
      credentialCount: input.credentials.length,
    })),
    resolveNotificationProviderOrder: vi.fn(async () => {
      throw new Error('plugin_notification_provider_order_unavailable');
    }),
    replaceNotificationProviderOrder: vi.fn(async (input) => ({
      tenantId: input.tenantId,
      channel: input.channel,
      configVersion: input.expectedConfigVersion + 1,
      state: input.installationIds.length > 0 ? ('enabled' as const) : ('disabled' as const),
      installationIds: input.installationIds,
    })),
  } satisfies Partial<NonNullable<Env['PLUGIN_RUNNER']>>;
  return {
    req: {
      param: vi.fn(() => 'tenant-a'),
      json: vi.fn(async () => options.body ?? {}),
    },
    env: {
      SETTINGS: options.settingsKv,
      AUTHRIM_CONFIG: options.configKv,
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      PLUGIN_RUNNER: pluginRunner,
    } as unknown as Env,
    get: vi.fn((key: string) => {
      if (key === 'adminAuth') {
        return {
          userId: 'admin-1',
          authMethod: 'session',
          roles: ['admin'],
          tenantId: 'tenant-a',
          tenantScope: ['tenant-a'],
        };
      }
      return undefined;
    }),
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
  } as never;
}

describe('tenant email settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enabled providers in saved priority order', async () => {
    const settingsKv = createMockKV({
      'plugins:registry': JSON.stringify({
        'notifier-cloudflare': {
          id: 'notifier-cloudflare',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          meta: {
            name: 'Cloudflare Email Service',
            description: 'Cloudflare',
            category: 'notification',
          },
        },
        'notifier-resend': {
          id: 'notifier-resend',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          meta: {
            name: 'Resend Email',
            description: 'Resend',
            category: 'notification',
          },
        },
      }),
      'plugins:schema:notifier-cloudflare': JSON.stringify({
        type: 'object',
        required: ['defaultFrom'],
      }),
      'plugins:schema:notifier-resend': JSON.stringify({
        type: 'object',
        required: ['apiKey', 'defaultFrom'],
      }),
      'plugins:config:notifier-cloudflare': JSON.stringify({
        defaultFrom: 'cloudflare@example.com',
      }),
      'plugins:config:notifier-resend': JSON.stringify({
        apiKey: 're_live_1234',
        defaultFrom: 'resend@example.com',
      }),
    });
    const configKv = createMockKV({
      'settings:tenant:tenant-a:email-settings': JSON.stringify({
        strategy: 'priority_failover',
        providerOrder: ['notifier-resend', 'notifier-cloudflare'],
      }),
    });
    const c = createMockContext({ settingsKv, configKv });

    const response = (await getTenantEmailSettingsHandler(c)) as Response;
    const body = (await response.json()) as {
      settings: { providerOrder: string[] };
      providers: Array<{ id: string }>;
    };

    expect(body.settings.providerOrder).toEqual(['notifier-resend', 'notifier-cloudflare']);
    expect(body.providers.map((provider: { id: string }) => provider.id)).toEqual([
      'notifier-resend',
      'notifier-cloudflare',
    ]);
  });

  it('persists reordered providers', async () => {
    const settingsKv = createMockKV({
      'plugins:registry': JSON.stringify({
        'notifier-cloudflare': {
          id: 'notifier-cloudflare',
          version: '1.0.0',
          capabilities: ['notifier.email'],
        },
        'notifier-resend': {
          id: 'notifier-resend',
          version: '1.0.0',
          capabilities: ['notifier.email'],
        },
      }),
      'plugins:schema:notifier-cloudflare': JSON.stringify({
        type: 'object',
        required: ['defaultFrom'],
      }),
      'plugins:schema:notifier-resend': JSON.stringify({
        type: 'object',
        required: ['apiKey', 'defaultFrom'],
      }),
      'plugins:config:notifier-cloudflare': JSON.stringify({
        defaultFrom: 'cloudflare@example.com',
      }),
      'plugins:config:notifier-resend': JSON.stringify({
        apiKey: 're_live_1234',
        defaultFrom: 'resend@example.com',
      }),
    });
    const configKv = createMockKV({
      'settings:tenant:tenant-a:email-settings': JSON.stringify({
        strategy: 'priority_failover',
        providerOrder: ['notifier-resend'],
      }),
    });
    const c = createMockContext({
      settingsKv,
      configKv,
      body: {
        strategy: 'priority_failover',
        providerOrder: ['notifier-cloudflare', 'notifier-resend'],
      },
    });

    const response = (await updateTenantEmailSettingsHandler(c)) as Response;
    const body = (await response.json()) as {
      settings: { providerOrder: string[] };
    };

    expect(body.settings.providerOrder).toEqual(['notifier-cloudflare', 'notifier-resend']);
    expect(configKv.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:email-settings',
      JSON.stringify({
        strategy: 'priority_failover',
        providerOrder: ['notifier-cloudflare', 'notifier-resend'],
      })
    );
  });

  it('filters out disabled or unconfigured providers', async () => {
    const settingsKv = createMockKV({
      'plugins:registry': JSON.stringify({
        'notifier-cloudflare': {
          id: 'notifier-cloudflare',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          meta: {
            name: 'Cloudflare Email Service',
            description: 'Cloudflare',
            category: 'notification',
          },
        },
        'notifier-resend': {
          id: 'notifier-resend',
          version: '1.0.0',
          capabilities: ['notifier.email'],
          meta: {
            name: 'Resend Email',
            description: 'Resend',
            category: 'notification',
          },
        },
      }),
      'plugins:schema:notifier-cloudflare': JSON.stringify({
        type: 'object',
        required: ['defaultFrom'],
      }),
      'plugins:schema:notifier-resend': JSON.stringify({
        type: 'object',
        required: ['apiKey', 'defaultFrom'],
      }),
      'plugins:config:notifier-cloudflare': JSON.stringify({
        defaultFrom: 'cloudflare@example.com',
      }),
      'plugins:enabled:notifier-resend:tenant:tenant-a': 'false',
    });
    const configKv = createMockKV({});
    const c = createMockContext({ settingsKv, configKv });

    const response = (await getTenantEmailSettingsHandler(c)) as Response;
    const body = (await response.json()) as {
      providers: Array<{ id: string; defaultFrom?: string; configSource: string }>;
    };

    expect(body.providers).toEqual([
      expect.objectContaining({
        id: 'notifier-cloudflare',
        defaultFrom: 'cloudflare@example.com',
        configSource: 'kv',
      }),
    ]);
  });

  it('keeps an absent provider order empty instead of enabling available providers implicitly', async () => {
    const settingsKv = createMockKV({
      'plugins:registry': JSON.stringify({
        'notifier-cloudflare': {
          id: 'notifier-cloudflare',
          version: '1.0.0',
          capabilities: ['notifier.email'],
        },
      }),
      'plugins:schema:notifier-cloudflare': JSON.stringify({
        type: 'object',
        required: ['defaultFrom'],
      }),
      'plugins:config:notifier-cloudflare': JSON.stringify({
        defaultFrom: 'cloudflare@example.com',
      }),
    });
    const c = createMockContext({ settingsKv, configKv: createMockKV() });

    const response = (await getTenantEmailSettingsHandler(c)) as Response;
    const body = (await response.json()) as { settings: { providerOrder: string[] } };
    expect(body.settings.providerOrder).toEqual([]);
  });

  it('replaces the saved order with an explicit empty order', async () => {
    const settingsKv = createMockKV({
      'plugins:registry': JSON.stringify({
        'notifier-cloudflare': {
          id: 'notifier-cloudflare',
          version: '1.0.0',
          capabilities: ['notifier.email'],
        },
      }),
    });
    const configKv = createMockKV({
      'settings:tenant:tenant-a:email-settings': JSON.stringify({
        strategy: 'priority_failover',
        providerOrder: ['notifier-cloudflare'],
      }),
    });
    const c = createMockContext({
      settingsKv,
      configKv,
      body: { strategy: 'priority_failover', providerOrder: [] },
    });

    const response = (await updateTenantEmailSettingsHandler(c)) as Response;
    const body = (await response.json()) as { settings: { providerOrder: string[] } };
    expect(body.settings.providerOrder).toEqual([]);
    expect(configKv.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:email-settings',
      JSON.stringify({ strategy: 'priority_failover', providerOrder: [] })
    );
  });

  describe('the provider switches in the tenant plugin settings do not decide the providers', () => {
    // plugin.notifier_resend_enabled is retired and plugin.enabled covers external plugin code
    // only: neither hides a built-in provider nor keeps it out of the order.
    const registry = {
      'plugins:registry': JSON.stringify({
        'notifier-cloudflare': {
          id: 'notifier-cloudflare',
          version: '1.0.0',
          capabilities: ['notifier.email'],
        },
        'notifier-resend': {
          id: 'notifier-resend',
          version: '1.0.0',
          capabilities: ['notifier.email'],
        },
      }),
      'plugins:schema:notifier-cloudflare': JSON.stringify({
        type: 'object',
        required: ['defaultFrom'],
      }),
      'plugins:schema:notifier-resend': JSON.stringify({
        type: 'object',
        required: ['apiKey', 'defaultFrom'],
      }),
      'plugins:config:notifier-cloudflare': JSON.stringify({
        defaultFrom: 'cloudflare@example.com',
      }),
      'plugins:config:notifier-resend': JSON.stringify({
        apiKey: 're_live_1234',
        defaultFrom: 'resend@example.com',
      }),
    };
    const stalePluginDocument = JSON.stringify({
      'plugin.notifier_resend_enabled': false,
      'plugin.enabled': false,
    });

    it('still lists Resend when a stale document says the retired switch is off', async () => {
      const settingsKv = createMockKV({
        ...registry,
        'settings:tenant:tenant-a:plugin': stalePluginDocument,
      });
      const configKv = createMockKV({ 'settings:tenant:tenant-a:plugin': stalePluginDocument });
      const c = createMockContext({ settingsKv, configKv });

      const response = (await getTenantEmailSettingsHandler(c)) as Response;
      const body = (await response.json()) as { providers: Array<{ id: string }> };

      expect(body.providers.map((provider) => provider.id).sort()).toEqual([
        'notifier-cloudflare',
        'notifier-resend',
      ]);
    });

    it('accepts Resend in the order for a tenant with no saved plugin settings, as before', async () => {
      const c = createMockContext({
        settingsKv: createMockKV(registry),
        configKv: createMockKV({}),
        body: {
          strategy: 'priority_failover',
          providerOrder: ['notifier-resend', 'notifier-cloudflare'],
        },
      });

      const response = (await updateTenantEmailSettingsHandler(c)) as Response;
      const body = (await response.json()) as { settings: { providerOrder: string[] } };

      expect(response.status).toBe(200);
      expect(body.settings.providerOrder).toEqual(['notifier-resend', 'notifier-cloudflare']);
    });

    it('accepts Resend in the order while a stale document holds the retired switch off', async () => {
      const settingsKv = createMockKV({
        ...registry,
        'settings:tenant:tenant-a:plugin': stalePluginDocument,
      });
      const configKv = createMockKV({ 'settings:tenant:tenant-a:plugin': stalePluginDocument });
      const c = createMockContext({
        settingsKv,
        configKv,
        body: { strategy: 'priority_failover', providerOrder: ['notifier-resend'] },
      });

      const response = (await updateTenantEmailSettingsHandler(c)) as Response;
      const body = (await response.json()) as { settings: { providerOrder: string[] } };

      expect(response.status).toBe(200);
      expect(body.settings.providerOrder).toEqual(['notifier-resend']);
    });

    it('still honours the plugin admin API switch for Resend', async () => {
      const c = createMockContext({
        settingsKv: createMockKV({
          ...registry,
          'plugins:enabled:notifier-resend:tenant:tenant-a': 'false',
        }),
        configKv: createMockKV({}),
        body: { strategy: 'priority_failover', providerOrder: ['notifier-resend'] },
      });

      const response = (await updateTenantEmailSettingsHandler(c)) as Response;

      expect(response.status).toBe(400);
    });
  });
});

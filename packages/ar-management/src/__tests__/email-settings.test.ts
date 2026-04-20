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
  return {
    req: {
      param: vi.fn(() => 'tenant-a'),
      json: vi.fn(async () => options.body ?? {}),
    },
    env: {
      SETTINGS: options.settingsKv,
      AUTHRIM_CONFIG: options.configKv,
    } as unknown as Env,
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
});

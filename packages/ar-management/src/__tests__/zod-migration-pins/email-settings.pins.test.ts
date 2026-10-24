/**
 * zod 3 -> 4 migration pins for routes/email-settings.ts (UpdateTenantEmailSettingsSchema:
 * z.literal(...).default(...), z.array(z.string()).default([])).
 *
 * The REAL `createErrorResponse` is used (the handler passes no variables, so the 400 body is the
 * masked ADMIN_INVALID_REQUEST body).
 */
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

import { updateTenantEmailSettingsHandler } from '../../routes/email-settings';

function createMockKV(values: Record<string, string> = {}) {
  const storage = new Map<string, string>(Object.entries(values));
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
  };
}

function registryKv() {
  return createMockKV({
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
    'plugins:config:notifier-cloudflare': JSON.stringify({ defaultFrom: 'cf@example.com' }),
    'plugins:config:notifier-resend': JSON.stringify({
      apiKey: 're_live_1234',
      defaultFrom: 'rs@example.com',
    }),
  });
}

const configKv = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof createMockKV> | undefined,
}));
type PluginRunner = NonNullable<Env['PLUGIN_RUNNER']>;

function context(
  body: unknown,
  options: { settingsKv?: KVNamespace | null; bodyError?: boolean } = {}
) {
  const pluginRunner = {
    configureNotificationInstallation: vi.fn(
      async (input: Parameters<PluginRunner['configureNotificationInstallation']>[0]) => ({
        ...input,
        state: input.enabled ? ('enabled' as const) : ('disabled' as const),
        configVersion: 1,
      })
    ),
    replacePluginCredentials: vi.fn(
      async (input: Parameters<PluginRunner['replacePluginCredentials']>[0]) => ({
        operationId: input.operationId,
        installationId: input.installationId,
        configVersion: input.expectedConfigVersion + 1,
        credentialCount: input.credentials.length,
      })
    ),
    resolveNotificationProviderOrder: vi.fn(async () => {
      throw new Error('plugin_notification_provider_order_unavailable');
    }),
    replaceNotificationProviderOrder: vi.fn(
      async (input: Parameters<PluginRunner['replaceNotificationProviderOrder']>[0]) => ({
        tenantId: input.tenantId,
        channel: input.channel,
        configVersion: input.expectedConfigVersion + 1,
        state: input.installationIds.length > 0 ? ('enabled' as const) : ('disabled' as const),
        installationIds: input.installationIds,
      })
    ),
  };
  return {
    req: {
      param: vi.fn(() => 'tenant-a'),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn(async () => body),
    },
    env: {
      SETTINGS: options.settingsKv === undefined ? registryKv() : (options.settingsKv ?? undefined),
      AUTHRIM_CONFIG: configKv.current,
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      PLUGIN_RUNNER: pluginRunner,
    } as unknown as Env,
    get: vi.fn((key: string) =>
      key === 'adminAuth'
        ? {
            userId: 'admin-1',
            authMethod: 'session',
            roles: ['admin'],
            tenantId: 'tenant-a',
            tenantScope: ['tenant-a'],
          }
        : undefined
    ),
    json: vi.fn(
      (value: unknown, status: number = 200) => new Response(JSON.stringify(value), { status })
    ),
  } as never;
}

async function update(body: unknown, options: Parameters<typeof context>[1] = {}) {
  const response = await updateTenantEmailSettingsHandler(context(body, options));
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe('zod pins: UpdateTenantEmailSettingsSchema (PUT tenant email settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configKv.current = createMockKV();
  });

  it('rejects non-objects and wrong member types with the same masked body', async () => {
    const first = await update(null);
    expect(first).toEqual({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: expect.any(String) as unknown,
        error_code: 'AR060003',
      },
    });
    expect(await update([])).toEqual(first);
    expect(await update('x')).toEqual(first);
    expect(await update(5)).toEqual(first);
    expect(await update(undefined, { bodyError: true })).toEqual(first);
    expect(await update({ strategy: 'round_robin' })).toEqual(first);
    expect(await update({ strategy: null })).toEqual(first);
    expect(await update({ providerOrder: 'notifier-resend' })).toEqual(first);
    expect(await update({ providerOrder: null })).toEqual(first);
    expect(await update({ providerOrder: [1] })).toEqual(first);
    expect(await update({ providerOrder: [null] })).toEqual(first);
  });

  it('empty object parses to defaults: strategy="priority_failover", providerOrder=[]', async () => {
    const result = await update({});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tenantId: 'tenant-a',
      settings: { strategy: 'priority_failover', providerOrder: [] },
    });
  });

  it('explicit literal strategy and ordered providerOrder are kept; unknown keys are stripped', async () => {
    const result = await update({
      strategy: 'priority_failover',
      providerOrder: ['notifier-resend', 'notifier-cloudflare'],
      stray: true,
    });
    expect(result.status).toBe(200);
    expect(result.body.settings).toEqual({
      strategy: 'priority_failover',
      providerOrder: ['notifier-resend', 'notifier-cloudflare'],
    });
    expect((result.body.providers as Array<{ id: string }>).map((provider) => provider.id)).toEqual(
      ['notifier-resend', 'notifier-cloudflare']
    );
    expect(configKv.current?.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:email-settings',
      JSON.stringify({
        strategy: 'priority_failover',
        providerOrder: ['notifier-resend', 'notifier-cloudflare'],
      })
    );
  });

  it('schema accepts any string ids; unavailable ones are rejected afterwards by the handler', async () => {
    expect(await update({ providerOrder: ['notifier-unknown'] })).toEqual({
      status: 400,
      body: {
        error: 'invalid_provider',
        error_description: 'Unavailable email provider: notifier-unknown',
      },
    });
  });

  it('after validation a missing SETTINGS binding is an internal error', async () => {
    const result = await update({}, { settingsKv: null });
    expect(result.status).toBe(500);
  });
});

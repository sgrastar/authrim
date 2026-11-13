import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../notification-delivery-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notification-delivery-intent')>()),
  createNotificationDeliveryIntent: mocks.create,
}));
vi.mock('../notification-intent-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notification-intent-routing')>()),
  resolveNotificationIntentTarget: mocks.resolve,
}));
vi.mock('../../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger')>();
  const logger = {
    module: () => logger,
    warn: mocks.warn,
    error: mocks.error,
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { ...actual, createLogger: () => logger };
});

import {
  produceNotificationDelivery,
  type NotificationDeliveryProducerEnv,
} from '../notification-delivery-producer';
import { NotificationQuotaExceededError } from '../notification-email-quota';
import { RATE_LIMIT_CATEGORY_META } from '../../types/settings/rate-limit';
import { createSettingsManager } from '../../utils/settings-manager';

const TENANT_KEY = 'rate_limit.email_tenant_hourly_max';
const DEPLOYMENT_KEY = 'rate_limit.email_deployment_hourly_max';

const baseInput = {
  owner: { owner: 'tenant' as const, tenantId: 'tenant-a' },
  intentId: 'intent-a',
  outboxId: 'outbox-a',
  notificationKind: 'admin_invitation',
  idempotencyKey: 'key-a',
  expiresAt: 1_300,
  payload: { channel: 'email' as const, to: 'secret.person@example.com', subject: 's', body: 'b' },
  now: 1_000,
};

/** A fake RateLimiterCounter namespace: counts per (object name, key) and records every call. */
function fakeLimiter(failWith?: Error) {
  const counts = new Map<string, number>();
  const calls: Array<{ object: string; key: string; maxRequests: number }> = [];
  return {
    calls,
    namespace: {
      idFromName: (name: string) => name,
      get: (object: string) => ({
        incrementRpc: async (
          key: string,
          config: { windowSeconds: number; maxRequests: number }
        ) => {
          if (failWith) throw failWith;
          calls.push({ object, key, maxRequests: config.maxRequests });
          expect(config.windowSeconds).toBe(3600);
          const id = `${object}|${key}`;
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          return {
            allowed: count <= config.maxRequests,
            current: count,
            limit: config.maxRequests,
            resetAt: 0,
            retryAfter: count <= config.maxRequests ? 0 : 1800,
          };
        },
      }),
    },
  };
}

function environment(
  extra: Record<string, unknown> = {},
  limiter: ReturnType<typeof fakeLimiter> | null = fakeLimiter()
) {
  const runner = {
    deliverNotification: vi.fn(async () => 'delivered' as const),
    encryptNotificationPayload: vi.fn(async () => ({ activeKeyId: 'k', envelope: '{"v":1}' })),
    resolveNotificationProviderOrder: vi.fn(
      async (): Promise<{
        tenantId: string;
        channel: 'email' | 'sms';
        configVersion: number;
        state: 'enabled';
        installationIds: string[];
      }> => ({
        tenantId: 'tenant-a',
        channel: 'email',
        configVersion: 1,
        state: 'enabled',
        installationIds: ['installation-a'],
      })
    ),
  };
  const env = {
    DB: {},
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    NOTIFICATION_INTENT_HMAC_KEY: 'notification-intent-hmac-key-value',
    // A fresh KV object per environment: the settings reader caches per KV namespace.
    SETTINGS: { get: vi.fn(async () => null) },
    ...(limiter ? { RATE_LIMITER: limiter.namespace } : {}),
    PLUGIN_RUNNER: runner,
    ...extra,
  } as unknown as NotificationDeliveryProducerEnv;
  return { env, runner, limiter };
}

describe('e-mail send quota in the notification producer', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.create.mockResolvedValue({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'outbox-a',
      pluginInstallationId: 'installation-a',
      notificationKind: 'admin_invitation',
      channel: 'email',
      expiresAt: 1_300,
      state: 'pending',
    });
    mocks.resolve.mockResolvedValue({
      tenantId: 'tenant-a',
      db: { prepare: vi.fn(), withSession: vi.fn() },
      bindingRef: 'TDB_TENANT_A_CORE',
    });
  });

  it('sends under the limit and counts the tenant and the deployment', async () => {
    const { env, limiter } = environment();
    await expect(produceNotificationDelivery(env, baseInput)).resolves.toMatchObject({
      delivery: 'delivered',
    });
    expect(limiter!.calls.map((c) => [c.object, c.maxRequests])).toEqual([
      ['tenant:tenant-a:rate-limit:email-quota-hourly', 2000],
      ['rate-limit:email-quota-hourly:deployment', 20000],
    ]);
  });

  it('refuses over the tenant limit, writes no intent and leaves the deployment counter alone', async () => {
    const { env, runner, limiter } = environment({
      SETTINGS: {
        get: vi.fn(async (key: string) =>
          key === 'settings:platform:rate-limit' ? JSON.stringify({ [TENANT_KEY]: 1 }) : null
        ),
      },
    });
    await produceNotificationDelivery(env, baseInput);
    const refused: unknown = await produceNotificationDelivery(env, baseInput).catch(
      (e: unknown) => e
    );
    expect(refused).toBeInstanceOf(NotificationQuotaExceededError);
    expect(refused).toMatchObject({
      scope: 'tenant',
      code: 'notification_quota_exceeded',
      retryAfterSeconds: 1800,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(runner.encryptNotificationPayload).toHaveBeenCalledTimes(1);
    // First mail: tenant + deployment; refused mail: tenant only.
    expect(limiter!.calls.filter((c) => c.object.includes('deployment'))).toHaveLength(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tenantId: 'tenant-a',
        scope: 'tenant',
        notificationKind: 'admin_invitation',
      })
    );
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('secret.person');
  });

  it.each([
    ['tenant owner', baseInput.owner, 'tenant-a'],
    ['platform owner', { owner: 'platform' as const }, 'authrim-platform'],
  ])('refuses over the deployment limit for a %s', async (_name, owner, targetTenant) => {
    mocks.resolve.mockResolvedValue({
      tenantId: targetTenant,
      db: { prepare: vi.fn(), withSession: vi.fn() },
      bindingRef: 'X',
    });
    const { env, runner, limiter } = environment({
      SETTINGS: {
        get: vi.fn(async (key: string) =>
          key === 'settings:platform:rate-limit' ? JSON.stringify({ [DEPLOYMENT_KEY]: 1 }) : null
        ),
      },
    });
    runner.resolveNotificationProviderOrder.mockResolvedValue({
      tenantId: targetTenant,
      channel: 'email',
      configVersion: 1,
      state: 'enabled',
      installationIds: ['installation-a'],
    });
    await produceNotificationDelivery(env, { ...baseInput, owner });
    await expect(produceNotificationDelivery(env, { ...baseInput, owner })).rejects.toMatchObject({
      scope: 'deployment',
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    if (owner.owner === 'platform') {
      expect(limiter!.calls.every((c) => c.object.includes('deployment'))).toBe(true);
    }
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tenantId: owner.owner === 'platform' ? 'platform' : 'tenant-a',
        scope: 'deployment',
      })
    );
  });

  it('does not count sms or push', async () => {
    const { env, runner, limiter } = environment();
    runner.resolveNotificationProviderOrder.mockResolvedValue({
      tenantId: 'tenant-a',
      channel: 'sms',
      configVersion: 1,
      state: 'enabled',
      installationIds: ['installation-a'],
    });
    await produceNotificationDelivery(env, {
      ...baseInput,
      payload: { channel: 'sms', to: '+10000000000', body: 'x' } as never,
    });
    expect(limiter!.calls).toEqual([]);
  });

  it('turns a counter off with 0', async () => {
    const { env, limiter } = environment({
      SETTINGS: {
        get: vi.fn(async (key: string) =>
          key === 'settings:platform:rate-limit'
            ? JSON.stringify({ [TENANT_KEY]: 0, [DEPLOYMENT_KEY]: 0 })
            : null
        ),
      },
    });
    for (let i = 0; i < 3; i++) await produceNotificationDelivery(env, baseInput);
    expect(limiter!.calls).toEqual([]);
  });

  it('fails open and logs one error line without the recipient when the limiter errors', async () => {
    const { env } = environment({}, fakeLimiter(new Error('do_down secret.person@example.com')));
    await expect(produceNotificationDelivery(env, baseInput)).resolves.toMatchObject({
      delivery: 'delivered',
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'email_quota_limiter_unavailable' })
    );
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('secret.person');
  });

  it('fails open when the limiter binding is missing', async () => {
    const { env } = environment({}, null);
    await expect(produceNotificationDelivery(env, baseInput)).resolves.toMatchObject({
      delivery: 'delivered',
    });
    expect(mocks.error).toHaveBeenCalled();
  });

  it('reads the limits from KV, then the environment variable, then the default', async () => {
    const kvOver = environment({
      EMAIL_TENANT_HOURLY_MAX: '50',
      EMAIL_DEPLOYMENT_HOURLY_MAX: '60',
      SETTINGS: {
        get: vi.fn(async (key: string) =>
          key === 'settings:platform:rate-limit' ? JSON.stringify({ [TENANT_KEY]: 7 }) : null
        ),
      },
    });
    await produceNotificationDelivery(kvOver.env, baseInput);
    // KV wins for the tenant key; the environment variable applies where KV is silent.
    expect(kvOver.limiter!.calls.map((c) => c.maxRequests)).toEqual([7, 60]);

    const envOnly = environment({ EMAIL_TENANT_HOURLY_MAX: '50' });
    await produceNotificationDelivery(envOnly.env, baseInput);
    expect(envOnly.limiter!.calls.map((c) => c.maxRequests)).toEqual([50, 20000]);

    const invalid = environment({
      EMAIL_TENANT_HOURLY_MAX: '-5',
      EMAIL_DEPLOYMENT_HOURLY_MAX: 'x',
    });
    await produceNotificationDelivery(invalid.env, baseInput);
    expect(invalid.limiter!.calls.map((c) => c.maxRequests)).toEqual([2000, 20000]);
  });
});

describe('e-mail quota settings are platform-only', () => {
  it.each([TENANT_KEY, DEPLOYMENT_KEY])('refuses a tenant-scoped write of %s', async (key) => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const manager = createSettingsManager({ env: {}, kv, cacheTTL: 0 });
    manager.registerCategory(RATE_LIMIT_CATEGORY_META);
    const scope = { type: 'tenant' as const, id: 'tenant-a' };
    const parents = [{ type: 'platform' as const }];
    const current = await manager.getAll('rate-limit', scope, { parents });
    const result = await manager.patch(
      'rate-limit',
      scope,
      { ifMatch: current.version, set: { [key]: 999999 } },
      'actor',
      { parents }
    );
    expect(result.rejected[key]).toContain('Not settable at tenant scope');
    expect(result.applied).toEqual([]);
  });

  it('ignores a value stored in a tenant document', async () => {
    const kv = {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:tenant-a:rate-limit'
          ? JSON.stringify({ [TENANT_KEY]: 999999 })
          : null
      ),
    } as unknown as KVNamespace;
    const manager = createSettingsManager({ env: {}, kv, cacheTTL: 0 });
    manager.registerCategory(RATE_LIMIT_CATEGORY_META);
    const current = await manager.getAll(
      'rate-limit',
      { type: 'tenant', id: 'tenant-a' },
      { parents: [{ type: 'platform' }] }
    );
    expect(current.values[TENANT_KEY]).toBe(2000);
  });
});

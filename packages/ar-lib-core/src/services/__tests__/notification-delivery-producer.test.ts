import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../notification-delivery-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notification-delivery-intent')>()),
  createNotificationDeliveryIntent: mocks.create,
}));

vi.mock('../notification-intent-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notification-intent-routing')>()),
  resolveNotificationIntentTarget: mocks.resolve,
}));

import { produceNotificationDelivery } from '../notification-delivery-producer';

const input = {
  owner: { owner: 'tenant' as const, tenantId: 'tenant-a' },
  intentId: 'intent-a',
  outboxId: 'outbox-a',
  notificationKind: 'login_otp',
  idempotencyKey: 'login:challenge-a',
  expiresAt: 1_300,
  payload: {
    channel: 'email' as const,
    to: 'user@example.com',
    subject: 'Code',
    body: '123456',
  },
  now: 1_000,
};

function environment(
  deliverNotification = vi.fn(async () => 'delivered' as const),
  resolveNotificationProviderOrder = vi.fn(async () => ({
    tenantId: 'tenant-a',
    channel: 'email' as const,
    configVersion: 3,
    state: 'enabled' as const,
    installationIds: ['installation-a', 'installation-b'],
  }))
) {
  return {
    DB: {},
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS: '{"keys":[]}',
    NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID: 'notification-key-a',
    NOTIFICATION_INTENT_HMAC_KEY: 'notification-intent-hmac-key-value',
    PLUGIN_RUNNER: { deliverNotification, resolveNotificationProviderOrder },
  } as never;
}

describe('notification delivery producer', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'outbox-a',
      pluginInstallationId: 'installation-a',
      notificationKind: 'login_otp',
      channel: 'email',
      expiresAt: 1_300,
      state: 'pending',
    });
    mocks.resolve.mockReset().mockResolvedValue({
      tenantId: 'tenant-a',
      db: { prepare: vi.fn(), withSession: vi.fn() },
      bindingRef: 'TDB_TENANT_A_CORE',
    });
  });

  it('commits the encrypted intent before invoking the reference-only RPC', async () => {
    const order: string[] = [];
    mocks.create.mockImplementation(async () => {
      order.push('commit');
      return {
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        outboxId: 'outbox-a',
        pluginInstallationId: 'installation-a',
        notificationKind: 'login_otp',
        channel: 'email',
        expiresAt: 1_300,
        state: 'pending',
      };
    });
    const deliver = vi.fn(async () => {
      order.push('rpc');
      return 'delivered' as const;
    });

    await expect(produceNotificationDelivery(environment(deliver), input)).resolves.toMatchObject({
      bindingRef: 'TDB_TENANT_A_CORE',
      delivery: 'delivered',
    });
    expect(order).toEqual(['commit', 'rpc']);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOrder: {
          configVersion: 3,
          installationIds: ['installation-a', 'installation-b'],
        },
      })
    );
    expect(deliver).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'outbox-a',
      pluginInstallationId: 'installation-a',
      bindingRef: 'TDB_TENANT_A_CORE',
    });
    expect(JSON.stringify(deliver.mock.calls)).not.toContain('user@example.com');
    expect(JSON.stringify(deliver.mock.calls)).not.toContain('123456');
  });

  it('keeps a committed intent pending after RPC failure or malformed output', async () => {
    await expect(
      produceNotificationDelivery(
        environment(vi.fn(async () => Promise.reject(new Error('response_lost')))),
        input
      )
    ).resolves.toMatchObject({ delivery: 'pending' });
    await expect(
      produceNotificationDelivery(environment(vi.fn(async () => 'unexpected' as never)), input)
    ).resolves.toMatchObject({ delivery: 'pending' });
  });

  it('adopts a terminal reflection without invoking Runner and never dispatches after commit failure', async () => {
    const deliver = vi.fn();
    mocks.create.mockResolvedValueOnce({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'outbox-a',
      pluginInstallationId: 'installation-a',
      notificationKind: 'login_otp',
      channel: 'email',
      expiresAt: 1_300,
      state: 'permanent_failure',
    });
    await expect(produceNotificationDelivery(environment(deliver), input)).resolves.toMatchObject({
      delivery: 'permanent_failure',
    });
    expect(deliver).not.toHaveBeenCalled();

    mocks.create.mockRejectedValueOnce(new Error('commit_failed'));
    await expect(produceNotificationDelivery(environment(deliver), input)).rejects.toThrow(
      'commit_failed'
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it('fails before routing when producer key material is incomplete', async () => {
    await expect(
      produceNotificationDelivery(
        {
          DB: {},
          AUTHRIM_ENVIRONMENT_NAME: 'test',
        } as never,
        input
      )
    ).rejects.toThrow('notification_delivery_producer_configuration_invalid');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('fails closed before intent creation when the materialized order is absent or disabled', async () => {
    await expect(
      produceNotificationDelivery(
        environment(
          vi.fn(),
          vi.fn(async () => ({
            tenantId: 'tenant-a',
            channel: 'email' as const,
            configVersion: 1,
            state: 'disabled' as const,
            installationIds: [],
          }))
        ),
        input
      )
    ).rejects.toThrow('notification_delivery_provider_order_unavailable');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('restricts an operator test to an installation already present in the signed order', async () => {
    await produceNotificationDelivery(environment(), {
      ...input,
      requiredInstallationId: 'installation-b',
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOrder: { configVersion: 3, installationIds: ['installation-b'] },
      })
    );

    mocks.create.mockClear();
    await expect(
      produceNotificationDelivery(environment(), {
        ...input,
        requiredInstallationId: 'installation-cross-tenant',
      })
    ).rejects.toThrow('notification_delivery_provider_order_unavailable');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

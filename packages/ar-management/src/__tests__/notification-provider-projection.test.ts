import { describe, expect, it, vi } from 'vitest';
import type { Env, NotificationProviderOrder } from '@authrim/ar-lib-core';
import {
  deriveTenantNotificationProviderInstallationId,
  materializeDisabledTenantEmailProviderOrder,
  projectTenantNotificationProviderOrder,
  removeTenantNotificationProviderFromOrder,
} from '../notification-provider-projection';

function environment(current: NotificationProviderOrder | null = null) {
  const configureNotificationInstallation = vi.fn(async (input) => ({
    ...input,
    state: input.enabled ? ('enabled' as const) : ('disabled' as const),
    configVersion: 1,
  }));
  const resolveNotificationProviderOrder = vi.fn(async () => {
    if (!current) throw new Error('plugin_notification_provider_order_unavailable');
    return current;
  });
  const replaceNotificationProviderOrder = vi.fn(async (input) => ({
    tenantId: input.tenantId,
    channel: input.channel,
    configVersion: input.expectedConfigVersion + 1,
    state: input.installationIds.length > 0 ? ('enabled' as const) : ('disabled' as const),
    installationIds: input.installationIds,
  }));
  const replacePluginCredentials = vi.fn(async (input) => ({
    operationId: input.operationId,
    installationId: input.installationId,
    configVersion: input.expectedConfigVersion + 1,
    credentialCount: input.credentials.length,
  }));
  return {
    env: {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      PLUGIN_RUNNER: {
        configureNotificationInstallation,
        replacePluginCredentials,
        resolveNotificationProviderOrder,
        replaceNotificationProviderOrder,
      },
    } as unknown as Env,
    configureNotificationInstallation,
    replacePluginCredentials,
    resolveNotificationProviderOrder,
    replaceNotificationProviderOrder,
  };
}

describe('notification provider projection', () => {
  it('derives the same installation identity for every projection owner', async () => {
    const { env } = environment();
    await expect(
      deriveTenantNotificationProviderInstallationId(env, {
        tenantId: 'tenant-a',
        pluginId: 'notifier-resend',
        channel: 'email',
      })
    ).resolves.toMatch(/^notification-installation-v1-[0-9a-f]{64}$/u);
  });

  it('configures built-ins and projects their exact deterministic order', async () => {
    const {
      env,
      configureNotificationInstallation,
      replacePluginCredentials,
      replaceNotificationProviderOrder,
    } = environment();
    const result = await projectTenantNotificationProviderOrder(env, {
      tenantId: 'tenant-a',
      channel: 'email',
      providerIds: ['notifier-resend', 'notifier-cloudflare'],
      providerConfigs: { 'notifier-resend': { apiKey: 're_secret' } },
      operationId: 'operation-a',
    });

    expect(configureNotificationInstallation).toHaveBeenCalledTimes(2);
    expect(configureNotificationInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'notifier-resend', enabled: true })
    );
    expect(configureNotificationInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'notifier-cloudflare', enabled: true })
    );
    expect(replacePluginCredentials).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^notification-credentials-/u),
      tenantId: 'tenant-a',
      installationId: result.installationIds[0],
      expectedConfigVersion: 1,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: 'api.resend.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: 're_secret',
        },
      ],
    });
    expect(replaceNotificationProviderOrder).toHaveBeenCalledWith({
      operationId: 'operation-a',
      tenantId: 'tenant-a',
      channel: 'email',
      expectedConfigVersion: 0,
      installationIds: result.installationIds,
    });
    expect(result.state).toBe('enabled');
  });

  it('fails closed before route projection when Resend credentials are absent', async () => {
    const { env, configureNotificationInstallation, replaceNotificationProviderOrder } =
      environment();
    await expect(
      projectTenantNotificationProviderOrder(env, {
        tenantId: 'tenant-a',
        channel: 'email',
        providerIds: ['notifier-resend'],
      })
    ).rejects.toThrow('notification_provider_projection_config_unavailable');
    expect(configureNotificationInstallation).not.toHaveBeenCalled();
    expect(replaceNotificationProviderOrder).not.toHaveBeenCalled();
  });

  it('does not infer or configure a custom Dynamic Worker script', async () => {
    const { env, configureNotificationInstallation, replaceNotificationProviderOrder } =
      environment();
    await projectTenantNotificationProviderOrder(env, {
      tenantId: 'tenant-a',
      channel: 'email',
      providerIds: ['custom-mailer'],
      operationId: 'operation-a',
    });
    expect(configureNotificationInstallation).not.toHaveBeenCalled();
    expect(replaceNotificationProviderOrder).toHaveBeenCalledWith(
      expect.objectContaining({ installationIds: [expect.stringMatching(/^notification-/u)] })
    );
  });

  it('materializes an explicit disabled route for a new tenant', async () => {
    const { env, replaceNotificationProviderOrder } = environment();
    await expect(
      materializeDisabledTenantEmailProviderOrder(env, 'tenant-a')
    ).resolves.toMatchObject({ state: 'disabled', installationIds: [] });
    expect(replaceNotificationProviderOrder).toHaveBeenCalledWith({
      operationId: 'notification-order-bootstrap-tenant-a',
      tenantId: 'tenant-a',
      channel: 'email',
      expectedConfigVersion: 0,
      installationIds: [],
    });
  });

  it('uses the reflected config version and fails on non-absence resolver errors', async () => {
    const current = {
      tenantId: 'tenant-a',
      channel: 'email' as const,
      configVersion: 7,
      state: 'disabled' as const,
      installationIds: [],
    };
    const { env, replaceNotificationProviderOrder } = environment(current);
    await projectTenantNotificationProviderOrder(env, {
      tenantId: 'tenant-a',
      channel: 'email',
      providerIds: [],
      operationId: 'operation-b',
    });
    expect(replaceNotificationProviderOrder).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConfigVersion: 7 })
    );

    const broken = environment().env;
    vi.mocked(broken.PLUGIN_RUNNER!.resolveNotificationProviderOrder).mockRejectedValueOnce(
      new Error('plugin_notification_provider_order_read_failed')
    );
    await expect(
      projectTenantNotificationProviderOrder(broken, {
        tenantId: 'tenant-a',
        channel: 'email',
        providerIds: [],
      })
    ).rejects.toThrow('plugin_notification_provider_order_read_failed');
  });

  it('removes only the selected installation and preserves fallback order', async () => {
    const initial = environment();
    const installationId = await deriveTenantNotificationProviderInstallationId(initial.env, {
      tenantId: 'tenant-a',
      pluginId: 'notifier-cloudflare',
      channel: 'email',
    });
    const current = {
      tenantId: 'tenant-a',
      channel: 'email' as const,
      configVersion: 4,
      state: 'enabled' as const,
      installationIds: [installationId, 'custom-fallback-installation'],
    };
    const { env, replaceNotificationProviderOrder } = environment(current);

    await removeTenantNotificationProviderFromOrder(env, {
      tenantId: 'tenant-a',
      channel: 'email',
      pluginId: 'notifier-cloudflare',
      operationId: 'remove-provider-a',
    });

    expect(replaceNotificationProviderOrder).toHaveBeenCalledWith({
      operationId: 'remove-provider-a',
      tenantId: 'tenant-a',
      channel: 'email',
      expectedConfigVersion: 4,
      installationIds: ['custom-fallback-installation'],
    });
  });

  it('rejects duplicate or oversized orders before installation mutation', async () => {
    const { env, configureNotificationInstallation } = environment();
    await expect(
      projectTenantNotificationProviderOrder(env, {
        tenantId: 'tenant-a',
        channel: 'email',
        providerIds: ['notifier-cloudflare', 'notifier-cloudflare'],
      })
    ).rejects.toThrow('notification_provider_projection_order_invalid');
    expect(configureNotificationInstallation).not.toHaveBeenCalled();
  });
});

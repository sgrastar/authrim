import {
  deriveNotificationInstallationId,
  type Env,
  type NotificationProviderOrder,
} from '@authrim/ar-lib-core';

const BUILTIN_PROVIDER_IDS = new Set(['notifier-resend', 'notifier-cloudflare']);
const RESEND_API_HOST = 'api.resend.com';

function environmentId(env: Env): string {
  const value = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!value) throw new Error('notification_provider_projection_environment_unavailable');
  return value;
}

function runner(env: Env): NonNullable<Env['PLUGIN_RUNNER']> {
  if (!env.PLUGIN_RUNNER) throw new Error('notification_provider_projection_runner_unavailable');
  return env.PLUGIN_RUNNER;
}

export async function deriveTenantNotificationProviderInstallationId(
  env: Env,
  input: { tenantId: string; pluginId: string; channel: 'email' | 'sms' | 'push' }
): Promise<string> {
  return deriveNotificationInstallationId({
    environmentId: environmentId(env),
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    purpose: `${input.channel}-provider`,
  });
}

export async function projectTenantNotificationProviderCredential(
  env: Env,
  input: {
    tenantId: string;
    channel: 'email' | 'sms' | 'push';
    pluginId: string;
    config?: Readonly<Record<string, unknown>>;
  }
): Promise<string> {
  const installationId = await deriveTenantNotificationProviderInstallationId(env, input);
  if (!BUILTIN_PROVIDER_IDS.has(input.pluginId)) return installationId;
  const service = runner(env);
  const requiresCredential = input.pluginId === 'notifier-resend';
  const apiKey = input.config?.apiKey;
  if (requiresCredential && (typeof apiKey !== 'string' || apiKey.length < 1)) {
    throw new Error('notification_provider_projection_config_unavailable');
  }
  const installation = await service.configureNotificationInstallation({
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    backendKind: 'in_process',
    enabled: true,
  });
  if (requiresCredential) {
    await service.replacePluginCredentials({
      operationId: `notification-credentials-${crypto.randomUUID()}`,
      tenantId: input.tenantId,
      installationId,
      expectedConfigVersion: installation.configVersion,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: RESEND_API_HOST,
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: apiKey as string,
        },
      ],
    });
  }
  return installationId;
}

export async function disableTenantBuiltinNotificationProvider(
  env: Env,
  input: {
    tenantId: string;
    channel: 'email' | 'sms' | 'push';
    pluginId: string;
  }
): Promise<void> {
  if (!BUILTIN_PROVIDER_IDS.has(input.pluginId)) return;
  const installationId = await deriveTenantNotificationProviderInstallationId(env, input);
  await runner(env).configureNotificationInstallation({
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    backendKind: 'in_process',
    enabled: false,
  });
}

async function currentOrder(
  env: Env,
  tenantId: string,
  channel: 'email' | 'sms' | 'push'
): Promise<NotificationProviderOrder | null> {
  try {
    return await runner(env).resolveNotificationProviderOrder({ tenantId, channel });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'plugin_notification_provider_order_unavailable'
    ) {
      return null;
    }
    throw error;
  }
}

export async function projectTenantNotificationProviderOrder(
  env: Env,
  input: {
    tenantId: string;
    channel: 'email' | 'sms' | 'push';
    providerIds: string[];
    providerConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    operationId?: string;
  }
): Promise<NotificationProviderOrder> {
  if (
    input.providerIds.length > 8 ||
    new Set(input.providerIds).size !== input.providerIds.length
  ) {
    throw new Error('notification_provider_projection_order_invalid');
  }
  const service = runner(env);
  const installationIds = await Promise.all(
    input.providerIds.map((pluginId) =>
      projectTenantNotificationProviderCredential(env, {
        tenantId: input.tenantId,
        pluginId,
        channel: input.channel,
        config: input.providerConfigs?.[pluginId],
      })
    )
  );
  const current = await currentOrder(env, input.tenantId, input.channel);
  return service.replaceNotificationProviderOrder({
    operationId: input.operationId ?? `notification-order-${crypto.randomUUID()}`,
    tenantId: input.tenantId,
    channel: input.channel,
    expectedConfigVersion: current?.configVersion ?? 0,
    installationIds,
  });
}

export async function removeTenantNotificationProviderFromOrder(
  env: Env,
  input: {
    tenantId: string;
    channel: 'email' | 'sms' | 'push';
    pluginId: string;
    operationId?: string;
  }
): Promise<NotificationProviderOrder> {
  const service = runner(env);
  const installationId = await deriveTenantNotificationProviderInstallationId(env, input);
  const current = await currentOrder(env, input.tenantId, input.channel);
  return service.replaceNotificationProviderOrder({
    operationId: input.operationId ?? `notification-order-${crypto.randomUUID()}`,
    tenantId: input.tenantId,
    channel: input.channel,
    expectedConfigVersion: current?.configVersion ?? 0,
    installationIds: (current?.installationIds ?? []).filter(
      (candidate) => candidate !== installationId
    ),
  });
}

export function materializeDisabledTenantEmailProviderOrder(
  env: Env,
  tenantId: string
): Promise<NotificationProviderOrder> {
  return projectTenantNotificationProviderOrder(env, {
    tenantId,
    channel: 'email',
    providerIds: [],
    operationId: `notification-order-bootstrap-${tenantId}`,
  });
}

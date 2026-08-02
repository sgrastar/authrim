import type { ImmediateNotificationDeliveryResult, PluginRunnerServiceBinding } from '../types/env';
import {
  createNotificationDeliveryIntent,
  type NotificationDeliveryIntentReference,
  type NotificationDeliveryPayload,
} from './notification-delivery-intent';
import {
  resolveNotificationIntentTarget,
  type NotificationIntentOwner,
  type NotificationIntentRoutingEnv,
} from './notification-intent-routing';

const SAFE_ENVIRONMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export interface NotificationDeliveryProducerEnv extends NotificationIntentRoutingEnv {
  PLUGIN_RUNNER?: Pick<
    PluginRunnerServiceBinding,
    'deliverNotification' | 'resolveNotificationProviderOrder'
  >;
  AUTHRIM_ENVIRONMENT_NAME?: string;
  NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS?: string;
  NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID?: string;
  NOTIFICATION_INTENT_HMAC_KEY?: string;
}

export interface ProduceNotificationDeliveryInput {
  owner: NotificationIntentOwner;
  intentId: string;
  outboxId: string;
  notificationKind: string;
  idempotencyKey: string;
  expiresAt: number;
  payload: NotificationDeliveryPayload;
  requiredInstallationId?: string;
  now?: number;
}

export interface ProduceNotificationDeliveryResult {
  reference: NotificationDeliveryIntentReference;
  bindingRef: string;
  delivery: ImmediateNotificationDeliveryResult;
}

function configuration(env: NotificationDeliveryProducerEnv) {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  const publicJwks = env.NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS;
  const activeKeyId = env.NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID;
  const idempotencyHmacKey = env.NOTIFICATION_INTENT_HMAC_KEY;
  if (
    !environmentId ||
    !SAFE_ENVIRONMENT.test(environmentId) ||
    !publicJwks ||
    !activeKeyId ||
    !idempotencyHmacKey
  ) {
    throw new Error('notification_delivery_producer_configuration_invalid');
  }
  return { environmentId, publicJwks, activeKeyId, idempotencyHmacKey };
}

export async function produceNotificationDelivery(
  env: NotificationDeliveryProducerEnv,
  input: ProduceNotificationDeliveryInput
): Promise<ProduceNotificationDeliveryResult> {
  const config = configuration(env);
  const target = await resolveNotificationIntentTarget(env, input.owner);
  if (!env.PLUGIN_RUNNER) {
    throw new Error('notification_delivery_provider_order_unavailable');
  }
  const providerOrder = await env.PLUGIN_RUNNER.resolveNotificationProviderOrder({
    tenantId: target.tenantId,
    channel: input.payload.channel,
  }).catch(() => null);
  if (
    !providerOrder ||
    providerOrder.tenantId !== target.tenantId ||
    providerOrder.channel !== input.payload.channel ||
    providerOrder.state !== 'enabled' ||
    !Number.isSafeInteger(providerOrder.configVersion) ||
    providerOrder.configVersion < 1 ||
    !Array.isArray(providerOrder.installationIds) ||
    providerOrder.installationIds.length < 1 ||
    providerOrder.installationIds.length > 8
  ) {
    throw new Error('notification_delivery_provider_order_unavailable');
  }
  const installationIds = input.requiredInstallationId
    ? providerOrder.installationIds.includes(input.requiredInstallationId)
      ? [input.requiredInstallationId]
      : null
    : providerOrder.installationIds;
  if (!installationIds) {
    throw new Error('notification_delivery_provider_order_unavailable');
  }
  const reference = await createNotificationDeliveryIntent({
    db: target.db,
    ...config,
    tenantId: target.tenantId,
    intentId: input.intentId,
    outboxId: input.outboxId,
    providerOrder: {
      configVersion: providerOrder.configVersion,
      installationIds,
    },
    notificationKind: input.notificationKind,
    idempotencyKey: input.idempotencyKey,
    expiresAt: input.expiresAt,
    payload: input.payload,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (reference.state !== 'pending') {
    return { reference, bindingRef: target.bindingRef, delivery: reference.state };
  }
  try {
    const delivery = await env.PLUGIN_RUNNER.deliverNotification({
      tenantId: reference.tenantId,
      intentId: reference.intentId,
      outboxId: reference.outboxId,
      pluginInstallationId: reference.pluginInstallationId,
      bindingRef: target.bindingRef,
    });
    return {
      reference,
      bindingRef: target.bindingRef,
      delivery: ['delivered', 'pending', 'permanent_failure'].includes(delivery)
        ? delivery
        : 'pending',
    };
  } catch {
    // The durable outbox remains the recovery path for RPC timeout or response loss.
    return { reference, bindingRef: target.bindingRef, delivery: 'pending' };
  }
}

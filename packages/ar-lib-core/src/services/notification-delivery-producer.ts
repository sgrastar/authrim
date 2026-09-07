import type { ImmediateNotificationDeliveryResult, PluginRunnerServiceBinding } from '../types/env';
import { encryptValue } from '../utils/pii-encryption';
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
    'deliverNotification' | 'encryptNotificationPayload' | 'resolveNotificationProviderOrder'
  >;
  AUTHRIM_ENVIRONMENT_NAME?: string;
  NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS?: string;
  NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID?: string;
  NOTIFICATION_INTENT_HMAC_KEY?: string;
  PII_ENCRYPTION_KEY?: string;
  PII_ENCRYPTION_KEY_VERSION?: string;
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
  accountId?: string;
  now?: number;
}

export interface ProduceNotificationDeliveryResult {
  reference: NotificationDeliveryIntentReference;
  bindingRef: string;
  delivery: ImmediateNotificationDeliveryResult;
}

function configuration(env: NotificationDeliveryProducerEnv) {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  const idempotencyHmacKey = env.NOTIFICATION_INTENT_HMAC_KEY;
  if (!environmentId || !SAFE_ENVIRONMENT.test(environmentId) || !idempotencyHmacKey) {
    throw new Error('notification_delivery_producer_configuration_invalid');
  }
  return { environmentId, idempotencyHmacKey };
}

function maskRecipient(value: string): string {
  const separator = value.lastIndexOf('@');
  if (separator < 1) return '***';
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
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
  const [providerOrder, encryptedPayload] = await Promise.all([
    env.PLUGIN_RUNNER.resolveNotificationProviderOrder({
      tenantId: target.tenantId,
      channel: input.payload.channel,
    }).catch(() => null),
    env.PLUGIN_RUNNER.encryptNotificationPayload({
      context: {
        environmentId: config.environmentId,
        tenantId: target.tenantId,
        intentId: input.intentId,
        notificationKind: input.notificationKind,
        payloadVersion: 1,
      },
      payload: input.payload,
    }).catch(() => null),
  ]);
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
  if (
    !encryptedPayload ||
    typeof encryptedPayload.activeKeyId !== 'string' ||
    typeof encryptedPayload.envelope !== 'string'
  ) {
    throw new Error('notification_delivery_encryption_key_unavailable');
  }
  const installationIds = input.requiredInstallationId
    ? providerOrder.installationIds.includes(input.requiredInstallationId)
      ? [input.requiredInstallationId]
      : null
    : providerOrder.installationIds;
  if (!installationIds) {
    throw new Error('notification_delivery_provider_order_unavailable');
  }
  const recipientMasked = maskRecipient(input.payload.to);
  let recipientEncrypted: string | undefined;
  let recipientEncryptionKeyVersion: number | undefined;
  if (env.PII_ENCRYPTION_KEY) {
    const configuredVersion = Number.parseInt(env.PII_ENCRYPTION_KEY_VERSION ?? '1', 10);
    recipientEncryptionKeyVersion =
      Number.isSafeInteger(configuredVersion) && configuredVersion > 0 ? configuredVersion : 1;
    recipientEncrypted = (
      await encryptValue(
        input.payload.to,
        env.PII_ENCRYPTION_KEY,
        'AES-256-GCM',
        recipientEncryptionKeyVersion
      )
    ).encrypted;
  }
  const reference = await createNotificationDeliveryIntent({
    db: target.db,
    ...config,
    preparedEnvelope: {
      keyId: encryptedPayload.activeKeyId,
      envelope: encryptedPayload.envelope,
    },
    tenantId: target.tenantId,
    intentId: input.intentId,
    outboxId: input.outboxId,
    providerOrder: {
      configVersion: providerOrder.configVersion,
      installationIds,
    },
    notificationKind: input.notificationKind,
    accountId: input.accountId,
    recipientMasked,
    recipientEncrypted,
    recipientEncryptionKeyVersion,
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

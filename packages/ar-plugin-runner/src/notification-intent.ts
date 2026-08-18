import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  decryptNotificationIntentPayload,
  encryptNotificationIntentPayloadWithSecret,
  parseNotificationDeliveryPayload,
  type NotificationDeliveryPayload,
} from '@authrim/ar-lib-core';
import type { PluginNotificationHookReferencePayload, PluginRunnerEnv } from './types';
import { validatePluginEncryptionKeyring } from './encryption-keyring';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_KIND = /^[a-z][a-z0-9._:-]{0,127}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

interface NotificationIntentRow {
  intent_id: string;
  tenant_id: string;
  plugin_installation_id: string;
  provider_installation_ids_json: string;
  active_provider_index: number | string;
  provider_started_at: number | string;
  channel: string;
  notification_kind: string;
  payload_version: number | string;
  payload_key_id: string | null;
  payload_envelope_json: string | null;
  idempotency_key: string;
  state: string;
  expires_at: number | string;
}

export type LoadedNotificationIntent =
  | {
      state: 'pending';
      intentId: string;
      tenantId: string;
      pluginInstallationId: string;
      notificationKind: string;
      idempotencyKey: string;
      payload: NotificationDeliveryPayload;
      expiresAt: number;
    }
  | {
      state: 'delivered';
      intentId: string;
      tenantId: string;
      pluginInstallationId: string;
      notificationKind: string;
      idempotencyKey: string;
      expiresAt: number;
    };

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('notification_intent_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function notificationIntentDecryptionError(error: unknown): string {
  if (!(error instanceof Error)) return 'notification_intent_decryption_failed';
  if (error.message === 'notification_encryption_key_unavailable') {
    return 'notification_intent_key_unavailable';
  }
  if (
    error.message === 'notification_encryption_key_invalid' ||
    error.message === 'notification_envelope_invalid' ||
    error.message === 'notification_envelope_context_invalid'
  ) {
    return 'notification_intent_envelope_invalid';
  }
  if (error.message === 'notification_envelope_key_unwrap_failed') {
    return 'notification_intent_key_unwrap_failed';
  }
  if (error.message === 'notification_envelope_payload_authentication_failed') {
    return 'notification_intent_payload_authentication_failed';
  }
  return 'notification_intent_decryption_failed';
}

function activeProvider(row: NotificationIntentRow): string {
  let providerIds: unknown;
  try {
    providerIds = JSON.parse(row.provider_installation_ids_json);
  } catch {
    throw new Error('notification_intent_row_invalid');
  }
  const activeIndex = integer(row.active_provider_index, 'notification_intent_row_invalid');
  if (
    !Array.isArray(providerIds) ||
    providerIds.length < 1 ||
    providerIds.length > 8 ||
    providerIds.some((providerId) => typeof providerId !== 'string' || !SAFE_ID.test(providerId)) ||
    new Set(providerIds).size !== providerIds.length ||
    providerIds[0] !== row.plugin_installation_id ||
    activeIndex < 0 ||
    activeIndex >= providerIds.length ||
    integer(row.provider_started_at, 'notification_intent_row_invalid') < 1
  ) {
    throw new Error('notification_intent_row_invalid');
  }
  return providerIds[activeIndex] as string;
}

function parsePrivateJwk(value: string, slot: 'A' | 'B'): Record<string, unknown> {
  if (value.length < 1 || value.length > 16_384) {
    throw new Error(`notification_decryption_slot_${slot.toLowerCase()}_invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`notification_decryption_slot_${slot.toLowerCase()}_invalid`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`notification_decryption_slot_${slot.toLowerCase()}_invalid`);
  }
  const key = parsed as Record<string, unknown>;
  const operations: unknown[] = Array.isArray(key.key_ops) ? key.key_ops : [];
  if (
    key.kty !== 'RSA' ||
    key.use !== 'enc' ||
    key.alg !== 'RSA-OAEP-256' ||
    !SAFE_KEY_ID.test(typeof key.kid === 'string' ? key.kid : '') ||
    operations.length !== 1 ||
    operations[0] !== 'decrypt' ||
    ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].some(
      (field) => typeof key[field] !== 'string' || !BASE64URL.test(key[field])
    )
  ) {
    throw new Error(`notification_decryption_slot_${slot.toLowerCase()}_invalid`);
  }
  return key;
}

export function notificationPrivateJwksFromEnv(
  env: Pick<
    PluginRunnerEnv,
    'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A' | 'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B'
  >
): string {
  const keys = [parsePrivateJwk(env.NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A, 'A')];
  if (env.NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B?.trim()) {
    keys.push(parsePrivateJwk(env.NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B, 'B'));
  }
  const keyIds = new Set(keys.map((key) => key.kid));
  if (keyIds.has(undefined) || keyIds.size !== keys.length) {
    throw new Error('notification_decryption_key_set_invalid');
  }
  return JSON.stringify({ keys });
}

export function notificationPayloadEncryptionKeyFromEnv(
  env: Pick<PluginRunnerEnv, 'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A'>
): { activeKeyId: string; publicJwks: string } {
  const privateKey = parsePrivateJwk(env.NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A, 'A');
  const activeKeyId = privateKey.kid as string;
  const publicKey = {
    kty: privateKey.kty,
    n: privateKey.n,
    e: privateKey.e,
    kid: activeKeyId,
    use: privateKey.use,
    alg: privateKey.alg,
    key_ops: ['encrypt'],
  };
  return {
    activeKeyId,
    publicJwks: JSON.stringify({ keys: [publicKey] }),
  };
}

type NotificationPayloadSymmetricKeyEnv = Pick<
  PluginRunnerEnv,
  | 'PLUGIN_ENCRYPTION_KEY'
  | 'PLUGIN_ENCRYPTION_ACTIVE_KEY_ID'
  | 'PLUGIN_ENCRYPTION_KEY_PREVIOUS'
  | 'PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID'
>;

export function notificationPayloadSymmetricKeysFromEnv(env: NotificationPayloadSymmetricKeyEnv): {
  active: { keyId: string; secret: string };
  all: Array<{ keyId: string; secret: string }>;
} {
  const previousId = env.PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID;
  const previousSecret = env.PLUGIN_ENCRYPTION_KEY_PREVIOUS;
  if ((previousId === undefined) !== (previousSecret === undefined)) {
    throw new Error('plugin_notification_symmetric_keyring_invalid');
  }
  const keyring = validatePluginEncryptionKeyring({
    active: {
      id: env.PLUGIN_ENCRYPTION_ACTIVE_KEY_ID ?? 'v1',
      secret: env.PLUGIN_ENCRYPTION_KEY,
    },
    ...(previousId && previousSecret
      ? { previous: { id: previousId, secret: previousSecret } }
      : {}),
  });
  const active = {
    keyId: `notification:${keyring.active.id}`,
    secret: keyring.active.secret,
  };
  return {
    active,
    all: [
      active,
      ...(keyring.previous
        ? [
            {
              keyId: `notification:${keyring.previous.id}`,
              secret: keyring.previous.secret,
            },
          ]
        : []),
    ],
  };
}

export async function encryptNotificationPayloadFromEnv(
  env: Pick<
    PluginRunnerEnv,
    | 'AUTHRIM_ENVIRONMENT_NAME'
    | 'PLUGIN_ENCRYPTION_KEY'
    | 'PLUGIN_ENCRYPTION_ACTIVE_KEY_ID'
    | 'PLUGIN_ENCRYPTION_KEY_PREVIOUS'
    | 'PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID'
  >,
  input: unknown
): Promise<{ activeKeyId: string; envelope: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_notification_encryption_input_invalid');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'context,payload') {
    throw new Error('plugin_notification_encryption_input_invalid');
  }
  const context = record.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('plugin_notification_encryption_input_invalid');
  }
  const rawContext = context as Record<string, unknown>;
  if (
    Object.keys(rawContext).sort().join(',') !==
      'environmentId,intentId,notificationKind,payloadVersion,tenantId' ||
    rawContext.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME ||
    typeof rawContext.tenantId !== 'string' ||
    typeof rawContext.intentId !== 'string' ||
    typeof rawContext.notificationKind !== 'string' ||
    rawContext.payloadVersion !== 1
  ) {
    throw new Error('plugin_notification_encryption_input_invalid');
  }
  const payload = parseNotificationDeliveryPayload(record.payload);
  const envelopeContext = {
    environmentId: rawContext.environmentId,
    tenantId: rawContext.tenantId,
    intentId: rawContext.intentId,
    notificationKind: rawContext.notificationKind,
    payloadVersion: 1 as const,
  };
  let keyring: ReturnType<typeof notificationPayloadSymmetricKeysFromEnv>;
  try {
    keyring = notificationPayloadSymmetricKeysFromEnv(env);
  } catch {
    throw new Error('plugin_notification_key_configuration_invalid');
  }
  let envelope: string;
  try {
    envelope = await encryptNotificationIntentPayloadWithSecret({
      secret: keyring.active.secret,
      keyId: keyring.active.keyId,
      context: envelopeContext,
      payload,
    });
  } catch {
    throw new Error('plugin_notification_payload_encryption_failed');
  }
  let reflected: unknown;
  try {
    // Validate the active live key before returning an envelope to another Worker.
    // This keeps a bad key from creating a durable dead-letter intent.
    reflected = await decryptNotificationIntentPayload({
      symmetricKeys: keyring.all,
      context: envelopeContext,
      envelope,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'notification_envelope_private_key_import_failed') {
        throw new Error('plugin_notification_private_key_import_failed');
      }
      if (error.message === 'notification_envelope_payload_authentication_failed') {
        throw new Error('plugin_notification_payload_authentication_failed');
      }
    }
    throw new Error('plugin_notification_encryption_round_trip_failed');
  }
  try {
    parseNotificationDeliveryPayload(reflected, payload.channel);
    return { activeKeyId: keyring.active.keyId, envelope };
  } catch {
    throw new Error('plugin_notification_payload_round_trip_invalid');
  }
}

export async function cleanupExpiredNotificationDeliveryIntents(
  db: D1Database,
  input: { now: number; limit?: number }
): Promise<{ deleted: number }> {
  const limit = input.limit ?? 100;
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1_000
  ) {
    throw new Error('notification_intent_cleanup_input_invalid');
  }
  const result = await primary(db)
    .prepare(
      `DELETE FROM notification_delivery_intents
        WHERE intent_id IN (
          SELECT intent_id
            FROM notification_delivery_intents
           WHERE delete_after <= ?
           ORDER BY delete_after ASC, intent_id ASC
           LIMIT ?
        )
          AND delete_after <= ?`
    )
    .bind(input.now, limit, input.now)
    .run();
  const deleted = result.meta.changes;
  if (
    result.success !== true ||
    result.error !== undefined ||
    !Number.isSafeInteger(deleted) ||
    deleted < 0 ||
    deleted > limit
  ) {
    throw new Error('notification_intent_cleanup_failed');
  }
  return { deleted };
}

export class D1NotificationIntentDeliveryStore {
  constructor(
    private readonly db: D1Database,
    private readonly environmentId: string,
    private readonly privateJwks: string,
    private readonly symmetricKeys: Array<{ keyId: string; secret: string }> = []
  ) {
    if (!SAFE_ID.test(environmentId)) throw new Error('notification_intent_environment_invalid');
  }

  async load(input: {
    tenantId: string;
    pluginInstallationId: string;
    reference: PluginNotificationHookReferencePayload;
    now: number;
  }): Promise<LoadedNotificationIntent> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !SAFE_ID.test(input.reference.intentId) ||
      input.reference.tenantId !== input.tenantId ||
      input.reference.eventType !== 'notification.delivery.requested' ||
      input.reference.eventVersion !== 1 ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1
    ) {
      throw new Error('notification_intent_delivery_input_invalid');
    }
    const session = primary(this.db);
    const row = await session
      .prepare(
        `SELECT intent_id, tenant_id, plugin_installation_id,
                provider_installation_ids_json, active_provider_index, provider_started_at,
                channel, notification_kind,
                payload_version, payload_key_id, payload_envelope_json, idempotency_key,
                state, expires_at
           FROM notification_delivery_intents
          WHERE intent_id = ? AND tenant_id = ?`
      )
      .bind(input.reference.intentId, input.tenantId)
      .first<NotificationIntentRow>();
    if (!row) throw new Error('notification_intent_unavailable');
    const expiresAt = integer(row.expires_at, 'notification_intent_row_invalid');
    const activePluginInstallationId = activeProvider(row);
    if (
      row.intent_id !== input.reference.intentId ||
      row.tenant_id !== input.tenantId ||
      activePluginInstallationId !== input.pluginInstallationId ||
      !SAFE_KIND.test(row.notification_kind) ||
      !SAFE_IDEMPOTENCY_KEY.test(row.idempotency_key) ||
      integer(row.payload_version, 'notification_intent_row_invalid') !== 1
    ) {
      throw new Error('notification_intent_row_invalid');
    }
    if (row.state === 'delivered') {
      return {
        state: 'delivered',
        intentId: row.intent_id,
        tenantId: row.tenant_id,
        pluginInstallationId: activePluginInstallationId,
        notificationKind: row.notification_kind,
        idempotencyKey: row.idempotency_key,
        expiresAt,
      };
    }
    if (row.state !== 'pending') throw new Error('notification_intent_terminal');
    if (expiresAt <= input.now) {
      await this.wipePending(session, row, 'expired', input.now);
      throw new Error('notification_intent_expired');
    }
    if (!row.payload_key_id || !row.payload_envelope_json) {
      throw new Error('notification_intent_row_invalid');
    }
    let decrypted: unknown;
    try {
      decrypted = await decryptNotificationIntentPayload({
        privateJwks: this.privateJwks,
        symmetricKeys: this.symmetricKeys,
        context: {
          environmentId: this.environmentId,
          tenantId: row.tenant_id,
          intentId: row.intent_id,
          notificationKind: row.notification_kind,
          payloadVersion: 1,
        },
        envelope: row.payload_envelope_json,
      });
    } catch (error) {
      await this.wipePending(session, row, 'dead_letter', input.now);
      throw new Error(notificationIntentDecryptionError(error));
    }
    let payload: NotificationDeliveryPayload;
    try {
      payload = parseNotificationDeliveryPayload(decrypted, row.channel);
    } catch {
      await this.wipePending(session, row, 'dead_letter', input.now);
      throw new Error('notification_intent_payload_invalid');
    }
    return {
      state: 'pending',
      intentId: row.intent_id,
      tenantId: row.tenant_id,
      pluginInstallationId: activePluginInstallationId,
      notificationKind: row.notification_kind,
      idempotencyKey: row.idempotency_key,
      payload,
      expiresAt,
    };
  }

  async complete(input: {
    tenantId: string;
    intentId: string;
    pluginInstallationId: string;
    providerMessageId?: string;
    now: number;
  }): Promise<void> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.intentId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      (input.providerMessageId !== undefined && input.providerMessageId.length > 512) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1
    ) {
      throw new Error('notification_intent_completion_input_invalid');
    }
    const result = await primary(this.db)
      .prepare(
        `UPDATE notification_delivery_intents
            SET state = 'delivered', payload_key_id = NULL, payload_envelope_json = NULL,
                delivered_at = ?, provider_accepted_at = ?, provider_message_id = ?,
                delivery_status = 'provider_accepted', delivery_status_updated_at = ?,
                attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?
          WHERE intent_id = ? AND tenant_id = ?
            AND json_extract(
              provider_installation_ids_json,
              '$[' || active_provider_index || ']'
            ) = ?
            AND state = 'pending'`
      )
      .bind(
        input.now,
        input.now,
        input.providerMessageId ?? null,
        input.now,
        input.now,
        input.intentId,
        input.tenantId,
        input.pluginInstallationId
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) return;
    const reflected = await primary(this.db)
      .prepare(
        `SELECT state FROM notification_delivery_intents
          WHERE intent_id = ? AND tenant_id = ?
            AND json_extract(
              provider_installation_ids_json,
              '$[' || active_provider_index || ']'
            ) = ?`
      )
      .bind(input.intentId, input.tenantId, input.pluginInstallationId)
      .first<{ state: string }>();
    if (reflected?.state !== 'delivered') throw new Error('notification_intent_completion_stale');
  }

  async failPermanent(input: {
    tenantId: string;
    intentId: string;
    pluginInstallationId: string;
    now: number;
  }): Promise<void> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.intentId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1
    ) {
      throw new Error('notification_intent_failure_input_invalid');
    }
    const result = await primary(this.db)
      .prepare(
        `UPDATE notification_delivery_intents
            SET state = 'dead_letter', payload_key_id = NULL, payload_envelope_json = NULL,
                dead_lettered_at = ?, updated_at = ?
          WHERE intent_id = ? AND tenant_id = ?
            AND json_extract(
              provider_installation_ids_json,
              '$[' || active_provider_index || ']'
            ) = ?
            AND state = 'pending'`
      )
      .bind(input.now, input.now, input.intentId, input.tenantId, input.pluginInstallationId)
      .run();
    if ((result.meta.changes ?? 0) === 1) return;
    const reflected = await primary(this.db)
      .prepare(
        `SELECT state FROM notification_delivery_intents
          WHERE intent_id = ? AND tenant_id = ?
            AND json_extract(
              provider_installation_ids_json,
              '$[' || active_provider_index || ']'
            ) = ?`
      )
      .bind(input.intentId, input.tenantId, input.pluginInstallationId)
      .first<{ state: string }>();
    if (reflected?.state !== 'dead_letter') throw new Error('notification_intent_failure_stale');
  }

  private async wipePending(
    session: D1DatabaseSession,
    row: NotificationIntentRow,
    state: 'expired' | 'dead_letter',
    now: number
  ): Promise<void> {
    const result = await session
      .prepare(
        `UPDATE notification_delivery_intents
            SET state = ?, payload_key_id = NULL, payload_envelope_json = NULL,
                canceled_at = CASE WHEN ? = 'expired' THEN ? ELSE NULL END,
                dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE NULL END,
                updated_at = ?
          WHERE intent_id = ? AND tenant_id = ? AND plugin_installation_id = ?
            AND state = 'pending'`
      )
      .bind(
        state,
        state,
        now,
        state,
        now,
        now,
        row.intent_id,
        row.tenant_id,
        row.plugin_installation_id
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('notification_intent_wipe_stale');
  }
}

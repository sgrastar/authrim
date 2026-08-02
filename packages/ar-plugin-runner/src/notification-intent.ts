import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  decryptNotificationIntentPayload,
  parseNotificationDeliveryPayload,
  type NotificationDeliveryPayload,
} from '@authrim/ar-lib-core';
import type { PluginNotificationHookReferencePayload, PluginRunnerEnv } from './types';

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
    private readonly privateJwks: string
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
        context: {
          environmentId: this.environmentId,
          tenantId: row.tenant_id,
          intentId: row.intent_id,
          notificationKind: row.notification_kind,
          payloadVersion: 1,
        },
        envelope: row.payload_envelope_json,
      });
      return {
        state: 'pending',
        intentId: row.intent_id,
        tenantId: row.tenant_id,
        pluginInstallationId: activePluginInstallationId,
        notificationKind: row.notification_kind,
        idempotencyKey: row.idempotency_key,
        payload: parseNotificationDeliveryPayload(decrypted, row.channel),
        expiresAt,
      };
    } catch {
      await this.wipePending(session, row, 'dead_letter', input.now);
      throw new Error('notification_intent_authentication_failed');
    }
  }

  async complete(input: {
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
      throw new Error('notification_intent_completion_input_invalid');
    }
    const result = await primary(this.db)
      .prepare(
        `UPDATE notification_delivery_intents
            SET state = 'delivered', payload_key_id = NULL, payload_envelope_json = NULL,
                delivered_at = ?, updated_at = ?
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

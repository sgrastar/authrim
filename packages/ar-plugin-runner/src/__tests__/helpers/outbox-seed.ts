import type { DatabaseSync } from 'node:sqlite';

export interface OutboxSeed {
  id?: string;
  tenant?: string;
  installation?: string;
  capability?: string;
  eventType?: string;
  eventVersion?: number;
  key?: string;
  payload?: unknown;
  createdAt?: number;
}

export const accountPayload = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a',
  accountId: 'account-a',
  eventType: 'account.created',
  eventVersion: 1,
  ...over,
});

export interface IntentPayload {
  tenantId: string;
  intentId: string;
  eventType: 'notification.delivery.requested';
  eventVersion: 1;
}

export const intentPayload = (over: Partial<Record<string, unknown>> = {}): IntentPayload => ({
  tenantId: 'tenant-a',
  intentId: 'intent-a',
  eventType: 'notification.delivery.requested',
  eventVersion: 1,
  ...over,
});

/** Inserts a queued account-event outbox row unless the seed says otherwise. */
export function insertOutbox(database: DatabaseSync, seed: OutboxSeed = {}): string {
  const id = seed.id ?? 'outbox-a';
  database
    .prepare(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, payload_class,
         status, attempt_no, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reference_v1', 'queued', 0, ?, ?)`
    )
    .run(
      id,
      seed.tenant ?? 'tenant-a',
      seed.installation ?? 'installation-a',
      seed.capability ?? 'hook.account.lifecycle',
      seed.eventType ?? 'account.created',
      seed.eventVersion ?? 1,
      seed.key ?? `event/${id}`,
      typeof seed.payload === 'string'
        ? seed.payload
        : JSON.stringify(seed.payload ?? accountPayload()),
      seed.createdAt ?? 100,
      seed.createdAt ?? 100
    );
  return id;
}

export function insertNotificationOutbox(
  database: DatabaseSync,
  seed: OutboxSeed & { intentId?: string } = {}
): string {
  return insertOutbox(database, {
    id: 'notification-a',
    capability: 'notifier.send',
    eventType: 'notification.delivery.requested',
    key: 'notification/a',
    payload: intentPayload(seed.intentId ? { intentId: seed.intentId } : {}),
    ...seed,
  });
}

export interface IntentSeed {
  id?: string;
  tenant?: string;
  providers?: string[];
  activeIndex?: number;
  startedAt?: number;
  key?: string;
  createdAt?: number;
}

export function insertIntent(database: DatabaseSync, seed: IntentSeed = {}): string {
  const providers = seed.providers ?? ['installation-a'];
  const id = seed.id ?? 'intent-a';
  database
    .prepare(
      `INSERT INTO notification_delivery_intents (
         intent_id, tenant_id, plugin_installation_id, provider_order_version,
         provider_installation_ids_json, active_provider_index, provider_started_at,
         channel, notification_kind, payload_version, payload_key_id, payload_envelope_json,
         idempotency_key, request_fingerprint, fingerprint_key_id, state, expires_at,
         delete_after, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, 'email', 'auth.email_otp', 1, 'key-a',
                 '{"ciphertext":"opaque"}', ?, ?, 'notification-intent-v1', 'pending',
                 100000, 100000, ?, ?)`
    )
    .run(
      id,
      seed.tenant ?? 'tenant-a',
      providers[0] ?? 'installation-a',
      JSON.stringify(providers),
      seed.activeIndex ?? 0,
      seed.startedAt ?? 100,
      seed.key ?? 'notification/a',
      'a'.repeat(64),
      seed.createdAt ?? 100,
      seed.createdAt ?? 100
    );
  return id;
}

export function outboxRow(database: DatabaseSync, id = 'outbox-a'): Record<string, unknown> {
  return database.prepare('SELECT * FROM plugin_hook_outbox WHERE outbox_id = ?').get(id) as Record<
    string,
    unknown
  >;
}

export function intentRow(database: DatabaseSync, id = 'intent-a'): Record<string, unknown> {
  return database
    .prepare('SELECT * FROM notification_delivery_intents WHERE intent_id = ?')
    .get(id) as Record<string, unknown>;
}

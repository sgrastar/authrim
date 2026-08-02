import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';
import { encryptNotificationIntentPayload } from './notification-intent-envelope';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_KIND = /^[a-z][a-z0-9._:-]{0,127}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/u;
const EVENT_TYPE = 'notification.delivery.requested';
const EVENT_VERSION = 1 as const;
const CAPABILITY = 'notifier.send';
const FINGERPRINT_KEY_ID = 'notification-intent-v1';
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_COLLECTION_ENTRIES = 2_048;
const MAX_JSON_KEY_LENGTH = 512;

export interface NotificationDeliveryPayload {
  channel: 'email' | 'sms' | 'push';
  to: string;
  from?: string;
  subject?: string;
  body: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  templateId?: string;
  templateVars?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NotificationProviderPlan {
  configVersion: number;
  installationIds: string[];
}

export interface CreateNotificationDeliveryIntentInput {
  db: D1Database;
  environmentId: string;
  publicJwks: string;
  activeKeyId: string;
  idempotencyHmacKey: string;
  tenantId: string;
  intentId: string;
  outboxId: string;
  providerOrder: NotificationProviderPlan;
  notificationKind: string;
  idempotencyKey: string;
  expiresAt: number;
  payload: NotificationDeliveryPayload;
  now?: number;
}

export interface NotificationDeliveryIntentReference {
  tenantId: string;
  intentId: string;
  outboxId: string;
  pluginInstallationId: string;
  notificationKind: string;
  channel: NotificationDeliveryPayload['channel'];
  expiresAt: number;
  state: 'pending' | 'delivered' | 'permanent_failure';
}

interface IntentRow {
  intent_id: string;
  tenant_id: string;
  plugin_installation_id: string;
  provider_order_version: number | string;
  provider_installation_ids_json: string;
  active_provider_index: number | string;
  provider_started_at: number | string;
  channel: string;
  notification_kind: string;
  payload_version: number | string;
  payload_key_id: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  fingerprint_key_id: string;
  state: string;
  expires_at: number | string;
}

interface OutboxRow {
  outbox_id: string;
  tenant_id: string;
  plugin_installation_id: string;
  capability: string;
  event_type: string;
  event_version: number | string;
  idempotency_key: string;
  payload_json: string;
  payload_class: string;
  status: string;
}

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

function validateProviderPlan(value: NotificationProviderPlan): NotificationProviderPlan {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.configVersion) ||
    value.configVersion < 1 ||
    !Array.isArray(value.installationIds) ||
    value.installationIds.length < 1 ||
    value.installationIds.length > 8 ||
    value.installationIds.some(
      (installationId) => typeof installationId !== 'string' || !SAFE_ID.test(installationId)
    ) ||
    new Set(value.installationIds).size !== value.installationIds.length
  ) {
    throw new Error('notification_intent_provider_order_invalid');
  }
  return {
    configVersion: value.configVersion,
    installationIds: [...value.installationIds],
  };
}

function normalizeJson(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget = { remainingNodes: MAX_JSON_NODES }
): unknown {
  if (depth > MAX_JSON_DEPTH || budget.remainingNodes-- < 1) {
    throw new Error('notification_intent_payload_invalid');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value) || value.length > MAX_JSON_COLLECTION_ENTRIES) {
      throw new Error('notification_intent_payload_invalid');
    }
    seen.add(value);
    const normalized = value.map((entry) => normalizeJson(entry, depth + 1, seen, budget));
    seen.delete(value);
    return normalized;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('notification_intent_payload_invalid');
    let entryCount = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.hasOwn(value, key)) continue;
      entryCount += 1;
      if (entryCount > MAX_JSON_COLLECTION_ENTRIES || key.length > MAX_JSON_KEY_LENGTH) {
        throw new Error('notification_intent_payload_invalid');
      }
    }
    seen.add(value);
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      Object.defineProperty(normalized, key, {
        value: normalizeJson((value as Record<string, unknown>)[key], depth + 1, seen, budget),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    seen.delete(value);
    return normalized;
  }
  throw new Error('notification_intent_payload_invalid');
}

function optionalString(
  payload: Record<string, unknown>,
  field: 'from' | 'replyTo' | 'templateId',
  maxLength: number
): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error('notification_intent_payload_invalid');
  }
  return value;
}

function optionalRecipients(
  payload: Record<string, unknown>,
  field: 'cc' | 'bcc'
): string[] | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error('notification_intent_payload_invalid');
  }
  const recipients: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 2_048) {
      throw new Error('notification_intent_payload_invalid');
    }
    recipients.push(entry);
  }
  return recipients;
}

function optionalJsonRecord(
  payload: Record<string, unknown>,
  field: 'templateVars' | 'metadata'
): Record<string, unknown> | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('notification_intent_payload_invalid');
  }
  const normalized = normalizeJson(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('notification_intent_payload_invalid');
  }
  return normalized as Record<string, unknown>;
}

export function parseNotificationDeliveryPayload(
  value: unknown,
  expectedChannel?: string
): NotificationDeliveryPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('notification_intent_payload_invalid');
  }
  const payload = value as Record<string, unknown>;
  const allowed = new Set([
    'channel',
    'to',
    'from',
    'subject',
    'body',
    'replyTo',
    'cc',
    'bcc',
    'templateId',
    'templateVars',
    'metadata',
  ]);
  if (
    Object.keys(payload).some((key) => !allowed.has(key)) ||
    !['email', 'sms', 'push'].includes(String(payload.channel)) ||
    (expectedChannel !== undefined && payload.channel !== expectedChannel) ||
    typeof payload.to !== 'string' ||
    payload.to.length < 1 ||
    payload.to.length > 2_048 ||
    typeof payload.body !== 'string' ||
    payload.body.length < 1 ||
    payload.body.length > 128 * 1024 ||
    (payload.subject !== undefined &&
      (typeof payload.subject !== 'string' || payload.subject.length > 998))
  ) {
    throw new Error('notification_intent_payload_invalid');
  }

  const parsed: NotificationDeliveryPayload = {
    channel: payload.channel as NotificationDeliveryPayload['channel'],
    to: payload.to,
    body: payload.body,
  };
  const from = optionalString(payload, 'from', 2_048);
  const replyTo = optionalString(payload, 'replyTo', 2_048);
  const templateId = optionalString(payload, 'templateId', 2_048);
  const cc = optionalRecipients(payload, 'cc');
  const bcc = optionalRecipients(payload, 'bcc');
  const templateVars = optionalJsonRecord(payload, 'templateVars');
  const metadata = optionalJsonRecord(payload, 'metadata');
  if (from !== undefined) parsed.from = from;
  if (payload.subject !== undefined) parsed.subject = payload.subject;
  if (replyTo !== undefined) parsed.replyTo = replyTo;
  if (cc !== undefined) parsed.cc = cc;
  if (bcc !== undefined) parsed.bcc = bcc;
  if (templateId !== undefined) parsed.templateId = templateId;
  if (templateVars !== undefined) parsed.templateVars = templateVars;
  if (metadata !== undefined) parsed.metadata = metadata;
  return parsed;
}

async function requestFingerprint(input: CreateNotificationDeliveryIntentInput): Promise<string> {
  if (input.idempotencyHmacKey.length < 32 || input.idempotencyHmacKey.length > 512) {
    throw new Error('notification_intent_hmac_key_invalid');
  }
  const canonical = JSON.stringify(
    normalizeJson([
      'authrim-notification-intent-idempotency-v1',
      input.environmentId,
      input.tenantId,
      input.intentId,
      input.outboxId,
      input.providerOrder,
      input.notificationKind,
      input.idempotencyKey,
      input.expiresAt,
      input.payload,
    ])
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.idempotencyHmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertBatch(results: D1Result<unknown>[]): void {
  if (
    results.length !== 2 ||
    results.some((result) => result.success !== true || result.error !== undefined)
  ) {
    throw new Error('notification_intent_commit_failed');
  }
}

function assertReflection(input: {
  intent: IntentRow | null;
  outbox: OutboxRow | null;
  expected: CreateNotificationDeliveryIntentInput;
  payloadJson: string;
  requestFingerprint: string;
}): NotificationDeliveryIntentReference {
  const { intent, outbox, expected, payloadJson, requestFingerprint } = input;
  if (!intent && !outbox) throw new Error('notification_intent_commit_failed');
  if (!intent || !outbox) throw new Error('notification_intent_idempotency_conflict');
  const providerOrder = validateProviderPlan(expected.providerOrder);
  const activeProviderIndex = integer(
    intent.active_provider_index,
    'notification_intent_reflection_invalid'
  );
  let reflectedProviderIds: unknown;
  try {
    reflectedProviderIds = JSON.parse(intent.provider_installation_ids_json);
  } catch {
    throw new Error('notification_intent_idempotency_conflict');
  }
  const baseInvalid =
    intent.intent_id !== expected.intentId ||
    intent.tenant_id !== expected.tenantId ||
    intent.plugin_installation_id !== providerOrder.installationIds[0] ||
    integer(intent.provider_order_version, 'notification_intent_reflection_invalid') !==
      providerOrder.configVersion ||
    JSON.stringify(reflectedProviderIds) !== JSON.stringify(providerOrder.installationIds) ||
    activeProviderIndex < 0 ||
    activeProviderIndex >= providerOrder.installationIds.length ||
    integer(intent.provider_started_at, 'notification_intent_reflection_invalid') < 1 ||
    intent.channel !== expected.payload.channel ||
    intent.notification_kind !== expected.notificationKind ||
    integer(intent.payload_version, 'notification_intent_reflection_invalid') !== 1 ||
    intent.idempotency_key !== expected.idempotencyKey ||
    intent.request_fingerprint !== requestFingerprint ||
    intent.fingerprint_key_id !== FINGERPRINT_KEY_ID ||
    integer(intent.expires_at, 'notification_intent_reflection_invalid') !== expected.expiresAt ||
    outbox.outbox_id !== expected.outboxId ||
    outbox.tenant_id !== expected.tenantId ||
    outbox.plugin_installation_id !== providerOrder.installationIds[activeProviderIndex] ||
    outbox.capability !== CAPABILITY ||
    outbox.event_type !== EVENT_TYPE ||
    integer(outbox.event_version, 'notification_intent_reflection_invalid') !== EVENT_VERSION ||
    outbox.idempotency_key !== expected.idempotencyKey ||
    outbox.payload_json !== payloadJson ||
    outbox.payload_class !== 'reference_v1';
  if (baseInvalid) {
    throw new Error('notification_intent_idempotency_conflict');
  }
  let state: NotificationDeliveryIntentReference['state'];
  if (intent.state === 'delivered') {
    state = 'delivered';
  } else if (['canceled', 'expired', 'dead_letter'].includes(intent.state)) {
    state = 'permanent_failure';
  } else if (
    intent.state === 'pending' &&
    !!intent.payload_key_id &&
    ['queued', 'locked', 'waiting_retry'].includes(outbox.status)
  ) {
    state = 'pending';
  } else {
    throw new Error('notification_intent_idempotency_conflict');
  }
  return {
    tenantId: intent.tenant_id,
    intentId: intent.intent_id,
    outboxId: outbox.outbox_id,
    pluginInstallationId: intent.plugin_installation_id,
    notificationKind: intent.notification_kind,
    channel: expected.payload.channel,
    expiresAt: integer(intent.expires_at, 'notification_intent_reflection_invalid'),
    state,
  };
}

export async function createNotificationDeliveryIntent(
  input: CreateNotificationDeliveryIntentInput
): Promise<NotificationDeliveryIntentReference> {
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const providerOrder = validateProviderPlan(input.providerOrder);
  if (
    !SAFE_ID.test(input.environmentId) ||
    !SAFE_ID.test(input.tenantId) ||
    !SAFE_ID.test(input.intentId) ||
    !SAFE_ID.test(input.outboxId) ||
    !SAFE_KIND.test(input.notificationKind) ||
    !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
    !Number.isSafeInteger(now) ||
    now < 1 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= now ||
    input.expiresAt > now + 7 * 24 * 60 * 60
  ) {
    throw new Error('notification_intent_input_invalid');
  }
  const payload = parseNotificationDeliveryPayload(input.payload);
  const normalizedInput = { ...input, providerOrder, payload };
  const payloadJson = JSON.stringify({
    tenantId: input.tenantId,
    intentId: input.intentId,
    eventType: EVENT_TYPE,
    eventVersion: EVENT_VERSION,
  });
  const fingerprint = await requestFingerprint(normalizedInput);
  const envelope = await encryptNotificationIntentPayload({
    publicJwks: input.publicJwks,
    activeKeyId: input.activeKeyId,
    context: {
      environmentId: input.environmentId,
      tenantId: input.tenantId,
      intentId: input.intentId,
      notificationKind: input.notificationKind,
      payloadVersion: 1,
    },
    payload,
  });
  const session = primary(input.db);
  try {
    const results = await session.batch([
      session
        .prepare(
          `INSERT INTO notification_delivery_intents (
           intent_id, tenant_id, plugin_installation_id, provider_order_version,
           provider_installation_ids_json, active_provider_index, provider_started_at,
           channel, notification_kind,
           payload_version, payload_key_id, payload_envelope_json, idempotency_key,
           request_fingerprint, fingerprint_key_id, state, expires_at, delete_after,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        )
        .bind(
          input.intentId,
          input.tenantId,
          providerOrder.installationIds[0],
          providerOrder.configVersion,
          JSON.stringify(providerOrder.installationIds),
          now,
          payload.channel,
          input.notificationKind,
          input.activeKeyId,
          envelope,
          input.idempotencyKey,
          fingerprint,
          FINGERPRINT_KEY_ID,
          input.expiresAt,
          input.expiresAt,
          now,
          now
        ),
      session
        .prepare(
          `INSERT INTO plugin_hook_outbox (
           outbox_id, tenant_id, plugin_installation_id, capability, event_type,
           event_version, idempotency_key, payload_json, payload_class,
           status, attempt_no, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reference_v1', 'queued', 0, ?, ?)`
        )
        .bind(
          input.outboxId,
          input.tenantId,
          providerOrder.installationIds[0],
          CAPABILITY,
          EVENT_TYPE,
          EVENT_VERSION,
          input.idempotencyKey,
          payloadJson,
          now,
          now
        ),
    ]);
    assertBatch(results);
  } catch {
    // A duplicate retry or response loss is adopted only after exact primary reflection below.
  }
  const [intent, outbox] = await Promise.all([
    session
      .prepare(
        `SELECT intent_id, tenant_id, plugin_installation_id, provider_order_version,
                provider_installation_ids_json, active_provider_index, provider_started_at,
                channel, notification_kind,
                payload_version, payload_key_id, idempotency_key, state, expires_at
                , request_fingerprint, fingerprint_key_id
           FROM notification_delivery_intents
          WHERE intent_id = ? AND tenant_id = ?`
      )
      .bind(input.intentId, input.tenantId)
      .first<IntentRow>(),
    session
      .prepare(
        `SELECT outbox_id, tenant_id, plugin_installation_id, capability, event_type,
                event_version, idempotency_key, payload_json, payload_class, status
           FROM plugin_hook_outbox
          WHERE outbox_id = ? AND tenant_id = ?`
      )
      .bind(input.outboxId, input.tenantId)
      .first<OutboxRow>(),
  ]);
  return assertReflection({
    intent,
    outbox,
    expected: normalizedInput,
    payloadJson,
    requestFingerprint: fingerprint,
  });
}

import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { PluginDispatchLimiter, PluginDispatchPolicy } from './dispatch-limiter';
import type { PluginHookBackend, PluginHookInvocation, PluginHookReferencePayload } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/u;
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const SAFE_ERROR = /^[a-z][a-z0-9_:-]{0,127}$/u;
const LEASE_SECONDS = 60;
const SUCCEEDED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEAD_LETTER_RETENTION_SECONDS = 90 * 24 * 60 * 60;

interface PluginHookOutboxRow {
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
  attempt_no: number | string;
  claim_owner: string | null;
  claim_token: string | null;
  lease_until: number | string | null;
  next_attempt_at: number | string | null;
  intent_state?: string | null;
  intent_active_provider?: string | null;
  provider_started_at?: number | string | null;
  created_at: number | string;
}

interface NotificationProviderStateRow {
  state: string;
  provider_installation_ids_json: string;
  active_provider_index: number | string;
  provider_started_at: number | string;
  outbox_status: string;
  outbox_plugin_installation_id: string;
  outbox_attempt_no: number | string;
  outbox_claim_owner: string | null;
  outbox_claim_token: string | null;
  outbox_next_attempt_at: number | string | null;
}

export interface ClaimedPluginHook {
  outboxId: string;
  invocation: PluginHookInvocation;
  attemptNo: number;
  claimOwner: string;
  claimToken: string;
  leaseUntil: number;
  createdAt: number;
  providerStartedAt: number;
}

export type PluginHookFailureScope = 'provider' | 'message' | 'platform';

export interface PluginHookOutboxStore {
  claimNext(input: { ownerId: string; now: number }): Promise<ClaimedPluginHook | null>;
  claimReference(input: {
    ownerId: string;
    now: number;
    outboxId: string;
    tenantId: string;
    pluginInstallationId: string;
    intentId: string;
  }): Promise<
    | { state: 'claimed'; claim: ClaimedPluginHook }
    | { state: 'pending' | 'delivered' | 'permanent_failure' }
  >;
  succeed(claim: ClaimedPluginHook, now: number): Promise<void>;
  fail(
    claim: ClaimedPluginHook,
    input: {
      now: number;
      errorCode: string;
      retryable: boolean;
      maxAttempts: number;
      failureScope: PluginHookFailureScope;
    }
  ): Promise<'waiting_retry' | 'dead_letter'>;
}

function integer(value: number | string | null, code: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function referencePayload(value: string, row: PluginHookOutboxRow): PluginHookReferencePayload {
  if (value.length > 16_384) throw new Error('plugin_outbox_payload_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('plugin_outbox_payload_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin_outbox_payload_invalid');
  }
  const payload = parsed as Record<string, unknown>;
  const eventVersion = integer(row.event_version, 'plugin_outbox_event_version_invalid', 1);
  const accountReference =
    Object.keys(payload).sort().join(',') === 'accountId,eventType,eventVersion,tenantId' &&
    typeof payload.accountId === 'string' &&
    SAFE_ID.test(payload.accountId);
  const notificationReference =
    Object.keys(payload).sort().join(',') === 'eventType,eventVersion,intentId,tenantId' &&
    row.capability === 'notifier.send' &&
    row.event_type === 'notification.delivery.requested' &&
    eventVersion === 1 &&
    typeof payload.intentId === 'string' &&
    SAFE_ID.test(payload.intentId);
  if (
    (!accountReference && !notificationReference) ||
    payload.tenantId !== row.tenant_id ||
    payload.eventType !== row.event_type ||
    payload.eventVersion !== eventVersion
  ) {
    throw new Error('plugin_outbox_payload_invalid');
  }
  return accountReference
    ? {
        tenantId: row.tenant_id,
        accountId: payload.accountId as string,
        eventType: row.event_type,
        eventVersion,
      }
    : {
        tenantId: row.tenant_id,
        intentId: payload.intentId as string,
        eventType: 'notification.delivery.requested',
        eventVersion: 1,
      };
}

function decodeClaim(row: PluginHookOutboxRow): ClaimedPluginHook {
  if (
    !SAFE_ID.test(row.outbox_id) ||
    !SAFE_ID.test(row.tenant_id) ||
    !SAFE_ID.test(row.plugin_installation_id) ||
    !SAFE_CAPABILITY.test(row.capability) ||
    !SAFE_CAPABILITY.test(row.event_type) ||
    !SAFE_IDEMPOTENCY_KEY.test(row.idempotency_key) ||
    row.payload_class !== 'reference_v1' ||
    row.status !== 'locked' ||
    !row.claim_owner ||
    !SAFE_ID.test(row.claim_owner) ||
    !row.claim_token ||
    !SAFE_ID.test(row.claim_token)
  ) {
    throw new Error('plugin_outbox_claim_invalid');
  }
  const eventVersion = integer(row.event_version, 'plugin_outbox_event_version_invalid', 1);
  const payload = referencePayload(row.payload_json, row);
  const createdAt = integer(row.created_at, 'plugin_outbox_created_at_invalid', 1);
  const providerStartedAt =
    'intentId' in payload
      ? integer(row.provider_started_at ?? null, 'plugin_outbox_provider_started_at_invalid', 1)
      : createdAt;
  if ('intentId' in payload && row.intent_active_provider !== row.plugin_installation_id) {
    throw new Error('plugin_outbox_active_provider_invalid');
  }
  return {
    outboxId: row.outbox_id,
    attemptNo: integer(row.attempt_no, 'plugin_outbox_attempt_invalid', 1),
    claimOwner: row.claim_owner,
    claimToken: row.claim_token,
    leaseUntil: integer(row.lease_until, 'plugin_outbox_lease_invalid', 1),
    createdAt,
    providerStartedAt,
    invocation: {
      pluginInstallationId: row.plugin_installation_id,
      tenantId: row.tenant_id,
      capability: row.capability,
      eventType: row.event_type,
      eventVersion,
      idempotencyKey: row.idempotency_key,
      payload,
    },
  };
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') throw new Error('plugin_outbox_d1_session_required');
  return db.withSession('first-primary');
}

function retryDelaySeconds(outboxId: string, attemptNo: number): number {
  let hash = 0;
  for (const character of outboxId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const base = Math.min(900, 5 * 2 ** Math.min(attemptNo - 1, 8));
  return base + (hash % Math.max(1, Math.floor(base / 5)));
}

export class D1PluginHookOutboxStore implements PluginHookOutboxStore {
  constructor(private readonly db: D1Database) {}

  async claimNext(input: { ownerId: string; now: number }): Promise<ClaimedPluginHook | null> {
    if (!SAFE_ID.test(input.ownerId) || !Number.isSafeInteger(input.now) || input.now < 1) {
      throw new Error('plugin_outbox_claim_input_invalid');
    }
    const session = primary(this.db);
    const candidate = await session
      .prepare(
        `SELECT outbox_id
           FROM plugin_hook_outbox
          WHERE (
            status = 'queued' OR
            (status = 'waiting_retry' AND next_attempt_at <= ?) OR
            (status = 'locked' AND lease_until <= ?)
          )
          ORDER BY COALESCE(next_attempt_at, created_at), created_at, outbox_id
          LIMIT 1`
      )
      .bind(input.now, input.now)
      .first<{ outbox_id: string }>();
    if (!candidate) return null;
    if (!SAFE_ID.test(candidate.outbox_id)) throw new Error('plugin_outbox_candidate_invalid');
    const claimToken = `claim-${crypto.randomUUID()}`;
    const leaseUntil = input.now + LEASE_SECONDS;
    const claimed = await session
      .prepare(
        `UPDATE plugin_hook_outbox
            SET status = 'locked', attempt_no = attempt_no + 1,
                claim_owner = ?, claim_token = ?, lease_until = ?, next_attempt_at = NULL,
                updated_at = ?
          WHERE outbox_id = ? AND (
            status = 'queued' OR
            (status = 'waiting_retry' AND next_attempt_at <= ?) OR
            (status = 'locked' AND lease_until <= ?)
          )`
      )
      .bind(
        input.ownerId,
        claimToken,
        leaseUntil,
        input.now,
        candidate.outbox_id,
        input.now,
        input.now
      )
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) return null;
    const reflected = await session
      .prepare(
        `SELECT outbox_id, tenant_id, plugin_installation_id, capability, event_type,
                event_version, idempotency_key, payload_json, payload_class, status,
                attempt_no, claim_owner, claim_token, lease_until, next_attempt_at, created_at,
                (SELECT provider_started_at
                   FROM notification_delivery_intents intent
                  WHERE intent.intent_id = json_extract(plugin_hook_outbox.payload_json, '$.intentId')
                    AND intent.tenant_id = plugin_hook_outbox.tenant_id
                    AND plugin_hook_outbox.capability = 'notifier.send'
                    AND plugin_hook_outbox.event_type = 'notification.delivery.requested')
                  AS provider_started_at,
                (SELECT json_extract(
                          provider_installation_ids_json,
                          '$[' || active_provider_index || ']'
                        )
                   FROM notification_delivery_intents intent
                  WHERE intent.intent_id = json_extract(plugin_hook_outbox.payload_json, '$.intentId')
                    AND intent.tenant_id = plugin_hook_outbox.tenant_id
                    AND plugin_hook_outbox.capability = 'notifier.send'
                    AND plugin_hook_outbox.event_type = 'notification.delivery.requested')
                  AS intent_active_provider
           FROM plugin_hook_outbox
          WHERE outbox_id = ? AND status = 'locked'
            AND claim_owner = ? AND claim_token = ?`
      )
      .bind(candidate.outbox_id, input.ownerId, claimToken)
      .first<PluginHookOutboxRow>();
    if (!reflected) throw new Error('plugin_outbox_claim_reflection_failed');
    try {
      return decodeClaim(reflected);
    } catch {
      await this.quarantine(reflected, input.now);
      throw new Error('plugin_outbox_claim_invalid');
    }
  }

  async claimReference(input: {
    ownerId: string;
    now: number;
    outboxId: string;
    tenantId: string;
    pluginInstallationId: string;
    intentId: string;
  }): Promise<
    | { state: 'claimed'; claim: ClaimedPluginHook }
    | { state: 'pending' | 'delivered' | 'permanent_failure' }
  > {
    if (
      !SAFE_ID.test(input.ownerId) ||
      !SAFE_ID.test(input.outboxId) ||
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !SAFE_ID.test(input.intentId) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1
    ) {
      throw new Error('plugin_outbox_reference_input_invalid');
    }
    const session = primary(this.db);
    const payloadJson = JSON.stringify({
      tenantId: input.tenantId,
      intentId: input.intentId,
      eventType: 'notification.delivery.requested',
      eventVersion: 1,
    });
    const load = () =>
      session
        .prepare(
          `SELECT outbox.outbox_id, outbox.tenant_id, outbox.plugin_installation_id,
                  outbox.capability, outbox.event_type, outbox.event_version,
                  outbox.idempotency_key, outbox.payload_json, outbox.payload_class,
                  outbox.status, outbox.attempt_no, outbox.claim_owner, outbox.claim_token,
                  outbox.lease_until, outbox.next_attempt_at, outbox.created_at,
                  intent.state AS intent_state,
                  intent.provider_started_at AS provider_started_at,
                  json_extract(
                    intent.provider_installation_ids_json,
                    '$[' || intent.active_provider_index || ']'
                  ) AS intent_active_provider
             FROM plugin_hook_outbox outbox
             JOIN notification_delivery_intents intent
               ON intent.intent_id = ? AND intent.tenant_id = ?
              AND intent.plugin_installation_id = ?
              AND outbox.plugin_installation_id = json_extract(
                    intent.provider_installation_ids_json,
                    '$[' || intent.active_provider_index || ']'
                  )
            WHERE outbox.outbox_id = ? AND outbox.tenant_id = ?
              AND outbox.capability = 'notifier.send'
              AND outbox.event_type = 'notification.delivery.requested'
              AND outbox.event_version = 1
              AND outbox.payload_class = 'reference_v1' AND outbox.payload_json = ?`
        )
        .bind(
          input.intentId,
          input.tenantId,
          input.pluginInstallationId,
          input.outboxId,
          input.tenantId,
          payloadJson
        )
        .first<PluginHookOutboxRow>();
    const existing = await load();
    if (!existing) throw new Error('plugin_outbox_reference_not_found');
    const settled = this.referenceState(existing, input.now);
    if (settled) return { state: settled };

    const claimToken = `claim-${crypto.randomUUID()}`;
    const leaseUntil = input.now + LEASE_SECONDS;
    const claimed = await session
      .prepare(
        `UPDATE plugin_hook_outbox
            SET status = 'locked', attempt_no = attempt_no + 1,
                claim_owner = ?, claim_token = ?, lease_until = ?, next_attempt_at = NULL,
                updated_at = ?
          WHERE outbox_id = ? AND tenant_id = ? AND plugin_installation_id = ?
            AND capability = 'notifier.send'
            AND event_type = 'notification.delivery.requested' AND event_version = 1
            AND payload_class = 'reference_v1' AND payload_json = ?
            AND EXISTS (
              SELECT 1 FROM notification_delivery_intents intent
               WHERE intent.intent_id = ? AND intent.tenant_id = ?
                 AND intent.plugin_installation_id = ?
                 AND plugin_hook_outbox.plugin_installation_id = json_extract(
                       intent.provider_installation_ids_json,
                       '$[' || intent.active_provider_index || ']'
                     )
            )
            AND (
              status = 'queued' OR
              (status = 'waiting_retry' AND next_attempt_at <= ?) OR
              (status = 'locked' AND lease_until <= ?)
            )`
      )
      .bind(
        input.ownerId,
        claimToken,
        leaseUntil,
        input.now,
        input.outboxId,
        input.tenantId,
        existing.plugin_installation_id,
        payloadJson,
        input.intentId,
        input.tenantId,
        input.pluginInstallationId,
        input.now,
        input.now
      )
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      const raced = await load();
      if (!raced) throw new Error('plugin_outbox_reference_not_found');
      return { state: this.referenceState(raced, input.now) ?? 'pending' };
    }
    const reflected = await load();
    if (
      !reflected ||
      reflected.status !== 'locked' ||
      reflected.claim_owner !== input.ownerId ||
      reflected.claim_token !== claimToken
    ) {
      throw new Error('plugin_outbox_claim_reflection_failed');
    }
    try {
      return { state: 'claimed', claim: decodeClaim(reflected) };
    } catch {
      await this.quarantine(reflected, input.now);
      throw new Error('plugin_outbox_claim_invalid');
    }
  }

  async succeed(claim: ClaimedPluginHook, now: number): Promise<void> {
    await this.finish(claim, {
      now,
      status: 'succeeded',
      errorCode: null,
      nextAttemptAt: null,
      deleteAfter: now + SUCCEEDED_RETENTION_SECONDS,
    });
  }

  async fail(
    claim: ClaimedPluginHook,
    input: {
      now: number;
      errorCode: string;
      retryable: boolean;
      maxAttempts: number;
      failureScope: PluginHookFailureScope;
    }
  ): Promise<'waiting_retry' | 'dead_letter'> {
    if (
      !SAFE_ERROR.test(input.errorCode) ||
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100
    ) {
      throw new Error('plugin_outbox_failure_input_invalid');
    }
    const terminal = !input.retryable || claim.attemptNo >= input.maxAttempts;
    if (
      terminal &&
      input.failureScope === 'provider' &&
      'intentId' in claim.invocation.payload &&
      (await this.advanceNotificationProvider(claim, input))
    ) {
      return 'waiting_retry';
    }
    const status = terminal ? 'dead_letter' : 'waiting_retry';
    await this.finish(claim, {
      now: input.now,
      status,
      errorCode: input.errorCode,
      nextAttemptAt: terminal
        ? null
        : input.now + retryDelaySeconds(claim.outboxId, claim.attemptNo),
      deleteAfter: terminal ? input.now + DEAD_LETTER_RETENTION_SECONDS : null,
    });
    return status;
  }

  private async advanceNotificationProvider(
    claim: ClaimedPluginHook,
    input: { now: number; errorCode: string }
  ): Promise<boolean> {
    if (!('intentId' in claim.invocation.payload)) return false;
    const intentId = claim.invocation.payload.intentId;
    const session = primary(this.db);
    const load = () =>
      session
        .prepare(
          `SELECT intent.state, intent.provider_installation_ids_json,
                  intent.active_provider_index, intent.provider_started_at,
                  outbox.status AS outbox_status,
                  outbox.plugin_installation_id AS outbox_plugin_installation_id,
                  outbox.attempt_no AS outbox_attempt_no,
                  outbox.claim_owner AS outbox_claim_owner,
                  outbox.claim_token AS outbox_claim_token,
                  outbox.next_attempt_at AS outbox_next_attempt_at
             FROM notification_delivery_intents intent
             JOIN plugin_hook_outbox outbox
               ON outbox.outbox_id = ? AND outbox.tenant_id = intent.tenant_id
            WHERE intent.intent_id = ? AND intent.tenant_id = ?`
        )
        .bind(claim.outboxId, intentId, claim.invocation.tenantId)
        .first<NotificationProviderStateRow>();
    const current = await load();
    if (!current) throw new Error('plugin_outbox_notification_state_invalid');
    const providerIds = this.providerIds(current);
    const activeIndex = integer(
      current.active_provider_index,
      'plugin_outbox_notification_state_invalid'
    );
    const reflectedActive = providerIds[activeIndex];
    if (current.state !== 'pending' || current.outbox_plugin_installation_id !== reflectedActive) {
      throw new Error('plugin_outbox_notification_state_invalid');
    }
    if (reflectedActive !== claim.invocation.pluginInstallationId) {
      if (
        ['queued', 'waiting_retry', 'locked'].includes(current.outbox_status) &&
        activeIndex > 0
      ) {
        return true;
      }
      throw new Error('plugin_outbox_stale_claim');
    }
    const nextProvider = providerIds[activeIndex + 1];
    if (!nextProvider) return false;

    const nextIndex = activeIndex + 1;
    const results = await session.batch([
      session
        .prepare(
          `UPDATE notification_delivery_intents
              SET active_provider_index = ?, provider_started_at = ?,
                  attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
            WHERE intent_id = ? AND tenant_id = ? AND state = 'pending'
              AND active_provider_index = ?
              AND json_extract(
                    provider_installation_ids_json,
                    '$[' || active_provider_index || ']'
                  ) = ?`
        )
        .bind(
          nextIndex,
          input.now,
          input.errorCode,
          input.now,
          intentId,
          claim.invocation.tenantId,
          activeIndex,
          claim.invocation.pluginInstallationId
        ),
      session
        .prepare(
          `UPDATE plugin_hook_outbox
              SET plugin_installation_id = ?, status = 'waiting_retry', attempt_no = 0,
                  claim_owner = NULL, claim_token = NULL, lease_until = NULL,
                  next_attempt_at = ?, last_error_code = ?, updated_at = ?
            WHERE outbox_id = ? AND tenant_id = ? AND plugin_installation_id = ?
              AND status = 'locked' AND claim_owner = ? AND claim_token = ?
              AND attempt_no = ?
              AND EXISTS (
                SELECT 1 FROM notification_delivery_intents intent
                 WHERE intent.intent_id = ? AND intent.tenant_id = ?
                   AND intent.state = 'pending' AND intent.active_provider_index = ?
                   AND intent.provider_started_at = ?
                   AND json_extract(
                         intent.provider_installation_ids_json,
                         '$[' || intent.active_provider_index || ']'
                       ) = ?
              )`
        )
        .bind(
          nextProvider,
          input.now,
          input.errorCode,
          input.now,
          claim.outboxId,
          claim.invocation.tenantId,
          claim.invocation.pluginInstallationId,
          claim.claimOwner,
          claim.claimToken,
          claim.attemptNo,
          intentId,
          claim.invocation.tenantId,
          nextIndex,
          input.now,
          nextProvider
        ),
    ]);
    if (results.some((result) => result.success !== true || result.error !== undefined)) {
      throw new Error('plugin_outbox_provider_advance_failed');
    }
    const reflected = await load();
    if (!reflected) throw new Error('plugin_outbox_provider_advance_failed');
    const reflectedIds = this.providerIds(reflected);
    const reflectedIndex = integer(
      reflected.active_provider_index,
      'plugin_outbox_notification_state_invalid'
    );
    if (
      reflected.state !== 'pending' ||
      reflectedIndex !== nextIndex ||
      reflectedIds[reflectedIndex] !== nextProvider ||
      integer(reflected.provider_started_at, 'plugin_outbox_notification_state_invalid', 1) !==
        input.now ||
      reflected.outbox_status !== 'waiting_retry' ||
      reflected.outbox_plugin_installation_id !== nextProvider ||
      integer(reflected.outbox_attempt_no, 'plugin_outbox_notification_state_invalid') !== 0 ||
      reflected.outbox_claim_owner !== null ||
      reflected.outbox_claim_token !== null ||
      integer(reflected.outbox_next_attempt_at, 'plugin_outbox_notification_state_invalid', 1) !==
        input.now
    ) {
      throw new Error('plugin_outbox_provider_advance_failed');
    }
    return true;
  }

  private providerIds(row: NotificationProviderStateRow): string[] {
    let value: unknown;
    try {
      value = JSON.parse(row.provider_installation_ids_json);
    } catch {
      throw new Error('plugin_outbox_notification_state_invalid');
    }
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 8 ||
      value.some((providerId) => typeof providerId !== 'string' || !SAFE_ID.test(providerId)) ||
      new Set(value).size !== value.length
    ) {
      throw new Error('plugin_outbox_notification_state_invalid');
    }
    return value as string[];
  }

  private async finish(
    claim: ClaimedPluginHook,
    input: {
      now: number;
      status: 'waiting_retry' | 'succeeded' | 'dead_letter';
      errorCode: string | null;
      nextAttemptAt: number | null;
      deleteAfter: number | null;
    }
  ): Promise<void> {
    if (!Number.isSafeInteger(input.now) || input.now < 1) {
      throw new Error('plugin_outbox_completion_input_invalid');
    }
    const session = primary(this.db);
    const outboxStatement = session
      .prepare(
        `UPDATE plugin_hook_outbox
            SET status = ?, claim_owner = NULL, claim_token = NULL, lease_until = NULL,
                next_attempt_at = ?, last_error_code = ?,
                succeeded_at = CASE WHEN ? = 'succeeded' THEN ? ELSE succeeded_at END,
                dead_lettered_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE dead_lettered_at END,
                delete_after = ?, updated_at = ?
          WHERE outbox_id = ? AND tenant_id = ? AND status = 'locked'
            AND plugin_installation_id = ?
            AND claim_owner = ? AND claim_token = ? AND attempt_no = ?`
      )
      .bind(
        input.status,
        input.nextAttemptAt,
        input.errorCode,
        input.status,
        input.now,
        input.status,
        input.now,
        input.deleteAfter,
        input.now,
        claim.outboxId,
        claim.invocation.tenantId,
        claim.invocation.pluginInstallationId,
        claim.claimOwner,
        claim.claimToken,
        claim.attemptNo
      );
    if (input.status === 'dead_letter' && 'intentId' in claim.invocation.payload) {
      const notificationOutboxStatement = session
        .prepare(
          `UPDATE plugin_hook_outbox
              SET status = 'dead_letter', claim_owner = NULL, claim_token = NULL,
                  lease_until = NULL, next_attempt_at = NULL, last_error_code = ?,
                  dead_lettered_at = ?, delete_after = ?, updated_at = ?
            WHERE outbox_id = ? AND tenant_id = ? AND plugin_installation_id = ?
              AND status = 'locked' AND claim_owner = ? AND claim_token = ?
              AND attempt_no = ?
              AND EXISTS (
                SELECT 1 FROM notification_delivery_intents intent
                 WHERE intent.intent_id = ? AND intent.tenant_id = ?
                   AND intent.state = 'dead_letter'
                   AND json_extract(
                         intent.provider_installation_ids_json,
                         '$[' || intent.active_provider_index || ']'
                       ) = plugin_hook_outbox.plugin_installation_id
              )`
        )
        .bind(
          input.errorCode,
          input.now,
          input.deleteAfter,
          input.now,
          claim.outboxId,
          claim.invocation.tenantId,
          claim.invocation.pluginInstallationId,
          claim.claimOwner,
          claim.claimToken,
          claim.attemptNo,
          claim.invocation.payload.intentId,
          claim.invocation.tenantId
        );
      const results = await session.batch([
        session
          .prepare(
            `UPDATE notification_delivery_intents
                SET state = 'dead_letter', payload_key_id = NULL,
                    payload_envelope_json = NULL, dead_lettered_at = ?,
                    delivery_status = 'failed', delivery_status_updated_at = ?,
                    attempt_count = attempt_count + 1, last_error_code = ?,
                    delete_after = ?, updated_at = ?
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
            input.errorCode,
            input.deleteAfter,
            input.now,
            claim.invocation.payload.intentId,
            claim.invocation.tenantId,
            claim.invocation.pluginInstallationId
          ),
        notificationOutboxStatement,
      ]);
      if (
        results.some((result) => result.success !== true || result.error !== undefined) ||
        (results[1]?.meta.changes ?? 0) !== 1
      ) {
        throw new Error('plugin_outbox_stale_claim');
      }
      return;
    }
    if ('intentId' in claim.invocation.payload) {
      const results = await session.batch([
        session
          .prepare(
            `UPDATE notification_delivery_intents
                SET attempt_count = attempt_count + CASE WHEN ? = 'succeeded' THEN 0 ELSE 1 END,
                    last_error_code = ?, updated_at = ?
              WHERE intent_id = ? AND tenant_id = ?`
          )
          .bind(
            input.status,
            input.errorCode,
            input.now,
            claim.invocation.payload.intentId,
            claim.invocation.tenantId
          ),
        outboxStatement,
      ]);
      if (
        results.some((result) => result.success !== true || result.error !== undefined) ||
        (results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1
      ) {
        throw new Error('plugin_outbox_stale_claim');
      }
      return;
    }
    const result = await outboxStatement.run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_outbox_stale_claim');
  }

  private referenceState(
    row: PluginHookOutboxRow,
    now: number
  ): 'pending' | 'delivered' | 'permanent_failure' | null {
    if (row.intent_state === 'delivered') return 'delivered';
    if (['canceled', 'expired', 'dead_letter'].includes(row.intent_state ?? '')) {
      return 'permanent_failure';
    }
    if (row.intent_state !== 'pending') throw new Error('plugin_outbox_reference_state_invalid');
    if (['succeeded', 'dead_letter', 'canceled'].includes(row.status)) {
      throw new Error('plugin_outbox_reference_state_invalid');
    }
    if (row.status === 'waiting_retry') {
      return integer(row.next_attempt_at, 'plugin_outbox_next_attempt_invalid', 1) > now
        ? 'pending'
        : null;
    }
    if (row.status === 'locked') {
      return integer(row.lease_until, 'plugin_outbox_lease_invalid', 1) > now ? 'pending' : null;
    }
    if (row.status === 'queued') return null;
    throw new Error('plugin_outbox_reference_state_invalid');
  }

  private async quarantine(row: PluginHookOutboxRow, now: number): Promise<void> {
    if (!row.claim_owner || !row.claim_token) throw new Error('plugin_outbox_quarantine_stale');
    const session = primary(this.db);
    const outboxStatement = session
      .prepare(
        `UPDATE plugin_hook_outbox
            SET status = 'dead_letter', claim_owner = NULL, claim_token = NULL,
                lease_until = NULL, next_attempt_at = NULL,
                last_error_code = 'plugin_outbox_payload_invalid',
                dead_lettered_at = ?, delete_after = ?, updated_at = ?
          WHERE outbox_id = ? AND tenant_id = ? AND status = 'locked'
            AND claim_owner = ? AND claim_token = ?`
      )
      .bind(
        now,
        now + DEAD_LETTER_RETENTION_SECONDS,
        now,
        row.outbox_id,
        row.tenant_id,
        row.claim_owner,
        row.claim_token
      );
    if (
      row.capability === 'notifier.send' &&
      row.event_type === 'notification.delivery.requested' &&
      Number(row.event_version) === 1
    ) {
      const results = await session.batch([
        session
          .prepare(
            `UPDATE notification_delivery_intents
                SET state = 'dead_letter', payload_key_id = NULL,
                    payload_envelope_json = NULL, dead_lettered_at = ?,
                    delivery_status = 'failed', delivery_status_updated_at = ?,
                    last_error_code = 'plugin_outbox_payload_invalid',
                    delete_after = ?, updated_at = ?
              WHERE tenant_id = ? AND idempotency_key = ?
                AND json_extract(
                      provider_installation_ids_json,
                      '$[' || active_provider_index || ']'
                    ) = ?
                AND state = 'pending'`
          )
          .bind(
            now,
            now,
            now + DEAD_LETTER_RETENTION_SECONDS,
            now,
            row.tenant_id,
            row.idempotency_key,
            row.plugin_installation_id
          ),
        outboxStatement,
      ]);
      if (
        results.some((result) => result.success !== true || result.error !== undefined) ||
        (results[0]?.meta.changes ?? 0) > 1 ||
        (results[1]?.meta.changes ?? 0) !== 1
      ) {
        throw new Error('plugin_outbox_quarantine_stale');
      }
      return;
    }
    const result = await outboxStatement.run();
    if (result.success !== true || result.error !== undefined || (result.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_outbox_quarantine_stale');
    }
  }
}

export interface PluginHookPolicyResolver {
  resolveDispatchPolicy(input: {
    tenantId: string;
    pluginInstallationId: string;
    capability: string;
  }): Promise<PluginDispatchPolicy>;
}

export class PluginHookOutboxDispatcher {
  constructor(
    private readonly store: PluginHookOutboxStore,
    private readonly backend: PluginHookBackend,
    private readonly policies: PluginHookPolicyResolver,
    private readonly limiter: PluginDispatchLimiter
  ) {}

  async processOne(input: {
    ownerId: string;
    now: number;
  }): Promise<'idle' | 'succeeded' | 'waiting_retry' | 'dead_letter'> {
    const claim = await this.store.claimNext(input);
    if (!claim) return 'idle';
    return this.processClaim(claim, input.now);
  }

  async processReference(input: {
    ownerId: string;
    now: number;
    outboxId: string;
    tenantId: string;
    pluginInstallationId: string;
    intentId: string;
  }): Promise<'delivered' | 'pending' | 'permanent_failure'> {
    const result = await this.store.claimReference(input);
    if (result.state !== 'claimed') return result.state;
    const processed = await this.processClaim(result.claim, input.now);
    if (processed === 'succeeded') return 'delivered';
    return processed === 'waiting_retry' ? 'pending' : 'permanent_failure';
  }

  private async processClaim(
    claim: ClaimedPluginHook,
    now: number
  ): Promise<'succeeded' | 'waiting_retry' | 'dead_letter'> {
    let policy: PluginDispatchPolicy;
    try {
      policy = await this.policies.resolveDispatchPolicy({
        tenantId: claim.invocation.tenantId,
        pluginInstallationId: claim.invocation.pluginInstallationId,
        capability: claim.invocation.capability,
      });
    } catch (error) {
      const permanent =
        error instanceof Error &&
        [
          'plugin_policy_unavailable',
          'plugin_policy_lookup_invalid',
          'plugin_policy_max_attempts_invalid',
          'plugin_policy_retry_budget_invalid',
          'plugin_policy_concurrency_invalid',
          'plugin_policy_rate_invalid',
        ].includes(error.message);
      return this.store.fail(claim, {
        now,
        errorCode: permanent ? 'plugin_policy_unavailable' : 'plugin_policy_lookup_failed',
        retryable: !permanent,
        maxAttempts: permanent ? 1 : 12,
        failureScope: permanent ? 'provider' : 'platform',
      });
    }
    if (claim.providerStartedAt + policy.retryBudgetSeconds <= now) {
      return this.store.fail(claim, {
        now,
        errorCode: 'plugin_retry_budget_exhausted',
        retryable: false,
        maxAttempts: policy.maxAttempts,
        failureScope: 'provider',
      });
    }
    let lease;
    try {
      lease = await this.limiter.acquire({
        installationId: claim.invocation.pluginInstallationId,
        tenantId: claim.invocation.tenantId,
        capability: claim.invocation.capability,
        concurrencyCap: policy.concurrencyCap,
        ratePerMinute: policy.ratePerMinute,
        now,
      });
    } catch {
      return this.store.fail(claim, {
        now,
        errorCode: 'plugin_dispatch_limiter_unavailable',
        retryable: true,
        maxAttempts: policy.maxAttempts,
        failureScope: 'platform',
      });
    }
    if (!lease) {
      return this.store.fail(claim, {
        now,
        errorCode: 'plugin_dispatch_limited',
        retryable: true,
        maxAttempts: policy.maxAttempts,
        failureScope: 'platform',
      });
    }
    try {
      try {
        await this.backend.invoke(claim.invocation);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';
        const retryable = errorMessage === 'plugin_hook_transient_failure';
        const providerScoped = retryable || errorMessage === 'plugin_hook_provider_rejected';
        const notificationErrorCodes = new Set([
          'plugin_notification_key_unavailable',
          'plugin_notification_key_unwrap_failed',
          'plugin_notification_payload_authentication_failed',
          'plugin_notification_decryption_failed',
          'plugin_notification_envelope_invalid',
          'plugin_notification_payload_invalid',
        ]);
        return this.store.fail(claim, {
          now,
          errorCode: retryable
            ? 'plugin_hook_transient_failure'
            : providerScoped
              ? 'plugin_hook_provider_rejected'
              : notificationErrorCodes.has(errorMessage)
                ? errorMessage
                : 'plugin_hook_rejected',
          retryable,
          maxAttempts: policy.maxAttempts,
          failureScope: providerScoped ? 'provider' : 'message',
        });
      }
      try {
        await this.store.succeed(claim, now);
      } catch {
        // The provider may have succeeded and the D1 response may have been lost. Preserve the
        // locked claim so lease takeover can adopt the intent's reflected delivered state.
        throw new Error('plugin_outbox_completion_failed');
      }
      return 'succeeded';
    } finally {
      try {
        await this.limiter.release(lease);
      } catch {
        // The bounded lease expires automatically; never overwrite a persisted dispatch outcome.
      }
    }
  }
}

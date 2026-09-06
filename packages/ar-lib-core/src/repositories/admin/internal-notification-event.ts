import type { DatabaseAdapter } from '../../db/adapter';

export const INTERNAL_NOTIFICATION_EVENT_CATEGORIES = [
  'identity_mapping_signal',
  'identity_mapping_manual_review',
  'identity_mapping_propagation_failure',
  'identity_mapping_bulk_impact',
  'storage_registry_security',
  'storage_registry_health',
  'tenant_database_stats',
  'tenant_database_health',
  'control_plane_drift',
  'logging_destination_health',
  'logging_delivery_failure',
  'logging_fallback_used',
  'logging_dlq_backlog',
  'logging_quota_warning',
  'logging_repair_job_status',
  'notification_delivery_failure',
] as const;

export type InternalNotificationEventCategory =
  (typeof INTERNAL_NOTIFICATION_EVENT_CATEGORIES)[number];

export type InternalNotificationEventSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type InternalNotificationDeliveryProvider =
  | 'internal_event'
  | 'webhook'
  | 'email'
  | 'slack'
  | 'custom';
export type InternalNotificationFailurePolicy =
  | 'best_effort'
  | 'retry_until_dead_letter'
  | 'fail_closed';
export type InternalNotificationPolicyScope = 'deployment' | 'profile' | 'tenant';

export type InternalNotificationEventStatus =
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'dead_letter'
  | 'suppressed';

export interface InternalNotificationRoutingPolicy {
  providers: InternalNotificationDeliveryProvider[];
  failurePolicy: InternalNotificationFailurePolicy;
  policyScope: InternalNotificationPolicyScope;
  allowProviderSuppression?: boolean;
}

export interface InternalNotificationEventInput {
  id?: string;
  tenantId: string;
  category: InternalNotificationEventCategory;
  eventType: string;
  severity: InternalNotificationEventSeverity;
  deduplicationKey?: string | null;
  payload: Record<string, unknown>;
  routingPolicy?: Partial<InternalNotificationRoutingPolicy> | null;
  reopenSuppressed?: boolean;
  now?: Date;
}

export interface InternalNotificationEventFailureOptions {
  maxAttempts: number;
  retryAfterSeconds?: number;
  now?: Date;
}

export interface InternalNotificationEventRow {
  id: string;
  tenant_id: string;
  category: InternalNotificationEventCategory;
  event_type: string;
  severity: InternalNotificationEventSeverity;
  status: InternalNotificationEventStatus;
  deduplication_key: string | null;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export function normalizeInternalNotificationRoutingPolicy(
  policy: Partial<InternalNotificationRoutingPolicy> | null | undefined
): InternalNotificationRoutingPolicy {
  const providers: InternalNotificationDeliveryProvider[] = policy?.providers?.length
    ? policy.providers
    : ['internal_event'];
  return {
    providers: Array.from(new Set(providers)),
    failurePolicy: policy?.failurePolicy ?? 'best_effort',
    policyScope: policy?.policyScope ?? 'deployment',
    allowProviderSuppression: policy?.allowProviderSuppression ?? false,
  };
}

export function resolveLoggingNotificationRoutingPolicy(input: {
  severity: InternalNotificationEventSeverity;
  externalNotificationEligible?: boolean;
}): InternalNotificationRoutingPolicy {
  if (input.externalNotificationEligible) {
    return {
      providers: ['internal_event', 'webhook', 'email'],
      failurePolicy: 'retry_until_dead_letter',
      policyScope: 'deployment',
      allowProviderSuppression: true,
    };
  }

  return normalizeInternalNotificationRoutingPolicy(null);
}

export class InternalNotificationEventRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async enqueue(input: InternalNotificationEventInput): Promise<InternalNotificationEventRow> {
    const id = input.id ?? crypto.randomUUID();
    const now = (input.now ?? new Date()).toISOString();
    const deduplicationKey = input.deduplicationKey ?? null;
    const payload = input.routingPolicy
      ? {
          ...input.payload,
          notification_routing_policy: normalizeInternalNotificationRoutingPolicy(
            input.routingPolicy
          ),
        }
      : input.payload;

    if (deduplicationKey) {
      const existing = await this.adapter.queryOne<InternalNotificationEventRow>(
        'SELECT * FROM internal_notification_events WHERE deduplication_key = ?',
        [deduplicationKey]
      );
      if (existing) {
        if (input.reopenSuppressed && existing.status === 'suppressed') {
          await this.adapter.execute(
            `UPDATE internal_notification_events
             SET status = 'pending',
                 severity = ?,
                 payload_json = ?,
                 attempts = 0,
                 last_error = NULL,
                 next_attempt_at = NULL,
                 delivered_at = NULL,
                 updated_at = ?
             WHERE id = ?
               AND status = 'suppressed'`,
            [input.severity, JSON.stringify(payload), now, existing.id]
          );
          const reopened = await this.adapter.queryOne<InternalNotificationEventRow>(
            'SELECT * FROM internal_notification_events WHERE id = ?',
            [existing.id]
          );
          if (!reopened) {
            throw new Error('internal_notification_event_reopen_failed');
          }
          return reopened;
        }
        return existing;
      }
    }

    await this.adapter.execute(
      `INSERT INTO internal_notification_events (
        id, tenant_id, category, event_type, severity, status, deduplication_key,
        payload_json, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)`,
      [
        id,
        input.tenantId,
        input.category,
        input.eventType,
        input.severity,
        deduplicationKey,
        JSON.stringify(payload),
        now,
        now,
      ]
    );

    const row = await this.adapter.queryOne<InternalNotificationEventRow>(
      deduplicationKey
        ? 'SELECT * FROM internal_notification_events WHERE deduplication_key = ?'
        : 'SELECT * FROM internal_notification_events WHERE id = ?',
      [deduplicationKey ?? id]
    );
    if (!row) {
      throw new Error('internal_notification_event_enqueue_failed');
    }
    return row;
  }

  async listPending(limit = 50, now: Date = new Date()): Promise<InternalNotificationEventRow[]> {
    return this.adapter.query<InternalNotificationEventRow>(
      `SELECT * FROM internal_notification_events
       WHERE status = 'pending'
          OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         created_at ASC
       LIMIT ?`,
      [now.toISOString(), limit]
    );
  }

  async markDelivered(id: string, now: Date = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    await this.adapter.execute(
      `UPDATE internal_notification_events
       SET status = 'delivered',
           updated_at = ?,
           delivered_at = ?,
           last_error = NULL,
           next_attempt_at = NULL
       WHERE id = ?`,
      [timestamp, timestamp, id]
    );
  }

  async suppressResolvedByDeduplicationKeys(
    deduplicationKeys: string[],
    now: Date = new Date()
  ): Promise<number> {
    const keys = Array.from(new Set(deduplicationKeys.filter(Boolean)));
    if (keys.length === 0) {
      return 0;
    }

    let suppressed = 0;
    const timestamp = now.toISOString();
    const batchSize = 50;
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      const batch = keys.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => '?').join(', ');
      const result = await this.adapter.execute(
        `UPDATE internal_notification_events
         SET status = 'suppressed',
             updated_at = ?,
             next_attempt_at = NULL
         WHERE deduplication_key IN (${placeholders})
           AND status IN ('pending', 'failed', 'dead_letter')`,
        [timestamp, ...batch]
      );
      suppressed += result.rowsAffected ?? 0;
    }
    return suppressed;
  }

  async markDeliveryFailure(
    id: string,
    error: string,
    options: InternalNotificationEventFailureOptions
  ): Promise<InternalNotificationEventStatus> {
    const now = options.now ?? new Date();
    const row = await this.adapter.queryOne<{ attempts: number }>(
      'SELECT attempts FROM internal_notification_events WHERE id = ?',
      [id]
    );
    const attempts = (row?.attempts ?? 0) + 1;
    const status: InternalNotificationEventStatus =
      attempts >= options.maxAttempts ? 'dead_letter' : 'failed';
    const nextAttemptAt =
      status === 'failed'
        ? new Date(now.getTime() + (options.retryAfterSeconds ?? 60) * 1000).toISOString()
        : null;

    await this.adapter.execute(
      `UPDATE internal_notification_events
       SET status = ?,
           attempts = ?,
           last_error = ?,
           next_attempt_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [status, attempts, error, nextAttemptAt, now.toISOString(), id]
    );
    return status;
  }
}

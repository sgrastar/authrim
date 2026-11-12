import { materializeAccountWebhookPayload } from './account-webhook-payload';
import {
  createEventDispatcherFromEnv,
  ensureDatabaseAdapter,
  resolveTenantDatabaseSourceFromRegistry,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  getSessionRevocationStore,
  createAuditLog,
  getTenantCapabilityState,
  type DatabaseAdapter,
  type Env,
  type EventPublishOptions,
  type EventPublishPayload,
} from '@authrim/ar-lib-core';
import type { GuestMaintenanceTarget } from './guest-lifecycle-scheduled';

export interface AccountWebhookRow {
  id: string;
  tenant_id: string;
  user_id: string;
  event_type: string;
  registration_state: 'guest' | 'registered';
  previous_registration_state: 'guest' | 'registered' | null;
  changed_field: string | null;
  occurred_at: number;
  attempts: number;
}

/**
 * Rows removed per shard per run while webhooks are off. Dropping needs no HTTP, so this is larger
 * than the delivery batch (20). The delete binds the tenant, the lease time and one id per row, and
 * D1 allows 100 bound parameters per statement, so 90 leaves room.
 */
export const DROP_BATCH_PER_SHARD = 90;

interface DroppedRow {
  id: string;
  event_type: string;
  occurred_at: number | string;
}

/** What is recorded when the outbox drops events because webhooks are off: counts and times only. */
export interface DroppedOutboxAuditEntry {
  tenantId: string;
  userId: string;
  action: 'webhook.outbox.dropped';
  resource: string;
  resourceId: string;
  ipAddress: string;
  userAgent: string;
  metadata: string;
  severity: 'warning';
}

function droppedAuditEntry(
  tenantId: string,
  rows: DroppedRow[],
  nowMs: number
): DroppedOutboxAuditEntry {
  const eventTypes: Record<string, number> = {};
  const times = rows.map((row) => Number(row.occurred_at));
  for (const row of rows) eventTypes[row.event_type] = (eventTypes[row.event_type] ?? 0) + 1;
  return {
    tenantId,
    userId: 'system',
    action: 'webhook.outbox.dropped',
    resource: 'account_webhook_outbox',
    resourceId: tenantId,
    ipAddress: 'unknown',
    userAgent: 'account-webhook-outbox',
    metadata: JSON.stringify({
      capability: 'webhooks',
      reason: 'capability_disabled',
      dropped: rows.length,
      event_types: eventTypes,
      oldest_occurred_at: Math.min(...times),
      newest_occurred_at: Math.max(...times),
      recorded_at: nowMs,
    }),
    severity: 'warning',
  };
}

type Publish = (payload: EventPublishPayload, options: EventPublishOptions) => Promise<boolean>;

/** Bounded, lease-fenced, at-least-once delivery. No PII or current user lookup in the payload. */
export async function processAccountWebhookOutbox(
  env: Env,
  targets: GuestMaintenanceTarget[],
  log: { warn(message: string, context?: Record<string, unknown>): void },
  options: {
    now?: () => number;
    snapshotAdapters?: (tenantId: string) => Promise<DatabaseAdapter[]>;
    publisher?: (tenantId: string) => Promise<Publish>;
    deletionReady?: (tenantId: string, userId: string) => Promise<boolean>;
    /** Records events dropped while webhooks are off (default: the audit log). */
    auditDropped?: (entry: DroppedOutboxAuditEntry) => Promise<void>;
  } = {}
): Promise<{ delivered: number; deferred: number; dropped?: number }> {
  const now = options.now ?? Date.now;
  const publisher =
    options.publisher ??
    (async (tenantId: string) => {
      // Subscriptions belong to the tenant default Core, not the account's data shard.
      const source = await resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId,
        role: 'tenant_core',
        shardGroup: 'default',
        shardIndex: 0,
      });
      const dispatcher = await createEventDispatcherFromEnv(env, {
        adapter: ensureDatabaseAdapter(source.source, 'account-webhook-subscriptions'),
        enableAuditLog: false,
      });
      return async (payload: EventPublishPayload, publishOptions: EventPublishOptions) =>
        (await dispatcher.publish(payload, publishOptions)).success;
    });
  const deletionReady =
    options.deletionReady ??
    (async (tenantId: string, userId: string) => {
      const state = await getSessionRevocationStore(env, tenantId, userId).getAccountStateRpc(
        tenantId,
        userId,
        `account:${userId}`
      );
      return state.lifecycle === 'deleted';
    });
  // The platform can turn webhooks off for tenants. While it is off, events that become due are
  // discarded as they are processed: the rows are removed (after the audit record), at most
  // DROP_BATCH_PER_SHARD per shard per run. Nothing is marked for later: a row still pending at the
  // moment the capability is turned back on (beyond that batch, or kept because the record could
  // not be written) is delivered then, like any pending row. An unreadable switch is not "off": the
  // rows are delivered as before.
  const capability = await getTenantCapabilityState(env, 'webhooks');
  if (capability === 'unknown') {
    log.warn('Tenant capability switch could not be read; treating the capability as enabled', {
      capability: 'webhooks',
    });
  }
  const webhooksOff = capability === 'off';
  let dropped = 0;
  let delivered = 0;
  let deferred = 0;
  if (webhooksOff) {
    const audit = options.auditDropped ?? ((entry) => createAuditLog(env, entry));
    for (const target of targets) {
      // 1. Find what is due, on every shard of the tenant.
      const due: Array<{ adapter: DatabaseAdapter; rows: DroppedRow[] }> = [];
      for (const { adapter, bindingRef } of target.adapters) {
        try {
          const rows = await adapter.query<DroppedRow>(
            `SELECT id, event_type, occurred_at FROM account_webhook_outbox
             WHERE tenant_id = ? AND delivered_at IS NULL
             AND next_attempt_at <= ? AND lease_until <= ? ORDER BY occurred_at, id LIMIT ${DROP_BATCH_PER_SHARD}`,
            [target.tenantId, now(), now()],
            { consistencyClass: 'primary_required' }
          );
          if (rows.length > 0) due.push({ adapter, rows });
        } catch {
          log.warn('Account webhook reconciliation deferred', {
            tenantId: target.tenantId,
            bindingRef,
          });
        }
      }
      const rows = due.flatMap((entry) => entry.rows);
      if (rows.length > 0) {
        // 2. The record comes first. If it cannot be written, nothing is removed: the rows stay
        //    and the next run tries again, so no event is ever lost without a record. (If a delete
        //    then fails after the record was written, the next run records those rows again: a
        //    duplicate record, never a missing one. The stores are separate databases, so one
        //    transaction across the audit log and the outbox is not available.)
        try {
          await audit(droppedAuditEntry(target.tenantId, rows, now()));
        } catch {
          log.warn('Account webhook outbox rows kept: the drop could not be recorded', {
            tenantId: target.tenantId,
            pending: rows.length,
          });
          continue;
        }
        // 3. Remove them.
        for (const { adapter, rows: shardRows } of due) {
          try {
            const removed = await adapter.execute(
              `DELETE FROM account_webhook_outbox WHERE tenant_id = ? AND delivered_at IS NULL
               AND lease_until <= ? AND id IN (${shardRows.map(() => '?').join(', ')})`,
              [target.tenantId, now(), ...shardRows.map((row) => row.id)]
            );
            dropped += removed.rowsAffected ?? 0;
          } catch {
            log.warn('Account webhook reconciliation deferred', { tenantId: target.tenantId });
          }
        }
      }
      for (const { adapter } of target.adapters) {
        try {
          await adapter.execute(
            'DELETE FROM account_webhook_outbox WHERE tenant_id = ? AND delivered_at < ?',
            [target.tenantId, now() - 30 * 86400_000]
          );
        } catch {
          log.warn('Account webhook cleanup deferred', { tenantId: target.tenantId });
        }
      }
    }
    if (dropped > 0) {
      log.warn('Account webhook outbox rows dropped: webhooks are turned off for tenants', {
        dropped,
      });
    }
    return { delivered: 0, deferred: 0, dropped };
  }
  for (const target of targets) {
    let publish: Publish | undefined;
    for (const { adapter, bindingRef } of target.adapters) {
      try {
        const rows = await adapter.query<AccountWebhookRow>(
          `SELECT * FROM account_webhook_outbox WHERE tenant_id = ? AND delivered_at IS NULL
           AND next_attempt_at <= ? AND lease_until <= ? ORDER BY occurred_at, id LIMIT 20`,
          [target.tenantId, now(), now()],
          { consistencyClass: 'primary_required' }
        );
        for (const row of rows) {
          const lease = crypto.randomUUID();
          const claimed = await adapter.execute(
            `UPDATE account_webhook_outbox SET lease_token = ?, lease_until = ?, attempts = attempts + 1
             WHERE tenant_id = ? AND id = ? AND delivered_at IS NULL AND lease_until <= ? AND next_attempt_at <= ?`,
            [lease, now() + 15 * 60_000, target.tenantId, row.id, now(), now()]
          );
          if (claimed.rowsAffected !== 1) continue;
          try {
            if (row.tenant_id !== target.tenantId)
              throw new Error('account_webhook_tenant_mismatch');
            if (row.event_type.endsWith('.deleted')) {
              const guest = await adapter.queryOne<{ phase: string }>(
                'SELECT phase FROM guest_account_lifecycle WHERE tenant_id = ? AND user_id = ?',
                [target.tenantId, row.user_id],
                { consistencyClass: 'primary_required' }
              );
              if (
                guest?.phase === 'deleting' ||
                !(await deletionReady(target.tenantId, row.user_id))
              ) {
                throw new Error('account_webhook_deletion_not_committed');
              }
            }
            publish ??= await publisher(target.tenantId);
            const success = await publish(
              {
                type: row.event_type,
                tenantId: target.tenantId,
                data: {
                  userId: row.user_id,
                  registration_state: row.registration_state,
                  previous_registration_state: row.previous_registration_state,
                  changed_fields: row.changed_field ? [row.changed_field] : [],
                },
                metadata: { source: 'account-webhook-outbox' },
              },
              {
                accountWebhookData: async (webhook) =>
                  materializeAccountWebhookPayload({
                    tenantId: target.tenantId,
                    eventId: row.id,
                    occurredAt: Number(row.occurred_at),
                    eventType: row.event_type,
                    userId: row.user_id,
                    webhook,
                    now: now(),
                    data: {
                      userId: row.user_id,
                      registration_state: row.registration_state,
                      previous_registration_state: row.previous_registration_state,
                      changed_fields: row.changed_field ? [row.changed_field] : [],
                    },
                    adapters: async () => {
                      if (!options.snapshotAdapters)
                        throw new Error('account_webhook_pii_unavailable');
                      return options.snapshotAdapters(target.tenantId);
                    },
                  }),
                durableEvent: { id: row.id, occurredAt: Number(row.occurred_at) },
                skipInternalHandlers: true,
                skipAuditLog: true,
              }
            );
            if (!success) throw new Error('account_webhook_delivery_failed');
            await adapter.execute(
              `UPDATE account_webhook_outbox SET delivered_at = ?, lease_token = NULL, lease_until = 0
               WHERE tenant_id = ? AND id = ? AND lease_token = ?`,
              [now(), target.tenantId, row.id, lease]
            );
            delivered += 1;
          } catch {
            await releaseForRetry(adapter, target.tenantId, row, lease, now());
            deferred += 1;
          }
        }
        await adapter.execute(
          'DELETE FROM account_webhook_outbox WHERE tenant_id = ? AND delivered_at < ?',
          [target.tenantId, now() - 30 * 86400_000]
        );
      } catch {
        log.warn('Account webhook reconciliation deferred', {
          tenantId: target.tenantId,
          bindingRef,
        });
      }
    }
  }
  return { delivered, deferred };
}

async function releaseForRetry(
  adapter: DatabaseAdapter,
  tenantId: string,
  row: AccountWebhookRow,
  lease: string,
  now: number
) {
  await adapter.execute(
    `UPDATE account_webhook_outbox SET next_attempt_at = ?, lease_token = NULL, lease_until = 0
     WHERE tenant_id = ? AND id = ? AND lease_token = ?`,
    [now + Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7)), tenantId, row.id, lease]
  );
}

/** Scan PII outboxes too: their events commit atomically with PII-only custom-profile writes. */
export async function processScheduledAccountWebhookOutbox(
  env: Env,
  targets: GuestMaintenanceTarget[],
  log: { warn(message: string, context?: Record<string, unknown>): void },
  options: Parameters<typeof processAccountWebhookOutbox>[3] & {
    resolvePii?: (tenantId: string) => Promise<GuestMaintenanceTarget['adapters']>;
  } = {}
) {
  const resolvePii =
    options.resolvePii ??
    (async (tenantId: string) => {
      const sources = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
        tenantId,
        role: 'tenant_pii',
        maxStores: 32,
        concurrency: 4,
      });
      return sources.map((source) => ({
        bindingRef: source.bindingRef,
        adapter: ensureDatabaseAdapter(source.source, `account-webhook-pii:${source.bindingRef}`),
      }));
    });
  const result = { delivered: 0, deferred: 0 };
  for (const target of targets) {
    const adapters = [...target.adapters];
    let piiAdapters: DatabaseAdapter[] | undefined;
    try {
      const known = new Set(adapters.map((store) => store.bindingRef));
      const piiStores = await resolvePii(target.tenantId);
      piiAdapters = piiStores.map((store) => store.adapter);
      for (const store of piiStores) {
        if (!known.has(store.bindingRef)) {
          adapters.push(store);
          known.add(store.bindingRef);
        }
        try {
          await store.adapter.execute(
            `UPDATE account_webhook_snapshots SET email_before_json = NULL, email_after_json = NULL
           WHERE tenant_id = ? AND expires_at <= ? AND
           (email_before_json IS NOT NULL OR email_after_json IS NOT NULL)`,
            [target.tenantId, (options.now ?? Date.now)()]
          );
        } catch {
          // Payload materialization independently enforces expiry. A cleanup failure must not
          // suppress this shard's outbox or prevent discovery of the remaining PII outboxes.
          log.warn('Account webhook snapshot cleanup deferred', {
            tenantId: target.tenantId,
            bindingRef: store.bindingRef,
          });
        }
      }
    } catch {
      log.warn('Account webhook PII shard resolution deferred', { tenantId: target.tenantId });
    }
    const page = await processAccountWebhookOutbox(env, [{ ...target, adapters }], log, {
      ...options,
      snapshotAdapters:
        options.snapshotAdapters ??
        (async () => {
          if (!piiAdapters) throw new Error('account_webhook_pii_unavailable');
          return piiAdapters;
        }),
    });
    result.delivered += page.delivered;
    result.deferred += page.deferred;
  }
  return result;
}

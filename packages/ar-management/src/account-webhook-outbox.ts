import { materializeAccountWebhookPayload } from './account-webhook-payload';
import {
  createEventDispatcherFromEnv,
  ensureDatabaseAdapter,
  resolveTenantDatabaseSourceFromRegistry,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  getSessionRevocationStore,
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
  } = {}
): Promise<{ delivered: number; deferred: number }> {
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
  let delivered = 0;
  let deferred = 0;
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

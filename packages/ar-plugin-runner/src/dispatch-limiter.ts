import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const SAFE_HOST = /^(?:|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/u;
// The lease must cover the maximum 30-second plugin timeout plus D1 bookkeeping latency.
const LEASE_SECONDS = 60;

export interface PluginDispatchPolicy {
  pluginId: string;
  maxAttempts: number;
  retryBudgetSeconds: number;
  concurrencyCap: number;
  ratePerMinute: number;
}

export interface PluginDispatchLease {
  leaseId: string;
  installationId: string;
  tenantId: string;
  capability: string;
  destinationHost: string;
}

export interface PluginDispatchLimiter {
  acquire(input: {
    installationId: string;
    tenantId: string;
    capability: string;
    destinationHost?: string;
    concurrencyCap: number;
    ratePerMinute: number;
    now: number;
  }): Promise<PluginDispatchLease | null>;
  release(lease: PluginDispatchLease): Promise<void>;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_dispatch_limiter_d1_session_required');
  }
  return db.withSession('first-primary');
}

function validate(input: {
  installationId: string;
  tenantId: string;
  capability: string;
  destinationHost: string;
  concurrencyCap: number;
  ratePerMinute: number;
  now: number;
}): void {
  if (
    !SAFE_ID.test(input.installationId) ||
    !SAFE_ID.test(input.tenantId) ||
    !SAFE_CAPABILITY.test(input.capability) ||
    !SAFE_HOST.test(input.destinationHost) ||
    !Number.isSafeInteger(input.concurrencyCap) ||
    input.concurrencyCap < 1 ||
    input.concurrencyCap > 32 ||
    !Number.isSafeInteger(input.ratePerMinute) ||
    input.ratePerMinute < 1 ||
    input.ratePerMinute > 10_000 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 1
  ) {
    throw new Error('plugin_dispatch_limiter_input_invalid');
  }
}

export class D1PluginDispatchLimiter implements PluginDispatchLimiter {
  constructor(private readonly db: D1Database) {}

  async acquire(input: {
    installationId: string;
    tenantId: string;
    capability: string;
    destinationHost?: string;
    concurrencyCap: number;
    ratePerMinute: number;
    now: number;
  }): Promise<PluginDispatchLease | null> {
    const normalized = { ...input, destinationHost: input.destinationHost ?? '' };
    validate(normalized);
    const session = primary(this.db);
    await session
      .prepare(
        `DELETE FROM plugin_runner_dispatch_leases
          WHERE installation_id = ? AND tenant_id = ? AND capability = ?
            AND destination_host = ? AND lease_expires_at <= ?`
      )
      .bind(
        normalized.installationId,
        normalized.tenantId,
        normalized.capability,
        normalized.destinationHost,
        normalized.now
      )
      .run();
    const lease: PluginDispatchLease = {
      leaseId: `dispatch-${crypto.randomUUID()}`,
      installationId: normalized.installationId,
      tenantId: normalized.tenantId,
      capability: normalized.capability,
      destinationHost: normalized.destinationHost,
    };
    const inserted = await session
      .prepare(
        `INSERT INTO plugin_runner_dispatch_leases (
           lease_id, installation_id, tenant_id, capability, destination_host,
           lease_expires_at, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE (
            SELECT COUNT(*) FROM plugin_runner_dispatch_leases
             WHERE installation_id = ? AND tenant_id = ? AND capability = ?
               AND destination_host = ? AND lease_expires_at > ?
          ) < ?
           AND EXISTS (
             SELECT 1 FROM plugin_runner_installations
              WHERE installation_id = ? AND tenant_id = ? AND state = 'enabled'
           )`
      )
      .bind(
        lease.leaseId,
        lease.installationId,
        lease.tenantId,
        lease.capability,
        lease.destinationHost,
        normalized.now + LEASE_SECONDS,
        normalized.now,
        lease.installationId,
        lease.tenantId,
        lease.capability,
        lease.destinationHost,
        normalized.now,
        normalized.concurrencyCap,
        lease.installationId,
        lease.tenantId
      )
      .run();
    if ((inserted.meta.changes ?? 0) !== 1) return null;

    const windowStartedAt = Math.floor(normalized.now / 60) * 60;
    const rate = await session
      .prepare(
        `INSERT INTO plugin_runner_rate_limit_buckets (
           installation_id, tenant_id, capability, destination_host,
           window_started_at, used_count, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(installation_id, tenant_id, capability, destination_host) DO UPDATE SET
           window_started_at = CASE
             WHEN plugin_runner_rate_limit_buckets.window_started_at = excluded.window_started_at
               THEN plugin_runner_rate_limit_buckets.window_started_at
             ELSE excluded.window_started_at
           END,
           used_count = CASE
             WHEN plugin_runner_rate_limit_buckets.window_started_at = excluded.window_started_at
               THEN plugin_runner_rate_limit_buckets.used_count + 1
             ELSE 1
           END,
           updated_at = excluded.updated_at
         WHERE plugin_runner_rate_limit_buckets.window_started_at <> excluded.window_started_at
            OR plugin_runner_rate_limit_buckets.used_count < ?`
      )
      .bind(
        lease.installationId,
        lease.tenantId,
        lease.capability,
        lease.destinationHost,
        windowStartedAt,
        normalized.now,
        normalized.ratePerMinute
      )
      .run();
    if ((rate.meta.changes ?? 0) === 1) return lease;
    await this.release(lease);
    return null;
  }

  async release(lease: PluginDispatchLease): Promise<void> {
    const result = await primary(this.db)
      .prepare(
        `DELETE FROM plugin_runner_dispatch_leases
          WHERE lease_id = ? AND installation_id = ? AND tenant_id = ?
            AND capability = ? AND destination_host = ?`
      )
      .bind(
        lease.leaseId,
        lease.installationId,
        lease.tenantId,
        lease.capability,
        lease.destinationHost
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_dispatch_lease_release_stale');
  }
}

/**
 * Admin Notice Delivery Repository
 *
 * Email and Slack delivery of admin notices: each admin's email preferences, the Slack channels
 * registered for the platform or a tenant, and the delivery rows the every-minute job sends.
 *
 * A notice is planned once: its delivery rows are written, then the notice is marked, so a notice
 * is never marked without its rows and a rerun only adds what is missing. A delivery is claimed with a lease
 * before it is sent, so two runs never send the same one.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';
import type { AdminNoticeSeverity } from './admin-notice';

export type AdminNoticeDeliveryChannel = 'email' | 'slack';
export type AdminNoticeDeliveryStatus = 'queued' | 'sent' | 'failed' | 'dead_letter' | 'skipped';

/** What an admin gets by email when they never chose: high and above. */
export const ADMIN_NOTICE_EMAIL_DEFAULTS = {
  email_enabled: true,
  email_min_severity: 'high' as AdminNoticeSeverity,
};

export interface AdminNoticePreferences {
  email_enabled: boolean;
  email_min_severity: AdminNoticeSeverity;
  updated_at: number | null;
}

export interface AdminNoticeChannel {
  id: string;
  scope_type: 'platform' | 'tenant';
  tenant_id: string | null;
  kind: 'slack';
  name: string;
  webhook_url_hint: string;
  min_severity: AdminNoticeSeverity;
  enabled: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** A channel with its encrypted URL, for the sender only. */
export interface AdminNoticeChannelSecret extends AdminNoticeChannel {
  webhook_url_encrypted: string;
}

export interface AdminNoticeDelivery {
  id: string;
  notice_id: string;
  channel: AdminNoticeDeliveryChannel;
  target_id: string;
  status: AdminNoticeDeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AdminNoticeChannelInput {
  scope_type: 'platform' | 'tenant';
  tenant_id: string | null;
  name: string;
  webhook_url_encrypted: string;
  webhook_url_hint: string;
  min_severity: AdminNoticeSeverity;
  enabled: boolean;
  created_by: string | null;
}

/** Delivery rows written per batch while planning. */
const PLAN_BATCH = 50;

export class AdminNoticeDeliveryRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  // -------------------------------------------------------------------------------------------
  // Preferences

  async getPreferences(adminUserId: string): Promise<AdminNoticePreferences> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_notice_preferences WHERE admin_user_id = ?',
      [adminUserId]
    );
    return row
      ? {
          email_enabled: Number(row.email_enabled) === 1,
          email_min_severity: row.email_min_severity as AdminNoticeSeverity,
          updated_at: Number(row.updated_at),
        }
      : { ...ADMIN_NOTICE_EMAIL_DEFAULTS, updated_at: null };
  }

  async setPreferences(
    adminUserId: string,
    input: { email_enabled: boolean; email_min_severity: AdminNoticeSeverity },
    now: number = getCurrentTimestamp()
  ): Promise<AdminNoticePreferences> {
    await this.adapter.execute(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(admin_user_id) DO UPDATE SET email_enabled = excluded.email_enabled,
         email_min_severity = excluded.email_min_severity, updated_at = excluded.updated_at`,
      [adminUserId, input.email_enabled ? 1 : 0, input.email_min_severity, now]
    );
    return { ...input, updated_at: now };
  }

  /** The preferences of these admins; admins without a row are left out (they have defaults). */
  async preferencesOf(adminUserIds: string[]): Promise<Map<string, AdminNoticePreferences>> {
    const result = new Map<string, AdminNoticePreferences>();
    for (let offset = 0; offset < adminUserIds.length; offset += 50) {
      const batch = adminUserIds.slice(offset, offset + 50);
      const rows = await this.adapter.query<Record<string, unknown>>(
        `SELECT * FROM admin_notice_preferences
          WHERE admin_user_id IN (${batch.map(() => '?').join(', ')})`,
        batch
      );
      for (const row of rows) {
        result.set(String(row.admin_user_id), {
          email_enabled: Number(row.email_enabled) === 1,
          email_min_severity: row.email_min_severity as AdminNoticeSeverity,
          updated_at: Number(row.updated_at),
        });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Channels

  async listChannels(scope: {
    tenantId: string | null;
    platform: boolean;
  }): Promise<AdminNoticeChannel[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (scope.platform) conditions.push(`scope_type = 'platform'`);
    if (scope.tenantId) {
      conditions.push(`(scope_type = 'tenant' AND tenant_id = ?)`);
      params.push(scope.tenantId);
    }
    if (conditions.length === 0) return [];
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_notice_channels WHERE ${conditions.join(' OR ')}
        ORDER BY scope_type, name, id`,
      params
    );
    return rows.map((row) => publicChannel(rowToChannel(row)));
  }

  async findChannel(id: string): Promise<AdminNoticeChannelSecret | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_notice_channels WHERE id = ?',
      [id]
    );
    return row ? rowToChannel(row) : null;
  }

  /** The enabled channels a notice of this audience and severity goes to. */
  async channelsFor(
    audience: { scope: 'platform' } | { scope: 'tenant'; tenantId: string },
    severity: AdminNoticeSeverity
  ): Promise<AdminNoticeChannelSecret[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      audience.scope === 'platform'
        ? `SELECT * FROM admin_notice_channels WHERE scope_type = 'platform' AND enabled = 1`
        : `SELECT * FROM admin_notice_channels
            WHERE scope_type = 'tenant' AND tenant_id = ? AND enabled = 1`,
      audience.scope === 'platform' ? [] : [audience.tenantId]
    );
    return rows
      .map(rowToChannel)
      .filter((channel) => severityReaches(severity, channel.min_severity));
  }

  async createChannel(
    input: AdminNoticeChannelInput,
    now: number = getCurrentTimestamp()
  ): Promise<AdminNoticeChannel> {
    const id = generateId();
    await this.adapter.execute(
      `INSERT INTO admin_notice_channels (id, scope_type, tenant_id, kind, name,
         webhook_url_encrypted, webhook_url_hint, min_severity, enabled, created_by, created_at,
         updated_at) VALUES (?, ?, ?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scope_type,
        input.scope_type === 'platform' ? null : input.tenant_id,
        input.name,
        input.webhook_url_encrypted,
        input.webhook_url_hint,
        input.min_severity,
        input.enabled ? 1 : 0,
        input.created_by,
        now,
        now,
      ]
    );
    const created = await this.findChannel(id);
    if (!created) throw new Error('admin_notice_channel_create_failed');
    return publicChannel(created);
  }

  async updateChannel(
    id: string,
    input: Partial<
      Pick<
        AdminNoticeChannelSecret,
        'name' | 'min_severity' | 'enabled' | 'webhook_url_encrypted' | 'webhook_url_hint'
      >
    >,
    now: number = getCurrentTimestamp()
  ): Promise<AdminNoticeChannel | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of [
      'name',
      'min_severity',
      'webhook_url_encrypted',
      'webhook_url_hint',
    ] as const) {
      if (input[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(input[key]);
      }
    }
    if (input.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(input.enabled ? 1 : 0);
    }
    sets.push('updated_at = ?');
    params.push(now, id);
    await this.adapter.execute(
      `UPDATE admin_notice_channels SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
    const updated = await this.findChannel(id);
    return updated ? publicChannel(updated) : null;
  }

  /** Delete a channel and what was still to be sent to it. */
  async deleteChannel(id: string): Promise<boolean> {
    const [, deleted] = await this.adapter.batch([
      {
        sql: `DELETE FROM admin_notice_deliveries
               WHERE channel = 'slack' AND target_id = ? AND status IN ('queued', 'failed')`,
        params: [id],
      },
      { sql: 'DELETE FROM admin_notice_channels WHERE id = ?', params: [id] },
    ]);
    return (deleted?.rowsAffected ?? 0) > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Planning

  /** Notices not planned yet, oldest first. */
  async listUnplanned(limit: number): Promise<Array<{ id: string }>> {
    return this.adapter.query<{ id: string }>(
      `SELECT id FROM admin_notices WHERE delivery_planned_at IS NULL
        ORDER BY created_at, id LIMIT ?`,
      [limit]
    );
  }

  /**
   * Write a notice's delivery rows, then mark it planned. Nothing is written once another run
   * marked it.
   *
   * @returns Whether this call planned it
   */
  async plan(
    noticeId: string,
    targets: Array<{ channel: AdminNoticeDeliveryChannel; target_id: string }>,
    now: number = getCurrentTimestamp()
  ): Promise<boolean> {
    const unplanned = `EXISTS (SELECT 1 FROM admin_notices
        WHERE id = ? AND delivery_planned_at IS NULL)`;
    // Rows go in a batch at a time while the notice is unplanned (a rerun adds only what is
    // missing), and the notice is marked last: it is never marked without its rows.
    for (let offset = 0; offset < targets.length; offset += PLAN_BATCH) {
      await this.adapter.batch(
        targets.slice(offset, offset + PLAN_BATCH).map((target) => ({
          sql: `INSERT INTO admin_notice_deliveries (id, notice_id, channel, target_id, status,
                  attempts, next_attempt_at, created_at, updated_at)
                SELECT ?, ?, ?, ?, 'queued', 0, ?, ?, ? WHERE ${unplanned}
                ON CONFLICT DO NOTHING`,
          params: [
            generateId(),
            noticeId,
            target.channel,
            target.target_id,
            now,
            now,
            now,
            noticeId,
          ],
        }))
      );
    }
    const marked = await this.adapter.execute(
      `UPDATE admin_notices SET delivery_planned_at = ?
        WHERE id = ? AND delivery_planned_at IS NULL`,
      [now, noticeId]
    );
    return (marked.rowsAffected ?? 0) > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Sending

  /** Lease up to `limit` due deliveries to this run. */
  async claimDue(
    now: number,
    limit: number,
    leaseMs: number,
    leaseToken: string
  ): Promise<AdminNoticeDelivery[]> {
    await this.adapter.execute(
      `UPDATE admin_notice_deliveries
          SET lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id IN (
          SELECT id FROM admin_notice_deliveries
           WHERE status IN ('queued', 'failed') AND next_attempt_at <= ?
             AND (lease_until IS NULL OR lease_until <= ?)
           ORDER BY next_attempt_at, id LIMIT ?
        )`,
      [leaseToken, now + leaseMs, now, now, now, limit]
    );
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_notice_deliveries WHERE lease_token = ? AND lease_until > ?
        ORDER BY next_attempt_at, id`,
      [leaseToken, now]
    );
    return rows.map(rowToDelivery);
  }

  /** Extend a lease this run still holds; false when it ran out and may be another run's. */
  async renewLease(id: string, leaseToken: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE admin_notice_deliveries SET lease_until = ?
        WHERE id = ? AND lease_token = ? AND lease_until > ?`,
      [now + leaseMs, id, leaseToken, now]
    );
    return (result.rowsAffected ?? 0) > 0;
  }

  /** Record how a leased delivery went; ignored when the lease was lost. */
  async finish(
    id: string,
    leaseToken: string,
    outcome:
      | { status: 'sent' | 'skipped' | 'dead_letter'; error?: string | null }
      | { status: 'failed'; error: string; nextAttemptAt: number },
    now: number = getCurrentTimestamp()
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE admin_notice_deliveries
          SET status = ?, last_error = ?, next_attempt_at = ?, lease_token = NULL,
              lease_until = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ?`,
      [
        outcome.status,
        outcome.error ? outcome.error.slice(0, 500) : null,
        outcome.status === 'failed' ? outcome.nextAttemptAt : now,
        now,
        id,
        leaseToken,
      ]
    );
    return (result.rowsAffected ?? 0) > 0;
  }

  /** A page of a notice's deliveries in id order, after `after` when given. */
  async listForNotice(
    noticeId: string,
    options: { after?: string | null; limit?: number } = {}
  ): Promise<{ items: AdminNoticeDelivery[]; next: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_notice_deliveries
        WHERE notice_id = ? AND (? IS NULL OR id > ?)
        ORDER BY id LIMIT ?`,
      [noticeId, options.after ?? null, options.after ?? null, limit + 1]
    );
    const items = rows.slice(0, limit).map(rowToDelivery);
    return { items, next: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null };
  }

  /** How many of a notice's deliveries are in each channel and status. */
  async summaryForNotice(
    noticeId: string
  ): Promise<
    Array<{ channel: AdminNoticeDeliveryChannel; status: AdminNoticeDeliveryStatus; count: number }>
  > {
    const rows = await this.adapter.query<{ channel: string; status: string; count: number }>(
      `SELECT channel, status, COUNT(*) AS count FROM admin_notice_deliveries
        WHERE notice_id = ? GROUP BY channel, status ORDER BY channel, status`,
      [noticeId]
    );
    return rows.map((row) => ({
      channel: row.channel === 'slack' ? 'slack' : 'email',
      status: row.status as AdminNoticeDeliveryStatus,
      count: Number(row.count),
    }));
  }
}

const SEVERITY_RANK: Record<AdminNoticeSeverity, number> = {
  critical: 0,
  high: 1,
  caution: 2,
  info: 3,
};

/** Whether a notice of `severity` is at least as urgent as `minimum`. */
export function severityReaches(
  severity: AdminNoticeSeverity,
  minimum: AdminNoticeSeverity
): boolean {
  return (SEVERITY_RANK[severity] ?? 3) <= (SEVERITY_RANK[minimum] ?? 1);
}

function rowToChannel(row: Record<string, unknown>): AdminNoticeChannelSecret {
  return {
    id: String(row.id),
    scope_type: row.scope_type === 'platform' ? 'platform' : 'tenant',
    tenant_id: typeof row.tenant_id === 'string' ? row.tenant_id : null,
    kind: 'slack',
    name: String(row.name),
    webhook_url_encrypted: String(row.webhook_url_encrypted),
    webhook_url_hint: String(row.webhook_url_hint),
    min_severity: row.min_severity as AdminNoticeSeverity,
    enabled: Number(row.enabled) === 1,
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function publicChannel(channel: AdminNoticeChannelSecret): AdminNoticeChannel {
  const { webhook_url_encrypted: _secret, ...rest } = channel;
  return rest;
}

function rowToDelivery(row: Record<string, unknown>): AdminNoticeDelivery {
  return {
    id: String(row.id),
    notice_id: String(row.notice_id),
    channel: row.channel === 'slack' ? 'slack' : 'email',
    target_id: String(row.target_id),
    status: row.status as AdminNoticeDeliveryStatus,
    attempts: Number(row.attempts),
    next_attempt_at: Number(row.next_attempt_at),
    lease_token: typeof row.lease_token === 'string' ? row.lease_token : null,
    last_error: typeof row.last_error === 'string' ? row.last_error : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

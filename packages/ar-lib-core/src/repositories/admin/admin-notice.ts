/**
 * Admin Notice Repository
 *
 * The notices of the admin console's header. Each is addressed to one audience (the platform's
 * admins, a tenant's admins, the admins who can read a client, or one admin) and is raised by the
 * system or written by an admin as an announcement.
 *
 * Information is put away by each admin for themselves (a dismissal row); everything else is
 * resolved once, by an admin or by the system when its cause goes away, and then leaves everyone's
 * list. One open notice per deduplication key: raising it again while open changes nothing.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

export const ADMIN_NOTICE_SCOPES = ['platform', 'tenant', 'client', 'admin_user'] as const;
export type AdminNoticeScope = (typeof ADMIN_NOTICE_SCOPES)[number];

/** Most urgent first. */
export const ADMIN_NOTICE_SEVERITIES = ['critical', 'high', 'caution', 'info'] as const;
export type AdminNoticeSeverity = (typeof ADMIN_NOTICE_SEVERITIES)[number];

export type AdminNoticeSource = 'system' | 'announcement';

/** The most notices one list returns. */
export const ADMIN_NOTICE_LIST_LIMIT = 100;

export interface AdminNotice {
  id: string;
  scope_type: AdminNoticeScope;
  tenant_id: string | null;
  client_id: string | null;
  admin_user_id: string | null;
  severity: AdminNoticeSeverity;
  source: AdminNoticeSource;
  category: string;
  message_key: string | null;
  params: Record<string, unknown>;
  title: string;
  body: string | null;
  link: string | null;
  required_permission: string | null;
  source_ref: string | null;
  deduplication_key: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

export interface AdminNoticeInput {
  scope_type: AdminNoticeScope;
  tenant_id?: string | null;
  client_id?: string | null;
  admin_user_id?: string | null;
  severity: AdminNoticeSeverity;
  source: AdminNoticeSource;
  category: string;
  message_key?: string | null;
  params?: Record<string, unknown> | null;
  title: string;
  body?: string | null;
  link?: string | null;
  required_permission?: string | null;
  source_ref?: string | null;
  deduplication_key?: string | null;
  created_by?: string | null;
  expires_at?: number | null;
}

/** Whom the list is for: the admin, the tenant they are looking at, what they may see. */
export interface AdminNoticeViewer {
  adminUserId: string;
  /** The tenant selected in the console; null shows no tenant or client notices. */
  tenantId: string | null;
  platform: boolean;
  /** Whether the viewer may read the tenant's clients (client notices). */
  canReadClients: boolean;
  /** Whether the viewer holds a notice's required permission. */
  holds: (permission: string) => boolean;
}

export type AdminNoticeResolveResult =
  | { resolved: true; notice: AdminNotice }
  | { resolved: false; reason: 'not_found' | 'already_resolved' };

const OPEN_SQL = 'n.resolved_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?)';

const INSERT_COLUMNS = [
  'id',
  'scope_type',
  'tenant_id',
  'client_id',
  'admin_user_id',
  'severity',
  'source',
  'category',
  'message_key',
  'params_json',
  'title',
  'body',
  'link',
  'required_permission',
  'source_ref',
  'deduplication_key',
  'created_by',
  'created_at',
  'expires_at',
].join(',');

function insertParams(id: string, input: AdminNoticeInput, now: number): unknown[] {
  return [
    id,
    input.scope_type,
    input.scope_type === 'platform' ? null : (input.tenant_id ?? null),
    input.scope_type === 'client' ? (input.client_id ?? null) : null,
    input.scope_type === 'admin_user' ? (input.admin_user_id ?? null) : null,
    input.severity,
    input.source,
    input.category,
    input.message_key ?? null,
    input.params ? JSON.stringify(input.params) : null,
    input.title,
    input.body ?? null,
    input.link ?? null,
    input.required_permission ?? null,
    input.source_ref ?? null,
    input.deduplication_key ?? null,
    input.created_by ?? null,
    now,
    input.expires_at ?? null,
  ];
}

export class AdminNoticeRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  /**
   * Raise a notice. With a deduplication key an open notice of the same key is kept as it is and
   * returned instead.
   */
  async create(input: AdminNoticeInput, now: number = getCurrentTimestamp()): Promise<AdminNotice> {
    const id = generateId();
    await this.adapter.execute(
      `INSERT INTO admin_notices (${INSERT_COLUMNS}) VALUES (${INSERT_COLUMNS.split(',')
        .map(() => '?')
        .join(', ')})
        ON CONFLICT DO NOTHING`,
      insertParams(id, input, now)
    );
    const row = await this.findCreated(id, input);
    if (!row) throw new Error('admin_notice_create_failed');
    return row;
  }

  /**
   * Raise the notice of an operational event, only while the event is not suppressed (nor, for
   * identity mapping, its state resolved). Checked in the same statement: an event closed
   * meanwhile gets no notice that nothing would close.
   *
   * @returns The notice, or null when the event is already suppressed (or gone)
   */
  async createForOpenEvent(
    input: AdminNoticeInput,
    eventId: string,
    now: number = getCurrentTimestamp()
  ): Promise<AdminNotice | null> {
    const id = generateId();
    await this.adapter.execute(
      `INSERT INTO admin_notices (${INSERT_COLUMNS})
        SELECT ${INSERT_COLUMNS.split(',')
          .map(() => '?')
          .join(', ')}
         WHERE EXISTS (
           SELECT 1 FROM internal_notification_events
            WHERE id = ? AND status <> 'suppressed'
         )
           AND NOT EXISTS (
             SELECT 1 FROM operational_notification_states
              WHERE notification_event_id = ? AND state = 'resolved'
           )
        ON CONFLICT DO NOTHING`,
      [...insertParams(id, input, now), eventId, eventId]
    );
    return this.findCreated(id, input);
  }

  private async findCreated(id: string, input: AdminNoticeInput): Promise<AdminNotice | null> {
    const dedup = input.deduplication_key ?? null;
    const row = dedup
      ? await this.adapter.queryOne<Record<string, unknown>>(
          'SELECT * FROM admin_notices WHERE deduplication_key = ? AND resolved_at IS NULL',
          [dedup]
        )
      : await this.adapter.queryOne<Record<string, unknown>>(
          'SELECT * FROM admin_notices WHERE id = ?',
          [id]
        );
    return row ? rowToNotice(row) : null;
  }

  async findById(id: string): Promise<AdminNotice | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_notices WHERE id = ?',
      [id]
    );
    return row ? rowToNotice(row) : null;
  }

  /** Whether the viewer put this notice away. */
  async isDismissed(noticeId: string, adminUserId: string): Promise<boolean> {
    const row = await this.adapter.queryOne<{ one: number }>(
      'SELECT 1 AS one FROM admin_notice_dismissals WHERE notice_id = ? AND admin_user_id = ?',
      [noticeId, adminUserId]
    );
    return row !== null;
  }

  /**
   * The viewer's open notices, newest first: addressed to them, to the platform when they are a
   * platform admin, or to the selected tenant (client notices only with client read access), and
   * not put away by them. Notices needing a permission the viewer lacks are left out.
   */
  async listOpenFor(
    viewer: AdminNoticeViewer,
    now: number = getCurrentTimestamp()
  ): Promise<AdminNotice[]> {
    const audiences = ['(n.scope_type = ? AND n.admin_user_id = ?)'];
    const params: unknown[] = ['admin_user', viewer.adminUserId];
    if (viewer.platform) {
      audiences.push(`n.scope_type = 'platform'`);
    }
    if (viewer.tenantId) {
      audiences.push(
        viewer.canReadClients
          ? `(n.scope_type IN ('tenant', 'client') AND n.tenant_id = ?)`
          : `(n.scope_type = 'tenant' AND n.tenant_id = ?)`
      );
      params.push(viewer.tenantId);
    }
    const scope = `${OPEN_SQL} AND (${audiences.join(' OR ')})`;
    const scopeParams = [now, ...params];
    // The permissions these notices need are few (one per area): check each once, then filter in
    // SQL, so notices the viewer may not see never push the ones they may out of the page.
    const needed = await this.adapter.query<{ permission: string }>(
      `SELECT DISTINCT n.required_permission AS permission FROM admin_notices n
        WHERE ${scope} AND n.required_permission IS NOT NULL`,
      scopeParams
    );
    const allowed = needed
      .map((row) => row.permission)
      .filter((permission) => viewer.holds(permission));
    const permissionSql =
      allowed.length > 0
        ? `(n.required_permission IS NULL OR n.required_permission IN (${allowed.map(() => '?').join(', ')}))`
        : 'n.required_permission IS NULL';
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT n.* FROM admin_notices n
        WHERE ${scope}
          AND ${permissionSql}
          AND NOT EXISTS (
            SELECT 1 FROM admin_notice_dismissals d
             WHERE d.notice_id = n.id AND d.admin_user_id = ?
          )
        ORDER BY n.created_at DESC
        LIMIT ?`,
      [...scopeParams, ...allowed, viewer.adminUserId, ADMIN_NOTICE_LIST_LIMIT]
    );
    return rows.map(rowToNotice);
  }

  /** Put information away for one admin. Idempotent. */
  async dismiss(
    noticeId: string,
    adminUserId: string,
    now: number = getCurrentTimestamp()
  ): Promise<void> {
    await this.adapter.execute(
      `INSERT OR IGNORE INTO admin_notice_dismissals (notice_id, admin_user_id, dismissed_at)
       VALUES (?, ?, ?)`,
      [noticeId, adminUserId, now]
    );
  }

  /** Resolve an open notice for everyone. */
  async resolve(
    id: string,
    resolvedBy: string,
    now: number = getCurrentTimestamp()
  ): Promise<AdminNoticeResolveResult> {
    const result = await this.adapter.execute(
      `UPDATE admin_notices SET resolved_at = ?, resolved_by = ?
        WHERE id = ? AND resolved_at IS NULL`,
      [now, resolvedBy, id]
    );
    const notice = await this.findById(id);
    if (!notice) return { resolved: false, reason: 'not_found' };
    if ((result.rowsAffected ?? 0) === 0) return { resolved: false, reason: 'already_resolved' };
    return { resolved: true, notice };
  }

  /**
   * Resolve a notice raised by an operational event and suppress the event, in one atomic batch:
   * the event is raised again either before (and closed with it) or after (with a new notice),
   * never in between. A notice resolved already leaves the event alone.
   */
  async resolveWithEvent(
    id: string,
    eventId: string,
    resolvedBy: string,
    now: number = getCurrentTimestamp()
  ): Promise<AdminNoticeResolveResult> {
    const [, , result] = await this.adapter.batch([
      {
        sql: `UPDATE internal_notification_events
                 SET status = 'suppressed', updated_at = ?, last_error = NULL, next_attempt_at = NULL
               WHERE id = ? AND status IN ('pending', 'failed', 'dead_letter')
                 AND EXISTS (SELECT 1 FROM admin_notices WHERE id = ? AND resolved_at IS NULL)`,
        params: [new Date(now).toISOString(), eventId, id],
      },
      {
        // Identity mapping keeps its own state for the event; it is resolved with the notice.
        sql: `UPDATE operational_notification_states
                 SET state = 'resolved', resolved_at = ?, updated_at = ?
               WHERE notification_event_id = ? AND state <> 'resolved'
                 AND EXISTS (SELECT 1 FROM admin_notices WHERE id = ? AND resolved_at IS NULL)`,
        params: [now, now, eventId, id],
      },
      {
        sql: `UPDATE admin_notices SET resolved_at = ?, resolved_by = ?
               WHERE id = ? AND resolved_at IS NULL`,
        params: [now, resolvedBy, id],
      },
    ]);
    const notice = await this.findById(id);
    if (!notice) return { resolved: false, reason: 'not_found' };
    if ((result?.rowsAffected ?? 0) === 0) return { resolved: false, reason: 'already_resolved' };
    return { resolved: true, notice };
  }

  /** Resolve every open notice raised by these sources (the system's cause went away). */
  async resolveBySourceRefs(
    sourceRefs: string[],
    now: number = getCurrentTimestamp()
  ): Promise<number> {
    const refs = Array.from(new Set(sourceRefs.filter(Boolean)));
    let resolved = 0;
    for (let offset = 0; offset < refs.length; offset += 50) {
      const batch = refs.slice(offset, offset + 50);
      const result = await this.adapter.execute(
        `UPDATE admin_notices SET resolved_at = ?, resolved_by = 'system'
          WHERE source_ref IN (${batch.map(() => '?').join(', ')}) AND resolved_at IS NULL`,
        [now, ...batch]
      );
      resolved += result.rowsAffected ?? 0;
    }
    return resolved;
  }

  /**
   * Resolve the notices of operational events that are suppressed now. An event raised again
   * meanwhile (pending once more) keeps its notice open: checking the event's status in the same
   * statement leaves no gap between the two.
   */
  async resolveForSuppressedEvents(
    eventIds: string[],
    now: number = getCurrentTimestamp()
  ): Promise<number> {
    const ids = Array.from(new Set(eventIds.filter(Boolean)));
    let resolved = 0;
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const result = await this.adapter.execute(
        `UPDATE admin_notices SET resolved_at = ?, resolved_by = 'system'
          WHERE source_ref IN (${batch.map(() => '?').join(', ')})
            AND resolved_at IS NULL
            AND EXISTS (
              SELECT 1 FROM internal_notification_events e
               WHERE e.id = admin_notices.source_ref AND e.status = 'suppressed'
            )`,
        [now, ...batch]
      );
      resolved += result.rowsAffected ?? 0;
    }
    return resolved;
  }

  /**
   * Delete notices handled before `cutoff` (resolved then, or expired then while still open),
   * with their dismissals, a batch at a time. Open, unexpired notices are never touched.
   *
   * @returns How many notices were deleted (each of the two kinds at most `batchSize * maxBatches`)
   */
  async purgeHandledBefore(
    cutoff: number,
    options: { batchSize?: number; maxBatches?: number } = {}
  ): Promise<number> {
    const batchSize = options.batchSize ?? 500;
    const maxBatches = options.maxBatches ?? 10;
    // Each search walks its own partial index (migration 007) in a fixed order, so the two
    // statements of a batch select the same rows and open notices are never read.
    const searches = [
      `SELECT id FROM admin_notices
        WHERE resolved_at IS NOT NULL AND resolved_at < ?
        ORDER BY resolved_at, id LIMIT ?`,
      `SELECT id FROM admin_notices
        WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?
        ORDER BY expires_at, id LIMIT ?`,
    ];
    let deleted = 0;
    // Each search has its own budget: a backlog of one kind never starves the other.
    for (const handled of searches) {
      for (let round = 0; round < maxBatches; round += 1) {
        // One batch, so dismissals and deliveries never outlive or lose their notice halfway.
        const [, , notices] = await this.adapter.batch([
          {
            sql: `DELETE FROM admin_notice_dismissals WHERE notice_id IN (${handled})`,
            params: [cutoff, batchSize],
          },
          {
            sql: `DELETE FROM admin_notice_deliveries WHERE notice_id IN (${handled})`,
            params: [cutoff, batchSize],
          },
          {
            sql: `DELETE FROM admin_notices WHERE id IN (${handled})`,
            params: [cutoff, batchSize],
          },
        ]);
        const count = notices?.rowsAffected ?? 0;
        deleted += count;
        if (count < batchSize) break;
      }
    }
    return deleted;
  }

  /** Resolve the open notice of a deduplication key, if any. */
  async resolveByDeduplicationKey(
    deduplicationKey: string,
    now: number = getCurrentTimestamp()
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE admin_notices SET resolved_at = ?, resolved_by = 'system'
        WHERE deduplication_key = ? AND resolved_at IS NULL`,
      [now, deduplicationKey]
    );
    return (result.rowsAffected ?? 0) > 0;
  }
}

function parseParams(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const number = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function rowToNotice(row: Record<string, unknown>): AdminNotice {
  return {
    id: String(row.id),
    scope_type: row.scope_type as AdminNoticeScope,
    tenant_id: text(row.tenant_id),
    client_id: text(row.client_id),
    admin_user_id: text(row.admin_user_id),
    severity: row.severity as AdminNoticeSeverity,
    source: row.source as AdminNoticeSource,
    category: String(row.category),
    message_key: text(row.message_key),
    params: parseParams(row.params_json),
    title: String(row.title),
    body: text(row.body),
    link: text(row.link),
    required_permission: text(row.required_permission),
    source_ref: text(row.source_ref),
    deduplication_key: text(row.deduplication_key),
    created_by: text(row.created_by),
    created_at: Number(row.created_at),
    expires_at: number(row.expires_at),
    resolved_at: number(row.resolved_at),
    resolved_by: text(row.resolved_by),
  };
}

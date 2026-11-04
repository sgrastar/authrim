import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  AdminNoticeRepository,
  type AdminNoticeInput,
  type AdminNoticeViewer,
} from '../admin/admin-notice';
import { InternalNotificationEventRepository } from '../admin/internal-notification-event';
import { sqliteAdapter } from './sqlite-core-schema';

const ADMIN_MIGRATIONS = new URL('../../../../../migrations/admin/d1/', import.meta.url);
const T0 = 1_000_000;

function adminSchema(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const fixture = sqliteAdapter('admin');
  for (const file of [
    '003_admin_session_passkey_evidence.sql',
    '004_admin_second_factors.sql',
    '005_admin_second_factor_recoveries.sql',
    '006_admin_notices.sql',
    '007_admin_notice_indexes.sql',
  ]) {
    fixture.db.exec(
      renderPortableMigrationSql(readMigrationSource(ADMIN_MIGRATIONS, file), 'sqlite')
    );
  }
  return fixture;
}

function viewer(overrides: Partial<AdminNoticeViewer> = {}): AdminNoticeViewer {
  return {
    adminUserId: 'admin-1',
    tenantId: 'tenant-a',
    platform: false,
    canReadClients: false,
    holds: () => true,
    ...overrides,
  };
}

function notice(overrides: Partial<AdminNoticeInput> = {}): AdminNoticeInput {
  return {
    scope_type: 'tenant',
    tenant_id: 'tenant-a',
    severity: 'info',
    source: 'announcement',
    category: 'announcement',
    title: 'Maintenance tonight',
    ...overrides,
  };
}

describe('AdminNoticeRepository in the real admin schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let notices: AdminNoticeRepository;

  beforeEach(() => {
    ({ db, adapter } = adminSchema());
    notices = new AdminNoticeRepository(adapter);
    for (const [id, tenant] of [
      ['admin-1', 'tenant-a'],
      ['admin-2', 'tenant-a'],
      ['admin-3', 'tenant-b'],
    ]) {
      db.prepare(
        `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, tenant, `${id}@example.com`, Date.now(), Date.now());
    }
  });

  const titles = async (who: AdminNoticeViewer, now = T0 + 100) =>
    (await notices.listOpenFor(who, now)).map((item) => item.title);

  it('shows each audience only to its admins', async () => {
    // Oldest first, so the lists below read newest first.
    await notices.create(
      notice({ scope_type: 'admin_user', admin_user_id: 'admin-2', title: 'to admin 2' }),
      T0
    );
    await notices.create(
      notice({ scope_type: 'client', client_id: 'app-1', title: 'client' }),
      T0 + 1
    );
    await notices.create(notice({ tenant_id: 'tenant-b', title: 'tenant b' }), T0 + 2);
    await notices.create(notice({ title: 'tenant a' }), T0 + 3);
    await notices.create(notice({ scope_type: 'platform', title: 'platform' }), T0 + 4);

    expect(await titles(viewer())).toEqual(['tenant a']);
    expect(await titles(viewer({ canReadClients: true }))).toEqual(['tenant a', 'client']);
    expect(await titles(viewer({ platform: true }))).toEqual(['platform', 'tenant a']);
    expect(await titles(viewer({ adminUserId: 'admin-2' }))).toEqual(['tenant a', 'to admin 2']);
    // A notice to one admin follows them into any tenant they look at.
    expect(await titles(viewer({ adminUserId: 'admin-2', tenantId: 'tenant-b' }))).toEqual([
      'tenant b',
      'to admin 2',
    ]);
    expect(await titles(viewer({ tenantId: null }))).toEqual([]);
  });

  it('leaves out notices behind a permission the viewer lacks', async () => {
    await notices.create(notice({ title: 'open to all' }), T0);
    await notices.create(
      notice({ title: 'logging', required_permission: 'admin:logging:overview:read' }),
      T0
    );
    expect(await titles(viewer({ holds: () => false }))).toEqual(['open to all']);
    expect(await titles(viewer())).toEqual(['open to all', 'logging']);
  });

  it('does not let notices the viewer may not see push the others off the page', async () => {
    await notices.create(notice({ title: 'visible' }), T0);
    for (let index = 0; index < 250; index += 1) {
      await notices.create(
        notice({ title: `hidden ${index}`, required_permission: 'admin:logging:overview:read' }),
        T0 + 1 + index
      );
    }
    const holdsLogging = (permission: string) => permission === 'admin:logging:overview:read';
    expect(await titles(viewer({ holds: () => false }), T0 + 1000)).toEqual(['visible']);
    const all = await notices.listOpenFor(viewer({ holds: holdsLogging }), T0 + 1000);
    expect(all).toHaveLength(100);
    expect(all[0].title).toBe('hidden 249');
  });

  it('lists newest first and drops expired notices', async () => {
    await notices.create(notice({ title: 'older' }), T0);
    await notices.create(notice({ title: 'newer' }), T0 + 10);
    await notices.create(notice({ title: 'expires', expires_at: T0 + 20 }), T0 + 5);
    expect(await titles(viewer(), T0 + 11)).toEqual(['newer', 'expires', 'older']);
    expect(await titles(viewer(), T0 + 20)).toEqual(['newer', 'older']);
  });

  it('keeps one open notice per deduplication key and allows it again once resolved', async () => {
    const first = await notices.create(notice({ deduplication_key: 'k', title: 'first' }), T0);
    const again = await notices.create(notice({ deduplication_key: 'k', title: 'again' }), T0);
    expect(again.id).toBe(first.id);
    expect(again.title).toBe('first');

    await notices.resolve(first.id, 'admin-1', T0 + 1);
    const reopened = await notices.create(notice({ deduplication_key: 'k', title: 'later' }), T0);
    expect(reopened.id).not.toBe(first.id);
  });

  it('puts information away for one admin only', async () => {
    const item = await notices.create(notice({ title: 'info' }), T0);
    await notices.dismiss(item.id, 'admin-1', T0);
    await notices.dismiss(item.id, 'admin-1', T0);
    expect(await titles(viewer())).toEqual([]);
    expect(await titles(viewer({ adminUserId: 'admin-2' }))).toEqual(['info']);
    expect(await notices.isDismissed(item.id, 'admin-1')).toBe(true);
  });

  it('resolves once, for everyone', async () => {
    const item = await notices.create(notice({ severity: 'high', title: 'high' }), T0);
    const first = await notices.resolve(item.id, 'admin-2', T0 + 1);
    expect(first).toMatchObject({ resolved: true, notice: { resolved_by: 'admin-2' } });
    expect(await notices.resolve(item.id, 'admin-1', T0 + 2)).toEqual({
      resolved: false,
      reason: 'already_resolved',
    });
    expect(await notices.resolve('missing', 'admin-1')).toEqual({
      resolved: false,
      reason: 'not_found',
    });
    expect(await titles(viewer({ adminUserId: 'admin-2' }))).toEqual([]);
  });

  it('deletes handled notices past the cutoff with their dismissals, and nothing open', async () => {
    const old = await notices.create(notice({ severity: 'high', title: 'old' }), T0);
    await notices.resolve(old.id, 'admin-1', T0 + 10);
    const oldInfo = await notices.create(notice({ title: 'old info' }), T0);
    await notices.dismiss(oldInfo.id, 'admin-1', T0);
    await notices.resolve(oldInfo.id, 'system', T0 + 10);
    await notices.create(notice({ title: 'expired', expires_at: T0 + 20 }), T0);
    const recent = await notices.create(notice({ severity: 'high', title: 'recent' }), T0);
    await notices.resolve(recent.id, 'admin-1', T0 + 500);
    await notices.create(notice({ title: 'open' }), T0);
    await notices.create(notice({ title: 'expires later', expires_at: T0 + 900 }), T0);

    expect(await notices.purgeHandledBefore(T0 + 100)).toBe(3);
    const left = db.prepare('SELECT title FROM admin_notices ORDER BY title').all() as {
      title: string;
    }[];
    expect(left.map((row) => row.title)).toEqual(['expires later', 'open', 'recent']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_notice_dismissals').get()).toEqual({
      n: 0,
    });
  });

  it('finds handled notices through the retention indexes, not by scanning', async () => {
    for (const sql of [
      `SELECT id FROM admin_notices WHERE resolved_at IS NOT NULL AND resolved_at < 1
        ORDER BY resolved_at, id LIMIT 10`,
      `SELECT id FROM admin_notices
        WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at < 1
        ORDER BY expires_at, id LIMIT 10`,
    ]) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((row) => row.detail)
        .join(' | ');
      expect(plan).toMatch(/idx_admin_notices_(resolved_handled|expired_open)/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('deletes expired notices even when no resolved one is left to delete', async () => {
    await notices.create(notice({ title: 'expired', expires_at: T0 + 5 }), T0);
    expect(await notices.purgeHandledBefore(T0 + 100, { batchSize: 2, maxBatches: 1 })).toBe(1);
  });

  it('looks up the identity mapping state of an event by index', async () => {
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM operational_notification_states
            WHERE notification_event_id = 'e' AND state = 'resolved'`
        )
        .all() as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain('idx_operational_notification_states_event');
  });

  it('purges in batches and stops at the run limit', async () => {
    for (let index = 0; index < 7; index += 1) {
      const item = await notices.create(notice({ severity: 'high', title: `n${index}` }), T0);
      await notices.resolve(item.id, 'admin-1', T0 + 1);
    }
    expect(await notices.purgeHandledBefore(T0 + 100, { batchSize: 2, maxBatches: 2 })).toBe(4);
    expect(await notices.purgeHandledBefore(T0 + 100, { batchSize: 2, maxBatches: 5 })).toBe(3);
  });

  it('refuses a notice whose audience does not match its scope', async () => {
    await expect(
      adapter.execute(
        `INSERT INTO admin_notices (id, scope_type, tenant_id, severity, source, category, title,
           created_at) VALUES ('x', 'client', 'tenant-a', 'info', 'system', 'c', 't', 1)`
      )
    ).rejects.toThrow();
  });

  describe('operational events', () => {
    it('raises a notice for a new event and resolves it with the event', async () => {
      const events = new InternalNotificationEventRepository(adapter);
      const tenantEvent = await events.enqueue({
        tenantId: 'tenant-a',
        category: 'logging_delivery_failure',
        eventType: 'delivery_failed',
        severity: 'medium',
        deduplicationKey: 'dedup-a',
        payload: {},
      });
      await events.enqueue({
        tenantId: 'global',
        category: 'control_plane_drift',
        eventType: 'drift',
        severity: 'critical',
        deduplicationKey: 'dedup-global',
        payload: {},
      });
      // The same event raised again does not add a second notice.
      await events.enqueue({
        tenantId: 'tenant-a',
        category: 'logging_delivery_failure',
        eventType: 'delivery_failed',
        severity: 'medium',
        deduplicationKey: 'dedup-a',
        payload: {},
      });

      const all = await notices.listOpenFor(viewer({ platform: true }), Date.now() + 1);
      expect(all.map((item) => [item.scope_type, item.severity, item.category])).toEqual(
        expect.arrayContaining([
          ['tenant', 'caution', 'logging_delivery_failure'],
          ['platform', 'critical', 'control_plane_drift'],
        ])
      );
      expect(all).toHaveLength(2);
      const tenantNotice = all.find((item) => item.scope_type === 'tenant');
      expect(tenantNotice).toMatchObject({
        source_ref: tenantEvent.id,
        required_permission: 'admin:logging:overview:read',
        params: { tenant_id: 'tenant-a' },
      });

      await events.suppressResolvedByDeduplicationKeys(['dedup-a']);
      const left = await notices.listOpenFor(viewer({ platform: true }), Date.now() + 1);
      expect(left.map((item) => item.category)).toEqual(['control_plane_drift']);
      expect(await notices.findById(tenantNotice!.id)).toMatchObject({ resolved_by: 'system' });
    });

    it('keeps the notice of an event raised again before its old notice was resolved', async () => {
      const events = new InternalNotificationEventRepository(adapter);
      const input = {
        tenantId: 'tenant-a',
        category: 'logging_dlq_backlog' as const,
        eventType: 'backlog',
        severity: 'high' as const,
        deduplicationKey: 'dedup-race',
        payload: {},
        reopenSuppressed: true,
      };
      const event = await events.enqueue(input);
      // Suppressed, and raised again before the resolving of its notice ran.
      db.prepare(`UPDATE internal_notification_events SET status = 'suppressed' WHERE id = ?`).run(
        event.id
      );
      await events.enqueue(input);
      expect(await notices.resolveForSuppressedEvents([event.id])).toBe(0);
      const open = await notices.listOpenFor(viewer(), Date.now() + 1);
      expect(open.map((item) => item.source_ref)).toEqual([event.id]);
    });

    it('raises no notice for an event suppressed before its notice was written', async () => {
      db.prepare(
        `INSERT INTO internal_notification_events (id, tenant_id, category, event_type, severity,
           status, payload_json) VALUES ('evt-x', 'tenant-a', 'logging_dlq_backlog', 'b', 'high',
           'suppressed', '{}')`
      ).run();
      const created = await notices.createForOpenEvent(
        notice({ severity: 'high', source: 'system', source_ref: 'evt-x' }),
        'evt-x'
      );
      expect(created).toBeNull();
      expect(await titles(viewer())).toEqual([]);
    });

    it('resolves a notice with its event at once, and a stale notice leaves the event alone', async () => {
      const events = new InternalNotificationEventRepository(adapter);
      const input = {
        tenantId: 'tenant-a',
        category: 'logging_dlq_backlog' as const,
        eventType: 'backlog',
        severity: 'high' as const,
        deduplicationKey: 'dedup-manual',
        payload: {},
        reopenSuppressed: true,
      };
      const event = await events.enqueue(input);
      const [first] = await notices.listOpenFor(viewer(), Date.now() + 1);
      const resolved = await notices.resolveWithEvent(first.id, event.id, 'admin-1');
      expect(resolved.resolved).toBe(true);
      const status = () =>
        db.prepare('SELECT status FROM internal_notification_events WHERE id = ?').get(event.id);
      expect(status()).toEqual({ status: 'suppressed' });

      // Raised again: a new notice; resolving the old one again changes nothing.
      await events.enqueue(input);
      expect(status()).toEqual({ status: 'pending' });
      expect(await notices.resolveWithEvent(first.id, event.id, 'admin-1')).toEqual({
        resolved: false,
        reason: 'already_resolved',
      });
      expect(status()).toEqual({ status: 'pending' });
      expect(await notices.listOpenFor(viewer(), Date.now() + 1)).toHaveLength(1);
    });

    it('raises no notice for an event whose identity mapping state is resolved', async () => {
      db.prepare(
        `INSERT INTO internal_notification_events (id, tenant_id, category, event_type, severity,
           status, payload_json) VALUES ('evt-m', 'tenant-a', 'identity_mapping_signal', 's',
           'high', 'pending', '{}')`
      ).run();
      db.prepare(
        `INSERT INTO operational_notification_states (id, tenant_id, notification_event_id,
           subject_type, subject_id, state, created_at, updated_at)
         VALUES ('st-m', 'tenant-a', 'evt-m', 'review_task', 'r1', 'resolved', 1, 1)`
      ).run();
      expect(
        await notices.createForOpenEvent(
          notice({ severity: 'high', source: 'system', source_ref: 'evt-m' }),
          'evt-m'
        )
      ).toBeNull();
    });

    it('keeps the event when the notice cannot be written', async () => {
      db.exec('DROP TABLE admin_notice_dismissals; DROP TABLE admin_notices;');
      const events = new InternalNotificationEventRepository(adapter);
      const event = await events.enqueue({
        tenantId: 'tenant-a',
        category: 'logging_quota_warning',
        eventType: 'quota',
        severity: 'high',
        payload: {},
      });
      expect(event.status).toBe('pending');
    });
  });
});

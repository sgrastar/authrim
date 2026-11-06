import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { AdminNoticeRepository, type AdminNoticeInput } from '../admin/admin-notice';
import { AdminNoticeDeliveryRepository, severityReaches } from '../admin/admin-notice-delivery';
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
    '008_admin_notice_delivery.sql',
  ]) {
    fixture.db.exec(
      renderPortableMigrationSql(readMigrationSource(ADMIN_MIGRATIONS, file), 'sqlite')
    );
  }
  return fixture;
}

const notice = (overrides: Partial<AdminNoticeInput> = {}): AdminNoticeInput => ({
  scope_type: 'tenant',
  tenant_id: 'tenant-a',
  severity: 'high',
  source: 'announcement',
  category: 'announcement',
  title: 'Maintenance',
  ...overrides,
});

const channel = (overrides = {}) => ({
  scope_type: 'tenant' as const,
  tenant_id: 'tenant-a',
  name: 'Ops',
  webhook_url_encrypted: 'enc:v1:secret',
  webhook_url_hint: 'hooks.slack.com/services/T1/…',
  min_severity: 'high' as const,
  enabled: true,
  created_by: 'admin-1',
  ...overrides,
});

describe('AdminNoticeDeliveryRepository in the real admin schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let deliveries: AdminNoticeDeliveryRepository;
  let notices: AdminNoticeRepository;

  beforeEach(() => {
    ({ db, adapter } = adminSchema());
    deliveries = new AdminNoticeDeliveryRepository(adapter);
    notices = new AdminNoticeRepository(adapter);
    for (const id of ['admin-1', 'admin-2']) {
      db.prepare(
        `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
         VALUES (?, 'tenant-a', ?, 1, 1)`
      ).run(id, `${id}@example.com`);
    }
  });

  it('ranks severities from critical down', () => {
    expect(severityReaches('critical', 'high')).toBe(true);
    expect(severityReaches('high', 'high')).toBe(true);
    expect(severityReaches('caution', 'high')).toBe(false);
    expect(severityReaches('info', 'info')).toBe(true);
  });

  it('keeps defaults until an admin chooses, then their choice', async () => {
    expect(await deliveries.getPreferences('admin-1')).toEqual({
      email_enabled: true,
      email_min_severity: 'high',
      updated_at: null,
    });
    await deliveries.setPreferences(
      'admin-1',
      {
        email_enabled: false,
        email_min_severity: 'critical',
      },
      T0
    );
    await deliveries.setPreferences(
      'admin-1',
      {
        email_enabled: true,
        email_min_severity: 'caution',
      },
      T0 + 1
    );
    expect(await deliveries.getPreferences('admin-1')).toMatchObject({
      email_enabled: true,
      email_min_severity: 'caution',
    });
    expect([...(await deliveries.preferencesOf(['admin-1', 'admin-2'])).keys()]).toEqual([
      'admin-1',
    ]);
  });

  it('never returns the encrypted webhook URL and picks channels by scope and severity', async () => {
    const ops = await deliveries.createChannel(channel(), T0);
    expect(ops).not.toHaveProperty('webhook_url_encrypted');
    await deliveries.createChannel(channel({ name: 'All', min_severity: 'info' }), T0);
    await deliveries.createChannel(channel({ name: 'Off', enabled: false }), T0);
    await deliveries.createChannel(channel({ name: 'B', tenant_id: 'tenant-b' }), T0);
    await deliveries.createChannel(
      channel({ name: 'Root', scope_type: 'platform', tenant_id: null }),
      T0
    );

    const names = async (severity: 'high' | 'info') =>
      (await deliveries.channelsFor({ scope: 'tenant', tenantId: 'tenant-a' }, severity))
        .map((item) => item.name)
        .sort();
    expect(await names('high')).toEqual(['All', 'Ops']);
    expect(await names('info')).toEqual(['All']);
    expect(
      (await deliveries.channelsFor({ scope: 'platform' }, 'critical')).map((item) => item.name)
    ).toEqual(['Root']);
    expect(
      (await deliveries.listChannels({ tenantId: 'tenant-a', platform: false })).map(
        (item) => item.name
      )
    ).toEqual(['All', 'Off', 'Ops']);
  });

  it('plans a notice once, with its rows', async () => {
    const item = await notices.create(notice(), T0);
    const targets = [
      { channel: 'email' as const, target_id: 'admin-1' },
      { channel: 'slack' as const, target_id: 'chan-1' },
    ];
    expect((await deliveries.listUnplanned(10)).map((row) => row.id)).toEqual([item.id]);
    expect(await deliveries.plan(item.id, targets, T0)).toBe(true);
    expect(await deliveries.plan(item.id, targets, T0)).toBe(false);
    expect(await deliveries.listUnplanned(10)).toEqual([]);
    expect((await deliveries.listForNotice(item.id)).items).toHaveLength(2);
  });

  it('leases due deliveries to one run and records the outcome', async () => {
    const item = await notices.create(notice(), T0);
    await deliveries.plan(item.id, [{ channel: 'email', target_id: 'admin-1' }], T0);

    const first = await deliveries.claimDue(T0 + 1, 10, 60_000, 'run-1');
    expect(first).toHaveLength(1);
    expect(first[0].attempts).toBe(1);
    expect(await deliveries.claimDue(T0 + 2, 10, 60_000, 'run-2')).toEqual([]);

    expect(await deliveries.finish(first[0].id, 'run-2', { status: 'sent' }, T0 + 3)).toBe(false);
    expect(
      await deliveries.finish(
        first[0].id,
        'run-1',
        { status: 'failed', error: 'slack_http_500', nextAttemptAt: T0 + 100 },
        T0 + 3
      )
    ).toBe(true);
    expect(await deliveries.claimDue(T0 + 50, 10, 60_000, 'run-3')).toEqual([]);
    const retry = await deliveries.claimDue(T0 + 100, 10, 60_000, 'run-3');
    expect(retry.map((row) => row.attempts)).toEqual([2]);
    await deliveries.finish(retry[0].id, 'run-3', { status: 'sent' }, T0 + 101);
    expect(await deliveries.claimDue(T0 + 10_000, 10, 60_000, 'run-4')).toEqual([]);
  });

  it('pages a notice’s deliveries and counts them by status', async () => {
    const item = await notices.create(notice(), T0);
    await deliveries.plan(
      item.id,
      Array.from({ length: 5 }, (_, index) => ({
        channel: 'email' as const,
        target_id: `admin-${index}`,
      })),
      T0
    );
    const first = await deliveries.listForNotice(item.id, { limit: 3 });
    expect(first.items).toHaveLength(3);
    const second = await deliveries.listForNotice(item.id, { after: first.next, limit: 3 });
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
    expect(await deliveries.summaryForNotice(item.id)).toEqual([
      { channel: 'email', status: 'queued', count: 5 },
    ]);
  });

  it('tells a run its lease was taken over by another', async () => {
    const item = await notices.create(notice(), T0);
    await deliveries.plan(item.id, [{ channel: 'email', target_id: 'admin-1' }], T0);
    const [row] = await deliveries.claimDue(T0, 10, 60_000, 'run-1');
    expect(await deliveries.renewLease(row.id, 'run-1', T0 + 1_000, 60_000)).toBe(true);
    // run-1 stalls past its lease; run-2 takes the row.
    expect(await deliveries.claimDue(T0 + 70_000, 10, 60_000, 'run-2')).toHaveLength(1);
    expect(await deliveries.renewLease(row.id, 'run-1', T0 + 70_001, 60_000)).toBe(false);
    expect(await deliveries.finish(row.id, 'run-1', { status: 'sent' }, T0 + 70_002)).toBe(false);
  });

  it('marks notices from before delivery existed as planned', () => {
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
    fixture.db.exec(`INSERT INTO admin_notices (id, scope_type, tenant_id, severity, source,
      category, title, created_at) VALUES ('old', 'tenant', 't', 'high', 'system', 'c', 'x', 5)`);
    fixture.db.exec(
      renderPortableMigrationSql(
        readMigrationSource(ADMIN_MIGRATIONS, '008_admin_notice_delivery.sql'),
        'sqlite'
      )
    );
    expect(fixture.db.prepare('SELECT delivery_planned_at FROM admin_notices').get()).toEqual({
      delivery_planned_at: 5,
    });
  });

  it('removes a channel with what was still to be sent to it', async () => {
    const created = await deliveries.createChannel(channel(), T0);
    const item = await notices.create(notice(), T0);
    await deliveries.plan(item.id, [{ channel: 'slack', target_id: created.id }], T0);
    expect(await deliveries.deleteChannel(created.id)).toBe(true);
    expect((await deliveries.listForNotice(item.id)).items).toEqual([]);
    expect(await deliveries.deleteChannel(created.id)).toBe(false);
  });

  it('deletes deliveries with the notices the retention purges', async () => {
    const item = await notices.create(notice(), T0);
    await deliveries.plan(item.id, [{ channel: 'email', target_id: 'admin-1' }], T0);
    await notices.resolve(item.id, 'admin-1', T0 + 1);
    expect(await notices.purgeHandledBefore(T0 + 100)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_notice_deliveries').get()).toEqual({ n: 0 });
  });
});

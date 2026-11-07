import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { AdminNoticeRepository, encryptValue } from '@authrim/ar-lib-core';

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
// The package has no Node types, so the driver is typed by the little these tests use.
const DatabaseSync = SqliteDatabase as unknown as new (path: string) => Database;

const mocks = vi.hoisted(() => {
  const emails: Array<{ to: string; subject: string; owner: unknown }> = [];
  const state: { emailResult: string; emailThrows: boolean } = {
    emailResult: 'delivered',
    emailThrows: false,
  };
  return { emails, state };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    produceNotificationDelivery: vi.fn(
      async (
        _env: unknown,
        input: { owner: unknown; payload: { to: string; subject: string } }
      ) => {
        if (mocks.state.emailThrows)
          throw new Error('notification_delivery_provider_order_unavailable');
        mocks.emails.push({
          to: input.payload.to,
          subject: input.payload.subject,
          owner: input.owner,
        });
        return { reference: 'r', bindingRef: 'b', delivery: mocks.state.emailResult };
      }
    ),
  };
});

import {
  MAX_ATTEMPTS,
  isSlackWebhookUrl,
  planNoticeDeliveries,
  sendDueNoticeDeliveries,
} from '../admin-notice-delivery';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);
const KEY = 'a'.repeat(64);
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const NOW = 2_000_000_000_000;

function database(): { db: Database; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    '001_0_5_0_admin_baseline.sql',
    '003_admin_session_passkey_evidence.sql',
    '004_admin_second_factors.sql',
    '005_admin_second_factor_recoveries.sql',
    '006_admin_notices.sql',
    '007_admin_notice_indexes.sql',
    '008_admin_notice_delivery.sql',
    '012_admin_groups.sql',
  ]) {
    db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, file));
  }
  const run = (sql: string) => db.prepare(sql);
  const adapter = {
    query: async (sql: string, params: unknown[] = []) => run(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => run(sql).get(...params) ?? null,
    execute: async (sql: string, params: unknown[] = []) => ({
      rowsAffected: Number(run(sql).run(...params).changes),
      success: true,
    }),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => ({
          rowsAffected: Number(run(sql).run(...params).changes),
          success: true,
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

const env = {
  PII_ENCRYPTION_KEY: KEY,
  ADMIN_UI_URL: 'https://admin.example.com',
} as unknown as Env;

describe('admin notice delivery', () => {
  let db: Database;
  let adapter: DatabaseAdapter;
  let notices: AdminNoticeRepository;

  beforeEach(() => {
    ({ db, adapter } = database());
    notices = new AdminNoticeRepository(adapter);
    mocks.emails.length = 0;
    mocks.state.emailResult = 'delivered';
    mocks.state.emailThrows = false;
    const user = db.prepare(
      `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`
    );
    const role = db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id,
         scope_type, scope_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    );
    user.run('lead', 'tenant-a', 'lead@a.example');
    role.run('ra-1', 'tenant-a', 'lead', 'role_ar_tenant_admin', 'tenant', 'tenant-a', null);
    user.run('watcher', 'tenant-a', 'watcher@a.example');
    role.run('ra-2', 'tenant-a', 'watcher', 'role_ar_viewer', 'tenant', 'tenant-a', null);
    user.run('expired', 'tenant-a', 'expired@a.example');
    // Lapsed an hour ago (role expiry is in milliseconds, as the auth middleware compares it).
    role.run(
      'ra-3',
      'tenant-a',
      'expired',
      'role_ar_tenant_admin',
      'tenant',
      'tenant-a',
      NOW - 3_600_000
    );
    user.run('other', 'tenant-b', 'other@b.example');
    role.run('ra-4', 'tenant-b', 'other', 'role_ar_tenant_admin', 'tenant', 'tenant-b', null);
    user.run('root', 'default', 'root@example.com');
    role.run('ra-5', 'default', 'root', 'role_ar_super_admin', 'global', null, null);
  });

  async function slackChannel(tenantId: string | null, minSeverity = 'high') {
    const sealed = await encryptValue(SLACK, KEY, 'AES-256-GCM', 1);
    db.prepare(
      `INSERT INTO admin_notice_channels (id, scope_type, tenant_id, kind, name,
         webhook_url_encrypted, webhook_url_hint, min_severity, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'slack', 'Ops', ?, 'hint', ?, 1, 1, 1)`
    ).run(
      `ch-${tenantId ?? 'platform'}`,
      tenantId ? 'tenant' : 'platform',
      tenantId,
      sealed.encrypted,
      minSeverity
    );
  }

  const targets = (noticeId: string) =>
    (
      db
        .prepare(
          `SELECT channel || ':' || target_id AS t FROM admin_notice_deliveries
            WHERE notice_id = ? ORDER BY t`
        )
        .all(noticeId) as { t: string }[]
    ).map((row) => row.t);

  it('accepts only Slack Incoming Webhook URLs', () => {
    expect(isSlackWebhookUrl(SLACK)).toBe(true);
    for (const url of [
      'http://hooks.slack.com/services/T/B/X',
      'https://hooks.slack.com.evil.example/services/T/B/X',
      'https://hooks.slack.com:8443/services/T/B/X',
      'https://user@hooks.slack.com/services/T/B/X',
      'https://hooks.slack.com/api/x',
      'https://hooks.slack.com/services/T/B/X?redirect=1',
      'not a url',
    ]) {
      expect(isSlackWebhookUrl(url), url).toBe(false);
    }
  });

  it('emails the admins of the audience who hold what it needs and want its severity', async () => {
    await slackChannel('tenant-a');
    await slackChannel(null);
    const tenant = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'T',
      },
      NOW
    );
    const writers = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'critical',
        source: 'system',
        category: 'c',
        title: 'W',
        required_permission: 'admin:settings:write',
      },
      NOW
    );
    const platform = await notices.create(
      { scope_type: 'platform', severity: 'critical', source: 'system', category: 'c', title: 'P' },
      NOW
    );
    const personal = await notices.create(
      {
        scope_type: 'admin_user',
        tenant_id: 'tenant-a',
        admin_user_id: 'watcher',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'M',
      },
      NOW
    );
    const quiet = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'caution',
        source: 'announcement',
        category: 'announcement',
        title: 'Q',
      },
      NOW
    );
    // The watcher wants no email at all.
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('watcher', 0, 'info', 1)`
    ).run();

    expect(await planNoticeDeliveries(adapter, NOW + 1)).toMatchObject({ planned: 5 });
    // A platform admin can open any tenant, so hears about it too.
    expect(targets(tenant.id)).toEqual(['email:lead', 'email:root', 'slack:ch-tenant-a']);
    // Behind a permission: the channel has no registering admin who sees it, so no post.
    expect(targets(writers.id)).toEqual(['email:lead', 'email:root']);
    expect(targets(platform.id)).toEqual(['email:root', 'slack:ch-platform']);
    // Personal notices are not posted to a shared channel; the watcher opted out of email.
    expect(targets(personal.id)).toEqual([]);
    // Below the default minimum (high) and the channel's.
    expect(targets(quiet.id)).toEqual([]);
    expect(await planNoticeDeliveries(adapter, NOW + 2)).toMatchObject({ planned: 0 });
  });

  it('plans nothing for notices already closed or too old when first seen', async () => {
    const old = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'critical',
        source: 'system',
        category: 'c',
        title: 'old',
      },
      NOW - 2 * 24 * 3600 * 1000
    );
    const closed = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'critical',
        source: 'system',
        category: 'c',
        title: 'closed',
      },
      NOW
    );
    await notices.resolve(closed.id, 'lead', NOW);
    await planNoticeDeliveries(adapter, NOW + 1);
    expect(targets(old.id)).toEqual([]);
    expect(targets(closed.id)).toEqual([]);
  });

  it('sends email through the outbox and Slack to the decrypted webhook', async () => {
    await slackChannel('tenant-a');
    await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: '<b>Down</b>',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));

    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 1, fetcher)).toEqual({ sent: 4 });
    // The viewer never chose, so gets the default (high and above); the lapsed admin nothing.
    expect(mocks.emails.map((email) => email.to).sort()).toEqual([
      'lead@a.example',
      'root@example.com',
      'watcher@a.example',
    ]);
    expect(mocks.emails[0]).toMatchObject({
      subject: '[Authrim] High: <b>Down</b>',
      owner: { owner: 'tenant', tenantId: 'tenant-a' },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe(SLACK);
    expect(JSON.parse(init.body)).toEqual({
      text: expect.stringContaining('&lt;b&gt;Down&lt;/b&gt;') as unknown,
    });
    expect(init.body).toContain('https://admin.example.com/admin/integrations/notifications');
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 2, fetcher)).toEqual({});
  });

  it('retries Slack with backoff, gives up on a refusal, and skips closed notices', async () => {
    await slackChannel('tenant-a');
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('lead', 0, 'info', 1), ('watcher', 0, 'info', 1), ('root', 0, 'info', 1)`
    ).run();
    const item = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    const busy = vi.fn(async () => new Response('', { status: 503 }));
    expect(await sendDueNoticeDeliveries(env, adapter, NOW, busy)).toEqual({ failed: 1 });
    // Not due again for a minute.
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 30_000, busy)).toEqual({});
    const gone = vi.fn(async () => new Response('', { status: 404 }));
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 61_000, gone)).toEqual({
      dead_letter: 1,
    });

    const second = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'y',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    await notices.resolve(second.id, 'lead', NOW);
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 1, busy)).toEqual({ skipped: 1 });
    expect(item.id).not.toBe(second.id);
  });

  it('stops retrying after the last attempt', async () => {
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('lead', 1, 'info', 1)`
    ).run();
    await notices.create(
      {
        scope_type: 'admin_user',
        tenant_id: 'tenant-a',
        admin_user_id: 'lead',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    db.prepare(`UPDATE admin_notice_deliveries SET attempts = ?`).run(MAX_ATTEMPTS - 1);
    mocks.state.emailThrows = true;
    expect(await sendDueNoticeDeliveries(env, adapter, NOW, vi.fn())).toEqual({ dead_letter: 1 });
  });

  it('does not email someone who lost the notice’s audience or opted out after planning', async () => {
    await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'critical',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    db.prepare(`DELETE FROM admin_role_assignments WHERE admin_user_id = 'lead'`).run();
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('watcher', 1, 'critical', 1), ('root', 0, 'info', 1)`
    ).run();
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 1, vi.fn())).toEqual({
      skipped: 2,
      sent: 1,
    });
    expect(mocks.emails.map((email) => email.to)).toEqual(['watcher@a.example']);
  });

  it('keeps the email expiry of the first attempt on a retry', async () => {
    await notices.create(
      {
        scope_type: 'admin_user',
        tenant_id: 'tenant-a',
        admin_user_id: 'lead',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    const { produceNotificationDelivery } = await import('@authrim/ar-lib-core');
    const spy = vi.mocked(produceNotificationDelivery);
    spy.mockClear();
    mocks.state.emailThrows = true;
    await sendDueNoticeDeliveries(env, adapter, NOW + 1, vi.fn());
    mocks.state.emailThrows = false;
    await sendDueNoticeDeliveries(env, adapter, NOW + 10 * 60_000, vi.fn());
    const expiries = spy.mock.calls.map(([, input]) => input.expiresAt);
    expect(expiries).toHaveLength(2);
    expect(expiries[0]).toBe(expiries[1]);
    // A day after the delivery was planned it is no longer sent.
    db.prepare(`UPDATE admin_notice_deliveries SET status = 'failed', next_attempt_at = 0`).run();
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 25 * 3_600_000, vi.fn())).toEqual({
      skipped: 1,
    });
  });

  it('plans a tenant with more admins than one query may take', async () => {
    const user = db.prepare(
      `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, 1, 1)`
    );
    const role = db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id,
         scope_type, scope_id, created_at) VALUES (?, 'tenant-a', ?, 'role_ar_viewer', 'tenant',
         'tenant-a', 1)`
    );
    for (let index = 0; index < 150; index += 1) {
      user.run(`many-${index}`, `many-${index}@a.example`);
      role.run(`ra-many-${index}`, `many-${index}`);
    }
    const item = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    expect(await planNoticeDeliveries(adapter, NOW)).toMatchObject({ planned: 1, failed: 0 });
    // 150 viewers, the lead, the watcher and the platform admin.
    expect(targets(item.id)).toHaveLength(153);
  });

  it('reaches global viewers of other tenants, and nobody without a sign-in role', async () => {
    const user = db.prepare(
      `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`
    );
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, display_name, permissions_json,
         hierarchy_level, role_type, is_system, created_at, updated_at)
       VALUES ('role_custom_reader', 'tenant-a', 'custom_reader', 'Reader',
         '["admin:settings:read"]', 1, 'custom', 0, 1, 1)`
    ).run();
    const role = db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id,
         scope_type, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)`
    );
    user.run('auditor', 'tenant-b', 'auditor@b.example');
    role.run('ra-aud', 'tenant-b', 'auditor', 'role_ar_viewer', 'global', null);
    user.run('custom', 'tenant-a', 'custom@a.example');
    role.run('ra-cus', 'tenant-a', 'custom', 'role_custom_reader', 'tenant', 'tenant-a');
    const item = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    // The global viewer of another tenant hears; the custom-role-only admin cannot sign in.
    expect(targets(item.id)).toEqual([
      'email:auditor',
      'email:lead',
      'email:root',
      'email:watcher',
    ]);
  });

  it('leaves the rest of a large plan for the next run', async () => {
    for (const title of ['a', 'b', 'c']) {
      await notices.create(
        {
          scope_type: 'tenant',
          tenant_id: 'tenant-a',
          severity: 'high',
          source: 'announcement',
          category: 'announcement',
          title,
        },
        NOW
      );
    }
    const first = await planNoticeDeliveries(adapter, NOW, undefined, 5);
    expect(first.planned).toBeGreaterThan(0);
    expect(first.planned).toBeLessThan(3);
    const rest = await planNoticeDeliveries(adapter, NOW);
    expect(first.planned + rest.planned).toBe(3);
  });

  it('skips a Slack post whose channel minimum was raised after planning', async () => {
    await slackChannel('tenant-a', 'high');
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('lead', 0, 'info', 1), ('watcher', 0, 'info', 1), ('root', 0, 'info', 1)`
    ).run();
    await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    db.prepare(`UPDATE admin_notice_channels SET min_severity = 'critical'`).run();
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 1, vi.fn())).toEqual({ skipped: 1 });
  });

  it('does not resend nor claim sent an email whose outbox intent conflicts', async () => {
    await notices.create(
      {
        scope_type: 'admin_user',
        tenant_id: 'tenant-a',
        admin_user_id: 'lead',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    const { produceNotificationDelivery } = await import('@authrim/ar-lib-core');
    vi.mocked(produceNotificationDelivery).mockRejectedValueOnce(
      new Error('notification_intent_idempotency_conflict')
    );
    // Not sent again, and not claimed as sent either.
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 1, vi.fn())).toEqual({ skipped: 1 });
  });

  it('reaches another tenant only through a global sign-in role, and honours global `*`', async () => {
    const user = db.prepare(
      `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`
    );
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, display_name, permissions_json,
         hierarchy_level, role_type, is_system, created_at, updated_at)
       VALUES ('role_custom_all', 'tenant-b', 'custom_all', 'All', '["*"]', 1, 'custom', 0, 1, 1)`
    ).run();
    const role = db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id,
         scope_type, scope_id, created_at) VALUES (?, 'tenant-b', ?, ?, ?, ?, 1)`
    );
    // A tenant viewer at home with a global custom role: cannot open tenant-a.
    user.run('mixed', 'tenant-b', 'mixed@b.example');
    role.run('ra-m1', 'mixed', 'role_ar_viewer', 'tenant', 'tenant-b');
    role.run('ra-m2', 'mixed', 'role_custom_all', 'global', null);
    // A global viewer with a global `*` role: platform authority without super admin.
    user.run('star', 'tenant-b', 'star@b.example');
    role.run('ra-s1', 'star', 'role_ar_viewer', 'global', null);
    role.run('ra-s2', 'star', 'role_custom_all', 'global', null);
    const tenant = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 't',
      },
      NOW
    );
    const platform = await notices.create(
      { scope_type: 'platform', severity: 'high', source: 'system', category: 'c', title: 'p' },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    expect(targets(tenant.id)).not.toContain('email:mixed');
    expect(targets(tenant.id)).toContain('email:star');
    // Global `*` is platform authority whichever sign-in role opened the console.
    expect(targets(platform.id)).toEqual(['email:mixed', 'email:root', 'email:star']);
  });

  it('posts a notice behind a permission only to channels whose registering admin sees it', async () => {
    const sealed = await encryptValue(SLACK, KEY, 'AES-256-GCM', 1);
    const channel = db.prepare(
      `INSERT INTO admin_notice_channels (id, scope_type, tenant_id, kind, name,
         webhook_url_encrypted, webhook_url_hint, min_severity, enabled, created_by, created_at,
         updated_at) VALUES (?, 'tenant', 'tenant-a', 'slack', ?, ?, 'hint', 'info', 1, ?, 1, 1)`
    );
    channel.run('ch-lead', 'Lead', sealed.encrypted, 'lead');
    channel.run('ch-watcher', 'Watcher', sealed.encrypted, 'watcher');
    const gated = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'system',
        category: 'c',
        title: 'g',
        required_permission: 'admin:settings:write',
      },
      NOW
    );
    const open = await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'o',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    expect(targets(gated.id).filter((t) => t.startsWith('slack:'))).toEqual(['slack:ch-lead']);
    expect(targets(open.id).filter((t) => t.startsWith('slack:'))).toEqual([
      'slack:ch-lead',
      'slack:ch-watcher',
    ]);
  });

  it('keeps only an error code on a delivery, never a free-form message', async () => {
    await notices.create(
      {
        scope_type: 'admin_user',
        tenant_id: 'tenant-a',
        admin_user_id: 'lead',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    const { produceNotificationDelivery } = await import('@authrim/ar-lib-core');
    vi.mocked(produceNotificationDelivery).mockRejectedValueOnce(
      new Error('D1_ERROR: no such table: secret_things at offset 12')
    );
    await sendDueNoticeDeliveries(env, adapter, NOW + 1, vi.fn());
    expect(db.prepare('SELECT last_error FROM admin_notice_deliveries').get()).toEqual({
      last_error: 'send_failed',
    });
  });

  it('stops posting a gated notice once the channel’s registering admin loses it', async () => {
    const sealed = await encryptValue(SLACK, KEY, 'AES-256-GCM', 1);
    db.prepare(
      `INSERT INTO admin_notice_channels (id, scope_type, tenant_id, kind, name,
         webhook_url_encrypted, webhook_url_hint, min_severity, enabled, created_by, created_at,
         updated_at) VALUES ('ch-lead', 'tenant', 'tenant-a', 'slack', 'Lead', ?, 'hint', 'info',
         1, 'lead', 1, 1)`
    ).run(sealed.encrypted);
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('lead', 0, 'info', 1), ('root', 0, 'info', 1)`
    ).run();
    await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'system',
        category: 'c',
        title: 'g',
        required_permission: 'admin:settings:write',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    db.prepare(`DELETE FROM admin_role_assignments WHERE admin_user_id = 'lead'`).run();
    const fetcher = vi.fn();
    expect(await sendDueNoticeDeliveries(env, adapter, NOW + 1, fetcher)).toEqual({ skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a network error of a Slack post as a code', async () => {
    await slackChannel('tenant-a', 'info');
    db.prepare(
      `INSERT INTO admin_notice_preferences (admin_user_id, email_enabled, email_min_severity,
         updated_at) VALUES ('lead', 0, 'info', 1), ('watcher', 0, 'info', 1), ('root', 0, 'info', 1)`
    ).run();
    await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        severity: 'high',
        source: 'announcement',
        category: 'announcement',
        title: 'x',
      },
      NOW
    );
    await planNoticeDeliveries(adapter, NOW);
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1');
    });
    await sendDueNoticeDeliveries(env, adapter, NOW + 1, fetcher);
    expect(db.prepare('SELECT status, last_error FROM admin_notice_deliveries').get()).toEqual({
      status: 'failed',
      last_error: 'send_failed',
    });
  });
});

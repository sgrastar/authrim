import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
const DatabaseSync = SqliteDatabase as unknown as new (path: string) => Database;

const mocks = vi.hoisted(() => {
  const state: { adapter?: DatabaseAdapter; auth: Record<string, unknown>; tenantId: string } = {
    auth: {},
    tenantId: 'tenant-a',
  };
  return { state, writeAdminAuditLog: vi.fn() };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.state.adapter),
    getTenantIdFromContext: vi.fn(() => mocks.state.tenantId),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.state.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status: number) => Response }, code: string) =>
        c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import {
  adminNoticeChannelsRouter,
  myNoticePreferencesRouter,
} from '../routes/admin-management/admin-notice-delivery';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';

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
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map(({ sql, params = [] }) => ({
        rowsAffected: Number(run(sql).run(...params).changes),
        success: true,
      })),
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

function admin(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    sessionId: 'sess-1',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    globalRoles: [],
    permissions: ['admin:settings:write', 'admin:settings:read'],
    globalPermissions: [],
    tenantScope: ['tenant-a'],
    tenantId: 'tenant-a',
    ...overrides,
  };
}
const PLATFORM = admin({
  userId: 'root',
  permissions: ['*'],
  globalPermissions: ['*'],
  tenantScope: ['*'],
});

const env = { PII_ENCRYPTION_KEY: 'b'.repeat(64) };

function call(
  router: typeof adminNoticeChannelsRouter,
  method: string,
  path: string,
  body?: unknown
) {
  return router.request(
    path,
    {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env
  );
}

describe('admin notice delivery routes', () => {
  let db: Database;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = database());
    mocks.state.adapter = adapter;
    mocks.state.tenantId = 'tenant-a';
    mocks.state.auth = admin();
    db.exec(`INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
      ('admin-1', 'tenant-a', 'a@example.com', 1, 1), ('root', 'default', 'r@example.com', 1, 1)`);
  });

  it('reads and changes the signed-in admin’s email choices, for human sessions only', async () => {
    const initial = await call(myNoticePreferencesRouter, 'GET', '/');
    expect(await initial.json()).toEqual({
      preferences: { email_enabled: true, email_min_severity: 'high', updated_at: null },
    });
    expect(
      (await call(myNoticePreferencesRouter, 'PUT', '/', { email_enabled: 'yes' })).status
    ).toBe(400);
    const saved = await call(myNoticePreferencesRouter, 'PUT', '/', {
      email_enabled: false,
      email_min_severity: 'critical',
    });
    expect(await saved.json()).toMatchObject({
      preferences: { email_enabled: false, email_min_severity: 'critical' },
    });
    mocks.state.auth = admin({ authMethod: 'bearer', sessionId: undefined });
    expect((await call(myNoticePreferencesRouter, 'GET', '/')).status).toBe(403);
  });

  it('registers a Slack channel with its URL encrypted and never shown back', async () => {
    expect(
      (
        await call(adminNoticeChannelsRouter, 'POST', '/', {
          name: 'Ops',
          webhook_url: 'https://example.com/hook',
        })
      ).status
    ).toBe(400);
    const created = await call(adminNoticeChannelsRouter, 'POST', '/', {
      name: 'Ops',
      webhook_url: SLACK,
      min_severity: 'critical',
    });
    expect(created.status).toBe(201);
    const { channel } = await created.json<{ channel: Record<string, unknown> }>();
    expect(channel).toMatchObject({
      scope_type: 'tenant',
      tenant_id: 'tenant-a',
      webhook_url_hint: 'hooks.slack.com/services/T000/…',
      min_severity: 'critical',
    });
    expect(JSON.stringify(channel)).not.toContain('XXXX');
    const stored = db
      .prepare('SELECT webhook_url_encrypted AS v FROM admin_notice_channels')
      .get() as {
      v: string;
    };
    expect(stored.v).not.toContain('hooks.slack.com');

    const list = await call(adminNoticeChannelsRouter, 'GET', '/');
    expect(JSON.stringify(await list.json())).not.toContain('XXXX');
  });

  it('keeps platform channels to platform admins and other tenants’ channels hidden', async () => {
    expect(
      (
        await call(adminNoticeChannelsRouter, 'POST', '/', {
          scope_type: 'platform',
          name: 'P',
          webhook_url: SLACK,
        })
      ).status
    ).toBe(403);
    mocks.state.auth = PLATFORM;
    const platform = await (
      await call(adminNoticeChannelsRouter, 'POST', '/', {
        scope_type: 'platform',
        name: 'P',
        webhook_url: SLACK,
      })
    ).json<{ channel: { id: string } }>();
    mocks.state.auth = admin();
    const mine = await (
      await call(adminNoticeChannelsRouter, 'POST', '/', { name: 'A', webhook_url: SLACK })
    ).json<{ channel: { id: string } }>();

    expect(
      (
        await call(adminNoticeChannelsRouter, 'PATCH', `/${platform.channel.id}`, {
          enabled: false,
        })
      ).status
    ).toBe(404);
    expect(
      (await call(adminNoticeChannelsRouter, 'DELETE', `/${platform.channel.id}`)).status
    ).toBe(404);
    mocks.state.tenantId = 'tenant-b';
    expect(
      (await call(adminNoticeChannelsRouter, 'PATCH', `/${mine.channel.id}`, { enabled: false }))
        .status
    ).toBe(404);
    mocks.state.tenantId = 'tenant-a';

    const updated = await call(adminNoticeChannelsRouter, 'PATCH', `/${mine.channel.id}`, {
      enabled: false,
      min_severity: 'info',
    });
    expect(await updated.json()).toMatchObject({
      channel: { enabled: false, min_severity: 'info' },
    });
    const replaced = await call(
      adminNoticeChannelsRouter,
      'PUT',
      `/${mine.channel.id}/webhook-url`,
      {
        webhook_url: 'https://hooks.slack.com/services/T999/B1/Y',
      }
    );
    expect(await replaced.json()).toMatchObject({
      channel: { webhook_url_hint: 'hooks.slack.com/services/T999/…' },
    });
    expect((await call(adminNoticeChannelsRouter, 'DELETE', `/${mine.channel.id}`)).status).toBe(
      200
    );
    mocks.state.auth = PLATFORM;
    const all = await (
      await call(adminNoticeChannelsRouter, 'GET', '/')
    ).json<{ items: Array<{ name: string }> }>();
    expect(all.items.map((item) => item.name)).toEqual(['P']);
  });
});

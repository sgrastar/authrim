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
// The package has no Node types, so the driver is typed by the little these tests use.
const DatabaseSync = SqliteDatabase as unknown as new (path: string) => Database;
type DatabaseSync = Database;

const mocks = vi.hoisted(() => {
  const auth: Record<string, unknown> = {};
  const state: { adapter?: DatabaseAdapter } = {};
  return {
    state,
    auth,
    tenantId: 'tenant-a',
    writeAdminAuditLog: vi.fn(),
  };
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
    getTenantIdFromContext: vi.fn(() => mocks.tenantId),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status: number) => Response }, code: string) =>
        c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import { adminNoticesRouter } from '../routes/admin-management/admin-notices';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);

/** The admin tables the notices touch, on an in-memory SQLite database. */
function database(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE internal_notification_events (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
      last_error TEXT, next_attempt_at TEXT, updated_at TEXT
    );
  `);
  db.exec(readRenderedMigrationSql(ADMIN_MIGRATIONS, '006_admin_notices.sql'));
  const run = (sql: string) => db.prepare(sql);
  const adapter = {
    query: async (sql: string, params: unknown[] = []) => run(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => run(sql).get(...params) ?? null,
    execute: async (sql: string, params: unknown[] = []) => {
      const result = run(sql).run(...params);
      return { rowsAffected: Number(result.changes), success: true };
    },
    // All or nothing, as D1's batch is.
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

function admin(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    sessionId: 'sess-1',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    globalRoles: [],
    permissions: ['admin:settings:write', 'admin:clients:read'],
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

function call(method: string, path: string, body?: unknown) {
  return adminNoticesRouter.request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface NoticeBody {
  notice: { id: string; tenant_id: string | null; resolved_by: string | null };
  field?: string;
}

async function publish(body: Record<string, unknown>) {
  const response = await call('POST', '/', { severity: 'info', title: 'Hello', ...body });
  return { status: response.status, json: await response.json<NoticeBody>() };
}

async function inbox(): Promise<string[]> {
  const response = await call('GET', '/');
  const json = await response.json<{ items: Array<{ title: string }> }>();
  return json.items.map((item) => item.title);
}

describe('admin notices routes', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = database());
    mocks.state.adapter = adapter;
    mocks.tenantId = 'tenant-a';
    mocks.auth = admin();
    mocks.writeAdminAuditLog.mockReset();
    db.exec(`INSERT INTO admin_users (id, tenant_id, email) VALUES
      ('admin-1', 'tenant-a', 'a1@example.com'),
      ('admin-2', 'tenant-a', 'a2@example.com'),
      ('admin-3', 'tenant-b', 'b3@example.com')`);
  });

  it('publishes to each audience and shows it only to that audience', async () => {
    expect((await publish({ scope_type: 'tenant', title: 'tenant' })).status).toBe(201);
    expect(
      (await publish({ scope_type: 'client', client_id: 'app-1', title: 'client' })).status
    ).toBe(201);
    expect(
      (await publish({ scope_type: 'admin_user', admin_user_id: 'admin-2', title: 'to 2' })).status
    ).toBe(201);
    mocks.auth = PLATFORM;
    expect((await publish({ scope_type: 'platform', title: 'platform' })).status).toBe(201);

    mocks.auth = admin();
    expect((await inbox()).sort()).toEqual(['client', 'tenant']);
    mocks.auth = admin({ userId: 'admin-2', permissions: [] });
    expect((await inbox()).sort()).toEqual(['tenant', 'to 2']);
    mocks.auth = PLATFORM;
    expect((await inbox()).sort()).toEqual(['client', 'platform', 'tenant']);
    mocks.tenantId = 'tenant-b';
    mocks.auth = admin({ userId: 'admin-3', tenantScope: ['tenant-b'], tenantId: 'tenant-b' });
    expect(await inbox()).toEqual([]);
  });

  it('keeps platform announcements and other tenants’ admins to platform admins', async () => {
    expect((await publish({ scope_type: 'platform' })).status).toBe(403);
    const other = await publish({ scope_type: 'admin_user', admin_user_id: 'admin-3' });
    expect(other).toMatchObject({ status: 400, json: { field: 'admin_user_id' } });

    mocks.auth = PLATFORM;
    const created = await publish({ scope_type: 'admin_user', admin_user_id: 'admin-3' });
    expect(created).toMatchObject({ status: 201, json: { notice: { tenant_id: 'tenant-b' } } });
  });

  it('validates an announcement', async () => {
    const now = Date.now();
    for (const [body, field] of [
      [{ scope_type: 'galaxy' }, 'scope_type'],
      [{ scope_type: 'tenant', severity: 'medium' }, 'severity'],
      [{ scope_type: 'tenant', title: ' ' }, 'title'],
      [{ scope_type: 'tenant', title: 'x'.repeat(201) }, 'title'],
      [{ scope_type: 'tenant', link: 'https://example.com' }, 'link'],
      [{ scope_type: 'tenant', link: '//example.com/admin/' }, 'link'],
      [{ scope_type: 'client' }, 'client_id'],
      [{ scope_type: 'tenant', expires_at: now - 1 }, 'expires_at'],
      [{ scope_type: 'tenant', expires_at: now + 400 * 24 * 3600 * 1000 }, 'expires_at'],
    ] as const) {
      expect(await publish(body), field).toMatchObject({ status: 400, json: { field } });
    }
  });

  it('dismisses information for one admin and refuses to dismiss anything else', async () => {
    const info = (await publish({ scope_type: 'tenant', title: 'info' })).json.notice;
    const high = (await publish({ scope_type: 'tenant', severity: 'high', title: 'high' })).json
      .notice;

    expect((await call('POST', `/${high.id}/dismiss`)).status).toBe(409);
    expect((await call('POST', `/${info.id}/dismiss`)).status).toBe(200);
    expect(await inbox()).toEqual(['high']);
    mocks.auth = admin({ userId: 'admin-2' });
    expect((await inbox()).sort()).toEqual(['high', 'info']);
  });

  it('keeps information per admin: no resolving it, no dismissing it with a machine token', async () => {
    const info = (await publish({ scope_type: 'tenant', title: 'info' })).json.notice;
    const refused = await call('POST', `/${info.id}/resolve`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'notice_not_resolvable' });

    mocks.auth = admin({ userId: 'amp_robot', authMethod: 'bearer', sessionId: undefined });
    expect((await call('POST', `/${info.id}/dismiss`)).status).toBe(403);
    mocks.auth = admin();
    expect(await inbox()).toEqual(['info']);
  });

  it('resolves for everyone, once, with the right authority', async () => {
    const high = (await publish({ scope_type: 'tenant', severity: 'high', title: 'high' })).json
      .notice;

    mocks.auth = admin({ userId: 'admin-2', permissions: ['admin:settings:read'] });
    expect((await call('POST', `/${high.id}/resolve`)).status).toBe(403);

    mocks.auth = admin();
    const resolved = await call('POST', `/${high.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ notice: { resolved_by: 'admin-1' } });
    expect((await call('POST', `/${high.id}/resolve`)).status).toBe(409);
    mocks.auth = admin({ userId: 'admin-2' });
    expect(await inbox()).toEqual([]);
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.notice.resolved', resourceId: high.id })
    );
  });

  it('lets the addressee resolve a notice to them, and nobody see another tenant’s', async () => {
    const mine = (
      await publish({
        scope_type: 'admin_user',
        admin_user_id: 'admin-2',
        severity: 'caution',
        title: 'mine',
      })
    ).json.notice;
    mocks.auth = admin({ userId: 'admin-2', permissions: [] });
    expect((await call('POST', `/${mine.id}/resolve`)).status).toBe(200);

    const tenant = (await publish({ scope_type: 'tenant', title: 'a only' })).json.notice;
    mocks.tenantId = 'tenant-b';
    mocks.auth = admin({ userId: 'admin-3', tenantScope: ['tenant-b'] });
    expect((await call('GET', `/${tenant.id}`)).status).toBe(404);
    expect((await call('POST', `/${tenant.id}/resolve`)).status).toBe(404);
  });

  it('closes the operational event behind a resolved notice', async () => {
    db.exec(`INSERT INTO internal_notification_events (id, tenant_id, status)
             VALUES ('evt-1', 'tenant-a', 'failed')`);
    db.exec(`INSERT INTO admin_notices (id, scope_type, tenant_id, severity, source, category,
               title, source_ref, deduplication_key, created_at)
             VALUES ('n-1', 'tenant', 'tenant-a', 'high', 'system', 'logging_delivery_failure',
               'failed', 'evt-1', 'ine:evt-1', 1)`);
    expect((await call('POST', '/n-1/resolve')).status).toBe(200);
    expect(db.prepare(`SELECT status FROM internal_notification_events`).get()).toEqual({
      status: 'suppressed',
    });
  });

  it('finishes both on a retry when closing the event failed', async () => {
    db.exec(`INSERT INTO admin_notices (id, scope_type, tenant_id, severity, source, category,
               title, source_ref, deduplication_key, created_at)
             VALUES ('n-2', 'tenant', 'tenant-a', 'high', 'system', 'logging_delivery_failure',
               'failed', 'evt-2', 'ine:evt-2', 1)`);
    db.exec('ALTER TABLE internal_notification_events RENAME TO events_away');
    expect((await call('POST', '/n-2/resolve')).status).toBe(500);
    db.exec('ALTER TABLE events_away RENAME TO internal_notification_events');
    db.exec(`INSERT INTO internal_notification_events (id, tenant_id, status)
             VALUES ('evt-2', 'tenant-a', 'pending')`);

    expect((await call('POST', '/n-2/resolve')).status).toBe(200);
    expect(
      db.prepare(`SELECT status FROM internal_notification_events WHERE id = 'evt-2'`).get()
    ).toEqual({ status: 'suppressed' });
  });
});

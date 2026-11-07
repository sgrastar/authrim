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
  const state: {
    adapter?: DatabaseAdapter;
    auth: Record<string, unknown>;
    settings: Record<string, unknown> | Error;
    deliveryAvailable: boolean;
  } = { auth: {}, settings: {}, deliveryAvailable: true };
  return {
    state,
    writeAdminAuditLog: vi.fn(),
    produceNotificationDelivery: vi.fn(),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.state.adapter),
    resolvePlatformSettingsWithSources: vi.fn(async () => {
      if (mocks.state.settings instanceof Error) throw mocks.state.settings;
      return { values: mocks.state.settings, sources: {} };
    }),
    isNotificationDeliveryAvailable: vi.fn(async () => mocks.state.deliveryAvailable),
    produceNotificationDelivery: mocks.produceNotificationDelivery,
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

import { Hono } from 'hono';
import { hasAdminPermission } from '@authrim/ar-lib-core';
import { adminLastResortRecoveryRouter } from '../routes/admin-management/admin-last-resort-recovery';
import { findAdminRouteAccessRule } from '../admin-route-access';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);
const PATH = '/api/admin/platform/last-resort-recovery/second-factors';
const DAY_MS = 24 * 60 * 60 * 1000;

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
    '010_keyring_second_factor_recoveries.sql',
    '011_admin_second_factor_reenroll_window.sql',
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

const app = new Hono();
app.route('/api/admin/platform/last-resort-recovery', adminLastResortRecoveryRouter);

const post = (body: unknown) =>
  app.request(
    PATH,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    {}
  );

function setupMachine(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'amp_authrim_setup',
    actorId: 'amp_authrim_setup',
    actorType: 'machine',
    authMethod: 'machine_access_token',
    permissions: ['admin:last_resort_recovery'],
    globalPermissions: ['admin:last_resort_recovery'],
    tenantScope: ['*'],
    roles: [],
    ...overrides,
  };
}

describe('last-resort second-factor recovery', () => {
  let db: Database;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = database());
    mocks.state.adapter = adapter;
    mocks.state.auth = setupMachine();
    mocks.state.settings = {};
    mocks.state.deliveryAvailable = true;
    mocks.writeAdminAuditLog.mockReset().mockResolvedValue('audit-1');
    mocks.produceNotificationDelivery
      .mockReset()
      .mockResolvedValue({ reference: 'r', bindingRef: 'b', delivery: 'pending' });
    db.exec(`
      INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
        ('solo', 'default', 'Solo@Example.com', 1, 1);
      INSERT INTO admin_second_factors (id, admin_user_id, kind, credential_id, public_key,
        created_at) VALUES ('sf-1', 'solo', 'webauthn_credential', 'cred-1', 'cGs=', 1);
      INSERT INTO admin_second_factors (id, admin_user_id, kind, holder_jkt, created_at)
        VALUES ('sf-2', 'solo', 'keyring_holder_key', 'jkt-1', 2);
      INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at,
        second_factor_id, second_factor_verified_at)
        VALUES ('sess-1', 'default', 'solo', 1, 9999999999999, 'sf-1', 5);
    `);
  });

  it('declares the route for the exact permission only, which no wildcard carries', () => {
    const rule = findAdminRouteAccessRule('POST', PATH);
    expect(rule?.permissions).toEqual(['admin:last_resort_recovery']);
    expect(rule?.roles).toBeUndefined();
    expect(hasAdminPermission(['*'], 'admin:last_resort_recovery')).toBe(false);
    expect(hasAdminPermission(['admin:*'], 'admin:last_resort_recovery')).toBe(false);
    expect(hasAdminPermission(['admin:last_resort_recovery'], 'admin:last_resort_recovery')).toBe(
      true
    );
  });

  it('recovers the only admin: revokes the factors, ends sessions, opens the window, notifies', async () => {
    const before = Date.now();
    const response = await post({ email: 'solo@example.com', reason: 'lost phone' });

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      admin: { id: 'solo', tenant_id: 'default' },
      revoked_second_factors: 2,
      ended_sessions: 1,
      cancelled_recovery_requests: 0,
      sole_admin: true,
      audit_logged: true,
      notices: { emailed: true, email_recipients: 1, console: true },
    });
    const until = body.reenroll_until as number;
    expect(until).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + DAY_MS);

    // The rows stay, revoked.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM admin_second_factors WHERE revoked_at IS NULL').get()
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_second_factors').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT second_factor_reenroll_until AS until FROM admin_users WHERE id = 'solo'")
        .get()
    ).toEqual({ until });

    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.second_factor.last_resort_recovery',
        resourceId: 'solo',
        severity: 'critical',
        metadata: expect.objectContaining({
          revoked_second_factor_ids: ['sf-1', 'sf-2'],
          sole_admin: true,
          reason: 'lost phone',
        }) as unknown,
      })
    );
    const [, delivery] = mocks.produceNotificationDelivery.mock.calls[0] as [
      unknown,
      { owner: unknown; payload: { to: string } },
    ];
    expect(delivery.owner).toEqual({ owner: 'platform' });
    expect(delivery.payload.to).toBe('Solo@Example.com');
    expect(
      db
        .prepare('SELECT scope_type, severity, message_key FROM admin_notices ORDER BY scope_type')
        .all()
    ).toEqual([
      {
        scope_type: 'platform',
        severity: 'critical',
        message_key: 'second_factor_last_resort_recovery',
      },
      {
        scope_type: 'tenant',
        severity: 'critical',
        message_key: 'second_factor_last_resort_recovery',
      },
    ]);
  });

  it('emails every active administrator of the system, and cancels an open recovery request', async () => {
    db.exec(`
      INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
        ('other', 'tenant-b', 'other@example.com', 1, 1);
      INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at, is_active) VALUES
        ('gone', 'tenant-b', 'gone@example.com', 1, 1, 0);
      INSERT INTO admin_second_factor_recoveries (
        id, admin_user_id, tenant_id, status, kind, credential_id, public_key,
        requested_session_id, requested_at, not_before, expires_at
      ) VALUES ('rec-1', 'solo', 'default', 'pending', 'webauthn_credential', 'cred-x', 'cGs=',
        'sess-0', 1, 2, 9999999999999);
    `);

    const response = await post({ email: 'solo@example.com' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sole_admin: false,
      cancelled_recovery_requests: 1,
      notices: { emailed: true, email_recipients: 2 },
    });
    const recipients = mocks.produceNotificationDelivery.mock.calls
      .map(([, input]) => (input as { payload: { to: string } }).payload.to)
      .sort();
    expect(recipients).toEqual(['Solo@Example.com', 'other@example.com']);
    expect(
      db.prepare('SELECT status, cancel_reason FROM admin_second_factor_recoveries').get()
    ).toEqual({ status: 'cancelled', cancel_reason: 'last_resort' });
  });

  it('reports when email delivery is not available, after the recovery took effect', async () => {
    mocks.state.deliveryAvailable = false;

    const response = await post({ email: 'solo@example.com' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revoked_second_factors: 2,
      notices: { emailed: false, email_recipients: 0, console: true },
    });
    expect(mocks.produceNotificationDelivery).not.toHaveBeenCalled();
  });

  it('takes the window from the platform setting, within its bounds, and the default otherwise', async () => {
    mocks.state.settings = { 'security.admin_last_resort_reenroll_window_seconds': 3600 };
    let before = Date.now();
    let body = await (await post({ email: 'solo@example.com' })).json<{ reenroll_until: number }>();
    expect(body.reenroll_until - before).toBeGreaterThanOrEqual(3_600_000);
    expect(body.reenroll_until - before).toBeLessThan(3_600_000 + 5_000);

    mocks.state.settings = { 'security.admin_last_resort_reenroll_window_seconds': 30 * DAY_MS };
    before = Date.now();
    body = await (await post({ email: 'solo@example.com' })).json<{ reenroll_until: number }>();
    expect(body.reenroll_until - before).toBeLessThan(72 * 3_600_000 + 5_000);

    mocks.state.settings = new Error('kv down');
    before = Date.now();
    body = await (await post({ email: 'solo@example.com' })).json<{ reenroll_until: number }>();
    expect(body.reenroll_until - before).toBeGreaterThanOrEqual(DAY_MS);
    expect(body.reenroll_until - before).toBeLessThan(DAY_MS + 5_000);
  });

  it.each([
    ['a signed-in admin', { authMethod: 'session', actorType: 'human', sessionId: 's' }],
    ['a machine with only a wildcard', { permissions: ['*'] }],
    ['a machine without the permission', { permissions: ['admin:admin_users:write'] }],
    [
      'a machine whose token reaches only some tenants',
      { globalPermissions: [], tenantScope: ['default'] },
    ],
  ])('refuses %s and changes nothing', async (_label, overrides) => {
    mocks.state.auth = setupMachine(overrides);

    expect((await post({ email: 'solo@example.com' })).status).toBe(403);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM admin_second_factors WHERE revoked_at IS NULL').get()
    ).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 1 });
  });

  it('refuses a machine principal as the target', async () => {
    db.exec(`
      INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
        ('amp_bot', 'default', 'bot@example.com', 1, 1);
      INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
        default_audience, token_ttl_seconds, created_at, updated_at)
        VALUES ('amp_bot', 'bot', 'Bot', 'automation', 'active', 'aud', 600, 1, 1);
    `);

    const response = await post({ email: 'bot@example.com' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'target_not_human_admin' });
  });

  it('asks for the tenant when admins of several tenants share the email', async () => {
    db.exec(`
      INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
        ('twin', 'tenant-b', 'solo@example.com', 1, 1);
    `);

    const ambiguous = await post({ email: 'solo@example.com' });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({
      error: 'admin_ambiguous',
      tenant_ids: ['default', 'tenant-b'],
    });

    const named = await post({ email: 'solo@example.com', tenant_id: 'tenant-b' });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ admin: { id: 'twin' }, revoked_second_factors: 0 });
  });

  it.each([
    [{ email: 'nobody@example.com' }, 404],
    [{ email: 'not-an-email' }, 400],
    [{ email: 'solo@example.com', tenant_id: 'Bad Tenant' }, 400],
    [{ email: 'solo@example.com', reason: 'x'.repeat(201) }, 400],
  ])('refuses %j with %i', async (body, status) => {
    expect((await post(body)).status).toBe(status);
  });

  it('refuses an admin who is not active', async () => {
    db.exec("UPDATE admin_users SET status = 'suspended' WHERE id = 'solo'");
    const response = await post({ email: 'solo@example.com' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'admin_not_active' });
  });
});

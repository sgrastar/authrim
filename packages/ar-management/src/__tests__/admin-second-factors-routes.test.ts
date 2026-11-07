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
    stepUp: Response | null;
  } = { auth: {}, stepUp: null };
  return {
    state,
    requireAdminStepUp: vi.fn(),
    writeAdminAuditLog: vi.fn(),
    produceNotificationDelivery: vi.fn(),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: mocks.requireAdminStepUp,
  refuseAdminFreshAuth: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.state.adapter),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    isNotificationDeliveryAvailable: vi.fn(async () => true),
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
import { adminSecondFactorsRouter } from '../routes/admin-management/admin-second-factors';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);

function database(): { db: Database; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    '001_0_5_0_admin_baseline.sql',
    '003_admin_session_passkey_evidence.sql',
    '004_admin_second_factors.sql',
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
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map(({ sql, params = [] }) => ({
        rowsAffected: Number(run(sql).run(...params).changes),
        success: true,
      })),
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

const app = new Hono();
app.route('/api/admin/admins/:id/second-factors', adminSecondFactorsRouter);

const call = (method: string, path: string) =>
  app.request(`/api/admin/admins${path}`, { method }, {});

function admin(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'lead',
    sessionId: 'sess-1',
    authMethod: 'session',
    actorType: 'human',
    roles: ['ar_tenant_admin'],
    permissions: ['admin:admin_users:read', 'admin:admin_users:write'],
    hierarchyLevel: 80,
    tenantScope: ['tenant-a'],
    tenantId: 'tenant-a',
    ...overrides,
  };
}

describe("another admin's second factors", () => {
  let db: Database;

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = database());
    mocks.state.adapter = adapter;
    mocks.state.auth = admin();
    mocks.requireAdminStepUp.mockReset().mockResolvedValue(null);
    mocks.writeAdminAuditLog.mockReset();
    mocks.produceNotificationDelivery
      .mockReset()
      .mockResolvedValue({ reference: 'r', bindingRef: 'b', delivery: 'pending' });
    db.exec(`
      INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES
        ('lead', 'tenant-a', 'lead@a.example', 1, 1),
        ('member', 'tenant-a', 'member@a.example', 1, 1),
        ('outsider', 'tenant-b', 'outsider@b.example', 1, 1);
      INSERT INTO admin_second_factors (id, admin_user_id, kind, credential_id, public_key, label,
        created_at) VALUES
        ('sf-1', 'member', 'webauthn_credential', 'cred-1', 'cGs=', 'Blue key', 1),
        ('sf-out', 'outsider', 'webauthn_credential', 'cred-2', 'cGs=', null, 1);
      INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at,
        second_factor_id, second_factor_verified_at)
        VALUES ('sess-m', 'tenant-a', 'member', 1, 9999999999999, 'sf-1', 5);
    `);
  });

  it('lists the keys of an admin of the tenant, and nobody else’s', async () => {
    const listed = await call('GET', '/member/second-factors');
    expect(await listed.json()).toMatchObject({
      second_factors: [{ id: 'sf-1', label: 'Blue key', revoked_at: null }],
    });
    expect((await call('GET', '/outsider/second-factors')).status).toBe(404);
  });

  it('revokes another admin’s last key with L2, clears it from their sessions and tells them', async () => {
    const response = await call('DELETE', '/member/second-factors/sf-1');

    expect(response.status).toBe(200);
    expect(mocks.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'admin_credential.revoke',
      targetTenantId: 'tenant-a',
      targetIds: ['member', 'sf-1'],
    });
    expect(
      db
        .prepare(
          "SELECT revoked_at IS NOT NULL AS revoked FROM admin_second_factors WHERE id = 'sf-1'"
        )
        .get()
    ).toEqual({ revoked: 1 });
    expect(
      db.prepare("SELECT second_factor_id FROM admin_sessions WHERE id = 'sess-m'").get()
    ).toEqual({ second_factor_id: null });
    const [, delivery] = mocks.produceNotificationDelivery.mock.calls[0] as [
      unknown,
      { payload: { to: string } },
    ];
    expect(delivery.payload.to).toBe('member@a.example');
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.second_factor.revoked_by_admin',
        resourceId: 'sf-1',
      })
    );
  });

  it('changes nothing until the step-up is met', async () => {
    mocks.requireAdminStepUp.mockResolvedValue(
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
    );

    expect((await call('DELETE', '/member/second-factors/sf-1')).status).toBe(403);
    expect(
      db.prepare("SELECT revoked_at FROM admin_second_factors WHERE id = 'sf-1'").get()
    ).toEqual({ revoked_at: null });
  });

  it.each([
    ['one’s own key', '/lead/second-factors/sf-1', 400],
    ['an admin of another tenant', '/outsider/second-factors/sf-out', 404],
    ['a key that is not the admin’s', '/member/second-factors/sf-out', 404],
  ])('refuses %s before any step-up', async (_label, path, status) => {
    expect((await call('DELETE', path)).status).toBe(status);
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('refuses an admin without authority over the account before any step-up', async () => {
    mocks.state.auth = admin({ hierarchyLevel: 0 });
    db.exec(`
      INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type,
        scope_id, created_at) VALUES ('ra-m', 'tenant-a', 'member', 'role_ar_tenant_admin',
        'tenant', 'tenant-a', 1);
    `);

    expect((await call('DELETE', '/member/second-factors/sf-1')).status).toBe(403);
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    // Nor does it see which keys that account holds.
    expect((await call('GET', '/member/second-factors')).status).toBe(403);
  });
});

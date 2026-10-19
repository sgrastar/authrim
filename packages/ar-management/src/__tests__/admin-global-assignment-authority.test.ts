import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware, type DatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';
import { adminUsersRouter } from '../routes/admin-management/admins';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

/**
 * Who may give an Admin a global assignment. A global assignment takes effect for every tenant,
 * so it is the way into everything the platform owns. These run the real admin-auth middleware
 * and the real routes on the real Admin schema, so the roles and permissions that
 * `adminAuth` adds up from all of an Admin's assignments are the ones the routes see.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

function openAdminDatabase(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/admin/d1/001_0_4_0_admin_baseline.sql'), 'utf8')
      .replaceAll(
        '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
        "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)"
      )
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  return db;
}

function sqliteAdapter(db: SQLiteDatabase): DatabaseAdapter {
  const bind = (params: unknown[] = []) => params.map((value) => (value ?? null) as SQLInputValue);
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...bind(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...bind(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      const result = db.prepare(sql).run(...bind(params));
      return { rowsAffected: Number(result.changes), success: true };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await fn(adapter);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      return Promise.all(statements.map((item) => adapter.execute(item.sql, item.params)));
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 1, type: 'sqlite' };
    },
    getType: () => 'sqlite',
    async close() {},
  };
  return adapter as unknown as DatabaseAdapter;
}

const TENANT = 'tenant-a';
let sessions = 0;

type Assignment = { role: string; scope: 'global' | 'tenant' };

/** An Admin of the tenant with these assignments, signed in; returns the session cookie. */
function signIn(db: SQLiteDatabase, assignments: Assignment[]): { userId: string; cookie: string } {
  sessions += 1;
  const userId = `admin-${sessions}`;
  const sessionId = `session-${sessions}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?)`
  ).run(userId, TENANT, `${userId}@example.test`, now, now);
  db.prepare(
    `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at, mfa_verified)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(sessionId, TENANT, userId, now, now + 3_600_000);
  assignments.forEach((assignment, index) => {
    db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${userId}-assignment-${index}`,
      TENANT,
      userId,
      assignment.role,
      assignment.scope,
      assignment.scope === 'tenant' ? TENANT : null,
      now
    );
  });
  return { userId, cookie: `authrim_admin_session=${sessionId}` };
}

function setup() {
  const db = openAdminDatabase();
  const adapter = sqliteAdapter(db);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', TENANT);
    await next();
  });
  app.route('/api/admin/admin-roles', adminRolesRouter);
  app.route('/api/admin/admins', adminUsersRouter);
  // What a session ends up with after its assignments are added up.
  app.use('/probe/*', adminAuthMiddleware({ plane: 'tenant' }));
  app.get('/probe/:tenant', (c) =>
    c.json((c as unknown as { get(key: string): unknown }).get('adminAuth') as object)
  );
  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(
      path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': TENANT,
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };
  const globalAssignments = () =>
    db
      .prepare("SELECT COUNT(*) AS n FROM admin_role_assignments WHERE scope_type = 'global'")
      .get() as {
      n: number;
    };
  return { db, call, globalAssignments };
}

const TENANT_SUPER_ADMIN: Assignment[] = [{ role: 'role_super_admin', scope: 'tenant' }];
const GLOBAL_SUPER_ADMIN: Assignment[] = [{ role: 'role_super_admin', scope: 'global' }];

/** The chain: make a custom role that holds the wildcard, then assign it to oneself globally. */
async function escalate(context: ReturnType<typeof setup>, assignments: Assignment[]) {
  const actor = signIn(context.db, assignments);
  const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
    name: `escalation-${sessions}`,
    permissions: ['*'],
    hierarchy_level: 10,
  });
  expect(created.status).toBe(201);
  const roleId = created.json.id as string;
  const assigned = await context.call(
    actor.cookie,
    'POST',
    `/api/admin/admin-roles/${roleId}/assignments`,
    { admin_user_id: actor.userId, scope_type: 'global' }
  );
  return { actor, roleId, assigned };
}

describe('giving an Admin a global assignment', () => {
  it('refuses a tenant-limited super_admin the chain of a wildcard role and a global self-assignment', async () => {
    const context = setup();

    const { actor, assigned } = await escalate(context, TENANT_SUPER_ADMIN);

    expect(assigned.status).toBe(403);
    expect(context.globalAssignments()).toEqual({ n: 0 });
    const probe = await context.call(actor.cookie, 'GET', '/probe/tenant-a');
    expect(probe.json.tenantScope).toEqual([TENANT]);
    expect(probe.json.globalRoles).toEqual([]);
  });

  it('refuses the same chain made by creating a tenant assignment first and widening it', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'widening',
      permissions: ['*'],
      hierarchy_level: 10,
    });
    const roleId = created.json.id as string;
    const tenantAssignment = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admin-roles/${roleId}/assignments`,
      { admin_user_id: actor.userId, scope_type: 'tenant' }
    );
    expect(tenantAssignment.status).toBe(201);

    const widened = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/${roleId}/assignments/${tenantAssignment.json.id}`,
      { scope_type: 'global' }
    );

    expect(widened.status).toBe(403);
    expect(context.globalAssignments()).toEqual({ n: 0 });
  });

  it('refuses a tenant-limited super_admin a global assignment through the Admin user route', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'via-user-route',
      permissions: ['*'],
      hierarchy_level: 10,
    });

    const assigned = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${actor.userId}/roles`,
      { role_id: created.json.id, scope_type: 'global' }
    );

    expect(assigned.status).toBe(403);
    expect(context.globalAssignments()).toEqual({ n: 0 });
  });

  it('refuses an Admin whose wildcard is held for the tenant while a global role is only a viewer', async () => {
    const context = setup();
    const actor = signIn(context.db, [
      { role: 'role_viewer', scope: 'global' },
      ...TENANT_SUPER_ADMIN,
    ]);
    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'mixed',
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
    });
    expect(created.status).toBe(201);

    const assigned = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admin-roles/${created.json.id}/assignments`,
      { admin_user_id: actor.userId, scope_type: 'global' }
    );

    expect(assigned.status).toBe(403);
    expect(context.globalAssignments()).toEqual({ n: 1 });
  });

  it('still lets a global super_admin do it', async () => {
    const context = setup();

    const { assigned } = await escalate(context, GLOBAL_SUPER_ADMIN);

    expect(assigned.status).toBe(201);
    expect(assigned.json.scope_type).toBe('global');
  });

  it('lets a global super_admin widen an assignment, and give one through the Admin user route', async () => {
    const context = setup();
    const actor = signIn(context.db, [
      { role: 'role_viewer', scope: 'tenant' },
      ...GLOBAL_SUPER_ADMIN,
    ]);
    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'widening-ok',
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
    });
    const roleId = created.json.id as string;
    const tenantAssignment = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admin-roles/${roleId}/assignments`,
      { admin_user_id: actor.userId, scope_type: 'tenant' }
    );

    const widened = await context.call(
      actor.cookie,
      'PATCH',
      `/api/admin/admin-roles/${roleId}/assignments/${tenantAssignment.json.id}`,
      { scope_type: 'global' }
    );
    const viaUserRoute = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admins/${actor.userId}/roles`,
      { role_id: 'role_support', scope_type: 'global' }
    );

    expect(widened.status).toBe(200);
    expect(viaUserRoute.status).toBe(201);
  });

  it('lets a tenant-limited super_admin assign roles within the tenant', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const created = await context.call(actor.cookie, 'POST', '/api/admin/admin-roles', {
      name: 'tenant-only',
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
    });

    const assigned = await context.call(
      actor.cookie,
      'POST',
      `/api/admin/admin-roles/${created.json.id}/assignments`,
      { admin_user_id: actor.userId, scope_type: 'tenant' }
    );

    expect(assigned.status).toBe(201);
  });
});

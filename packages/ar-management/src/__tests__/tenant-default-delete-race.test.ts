import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * `set-default` and `DELETE` on the same tenant, run on a real SQLite tenants table (with the
 * unique default guard) through the real handlers and the real statements: whichever runs its
 * write first wins and the other is refused with 409, so a default tenant is never `deleting`.
 */
interface Hooks {
  db: unknown;
  beforeExecute: null | { match: RegExp; run: () => Promise<void> };
  beforeBatch: null | (() => Promise<void>);
}
const hooks = vi.hoisted((): Hooks => ({ db: null, beforeExecute: null, beforeBatch: null }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const database = () => hooks.db as SQLiteDatabase;
  const adapter = {
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      database()
        .prepare(sql)
        .get(...params) ?? null,
    query: async (sql: string, params: SQLInputValue[] = []) =>
      database()
        .prepare(sql)
        .all(...params),
    execute: async (sql: string, params: SQLInputValue[] = []) => {
      const hook = hooks.beforeExecute;
      if (hook?.match.test(sql)) {
        hooks.beforeExecute = null;
        await hook.run();
      }
      const result = database()
        .prepare(sql)
        .run(...params);
      return { success: true, rowsAffected: Number(result.changes) };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string; params?: SQLInputValue[] }>) => {
      const hook = hooks.beforeBatch;
      if (hook) {
        hooks.beforeBatch = null;
        await hook();
      }
      database().exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          const result = database()
            .prepare(statement.sql)
            .run(...(statement.params ?? []));
          return { success: true, rowsAffected: Number(result.changes) };
        });
        database().exec('COMMIT');
        return results;
      } catch (error) {
        database().exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return {
    ...actual,
    createD1Adapter: () => adapter,
    requireDedicatedAdminDatabaseAdapter: () => adapter,
    createAuditLogFromContext: async () => {},
  };
});

import {
  adminTenantDeleteHandler,
  adminTenantResumeHandler,
  adminTenantSetDefaultHandler,
} from '../admin-tenants';
import { activeTenantDeleteJobGuard } from '../tenant-deletion-job-predicate';

function openDatabase(lifecycle = 'active'): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, tenant_code TEXT, name TEXT, description TEXT,
      isolation_policy TEXT DEFAULT 'shared_pool', lifecycle_state TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, default_tenant_guard TEXT,
      created_at INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);
    CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, progress TEXT, config TEXT,
      created_by TEXT, created_at INTEGER, updated_at INTEGER, estimated_completion INTEGER,
      attempt_count INTEGER, max_attempts INTEGER, result TEXT, error_code TEXT,
      error_message TEXT, next_run_at INTEGER, completed_at INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO tenants (id, tenant_code, name, lifecycle_state, is_default, default_tenant_guard) VALUES ('default', 'default', 'Default', 'active', 1, 'default')"
  ).run();
  db.prepare(
    'INSERT INTO tenants (id, tenant_code, name, lifecycle_state) VALUES (?, ?, ?, ?)'
  ).run('second', 'second', 'Second', lifecycle);
  return db;
}

const AUTH: AdminAuthContext = {
  userId: 'machine-9',
  actorId: 'machine-9',
  actorType: 'machine',
  authMethod: 'machine_access_token',
  roles: [],
  tenantScope: ['*'],
  permissions: ['admin:*', 'admin:step_up_exempt:tenant.delete'],
  globalPermissions: ['admin:*', 'admin:step_up_exempt:tenant.delete'],
};

async function call(
  method: 'DELETE' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string
) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', AUTH);
    c.set('tenantId' as never, 'default' as never);
    await next();
  });
  app.delete('/api/admin/tenants/:id', (c) => adminTenantDeleteHandler(c as never));
  app.post('/api/admin/tenants/:id/set-default', (c) => adminTenantSetDefaultHandler(c as never));
  app.post('/api/admin/tenants/:id/lifecycle/resume', (c) => adminTenantResumeHandler(c as never));
  const response = await app.request(
    path,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { BASE_DOMAIN: 'op.example.com' }
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const row = (db: SQLiteDatabase, id: string) =>
  db.prepare('SELECT lifecycle_state, is_default FROM tenants WHERE id = ?').get(id) as {
    lifecycle_state: string;
    is_default: number;
  };
const jobs = (db: SQLiteDatabase) =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM admin_jobs').get() as { n: number }).n);

const DELETE_PATH = '/api/admin/tenants/second';
const SET_DEFAULT_PATH = '/api/admin/tenants/second/set-default';

describe('set-default and delete on the same tenant', () => {
  it('delete alone and set-default alone work', async () => {
    hooks.db = openDatabase();
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(row(hooks.db as SQLiteDatabase, 'second').lifecycle_state).toBe('deleting');
    expect(jobs(hooks.db as SQLiteDatabase)).toBe(1);

    hooks.db = openDatabase();
    expect((await call('POST', SET_DEFAULT_PATH)).status).toBe(200);
    expect(row(hooks.db as SQLiteDatabase, 'second')).toMatchObject({ is_default: 1 });
    expect(row(hooks.db as SQLiteDatabase, 'default')).toMatchObject({ is_default: 0 });
  });

  it('set-default lands between the delete handler’s read and its batch: the delete is refused', async () => {
    const db = openDatabase();
    hooks.db = db;
    hooks.beforeBatch = async () => {
      expect((await call('POST', SET_DEFAULT_PATH)).status).toBe(200);
    };
    const result = await call('DELETE', DELETE_PATH);
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(row(db, 'second')).toEqual({ lifecycle_state: 'active', is_default: 1 });
    expect(jobs(db)).toBe(0);
  });

  it('the delete lands between the set-default handler’s read and its batch: set-default is refused', async () => {
    const db = openDatabase();
    hooks.db = db;
    hooks.beforeBatch = async () => {
      expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    };
    const result = await call('POST', SET_DEFAULT_PATH);
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_deletion_in_progress' } });
    expect(row(db, 'second')).toEqual({ lifecycle_state: 'deleting', is_default: 0 });
    // The old default is untouched.
    expect(row(db, 'default')).toEqual({ lifecycle_state: 'active', is_default: 1 });
    expect(jobs(db)).toBe(1);
  });

  it('set-default refuses a tenant that is not active in the first place', async () => {
    const db = openDatabase('suspended');
    hooks.db = db;
    expect((await call('POST', SET_DEFAULT_PATH)).status).toBe(400);
    expect(row(db, 'default')).toMatchObject({ is_default: 1 });
  });

  it('a second delete while one is pending is refused with 409 and queues no second job', async () => {
    const db = openDatabase();
    hooks.db = db;
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    // The first job failed and suspended the tenant; its retry is still pending.
    db.prepare("UPDATE tenants SET lifecycle_state = 'suspended' WHERE id = 'second'").run();
    const second = await call('DELETE', DELETE_PATH);
    expect(second).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(row(db, 'second').lifecycle_state).toBe('suspended');
    expect(jobs(db)).toBe(1);
  });

  it('a delete that runs between another delete’s read and its batch wins alone and is not undone', async () => {
    const db = openDatabase();
    hooks.db = db;
    // Request A has read an active tenant; before its batch, the tenant was suspended (a failed
    // older job) and request B started a deletion and queued its job.
    hooks.beforeBatch = async () => {
      db.prepare("UPDATE tenants SET lifecycle_state = 'suspended' WHERE id = 'second'").run();
      expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    };
    const a = await call('DELETE', DELETE_PATH);
    expect(a).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    // B's state and job stand; A changed nothing and there is nothing for A to compensate.
    expect(row(db, 'second').lifecycle_state).toBe('deleting');
    expect(jobs(db)).toBe(1);
  });

  it('a failing job insert rolls the lifecycle update back with it', async () => {
    const db = openDatabase('suspended');
    hooks.db = db;
    db.exec(
      "CREATE TRIGGER fail_job BEFORE INSERT ON admin_jobs BEGIN SELECT RAISE(ABORT, 'job insert failed'); END"
    );
    const result = await call('DELETE', DELETE_PATH);
    expect(result.status).toBe(500);
    expect(row(db, 'second')).toEqual({ lifecycle_state: 'suspended', is_default: 0 });
    expect(jobs(db)).toBe(0);
  });

  describe('while the tenant has an active deletion job', () => {
    const RESUME_PATH = '/api/admin/tenants/second/lifecycle/resume';
    let seq = 0;
    const resume = (db: SQLiteDatabase) => {
      const { updated_at } = db
        .prepare("SELECT updated_at FROM tenants WHERE id = 'second'")
        .get() as { updated_at: number };
      return call(
        'POST',
        RESUME_PATH,
        { expected_state: 'suspended', expected_updated_at: updated_at, reason: 'recovering it' },
        `key-${seq++}`
      );
    };
    const addJob = (
      db: SQLiteDatabase,
      status: string,
      config: object,
      updatedAt = Math.floor(Date.now() / 1000)
    ) =>
      db
        .prepare(
          "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, updated_at) VALUES (?, 'default', 'tenants/delete', ?, ?, ?)"
        )
        .run(`job-${seq++}`, status, JSON.stringify(config), updatedAt);

    it('refuses resume and set-default in their own statement, with a clear code', async () => {
      const db = openDatabase('suspended');
      hooks.db = db;
      addJob(db, 'pending', { tenant_id: 'second', stage: 'retry_scheduled' });

      expect(await resume(db)).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_in_progress' },
      });
      expect(row(db, 'second').lifecycle_state).toBe('suspended');

      db.prepare("UPDATE tenants SET lifecycle_state = 'active' WHERE id = 'second'").run();
      expect(await call('POST', SET_DEFAULT_PATH)).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_in_progress' },
      });
      expect(row(db, 'default')).toEqual({ lifecycle_state: 'active', is_default: 1 });
      expect(row(db, 'second')).toEqual({ lifecycle_state: 'active', is_default: 0 });
    });

    it('is decided in the statement, not on an earlier read: a job queued after the read still blocks', async () => {
      const db = openDatabase('suspended');
      hooks.db = db;
      hooks.beforeExecute = {
        match: /UPDATE tenants SET lifecycle_state = \?/,
        run: async () => {
          addJob(db, 'pending', { tenant_id: 'second' });
        },
      };
      expect((await resume(db)).status).toBe(409);
      expect(row(db, 'second').lifecycle_state).toBe('suspended');
    });

    it('can be abandoned: a failed or completed job, or a stale processing one, no longer blocks', async () => {
      for (const [status, age] of [
        ['failed', 0],
        ['completed', 0],
        ['processing', 7 * 60 * 60],
      ] as const) {
        const db = openDatabase('suspended');
        hooks.db = db;
        addJob(db, status, { tenant_id: 'second' }, Math.floor(Date.now() / 1000) - age);
        expect((await resume(db)).status).toBe(202);
        expect(row(db, 'second').lifecycle_state).toBe('suspended');
      }
      // A fresh processing job does block.
      const db = openDatabase('suspended');
      hooks.db = db;
      addJob(db, 'processing', { tenant_id: 'second' });
      expect((await resume(db)).status).toBe(409);
    });

    it('records the wall-clock acceptance time in the validation job even when the tenant version runs ahead', async () => {
      const db = openDatabase('suspended');
      hooks.db = db;
      const ahead = Math.floor(Date.now() / 1000) + 500;
      db.prepare("UPDATE tenants SET updated_at = ? WHERE id = 'second'").run(ahead);
      const before = Math.floor(Date.now() / 1000);
      expect((await resume(db)).status).toBe(202);
      const accepted = db
        .prepare(
          "SELECT created_at, config FROM admin_jobs WHERE job_type = 'tenants/lifecycle-validation'"
        )
        .get() as { created_at: number; config: string };
      // created_at is the tenant version (ahead of the clock); accepted_at is the clock.
      expect(accepted.created_at).toBe(ahead + 1);
      const acceptedAt = (JSON.parse(accepted.config) as { accepted_at: number }).accepted_at;
      expect(acceptedAt).toBeGreaterThanOrEqual(before);
      expect(acceptedAt).toBeLessThan(ahead);
    });

    it('matches the target tenant exactly, whatever the JSON spacing or key order', () => {
      const db = openDatabase();
      addJob(db, 'pending', { stage: 'queued', tenant_id: 'demo-10' });
      db.prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, updated_at) VALUES ('spaced', 'default', 'tenants/delete', 'pending', '{ \"stage\": \"x\",  \"tenant_id\" : \"xdemo-1\" }', 1)"
      ).run();
      const active = (tenantId: string) => {
        const guard = activeTenantDeleteJobGuard(tenantId);
        return db
          .prepare(`SELECT EXISTS (${guard.sql}) AS found`)
          .get(...(guard.params as never[])) as {
          found: number;
        };
      };
      expect(active('demo-1').found).toBe(0);
      expect(active('demo-10').found).toBe(1);
      expect(active('xdemo-1').found).toBe(1);
      expect(active('demo').found).toBe(0);
      // A wildcard character in a tenant id is just a character: there is no LIKE.
      expect(active('%').found).toBe(0);
      expect(active('demo-_0').found).toBe(0);
    });
  });
});

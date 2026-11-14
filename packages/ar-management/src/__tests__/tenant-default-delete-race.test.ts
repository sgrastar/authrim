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
  onAudit: null | (() => Promise<void>);
  onPublish: null | (() => Promise<void>);
}
const hooks = vi.hoisted(
  (): Hooks => ({
    db: null,
    beforeExecute: null,
    beforeBatch: null,
    onAudit: null,
    onPublish: null,
  })
);

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

vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditLog: async () => {
    const hook = hooks.onAudit;
    hooks.onAudit = null;
    if (hook) await hook();
    return 'audit-1';
  },
}));
vi.mock('../tenant-deletion-lookup-cleanup', () => ({
  disableTenantLookupDirectory: async () => undefined,
  tenantLookupIdentifierDisableEvidence: async () => ({
    identifierRows: 1,
    disabledIdentifierRows: 0,
  }),
}));
vi.mock('../tenant-runtime-registry-route-state', async () => {
  const lib = await import('@authrim/ar-lib-core');
  return {
    // Stands in for the reactivation (its real transition is covered by the real-transition
    // test): the route turns active in the registry row.
    publishTenantRuntimeRegistryReactivation: async (
      _env: unknown,
      options: { tenantId: string }
    ) => {
      if (hooks.onPublish) await hooks.onPublish();
      await lib
        .requireDedicatedAdminDatabaseAdapter({}, 'test')
        .execute(
          "UPDATE tenant_runtime_cache_generations SET generation = generation + 1, metadata_json = json_set(metadata_json, '$.route_status', 'active', '$.route_state_reactivated_at', 'now') WHERE tenant_id = ?",
          [options.tenantId]
        );
      return { routeStatus: 'active' };
    },
  };
});

import {
  adminTenantDeleteHandler,
  adminTenantDeletionCancelHandler,
  adminTenantResumeHandler,
  adminTenantRestoreValidateHandler,
  adminTenantSetDefaultHandler,
  adminTenantUnfreezeHandler,
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
    CREATE TABLE tenant_runtime_cache_generations (
      tenant_id TEXT NOT NULL, cache_namespace TEXT NOT NULL, generation INTEGER NOT NULL,
      updated_at TEXT, updated_by TEXT, metadata_json TEXT,
      PRIMARY KEY (tenant_id, cache_namespace)
    );
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
  app.post('/api/admin/tenants/:id/deletion/cancel', (c) =>
    adminTenantDeletionCancelHandler(c as never)
  );
  app.post('/api/admin/tenants/:id/lifecycle/resume', (c) => adminTenantResumeHandler(c as never));
  app.post('/api/admin/tenants/:id/lifecycle/unfreeze', (c) =>
    adminTenantUnfreezeHandler(c as never)
  );
  app.post('/api/admin/tenants/:id/lifecycle/restore-validate', (c) =>
    adminTenantRestoreValidateHandler(c as never)
  );
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
    {
      BASE_DOMAIN: 'op.example.com',
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      CONTROL: {
        getTenantDeletionInventory: async ({ tenantId, operationId }: Record<string, string>) => ({
          environmentId: 'test',
          tenantId,
          operationId,
          state: 'ready',
          lookupShards: [{ lookupShardId: 'l1', bindingRef: 'L1', status: 'active' }],
          tenantShards: [],
        }),
      },
    }
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

describe('delete of a tenant whose previous deletion failed', () => {
  const PREDECESSOR = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-2222-4333-8444-555555555555';

  function seed(options: {
    routeStatus?: string | null;
    routeOperationId?: string;
    predecessorConfig?: Record<string, unknown>;
    predecessorStatus?: string;
  }): SQLiteDatabase {
    const db = openDatabase('suspended');
    if (options.predecessorStatus !== null) {
      db.prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES (?, 'default', 'tenants/delete', ?, ?, 10, 10)"
      ).run(
        PREDECESSOR,
        options.predecessorStatus ?? 'failed',
        JSON.stringify({ tenant_id: 'second', ...(options.predecessorConfig ?? {}) })
      );
    }
    if (options.routeStatus) {
      db.prepare(
        "INSERT INTO tenant_runtime_cache_generations (tenant_id, cache_namespace, generation, metadata_json) VALUES ('second', 'runtime_registry', 2, ?)"
      ).run(
        JSON.stringify({
          route_status: options.routeStatus,
          quarantine_deny_generation: 1,
          route_state_operation_id: options.routeOperationId ?? PREDECESSOR,
        })
      );
    }
    hooks.db = db;
    return db;
  }

  // The queued job's config without the server-set `marker_aware` flag (asserted on its own).
  const newJobConfig = (db: SQLiteDatabase) => {
    const { marker_aware: markerAware, ...config } = JSON.parse(
      (
        db
          .prepare(
            "SELECT config FROM admin_jobs WHERE status = 'pending' AND job_type = 'tenants/delete'"
          )
          .get() as { config: string }
      ).config
    ) as Record<string, unknown>;
    expect(markerAware).toBe(true);
    return config;
  };

  it.each(['quarantining', 'quarantined', 'disabled'])(
    'adopts the failed predecessor chain while the route is %s under its id',
    async (routeStatus) => {
      const db = seed({ routeStatus });
      expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
      expect(newJobConfig(db)).toEqual({ tenant_id: 'second', operation_id: PREDECESSOR });
    }
  );

  it('keeps the original chain id when the predecessor was itself a continuation', async () => {
    const db = seed({
      routeStatus: 'quarantined',
      routeOperationId: OTHER,
      predecessorConfig: { operation_id: OTHER },
    });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second', operation_id: OTHER });
  });

  it('adopts the older failed job that owns the route state when a newer failed job is unrelated', async () => {
    const db = seed({ routeStatus: 'quarantined' });
    db.prepare(
      "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES (?, 'default', 'tenants/delete', 'failed', ?, 20, 20)"
    ).run(OTHER, JSON.stringify({ tenant_id: 'second' }));
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second', operation_id: PREDECESSOR });
  });

  it('does not adopt when the route is active', async () => {
    const db = seed({ routeStatus: 'active' });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second' });
  });

  it('does not adopt when there is no route state row', async () => {
    const db = seed({ routeStatus: null });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second' });
  });

  it('does not adopt another operation’s quarantine', async () => {
    const db = seed({ routeStatus: 'quarantined', routeOperationId: OTHER });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second' });
  });

  it('does not adopt without a failed predecessor', async () => {
    const none = seed({ routeStatus: 'quarantined', predecessorStatus: null as never });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(none)).toEqual({ tenant_id: 'second' });

    const completed = seed({ routeStatus: 'quarantined', predecessorStatus: 'completed' });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(completed)).toEqual({ tenant_id: 'second' });
  });

  it('does not adopt a predecessor id that is not a UUID', async () => {
    const db = seed({
      routeStatus: 'quarantined',
      routeOperationId: 'not-a-uuid',
      predecessorConfig: { operation_id: 'not-a-uuid' },
    });
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second' });
  });

  it('does not adopt when the route state cannot be read', async () => {
    const db = seed({ routeStatus: 'quarantined' });
    db.exec("UPDATE tenant_runtime_cache_generations SET metadata_json = '{not json'");
    expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second' });
  });

  it('never takes an operation id from the request', async () => {
    const db = seed({ routeStatus: 'active' });
    expect(
      (await call('DELETE', DELETE_PATH, { operation_id: OTHER, config: { operation_id: OTHER } }))
        .status
    ).toBe(202);
    expect(newJobConfig(db)).toEqual({ tenant_id: 'second' });
  });
});

describe('reactivating a tenant whose last deletion failed', () => {
  const FAILED_JOB = '11111111-2222-4333-8444-555555555555';
  let seq = 0;

  function seed(options: {
    lifecycle?: string;
    routeStatus?: string | null;
    jobStatus?: string | null;
    jobError?: string | null;
    jobProgress?: string | null;
  }): SQLiteDatabase {
    const db = openDatabase(options.lifecycle ?? 'suspended');
    if (options.jobStatus !== null) {
      db.prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, error_message, progress, created_at, updated_at) VALUES (?, 'default', 'tenants/delete', ?, ?, ?, ?, 10, 10)"
      ).run(
        FAILED_JOB,
        options.jobStatus ?? 'failed',
        JSON.stringify({ tenant_id: 'second' }),
        options.jobError ?? null,
        options.jobProgress ?? null
      );
    }
    if (options.routeStatus) {
      db.prepare(
        "INSERT INTO tenant_runtime_cache_generations (tenant_id, cache_namespace, generation, metadata_json) VALUES ('second', 'runtime_registry', 2, ?)"
      ).run(
        JSON.stringify({
          route_status: options.routeStatus,
          quarantine_deny_generation: 1,
          route_state_operation_id: FAILED_JOB,
        })
      );
    }
    hooks.db = db;
    return db;
  }

  function command(db: SQLiteDatabase, name: 'resume' | 'unfreeze' | 'restore-validate') {
    const { lifecycle_state, updated_at } = db
      .prepare("SELECT lifecycle_state, updated_at FROM tenants WHERE id = 'second'")
      .get() as { lifecycle_state: string; updated_at: number };
    return call(
      'POST',
      `/api/admin/tenants/second/lifecycle/${name}`,
      { expected_state: lifecycle_state, expected_updated_at: updated_at, reason: 'recovering it' },
      `key-${seq++}`
    );
  }
  const validationJobs = (db: SQLiteDatabase) =>
    Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM admin_jobs WHERE job_type = 'tenants/lifecycle-validation'"
          )
          .get() as { n: number }
      ).n
    );

  it.each(['quarantining', 'quarantined', 'disabled'])(
    'resume is refused with tenant_deletion_failed_use_cancel while the route is %s, changing nothing',
    async (routeStatus) => {
      const db = seed({ routeStatus });
      const result = await command(db, 'resume');
      expect(result).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_failed_use_cancel' },
      });
      expect(row(db, 'second').lifecycle_state).toBe('suspended');
      expect(validationJobs(db)).toBe(0);
    }
  );

  it.each([
    ['unfreeze', 'frozen'],
    ['restore-validate', 'restore_pending'],
  ] as const)('%s is refused the same way', async (name, lifecycle) => {
    const db = seed({ lifecycle, routeStatus: 'quarantined' });
    expect(await command(db, name)).toMatchObject({
      status: 409,
      body: { error: 'tenant_deletion_failed_use_cancel' },
    });
    expect(row(db, 'second').lifecycle_state).toBe(lifecycle);
    expect(validationJobs(db)).toBe(0);
  });

  it('refuses with 503 (fail closed) when the route state cannot be read', async () => {
    const db = seed({ routeStatus: 'bogus' });
    expect(await command(db, 'resume')).toMatchObject({
      status: 503,
      body: { error: 'tenant_route_state_unavailable' },
    });
    expect(row(db, 'second').lifecycle_state).toBe('suspended');
    expect(validationJobs(db)).toBe(0);
  });

  it('still resumes a tenant whose failed deletion never reached quarantine (route active or no row)', async () => {
    for (const routeStatus of [null, 'active']) {
      const db = seed({ routeStatus });
      expect((await command(db, 'resume')).status).toBe(202);
      expect(validationJobs(db)).toBe(1);
    }
  });

  it('resumes after the failed deletion was cancelled (job marked, route active)', async () => {
    const db = seed({
      routeStatus: 'active',
      jobError: 'tenant_deletion_cancelled',
      jobProgress: '{"stage":"cancelled"}',
    });
    expect((await command(db, 'resume')).status).toBe(202);
    expect(validationJobs(db)).toBe(1);
  });

  it.each([null, 'active', 'quarantined'])(
    'is refused while the cancel is incomplete, whatever the database route says (%s)',
    async (routeStatus) => {
      const db = seed({
        routeStatus,
        jobError: 'tenant_deletion_cancelled',
        jobProgress: '{"stage":"cancelling"}',
      });
      expect(await command(db, 'resume')).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_failed_use_cancel' },
      });
      expect(validationJobs(db)).toBe(0);
    }
  );

  it('is refused after a completed cancel while the route is still non-active', async () => {
    const db = seed({
      routeStatus: 'quarantined',
      jobError: 'tenant_deletion_cancelled',
      jobProgress: '{"stage":"cancelled"}',
    });
    expect((await command(db, 'resume')).status).toBe(409);
  });

  it('is not triggered by a tenant with no deletion job, or whose latest job is not failed', async () => {
    for (const jobStatus of [null, 'completed']) {
      const db = seed({ routeStatus: 'quarantined', jobStatus });
      expect((await command(db, 'resume')).status).toBe(202);
    }
  });
});

describe('cancel and DELETE serialise on the platform database', () => {
  const JOB_A = '11111111-2222-4333-8444-555555555555';
  const JOB_B = '22222222-2222-4333-8444-555555555555';
  const JOB_C = '33333333-2222-4333-8444-555555555555';
  const CANCEL_PATH = '/api/admin/tenants/second/deletion/cancel';
  const BODY = { reason: 'operator abandoned the deletion' };

  /**
   * A failed deletion chain: A (own id), then B and C continuing A's id, newest last. `count`
   * says how many of them exist. The route is quarantined under A's id.
   */
  function seed(count = 1, options: { progress?: string; error?: string } = {}): SQLiteDatabase {
    const db = openDatabase('suspended');
    [JOB_A, JOB_B, JOB_C].slice(0, count).forEach((id, index) => {
      db.prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, error_message, progress, created_at, updated_at) VALUES (?, 'default', 'tenants/delete', 'failed', ?, ?, ?, ?, ?)"
      ).run(
        id,
        JSON.stringify({
          tenant_id: 'second',
          marker_aware: true,
          ...(index === 0 ? {} : { operation_id: JOB_A }),
        }),
        options.error ?? null,
        options.progress ?? null,
        10 + index,
        10 + index
      );
    });
    db.prepare(
      "INSERT INTO tenant_runtime_cache_generations (tenant_id, cache_namespace, generation, updated_at, metadata_json) VALUES ('second', 'runtime_registry', 2, '2026-01-01T00:00:00.000Z', ?)"
    ).run(
      JSON.stringify({
        route_status: 'quarantined',
        quarantine_deny_generation: 1,
        route_state_operation_id: JOB_A,
      })
    );
    hooks.db = db;
    return db;
  }
  const pendingDeletes = (db: SQLiteDatabase) =>
    Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM admin_jobs WHERE status = 'pending' AND job_type = 'tenants/delete'"
          )
          .get() as { n: number }
      ).n
    );
  const jobStates = (db: SQLiteDatabase) =>
    (
      db
        .prepare(
          "SELECT id, error_message, progress FROM admin_jobs WHERE status = 'failed' ORDER BY created_at"
        )
        .all() as { id: string; error_message: string | null; progress: string | null }[]
    ).map((job) => ({
      id: job.id,
      marked: job.error_message === 'tenant_deletion_cancelled',
      stage: (JSON.parse(job.progress ?? '{}') as { stage?: string }).stage ?? null,
    }));
  const routeStatus = (db: SQLiteDatabase) => {
    const { metadata_json } = db
      .prepare('SELECT metadata_json FROM tenant_runtime_cache_generations')
      .get() as { metadata_json: string };
    return (JSON.parse(metadata_json) as { route_status: string }).route_status;
  };

  it.each([1, 2, 3])(
    'cancel alone marks and finalises all %i failed jobs of the chain together, and a DELETE then gets its own chain',
    async (count) => {
      const db = seed(count);
      expect((await call('POST', CANCEL_PATH, BODY)).status).toBe(200);
      expect(jobStates(db)).toEqual(
        [JOB_A, JOB_B, JOB_C]
          .slice(0, count)
          .map((id) => ({ id, marked: true, stage: 'cancelled' }))
      );
      expect(routeStatus(db)).toBe('active');
      expect(row(db, 'second').lifecycle_state).toBe('suspended');
      // Idempotent repeat.
      expect((await call('POST', CANCEL_PATH, BODY)).body).toMatchObject({
        already_cancelled: true,
      });
      expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
      expect(
        JSON.parse(
          (
            db.prepare("SELECT config FROM admin_jobs WHERE status = 'pending'").get() as {
              config: string;
            }
          ).config
        )
      ).toEqual({ tenant_id: 'second', marker_aware: true });
    }
  );

  it('a DELETE that read the adoption before the cancel, with three chain jobs, is refused after the cancel', async () => {
    const db = seed(3);
    hooks.beforeBatch = async () => {
      expect((await call('POST', CANCEL_PATH, BODY)).status).toBe(200);
    };
    const result = await call('DELETE', DELETE_PATH);
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(pendingDeletes(db)).toBe(0);
    expect(row(db, 'second').lifecycle_state).toBe('suspended');
    expect(routeStatus(db)).toBe('active');
    // No older unmarked job is left to be adopted.
    expect(jobStates(db).every((job) => job.marked && job.stage === 'cancelled')).toBe(true);
  });

  it('a DELETE that lands during the audit write wins: cancel answers 409 and nothing is reactivated or marked', async () => {
    const db = seed(2);
    hooks.onAudit = async () => {
      expect((await call('DELETE', DELETE_PATH)).status).toBe(202);
    };
    const result = await call('POST', CANCEL_PATH, BODY);
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(pendingDeletes(db)).toBe(1);
    expect(routeStatus(db)).toBe('quarantined');
    expect(jobStates(db).some((job) => job.marked)).toBe(false);
    expect(row(db, 'second').lifecycle_state).toBe('deleting');
  });

  it('a DELETE is refused while a cancel is incomplete (marked cancelling), adopted or not', async () => {
    for (const status of ['quarantined', 'active']) {
      const db = seed(2, {
        progress: '{"stage":"cancelling","cancelling_at":5}',
        error: 'tenant_deletion_cancelled',
      });
      db.prepare(
        "UPDATE tenant_runtime_cache_generations SET metadata_json = json_set(metadata_json, '$.route_status', ?)"
      ).run(status);
      const result = await call('DELETE', DELETE_PATH);
      expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
      expect(pendingDeletes(db)).toBe(0);
    }
  });

  it('decides the chain from the route: a later failed job with its own id does not hide the owner (A holds the quarantine, B failed on the conflict)', async () => {
    const db = seed(1);
    db.prepare(
      "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES (?, 'default', 'tenants/delete', 'failed', ?, 50, 50)"
    ).run(JOB_B, JSON.stringify({ tenant_id: 'second', marker_aware: true }));
    const result = await call('POST', CANCEL_PATH, BODY);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation_id: JOB_A, cancelled_job_id: JOB_A });
    expect(jobStates(db).map((job) => job.stage)).toEqual(['cancelled', 'cancelled']);
    expect(routeStatus(db)).toBe('active');
  });

  it('a quarantine owned by an operation that is not a deletion job of this tenant is not touched', async () => {
    const db = seed(1);
    db.prepare(
      "UPDATE tenant_runtime_cache_generations SET metadata_json = json_set(metadata_json, '$.route_state_operation_id', '99999999-2222-4333-8444-555555555555')"
    ).run();
    expect(await call('POST', CANCEL_PATH, BODY)).toMatchObject({
      status: 409,
      body: { error: 'tenant_route_owned_by_other_operation' },
    });
    expect(routeStatus(db)).toBe('quarantined');
    expect(jobStates(db).some((job) => job.marked)).toBe(false);
  });

  describe('the lease on the cancel mark', () => {
    const marked = (cancellingAt: number) => ({
      progress: JSON.stringify({ stage: 'cancelling', cancelling_at: cancellingAt }),
      error: 'tenant_deletion_cancelled',
    });

    it('a repeat inside the lease is refused with nothing changed', async () => {
      const db = seed(2, marked(Math.floor(Date.now() / 1000) - 10));
      const before = jobStates(db);
      const updatedAt = row(db, 'second');
      expect(await call('POST', CANCEL_PATH, BODY)).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_cancel_in_progress' },
      });
      expect(jobStates(db)).toEqual(before);
      expect(row(db, 'second')).toEqual(updatedAt);
      expect(routeStatus(db)).toBe('quarantined');
    });

    it('a repeat after the lease takes the mark over and completes', async () => {
      const db = seed(2, marked(Math.floor(Date.now() / 1000) - 600));
      expect((await call('POST', CANCEL_PATH, BODY)).status).toBe(200);
      expect(jobStates(db).map((job) => job.stage)).toEqual(['cancelled', 'cancelled']);
      expect(routeStatus(db)).toBe('active');
    });

    it('a request that lost its lease cannot finalise: the takeover re-stamped the marks', async () => {
      const db = seed(1);
      // The slow request A is inside the publication when its lease passes and B takes over.
      hooks.onPublish = async () => {
        db.prepare(
          "UPDATE admin_jobs SET progress = json_set(progress, '$.cancelling_at', 1) WHERE error_message = 'tenant_deletion_cancelled'"
        ).run();
        hooks.onPublish = null;
        expect((await call('POST', CANCEL_PATH, BODY)).status).toBe(200);
      };
      const result = await call('POST', CANCEL_PATH, BODY);
      // B (the repeat) completed; A, stale, could not finalise anything.
      expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
      expect(jobStates(db).map((job) => job.stage)).toEqual(['cancelled']);
    });
  });
});

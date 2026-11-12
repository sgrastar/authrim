import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * The real validation-job executor (the job that completes an accepted resume / unfreeze /
 * restore-validate) on real SQLite databases: the tenant inventory with its deletion jobs, and
 * the admin jobs table. A deletion that started after the reactivation was accepted wins: the
 * validation job must not set the tenant back to `active`, nor enable its caches.
 */
const lifecycleAudit = vi.hoisted(() => ({
  prepare: vi.fn(),
  confirm: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', () => ({
  prepareLogIcebergRowWrite: lifecycleAudit.prepare,
}));
vi.mock('@authrim/ar-lib-core/services/admin-audit-receipts', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/admin-audit-receipts')>()),
  confirmAdminAuditReceipt: lifecycleAudit.confirm,
}));

const probe = vi.hoisted(() => ({
  tenantDb: {
    queryOne: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM authrim_runtime_probes'))
        return { id: params[0], tenant_id: params[1] };
      if (sql.includes('SELECT 1 AS ok')) return { ok: 1 };
      return { count: 1 };
    },
    query: async () => [],
    execute: async () => ({ success: true, rowsAffected: 1 }),
  },
}));

vi.mock('../log-read-adapter', () => ({
  createLogReadAdapter: () => ({ adapter: { queryOne: async () => ({ id: 'audit-1' }) } }),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: async () => probe.tenantDb,
    emitRuntimeLogRecords: async () => ({ tenantKey: 'tk', targetResults: [] }),
  };
});

import { processGenericAdminJobNow } from '../admin-job-executor';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function sqliteAdapter(db: SQLiteDatabase): DatabaseAdapter {
  const adapter = {
    query: async (sql: string, params: SQLInputValue[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      db.prepare(sql).get(...params) ?? null,
    execute: async (sql: string, params: SQLInputValue[] = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...params).changes),
    }),
    batch: async () => [],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    isHealthy: async () => ({ healthy: true }),
    getType: () => 'sqlite',
    close: () => undefined,
  } as unknown as DatabaseAdapter;
  return adapter;
}

const ACCEPTED_AT = 1_000_000;

function setup() {
  const inventory = new DatabaseSync(':memory:');
  inventory.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, is_default INTEGER DEFAULT 0,
      default_tenant_guard TEXT, updated_at INTEGER
    );
    CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, config TEXT,
      created_at INTEGER, updated_at INTEGER
    );
  `);
  inventory
    .prepare(
      "INSERT INTO tenants (id, lifecycle_state, updated_at) VALUES ('tenant-a', 'suspended', ?)"
    )
    .run(ACCEPTED_AT);
  const admin = new DatabaseSync(':memory:');
  admin.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/admin/d1/001_0_4_0_admin_baseline.sql'), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  admin
    .prepare(
      `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_by, created_at, updated_at, attempt_count, max_attempts)
       VALUES ('val-1', 'tenant-a', 'tenants/lifecycle-validation', 'pending', ?, 'admin-1', ?, ?, 0, 3)`
    )
    .run(
      JSON.stringify({
        command: 'resume',
        validation_kind: 'resume',
        source_state: 'suspended',
        target_state: 'active',
        reason: 'recovering',
        idempotency_key: 'k1',
        accepted_at: ACCEPTED_AT,
        actor_id: 'admin-1',
      }),
      ACCEPTED_AT,
      ACCEPTED_AT
    );
  const kv = {
    get: vi.fn(async () =>
      JSON.stringify({ 'tenant.allowed_identifiers': 'https://tenant-a.op.example.com' })
    ),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const env = {
    BASE_DOMAIN: 'op.example.com',
    AUTHRIM_CONFIG: kv,
    DB: sqliteAdapter(inventory),
    DB_ADMIN: sqliteAdapter(admin),
  } as never;
  return { inventory, admin, kv, env };
}

const logger = { info: vi.fn(), error: vi.fn() };
const tenant = (db: SQLiteDatabase) =>
  db.prepare("SELECT lifecycle_state FROM tenants WHERE id = 'tenant-a'").get();
const job = (db: SQLiteDatabase) =>
  db.prepare("SELECT status, progress FROM admin_jobs WHERE id = 'val-1'").get() as {
    status: string;
    progress: string;
  };

describe('accepted reactivation vs a deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleAudit.prepare.mockReturnValue({ record: {}, dispatch: lifecycleAudit.dispatch });
    lifecycleAudit.dispatch.mockResolvedValue(undefined);
  });

  it('a normal accepted resume still activates the tenant and enables its cache', async () => {
    const { inventory, admin, kv, env } = setup();
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'active' });
    expect(job(admin).status).toBe('completed');
    expect(kv.put).toHaveBeenCalledWith('v1:tenant-exists:tenant-a', 'true', expect.anything());
  });

  it('a deletion that failed and re-suspended the tenant since acceptance supersedes the job', async () => {
    const { inventory, admin, kv, env } = setup();
    // Deletion started and failed transiently: the tenant is suspended again (a newer version)
    // with its deletion job pending.
    inventory
      .prepare("UPDATE tenants SET updated_at = ? WHERE id = 'tenant-a'")
      .run(ACCEPTED_AT + 5);
    inventory
      .prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES ('del-1', 'default', 'tenants/delete', 'pending', '{\"tenant_id\":\"tenant-a\"}', ?, ?)"
      )
      .run(ACCEPTED_AT - 100, Math.floor(Date.now() / 1000));
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'suspended' });
    expect(job(admin).status).toBe('partial_failure');
    expect(job(admin).progress).toContain('tenant_lifecycle_validation_superseded');
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('a display edit between acceptance and execution does not stop the reactivation', async () => {
    const { inventory, admin, kv, env } = setup();
    inventory
      .prepare("UPDATE tenants SET updated_at = ? WHERE id = 'tenant-a'")
      .run(ACCEPTED_AT + 9);
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'active' });
    expect(job(admin).status).toBe('completed');
    expect(kv.put).toHaveBeenCalled();
  });

  it('a deletion accepted after the command supersedes it even if the deletion failed since', async () => {
    const { inventory, admin, kv, env } = setup();
    // Resume accepted at ACCEPTED_AT, then a deletion accepted a second later; its job failed and
    // left the tenant suspended again, the state the old resume started from.
    inventory
      .prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES ('del-1', 'default', 'tenants/delete', 'failed', '{\"tenant_id\":\"tenant-a\"}', ?, ?)"
      )
      .run(ACCEPTED_AT + 1, ACCEPTED_AT + 5);
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'suspended' });
    expect(job(admin).status).toBe('partial_failure');
    expect(job(admin).progress).toContain('tenant_lifecycle_validation_superseded');
    expect(kv.put).not.toHaveBeenCalled();

    // A NEW resume, accepted after that deletion, activates the tenant.
    admin
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_by, created_at, updated_at, attempt_count, max_attempts)
         SELECT 'val-2', tenant_id, job_type, 'pending', json_set(config, '$.accepted_at', ?), created_by, ?, ?, 0, 3 FROM admin_jobs WHERE id = 'val-1'`
      )
      .run(ACCEPTED_AT + 20, ACCEPTED_AT + 20, ACCEPTED_AT + 20);
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-2');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'active' });
    expect(kv.put).toHaveBeenCalledWith('v1:tenant-exists:tenant-a', 'true', expect.anything());
  });

  it('compares wall-clock acceptance times: a tenant version running ahead of the clock does not hide a deletion', async () => {
    const { inventory, admin, kv, env } = setup();
    // The tenant version was T, the resume was accepted in wall-clock second T (so the job's
    // created_at, the new version, is T + 1), and a deletion was accepted in the same second T,
    // then failed and left the tenant suspended.
    const T = ACCEPTED_AT;
    admin.prepare("UPDATE admin_jobs SET created_at = ? WHERE id = 'val-1'").run(T + 1);
    inventory
      .prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES ('del-1', 'default', 'tenants/delete', 'failed', '{\"tenant_id\":\"tenant-a\"}', ?, ?)"
      )
      .run(T, T + 3);
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'suspended' });
    expect(job(admin).progress).toContain('tenant_lifecycle_validation_superseded');
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('an active deletion job alone blocks the activation, even at the accepted version', async () => {
    const { inventory, admin, kv, env } = setup();
    inventory
      .prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES ('del-1', 'default', 'tenants/delete', 'processing', '{\"tenant_id\":\"tenant-a\"}', ?, ?)"
      )
      .run(ACCEPTED_AT - 100, Math.floor(Date.now() / 1000));
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'suspended' });
    expect(job(admin).status).toBe('partial_failure');
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('a finished deletion job does not block it', async () => {
    const { inventory, env } = setup();
    inventory
      .prepare(
        "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at) VALUES ('del-1', 'default', 'tenants/delete', 'failed', '{\"tenant_id\":\"tenant-a\"}', ?, ?)"
      )
      .run(ACCEPTED_AT - 100, Math.floor(Date.now() / 1000));
    await processGenericAdminJobNow(env, logger, 'tenant-a', 'val-1');
    expect(tenant(inventory)).toEqual({ lifecycle_state: 'active' });
  });
});

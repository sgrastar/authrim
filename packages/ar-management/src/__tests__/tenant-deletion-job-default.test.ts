import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * The real deletion job on a real SQLite tenants / admin_jobs table: a stale pending job for a
 * tenant that has since become the default fails the job and touches nothing else, and a
 * non-default tenant whose deletion fails is still suspended as before.
 */
interface State {
  db: unknown;
  beforeSuspend: null | (() => void);
}
const state = vi.hoisted((): State => ({ db: null, beforeSuspend: null }));
const spies = vi.hoisted(() => ({
  disable: vi.fn(),
  route: vi.fn(),
  purge: vi.fn(),
  inventory: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const database = () => state.db as SQLiteDatabase;
  const adapter = {
    query: async (sql: string, params: SQLInputValue[] = []) =>
      database()
        .prepare(sql)
        .all(...params),
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      database()
        .prepare(sql)
        .get(...params) ?? null,
    execute: async (sql: string, params: SQLInputValue[] = []) => {
      if (state.beforeSuspend && sql.includes("SET lifecycle_state = 'suspended'")) {
        const hook = state.beforeSuspend;
        state.beforeSuspend = null;
        hook();
      }
      return {
        success: true,
        rowsAffected: Number(
          database()
            .prepare(sql)
            .run(...params).changes
        ),
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
  } as unknown as DatabaseAdapter;
  return {
    ...actual,
    ensureDatabaseAdapter: () => adapter,
    listEnvironmentTenantDefaultStores: async () => [
      { tenantId: 'operator-tenant', store: { source: 'core', bindingRef: 'CORE' } },
    ],
  };
});
vi.mock('../tenant-deletion-lookup-cleanup', () => ({
  disableTenantLookupDirectory: spies.disable,
}));
vi.mock('../tenant-runtime-registry-route-state', () => ({
  publishTenantRuntimeRegistryRouteState: spies.route,
}));
vi.mock('../tenant-deletion-authoritative-purge', () => ({
  purgeTenantAuthoritativeShards: spies.purge,
}));

import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';

function open(isDefault: boolean): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
      default_tenant_guard TEXT, updated_at INTEGER DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);
    CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, progress TEXT, config TEXT,
      error_message TEXT, attempt_count INTEGER, max_attempts INTEGER, next_run_at INTEGER,
      started_at INTEGER, completed_at INTEGER, updated_at INTEGER, created_by TEXT, created_at INTEGER
    );
  `);
  db.prepare(
    'INSERT INTO tenants (id, lifecycle_state, is_default, default_tenant_guard) VALUES (?, ?, ?, ?)'
  ).run('target-tenant', 'active', isDefault ? 1 : 0, isDefault ? 'default' : null);
  db.prepare(
    "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config) VALUES ('job-1', 'operator-tenant', 'tenants/delete', 'pending', ?)"
  ).run(JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }));
  return db;
}

const env = {
  DB_ADMIN: 'admin-db',
  AUTHRIM_CONFIG: { get: async () => null, put: async () => undefined },
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  CONTROL: { getTenantDeletionInventory: spies.inventory },
} as never;
const logger = { info: vi.fn(), error: vi.fn() };

const tenant = (db: SQLiteDatabase) =>
  db.prepare('SELECT lifecycle_state, is_default FROM tenants WHERE id = ?').get('target-tenant');
const job = (db: SQLiteDatabase) =>
  db.prepare('SELECT status, error_message FROM admin_jobs WHERE id = ?').get('job-1');

describe('tenant deletion job and the default tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.beforeSuspend = null;
  });

  it('fails a stale job for a tenant that is now the default, and changes nothing else', async () => {
    const db = open(true);
    state.db = db;
    await processPendingTenantDeletionJobs(env, logger);
    expect(job(db)).toMatchObject({
      status: 'failed',
      error_message: 'tenant_deletion_target_is_default',
    });
    expect(tenant(db)).toEqual({ lifecycle_state: 'active', is_default: 1 });
    expect(spies.inventory).not.toHaveBeenCalled();
    expect(spies.route).not.toHaveBeenCalled();
    expect(spies.disable).not.toHaveBeenCalled();
    expect(spies.purge).not.toHaveBeenCalled();
  });

  it('never suspends a default tenant, whichever step failed', async () => {
    // Even if the default check were skipped, the suspend-on-failure statement is guarded.
    const db = open(true);
    state.db = db;
    spies.inventory.mockRejectedValue(new Error('tenant_deletion_step_failed'));
    await processPendingTenantDeletionJobs(env, logger);
    expect(tenant(db)).toEqual({ lifecycle_state: 'active', is_default: 1 });
  });

  it('still suspends a non-default tenant whose deletion fails', async () => {
    const db = open(false);
    state.db = db;
    spies.inventory.mockRejectedValue(new Error('tenant_deletion_step_failed'));
    await processPendingTenantDeletionJobs(env, logger);
    expect(tenant(db)).toEqual({ lifecycle_state: 'suspended', is_default: 0 });
    expect(job(db)).toMatchObject({ status: 'pending' }); // a retry is scheduled
  });

  it('stops without touching state or routes when the tenant becomes the default just before the suspend', async () => {
    const db = open(false);
    state.db = db;
    const shard = (shardId: string, dataRole: string, bindingRef: string) => ({
      shardId,
      dataRole,
      residencyPolicyId: 'global',
      residencyPartition: 'global',
      bindingRef,
      status: 'active',
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'target-tenant',
    });
    spies.inventory.mockResolvedValue({
      environmentId: 'test',
      tenantId: 'target-tenant',
      operationId: 'job-1',
      state: 'ready',
      lookupShards: [{ lookupShardId: 'lookup-1', bindingRef: 'LOOKUP_1', status: 'active' }],
      tenantShards: [
        shard('default-1', 'tenant_core/default', 'TDB_DEFAULT'),
        shard('users-1', 'tenant_core/users', 'TDB_USERS'),
        shard('pii-1', 'tenant_pii', 'TDB_PII'),
      ],
    });
    // The interleaving the invariants rule out (set-default is refused while this job is
    // active), forced here: the tenant is made the default after the job's first check.
    state.beforeSuspend = () => {
      db.prepare(
        "UPDATE tenants SET is_default = 1, default_tenant_guard = 'default' WHERE id = 'target-tenant'"
      ).run();
    };
    await processPendingTenantDeletionJobs(env, logger);
    expect(tenant(db)).toEqual({ lifecycle_state: 'active', is_default: 1 });
    expect(job(db)).toMatchObject({
      status: 'failed',
      error_message: 'tenant_deletion_target_is_default',
    });
    expect(spies.route).not.toHaveBeenCalled();
    expect(spies.disable).not.toHaveBeenCalled();
    expect(spies.purge).not.toHaveBeenCalled();
  });
});

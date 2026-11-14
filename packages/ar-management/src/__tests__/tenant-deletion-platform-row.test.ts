import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * The tenant deletion scanner on real SQLite tenants / admin_jobs tables, with the real
 * `listEnvironmentTenantDefaultStores`: only the layers beneath it (the lookup alias resolver, the
 * blind index, the verified bucket assignments and the signed Registry store resolution) are
 * replaced. A tenant that is deleting must still be reached by the scanner, and once the purge has
 * run the platform database row (`env.DB`) must end up `deleted` even when it is another database
 * than the tenant's own store.
 */
const state = vi.hoisted(() => ({
  aliases: [] as string[],
  stores: new Map<string, unknown>(),
  purged: [] as string[],
  markStoreDeleted: null as null | ((tenantId: string) => void),
}));
const spies = vi.hoisted(() => ({ inventory: vi.fn(), finalize: vi.fn() }));

vi.mock('../../../ar-lib-core/dist/services/lookup-directory/blind-index.js', () => ({
  createLookupAliasIndex: async () => ({ aliasKind: 'environment_tenant' }),
}));
vi.mock('../../../ar-lib-core/dist/services/lookup-directory/shard-registry.js', () => ({
  loadVerifiedLookupBucketAssignmentProvider: async () => ({}),
}));
vi.mock('../../../ar-lib-core/dist/services/lookup-directory/resolver.js', () => ({
  LookupRouteResolver: class {
    async resolveAliases(input: { maximumResults: number; afterTenantId?: string }) {
      return state.aliases
        .filter((id) => !input.afterTenantId || id > input.afterTenantId)
        .slice(0, input.maximumResults)
        .map((tenantId) => ({ tenantId, routeProjection: projection }));
    }
  },
}));
vi.mock('../../../ar-lib-core/dist/services/tenant-database-resolver.js', () => ({
  resolveTenantDatabaseSourceFromRegistry: async (_env: unknown, input: { tenantId: string }) => ({
    bindingRouteGeneration: 1,
    residencyPolicyId: 'p',
    residencyPartition: 'r',
    shardId: 's',
    bindingRef: 'TDB_DEFAULT',
    source: state.stores.get(input.tenantId),
  }),
}));
vi.mock('../tenant-deletion-lookup-cleanup', () => ({
  disableTenantLookupDirectory: vi.fn(),
}));
vi.mock('../tenant-runtime-registry-route-state', () => ({
  publishTenantRuntimeRegistryRouteState: async () => ({
    publishedAt: '2000-01-01T00:00:00.000Z',
  }),
}));
vi.mock('../tenant-deletion-authoritative-purge', () => ({
  purgeTenantAuthoritativeShards: async (_env: unknown, _rows: unknown, tenantId: string) => {
    state.purged.push(tenantId);
    state.markStoreDeleted?.(tenantId);
  },
}));
vi.mock('../tenant-deletion-admin-accounts', () => ({
  purgeTenantHomedAdmins: async () => ({ removed: 0, kept: [] }),
  createTenantAdminPurgeAuditWriter: () => vi.fn(),
}));

import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';

const projection = {
  schemaVersion: 1,
  tenantRouteGeneration: 1,
  residencyPolicyId: 'p',
  target: {
    dataRole: 'tenant_core/default',
    residencyPartition: 'r',
    shardId: 's',
    bindingRef: 'TDB_DEFAULT',
    requiredBindingRouteGeneration: 1,
  },
};

function adapterOf(db: SQLiteDatabase) {
  const adapter = {
    query: async (sql: string, params: SQLInputValue[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      db.prepare(sql).get(...params) ?? null,
    execute: async (sql: string, params: SQLInputValue[] = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...params).changes),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  };
  return adapter;
}

/** Permissive stand-in for DB_ADMIN: the Admin cleanup is not what is under test here. */
const adminAdapter = {
  query: async () => [],
  queryOne: async () => null,
  execute: async () => ({ success: true, rowsAffected: 1 }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adminAdapter),
  batch: async () => [],
  isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
  getType: () => 'test',
  close: async () => undefined,
};

function database(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
      default_tenant_guard TEXT, updated_at INTEGER DEFAULT 1
    );
    CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, progress TEXT, config TEXT,
      error_message TEXT, attempt_count INTEGER, max_attempts INTEGER, next_run_at INTEGER,
      started_at INTEGER, completed_at INTEGER, updated_at INTEGER, created_by TEXT, created_at INTEGER
    );
  `);
  return db;
}

function addTenant(
  db: SQLiteDatabase,
  id: string,
  lifecycleState: string,
  isDefault = false
): void {
  db.prepare(
    'INSERT INTO tenants (id, lifecycle_state, is_default, default_tenant_guard) VALUES (?, ?, ?, ?)'
  ).run(id, lifecycleState, isDefault ? 1 : 0, isDefault ? 'default' : null);
}

function addDeletionJob(db: SQLiteDatabase, holder: string, target: string): void {
  db.prepare(
    "INSERT INTO admin_jobs (id, tenant_id, job_type, status, config) VALUES ('job-1', ?, 'tenants/delete', 'pending', ?)"
  ).run(holder, JSON.stringify({ tenant_id: target, skip_backup: true }));
}

const lifecycle = (db: SQLiteDatabase, id: string) =>
  (
    db.prepare('SELECT lifecycle_state FROM tenants WHERE id = ?').get(id) as
      | { lifecycle_state: string }
      | undefined
  )?.lifecycle_state;
const jobStatus = (db: SQLiteDatabase) =>
  (db.prepare("SELECT status FROM admin_jobs WHERE id = 'job-1'").get() as { status: string })
    .status;

function inventory(finalized: boolean) {
  spies.inventory.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
    environmentId: 'test',
    tenantId,
    operationId: 'job-1',
    state: finalized ? 'finalized' : 'ready',
    lookupShards: [],
    tenantShards: [],
  }));
}

function environment(platform: SQLiteDatabase) {
  const put = vi.fn(async () => undefined);
  return {
    env: {
      DB: adapterOf(platform),
      DB_ADMIN: adminAdapter,
      AUTHRIM_CONFIG: { get: async () => null, put },
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: {},
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
      CONTROL: {
        getTenantDeletionInventory: spies.inventory,
        finalizeTenantDeletionControlState: spies.finalize,
      },
    } as never,
    put,
  };
}

const logger = { info: vi.fn(), error: vi.fn() };

describe('tenant deletion scanner with the real tenant directory', () => {
  let platform: SQLiteDatabase;
  let store: SQLiteDatabase;
  let other: SQLiteDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    state.aliases = ['other-tenant', 'target-tenant'];
    state.purged = [];
    platform = database();
    store = database();
    other = database();
    state.stores = new Map<string, unknown>([
      ['target-tenant', adapterOf(store)],
      ['other-tenant', adapterOf(other)],
    ]);
    state.markStoreDeleted = (tenantId) => {
      store.prepare("UPDATE tenants SET lifecycle_state = 'deleted' WHERE id = ?").run(tenantId);
    };
    addTenant(other, 'other-tenant', 'active');
    addTenant(store, 'target-tenant', 'deleting');
    addDeletionJob(store, 'target-tenant', 'target-tenant');
    spies.finalize.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
      environmentId: 'test',
      tenantId,
      operationId: 'job-1',
      state: 'finalized',
      finalizedAt: 1_700_000_000,
    }));
    inventory(false);
  });

  it('reaches the store of a deleting tenant and ends the platform row as deleted', async () => {
    addTenant(platform, 'target-tenant', 'deleting');
    const { env, put } = environment(platform);

    await processPendingTenantDeletionJobs(env, logger);

    expect(state.purged).toEqual(['target-tenant']);
    expect(jobStatus(store)).toBe('completed');
    expect(lifecycle(store, 'target-tenant')).toBe('deleted');
    expect(lifecycle(platform, 'target-tenant')).toBe('deleted');
    expect(put).toHaveBeenLastCalledWith('jobs:tenant-deletion:tenant-cursor', '');
  });

  it('ends the platform row as deleted on the resume branch of a finalized deletion', async () => {
    addTenant(platform, 'target-tenant', 'suspended');
    inventory(true);
    const { env } = environment(platform);

    await processPendingTenantDeletionJobs(env, logger);

    expect(state.purged).toEqual([]);
    expect(jobStatus(store)).toBe('completed');
    expect(lifecycle(platform, 'target-tenant')).toBe('deleted');
  });

  it('never changes a platform row that is the default tenant', async () => {
    addTenant(platform, 'target-tenant', 'active', true);
    const { env } = environment(platform);

    await processPendingTenantDeletionJobs(env, logger);

    expect(lifecycle(platform, 'target-tenant')).toBe('active');
    expect(platform.prepare('SELECT is_default FROM tenants').get()).toEqual({ is_default: 1 });
  });

  it('leaves an unrelated platform tenant alone', async () => {
    addTenant(platform, 'target-tenant', 'deleting');
    addTenant(platform, 'other-tenant', 'active');
    const { env } = environment(platform);

    await processPendingTenantDeletionJobs(env, logger);

    expect(lifecycle(platform, 'other-tenant')).toBe('active');
  });

  it('stays correct when the platform database is the tenant store itself', async () => {
    const { env } = environment(store);

    await processPendingTenantDeletionJobs(env, logger);

    expect(jobStatus(store)).toBe('completed');
    expect(lifecycle(store, 'target-tenant')).toBe('deleted');
  });

  it('is idempotent: a platform row already deleted stays deleted without an error', async () => {
    addTenant(platform, 'target-tenant', 'deleted');
    const { env } = environment(platform);

    await processPendingTenantDeletionJobs(env, logger);

    expect(jobStatus(store)).toBe('completed');
    expect(lifecycle(platform, 'target-tenant')).toBe('deleted');
  });
});

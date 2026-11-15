import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * A continued deletion job (config exactly as the DELETE API writes it) run through the real job
 * code with the REAL route-state transition and the real admin DDL for the registry tables: only
 * the snapshot publication (KV and signing), Lookup, the shard purge and Control are replaced.
 * Whatever state the failed predecessor left the route in, no transition error may occur.
 */
const hooks = vi.hoisted(
  (): {
    db: unknown;
    core: unknown;
    publishes: string[];
    destructive: string[];
    signingKey: unknown;
    audit: Array<Record<string, unknown>>;
    auditFails: boolean;
    onAudit: () => void;
    publishFailsAfterDb: boolean;
    stepUp: () => Response | null;
    lookupTouched: () => Promise<boolean>;
    identifierRows: number;
  } => ({
    db: null,
    core: null,
    publishes: [],
    destructive: [],
    signingKey: null,
    audit: [],
    auditFails: false,
    onAudit: () => undefined,
    publishFailsAfterDb: false,
    stepUp: () => null,
    lookupTouched: async () => false,
    identifierRows: 1,
  })
);

const BASELINE = fileURLToPath(
  new URL('../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql', import.meta.url)
);
const TENANT = 'target-tenant';
const CHAIN = '11111111-2222-4333-8444-555555555555';

function sqliteAdapter(getDb: () => SQLiteDatabase): DatabaseAdapter {
  const tolerate = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      // Tables of the admin baseline this test does not create hold nothing to delete.
      if (String(error).includes('no such table')) return fallback;
      throw error;
    }
  };
  const adapter = {
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      tolerate(
        () =>
          getDb()
            .prepare(sql)
            .get(...params) ?? null,
        null
      ),
    query: async (sql: string, params: SQLInputValue[] = []) =>
      tolerate(
        () =>
          getDb()
            .prepare(sql)
            .all(...params),
        []
      ),
    execute: async (sql: string, params: SQLInputValue[] = []) =>
      tolerate(
        () => {
          const result = getDb()
            .prepare(sql)
            .run(...params);
          return { success: true, rowsAffected: Number(result.changes) };
        },
        { success: true, rowsAffected: 0 }
      ),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string; params?: SQLInputValue[] }>) =>
      statements.map((statement) => {
        const result = getDb()
          .prepare(statement.sql)
          .run(...(statement.params ?? []));
        return { success: true, rowsAffected: Number(result.changes) };
      }),
  };
  return adapter as unknown as DatabaseAdapter;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: (source: unknown) => (source === 'admin-db' ? hooks.db : hooks.core),
    // The cancel handler: the tenant inventory (jobs and tenants) and the registry in DB_ADMIN.
    createD1Adapter: () => hooks.core,
    requireDedicatedAdminDatabaseAdapter: () => hooks.db,
    listEnvironmentTenantDefaultStores: async () => [
      { tenantId: 'operator-tenant', store: { source: 'core-db', bindingRef: 'CORE' } },
    ],
  };
});

vi.mock('../tenant-runtime-registry-route-state', async () => {
  const lib = await import('@authrim/ar-lib-core');
  // The real publisher, with its registry/pointer integrity checks; only the KV is a fake.
  async function publishSnapshot(
    repository: InstanceType<typeof lib.TenantDatabaseRegistryRepository>,
    options: { tenantId: string; actorId: string }
  ) {
    if (!hooks.signingKey) {
      const pair = (await crypto.subtle.generateKey('Ed25519', true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
      Object.assign(privateJwk, { kid: 'rr-key-1', alg: 'EdDSA', use: 'sig' });
      hooks.signingKey = { privateJwk, keyId: 'rr-key-1' };
    }
    return lib.publishTenantRuntimeRegistrySnapshot({
      tenantId: options.tenantId,
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
      repository,
      snapshotStore: { put: async () => undefined },
      deploymentTarget: 'default',
      actorId: options.actorId,
      signingKey: hooks.signingKey as never,
    });
  }
  return {
    publishTenantRuntimeRegistryRouteState: async (
      _env: unknown,
      options: Parameters<typeof lib.transitionTenantRuntimeRegistryRouteState>[1]
    ) => {
      hooks.publishes.push(`${options.routeStatus}:${options.operationId}`);
      const repository = new lib.TenantDatabaseRegistryRepository(hooks.db as DatabaseAdapter);
      const transition = await lib.transitionTenantRuntimeRegistryRouteState(repository, options);
      const publication = await publishSnapshot(repository, options);
      return { ...transition, publishedAt: publication.snapshot.publishedAt };
    },
    // The disaster-recovery inverse transition, real; only the snapshot store is a fake.
    publishTenantRuntimeRegistryReactivation: async (
      _env: unknown,
      options: Parameters<typeof lib.reactivateTenantRuntimeRegistryRouteState>[1]
    ) => {
      hooks.publishes.push(`reactivate:${options.operationId}`);
      const repository = new lib.TenantDatabaseRegistryRepository(hooks.db as DatabaseAdapter);
      const transition = await lib.reactivateTenantRuntimeRegistryRouteState(repository, options);
      // The database changed; the signed publication does not happen.
      if (hooks.publishFailsAfterDb) throw new Error('tenant_runtime_registry_publish_failed');
      const publication = await publishSnapshot(repository, options);
      return { ...transition, publishedAt: publication.snapshot.publishedAt };
    },
  };
});
vi.mock('../tenant-deletion-lookup-cleanup', () => ({
  disableTenantLookupDirectory: vi.fn(async () => {
    hooks.destructive.push('lookup');
  }),
  tenantLookupIdentifierDisableEvidence: vi.fn(async () => ({
    identifierRows: hooks.identifierRows,
    disabledIdentifierRows: (await hooks.lookupTouched()) ? 1 : 0,
  })),
}));
vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditLog: vi.fn(async (_c: unknown, input: Record<string, unknown>) => {
    hooks.onAudit();
    if (hooks.auditFails) return null;
    hooks.audit.push(input);
    return 'audit-1';
  }),
}));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: vi.fn(async () => hooks.stepUp()),
}));
vi.mock('../tenant-deletion-authoritative-purge', () => ({
  purgeTenantAuthoritativeShards: vi.fn(async () => {
    hooks.destructive.push('purge');
  }),
}));
vi.mock('../tenant-deletion-admin-accounts', () => ({
  purgeTenantHomedAdmins: vi.fn(async () => ({ removed: 0, kept: [] })),
  createTenantAdminPurgeAuditWriter: vi.fn(() => vi.fn()),
}));

import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';
import { cancelTenantDeletion } from '../tenant-deletion-cancel';
import { resolveTenantDeletionChainOperationId } from '../tenant-deletion-chain';
import { failedTenantDeletionNeedsCancel } from '../tenant-deletion-reactivation-guard';

function openAdminDb(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  const baseline = readFileSync(BASELINE, 'utf8');
  for (const table of [
    'tenant_database_registry',
    'tenant_database_active_pointers',
    'tenant_runtime_cache_generations',
    'tenant_runtime_registry_snapshots',
  ]) {
    const match = new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`, 'u').exec(baseline);
    if (!match) throw new Error(`baseline_ddl_missing:${table}`);
    db.exec(match[0]);
  }
  return db;
}

function seedRoute(db: SQLiteDatabase, routeStatus: string | null, operationId = CHAIN) {
  if (!routeStatus) return;
  db.prepare(
    `INSERT INTO tenant_runtime_cache_generations
       (tenant_id, cache_namespace, generation, metadata_json)
     VALUES (?, 'runtime_registry', 2, ?)`
  ).run(
    TENANT,
    JSON.stringify({
      route_status: routeStatus,
      quarantine_deny_generation: 1,
      route_state_operation_id: operationId,
    })
  );
}

function controlEnvironment() {
  return {
    DB_ADMIN: 'admin-db',
    AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      getTenantDeletionInventory: async ({ tenantId, operationId }: Record<string, string>) => ({
        environmentId: 'test',
        tenantId,
        operationId,
        state: 'ready',
        lookupShards: [],
        tenantShards: [],
      }),
      finalizeTenantDeletionControlState: async ({
        tenantId,
        operationId,
      }: Record<string, string>) => {
        hooks.destructive.push('finalize');
        return {
          environmentId: 'test',
          tenantId,
          operationId,
          state: 'finalized',
          finalizedAt: 1_700_000_000,
        };
      },
    },
  } as never;
}

describe('continued deletion job against the real route-state transition', () => {
  let admin: SQLiteDatabase;
  let core: SQLiteDatabase;

  beforeEach(() => {
    hooks.publishes = [];
    hooks.destructive = [];
    admin = openAdminDb();
    core = new DatabaseSync(':memory:');
    core.exec(`CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, progress TEXT, config TEXT,
      attempt_count INTEGER, max_attempts INTEGER, next_run_at INTEGER, completed_at INTEGER,
      started_at INTEGER, updated_at INTEGER, created_at INTEGER, error_message TEXT
    )`);
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES ('job-new', 'operator-tenant', 'tenants/delete', 'pending', ?, 1, 1)`
      )
      .run(JSON.stringify({ tenant_id: TENANT, operation_id: CHAIN, skip_backup: true }));
    hooks.db = sqliteAdapter(() => admin);
    hooks.core = sqliteAdapter(() => core);
  });

  const jobStatus = () =>
    core.prepare("SELECT status, error_message FROM admin_jobs WHERE id = 'job-new'").get() as {
      status: string;
      error_message: string | null;
    };

  const START = new Date('2026-11-14T12:00:00Z');
  const row = () =>
    core
      .prepare("SELECT status, progress, config, next_run_at FROM admin_jobs WHERE id = 'job-new'")
      .get() as {
      status: string;
      progress: string;
      config: string;
      next_run_at: number | null;
    };

  it('drains again, then completes, when the predecessor left the route quarantining', async () => {
    seedRoute(admin, 'quarantining');
    const log = { info: vi.fn(), error: vi.fn() };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(START);
      const startSeconds = Math.floor(START.getTime() / 1000);
      await processPendingTenantDeletionJobs(controlEnvironment(), log);

      // The drain restarted: waiting, with the deadline recorded, nothing destructive run.
      expect(row().status).toBe('pending');
      expect(JSON.parse(row().progress)).toMatchObject({ stage: 'quarantine_draining' });
      expect(JSON.parse(row().config)).toMatchObject({
        operation_id: CHAIN,
        quarantine_started_at: startSeconds,
      });
      expect(row().next_run_at).toBe(startSeconds + 30 * 60);
      expect(hooks.destructive).toEqual([]);

      // Before the deadline the job is not selected at all.
      vi.setSystemTime(new Date(START.getTime() + 10 * 60 * 1000));
      await processPendingTenantDeletionJobs(controlEnvironment(), log);
      expect(row().status).toBe('pending');
      expect(hooks.destructive).toEqual([]);

      // After it the job runs on to the end, without publishing `quarantining` again.
      vi.setSystemTime(new Date(START.getTime() + 31 * 60 * 1000));
      await processPendingTenantDeletionJobs(controlEnvironment(), log);
    } finally {
      vi.useRealTimers();
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(row().status).toBe('completed');
    // The marker was persisted before the lookup disable, on top of the quarantine bookkeeping.
    const persisted = JSON.parse(row().config) as Record<string, unknown>;
    expect(persisted).toMatchObject({ operation_id: CHAIN, marker_aware: true });
    expect(typeof persisted.destructive_started_at).toBe('number');
    expect(typeof persisted.quarantine_started_at).toBe('number');
    expect(hooks.destructive).toEqual(['lookup', 'purge', 'finalize']);
    expect(hooks.publishes).toEqual([
      `quarantining:${CHAIN}`,
      `quarantined:${CHAIN}`,
      `disabled:${CHAIN}`,
    ]);
  });

  it('skips the drain and completes when the predecessor left the route quarantined', async () => {
    seedRoute(admin, 'quarantined');
    const log = { info: vi.fn(), error: vi.fn() };
    await processPendingTenantDeletionJobs(controlEnvironment(), log);
    expect(log.error).not.toHaveBeenCalled();
    expect(jobStatus()).toMatchObject({ status: 'completed' });
    expect(hooks.publishes).toEqual([`quarantined:${CHAIN}`, `disabled:${CHAIN}`]);
  });

  it('does not run the destructive step when the marker cannot be persisted', async () => {
    seedRoute(admin, 'quarantined');
    core.exec(
      `CREATE TRIGGER no_marker BEFORE UPDATE OF config ON admin_jobs
       WHEN NEW.config LIKE '%destructive_started_at%'
       BEGIN SELECT RAISE(ABORT, 'marker write failed'); END`
    );
    const log = { info: vi.fn(), error: vi.fn() };
    await processPendingTenantDeletionJobs(controlEnvironment(), log);
    expect(hooks.destructive).toEqual([]);
    expect(jobStatus().status).not.toBe('completed');
    // And once the write works, the marker is written once, before the destructive step.
    core.exec('DROP TRIGGER no_marker');
    core.prepare("UPDATE admin_jobs SET status = 'pending', next_run_at = NULL").run();
    await processPendingTenantDeletionJobs(controlEnvironment(), log);
    expect(hooks.destructive).toEqual(['lookup', 'purge', 'finalize']);
  });

  function seedFailedStores(db: SQLiteDatabase) {
    for (const [role, shardGroup] of [
      ['tenant_core', 'default'],
      ['tenant_pii', 'default'],
    ]) {
      db.prepare(
        `INSERT INTO tenant_database_registry (
           tenant_id, role, generation, shard_group, shard_index, provider, database_id,
           database_name, binding_ref, schema_version, status, shard_count, shard_key_strategy,
           deployment_target, metadata_json
         ) VALUES (?, ?, 1, ?, 0, 'd1', ?, ?, ?, 2, 'failed', 1, 'none', 'default', '{}')`
      ).run(TENANT, role, shardGroup, `db-${role}`, `name-${role}`, `BIND_${role}`);
      db.prepare(
        `INSERT INTO tenant_database_active_pointers (
           tenant_id, role, shard_group, generation, shard_count, shard_key_strategy,
           runtime_generation, status
         ) VALUES (?, ?, ?, 1, 1, 'none', 2, 'active')`
      ).run(TENANT, role, shardGroup);
    }
  }

  it('completes when the predecessor left the route disabled over failed registry rows and active pointers', async () => {
    seedRoute(admin, 'disabled');
    seedFailedStores(admin);
    const env = controlEnvironment() as { CONTROL: Record<string, unknown> };
    const log = { info: vi.fn(), error: vi.fn() };
    await processPendingTenantDeletionJobs(
      {
        ...env,
        CONTROL: {
          ...env.CONTROL,
          getTenantDeletionInventory: async ({
            tenantId,
            operationId,
          }: Record<string, string>) => ({
            environmentId: 'test',
            tenantId,
            operationId,
            state: 'finalized',
            lookupShards: [],
            tenantShards: [],
          }),
        },
      } as never,
      log
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(jobStatus()).toMatchObject({ status: 'completed' });
    expect(hooks.publishes).toEqual([`disabled:${CHAIN}`]);
    const statuses = (table: string) =>
      (
        admin.prepare(`SELECT DISTINCT status FROM ${table} WHERE tenant_id = ?`).all(TENANT) as {
          status: string;
        }[]
      ).map((row) => row.status);
    expect(statuses('tenant_database_active_pointers')).toEqual(['disabled']);
    expect(statuses('tenant_database_registry')).toEqual(['deleted']);
  });
});

/**
 * Cancelling a failed deletion through the real handler, the real jobs and tenants SQL, and the
 * real route-state transitions (the deletion's quarantine and DR's reactivation). Replaced:
 * snapshot publication (KV and signing), Lookup, Control, the audit writer and the step-up gate.
 */
describe('cancelling a failed tenant deletion', () => {
  let admin: SQLiteDatabase;
  let core: SQLiteDatabase;
  const OLD_JOB = '99999999-2222-4333-8444-555555555555';
  const kv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    delete: vi.fn(async () => undefined),
  };

  const superAdmin: AdminAuthContext = {
    userId: 'admin-1',
    authMethod: 'bearer',
    actorType: 'human',
    roles: ['ar_super_admin'],
    globalRoles: ['ar_super_admin'],
    tenantScope: ['*'],
    permissions: ['*'],
  };

  function environment(control?: Record<string, unknown>) {
    const base = controlEnvironment() as unknown as { CONTROL: Record<string, unknown> };
    return {
      ...base,
      DB: 'core-db',
      BASE_DOMAIN: 'op.example.com',
      AUTHRIM_CONFIG: kv,
      CONTROL: { ...base.CONTROL, ...control },
    } as unknown as Env;
  }

  async function cancel(
    body: unknown = { reason: 'operator abandoned the deletion' },
    options: { tenantId?: string; env?: Env; auth?: AdminAuthContext } = {}
  ) {
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/admin/tenants/:id/deletion/cancel', async (c) => {
      (c as unknown as { set(k: string, v: unknown): void }).set(
        'adminAuth',
        options.auth ?? superAdmin
      );
      (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', 'default');
      return cancelTenantDeletion(c);
    });
    const response = await app.request(
      `/api/admin/tenants/${options.tenantId ?? TENANT}/deletion/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      options.env ?? environment()
    );
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }

  const routeRow = () =>
    JSON.parse(
      (
        admin
          .prepare(
            "SELECT metadata_json FROM tenant_runtime_cache_generations WHERE tenant_id = ? AND cache_namespace = 'runtime_registry'"
          )
          .get(TENANT) as { metadata_json: string } | undefined
      )?.metadata_json ?? 'null'
    ) as Record<string, unknown> | null;
  const routeJson = () =>
    (admin
      .prepare('SELECT generation, metadata_json FROM tenant_runtime_cache_generations')
      .get() as Record<string, unknown> | undefined) ?? null;
  const tenantRow = () =>
    core.prepare('SELECT lifecycle_state, updated_at FROM tenants WHERE id = ?').get(TENANT) as {
      lifecycle_state: string;
      updated_at: number;
    };
  const oldJob = () =>
    core
      .prepare('SELECT status, error_message, progress FROM admin_jobs WHERE id = ?')
      .get(OLD_JOB) as {
      status: string;
      error_message: string | null;
      progress: string | null;
    };

  beforeEach(() => {
    hooks.publishes = [];
    hooks.destructive = [];
    hooks.audit = [];
    hooks.auditFails = false;
    hooks.onAudit = () => undefined;
    hooks.publishFailsAfterDb = false;
    hooks.stepUp = () => null;
    hooks.lookupTouched = async () => false;
    hooks.identifierRows = 1;
    kv.delete.mockClear();
    admin = openAdminDb();
    core = new DatabaseSync(':memory:');
    core.exec(`
      CREATE TABLE admin_jobs (
        id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, progress TEXT, config TEXT,
        attempt_count INTEGER, max_attempts INTEGER, next_run_at INTEGER, completed_at INTEGER,
        started_at INTEGER, updated_at INTEGER, created_at INTEGER, error_message TEXT
      );
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, is_default INTEGER DEFAULT 0,
        default_tenant_guard TEXT, updated_at INTEGER
      );
    `);
    core
      .prepare("INSERT INTO tenants (id, lifecycle_state, updated_at) VALUES (?, 'suspended', 100)")
      .run(TENANT);
    // The failed deletion: its chain id is the route's operation id.
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, progress, config, error_message, created_at, updated_at)
         VALUES (?, 'operator-tenant', 'tenants/delete', 'failed', '{"stage":"retry_scheduled"}', ?, 'tenant_deletion_lookup_cleanup_unavailable', 10, 20)`
      )
      .run(
        OLD_JOB,
        JSON.stringify({
          tenant_id: TENANT,
          operation_id: CHAIN,
          skip_backup: true,
          marker_aware: true,
        })
      );
    seedActiveStores(admin);
    hooks.db = sqliteAdapter(() => admin);
    hooks.core = sqliteAdapter(() => core);
  });

  /** The tenant's two stores, active in the registry and by pointer: what a live tenant has. */
  function seedActiveStores(db: SQLiteDatabase) {
    for (const role of ['tenant_core', 'tenant_pii']) {
      db.prepare(
        `INSERT INTO tenant_database_registry (
           tenant_id, role, generation, shard_group, shard_index, provider, database_id,
           database_name, binding_ref, schema_version, status, shard_count, shard_key_strategy,
           deployment_target, metadata_json
         ) VALUES (?, ?, 1, 'default', 0, 'd1', ?, ?, ?, 2, 'active', 1, 'none', 'default', ?)`
      ).run(
        TENANT,
        role,
        `db-${role}`,
        `name-${role}`,
        `BIND_${role}`,
        JSON.stringify({
          control_data_role: role === 'tenant_pii' ? 'tenant_pii' : 'tenant_core/default',
          control_residency_policy_id: 'residency-1',
          control_residency_partition: 'eu',
          control_shard_id: `shard-${role}`,
          control_allocation_scope: 'tenant_exclusive',
          control_owner_tenant_id: TENANT,
          control_assignment_generation: 1,
          control_placement_policy_generation: 7,
        })
      );
      db.prepare(
        `INSERT INTO tenant_database_active_pointers (
           tenant_id, role, shard_group, generation, shard_count, shard_key_strategy,
           runtime_generation, status
         ) VALUES (?, ?, 'default', 1, 1, 'none', 2, 'active')`
      ).run(TENANT, role);
    }
  }

  async function freshDeletionCompletes(jobId: string) {
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES (?, 'operator-tenant', 'tenants/delete', 'pending', ?, 1000, 1000)`
      )
      .run(jobId, JSON.stringify({ tenant_id: TENANT, skip_backup: true }));
    // What the DELETE API decides for it: nothing to adopt, the job keeps its own id.
    expect(
      await resolveTenantDeletionChainOperationId(hooks.core as never, hooks.db as never, TENANT)
    ).toBeNull();
    const log = { info: vi.fn(), error: vi.fn() };
    const start = new Date('2026-11-14T12:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      await processPendingTenantDeletionJobs(environment(), log);
      vi.setSystemTime(new Date(start.getTime() + 31 * 60 * 1000));
      await processPendingTenantDeletionJobs(environment(), log);
    } finally {
      vi.useRealTimers();
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(core.prepare('SELECT status FROM admin_jobs WHERE id = ?').get(jobId)).toMatchObject({
      status: 'completed',
    });
  }

  it.each(['quarantining', 'quarantined'])(
    'cancels from %s: reactivates the route, marks the job, keeps the tenant suspended; a fresh deletion then runs under its own operation id',
    async (status) => {
      seedRoute(admin, status);
      const result = await cancel();
      expect(result).toEqual({
        status: 200,
        body: {
          tenant_id: TENANT,
          lifecycle_state: 'suspended',
          cancelled_job_id: OLD_JOB,
          operation_id: CHAIN,
          route_status_before: status,
          route_reactivated: true,
        },
      });
      expect(routeRow()).toMatchObject({
        route_status: 'active',
        route_state_operation_id: CHAIN,
        quarantine_deny_generation: 1,
      });
      expect(hooks.publishes).toEqual([`reactivate:${CHAIN}`]);
      expect(oldJob()).toMatchObject({
        status: 'failed',
        error_message: 'tenant_deletion_cancelled',
      });
      expect(JSON.parse(oldJob().progress ?? '{}')).toMatchObject({
        stage: 'cancelled',
        cancelled_by: 'admin-1',
      });
      expect(tenantRow().lifecycle_state).toBe('suspended');
      expect(tenantRow().updated_at).toBeGreaterThan(100);
      expect(hooks.audit).toHaveLength(1);
      expect(hooks.audit[0]).toMatchObject({
        action: 'tenant.delete_cancelled',
        resourceType: 'tenant',
        resourceId: TENANT,
        metadata: {
          job_id: OLD_JOB,
          operation_id: CHAIN,
          route_status_before: status,
          reason: 'operator abandoned the deletion',
        },
      });
      expect(kv.delete).toHaveBeenCalledTimes(1);

      const NEW_JOB = 'aaaaaaaa-2222-4333-8444-555555555555';
      await freshDeletionCompletes(NEW_JOB);
      expect(hooks.publishes).toEqual([
        `reactivate:${CHAIN}`,
        `quarantining:${NEW_JOB}`,
        `quarantined:${NEW_JOB}`,
        `disabled:${NEW_JOB}`,
      ]);
    }
  );

  it('a cancelled job is never adopted by a later deletion', async () => {
    seedRoute(admin, 'quarantined');
    // Control: while the failed job is not cancelled it is adopted.
    expect(
      await resolveTenantDeletionChainOperationId(hooks.core as never, hooks.db as never, TENANT)
    ).toBe(CHAIN);
    core
      .prepare("UPDATE admin_jobs SET error_message = 'tenant_deletion_cancelled' WHERE id = ?")
      .run(OLD_JOB);
    expect(
      await resolveTenantDeletionChainOperationId(hooks.core as never, hooks.db as never, TENANT)
    ).toBeNull();
  });

  it('an idempotent repeat answers 200 already_cancelled and changes nothing more', async () => {
    seedRoute(admin, 'quarantining');
    expect((await cancel()).status).toBe(200);
    const routeAfter = routeJson();
    const tenantAfter = tenantRow();
    const again = await cancel();
    expect(again).toEqual({
      status: 200,
      body: {
        tenant_id: TENANT,
        lifecycle_state: 'suspended',
        cancelled_job_id: OLD_JOB,
        operation_id: CHAIN,
        route_status_before: 'active',
        route_reactivated: false,
        already_cancelled: true,
      },
    });
    expect(hooks.audit).toHaveLength(1);
    expect(hooks.publishes).toEqual([`reactivate:${CHAIN}`]);
    expect(routeJson()).toEqual(routeAfter);
    expect(tenantRow()).toEqual(tenantAfter);
  });

  it('a failed publication leaves the cancel incomplete (resume stays refused); a repeat re-publishes and completes', async () => {
    seedRoute(admin, 'quarantined');
    hooks.publishFailsAfterDb = true;
    const failed = await cancel();
    expect(failed).toMatchObject({
      status: 503,
      body: { error: 'tenant_route_reactivation_failed' },
    });
    // The database says active, the published route does not: the job says so.
    expect(routeRow()).toMatchObject({ route_status: 'active' });
    expect(JSON.parse(oldJob().progress ?? '{}')).toMatchObject({ stage: 'cancelling' });
    expect(oldJob().error_message).toBe('tenant_deletion_cancelled');
    expect(
      await failedTenantDeletionNeedsCancel(hooks.core as never, hooks.db as never, TENANT)
    ).toBe(true);

    // A repeat inside the lease is refused: the first request may still be publishing.
    hooks.publishFailsAfterDb = false;
    expect(await cancel()).toMatchObject({
      status: 409,
      body: { error: 'tenant_deletion_cancel_in_progress' },
    });
    // After the lease the repeat replays the reactivation (already active under the same id).
    core
      .prepare(
        "UPDATE admin_jobs SET progress = json_set(progress, '$.cancelling_at', 1) WHERE id = ?"
      )
      .run(OLD_JOB);
    hooks.publishes = [];
    const done = await cancel();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ route_reactivated: true, route_status_before: 'active' });
    expect(hooks.publishes).toEqual([`reactivate:${CHAIN}`]);
    expect(JSON.parse(oldJob().progress ?? '{}')).toMatchObject({ stage: 'cancelled' });
    expect(
      await failedTenantDeletionNeedsCancel(hooks.core as never, hooks.db as never, TENANT)
    ).toBe(false);
    // The refused repeat wrote no audit entry; the two requests that went on did.
    expect(hooks.audit).toHaveLength(2);
  });

  it('a newer failed job with its own chain does not hide the route owner: the repeat re-publishes under the owner id before anything is finalised', async () => {
    const NEWER = 'dddddddd-2222-4333-8444-555555555555';
    seedRoute(admin, 'quarantined');
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES (?, 'operator-tenant', 'tenants/delete', 'failed', ?, 50, 50)`
      )
      .run(NEWER, JSON.stringify({ tenant_id: TENANT, marker_aware: true }));
    const stages = () =>
      (
        core.prepare("SELECT progress FROM admin_jobs WHERE status = 'failed'").all() as {
          progress: string;
        }[]
      ).map((job) => (JSON.parse(job.progress) as { stage: string }).stage);

    hooks.publishFailsAfterDb = true;
    expect((await cancel()).status).toBe(503);
    expect(routeRow()).toMatchObject({ route_status: 'active', route_state_operation_id: CHAIN });
    expect(stages()).toEqual(['cancelling', 'cancelling']);
    expect(
      await failedTenantDeletionNeedsCancel(hooks.core as never, hooks.db as never, TENANT)
    ).toBe(true);

    hooks.publishFailsAfterDb = false;
    hooks.publishes = [];
    core.prepare("UPDATE admin_jobs SET progress = json_set(progress, '$.cancelling_at', 1)").run();
    const done = await cancel();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ operation_id: CHAIN, route_reactivated: true });
    // The publication ran under the OWNER's id, and only then were the jobs finalised.
    expect(hooks.publishes).toEqual([`reactivate:${CHAIN}`]);
    expect(stages()).toEqual(['cancelled', 'cancelled']);
    expect(
      await failedTenantDeletionNeedsCancel(hooks.core as never, hooks.db as never, TENANT)
    ).toBe(false);
  });

  it('a repeat on an incomplete cancel whose route is still quarantined goes on from the reactivation', async () => {
    seedRoute(admin, 'quarantined');
    core
      .prepare(
        "UPDATE admin_jobs SET error_message = 'tenant_deletion_cancelled', progress = ? WHERE id = ?"
      )
      .run(
        JSON.stringify({ stage: 'cancelling', cancelling_at: 150, cancelled_by: 'admin-1' }),
        OLD_JOB
      );
    const result = await cancel();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      route_reactivated: true,
      route_status_before: 'quarantined',
    });
    expect(routeRow()).toMatchObject({ route_status: 'active' });
    expect(JSON.parse(oldJob().progress ?? '{}')).toMatchObject({ stage: 'cancelled' });
  });

  it('a job with the destructive marker is past the point of no return, on the first request and on a repeat; the cancel stays incomplete', async () => {
    seedRoute(admin, 'quarantined');
    core
      .prepare(
        "UPDATE admin_jobs SET config = json_set(config, '$.destructive_started_at', 1700000000), error_message = 'tenant_deletion_cancelled', progress = ? WHERE id = ?"
      )
      .run(JSON.stringify({ stage: 'cancelling', cancelling_at: 150 }), OLD_JOB);
    expect(await cancel()).toMatchObject({
      status: 409,
      body: { error: 'tenant_deletion_past_point_of_no_return', stage: 'destructive_started' },
    });
    expect(JSON.parse(oldJob().progress ?? '{}')).toMatchObject({ stage: 'cancelling' });
    expect(routeRow()).toMatchObject({ route_status: 'quarantined' });
    expect(
      await failedTenantDeletionNeedsCancel(hooks.core as never, hooks.db as never, TENANT)
    ).toBe(true);
  });

  it('the marker of ANY job of the chain counts (an older failed job crossed the line)', async () => {
    seedRoute(admin, 'quarantined');
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES ('cccccccc-2222-4333-8444-555555555555', 'operator-tenant', 'tenants/delete', 'failed', ?, 30, 30)`
      )
      .run(
        JSON.stringify({
          tenant_id: TENANT,
          operation_id: CHAIN,
          marker_aware: true,
          destructive_started_at: 1700000000,
        })
      );
    // The latest job (the one with the marker) is not the one OLD_JOB: still refused.
    core
      .prepare(
        "UPDATE admin_jobs SET created_at = 5 WHERE id = 'cccccccc-2222-4333-8444-555555555555'"
      )
      .run();
    expect(await cancel()).toMatchObject({
      status: 409,
      body: { stage: 'destructive_started' },
    });
  });

  it('a failed job of the tenant OUTSIDE the chain that carries the marker refuses the whole cancel (the set verified is the set marked)', async () => {
    seedRoute(admin, 'quarantined');
    const before = routeJson();
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES ('eeeeeeee-2222-4333-8444-555555555555', 'operator-tenant', 'tenants/delete', 'failed', ?, 5, 5)`
      )
      .run(
        JSON.stringify({
          tenant_id: TENANT,
          marker_aware: true,
          destructive_started_at: 1700000000,
        })
      );
    expect(await cancel()).toMatchObject({
      status: 409,
      body: { error: 'tenant_deletion_past_point_of_no_return', stage: 'destructive_started' },
    });
    expect(routeJson()).toEqual(before);
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    expect(
      core.prepare('SELECT COUNT(*) AS n FROM admin_jobs WHERE error_message IS NOT NULL').get()
    ).toMatchObject({ n: 1 });
    expect(hooks.audit).toEqual([]);
    expect(hooks.publishes).toEqual([]);
  });

  it('a pre-marker job outside the chain brings the legacy identifier probe into play', async () => {
    seedRoute(admin, 'quarantined');
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES ('ffffffff-2222-4333-8444-555555555555', 'operator-tenant', 'tenants/delete', 'failed', ?, 5, 5)`
      )
      .run(JSON.stringify({ tenant_id: TENANT }));
    hooks.lookupTouched = async () => true;
    expect(await cancel()).toMatchObject({ status: 409, body: { stage: 'lookup_disabled' } });
  });

  it('an alias row disabled by an ordinary operation (a deleted client) does not block a job that never started the destructive step', async () => {
    // The probe is not consulted for a marker-aware job: its absence of the marker is the proof.
    seedRoute(admin, 'quarantined');
    hooks.lookupTouched = async () => true;
    expect((await cancel()).status).toBe(200);
  });

  describe('a job that predates the marker (no marker_aware)', () => {
    beforeEach(() => {
      core
        .prepare(
          "UPDATE admin_jobs SET config = json_remove(config, '$.marker_aware') WHERE id = ?"
        )
        .run(OLD_JOB);
      seedRoute(admin, 'quarantined');
    });

    it('is cancellable while the identifier table shows no disable (and has rows)', async () => {
      expect((await cancel()).status).toBe(200);
    });

    it('is refused when an identifier row is already disabled', async () => {
      hooks.lookupTouched = async () => true;
      expect(await cancel()).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_past_point_of_no_return', stage: 'lookup_disabled' },
      });
      expect(hooks.audit).toEqual([]);
    });

    it('is refused when the probe has no evidence (no identifier rows at all)', async () => {
      hooks.identifierRows = 0;
      expect(await cancel()).toMatchObject({
        status: 409,
        body: { stage: 'legacy_unverifiable' },
      });
    });

    it('is refused with 503 when the shards cannot be read', async () => {
      hooks.lookupTouched = async () => {
        throw new Error('tenant_deletion_lookup_binding_unavailable');
      };
      expect(await cancel()).toMatchObject({
        status: 503,
        body: { error: 'tenant_deletion_state_unverifiable' },
      });
    });
  });

  it('a deletion queued during the audit write wins: 409, no reactivation, nothing marked', async () => {
    seedRoute(admin, 'quarantined');
    const before = routeJson();
    hooks.onAudit = () => {
      core
        .prepare(
          `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
           VALUES ('bbbbbbbb-2222-4333-8444-555555555555', 'operator-tenant', 'tenants/delete', 'pending', ?, 200, 200)`
        )
        .run(JSON.stringify({ tenant_id: TENANT, operation_id: CHAIN }));
    };
    const result = await cancel();
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(routeJson()).toEqual(before);
    expect(hooks.publishes).toEqual([]);
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
  });

  it('cancels a failure that never reached quarantine (no route row): only the job is marked', async () => {
    const result = await cancel();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ route_reactivated: false, route_status_before: 'active' });
    expect(oldJob().error_message).toBe('tenant_deletion_cancelled');
  });

  it('refuses past the point of no return when the route is disabled, changing nothing', async () => {
    seedRoute(admin, 'disabled');
    const before = routeJson();
    const result = await cancel();
    expect(result).toMatchObject({
      status: 409,
      body: { error: 'tenant_deletion_past_point_of_no_return', stage: 'route_disabled' },
    });
    expect(routeJson()).toEqual(before);
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    expect(hooks.audit).toEqual([]);
  });

  it('never overrides a route another operation holds', async () => {
    seedRoute(admin, 'quarantined', '77777777-2222-4333-8444-555555555555');
    const before = routeJson();
    const result = await cancel();
    expect(result).toMatchObject({
      status: 409,
      body: { error: 'tenant_route_owned_by_other_operation' },
    });
    expect(routeJson()).toEqual(before);
    expect(hooks.publishes).toEqual([]);
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    expect(hooks.audit).toEqual([]);
  });

  describe('point-of-no-return probes (persisted state, fail closed)', () => {
    function expectUntouched(before: unknown) {
      expect(routeJson()).toEqual(before);
      expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
      expect(tenantRow()).toEqual({ lifecycle_state: 'suspended', updated_at: 100 });
      expect(hooks.audit).toEqual([]);
      expect(hooks.publishes).toEqual([]);
    }

    it('Control finalised: passed', async () => {
      seedRoute(admin, 'quarantined');
      const before = routeJson();
      const result = await cancel(
        { reason: 'abandon it' },
        {
          env: environment({
            getTenantDeletionInventory: async ({
              tenantId,
              operationId,
            }: Record<string, string>) => ({
              environmentId: 'test',
              tenantId,
              operationId,
              state: 'finalized',
              lookupShards: [],
              tenantShards: [],
            }),
          }),
        }
      );
      expect(result).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_past_point_of_no_return', stage: 'control_finalized' },
      });
      expectUntouched(before);
    });

    it('Control placement policy unavailable: passed', async () => {
      seedRoute(admin, 'quarantined');
      const before = routeJson();
      const result = await cancel(undefined, {
        env: environment({
          getTenantDeletionInventory: async () => {
            throw new Error('control_tenant_deletion_policy_unavailable');
          },
        }),
      });
      expect(result).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_past_point_of_no_return', stage: 'control_finalized' },
      });
      expectUntouched(before);
    });

    it('Control down or failing: 503, nothing changed', async () => {
      for (const control of [
        {
          getTenantDeletionInventory: async () => {
            throw new Error('control_unreachable');
          },
        },
        { getTenantDeletionInventory: undefined },
      ]) {
        seedRoute(admin, 'quarantined');
        const before = routeJson();
        const result = await cancel(undefined, { env: environment(control) });
        expect(result).toMatchObject({
          status: 503,
          body: { error: 'tenant_deletion_state_unverifiable' },
        });
        expectUntouched(before);
        admin.exec('DELETE FROM tenant_runtime_cache_generations');
      }
    });
  });

  it('refuses with 503 and changes nothing when the route state cannot be read', async () => {
    admin
      .prepare(
        `INSERT INTO tenant_runtime_cache_generations (tenant_id, cache_namespace, generation, metadata_json)
         VALUES (?, 'runtime_registry', 2, '{"route_status":"bogus"}')`
      )
      .run(TENANT);
    const result = await cancel();
    expect(result).toMatchObject({
      status: 503,
      body: { error: 'tenant_route_state_unavailable' },
    });
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    expect(hooks.audit).toEqual([]);
  });

  it('the step-up gate is asked, after the checks and before the first change', async () => {
    seedRoute(admin, 'quarantined');
    const before = routeJson();
    hooks.stepUp = () =>
      new Response(JSON.stringify({ error: 'step_up_human_required' }), { status: 403 });
    const result = await cancel();
    expect(result.status).toBe(403);
    expect(routeJson()).toEqual(before);
    expect(tenantRow()).toEqual({ lifecycle_state: 'suspended', updated_at: 100 });
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    expect(hooks.audit).toEqual([]);
  });

  it('loses the fence to a deletion queued meanwhile: 409, nothing cancelled', async () => {
    seedRoute(admin, 'quarantined');
    const before = routeJson();
    hooks.stepUp = () => {
      core
        .prepare(
          `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
           VALUES ('bbbbbbbb-2222-4333-8444-555555555555', 'operator-tenant', 'tenants/delete', 'pending', ?, 200, 200)`
        )
        .run(JSON.stringify({ tenant_id: TENANT }));
      return null;
    };
    const result = await cancel();
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(routeJson()).toEqual(before);
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    expect(hooks.publishes).toEqual([]);
  });

  it('loses the fence to a tenant version change meanwhile', async () => {
    seedRoute(admin, 'quarantined');
    hooks.stepUp = () => {
      core.prepare('UPDATE tenants SET updated_at = 150 WHERE id = ?').run(TENANT);
      return null;
    };
    const result = await cancel();
    expect(result).toMatchObject({ status: 409, body: { error: 'tenant_state_changed' } });
    expect(hooks.publishes).toEqual([]);
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
  });

  it('audit write failure: 503, the route, the job and the tenant state are unchanged', async () => {
    seedRoute(admin, 'quarantined');
    const before = routeJson();
    hooks.auditFails = true;
    const result = await cancel();
    expect(result).toMatchObject({ status: 503, body: { error: 'audit_unavailable' } });
    expect(routeJson()).toEqual(before);
    expect(hooks.publishes).toEqual([]);
    expect(oldJob()).toMatchObject({ status: 'failed' });
    expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    // No write at all before the audit: not even the tenant version moved.
    expect(tenantRow()).toEqual({ lifecycle_state: 'suspended', updated_at: 100 });
    // A repeat once the audit store is back completes.
    hooks.auditFails = false;
    expect((await cancel()).status).toBe(200);
    expect(routeRow()).toMatchObject({ route_status: 'active' });
  });

  describe('tenant and job state decide', () => {
    it('deleting: 409 tenant_deletion_in_progress', async () => {
      core.prepare("UPDATE tenants SET lifecycle_state = 'deleting' WHERE id = ?").run(TENANT);
      expect(await cancel()).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_in_progress' },
      });
    });

    it.each(['active', 'frozen', 'deleted'])(
      '%s: 409 tenant_deletion_not_failed',
      async (state) => {
        core.prepare('UPDATE tenants SET lifecycle_state = ? WHERE id = ?').run(state, TENANT);
        expect(await cancel()).toMatchObject({
          status: 409,
          body: { error: 'tenant_deletion_not_failed' },
        });
      }
    );

    it('an active deletion job: 409 tenant_deletion_in_progress', async () => {
      core.prepare("UPDATE admin_jobs SET status = 'pending' WHERE id = ?").run(OLD_JOB);
      expect(await cancel()).toMatchObject({
        status: 409,
        body: { error: 'tenant_deletion_in_progress' },
      });
    });

    it('no deletion job, or a completed one: 409 tenant_deletion_not_failed', async () => {
      core.prepare("UPDATE admin_jobs SET status = 'completed' WHERE id = ?").run(OLD_JOB);
      expect((await cancel()).body.error).toBe('tenant_deletion_not_failed');
      core.exec('DELETE FROM admin_jobs');
      expect((await cancel()).body.error).toBe('tenant_deletion_not_failed');
    });

    it('a cancelled job whose route is not active is not an idempotent replay', async () => {
      seedRoute(admin, 'quarantined');
      core
        .prepare(
          'UPDATE admin_jobs SET error_message = \'tenant_deletion_cancelled\', progress = \'{"stage":"cancelled"}\' WHERE id = ?'
        )
        .run(OLD_JOB);
      expect((await cancel()).body.error).toBe('tenant_deletion_not_failed');
    });

    it('unknown tenant: 404; primary tenant and default tenant refused', async () => {
      expect((await cancel(undefined, { tenantId: 'nobody' })).status).toBe(404);
      expect((await cancel(undefined, { tenantId: 'default' })).status).toBe(400);
      core.prepare('UPDATE tenants SET is_default = 1 WHERE id = ?').run(TENANT);
      expect((await cancel()).status).toBe(400);
    });

    it('a strict body: reason of 3..1000 characters, nothing else', async () => {
      for (const body of [
        {},
        { reason: 'ab' },
        { reason: 'x'.repeat(1001) },
        { reason: 'fine reason', extra: 1 },
        'not json',
      ]) {
        expect((await cancel(body)).status).toBe(400);
      }
      expect(oldJob().error_message).not.toBe('tenant_deletion_cancelled');
    });

    it('is refused for a tenant-scoped admin before anything is read', async () => {
      const result = await cancel(undefined, {
        auth: {
          ...superAdmin,
          roles: ['ar_tenant_admin'],
          globalRoles: [],
          tenantScope: [TENANT],
        },
      });
      expect(result.status).toBe(403);
      expect(hooks.audit).toEqual([]);
    });
  });
});

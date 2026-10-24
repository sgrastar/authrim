import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import { insertTenant, openCoreDatabase } from './helpers/core-database';
import { d1OverSqlite } from './helpers/d1-over-sqlite';

/**
 * The workflows that keep admin jobs for the scheduled admin job run (tenant lifecycle validation,
 * the backup before a tenant deletion, Support Ops cohort snapshots), over the real baselines as
 * three databases: the tenant inventory (`DB`), the tenant's routed Core database, and DB_ADMIN. A
 * row kept in one and looked for in another is never found.
 */
const mocks = vi.hoisted(() => ({
  core: null as DatabaseAdapter | null,
  coreSource: null as D1Database | null,
  /** Runs before the tenant's Core database is resolved (to interleave another run). */
  beforeTenantResolve: null as ((partition: string) => void) | null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'platform'),
    // As the resolver does: the tenant's Core database for a tenant, DB_ADMIN without one.
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: Env, partition: string, options?: { tenantId?: string }) => {
        if (!options?.tenantId) return actual.ensureDatabaseAdapter(env.DB_ADMIN!, partition);
        mocks.beforeTenantResolve?.(partition);
        return mocks.core;
      }
    ),
    // A job's tenant metadata database (a Support Ops snapshot's), of a tenant whose accounts
    // are in it.
    resolveTenantMetadataContext: vi.fn(async (_env: Env, tenantId: string) => {
      mocks.beforeTenantResolve?.('support-ops-snapshot-tenant');
      return { tenantId, coreDb: mocks.core };
    }),
    listEnvironmentTenantDefaultStores: vi.fn(async () => [
      { tenantId: 'platform', store: { source: mocks.coreSource, bindingRef: 'DB' } },
    ]),
    createAuditLogFromContext: vi.fn(async () => undefined),
    emitRuntimeLogRecords: vi.fn(async () => ({ tenantKey: 'tk_test', targetResults: [] })),
  };
});

vi.mock('../admin-tenant-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-tenant-access')>()),
  requirePlatformTenantManagementAuthority: vi.fn(async () => null),
  getAdminAuth: vi.fn(() => ({ userId: 'admin-1', actorId: 'admin-1', permissions: ['*'] })),
}));

vi.mock('../single-tenant-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../single-tenant-guard')>()),
  ensureSupportedTenantId: vi.fn(async () => null),
}));

import {
  adminTenantLifecycleJobRetryHandler,
  adminTenantLifecycleJobsHandler,
  adminTenantResumeHandler,
} from '../admin-tenants';
import { processPendingGenericAdminJobs } from '../admin-job-executor';
import { deleteTenantAdminJobs, processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';
import { processPendingSupportOpsSnapshotJobs } from '../support-ops';
import { createAuditLogFromContext, ensureDatabaseAdapter } from '@authrim/ar-lib-core';

const REPO_ROOT = resolve(__dirname, '../../../..');
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

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

function jobsIn(db: SQLiteDatabase) {
  return db
    .prepare('SELECT id, job_type, status FROM admin_jobs ORDER BY created_at, id')
    .all() as Array<{
    id: string;
    job_type: string;
    status: string;
  }>;
}

let inventory: SQLiteDatabase;
let core: SQLiteDatabase;
let admin: SQLiteDatabase;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beforeTenantResolve = null;
  // The tenant inventory, where lifecycle commands and deletion move tenants.
  inventory = openCoreDatabase();
  insertTenant(inventory, 'platform');
  insertTenant(inventory, 'tenant-a');
  // The tenant's routed Core database: its own tenants row is not the one lifecycle reads.
  core = openCoreDatabase();
  // Created by a later Core migration (the baseline predates it).
  core.exec(
    `CREATE TABLE authrim_runtime_probes (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL, probe_kind TEXT NOT NULL,
       nonce TEXT NOT NULL, created_at INTEGER NOT NULL
     )`
  );
  insertTenant(core, 'platform');
  insertTenant(core, 'tenant-a');
  admin = openAdminDatabase();
  mocks.coreSource = d1OverSqlite(core);
  mocks.core = ensureDatabaseAdapter(mocks.coreSource, 'test-core');
  env = { DB: d1OverSqlite(inventory), DB_ADMIN: d1OverSqlite(admin) } as unknown as Env;
});

describe('tenant lifecycle validation', () => {
  const settingsKv = {
    get: vi.fn(async (key: string) =>
      key === 'settings:tenant:tenant-a:tenant'
        ? JSON.stringify({ 'tenant.allowed_identifiers': 'https://tenant-a.auth.example.com' })
        : null
    ),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };

  function createApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/admin/tenants/:id/resume', adminTenantResumeHandler);
    app.get('/api/admin/tenants/:id/lifecycle/jobs', adminTenantLifecycleJobsHandler);
    app.post(
      '/api/admin/tenants/:id/lifecycle/jobs/:jobId/retry',
      adminTenantLifecycleJobRetryHandler
    );
    return app;
  }

  const tenantRow = () =>
    inventory
      .prepare("SELECT lifecycle_state, updated_at FROM tenants WHERE id = 'tenant-a'")
      .get() as {
      lifecycle_state: string;
      updated_at: number;
    };

  beforeEach(() => {
    inventory
      .prepare(
        "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = 10 WHERE id = 'tenant-a'"
      )
      .run();
    env = { ...env, BASE_DOMAIN: 'auth.example.com', AUTHRIM_CONFIG: settingsKv } as unknown as Env;
  });

  const resume = (app: ReturnType<typeof createApp>, key = 'resume-1') =>
    app.request(
      '/api/admin/tenants/tenant-a/resume',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({
          expected_state: 'suspended',
          expected_updated_at: 10,
          reason: 'incident resolved',
        }),
      },
      env
    );

  it('keeps the job in DB_ADMIN, where the scheduled run validates and resumes the tenant', async () => {
    const app = createApp();
    const res = await resume(app);
    expect(res.status).toBe(202);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(jobsIn(inventory)).toEqual([]);
    expect(jobsIn(admin)).toEqual([
      { id: job_id, job_type: 'tenants/lifecycle-validation', status: 'pending' },
    ]);

    // Replayed: the same job, from DB_ADMIN.
    const replay = await resume(app);
    expect(((await replay.json()) as { job_id: string }).job_id).toBe(job_id);

    await processPendingGenericAdminJobs(env, logger);

    expect(jobsIn(admin)[0]?.status).toBe('completed');
    expect(tenantRow().lifecycle_state).toBe('active');
  });

  it('moves the tenant back when its job cannot be kept, so the request can be sent again', async () => {
    const app = createApp();
    // The job is not kept (the idempotency lookup before it still reads DB_ADMIN).
    admin.exec(
      "CREATE TRIGGER jobs_unavailable BEFORE INSERT ON admin_jobs BEGIN SELECT RAISE(ABORT, 'unavailable'); END"
    );

    expect((await resume(app)).status).toBe(500);
    expect(tenantRow()).toEqual({ lifecycle_state: 'suspended', updated_at: 10 });

    admin.exec('DROP TRIGGER jobs_unavailable');
    expect((await resume(app)).status).toBe(202);
    expect(jobsIn(admin)).toHaveLength(1);
  });

  it('records the move it could not undo when the job is not kept', async () => {
    const app = createApp();
    admin.exec(
      "CREATE TRIGGER jobs_unavailable BEFORE INSERT ON admin_jobs BEGIN SELECT RAISE(ABORT, 'unavailable'); END"
    );
    // The move back fails too.
    inventory.exec(
      "CREATE TRIGGER no_move_back BEFORE UPDATE ON tenants WHEN NEW.updated_at = 10 BEGIN SELECT RAISE(ABORT, 'unavailable'); END"
    );

    expect((await resume(app)).status).toBe(500);

    expect(tenantRow().updated_at).toBeGreaterThan(10);
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.lifecycle.resume',
      'tenant',
      'tenant-a',
      expect.objectContaining({ job_id: null, job_kept: false, target_state: 'suspended' })
    );
  });

  const insertLegacyValidation = () =>
    inventory
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, error_code, created_by,
           created_at, updated_at)
         VALUES ('legacy-1', 'tenant-a', 'tenants/lifecycle-validation', 'failed', ?, 'admin_job_store_moved',
           'admin-1', 5, 5)`
      )
      .run(
        JSON.stringify({
          command: 'resume',
          source_state: 'suspended',
          target_state: 'active',
          reason: 'incident resolved',
          idempotency_key: 'old-key',
        })
      );

  it('moves a validation kept in the tenant inventory to DB_ADMIN when it is retried', async () => {
    insertLegacyValidation();
    const app = createApp();

    const listed = await app.request('/api/admin/tenants/tenant-a/lifecycle/jobs', {}, env);
    expect(
      ((await listed.json()) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)
    ).toEqual(['legacy-1']);

    const retried = await app.request(
      '/api/admin/tenants/tenant-a/lifecycle/jobs/legacy-1/retry',
      { method: 'POST' },
      env
    );
    expect(retried.status).toBe(202);
    expect(jobsIn(inventory)).toEqual([]);
    expect(jobsIn(admin)).toEqual([
      { id: 'legacy-1', job_type: 'tenants/lifecycle-validation', status: 'pending' },
    ]);

    await processPendingGenericAdminJobs(env, logger);
    expect(jobsIn(admin)[0]?.status).toBe('completed');
    expect(tenantRow().lifecycle_state).toBe('active');

    const after = await app.request('/api/admin/tenants/tenant-a/lifecycle/jobs', {}, env);
    expect(((await after.json()) as { jobs: Array<{ id: string }> }).jobs).toHaveLength(1);
  });

  it('removes the inventory copy a retry left when it stopped half way through a move', async () => {
    insertLegacyValidation();
    // The move kept the job in DB_ADMIN, then stopped before removing it from the inventory.
    admin
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_by, created_at,
           updated_at)
         VALUES ('legacy-1', 'tenant-a', 'tenants/lifecycle-validation', 'pending', '{}', 'admin-1', 5, 6)`
      )
      .run();
    const app = createApp();

    const listed = await app.request('/api/admin/tenants/tenant-a/lifecycle/jobs', {}, env);
    expect((await listed.json()) as unknown).toMatchObject({
      jobs: [{ id: 'legacy-1', status: 'pending' }],
    });
    const retried = await app.request(
      '/api/admin/tenants/tenant-a/lifecycle/jobs/legacy-1/retry',
      { method: 'POST' },
      env
    );

    expect(retried.status).toBe(409);
    expect(jobsIn(inventory)).toEqual([]);
    expect(jobsIn(admin)).toEqual([
      { id: 'legacy-1', job_type: 'tenants/lifecycle-validation', status: 'pending' },
    ]);
  });
});

describe('backup before a tenant deletion', () => {
  const getTenantDeletionInventory = vi.fn(async () => {
    throw new Error('tenant_deletion_test_stops_after_backup');
  });

  beforeEach(() => {
    getTenantDeletionInventory.mockClear();
    env = {
      ...env,
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      AUTHRIM_CONFIG: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
      CONTROL: { getTenantDeletionInventory },
    } as unknown as Env;
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_by, created_at, updated_at)
         VALUES ('delete-1', 'platform', 'tenants/delete', 'pending', ?, 'admin-1', 1, 1)`
      )
      .run(JSON.stringify({ tenant_id: 'tenant-a' }));
  });

  const deletionJob = () =>
    core.prepare("SELECT status, progress, config FROM admin_jobs WHERE id = 'delete-1'").get() as {
      status: string;
      progress: string;
      config: string;
    };
  const backupId = 'tenant-delete-backup:delete-1';
  const setBackupStatus = (status: string) =>
    admin.prepare('UPDATE admin_jobs SET status = ? WHERE id = ?').run(status, backupId);

  it('goes past the backup only once the export the scheduled run claims completed', async () => {
    await processPendingTenantDeletionJobs(env, logger);
    expect(jobsIn(admin)).toEqual([
      { id: backupId, job_type: 'tenant-database/export', status: 'pending' },
    ]);
    expect(jobsIn(core).map((job) => job.id)).toEqual(['delete-1']);
    expect(JSON.parse(deletionJob().progress).stage).toBe('backup_requested');

    // The scheduled admin job run claims the export (this test gives it no artifact storage, so
    // the attempt fails and is retried).
    await processPendingGenericAdminJobs(env, logger);
    const claimed = admin
      .prepare('SELECT attempt_count, error_message FROM admin_jobs WHERE id = ?')
      .get(backupId) as { attempt_count: number; error_message: string };
    expect(claimed.attempt_count).toBe(1);
    expect(claimed.error_message).toContain('EXPORT_ARTIFACTS');

    await processPendingTenantDeletionJobs(env, logger);
    expect(JSON.parse(deletionJob().progress).stage).toBe('backup_waiting');
    expect(getTenantDeletionInventory).not.toHaveBeenCalled();

    setBackupStatus('completed');
    await processPendingTenantDeletionJobs(env, logger);
    expect(getTenantDeletionInventory).toHaveBeenCalledOnce();
  });

  it('stops the deletion when the export failed', async () => {
    await processPendingTenantDeletionJobs(env, logger);
    setBackupStatus('failed');

    await processPendingTenantDeletionJobs(env, logger);

    expect(deletionJob().status).toBe('failed');
    expect(getTenantDeletionInventory).not.toHaveBeenCalled();
  });

  it('stops the deletion without DB_ADMIN, where the backup would run', async () => {
    env = { ...env, DB_ADMIN: undefined } as unknown as Env;

    await processPendingTenantDeletionJobs(env, logger);

    expect(deletionJob().status).toBe('failed');
    expect(getTenantDeletionInventory).not.toHaveBeenCalled();
  });

  it('requests again in DB_ADMIN a backup that waited where it never ran', async () => {
    const backupConfig = JSON.stringify({
      policy: 'deletion_before_purge',
      consistency: 'maintenance_read_only',
      reason: 'pre-purge backup for tenant deletion job delete-1',
    });
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_by, created_at, updated_at)
         VALUES (?, 'tenant-a', 'tenant-database/export', 'pending', ?, 'delete-1', 1, 1)`
      )
      .run(backupId, backupConfig);
    core
      .prepare("UPDATE admin_jobs SET config = ? WHERE id = 'delete-1'")
      .run(JSON.stringify({ tenant_id: 'tenant-a', backup_job_id: backupId }));

    await processPendingTenantDeletionJobs(env, logger);

    expect(jobsIn(core).map((job) => job.id)).toEqual(['delete-1']);
    expect(jobsIn(admin)).toEqual([
      { id: backupId, job_type: 'tenant-database/export', status: 'pending' },
    ]);
    expect(getTenantDeletionInventory).not.toHaveBeenCalled();
  });
});

describe('the tenant jobs DB_ADMIN keeps, when the tenant is deleted', () => {
  function insertCatalog(id: string, objectKey: string, tenantId = 'tenant-a') {
    admin
      .prepare(
        `INSERT INTO object_catalog (id, public_artifact_id, tenant_id, object_class, created_at, updated_at)
         VALUES (?, ?, ?, 'admin_job_result', 1, 1)`
      )
      .run(id, `public-${id}`, tenantId);
    admin
      .prepare(
        `INSERT INTO object_catalog_objects (id, catalog_id, representation, object_kind, object_index,
           bucket_binding, object_key, created_at)
         VALUES (?, ?, 'canonical_json', 'single', 0, 'EXPORT_ARTIFACTS', ?, 1)`
      )
      .run(`object-${id}`, id, objectKey);
  }
  function insertAdminJob(
    id: string,
    jobType: string,
    objectCatalogId: string | null,
    result: string | null
  ) {
    admin
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, object_catalog_id, result, created_by,
           created_at, updated_at)
         VALUES (?, 'tenant-a', ?, 'completed', ?, ?, 'admin-1', 1, 1)`
      )
      .run(id, jobType, objectCatalogId, result);
  }
  const live = () =>
    (
      admin
        .prepare('SELECT id FROM object_catalog WHERE deleted_at IS NULL ORDER BY id')
        .all() as Array<{ id: string }>
    ).map((row) => row.id);

  it("erases their artifacts, an export's tables included, and keeps the deletion's backup", async () => {
    const backup = 'tenant-delete-backup:delete-1';
    // An earlier export whose result was large enough to be kept as an artifact (a summary inline).
    insertAdminJob('old_backup', 'tenant-database/export', 'old-result', '{"summary":{}}');
    insertCatalog(
      'old-result',
      'exports/tenant-a/admin-jobs/tenant-database-export/old_backup/result.json'
    );
    insertCatalog('old-manifest', 'exports/tenant-a/tenant-backup/old_backup/manifest.json');
    insertCatalog(
      'old-table',
      'exports/tenant-a/tenant-backup/old_backup/core/core-0/identity_accounts.jsonl'
    );
    // A key one character away (`_` is not a wildcard here), and another tenant's.
    insertCatalog('near-miss', 'exports/tenant-a/tenant-backup/oldXbackup/manifest.json');
    insertCatalog(
      'other-tenant',
      'exports/tenant-b/tenant-backup/old_backup/manifest.json',
      'tenant-b'
    );
    // A report with its result artifact.
    insertAdminJob('report-1', 'reports/generate', 'report-result', null);
    insertCatalog(
      'report-result',
      'exports/tenant-a/admin-jobs/reports-generate/report-1/result.json'
    );
    // An export whose result names a catalog of the deletion's backup: that one stays.
    insertAdminJob(
      'stray-export',
      'tenant-database/export',
      null,
      JSON.stringify({ manifest: { object_catalog_id: 'backup-table' }, table_artifacts: [] })
    );
    // The deletion's own backup, preserved with its artifacts.
    insertAdminJob(backup, 'tenant-database/export', 'backup-result', null);
    insertCatalog(
      'backup-result',
      'exports/tenant-a/admin-jobs/tenant-database-export/backup/result.json'
    );
    insertCatalog(
      'backup-table',
      `exports/tenant-a/tenant-backup/${backup}/core/core-0/identity_accounts.jsonl`
    );
    insertCatalog(
      'backup-table-safe',
      'exports/tenant-a/tenant-backup/tenant-delete-backup_delete-1/core/core-0/subjects.jsonl'
    );

    await deleteTenantAdminJobs(
      { EXPORT_ARTIFACTS: { delete: vi.fn() } } as unknown as Env,
      ensureDatabaseAdapter(d1OverSqlite(admin), 'test-admin'),
      'tenant-a',
      ['delete-1', backup]
    );

    expect(jobsIn(admin).map((job) => job.id)).toEqual([backup]);
    expect(live()).toEqual([
      'backup-result',
      'backup-table',
      'backup-table-safe',
      'near-miss',
      'other-tenant',
    ]);
  });
});

describe('Support Ops cohort snapshots', () => {
  it('leaves a job another run ended while its tenant could not be resolved', async () => {
    admin
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, progress, config, created_by,
           created_at, updated_at)
         VALUES ('snapshot-2', 'tenant-a', 'support-ops/cohort-snapshot', 'pending', '{}', '{}', 'admin-1', 1, 1)`
      )
      .run();
    mocks.beforeTenantResolve = (partition) => {
      if (partition !== 'support-ops-snapshot-tenant') return;
      // Another run completes the job, then this run cannot reach the tenant.
      admin
        .prepare(
          "UPDATE admin_jobs SET status = 'completed', updated_at = 2 WHERE id = 'snapshot-2'"
        )
        .run();
      throw new Error('tenant route unavailable');
    };

    await processPendingSupportOpsSnapshotJobs(env, logger);

    expect(jobsIn(admin)).toEqual([
      { id: 'snapshot-2', job_type: 'support-ops/cohort-snapshot', status: 'completed' },
    ]);
  });

  it('fails a waiting job whose tenant cannot be resolved', async () => {
    admin
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, progress, config, created_by,
           created_at, updated_at)
         VALUES ('snapshot-3', 'tenant-a', 'support-ops/cohort-snapshot', 'pending', '{}', '{}', 'admin-1', 1, 1)`
      )
      .run();
    mocks.beforeTenantResolve = () => {
      throw new Error('tenant route unavailable');
    };

    await processPendingSupportOpsSnapshotJobs(env, logger);

    expect(jobsIn(admin)).toEqual([
      { id: 'snapshot-3', job_type: 'support-ops/cohort-snapshot', status: 'failed' },
    ]);
  });

  it('snapshots the cohort in the tenant Core database for a job kept in DB_ADMIN', async () => {
    for (let index = 0; index < 12; index += 1) {
      const userId = `user-${String(index).padStart(2, '0')}`;
      core
        .prepare(
          `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
             metadata_json, created_at, updated_at)
           VALUES (?, 'tenant-a', 'person', 'active', ?, '{"status":"active"}', 1, 1)`
        )
        .run(`account-${userId}`, userId);
    }
    core
      .prepare(
        `INSERT INTO support_operation_cohorts (id, tenant_id, resource, intended_action, selector_json,
           selector_hash, matched_count, snapshot_status, snapshot_job_id, risk_json, created_by,
           expires_at, created_at)
         VALUES ('cohort-1', 'tenant-a', 'User', 'revoke_sessions', '{}', 'hash', 12, 'pending', 'snapshot-1',
           '{}', 'admin-1', 9999999999999, 1)`
      )
      .run();
    admin
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, progress, config, created_by,
           created_at, updated_at)
         VALUES ('snapshot-1', 'tenant-a', 'support-ops/cohort-snapshot', 'pending', '{}', ?, 'admin-1', 1, 1)`
      )
      .run(
        JSON.stringify({
          cohort_id: 'cohort-1',
          resource: 'User',
          intended_action: 'revoke_sessions',
          selector_json: '{}',
          selector_hash: 'hash',
          matched_count: 12,
          snapshot_cutoff: Date.now(),
        })
      );

    await processPendingSupportOpsSnapshotJobs(env, logger);

    expect(jobsIn(admin)).toEqual([
      { id: 'snapshot-1', job_type: 'support-ops/cohort-snapshot', status: 'completed' },
    ]);
    expect(
      core.prepare('SELECT snapshot_status, actionable_count FROM support_operation_cohorts').get()
    ).toEqual({ snapshot_status: 'completed', actionable_count: 12 });
    expect(
      (
        core.prepare('SELECT COUNT(*) AS count FROM support_operation_cohort_targets').get() as {
          count: number;
        }
      ).count
    ).toBe(12);
  });
});

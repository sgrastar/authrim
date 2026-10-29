import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import { insertTenant, openCoreDatabase } from './helpers/core-database';
import { d1OverSqlite } from './helpers/d1-over-sqlite';

/**
 * Admin jobs created through the admin API, run by the scheduled executor, and read back through
 * the API, over the real Core and Admin baselines: each table is only where the migrations put
 * it, so a job written to one database and looked for in another is never run.
 */
const mocks = vi.hoisted(() => ({
  core: null as DatabaseAdapter | null,
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    // As the resolver does: the tenant's Core database for a tenant, DB_ADMIN without one.
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: Env, partition: string, options?: { tenantId?: string }) =>
        options?.tenantId ? mocks.core : actual.ensureDatabaseAdapter(env.DB_ADMIN!, partition)
    ),
    // The tenant's metadata (accounts not routed: memberships are kept in the same database).
    resolveTenantMetadataContext: vi.fn(async (_env: Env, tenantId: string) => ({
      tenantId,
      coreDb: mocks.core,
    })),
    createAuditLogFromContext: mocks.audit,
    emitRuntimeLogRecords: vi.fn(async () => ({ tenantKey: 'tk_test', targetResults: [] })),
    // The authentication state a bulk status change moves first (a Durable Object in production).
    transitionAccountAuthenticationStateEndingSessions: vi.fn(
      async (_env: unknown, input: { lifecycle: string }) => ({
        state: { lifecycle: input.lifecycle },
        endedSessionIds: [],
      })
    ),
  };
});

import {
  adminJobGetHandler,
  adminJobResultHandler,
  adminJobsListHandler,
  adminJobsOrgBulkMembersHandler,
  adminJobsReportsGenerateHandler,
  adminJobsUsersBulkUpdateHandler,
  adminJobsUsersImportHandler,
} from '../admin-jobs';
import { processPendingGenericAdminJobs } from '../admin-job-executor';
import { buildUserImportUploadKey, processPendingUserImportJobs } from '../user-import-jobs';
import { ensureDatabaseAdapter } from '@authrim/ar-lib-core';

const REPO_ROOT = resolve(__dirname, '../../../..');
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

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

function insertAccount(db: SQLiteDatabase, userId: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO identity_accounts (
       id, tenant_id, account_type, lifecycle_state, legacy_user_id, metadata_json,
       created_at, updated_at
     ) VALUES (?, 'tenant-a', 'person', 'active', ?, '{"status":"active"}', ?, ?)`
  ).run(`account-${userId}`, userId, createdAt, createdAt);
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as any).set('adminAuth', {
      adminId: 'admin-1',
      userId: 'admin-1',
      roles: ['ar_super_admin'],
      permissions: ['*'],
    });
    await next();
  });
  app.post('/api/admin/jobs/users/import', adminJobsUsersImportHandler);
  app.post('/api/admin/jobs/users/bulk-update', adminJobsUsersBulkUpdateHandler);
  app.post('/api/admin/jobs/reports/generate', adminJobsReportsGenerateHandler);
  app.post('/api/admin/jobs/organizations/:id/bulk-members', adminJobsOrgBulkMembersHandler);
  app.get('/api/admin/jobs', adminJobsListHandler);
  app.get('/api/admin/jobs/:id/result', adminJobResultHandler);
  app.get('/api/admin/jobs/:id', adminJobGetHandler);
  return app;
}

const logger = { info: vi.fn(), error: vi.fn() };

function insertJob(
  db: SQLiteDatabase,
  input: { id: string; tenantId?: string; jobType: string; status?: string; createdAt: number }
): void {
  db.prepare(
    `INSERT INTO admin_jobs (id, tenant_id, job_type, status, result, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'admin-1', ?, ?)`
  ).run(
    input.id,
    input.tenantId ?? 'tenant-a',
    input.jobType,
    input.status ?? 'completed',
    JSON.stringify({ summary: { total: 1 } }),
    input.createdAt,
    input.createdAt
  );
}

/** A CSV upload as the upload endpoint stores it. */
function importBucket(key: string, csv: string) {
  const body = new TextEncoder().encode(csv);
  return {
    get: vi.fn(async (requested: string) =>
      requested === key
        ? {
            etag: 'etag-1',
            writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'text/csv'),
            arrayBuffer: async () => body.buffer.slice(0),
            text: async () => csv,
            body: new Blob([body]).stream(),
          }
        : null
    ),
    delete: vi.fn(async () => undefined),
  };
}

describe('admin jobs created through the admin API', () => {
  let inventory: SQLiteDatabase;
  let core: SQLiteDatabase;
  let admin: SQLiteDatabase;
  let env: Env;
  let app: ReturnType<typeof createApp>;

  const post = async (path: string, body: unknown) => {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );
    expect(res.status).toBe(202);
    return (await res.json()) as { job_id: string };
  };
  const get = async (path: string) => {
    const res = await app.request(path, {}, env);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The tenant inventory, where a scheduled run reads the tenant's lifecycle state.
    inventory = openCoreDatabase();
    insertTenant(inventory, 'tenant-a');
    inventory.prepare("UPDATE tenants SET lifecycle_state = 'active' WHERE id = 'tenant-a'").run();
    // The tenant's routed Core database (its tenants row is not the one lifecycle reads).
    core = openCoreDatabase();
    insertTenant(core, 'tenant-a');
    core.prepare("UPDATE tenants SET lifecycle_state = 'active' WHERE id = 'tenant-a'").run();
    insertAccount(core, USER_A, 1_767_300_000);
    insertAccount(core, USER_B, 1_767_400_000);
    admin = openAdminDatabase();
    mocks.core = ensureDatabaseAdapter(d1OverSqlite(core), 'test-core');
    env = { DB: d1OverSqlite(inventory), DB_ADMIN: d1OverSqlite(admin) } as unknown as Env;
    app = createApp();
  });

  it('runs a report job and serves its result', async () => {
    const { job_id } = await post('/api/admin/jobs/reports/generate', {
      type: 'user_activity',
      format: 'json',
      from_date: '2026-01-01T00:00:00.000Z',
      to_date: '2026-01-31T00:00:00.000Z',
    });

    await processPendingGenericAdminJobs(env, logger);

    const job = await get(`/api/admin/jobs/${job_id}`);
    expect(job.status).toBe(200);
    expect(job.body.status).toBe('completed');
    const result = await get(`/api/admin/jobs/${job_id}/result`);
    expect(result.status).toBe(200);
    expect(result.body.summary).toMatchObject({ total_rows: 1, report_type: 'user_activity' });
    // The two accounts in the tenant's Core database, created within the range.
    const stored = admin.prepare('SELECT result FROM admin_jobs WHERE id = ?').get(job_id) as {
      result: string;
    };
    expect(JSON.parse(stored.result).report.rows).toEqual([{ status: 'active', count: 2 }]);
  });

  it('runs a dry-run bulk update counted from the tenant accounts', async () => {
    const { job_id } = await post('/api/admin/jobs/users/bulk-update', {
      fields: ['status'],
      values: { status: 'suspended' },
      dry_run: true,
    });

    await processPendingGenericAdminJobs(env, logger);

    const job = await get(`/api/admin/jobs/${job_id}`);
    expect(job.body.status).toBe('completed');
    expect(job.body.progress).toMatchObject({ total: 2, processed: 2 });
  });

  it('suspends the accounts in the tenant Core database and keeps the job in DB_ADMIN', async () => {
    const { job_id } = await post('/api/admin/jobs/users/bulk-update', {
      fields: ['status'],
      values: { status: 'suspended' },
      result_delivery: 'inline',
    });

    await processPendingGenericAdminJobs(env, logger);
    // A run takes one batch; the next one finds no account left and completes the job.
    await processPendingGenericAdminJobs(env, logger);

    const job = await get(`/api/admin/jobs/${job_id}`);
    expect(job.body.status).toBe('completed');
    expect(job.body.progress).toMatchObject({ total: 2, processed: 2, succeeded: 2 });
    expect(
      core
        .prepare(
          "SELECT legacy_user_id, json_extract(metadata_json, '$.status') AS status FROM identity_accounts ORDER BY legacy_user_id"
        )
        .all()
    ).toEqual([
      { legacy_user_id: USER_A, status: 'suspended' },
      { legacy_user_id: USER_B, status: 'suspended' },
    ]);
  });

  it('adds organization members in the tenant Core database', async () => {
    core
      .prepare(
        `INSERT INTO organizations (id, tenant_id, name, display_name, created_at, updated_at)
         VALUES ('org-a', 'tenant-a', 'org-a', 'Org A', 1, 1)`
      )
      .run();
    // The baseline schema (before core migration 028) still has the membership's subject
    // reference users_core.
    core
      .prepare(
        `INSERT INTO users_core (id, tenant_id, created_at, updated_at)
         VALUES (?, 'tenant-a', 1, 1)`
      )
      .run(USER_A);
    const { job_id } = await post('/api/admin/jobs/organizations/org-a/bulk-members', {
      user_ids: [USER_A],
      action: 'add',
    });

    await processPendingGenericAdminJobs(env, logger);

    expect((await get(`/api/admin/jobs/${job_id}`)).body.status).toBe('completed');
    const membership = core
      .prepare('SELECT subject_id FROM subject_org_membership WHERE org_id = ?')
      .all('org-a');
    expect(membership).toEqual([{ subject_id: USER_A }]);
  });

  it('lists the job it created', async () => {
    const { job_id } = await post('/api/admin/jobs/reports/generate', {
      type: 'user_activity',
      format: 'json',
      from_date: '2026-01-01T00:00:00.000Z',
      to_date: '2026-01-31T00:00:00.000Z',
    });

    const list = await get('/api/admin/jobs');
    expect(list.status).toBe(200);
    expect(list.body.data.map((job: { job_id: string }) => job.job_id)).toEqual([job_id]);
  });
  it('keeps a user import where the import run claims it', async () => {
    const key = buildUserImportUploadKey('tenant-a', 'upload-1', 'users.csv');
    const bucket = importBucket(key, 'email\nalice@example.com\n');
    env = { ...env, IMPORT_ARTIFACTS: bucket, EXPORT_ARTIFACTS: bucket } as unknown as Env;
    const { job_id } = await post('/api/admin/jobs/users/import', {
      file_key: key,
      options: { validate_only: true },
    });

    expect(core.prepare('SELECT id FROM admin_jobs').all()).toEqual([]);
    await processPendingUserImportJobs(env, logger);

    // Claimed by the import run (whatever came of it in this test's environment).
    const row = admin
      .prepare('SELECT status, started_at FROM admin_jobs WHERE id = ?')
      .get(job_id) as { status: string; started_at: number | null };
    expect(row.status).not.toBe('pending');
    expect(row.started_at).not.toBeNull();
  });

  it('lists the jobs of both stores in one order, page by page', async () => {
    insertJob(core, { id: 'core-100', jobType: 'tenants/delete', createdAt: 100 });
    insertJob(admin, { id: 'admin-200', jobType: 'reports/generate', createdAt: 200 });
    insertJob(core, { id: 'core-300', jobType: 'support-ops/cohort-snapshot', createdAt: 300 });
    insertJob(admin, { id: 'admin-400', jobType: 'users/import', createdAt: 400 });
    insertJob(admin, {
      id: 'other-500',
      tenantId: 'tenant-b',
      jobType: 'users/import',
      createdAt: 500,
    });

    const first = await get('/api/admin/jobs?limit=3');
    expect(first.body.data.map((job: { job_id: string }) => job.job_id)).toEqual([
      'admin-400',
      'core-300',
      'admin-200',
    ]);
    expect(first.body.pagination.has_more).toBe(true);
    const second = await get(`/api/admin/jobs?limit=3&cursor=${first.body.pagination.next_cursor}`);
    expect(second.body.data.map((job: { job_id: string }) => job.job_id)).toEqual(['core-100']);
    expect(second.body.pagination.has_more).toBe(false);

    const byType = await get('/api/admin/jobs?sort=job_type');
    expect(byType.body.data.map((job: { type: string }) => job.type)).toEqual([
      'reports/generate',
      'support-ops/cohort-snapshot',
      'tenants/delete',
      'users/import',
    ]);

    // Page by page in a sort other than the default, across both stores.
    const pages: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const next = await get(
        `/api/admin/jobs?sort=-job_type&limit=1${cursor ? `&cursor=${cursor}` : ''}`
      );
      pages.push(...next.body.data.map((job: { job_id: string }) => job.job_id));
      cursor = next.body.pagination.next_cursor;
      if (!next.body.pagination.has_more) break;
    }
    expect(pages).toEqual(['admin-400', 'core-100', 'core-300', 'admin-200']);
    expect(cursor).toBeUndefined();

    // A cursor of one sort is refused for another.
    const created = await get('/api/admin/jobs?limit=1');
    const mixed = await get(
      `/api/admin/jobs?sort=job_type&cursor=${created.body.pagination.next_cursor}`
    );
    expect(mixed.status).toBe(400);
  });

  it('runs no import batch for a tenant that is no longer active', async () => {
    const key = buildUserImportUploadKey('tenant-a', 'upload-1', 'users.csv');
    const bucket = importBucket(key, 'email\nalice@example.com\n');
    env = { ...env, IMPORT_ARTIFACTS: bucket, EXPORT_ARTIFACTS: bucket } as unknown as Env;
    const { job_id } = await post('/api/admin/jobs/users/import', {
      file_key: key,
      options: { validate_only: true },
    });
    // Frozen in the inventory, as the freeze command does (the routed Core row still says active).
    inventory.prepare("UPDATE tenants SET lifecycle_state = 'frozen' WHERE id = 'tenant-a'").run();

    await processPendingUserImportJobs(env, logger);

    const row = admin
      .prepare('SELECT status, started_at, error_message FROM admin_jobs WHERE id = ?')
      .get(job_id);
    expect(row).toEqual({
      status: 'partial_failure',
      started_at: null,
      error_message: 'tenant_lifecycle_blocked:frozen',
    });
    expect(bucket.delete).toHaveBeenCalledWith(key);
  });

  it('reads a job its workflow keeps in the tenant Core database', async () => {
    insertJob(core, { id: 'core-delete', jobType: 'tenants/delete', createdAt: 100 });

    const job = await get('/api/admin/jobs/core-delete');
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({ job_id: 'core-delete', type: 'tenants/delete' });
    const result = await get('/api/admin/jobs/core-delete/result');
    expect(result.body.summary).toEqual({ total: 1 });
    expect((await get('/api/admin/jobs/missing')).status).toBe(404);
  });

  it('lists a job left in both stores by a move that stopped half way once, as DB_ADMIN has it', async () => {
    insertJob(admin, {
      id: 'moved',
      jobType: 'tenants/lifecycle-validation',
      status: 'pending',
      createdAt: 100,
    });
    insertJob(core, {
      id: 'moved',
      jobType: 'tenants/lifecycle-validation',
      status: 'failed',
      createdAt: 100,
    });
    insertJob(admin, { id: 'other', jobType: 'reports/generate', createdAt: 200 });
    insertJob(admin, { id: 'other-2', jobType: 'reports/generate', createdAt: 250 });
    core.prepare("UPDATE admin_jobs SET updated_at = 300 WHERE id = 'moved'").run();

    // Sorted by updated_at, the two copies fall on different pages (the Core copy first).
    const seen: Array<{ job_id: string; status: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const next = await get(
        `/api/admin/jobs?sort=-updated_at&limit=1${cursor ? `&cursor=${cursor}` : ''}`
      );
      seen.push(
        ...next.body.data.map(({ job_id, status }: { job_id: string; status: string }) => ({
          job_id,
          status,
        }))
      );
      cursor = next.body.pagination.next_cursor;
      if (!next.body.pagination.has_more) break;
    }
    expect(seen).toEqual([
      { job_id: 'other-2', status: 'completed' },
      { job_id: 'other', status: 'completed' },
      { job_id: 'moved', status: 'pending' },
    ]);
    expect((await get('/api/admin/jobs/moved')).body.status).toBe('pending');
  });

  it.each([
    ['with a later DB_ADMIN job', true],
    ['with no later DB_ADMIN job', false],
  ])(
    'reads the Core page on past consecutive copies left by stopped moves (%s)',
    async (_name, laterAdminJob) => {
      insertJob(admin, { id: 'a-100', jobType: 'reports/generate', createdAt: 100 });
      insertJob(admin, { id: 'm-1', jobType: 'tenants/lifecycle-validation', createdAt: 95 });
      insertJob(admin, { id: 'm-2', jobType: 'tenants/lifecycle-validation', createdAt: 85 });
      if (laterAdminJob) {
        insertJob(admin, { id: 'a-10', jobType: 'reports/generate', createdAt: 10 });
      }
      insertJob(core, { id: 'm-1', jobType: 'tenants/lifecycle-validation', createdAt: 90 });
      insertJob(core, { id: 'm-2', jobType: 'tenants/lifecycle-validation', createdAt: 80 });
      insertJob(core, { id: 'c-70', jobType: 'tenants/delete', createdAt: 70 });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const next = await get(
          `/api/admin/jobs?sort=-updated_at&limit=1${cursor ? `&cursor=${cursor}` : ''}`
        );
        seen.push(...next.body.data.map((job: { job_id: string }) => job.job_id));
        cursor = next.body.pagination.next_cursor;
        if (!next.body.pagination.has_more) break;
        expect(cursor).toBeDefined();
      }
      expect(seen).toEqual(['a-100', 'm-1', 'm-2', 'c-70', ...(laterAdminJob ? ['a-10'] : [])]);
    }
  );

  it('counts the jobs of both stores in a compliance audit report', async () => {
    const at = Math.floor(Date.parse('2026-01-10T00:00:00.000Z') / 1000);
    insertJob(core, { id: 'core-delete', jobType: 'tenants/delete', createdAt: at });
    insertJob(admin, { id: 'admin-import', jobType: 'users/import', createdAt: at });
    insertJob(admin, { id: 'admin-import-2', jobType: 'users/import', createdAt: at });
    const { job_id } = await post('/api/admin/jobs/reports/generate', {
      type: 'compliance_audit',
      from_date: '2026-01-01T00:00:00.000Z',
      to_date: '2026-01-31T00:00:00.000Z',
    });

    await processPendingGenericAdminJobs(env, logger);

    const stored = admin
      .prepare('SELECT status, result FROM admin_jobs WHERE id = ?')
      .get(job_id) as {
      status: string;
      result: string;
    };
    expect(stored.status).toBe('completed');
    expect(JSON.parse(stored.result).report.rows).toEqual([
      { job_type: 'tenants/delete', status: 'completed', count: 1 },
      { job_type: 'users/import', status: 'completed', count: 2 },
    ]);
  });
});

describe('core D1 027: jobs the admin API left in the Core database', () => {
  it('closes those still waiting, with the reason, and leaves every other job', () => {
    const core = openCoreDatabase();
    for (const [id, jobType, status] of [
      ['import-pending', 'users/import', 'pending'],
      ['bulk-processing', 'users/bulk-update', 'processing'],
      ['report-pending', 'reports/generate', 'pending'],
      ['members-pending', 'organizations/bulk-members', 'pending'],
      ['import-completed', 'users/import', 'completed'],
      ['delete-pending', 'tenants/delete', 'pending'],
      ['backup-pending', 'tenant-database/export', 'pending'],
      ['lifecycle-pending', 'tenants/lifecycle-validation', 'pending'],
      ['snapshot-pending', 'support-ops/cohort-snapshot', 'pending'],
      ['snapshot-completed', 'support-ops/cohort-snapshot', 'completed'],
    ] as const) {
      insertJob(core, { id, jobType, status, createdAt: 100 });
    }
    for (const [id, jobId, snapshotStatus] of [
      ['cohort-waiting', 'snapshot-pending', 'pending'],
      ['cohort-done', 'snapshot-completed', 'completed'],
    ]) {
      core
        .prepare(
          `INSERT INTO support_operation_cohorts (id, tenant_id, resource, intended_action,
             selector_json, selector_hash, matched_count, snapshot_status, snapshot_job_id,
             risk_json, created_by, expires_at, created_at)
           VALUES (?, 'tenant-a', 'User', 'revoke_sessions', '{}', 'h', 20, ?, ?, '{}', 'a', 1, 1)`
        )
        .run(id, snapshotStatus, jobId);
    }

    core.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/core/d1/027_admin_api_jobs_moved_to_admin_store.sql'),
        'utf8'
      ).replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1000')
    );

    expect(
      core
        .prepare('SELECT id, status, error_code, dead_lettered_at FROM admin_jobs ORDER BY id')
        .all()
    ).toEqual([
      // The backup a deletion waits for is requested again in DB_ADMIN by the deletion itself.
      { id: 'backup-pending', status: 'pending', error_code: null, dead_lettered_at: null },
      {
        id: 'bulk-processing',
        status: 'failed',
        error_code: 'admin_job_store_moved',
        dead_lettered_at: 1000,
      },
      { id: 'delete-pending', status: 'pending', error_code: null, dead_lettered_at: null },
      { id: 'import-completed', status: 'completed', error_code: null, dead_lettered_at: null },
      {
        id: 'import-pending',
        status: 'failed',
        error_code: 'admin_job_store_moved',
        dead_lettered_at: 1000,
      },
      {
        id: 'lifecycle-pending',
        status: 'failed',
        error_code: 'admin_job_store_moved',
        dead_lettered_at: 1000,
      },
      {
        id: 'members-pending',
        status: 'failed',
        error_code: 'admin_job_store_moved',
        dead_lettered_at: 1000,
      },
      {
        id: 'report-pending',
        status: 'failed',
        error_code: 'admin_job_store_moved',
        dead_lettered_at: 1000,
      },
      { id: 'snapshot-completed', status: 'completed', error_code: null, dead_lettered_at: null },
      {
        id: 'snapshot-pending',
        status: 'failed',
        error_code: 'admin_job_store_moved',
        dead_lettered_at: 1000,
      },
    ]);
    expect(
      core
        .prepare(
          'SELECT id, snapshot_status, snapshot_error FROM support_operation_cohorts ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 'cohort-done', snapshot_status: 'completed', snapshot_error: null },
      { id: 'cohort-waiting', snapshot_status: 'failed', snapshot_error: 'admin_job_store_moved' },
    ]);
  });
});

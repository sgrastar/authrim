import { readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };

// Routed account storage: the cohorts, their targets and the actions in the tenant metadata
// database, the accounts (with their subjects) each in one of the tenant's user stores.
const state = vi.hoisted(() => ({
  metadata: null as unknown as { adapter: DatabaseAdapter },
  accounts: [] as Array<{ adapter: DatabaseAdapter }>,
  admin: null as unknown as DatabaseAdapter,
  maxSnapshotCount: null as number | null,
}));
const mockTransition = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const route = { allocationScope: 'shared_pool', bindingRef: 'TENANT_METADATA' };
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: state.metadata.adapter })),
    getTenantMetadataContextFromHono: vi.fn(() => ({ tenantId: 'tenant-a', route })),
    resolveTenantMetadataContext: vi.fn(async () => ({
      tenantId: 'tenant-a',
      coreDb: state.metadata.adapter,
      route,
    })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => state.metadata.adapter),
    resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(async () =>
      state.accounts.map((account, index) => ({
        bindingRef: `USERS_${index}`,
        source: account.adapter,
      }))
    ),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getTenantSettingsDocument: vi.fn(async () => null),
    getSupportOpsResource: vi.fn((name: string) => {
      const resource = actual.getSupportOpsResource(name);
      return resource && state.maxSnapshotCount !== null
        ? { ...resource, maxSnapshotCount: state.maxSnapshotCount }
        : resource;
    }),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => state.admin),
    transitionAccountAuthenticationStateEndingSessions: mockTransition,
  };
});
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: vi.fn() }));
vi.mock('../admin-session-end', () => ({ startAdminSessionEndLogout: vi.fn() }));

import { processPendingSupportOpsSnapshotJobs, supportOpsRouter } from '../support-ops';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);

function openAdminStore(): DatabaseAdapter {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(ADMIN_MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(
      renderPortableMigrationSql(readFileSync(new URL(file, ADMIN_MIGRATIONS), 'utf8'), 'sqlite')
    );
  }
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  return {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    batch: async (statements: PreparedStatement[]) => statements.map(run),
  } as unknown as DatabaseAdapter;
}

let metadata: Store;
let first: Store;
let second: Store;

function addAccount(
  store: Store,
  userId: string,
  options: { status?: string; accountType?: string } = {}
) {
  store.db
    .prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, created_at,
         updated_at)
       VALUES (?, 'tenant-a', 'person', 'active', 1, 1)`
    )
    .run(`subject-${userId}`);
  store.db
    .prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         primary_subject_id, metadata_json, created_at, updated_at)
       VALUES (?, 'tenant-a', ?, 'active', ?, ?, ?, 1, 1)`
    )
    .run(
      `account-${userId}`,
      options.accountType ?? 'user',
      userId,
      `subject-${userId}`,
      options.status ? JSON.stringify({ status: options.status }) : null
    );
}

/**
 * 30 accounts over two user stores: 12 actionable and 5 locked in the first, 8 actionable and 5
 * suspended in the second (whose ids sort before the first's, so a job reading the second from
 * where it stopped in the first would miss them). Neither store alone has the cohort's counts, and the second alone is
 * below the minimum number of actionable accounts. Six admin accounts in each store make a group
 * that only the two together put above the minimum count.
 */
function seed() {
  for (const store of [first, second]) store.db.exec('PRAGMA foreign_keys = OFF');
  for (let index = 0; index < 12; index += 1) {
    addAccount(first, `user-p-${String(index).padStart(2, '0')}`, {
      accountType: index < 6 ? 'admin' : 'user',
    });
  }
  for (let index = 0; index < 5; index += 1) {
    addAccount(first, `user-p-blocked-${index}`, { status: 'locked' });
  }
  for (let index = 0; index < 8; index += 1) {
    addAccount(second, `user-b-${String(index).padStart(2, '0')}`, {
      accountType: index < 6 ? 'admin' : 'user',
    });
  }
  for (let index = 0; index < 5; index += 1) {
    addAccount(second, `user-b-blocked-${index}`, { status: 'suspended' });
  }
  for (const store of [first, second]) store.db.exec('PRAGMA foreign_keys = ON');
}

function app() {
  const router = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown } }>();
  router.use('/api/admin/support-ops/*', async (c, next) => {
    c.set('adminAuth', { userId: 'admin-1', permissions: ['admin:support_ops:*'] });
    await next();
  });
  router.route('/api/admin/support-ops', supportOpsRouter);
  return router;
}

async function post(path: string, body: unknown) {
  const response = await app().request(
    `/api/admin/support-ops${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    {} as Env
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function targets(cohortId: string) {
  return metadata.db
    .prepare(
      `SELECT target_id, block_reason FROM support_operation_cohort_targets
        WHERE cohort_id = ? ORDER BY target_id`
    )
    .all(cohortId) as Array<{ target_id: string; block_reason: string | null }>;
}

function expectSnapshot(cohortId: string) {
  const rows = targets(cohortId);
  expect(rows.filter((row) => row.block_reason === null).map((row) => row.target_id)).toEqual([
    ...Array.from({ length: 8 }, (_, index) => `user-b-${String(index).padStart(2, '0')}`),
    ...Array.from({ length: 12 }, (_, index) => `user-p-${String(index).padStart(2, '0')}`),
  ]);
  expect(rows.filter((row) => row.block_reason !== null).map((row) => row.target_id)).toEqual([
    ...Array.from({ length: 5 }, (_, index) => `user-b-blocked-${index}`),
    ...Array.from({ length: 5 }, (_, index) => `user-p-blocked-${index}`),
  ]);
}

function lifecycles(store: Store, table: 'identity_accounts' | 'identity_subjects') {
  return store.db
    .prepare(
      `SELECT lifecycle_state, COUNT(*) AS count FROM ${table}
        GROUP BY lifecycle_state ORDER BY lifecycle_state`
    )
    .all();
}

/** An approved suspend of the cohort, by administrators other than the executor. */
function approveSuspend(cohortId: string) {
  metadata.db
    .prepare(
      `INSERT INTO support_operation_actions (id, tenant_id, cohort_id, resource, action, status,
         reason, requested_by, approved_by, approved_at, created_at, updated_at)
       VALUES ('action-1', 'tenant-a', ?, 'User', 'suspend', 'approved', 'case', 'admin-2',
         'admin-3', 1, 1, 1)`
    )
    .run(cohortId);
}

async function readAction() {
  const response = await app().request('/api/admin/support-ops/actions/action-1', {}, {} as Env);
  return (await response.json()) as Record<string, any>;
}

function job(jobId: string) {
  return state.admin.queryOne<{ status: string; error_message: string | null; progress: string }>(
    'SELECT status, error_message, progress FROM admin_jobs WHERE id = ?',
    [jobId]
  );
}

describe('Support Ops under routed account storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metadata = openCoreStore('tenant-a');
    first = openCoreStore('tenant-a');
    second = openCoreStore('tenant-a');
    state.metadata = metadata;
    state.accounts = [{ adapter: first.adapter }, { adapter: second.adapter }];
    state.admin = openAdminStore();
    state.maxSnapshotCount = null;
    mockTransition.mockResolvedValue({ state: {}, endedSessionIds: [] });
    seed();
  });

  it('previews a cohort over every account database', async () => {
    const preview = await post('/cohorts/preview', {
      resource: 'User',
      intent: { action: 'suspend' },
    });

    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      matched_count: 30,
      actionable_count: 20,
      blocked_count: 10,
      blocked_reasons: ['not_active'],
      privacy: { min_count: 10, low_count_suppressed: false },
    });
    expect(preview.body.risk).toMatchObject({ matched_count: 30, low_count_suppressed: false });
  });

  it('suppresses a count by the combined result, not by each database', async () => {
    const admins = {
      resource: 'User',
      selector: { field: 'user_type', op: 'eq', value: 'admin' },
      intent: { action: 'suspend' },
    };
    // Six admins in each store: below the minimum in each, above it together.
    const preview = await post('/cohorts/preview', admins);
    // Two in each store: below the minimum together.
    for (const [store, prefix] of [
      [first, 'user-p'],
      [second, 'user-b'],
    ] as const) {
      store.db.exec(
        `DELETE FROM identity_accounts
          WHERE legacy_user_id IN ('${prefix}-00', '${prefix}-01', '${prefix}-02', '${prefix}-03')`
      );
    }
    const low = await post('/cohorts/preview', admins);

    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      matched_count: 12,
      actionable_count: 12,
      blocked_count: 0,
      privacy: { low_count_suppressed: false },
    });
    expect(low.status).toBe(200);
    expect(low.body).toMatchObject({
      matched_count: null,
      actionable_count: null,
      privacy: { low_count_suppressed: true },
    });
    expect(low.body.risk).toMatchObject({ matched_count: null, low_count_suppressed: true });
  });

  it('aggregates the groups of every account database before suppressing them', async () => {
    const aggregate = await post('/aggregate', { resource: 'User', group_by: ['user_type'] });

    expect(aggregate.status).toBe(200);
    // 12 admins (6 in each store: each below the minimum alone) and 18 users.
    expect(aggregate.body.groups).toEqual([
      { key: { user_type: 'user' }, count: 10 },
      { key: { user_type: 'admin' }, count: 10 },
    ]);
    expect(aggregate.body.suppressed_groups).toBe(0);
  });

  it('snapshots a cohort over every account database in the request', async () => {
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      snapshot_status: 'completed',
      matched_count: 30,
      actionable_count: 20,
      blocked_count: 10,
    });
    expectSnapshot(created.body.cohort_id);
  });

  it('snapshots a cohort over every account database in resumable job runs', async () => {
    state.maxSnapshotCount = 25;
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    expect(created.status).toBe(202);
    const jobId = created.body.snapshot_job_id as string;

    // Seven rows a run, four a page: every run stops part-way through a store or between them.
    let runs = 0;
    while ((await job(jobId))?.status !== 'completed' && runs < 20) {
      await processPendingSupportOpsSnapshotJobs({} as Env, undefined, {
        pageSize: 4,
        maxRowsPerRun: 7,
      });
      runs += 1;
      expect((await job(jobId))?.status).not.toBe('failed');
    }

    expect(runs).toBeGreaterThan(3);
    expect(await job(jobId)).toMatchObject({ status: 'completed', error_message: null });
    expect(
      metadata.db
        .prepare(
          `SELECT snapshot_status, actionable_count, blocked_count FROM support_operation_cohorts
            WHERE id = ?`
        )
        .get(created.body.cohort_id)
    ).toEqual({ snapshot_status: 'completed', actionable_count: 20, blocked_count: 10 });
    expectSnapshot(created.body.cohort_id);
  });

  it('completes a snapshot job with the count of the accounts it took', async () => {
    state.maxSnapshotCount = 25;
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    expect(created.body.matched_count).toBe(30);
    // Six actionable accounts go after the cohort was queued, before the job takes them.
    second.db.exec(
      "DELETE FROM identity_accounts WHERE legacy_user_id IN ('user-b-00', 'user-b-01', 'user-b-02', 'user-b-03', 'user-b-04', 'user-b-05')"
    );

    await processPendingSupportOpsSnapshotJobs({} as Env);
    const read = await app().request(
      `/api/admin/support-ops/cohorts/${created.body.cohort_id}`,
      {},
      {} as Env
    );
    const cohort = (await read.json()) as Record<string, any>;

    expect(cohort).toMatchObject({
      snapshot_status: 'completed',
      matched_count: 24,
      actionable_count: 14,
      blocked_count: 10,
      risk: { matched_count: 24 },
    });
    expect(JSON.parse((await job(created.body.snapshot_job_id))!.progress)).toMatchObject({
      total: 24,
      processed: 24,
    });
  });

  it('stops a snapshot job run at its statement budget and resumes it', async () => {
    // A third database, empty: each page also checks it for the page's accounts.
    state.accounts.push({ adapter: openCoreStore('tenant-a').adapter });
    state.maxSnapshotCount = 25;
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    const jobId = created.body.snapshot_job_id as string;

    // A page of ten costs five statements (a read, two checks, the batch, the progress): a run
    // of six reads two pages at most, though its rows would allow all of them.
    let runs = 0;
    while ((await job(jobId))?.status !== 'completed' && runs < 20) {
      await processPendingSupportOpsSnapshotJobs({} as Env, undefined, {
        pageSize: 10,
        maxRowsPerRun: 1000,
        maxQueriesPerRun: 6,
      });
      runs += 1;
    }

    expect(runs).toBeGreaterThanOrEqual(3);
    expect(await job(jobId)).toMatchObject({ status: 'completed', error_message: null });
    expectSnapshot(created.body.cohort_id);
  });

  it('resumes a snapshot job whose last page was taken but not recorded', async () => {
    state.maxSnapshotCount = 25;
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    const jobId = created.body.snapshot_job_id as string;
    await processPendingSupportOpsSnapshotJobs({} as Env, undefined, {
      pageSize: 4,
      maxRowsPerRun: 20,
    });
    // As if the run ended before its progress was written: the job is taken up from the start.
    await state.admin.execute(
      `UPDATE admin_jobs SET status = 'pending', progress = NULL WHERE id = ?`,
      [jobId]
    );

    for (let runs = 0; runs < 10 && (await job(jobId))?.status !== 'completed'; runs += 1) {
      await processPendingSupportOpsSnapshotJobs({} as Env, undefined, {
        pageSize: 4,
        maxRowsPerRun: 20,
      });
    }

    const completed = await job(jobId);
    expect(completed).toMatchObject({ status: 'completed', error_message: null });
    // Its progress counts the cohort's targets, also those taken before the progress was lost.
    expect(JSON.parse(completed!.progress)).toMatchObject({
      total: 30,
      processed: 30,
      succeeded: 30,
      actionable: 20,
      blocked: 10,
      stage: 'completed',
    });
    expectSnapshot(created.body.cohort_id);
  });

  it('suspends each account of the cohort in its own account database', async () => {
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    expect(created.status).toBe(201);
    approveSuspend(created.body.cohort_id);

    const executed = await post('/actions/action-1/execute', {});

    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({
      status: 'completed',
      succeeded_count: 20,
      failed_count: 0,
    });
    for (const [store, actionable] of [
      [first, 12],
      [second, 8],
    ] as const) {
      const expected = [
        { lifecycle_state: 'active', count: 5 },
        { lifecycle_state: 'suspended', count: actionable },
      ];
      expect(lifecycles(store, 'identity_accounts')).toEqual(expected);
      expect(lifecycles(store, 'identity_subjects')).toEqual([
        { lifecycle_state: 'active', count: 5 },
        { lifecycle_state: 'suspended', count: actionable },
      ]);
    }
    expect(mockTransition).toHaveBeenCalledTimes(20);
  });

  it('reports the accounts suspended in the other databases when one fails', async () => {
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    approveSuspend(created.body.cohort_id);
    state.accounts[1] = {
      adapter: {
        ...second.adapter,
        batch: async () => {
          throw new Error('database unavailable');
        },
      } as DatabaseAdapter,
    };

    const executed = await post('/actions/action-1/execute', {});

    expect(executed.status).toBe(409);
    expect(
      JSON.parse(
        (
          metadata.db
            .prepare(`SELECT status, result_summary_json FROM support_operation_actions`)
            .get() as { result_summary_json: string }
        ).result_summary_json
      )
    ).toMatchObject({ succeeded_count: 12, failed_count: 8, error: 'execution_failed' });
    expect(lifecycles(first, 'identity_accounts')).toEqual([
      { lifecycle_state: 'active', count: 5 },
      { lifecycle_state: 'suspended', count: 12 },
    ]);
    expect(lifecycles(second, 'identity_accounts')).toEqual([
      { lifecycle_state: 'active', count: 13 },
    ]);
    // The eight that failed are below the minimum: neither count is shown (one is the other
    // subtracted from the attempted count).
    expect(await readAction()).toMatchObject({
      status: 'failed',
      result_summary: {
        attempted_count: 20,
        succeeded_count: null,
        failed_count: null,
        privacy: { low_count_suppressed: true },
      },
    });
  });

  describe('a cohort of more accounts in one database than one statement names', () => {
    beforeEach(() => {
      // 1,010 more actionable accounts (with their subjects) in the first database.
      first.db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1009)
        INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, created_at,
          updated_at)
        SELECT 'subject-user-q-' || i, 'tenant-a', 'person', 'active', 1, 1 FROM n`);
      first.db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1009)
        INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
          legacy_user_id, primary_subject_id, created_at, updated_at)
        SELECT 'account-user-q-' || i, 'tenant-a', 'user', 'active', 'user-q-' || i,
          'subject-user-q-' || i, 1, 1 FROM n`);
    });

    it('suspends all of them, with their subjects', async () => {
      const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
      expect(created.status).toBe(201);
      approveSuspend(created.body.cohort_id);

      const executed = await post('/actions/action-1/execute', {});

      expect(executed.status).toBe(200);
      expect(executed.body).toMatchObject({ succeeded_count: 1030, failed_count: 0 });
      expect(lifecycles(first, 'identity_subjects')).toEqual([
        { lifecycle_state: 'active', count: 5 },
        { lifecycle_state: 'suspended', count: 1022 },
      ]);
    });

    it('suspends none of a database whose later statement fails', async () => {
      const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
      approveSuspend(created.body.cohort_id);
      // The first database's second chunk of accounts fails.
      state.accounts[0] = {
        adapter: {
          ...first.adapter,
          batch: (statements: PreparedStatement[]) =>
            first.adapter.batch(
              statements.map((statement, index) =>
                index === 2
                  ? { ...statement, sql: `${statement.sql} AND no_such_column = 1` }
                  : statement
              )
            ),
        } as DatabaseAdapter,
      };

      const executed = await post('/actions/action-1/execute', {});

      expect(executed.status).toBe(409);
      expect(lifecycles(first, 'identity_accounts')).toEqual([
        { lifecycle_state: 'active', count: 1027 },
      ]);
      expect(lifecycles(second, 'identity_accounts')).toEqual([
        { lifecycle_state: 'active', count: 5 },
        { lifecycle_state: 'suspended', count: 8 },
      ]);
    });
  });

  describe('an account in two account databases', () => {
    beforeEach(() => {
      second.db.exec('PRAGMA foreign_keys = OFF');
      addAccount(second, 'user-p-00');
    });

    it('is not counted twice to reach the minimum by a preview or an aggregate', async () => {
      // 13 admins as counted (12 accounts): a count the copy could have lifted to the minimum.
      const admins = await post('/cohorts/preview', {
        resource: 'User',
        selector: { field: 'user_type', op: 'eq', value: 'admin' },
        intent: { action: 'suspend' },
      });
      const aggregate = await post('/aggregate', { resource: 'User', group_by: ['user_type'] });
      // 31 as counted (30 accounts): above the minimum even if every account were counted twice.
      const all = await post('/cohorts/preview', {
        resource: 'User',
        intent: { action: 'suspend' },
      });

      expect([admins.status, admins.body.error]).toEqual([409, 'account_store_ambiguous']);
      expect(admins.body.matched_count).toBeUndefined();
      expect([aggregate.status, aggregate.body.error]).toEqual([409, 'account_store_ambiguous']);
      expect(all.status).toBe(200);
    });

    it('is not counted twice to reach the minimum within a large selection', async () => {
      first.db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
        INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
          legacy_user_id, created_at, updated_at)
        SELECT 'account-bulk-' || i, 'tenant-a', 'user', 'active', 'user-bulk-' || i, 1, 1 FROM n`);
      // Six locked service accounts, each in both databases; no other account is blocked.
      for (const store of [first, second]) {
        store.db.exec("DELETE FROM identity_accounts WHERE legacy_user_id LIKE '%-blocked-%'");
        for (let index = 0; index < 6; index += 1) {
          addAccount(store, `user-copy-${index}`, {
            accountType: 'service_account',
            status: 'locked',
          });
        }
      }

      const preview = await post('/cohorts/preview', {
        resource: 'User',
        intent: { action: 'suspend' },
      });
      const aggregate = await post('/aggregate', { resource: 'User', group_by: ['user_type'] });

      expect([preview.status, preview.body.error]).toEqual([409, 'account_store_ambiguous']);
      expect(preview.body.blocked_count).toBeUndefined();
      expect([aggregate.status, aggregate.body.error]).toEqual([409, 'account_store_ambiguous']);
    });

    it('is not counted twice to escape complementary suppression', async () => {
      // Ten admins, each in both databases (20 as counted), and one service account: the admins
      // are fewer than twice the minimum, so a suppressed group beside them hides them too.
      for (const store of [first, second]) store.db.exec('DELETE FROM identity_accounts');
      for (let index = 0; index < 10; index += 1) {
        for (const store of [first, second]) {
          addAccount(store, `user-admin-${index}`, { accountType: 'admin' });
        }
      }
      addAccount(first, 'user-service', { accountType: 'service_account' });

      const aggregate = await post('/aggregate', { resource: 'User', group_by: ['user_type'] });

      expect([aggregate.status, aggregate.body.error]).toEqual([409, 'account_store_ambiguous']);
    });

    it('is not missed by a preview when its copy goes before it is checked', async () => {
      second.db.exec("DELETE FROM identity_accounts WHERE id = 'account-user-p-00'");
      const admins = {
        resource: 'User',
        selector: { field: 'user_type', op: 'eq', value: 'admin' },
        intent: { action: 'suspend' },
      };
      // The second database counts an admin it then does not read (as if its copy were removed
      // in between): what was counted is not known.
      state.accounts[1] = {
        adapter: {
          ...second.adapter,
          query: async (sql: string, params?: unknown[]) => {
            const rows = await second.adapter.query(sql, params);
            return sql.includes('AS in_0') ? rows.slice(1) : rows;
          },
        } as DatabaseAdapter,
      };

      const preview = await post('/cohorts/preview', admins);

      expect([preview.status, preview.body.error]).toEqual([409, 'count_unverified']);
      expect(preview.body.matched_count).toBeUndefined();
    });

    it('is refused by cohort creation, in the request and in the snapshot job', async () => {
      const inRequest = await post('/cohorts', {
        resource: 'User',
        intent: { action: 'suspend' },
      });
      state.maxSnapshotCount = 25;
      const queued = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
      await processPendingSupportOpsSnapshotJobs({} as Env);

      expect([inRequest.status, inRequest.body.error]).toEqual([409, 'account_store_ambiguous']);
      expect(queued.status).toBe(202);
      expect(await job(queued.body.snapshot_job_id)).toMatchObject({
        status: 'failed',
        error_message: 'account_store_ambiguous',
      });
      expect(targets(queued.body.cohort_id)).toEqual([]);
    });

    it('is refused by execute before any account is suspended', async () => {
      second.db.exec("DELETE FROM identity_accounts WHERE id = 'account-user-p-00'");
      const created = await post('/cohorts', {
        resource: 'User',
        intent: { action: 'suspend' },
      });
      expect(created.status).toBe(201);
      approveSuspend(created.body.cohort_id);
      // A copy that is not active is a copy all the same.
      addAccount(second, 'user-p-01', { status: 'locked' });

      const executed = await post('/actions/action-1/execute', {});

      expect([executed.status, executed.body.error]).toEqual([409, 'account_store_ambiguous']);
      expect(mockTransition).not.toHaveBeenCalled();
      expect(lifecycles(first, 'identity_accounts')).toEqual([
        { lifecycle_state: 'active', count: 17 },
      ]);
      expect((await readAction()).status).toBe('approved');
    });
  });

  it('refuses an aggregate whose accounts a database does not read back as it counted', async () => {
    // The second database reads one admin fewer than it counted (as if one left in between).
    state.accounts[1] = {
      adapter: {
        ...second.adapter,
        query: async (sql: string, params?: unknown[]) => {
          const rows = await second.adapter.query(sql, params);
          return sql.includes('AS group_key') ? rows.slice(1) : rows;
        },
      } as DatabaseAdapter,
    };

    const aggregate = await post('/aggregate', { resource: 'User', group_by: ['user_type'] });

    expect([aggregate.status, aggregate.body.error]).toEqual([409, 'count_unverified']);
    expect(aggregate.body.groups).toBeUndefined();
  });

  it('refuses an aggregate when an account database has more groups than it reads', async () => {
    for (let index = 0; index < 1001; index += 1) {
      first.db
        .prepare(
          `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
             legacy_user_id, created_at, updated_at)
           VALUES (?, 'tenant-a', ?, 'active', ?, 1, 1)`
        )
        .run(`account-many-${index}`, `type-${index}`, `user-many-${index}`);
    }

    const aggregate = await post('/aggregate', { resource: 'User', group_by: ['user_type'] });

    expect(aggregate.status).toBe(400);
  });
});

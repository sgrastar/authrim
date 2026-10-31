import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

// Support Ops against the real schemas: the tenant's Core store (every core migration) and the
// Admin store holding the snapshot jobs, with the User resource as ar-lib-core describes it.
const stores = vi.hoisted(() => ({
  core: null as unknown as DatabaseAdapter,
  admin: null as unknown as DatabaseAdapter,
  maxSnapshotCount: null as number | null,
}));
const mockTransition = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const route = {
    registryRow: { database_id: 'core-db' },
    bindingRouteGeneration: 1,
    assignmentGeneration: 1,
    shardId: 'core-shard',
  };
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: stores.core })),
    getTenantMetadataContextFromHono: vi.fn(() => ({
      tenantId: 'tenant-a',
      coreDb: stores.core,
      route,
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getTenantSettingsDocument: vi.fn(async () => null),
    // A lower snapshot limit sends a cohort of this size through the snapshot job.
    getSupportOpsResource: vi.fn((name: string) => {
      const resource = actual.getSupportOpsResource(name);
      return resource && stores.maxSnapshotCount !== null
        ? { ...resource, maxSnapshotCount: stores.maxSnapshotCount }
        : resource;
    }),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => stores.admin),
    resolveTenantMetadataContext: vi.fn(async () => ({
      tenantId: 'tenant-a',
      coreDb: stores.core,
      route,
    })),
    // The SQL/topology tests have no sessions. Actual receipt/lease behavior is covered by
    // support-ops-execute-job.test.ts and Core's actual-DO SQLite regression suite.
    getSessionRevocationStore: vi.fn((_env: Env, _tenant: string, userId: string) => ({
      beginSupportOpsSuspensionRpc: async (
        _t: string,
        _u: string,
        _a: string,
        version: number,
        operation: string
      ) => {
        await mockTransition({}, { userId });
        return {
          fence: 1,
          currentState: {
            lifecycle: 'suspended',
            lifecycleVersionMs: version,
            lifecycleOperationId: operation,
          },
        };
      },
      readSupportOpsSuspensionReceiptRpc: async () => ({
        stage: 'drained',
        sequence: 0,
        sessionIds: [],
      }),
      completeSupportOpsSuspensionReceiptRpc: async () => undefined,
    })),
    transitionAccountAuthenticationStateEndingSessions: mockTransition,
  };
});
vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditLog: vi.fn(),
}));
vi.mock('../admin-session-end', () => ({ startAdminSessionEndLogout: vi.fn() }));

import { processPendingSupportOpsSnapshotJobs, supportOpsRouter } from '../support-ops';
import { processSupportOpsExecuteJobInline } from '../support-ops-execute-job';

const ADMIN_MIGRATIONS = new URL('../../../../migrations/admin/d1/', import.meta.url);

function openAdminStore(): { db: SQLiteDatabase; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of [`001_0_5_0_admin_baseline.sql`]) {
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
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    batch: async (statements: PreparedStatement[]) => statements.map(run),
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

let core: SQLiteDatabase;
let admin: SQLiteDatabase;

function addAccount(
  userId: string,
  options: {
    lifecycle?: string;
    metadata?: Record<string, unknown> | string | null;
    tenantId?: string;
  } = {}
) {
  const tenantId = options.tenantId ?? 'tenant-a';
  const lifecycle = options.lifecycle ?? 'active';
  core
    .prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, created_at,
         updated_at)
       VALUES (?, ?, 'person', ?, 1, 1)`
    )
    .run(`subject-${userId}`, tenantId, lifecycle);
  core
    .prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         primary_subject_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?, 1, 1)`
    )
    .run(
      `account-${userId}`,
      tenantId,
      lifecycle,
      userId,
      `subject-${userId}`,
      options.metadata === undefined || options.metadata === null
        ? null
        : typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata)
    );
}

/**
 * 20 accounts suspend can act on (half with no status recorded in their metadata, as accounts
 * created since the canonical cutover have), 10 whose recorded status is not active (as a status
 * carried over from before the cutover can be), and accounts the cohort never takes: one not
 * active and one of another tenant.
 */
function seedAccounts() {
  for (let index = 0; index < 20; index += 1) {
    const id = `user-${String(index).padStart(2, '0')}`;
    addAccount(id, { metadata: index % 2 === 0 ? null : { status: 'active' } });
  }
  for (let index = 0; index < 10; index += 1) {
    addAccount(`user-blocked-${index}`, {
      metadata: { status: index % 2 === 0 ? 'locked' : 'suspended' },
    });
  }
  addAccount('user-suspended', { lifecycle: 'suspended', metadata: { status: 'suspended' } });
  addAccount('user-other-tenant', { tenantId: 'tenant-b' });
}

function app() {
  const router = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown } }>();
  router.use('/api/admin/support-ops/*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'machine_access_token',
      permissions: ['admin:support_ops:*'],
    });
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

function targets(cohortId: string): Array<{ target_id: string; block_reason: string | null }> {
  return core
    .prepare(
      `SELECT target_id, block_reason FROM support_operation_cohort_targets
        WHERE cohort_id = ? ORDER BY target_id`
    )
    .all(cohortId) as Array<{ target_id: string; block_reason: string | null }>;
}

/** Executes the cohort's suspend as an action already approved by other administrators. */
async function executeSuspend(cohortId: string) {
  core
    .prepare(
      `INSERT INTO support_operation_actions (id, tenant_id, cohort_id, resource, action, status,
         reason, requested_by, approved_by, approved_at, created_at, updated_at)
       VALUES ('action-1', 'tenant-a', ?, 'User', 'suspend', 'approved', 'case', 'admin-2',
         'admin-3', 1, 1, 1)`
    )
    .run(cohortId);
  const response = await post('/actions/action-1/execute', {});
  if (response.status !== 202) return response;
  for (let run = 0; run < 100; run++) {
    await processSupportOpsExecuteJobInline({} as Env, 'tenant-a', response.body.job_id as string, {
      maxCallsPerRun: 600,
    });
    const action = core
      .prepare(
        "SELECT status,result_summary_json FROM support_operation_actions WHERE id='action-1'"
      )
      .get() as { status: string; result_summary_json: string };
    if (action.status === 'completed' || action.status === 'failed')
      return {
        status: action.status === 'completed' ? 200 : 409,
        body: {
          status: action.status,
          ...(JSON.parse(action.result_summary_json) as Record<string, unknown>),
        },
      };
  }
  throw new Error('execution_did_not_finish');
}

function lifecycles(table: 'identity_accounts' | 'identity_subjects') {
  return core
    .prepare(
      `SELECT lifecycle_state, COUNT(*) AS count FROM ${table}
        WHERE tenant_id = 'tenant-a' GROUP BY lifecycle_state ORDER BY lifecycle_state`
    )
    .all();
}

function expectSnapshot(cohortId: string) {
  const rows = targets(cohortId);
  expect(rows.filter((row) => row.block_reason === null)).toHaveLength(20);
  expect(
    rows.filter((row) => row.block_reason !== null).map((row) => [row.target_id, row.block_reason])
  ).toEqual(
    Array.from({ length: 10 }, (_, index) => [`user-blocked-${index}`, 'not_active'] as const)
  );
  expect(rows.map((row) => row.target_id)).not.toContain('user-suspended');
  expect(rows.map((row) => row.target_id)).not.toContain('user-other-tenant');
}

describe('Support Ops on the Core schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const coreStore = openCoreStore('tenant-a');
    core = coreStore.db;
    stores.core = coreStore.adapter;
    const adminStore = openAdminStore();
    admin = adminStore.db;
    stores.admin = adminStore.adapter;
    stores.maxSnapshotCount = null;
    mockTransition.mockResolvedValue({ state: {}, endedSessionIds: [] });
    core.exec('PRAGMA foreign_keys = OFF');
    seedAccounts();
    core.exec('PRAGMA foreign_keys = ON');
  });

  it('previews a suspend cohort, blocking accounts whose status is not active', async () => {
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
    });
  });

  it('reads and suspends accounts whose metadata is not a JSON object by their lifecycle state', async () => {
    const odd = {
      'user-malformed': '{not json',
      'user-array': '[]',
      'user-null': 'null',
      'user-text': '"active"',
    };
    for (const [userId, metadata] of Object.entries(odd)) addAccount(userId, { metadata });

    const preview = await post('/cohorts/preview', {
      resource: 'User',
      selector: { field: 'status', op: 'eq', value: 'active' },
      intent: { action: 'suspend' },
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      matched_count: 20,
      actionable_count: 20,
      privacy: { count_exact: false, count_precision: 10 },
      risk: { matched_count: 20 },
    });

    const created = await post('/cohorts', {
      resource: 'User',
      selector: { field: 'status', op: 'eq', value: 'active' },
      intent: { action: 'suspend' },
    });
    expect(created.status).toBe(201);
    const executed = await executeSuspend(created.body.cohort_id);

    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ status: 'completed', succeeded_count: 24 });
    for (const userId of Object.keys(odd)) {
      const account = core
        .prepare(
          `SELECT a.lifecycle_state, json_extract(a.metadata_json, '$.status') AS status,
                  s.lifecycle_state AS subject_lifecycle_state
             FROM identity_accounts a JOIN identity_subjects s ON s.id = a.primary_subject_id
            WHERE a.legacy_user_id = ?`
        )
        .get(userId);
      expect([userId, account]).toEqual([
        userId,
        { lifecycle_state: 'suspended', status: 'suspended', subject_lifecycle_state: 'suspended' },
      ]);
    }
  });

  it('snapshots a suspend cohort in the request', async () => {
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

  it('snapshots a suspend cohort in the snapshot job', async () => {
    stores.maxSnapshotCount = 25;
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    expect(created.status).toBe(202);

    await processPendingSupportOpsSnapshotJobs({} as Env);

    expect(
      admin
        .prepare('SELECT status, error_message FROM admin_jobs WHERE id = ?')
        .get(created.body.snapshot_job_id)
    ).toEqual({ status: 'completed', error_message: null });
    expect(
      core
        .prepare(
          `SELECT snapshot_status, actionable_count, blocked_count, snapshot_error
             FROM support_operation_cohorts WHERE id = ?`
        )
        .get(created.body.cohort_id)
    ).toEqual({
      snapshot_status: 'completed',
      actionable_count: 20,
      blocked_count: 10,
      snapshot_error: null,
    });
    expectSnapshot(created.body.cohort_id);
  });

  it('suspends only the actionable accounts of the cohort, with their subjects', async () => {
    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    expect(created.status).toBe(201);

    const executed = await executeSuspend(created.body.cohort_id);

    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ status: 'completed', succeeded_count: 20 });
    const expected = [
      { lifecycle_state: 'active', count: 10 },
      { lifecycle_state: 'suspended', count: 21 },
    ];
    expect(lifecycles('identity_accounts')).toEqual(expected);
    expect(lifecycles('identity_subjects')).toEqual(expected);
    expect(
      new Set(mockTransition.mock.calls.map(([, input]) => (input as { userId: string }).userId))
        .size
    ).toBe(20);
    expect(
      mockTransition.mock.calls.map(([, input]) => (input as { userId: string }).userId)
    ).not.toContain('user-blocked-0');
  });

  it('does not reveal a suppressed count through the risk summary', async () => {
    core.exec(
      "DELETE FROM identity_accounts WHERE legacy_user_id LIKE 'user-blocked-%' AND legacy_user_id != 'user-blocked-0'"
    );

    const created = await post('/cohorts', { resource: 'User', intent: { action: 'suspend' } });
    const read = await app().request(
      `/api/admin/support-ops/cohorts/${created.body.cohort_id}`,
      {},
      {} as Env
    );
    const cohort = (await read.json()) as Record<string, any>;

    expect(created.status).toBe(201);
    expect(read.status).toBe(200);
    for (const body of [created.body, cohort]) {
      expect(body).toMatchObject({
        matched_count: null,
        actionable_count: 20,
        blocked_count: null,
      });
      expect(body.risk).toEqual({
        min_count: 10,
        matched_count: null,
        low_count_suppressed: true,
        uses_sensitive_field: false,
        risk_level: 'low',
        approval_required: true,
      });
    }
  });

  it('rejects PII selectors without exposing their value or a count', async () => {
    const preview = await post('/cohorts/preview', {
      resource: 'User',
      selector: { field: 'email', op: 'eq', value: 'private-selector-marker' },
      intent: { action: 'suspend' },
    });

    expect(preview.status).toBe(400);
    expect(preview.body.error).toBe('invalid_selector');
    expect(preview.body).not.toHaveProperty('matched_count');
    expect(JSON.stringify(preview.body)).not.toContain('private-selector-marker');
  });

  it('selects by status as the account reports it', async () => {
    const active = await post('/cohorts/preview', {
      resource: 'User',
      selector: { field: 'status', op: 'eq', value: 'active' },
      intent: { action: 'suspend' },
    });
    const locked = await post('/cohorts/preview', {
      resource: 'User',
      selector: { field: 'status', op: 'in', value: ['locked', 'suspended'] },
    });

    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({
      matched_count: 20,
      actionable_count: 20,
      blocked_count: 0,
    });
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ matched_count: 10 });
  });

  it('answers every field the registry offers from the Core schema', async () => {
    const registry = await app().request('/api/admin/support-ops/registry', {}, {} as Env);
    const [user] = ((await registry.json()) as { resources: Array<Record<string, any>> }).resources;
    const fields = Object.entries(user.fields as Record<string, Record<string, any>>);

    for (const [field, descriptor] of fields.filter(([, d]) => d.filterable)) {
      for (const op of descriptor.operators as string[]) {
        const value =
          op === 'exists' || op === 'not_exists'
            ? undefined
            : descriptor.type === 'datetime'
              ? 1
              : descriptor.type === 'boolean'
                ? true
                : op === 'in'
                  ? [descriptor.values?.[0] ?? 'x']
                  : (descriptor.values?.[0] ?? 'x');
        const preview = await post('/cohorts/preview', {
          resource: 'User',
          selector: { field, op, value },
          intent: { action: 'suspend' },
        });
        expect([field, op, preview.status]).toEqual([field, op, 200]);
      }
    }
    for (const [field] of fields.filter(([, d]) => d.aggregatable)) {
      const aggregate = await post('/aggregate', { resource: 'User', group_by: [field] });
      expect([field, aggregate.status]).toEqual([field, 200]);
    }
    // PII is held by the PII store and the last sign-in by each account's session state.
    expect(user.fields.pii_status).toBeUndefined();
    expect(user.fields.last_login_at).toBeUndefined();
  });
});

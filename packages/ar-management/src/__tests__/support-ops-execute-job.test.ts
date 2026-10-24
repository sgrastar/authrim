import { Hono, type Context } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  createExecuteFixture,
  TENANT,
  type ExecuteFixture,
} from './helpers/support-ops-execute-sqlite';
import { openCoreStore } from './helpers/core-schema-sqlite';

const runtime = vi.hoisted(() => ({ current: undefined as ExecuteFixture | undefined }));
function current(): ExecuteFixture {
  if (!runtime.current) throw new Error('fixture_missing');
  return runtime.current;
}
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const context = () => ({
    tenantId: TENANT,
    coreDb: current().core.adapter,
    route: {
      allocationScope: 'shared_pool',
      bindingRef: 'METADATA',
      registryRow: { database_id: current().stores.metadataIdentity?.databaseId },
      ...current().stores.metadataIdentity,
    },
  });
  return {
    ...actual,
    createAuthContextFromHono: () => ({ coreAdapter: current().core.adapter }),
    getTenantIdFromContext: (c: Context) => c.req.header('X-Tenant-Id') ?? TENANT,
    getTenantMetadataContextFromHono: context,
    resolveTenantMetadataContext: async () => context(),
    resolveTenantAssignedDatabaseSourcesFromRegistry: async () =>
      current().stores.accounts.map((store) => ({
        bindingRef: store.key,
        source: store.adapter,
        registryRow: { database_id: store.identity?.databaseId },
        ...store.identity,
      })),
    requireDedicatedAdminDatabaseAdapter: () => current().admin.adapter,
    getTenantSettingsDocument: async () => null,
    getSessionRevocationStore: (_env: Env, tenant: string, user: string) => {
      const receipt = current().receipts.get(user);
      if (tenant !== TENANT || !receipt) throw new Error('cross_tenant_rpc');
      return receipt.rpc;
    },
  };
});
vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditLog: vi.fn(),
}));
const archive = vi.hoisted(() =>
  vi.fn(async (_input: { records: Array<{ id: string }> }) => ({
    targetResults: [] as Array<{ error?: string }>,
  }))
);
vi.mock('@authrim/ar-lib-core/services/logging-runtime-emitter', () => ({
  emitRuntimeLogRecords: archive,
}));
import { supportOpsRouter } from '../support-ops';
import { keepSupportOpsLogoutPage } from '../support-ops-job-evidence';
import {
  adminJobsListHandler,
  adminJobGetHandler,
  adminJobResultHandler,
  adminJobResultDownloadHandler,
  adminJobTypesHandler,
} from '../admin-jobs';

const opened: ExecuteFixture[] = [];
async function fixture(sessions = 1, targets = 1) {
  const value = await createExecuteFixture(sessions, targets);
  runtime.current = value;
  opened.push(value);
  return value;
}
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  runtime.current = undefined;
  vi.restoreAllMocks();
  archive.mockReset();
  archive.mockResolvedValue({ targetResults: [] });
});
function receipt(f: ExecuteFixture) {
  const value = f.receipts.get('user-1');
  if (!value) throw new Error('receipt_missing');
  return value;
}
function account(f: ExecuteFixture) {
  return f.core.db
    .prepare(
      "SELECT lifecycle_state,metadata_json FROM identity_accounts WHERE id='account-user-1'"
    )
    .get() as { lifecycle_state: string; metadata_json: string | null };
}
async function reactivate(f: ExecuteFixture) {
  const version = f.sourceVersionMs + 1000;
  await receipt(f).rpc.setAccountLifecycleRpc(
    TENANT,
    'user-1',
    'account:user-1',
    'active',
    version,
    'normal-reactivate',
    false
  );
  f.core.db
    .prepare(
      "UPDATE identity_accounts SET lifecycle_state='active',metadata_json=?,updated_at=? WHERE id='account-user-1'"
    )
    .run(
      JSON.stringify({
        lifecycle_version_ms: version,
        lifecycle_operation_id: 'normal-reactivate',
      }),
      version
    );
}
async function request(
  f: ExecuteFixture,
  options: { tenant?: string; permissions?: string[] } = {}
) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth: unknown } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'machine-1',
      authMethod: 'machine_access_token',
      permissions: options.permissions ?? ['admin:support_ops:*'],
    });
    await next();
  });
  app.route('/api/admin/support-ops', supportOpsRouter);
  return app.request(
    '/api/admin/support-ops/actions/action-1/execute',
    { method: 'POST', headers: { 'X-Tenant-Id': options.tenant ?? TENANT } },
    f.env
  );
}
function approved(f: ExecuteFixture) {
  f.admin.db.exec('DELETE FROM admin_jobs');
  f.core.db.exec("UPDATE support_operation_actions SET status='approved',result_summary_json=NULL");
}
async function readJob(f: ExecuteFixture, path: string, tenant = TENANT) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth: unknown } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'machine-1',
      authMethod: 'machine_access_token',
      permissions: ['*'],
    });
    await next();
  });
  app.get('/jobs', adminJobsListHandler);
  app.get('/jobs/types', adminJobTypesHandler);
  app.get('/jobs/:id/result', adminJobResultHandler);
  app.get('/jobs/:id/result/download', adminJobResultDownloadHandler);
  app.get('/jobs/:id', adminJobGetHandler);
  return app.request(path, { headers: { 'X-Tenant-Id': tenant } }, f.env);
}

describe('resumable Support Ops coordinator on real Core/Admin SQLite and actual DO RPCs', () => {
  it('stops before remote effects when the Admin run owner changes before its heartbeat', async () => {
    const f = await fixture(2),
      execute = f.admin.adapter.execute.bind(f.admin.adapter);
    let stolen = false;
    vi.spyOn(f.admin.adapter, 'execute').mockImplementation(async (sql, params) => {
      if (!stolen && sql.includes('UPDATE admin_jobs SET updated_at=CASE')) {
        stolen = true;
        f.admin.db.exec(
          "UPDATE admin_jobs SET progress=json_set(progress,'$.run_id','new-owner') WHERE id='job-1'"
        );
      }
      return execute(sql, params);
    });
    const batch = vi.spyOn(f.core.adapter, 'batch');
    await f.step();
    expect(stolen).toBe(true);
    expect(batch).not.toHaveBeenCalled();
    expect(account(f).lifecycle_state).toBe('active');
    expect(await receipt(f).storage.get('support-ops-session-receipt')).toBeUndefined();
    expect(f.row().status).toBe('processing');
  });
  it('retries a Core batch that never committed after draining, without inventing a skip result', async () => {
    const f = await fixture(12);
    vi.spyOn(f.core.adapter, 'batch').mockRejectedValueOnce(new Error('core_before_commit'));
    await f.step();
    expect(f.row().status).toBe('pending');
    expect(f.progress().active).toMatchObject({ transferred: { sequence: 2 } });
    expect(f.progress().active?.account_result).toBeUndefined();
    expect(await receipt(f).storage.get('support-ops-session-receipt')).toMatchObject({
      complete: false,
    });
    expect(account(f).lifecycle_state).toBe('active');
    expect(f.core.db.prepare('SELECT * FROM support_ops_account_result_receipts').all()).toEqual(
      []
    );
    await f.finish();
    expect(f.progress().succeeded).toBe(1);
    expect(account(f).lifecycle_state).toBe('suspended');
    expect(await receipt(f).storage.get('support-ops-session-receipt')).toMatchObject({
      complete: true,
    });
  });
  it('never reapplies the old suspension when a normal lifecycle supersedes an uncommitted result', async () => {
    const f = await fixture(2);
    vi.spyOn(f.core.adapter, 'batch').mockRejectedValueOnce(new Error('core_before_commit'));
    await f.step();
    await reactivate(f);
    await f.finish();
    expect(f.progress().succeeded).toBe(0);
    expect(account(f).lifecycle_state).toBe('active');
    expect(
      f.core.db.prepare('SELECT succeeded,applied FROM support_ops_account_result_receipts').get()
    ).toMatchObject({ succeeded: 0, applied: 1 });
  });
  it('recovers a committed Core result after response loss and newer normal lifecycle', async () => {
    const f = await fixture(2),
      batch = f.core.adapter.batch.bind(f.core.adapter);
    vi.spyOn(f.core.adapter, 'batch').mockImplementationOnce(async (statements) => {
      await batch(statements);
      throw new Error('response_lost');
    });
    await f.step();
    await reactivate(f);
    await f.finish();
    expect(f.progress().succeeded).toBe(1);
    expect(account(f).lifecycle_state).toBe('active');
  });
  it('keeps an unresolved active result nonterminal at max_attempts and drains it on recovery', async () => {
    const f = await fixture(12);
    f.admin.db.exec("UPDATE admin_jobs SET max_attempts=1 WHERE id='job-1'");
    vi.spyOn(f.core.adapter, 'batch').mockRejectedValueOnce(new Error('core_before_commit'));
    await f.step();
    expect(f.row().status).toBe('pending');
    expect(f.progress().outcome?.status).toBe('failed');
    expect(await receipt(f).storage.get('support-ops-session-receipt')).toMatchObject({
      complete: false,
    });
    await f.finish();
    expect(f.row().status).toBe('failed');
    expect(f.progress().active).toBeUndefined();
    expect(account(f).lifecycle_state).toBe('suspended');
  });
  it('recovers final ACK response loss after normal lifecycle and a newer op replace the DO descriptor', async () => {
    const f = await fixture(2),
      rpc = receipt(f).rpc,
      complete = rpc.completeSupportOpsSuspensionReceiptRpc.bind(rpc);
    vi.spyOn(rpc, 'completeSupportOpsSuspensionReceiptRpc').mockImplementationOnce(
      async (...args) => {
        await complete(...args);
        throw new Error('complete_response_lost');
      }
    );
    await f.step();
    expect(f.progress().active).toMatchObject({ account_result: 1, transferred: { sequence: 1 } });
    await reactivate(f);
    await rpc.beginSupportOpsSuspensionRpc(
      TENANT,
      'user-1',
      'account:user-1',
      f.sourceVersionMs + 2000,
      'new-support-op',
      'new-owner',
      Date.now()
    );
    await f.finish();
    expect(f.row().status).toBe('completed');
    expect(f.progress().succeeded).toBe(1);
    expect(
      f.admin.db
        .prepare(
          "SELECT COUNT(*) n FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'"
        )
        .get()
    ).toMatchObject({ n: 1 });
  });
  it('yields within its call budget and keeps bounded, private logout pages before final audit', async () => {
    const f = await fixture(25);
    await f.step(45);
    expect(f.row().status).toBe('pending');
    expect(f.progress().active).toBeDefined();
    await f.finish();
    expect(f.row().status).toBe('completed');
    const jobs = f.admin.db
      .prepare("SELECT config FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'")
      .all() as Array<{ config: string }>;
    const configs = jobs.map((row) => JSON.parse(row.config) as { sessions: unknown[] });
    expect(configs.map((config) => config.sessions.length)).toEqual([10, 10, 5]);
    const audit = f.admin.db.prepare('SELECT metadata_json FROM admin_audit_log').all() as Array<{
      metadata_json: string;
    }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata_json).not.toMatch(/session-|account-user|target_id|store_identity/);
  });
  it('retains a logout page after an Admin commit response is lost and checks same-payload identity', async () => {
    const f = await fixture(12),
      execute = f.admin.adapter.execute.bind(f.admin.adapter);
    let fail = true;
    vi.spyOn(f.admin.adapter, 'execute').mockImplementation(async (sql, params) => {
      const result = await execute(sql, params);
      if (fail && sql.includes('ON CONFLICT')) {
        fail = false;
        throw new Error('response_lost');
      }
      return result;
    });
    await f.step();
    expect(f.progress().active?.account_result).toBe(1);
    await f.finish();
    expect(
      f.admin.db
        .prepare(
          "SELECT COUNT(*) n FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'"
        )
        .get()
    ).toMatchObject({ n: 2 });
    const input = {
      jobId: 'other-job',
      tenantId: TENANT,
      actionId: 'action-1',
      accountId: 'account-user-1',
      userId: 'user-1',
      operationId: 'other-op',
      sourceVersionMs: f.sourceVersionMs,
      sequence: 0,
      sessionIds: ['session-a'],
      executor: 'machine-1',
    };
    await keepSupportOpsLogoutPage(f.admin.adapter, input, async () => {});
    await expect(
      keepSupportOpsLogoutPage(
        f.admin.adapter,
        { ...input, sessionIds: ['session-b'] },
        async () => {}
      )
    ).rejects.toThrow('conflict');
  });
  it('preserves earlier target logout transfer and its actor/action when a later DO is unavailable', async () => {
    const f = await fixture(2, 2),
      later = f.receipts.get('user-2');
    if (!later) throw new Error('missing_later_target');
    vi.spyOn(later.rpc, 'beginSupportOpsSuspensionRpc').mockRejectedValueOnce(
      new Error('do_unavailable')
    );
    await f.step();
    expect(f.row().status).toBe('pending');
    expect(f.progress()).toMatchObject({
      processed: 1,
      succeeded: 1,
      active: { account_id: 'account-user-2' },
    });
    const rows = f.admin.db
      .prepare("SELECT config FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'")
      .all() as Array<{ config: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.config ?? 'null')).toMatchObject({
      trigger: {
        action: 'support_ops.action.execute',
        operationId: 'action-1',
        actorId: 'machine-1',
      },
      sessions: [
        { userId: 'user-1', sessionId: 'session-00000' },
        { userId: 'user-1', sessionId: 'session-00001' },
      ],
    });
    await f.finish();
    expect(f.progress().succeeded).toBe(2);
    expect(
      f.admin.db
        .prepare("SELECT config FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'")
        .all()
    ).toEqual(rows);
  });
  it('retries archive fanout with one durable audit identity instead of duplicating the D1 row', async () => {
    const f = await fixture(0);
    f.env.AUTHRIM_CONFIG = {} as KVNamespace;
    archive.mockResolvedValueOnce({ targetResults: [{ error: 'archive_unavailable' }] });
    await f.step();
    expect(f.row().status).toBe('pending');
    expect(f.admin.db.prepare('SELECT COUNT(*) n FROM admin_audit_log').get()).toMatchObject({
      n: 1,
    });
    await f.finish();
    expect(f.row().status).toBe('completed');
    expect(f.admin.db.prepare('SELECT COUNT(*) n FROM admin_audit_log').get()).toMatchObject({
      n: 1,
    });
    expect(archive).toHaveBeenCalledTimes(2);
    expect(archive.mock.calls[0]?.[0].records[0]?.id).toBe(
      archive.mock.calls[1]?.[0].records[0]?.id
    );
  });
  it.each(['databaseId', 'bindingRouteGeneration', 'shardId', 'assignmentGeneration'] as const)(
    'refuses changed physical %s before another DO/Core mutation',
    async (field) => {
      const f = await fixture(25);
      await f.step(45);
      expect(f.progress().active).toBeDefined();
      const store = f.stores.accounts[0];
      if (!store?.identity) throw new Error('missing_identity');
      const old = { ...store.identity };
      store.identity = {
        ...old,
        [field]: typeof old[field] === 'number' ? Number(old[field]) + 1 : 'replaced',
      };
      const begin = vi.spyOn(receipt(f).rpc, 'beginSupportOpsSuspensionRpc'),
        batch = vi.spyOn(f.core.adapter, 'batch');
      const began = begin.mock.calls.length;
      const batched = batch.mock.calls.length;
      await f.step();
      expect(begin).toHaveBeenCalledTimes(began);
      expect(batch).toHaveBeenCalledTimes(batched);
      expect(f.progress().active).toBeDefined();
      store.identity = old;
      await f.finish();
      expect(f.row().status).toBe('completed');
    }
  );
});

describe('Support Ops execute HTTP boundary', () => {
  it('exposes only whitelisted execution progress and hides internal logout jobs across tenants', async () => {
    const f = await fixture(2);
    await f.step(45);
    const publicJob = await readJob(f, '/jobs/job-1');
    expect(publicJob.status).toBe(200);
    const serialized = JSON.stringify(await publicJob.json());
    expect(serialized).not.toMatch(
      /session-00000|account-user-1|physical-accounts|operation_id|store_identity|source_version_ms/
    );
    expect((await readJob(f, '/jobs/job-1', 'other-tenant')).status).toBe(404);
    await f.finish();
    const logout = f.admin.db
      .prepare("SELECT id FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'")
      .get() as { id: string };
    for (const suffix of ['', '/result', '/result/download'])
      expect((await readJob(f, `/jobs/${logout.id}${suffix}`)).status).toBe(404);
    const list = JSON.stringify(await (await readJob(f, '/jobs')).json());
    expect(list).not.toContain(logout.id);
    expect(list).not.toContain('session-00000');
    expect(JSON.stringify(await (await readJob(f, '/jobs/types')).json())).not.toContain(
      'support-ops/action-execute-logout'
    );
  });
  it('preserves 200 for a bounded ten-target execution including durable final evidence', async () => {
    const f = await fixture(0, 10);
    approved(f);
    const response = await request(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'completed', succeeded_count: 10 });
    expect(f.admin.db.prepare('SELECT COUNT(*) n FROM admin_audit_log').get()).toMatchObject({
      n: 1,
    });
  });
  it('returns 202 for many sessions and above the target threshold, with no internal identifiers', async () => {
    const f = await fixture(2051, 10);
    approved(f);
    const response = await request(f),
      body = await response.json();
    expect(response.status).toBe(202);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('accepted_body_invalid');
    expect(Object.keys(body).sort()).toEqual([
      'action',
      'action_id',
      'cohort_id',
      'job_id',
      'resource',
      'status',
    ]);
    const transfers = f.admin.db
      .prepare("SELECT config FROM admin_jobs WHERE job_type='support-ops/action-execute-logout'")
      .all() as Array<{ config: string }>;
    expect(transfers.length).toBeGreaterThan(0);
    expect(
      transfers.every(
        (row) => (JSON.parse(row.config) as { sessions: unknown[] }).sessions.length <= 10
      )
    ).toBe(true);
    approved(f);
    f.core.db.exec('UPDATE support_operation_cohorts SET actionable_count=1001,matched_count=1001');
    expect((await request(f)).status).toBe(202);
  });
  it.each(['unsupported', 'missing_schema'] as const)(
    'preflights every account store before any action/job/DO write: %s',
    async (mode) => {
      const f = await fixture(0, 10);
      approved(f);
      const second = openCoreStore(TENANT);
      try {
        if (mode === 'unsupported') vi.spyOn(second.adapter, 'getType').mockReturnValue('postgres');
        else second.db.exec('DROP TABLE support_ops_account_result_receipts');
        f.stores.accounts.push({
          key: 'SECOND',
          adapter: second.adapter,
          identity: {
            databaseId: 'physical-second',
            shardId: 'second',
            bindingRouteGeneration: 1,
            assignmentGeneration: 1,
          },
        });
        const response = await request(f);
        expect(response.status).toBe(503);
        expect(f.admin.db.prepare('SELECT COUNT(*) n FROM admin_jobs').get()).toMatchObject({
          n: 0,
        });
        expect(
          f.core.db.prepare('SELECT status FROM support_operation_actions').get()
        ).toMatchObject({ status: 'approved' });
        expect(account(f).lifecycle_state).toBe('active');
        expect(await receipt(f).storage.get('support-ops-session-receipt')).toBeUndefined();
      } finally {
        second.db.close();
      }
    }
  );
  it('refuses missing physical identity, cross-tenant actions and insufficient permission without enqueueing', async () => {
    const f = await fixture(0, 10);
    approved(f);
    delete f.stores.accounts[0]?.identity;
    expect((await request(f)).status).toBe(503);
    expect((await request(f, { tenant: 'other-tenant' })).status).toBe(404);
    expect((await request(f, { permissions: [] })).status).toBe(403);
    expect(f.admin.db.prepare('SELECT COUNT(*) n FROM admin_jobs').get()).toMatchObject({ n: 0 });
  });
});

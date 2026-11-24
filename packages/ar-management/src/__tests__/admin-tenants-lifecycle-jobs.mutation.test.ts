/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the tenant lifecycle commands (suspend, resume, freeze, unfreeze,
 * restore-validate), their transition table and idempotency, the validation job list and retry,
 * and the continuation of a failed deletion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stepUp = vi.hoisted(() => ({ gate: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp.gate,
  refuseAdminFreshAuth: vi.fn(),
}));
const fakes = vi.hoisted(() => ({
  needsCancel: vi.fn(async (): Promise<boolean> => false),
  chainId: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('@authrim/ar-lib-core', async () =>
  (await import('./helpers/admin-tenants-mutation-harness')).buildCoreMock()
);
vi.mock('../single-tenant-guard', () => ({
  createSingleTenantMutationError: vi.fn(
    () => new Response(JSON.stringify({ error: 'single_tenant_mode' }), { status: 409 })
  ),
  ensureSupportedTenantId: vi.fn(async (): Promise<Response | null> => null),
  getSingleTenantId: vi.fn(() => 'default'),
  isSingleTenantMode: vi.fn(() => false),
}));
vi.mock('../tenant-region-shard-policy', () => ({
  ensureTenantProvisioningRegionShardConfig: vi.fn(),
}));
vi.mock('../tenant-deletion-reactivation-guard', () => ({
  failedTenantDeletionNeedsCancel: fakes.needsCancel,
}));
vi.mock('../tenant-deletion-chain', () => ({
  resolveTenantDeletionChainOperationId: fakes.chainId,
}));

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import {
  adminTenantDeleteHandler,
  adminTenantLifecycleJobRetryHandler,
  adminTenantLifecycleJobsHandler,
} from '../admin-tenants';
import { ensureSupportedTenantId } from '../single-tenant-guard';
import {
  adapters,
  createAdapter,
  createContext,
  createTenantRow,
} from './helpers/admin-tenants-mutation-harness';
import { must } from './helpers/must';

type Handler = (c: never) => Promise<Response>;

const T0 = 1767225600; // 2026-01-01T00:00:00Z

const TENANT_ADMIN = {
  userId: 'tenant-admin',
  roles: ['ar_tenant_admin'],
  globalRoles: [],
  tenantScope: ['second'],
  permissions: [],
};

function context(
  body: Record<string, unknown>,
  options: {
    key?: string | null;
    auth?: Record<string, unknown>;
    env?: Record<string, unknown>;
  } = {}
) {
  const c = createContext(body, options.env ?? {}, { id: 'second', jobId: 'job-1' }, options.auth);
  const key = 'key' in options ? options.key : 'key-1';
  c.req.header = vi.fn((name: string) =>
    name.toLowerCase() === 'idempotency-key' ? key : undefined
  );
  return c;
}

async function call(handler: unknown, c: unknown) {
  const response = await (handler as Handler)(c as never);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

interface Setup {
  tenant?: object | null;
  jobsStoreJob?: Record<string, unknown> | null;
  inventoryJob?: Record<string, unknown> | null;
  updateRows?: number;
  deleting?: boolean;
  insertError?: Error;
  moveBackRows?: number;
  moveBackError?: boolean;
  current?: Record<string, unknown> | null | 'throw';
}

function setup(options: Setup = {}) {
  const tenant =
    'tenant' in options
      ? options.tenant
      : createTenantRow('second', { lifecycle_state: 'active', updated_at: 10 });
  adapters.defaultAdapter = createAdapter((sql, _params, op) => {
    if (op === 'queryOne' && sql.startsWith('SELECT 1 AS found'))
      return options.deleting ? { found: 1 } : null;
    if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return options.inventoryJob ?? null;
    if (
      op === 'queryOne' &&
      sql === 'SELECT lifecycle_state, updated_at FROM tenants WHERE id = ?'
    ) {
      if (options.current === 'throw') throw new Error('read failed');
      return options.current ?? null;
    }
    if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) return tenant;
    if (op === 'execute' && sql.includes('UPDATE tenants SET lifecycle_state = ?')) {
      const isMoveBack =
        !sql.includes('NOT EXISTS') &&
        must(adapters.defaultAdapter).calls.filter((c) => c.op === 'execute').length > 1;
      if (isMoveBack) {
        if (options.moveBackError) throw new Error('move back failed');
        return { rowsAffected: options.moveBackRows ?? 1 };
      }
      return { rowsAffected: options.updateRows ?? 1 };
    }
    return null;
  });
  adapters.lifecycleJobsAdapter = createAdapter((sql, _params, op) => {
    if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return options.jobsStoreJob ?? null;
    if (op === 'execute' && sql.includes('INSERT INTO admin_jobs') && options.insertError) {
      throw options.insertError;
    }
    return { rowsAffected: 1 };
  });
  return { platform: adapters.defaultAdapter, jobs: adapters.lifecycleJobsAdapter };
}

beforeEach(() => {
  adapters.defaultAdapter = null;
  adapters.tenantAdapters.clear();
  adapters.adminAdapter = null;
  adapters.lifecycleJobsAdapter = null;
  vi.clearAllMocks();
  fakes.needsCancel.mockReset();
  fakes.needsCancel.mockResolvedValue(false);
  fakes.chainId.mockReset();
  fakes.chainId.mockResolvedValue(null);
  vi.mocked(ensureSupportedTenantId).mockResolvedValue(null);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

describe('tenant lifecycle jobs', () => {
  const jobRow = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
    id,
    status: 'completed',
    progress: '{"stage":"completed"}',
    result: '{"ok":true}',
    config: '{"command":"suspend"}',
    error_code: 'secret',
    error_message: null,
    created_by: 'someone',
    attempt_count: 0,
    max_attempts: 3,
    next_run_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: createdAt,
    ...extra,
  });

  it('merges both stores, newest first with ids as tie break, at most 20, without internal columns', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) =>
      op === 'query'
        ? [
            jobRow('b', 5),
            jobRow('shared', 7),
            ...Array.from({ length: 19 }, (_, i) => jobRow(`old-${i}`, 1)),
          ]
        : null
    );
    adapters.lifecycleJobsAdapter = createAdapter((_sql, _params, op) =>
      op === 'query'
        ? [
            jobRow('a', 5),
            jobRow('shared', 7, { status: 'pending' }),
            jobRow('z', 9, { progress: null, result: null, config: null }),
          ]
        : null
    );
    const result = await call(adminTenantLifecycleJobsHandler, context({}));
    expect(result.status).toBe(200);
    expect(result.body.jobs).toHaveLength(20);
    expect(result.body.jobs.slice(0, 4).map((job: { id: string }) => job.id)).toEqual([
      'z',
      'shared',
      'a',
      'b',
    ]);
    expect(result.body.jobs[1].status).toBe('pending');
    expect(result.body.jobs[0]).toMatchObject({ progress: null, result: null, config: null });
    expect(result.body.jobs[2]).toMatchObject({
      progress: { stage: 'completed' },
      result: { ok: true },
      config: { command: 'suspend' },
    });
    expect('created_by' in result.body.jobs[0]).toBe(false);
    expect('error_code' in result.body.jobs[0]).toBe(false);
    for (const adapter of [adapters.defaultAdapter, adapters.lifecycleJobsAdapter]) {
      expect(adapter.calls[0].params).toEqual(['second']);
      expect(adapter.calls[0].sql).toContain('LIMIT 20');
    }
  });

  it('is refused for a tenant administrator and by the single-tenant guard', async () => {
    setup();
    expect(
      (await call(adminTenantLifecycleJobsHandler, context({}, { auth: TENANT_ADMIN }))).status
    ).toBe(403);
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(new Response('{}', { status: 404 }));
    expect((await call(adminTenantLifecycleJobsHandler, context({}))).status).toBe(404);
  });
});

describe('tenant lifecycle job retry', () => {
  const failed = (extra: Record<string, unknown> = {}) => ({
    id: 'job-1',
    status: 'failed',
    config: '{"source_state":"suspended","command":"resume"}',
    created_by: 'creator',
    created_at: 42,
    ...extra,
  });

  function retrySetup(options: { moved?: unknown; legacy?: unknown } = {}) {
    adapters.defaultAdapter = createAdapter((sql, _params, op) =>
      op === 'queryOne' && sql.includes('FROM admin_jobs')
        ? (options.legacy ?? null)
        : { rowsAffected: 1 }
    );
    adapters.lifecycleJobsAdapter = createAdapter((sql, _params, op) =>
      op === 'queryOne' && sql.includes('FROM admin_jobs')
        ? (options.moved ?? null)
        : { rowsAffected: 1 }
    );
    return { inventory: adapters.defaultAdapter, jobs: adapters.lifecycleJobsAdapter };
  }

  it('answers 404 for a job that exists nowhere', async () => {
    const { inventory, jobs } = retrySetup();
    const result = await call(adminTenantLifecycleJobRetryHandler, context({}));
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({ variables: { resource: 'tenant lifecycle job' } });
    expect(inventory.calls[0].params).toEqual(['job-1', 'second']);
    expect(jobs.calls[0].params).toEqual(['job-1', 'second']);
  });

  it.each(['pending', 'processing', 'completed'])('refuses to retry a %s job', async (status) => {
    const { jobs } = retrySetup({ moved: failed({ status }) });
    const result = await call(adminTenantLifecycleJobRetryHandler, context({}));
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'invalid_job_state',
      error_description: 'Only failed lifecycle jobs can be retried',
    });
    expect(jobs.execute).not.toHaveBeenCalled();
  });

  it.each(['failed', 'partial_failure'])('re-queues a %s job in DB_ADMIN', async (status) => {
    const { jobs, inventory } = retrySetup({ moved: failed({ status }) });
    const result = await call(adminTenantLifecycleJobRetryHandler, context({}));
    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      job_id: 'job-1',
      status: 'pending',
      tenant_id: 'second',
      lifecycle_state: 'suspended',
      validation_required: true,
    });
    expect(jobs.execute).toHaveBeenCalledTimes(1);
    const update = must(jobs.calls.find((call) => call.op === 'execute'));
    expect(update.sql).toContain("SET status = 'pending'");
    expect(update.sql).toContain("status IN ('failed', 'partial_failure')");
    expect(update.params).toEqual([
      '{"stage":"retry_queued","checks":[]}',
      T0,
      T0,
      'job-1',
      'second',
    ]);
    expect(inventory.calls.filter((call) => call.op === 'execute')).toHaveLength(0);
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.lifecycle.validation_retry_requested',
      'tenant',
      'second',
      {
        job_id: 'job-1',
        prior_status: status,
        config: { source_state: 'suspended', command: 'resume' },
      }
    );
  });

  it('defaults the state to frozen and the audited config to null when the job has none', async () => {
    retrySetup({ moved: failed({ config: null }) });
    const result = await call(adminTenantLifecycleJobRetryHandler, context({}));
    expect(result.body.lifecycle_state).toBe('frozen');
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'tenant',
      'second',
      expect.objectContaining({ config: null })
    );
    retrySetup({ moved: failed({ config: '{}' }) });
    expect(
      (await call(adminTenantLifecycleJobRetryHandler, context({}))).body.lifecycle_state
    ).toBe('frozen');
  });

  it('moves a job kept in the inventory to DB_ADMIN, pending, and removes the old row', async () => {
    const { jobs, inventory } = retrySetup({ legacy: failed() });
    const result = await call(adminTenantLifecycleJobRetryHandler, context({}));
    expect(result.status).toBe(202);
    const insert = must(jobs.calls.find((call) => call.op === 'execute'));
    expect(insert.sql).toContain('INSERT OR IGNORE INTO admin_jobs');
    expect(insert.sql).toContain("'pending'");
    expect(insert.params).toEqual([
      'job-1',
      'second',
      '{"stage":"retry_queued","checks":[]}',
      '{"source_state":"suspended","command":"resume"}',
      'creator',
      42,
      T0,
      T0,
    ]);
    const removal = must(inventory.calls.find((call) => call.op === 'execute'));
    expect(removal.sql).toContain('DELETE FROM admin_jobs');
    expect(removal.sql).toContain("status IN ('failed', 'partial_failure')");
    expect(removal.params).toEqual(['job-1', 'second']);
  });

  it('removes a leftover inventory copy of a job already moved, then retries the moved one', async () => {
    const { jobs, inventory } = retrySetup({
      moved: failed(),
      legacy: failed({ created_by: 'old' }),
    });
    await call(adminTenantLifecycleJobRetryHandler, context({}));
    expect(
      inventory.calls.filter((call) => call.sql.startsWith('DELETE FROM admin_jobs'))
    ).toHaveLength(1);
    expect(must(jobs.calls.find((call) => call.op === 'execute')).sql).toContain(
      'UPDATE admin_jobs'
    );
  });

  it('is refused for a tenant administrator and by the single-tenant guard', async () => {
    retrySetup({ moved: failed() });
    expect(
      (await call(adminTenantLifecycleJobRetryHandler, context({}, { auth: TENANT_ADMIN }))).status
    ).toBe(403);
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(new Response('{}', { status: 404 }));
    expect((await call(adminTenantLifecycleJobRetryHandler, context({}))).status).toBe(404);
  });
});

describe('tenant delete: continuing a failed deletion', () => {
  function deleteSetup() {
    adapters.defaultAdapter = createAdapter((sql, _params, op) =>
      op === 'queryOne' &&
      sql === 'SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?'
        ? { id: 'second', is_default: 0, lifecycle_state: 'suspended' }
        : null
    );
    return adapters.defaultAdapter;
  }

  it('adopts the failed deletion chain in the guarded update and the job config', async () => {
    const adapter = deleteSetup();
    adapters.lifecycleJobsAdapter = createAdapter();
    fakes.chainId.mockResolvedValue('chain-1');
    const result = await call(adminTenantDeleteHandler, context({}));
    expect(result.status).toBe(202);
    const [statements] = adapter.batch.mock.calls[0] as unknown as [
      Array<{ sql: string; params: unknown[] }>,
    ];
    expect(statements[0].sql).toContain("json_extract(config, '$.tenant_id') = ?");
    expect(statements[0].sql).toContain('AND EXISTS (SELECT 1 FROM admin_jobs');
    expect(statements[0].params).toContain('chain-1');
    expect(statements[0].params).toEqual(
      expect.arrayContaining(['tenant_deletion_cancelled', 'second', 'chain-1', 'chain-1'])
    );
    expect(JSON.parse(String(statements[1].params[5]))).toEqual({
      tenant_id: 'second',
      operation_id: 'chain-1',
      marker_aware: true,
    });
    expect(fakes.chainId).toHaveBeenCalledWith(adapter, adapters.lifecycleJobsAdapter, 'second');
  });

  it('starts a fresh chain when none is adopted, or when it cannot be read', async () => {
    const adapter = deleteSetup();
    adapters.lifecycleJobsAdapter = createAdapter();
    fakes.chainId.mockResolvedValue(null);
    await call(adminTenantDeleteHandler, context({}));
    const [first] = adapter.batch.mock.calls[0] as unknown as [
      Array<{ sql: string; params: unknown[] }>,
    ];
    expect(first[0].sql).not.toContain('AND EXISTS (SELECT 1 FROM admin_jobs');
    expect(JSON.parse(String(first[1].params[5]))).toEqual({
      tenant_id: 'second',
      marker_aware: true,
    });
    adapter.batch.mockClear();
    fakes.chainId.mockRejectedValue(new Error('unreadable'));
    const result = await call(adminTenantDeleteHandler, context({}));
    expect(result.status).toBe(202);
    const [second] = adapter.batch.mock.calls[0] as unknown as [
      Array<{ sql: string; params: unknown[] }>,
    ];
    expect(JSON.parse(String(second[1].params[5]))).toEqual({
      tenant_id: 'second',
      marker_aware: true,
    });
  });
});

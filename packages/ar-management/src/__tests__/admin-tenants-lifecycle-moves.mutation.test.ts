/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

import {
  createAuditLogFromContext,
  deleteTenantExistsCache,
  putTenantExistsCache,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  adminTenantFreezeHandler,
  adminTenantResumeHandler,
  adminTenantRestoreValidateHandler,
  adminTenantSuspendHandler,
  adminTenantUnfreezeHandler,
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

const BREAK_GLASS_ADMIN = {
  userId: 'platform-admin',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  tenantScope: ['*'],
  permissions: ['admin:tenants:lifecycle:break_glass'],
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

const stateBody = (extra: Record<string, unknown> = {}) => ({
  expected_state: 'active',
  expected_updated_at: 10,
  reason: 'planned maintenance',
  ...extra,
});

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

describe('lifecycle command: the move and its job', () => {
  it('suspends at once: moves the tenant, keeps a completed job and drops the cache entry', async () => {
    const { platform, jobs } = setup();
    const result = await call(
      adminTenantSuspendHandler,
      context(stateBody({ reason: '  planned maintenance  ' }))
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      job_id: expect.any(String),
      status: 'completed',
      tenant_id: 'second',
      lifecycle_state: 'suspended',
      validation_required: false,
    });
    const update = must(platform.calls.find((call) => call.op === 'execute'));
    expect(update.sql).toBe(
      'UPDATE tenants SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND lifecycle_state = ? AND updated_at = ?'
    );
    expect(update.params).toEqual(['suspended', T0, 'second', 'active', 10]);
    const insert = must(jobs.calls.find((call) => call.sql.includes('INSERT INTO admin_jobs')));
    const [id, tenantId, status, progress, config, createdBy, createdAt, updatedAt, estimated] =
      insert.params;
    expect([id, tenantId, status, createdBy, createdAt, updatedAt, estimated]).toEqual([
      result.body.job_id,
      'second',
      'completed',
      'platform-admin',
      T0,
      T0,
      T0,
    ]);
    expect(JSON.parse(String(progress))).toEqual({
      stage: 'completed',
      checks: [],
      transitioned_to: 'suspended',
    });
    expect(JSON.parse(String(config))).toEqual({
      command: 'suspend',
      validation_kind: 'suspend',
      source_state: 'active',
      target_state: 'suspended',
      reason: 'planned maintenance',
      break_glass: false,
      idempotency_key: 'key-1',
      expected_updated_at: 10,
      accepted_at: T0,
      actor_id: 'platform-admin',
    });
    expect(deleteTenantExistsCache).toHaveBeenCalledWith(expect.anything(), 'second');
    expect(putTenantExistsCache).not.toHaveBeenCalled();
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.lifecycle.suspend',
      'tenant',
      'second',
      {
        job_id: result.body.job_id,
        source_state: 'active',
        target_state: 'suspended',
        reason: 'planned maintenance',
        break_glass: false,
        idempotency_key: 'key-1',
      }
    );
  });

  it('queues a validation for resume, leaving the tenant in its state and its version moved', async () => {
    const { platform, jobs } = setup({
      tenant: createTenantRow('second', { lifecycle_state: 'suspended', updated_at: T0 + 50 }),
    });
    const result = await call(
      adminTenantResumeHandler,
      context(stateBody({ expected_state: 'suspended', expected_updated_at: T0 + 50 }))
    );
    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      job_id: expect.any(String),
      status: 'pending',
      tenant_id: 'second',
      lifecycle_state: 'suspended',
      validation_required: true,
    });
    // The version runs ahead of the clock: one past the tenant's own.
    const update = must(platform.calls.find((call) => call.op === 'execute'));
    expect(update.params.slice(0, 2)).toEqual(['suspended', T0 + 51]);
    expect(update.sql).toContain('AND NOT EXISTS (SELECT 1 FROM admin_jobs');
    expect(update.params.slice(5)).toEqual(['second', expect.any(Number)]);
    const insert = must(jobs.calls.find((call) => call.sql.includes('INSERT INTO admin_jobs')));
    expect(insert.params[2]).toBe('pending');
    expect(insert.params[6]).toBe(T0 + 51);
    expect(insert.params[8]).toBe(T0 + 51 + 300);
    expect(JSON.parse(String(insert.params[3]))).toEqual({ stage: 'queued', checks: [] });
    expect(JSON.parse(String(insert.params[4]))).toMatchObject({
      command: 'resume',
      target_state: 'active',
      accepted_at: T0,
    });
    expect(deleteTenantExistsCache).toHaveBeenCalledWith(expect.anything(), 'second');
  });

  it('keeps the cache entry of a tenant that stays active', async () => {
    setup({ tenant: createTenantRow('second', { lifecycle_state: 'active', updated_at: 10 }) });
    // Break glass resume of an active tenant: validation required, state unchanged.
    const result = await call(
      adminTenantResumeHandler,
      context(stateBody({ break_glass: true }), { auth: BREAK_GLASS_ADMIN })
    );
    expect(result.status).toBe(202);
    expect(result.body.lifecycle_state).toBe('active');
    expect(putTenantExistsCache).toHaveBeenCalledWith(expect.anything(), 'second');
    expect(deleteTenantExistsCache).not.toHaveBeenCalled();
  });

  it('moves a restore validation to restore_validating at once and records the restore kind', async () => {
    const { jobs } = setup({
      tenant: createTenantRow('second', { lifecycle_state: 'restore_pending', updated_at: 10 }),
    });
    const result = await call(
      adminTenantRestoreValidateHandler,
      context(stateBody({ expected_state: 'restore_pending' }))
    );
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ lifecycle_state: 'restore_validating', status: 'pending' });
    const insert = must(jobs.calls.find((call) => call.sql.includes('INSERT INTO admin_jobs')));
    expect(JSON.parse(String(insert.params[4]))).toMatchObject({
      command: 'restore-validate',
      validation_kind: 'restore',
      source_state: 'restore_pending',
      target_state: 'restore_validating',
    });
    expect(
      must(must(adapters.defaultAdapter).calls.find((call) => call.op === 'execute')).sql
    ).toContain('AND NOT EXISTS');
  });

  it('freezes at once, and unfreezing queues a validation', async () => {
    setup();
    const frozen = await call(adminTenantFreezeHandler, context(stateBody()));
    expect(frozen.body).toMatchObject({ lifecycle_state: 'frozen', status: 'completed' });
    expect(
      must(must(adapters.defaultAdapter).calls.find((call) => call.op === 'execute')).sql
    ).not.toContain('NOT EXISTS');
    setup({ tenant: createTenantRow('second', { lifecycle_state: 'frozen', updated_at: 10 }) });
    const unfrozen = await call(
      adminTenantUnfreezeHandler,
      context(stateBody({ expected_state: 'frozen' }))
    );
    expect(unfrozen.status).toBe(202);
  });

  it('records the machine actor in the job, and unknown when there is none', async () => {
    const { jobs } = setup();
    await call(
      adminTenantSuspendHandler,
      context(stateBody(), {
        auth: {
          userId: 'u1',
          actorId: 'machine-7',
          roles: ['ar_super_admin'],
          globalRoles: ['ar_super_admin'],
          tenantScope: ['*'],
          permissions: [],
        },
      })
    );
    const insert = must(jobs.calls.find((call) => call.sql.includes('INSERT INTO admin_jobs')));
    expect(insert.params[5]).toBe('machine-7');
    expect(JSON.parse(String(insert.params[4])).actor_id).toBe('machine-7');
    const anonymous = setup();
    await call(
      adminTenantSuspendHandler,
      context(stateBody(), {
        auth: {
          roles: ['ar_super_admin'],
          globalRoles: ['ar_super_admin'],
          tenantScope: ['*'],
          permissions: [],
        },
      })
    );
    const second = must(
      anonymous.jobs.calls.find((call) => call.sql.includes('INSERT INTO admin_jobs'))
    );
    expect(second.params[5]).toBe('unknown');
    expect(JSON.parse(String(second.params[4])).actor_id).toBeNull();
  });
});

describe('lifecycle command: reactivation and races', () => {
  const suspendedTenant = () =>
    createTenantRow('second', { lifecycle_state: 'suspended', updated_at: 10 });

  it('asks whether a failed deletion must be cancelled first, for each reactivating command', async () => {
    for (const [handler, state] of [
      [adminTenantResumeHandler, 'suspended'],
      [adminTenantUnfreezeHandler, 'frozen'],
      [adminTenantRestoreValidateHandler, 'restore_pending'],
    ] as const) {
      fakes.needsCancel.mockClear();
      setup({ tenant: createTenantRow('second', { lifecycle_state: state, updated_at: 10 }) });
      await call(handler, context(stateBody({ expected_state: state })));
      expect(fakes.needsCancel).toHaveBeenCalledTimes(1);
      expect(fakes.needsCancel.mock.calls[0]).toEqual([
        adapters.defaultAdapter,
        adapters.lifecycleJobsAdapter,
        'second',
      ]);
    }
    fakes.needsCancel.mockClear();
    setup();
    await call(adminTenantSuspendHandler, context(stateBody()));
    expect(fakes.needsCancel).not.toHaveBeenCalled();
    expect(requireDedicatedAdminDatabaseAdapter).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-deletion-chain'
    );
  });

  it('refuses a reactivation that must go through the deletion cancel', async () => {
    const { platform, jobs } = setup({ tenant: suspendedTenant() });
    fakes.needsCancel.mockResolvedValue(true);
    const result = await call(
      adminTenantResumeHandler,
      context(stateBody({ expected_state: 'suspended' }))
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('tenant_deletion_failed_use_cancel');
    expect(result.body.error_description).toBe(
      'The last deletion of this tenant failed and left its route out of service; cancel it with POST /api/admin/tenants/{id}/deletion/cancel before reactivating the tenant'
    );
    expect(platform.calls.filter((call) => call.op === 'execute')).toHaveLength(0);
    expect(jobs.execute).not.toHaveBeenCalled();
  });

  it('answers 503 when the route state cannot be read, changing nothing', async () => {
    const { platform } = setup({ tenant: suspendedTenant() });
    fakes.needsCancel.mockRejectedValue(new Error('route unreadable'));
    const result = await call(
      adminTenantResumeHandler,
      context(stateBody({ expected_state: 'suspended' }))
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: 'tenant_route_state_unavailable',
      error_description: 'The tenant route state could not be read; nothing was changed',
    });
    expect(platform.calls.filter((call) => call.op === 'execute')).toHaveLength(0);
  });

  it('answers 409 deletion in progress when the guarded update matched nothing and a deletion runs', async () => {
    const { jobs } = setup({ tenant: suspendedTenant(), updateRows: 0, deleting: true });
    const result = await call(
      adminTenantResumeHandler,
      context(stateBody({ expected_state: 'suspended' }))
    );
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_deletion_in_progress',
      error_description:
        'The tenant has a deletion in progress; wait for it to finish or fail before reactivating it',
    });
    expect(jobs.execute).not.toHaveBeenCalled();
  });

  it('answers 409 conflict when the guarded update matched nothing and no deletion runs', async () => {
    setup({ tenant: suspendedTenant(), updateRows: 0 });
    const resumed = await call(
      adminTenantResumeHandler,
      context(stateBody({ expected_state: 'suspended' }))
    );
    expect(resumed.body).toEqual({
      error: 'lifecycle_conflict',
      error_description: 'Tenant lifecycle changed concurrently',
    });
    // A command that does not reactivate never asks about deletions.
    const { platform } = setup({ updateRows: 0, deleting: true });
    const suspended = await call(adminTenantSuspendHandler, context(stateBody()));
    expect(suspended.body.error).toBe('lifecycle_conflict');
    expect(platform.calls.some((call) => call.sql.startsWith('SELECT 1 AS found'))).toBe(false);
  });

  it('moves the tenant back when its job cannot be kept, and the request fails', async () => {
    const { platform } = setup({ insertError: new Error('jobs db down') });
    await expect(call(adminTenantSuspendHandler, context(stateBody()))).rejects.toThrow(
      'jobs db down'
    );
    const executes = platform.calls.filter((call) => call.op === 'execute');
    expect(executes[1].sql).toBe(
      'UPDATE tenants SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND lifecycle_state = ? AND updated_at = ?'
    );
    expect(executes[1].params).toEqual(['active', 10, 'second', 'suspended', T0]);
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
    expect(putTenantExistsCache).not.toHaveBeenCalled();
  });

  it('records the move that stands when the tenant could not be moved back and is as the command left it', async () => {
    const { platform } = setup({
      insertError: new Error('jobs db down'),
      moveBackRows: 0,
      current: { lifecycle_state: 'suspended', updated_at: T0 },
    });
    await expect(call(adminTenantSuspendHandler, context(stateBody()))).rejects.toThrow(
      'jobs db down'
    );
    expect(
      platform.calls.some(
        (call) => call.sql === 'SELECT lifecycle_state, updated_at FROM tenants WHERE id = ?'
      )
    ).toBe(true);
    expect(deleteTenantExistsCache).toHaveBeenCalledTimes(1);
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.lifecycle.suspend',
      'tenant',
      'second',
      {
        job_id: null,
        job_kept: false,
        move_stands: true,
        source_state: 'active',
        target_state: 'suspended',
        observed_state: 'suspended',
        reason: 'planned maintenance',
        break_glass: false,
        idempotency_key: 'key-1',
      }
    );
  });

  it('follows the cache to an active state that stands, and drops it when another command moved on', async () => {
    setup({
      tenant: suspendedTenant(),
      insertError: new Error('jobs db down'),
      moveBackRows: 0,
      current: { lifecycle_state: 'suspended', updated_at: T0 + 1 },
    });
    // Resume keeps the state; the version no longer matches: not standing.
    await expect(
      call(adminTenantResumeHandler, context(stateBody({ expected_state: 'suspended' })))
    ).rejects.toThrow('jobs db down');
    expect(deleteTenantExistsCache).toHaveBeenCalled();
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.lifecycle.resume',
      'tenant',
      'second',
      expect.objectContaining({ move_stands: false, observed_state: 'suspended' })
    );
    vi.clearAllMocks();
    setup({
      tenant: createTenantRow('second', { lifecycle_state: 'active', updated_at: 10 }),
      insertError: new Error('jobs db down'),
      moveBackRows: 0,
      current: { lifecycle_state: 'active', updated_at: T0 },
    });
    // A break-glass resume of an active tenant "stands" as active: the cache follows it.
    await expect(
      call(
        adminTenantResumeHandler,
        context(stateBody({ break_glass: true }), { auth: BREAK_GLASS_ADMIN })
      )
    ).rejects.toThrow('jobs db down');
    expect(putTenantExistsCache).toHaveBeenCalledWith(expect.anything(), 'second');
  });

  it('records an unknown observed state when the tenant cannot be read, and survives a failing audit', async () => {
    setup({ insertError: new Error('jobs db down'), moveBackError: true, current: 'throw' });
    vi.mocked(createAuditLogFromContext).mockRejectedValueOnce(new Error('audit down'));
    vi.mocked(deleteTenantExistsCache).mockRejectedValueOnce(new Error('cache down'));
    await expect(call(adminTenantSuspendHandler, context(stateBody()))).rejects.toThrow(
      'jobs db down'
    );
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.lifecycle.suspend',
      'tenant',
      'second',
      expect.objectContaining({ move_stands: false, observed_state: null })
    );
    expect(deleteTenantExistsCache).toHaveBeenCalled();
  });
});

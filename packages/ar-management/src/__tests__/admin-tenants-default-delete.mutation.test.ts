/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the tenant inventory handlers: list, update, set-default and
 * delete. Each asserts the status, the body, the SQL and parameters written and what is left
 * unwritten when a request is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stepUp = vi.hoisted(() => ({ gate: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp.gate,
  refuseAdminFreshAuth: vi.fn(),
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
  ensureTenantRegionShardConfig: vi.fn(),
}));
vi.mock('../tenant-deletion-cancel', () => ({
  cancelTenantDeletion: vi.fn(async () => new Response('{"cancelled":true}', { status: 202 })),
}));

import {
  createAuditLogFromContext,
  deleteTenantExistsCache,
  putTenantExistsCache,
} from '@authrim/ar-lib-core';
import {
  adminTenantDeleteHandler,
  adminTenantDeletionCancelHandler,
  adminTenantGetHandler,
  adminTenantSetDefaultHandler,
} from '../admin-tenants';
import { cancelTenantDeletion } from '../tenant-deletion-cancel';
import { ensureSupportedTenantId, isSingleTenantMode } from '../single-tenant-guard';
import {
  adapters,
  createAdapter,
  createContext,
  createTenantRow,
} from './helpers/admin-tenants-mutation-harness';

type Handler = (c: never) => Promise<Response>;

const TENANT_COLUMNS =
  'SELECT id, tenant_code, name, description, isolation_policy, lifecycle_state, is_default, created_at, updated_at FROM tenants';

async function run(
  handler: unknown,
  body: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
  params: Record<string, string> = {},
  auth?: Record<string, unknown>
) {
  const response = await (handler as Handler)(createContext(body, env, params, auth) as never);
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json, response };
}

const TENANT_ADMIN = {
  userId: 'tenant-admin',
  roles: ['ar_tenant_admin'],
  globalRoles: [],
  tenantScope: ['tenant-a', 'tenant-b'],
  permissions: [],
};

beforeEach(() => {
  adapters.defaultAdapter = null;
  adapters.tenantAdapters.clear();
  adapters.adminAdapter = null;
  adapters.lifecycleJobsAdapter = null;
  vi.clearAllMocks();
  vi.mocked(isSingleTenantMode).mockReturnValue(false);
  vi.mocked(ensureSupportedTenantId).mockResolvedValue(null);
  stepUp.gate.mockResolvedValue(null);
});

describe('tenant set-default', () => {
  function setup(
    options: { state?: string; rows?: number; deleting?: boolean; updated?: unknown } = {}
  ) {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id, lifecycle_state FROM tenants WHERE id = ?') {
        return options.state === 'missing'
          ? null
          : { id: 'second', lifecycle_state: options.state ?? 'active' };
      }
      if (op === 'queryOne' && sql.startsWith('SELECT 1 AS found')) {
        return options.deleting ? { found: 1 } : null;
      }
      if (op === 'queryOne' && sql === `${TENANT_COLUMNS} WHERE id = ?`) {
        return 'updated' in options
          ? options.updated
          : createTenantRow('second', { is_default: 1 });
      }
      return null;
    });
    adapters.defaultAdapter.batch.mockResolvedValue([
      { rowsAffected: 1 },
      { rowsAffected: options.rows ?? 1 },
    ]);
    return adapters.defaultAdapter;
  }

  it('answers 404 for a missing tenant and 400 for one that is not active', async () => {
    setup({ state: 'missing' });
    const missing = await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' });
    expect(missing.status).toBe(404);
    for (const state of ['suspended', 'provisioning', 'deleting']) {
      const adapter = setup({ state });
      const result = await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' });
      expect(result.status).toBe(400);
      expect(result.body.details).toEqual({
        variables: { field: 'id', reason: 'Cannot set a non-active tenant as default' },
      });
      expect(adapter.batch).not.toHaveBeenCalled();
    }
  });

  it('refuses in single-tenant mode', async () => {
    vi.mocked(isSingleTenantMode).mockReturnValue(true);
    const adapter = setup();
    const result = await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'single_tenant_mode' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('moves the default in one guarded batch and answers the new default', async () => {
    const adapter = setup();
    const result = await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 'second', is_default: true });
    const [statements] = adapter.batch.mock.calls[0] as unknown as [
      Array<{ sql: string; params: unknown[] }>,
    ];
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('SET is_default = 0, default_tenant_guard = NULL');
    expect(statements[0].sql).toContain('WHERE is_default = 1');
    expect(statements[0].sql).toContain("lifecycle_state = 'active'");
    expect(statements[0].sql).toContain('NOT EXISTS (SELECT 1 FROM admin_jobs');
    expect(statements[0].params.slice(1, 3)).toEqual(['second', 'second']);
    expect(statements[1].sql).toContain('SET is_default = 1, default_tenant_guard = ?');
    expect(statements[1].params[0]).toBe('default');
    expect(statements[1].params[2]).toBe('second');
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.set_default',
      'tenant',
      'second',
      { tenant_id: 'second' }
    );
  });

  it('answers 409 deletion in progress when the guarded batch matched nothing and a deletion runs', async () => {
    setup({ rows: 0, deleting: true });
    const result = await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_deletion_in_progress',
      error_description: 'The tenant has a deletion in progress; it cannot become the default',
    });
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
  });

  it('answers 409 state changed when nothing matched and no deletion runs', async () => {
    setup({ rows: 0 });
    const result = await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_state_changed',
      error_description: 'The tenant is no longer active; the default tenant was not changed',
    });
  });

  it('treats a batch that changed more than one row as not applied', async () => {
    setup({ rows: 2 });
    expect((await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' })).status).toBe(409);
  });

  it('answers 500 when the new default cannot be read back, or the database fails', async () => {
    setup({ updated: null });
    expect((await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' })).status).toBe(500);
    adapters.defaultAdapter = createAdapter(() => {
      throw new Error('db down');
    });
    expect((await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' })).status).toBe(500);
  });

  it('is refused for a scoped administrator and by the single-tenant guard', async () => {
    const adapter = setup();
    expect(
      (await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' }, TENANT_ADMIN)).status
    ).toBe(403);
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(new Response('{}', { status: 404 }));
    expect((await run(adminTenantSetDefaultHandler, {}, {}, { id: 'second' })).status).toBe(404);
    expect(adapter.batch).not.toHaveBeenCalled();
  });
});

describe('tenant delete', () => {
  const rowFor = (extra: Record<string, unknown> = {}) => ({
    id: 'second',
    is_default: 0,
    lifecycle_state: 'active',
    ...extra,
  });

  function setup(row: unknown = rowFor(), batch?: Array<{ rowsAffected: number }>) {
    adapters.defaultAdapter = createAdapter((sql, _params, op) =>
      op === 'queryOne' &&
      sql === 'SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?'
        ? row
        : null
    );
    if (batch) adapters.defaultAdapter.batch.mockResolvedValue(batch);
    return adapters.defaultAdapter;
  }

  it('refuses the primary and the deployment default tenant before reading anything', async () => {
    const adapter = setup();
    const primary = await run(adminTenantDeleteHandler, {}, {}, { id: 'default' });
    expect(primary.status).toBe(400);
    expect(primary.body.details).toEqual({
      variables: { field: 'id', reason: 'Cannot delete the primary tenant' },
    });
    const deploymentDefault = await run(
      adminTenantDeleteHandler,
      {},
      { DEFAULT_TENANT_ID: 'home' },
      { id: 'home' }
    );
    expect(deploymentDefault.status).toBe(409);
    expect(deploymentDefault.body).toEqual({
      error: 'default_tenant_protected',
      error_description: 'The deployment default tenant cannot be deleted',
    });
    expect(adapter.calls).toHaveLength(0);
  });

  it('answers 404 for a missing tenant', async () => {
    setup(null);
    const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'gone' });
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({ variables: { resource: 'tenant' } });
    expect(stepUp.gate).not.toHaveBeenCalled();
  });

  it('refuses the tenant flagged as default and tenants in internal states', async () => {
    setup(rowFor({ is_default: 1 }));
    const flagged = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
    expect(flagged.body.details).toEqual({
      variables: { field: 'id', reason: 'Cannot delete the default tenant' },
    });
    for (const state of ['provisioning', 'deleting', 'deleted', 'restore_pending']) {
      const adapter = setup(rowFor({ lifecycle_state: state }));
      const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
      expect(result.status).toBe(400);
      expect(result.body.details).toEqual({
        variables: {
          field: 'lifecycle_state',
          reason: 'Lifecycle state requires a dedicated operation',
        },
      });
      expect(adapter.batch).not.toHaveBeenCalled();
    }
    for (const state of ['active', 'suspended', 'frozen', 'migration_read_only']) {
      setup(rowFor({ lifecycle_state: state }));
      expect((await run(adminTenantDeleteHandler, {}, {}, { id: 'second' })).status).toBe(202);
    }
  });

  it('returns the step-up refusal and queues nothing', async () => {
    stepUp.gate.mockResolvedValue(new Response('{"error":"step_up_required"}', { status: 401 }));
    const adapter = setup();
    const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(401);
    expect(stepUp.gate).toHaveBeenCalledWith(expect.anything(), {
      operation: 'tenant.delete',
      targetTenantId: 'second',
      targetIds: ['second'],
    });
    expect(adapter.batch).not.toHaveBeenCalled();
  });

  it('queues the deletion, answers 202 with the job and drops the tenant from the cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const adapter = setup();
      const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
      expect(result.status).toBe(202);
      expect(result.body).toEqual({
        job_id: expect.any(String),
        status: 'pending',
        estimated_completion: 1767225600 + 3600,
      });
      const [statements] = adapter.batch.mock.calls[0] as unknown as [
        Array<{ sql: string; params: unknown[] }>,
      ];
      expect(statements[0].sql).toContain("SET lifecycle_state = 'deleting'");
      expect(statements[0].sql).toContain(
        "IN ('active', 'suspended', 'frozen', 'migration_read_only')"
      );
      expect(statements[0].params.slice(0, 2)).toEqual([1767225600, 'second']);
      expect(statements[1].params.slice(0, 6)).toEqual([
        result.body.job_id,
        'default',
        'tenants/delete',
        'pending',
        '{"stage":"queued"}',
        '{"tenant_id":"second","marker_aware":true}',
      ]);
      expect(statements[1].params.slice(6, 11)).toEqual([
        'platform-admin',
        1767225600,
        1767225600,
        1767225600 + 3600,
        'second',
      ]);
      expect(deleteTenantExistsCache).toHaveBeenCalledWith(expect.anything(), 'second');
      expect(putTenantExistsCache).not.toHaveBeenCalled();
      expect(createAuditLogFromContext).toHaveBeenCalledWith(
        expect.anything(),
        'tenant.delete_queued',
        'tenant',
        'second',
        expect.objectContaining({ tenant_id: 'second', job_id: result.body.job_id })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 409 when the guarded update matched no row, queueing nothing', async () => {
    setup(rowFor(), [{ rowsAffected: 0 }, { rowsAffected: 0 }]);
    const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_state_changed',
      error_description:
        'The tenant became the default, changed state, or already has a deletion queued; deletion was not started',
    });
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
    expect(deleteTenantExistsCache).not.toHaveBeenCalled();
  });

  it('answers 500 when the job row was not inserted although the tenant moved', async () => {
    setup(rowFor(), [{ rowsAffected: 1 }, { rowsAffected: 0 }]);
    const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(500);
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
    setup(rowFor(), [{ rowsAffected: 2 }, { rowsAffected: 1 }]);
    expect((await run(adminTenantDeleteHandler, {}, {}, { id: 'second' })).status).toBe(409);
  });

  it('answers 500 when the database fails, and is refused for a scoped administrator', async () => {
    adapters.defaultAdapter = createAdapter(() => {
      throw new Error('db down');
    });
    expect((await run(adminTenantDeleteHandler, {}, {}, { id: 'second' })).status).toBe(500);
    setup();
    expect(
      (await run(adminTenantDeleteHandler, {}, {}, { id: 'second' }, TENANT_ADMIN)).status
    ).toBe(403);
  });
});

describe('tenant handlers: route wiring', () => {
  it('requires the tenant id path parameter', async () => {
    adapters.defaultAdapter = createAdapter(() => null);
    await expect(run(adminTenantGetHandler, {}, {}, {})).rejects.toThrow(
      'tenant_path_parameter_missing:id'
    );
    await expect(run(adminTenantDeleteHandler, {}, {}, {})).rejects.toThrow(
      'tenant_path_parameter_missing:id'
    );
  });

  it('refuses reading a tenant to a scoped administrator', async () => {
    adapters.defaultAdapter = createAdapter(() => createTenantRow('second'));
    const result = await run(adminTenantGetHandler, {}, {}, { id: 'second' }, TENANT_ADMIN);
    expect(result.status).toBe(403);
    expect(adapters.defaultAdapter.calls).toHaveLength(0);
  });

  it('stops a delete at the single-tenant guard before reading the tenant', async () => {
    adapters.defaultAdapter = createAdapter(() => null);
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(new Response('{"e":1}', { status: 409 }));
    const result = await run(adminTenantDeleteHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(409);
    expect(adapters.defaultAdapter.calls).toHaveLength(0);
    expect(stepUp.gate).not.toHaveBeenCalled();
  });

  it('hands the deletion cancel route to the cancel service with the same context', async () => {
    const c = createContext({}, {}, { id: 'second' });
    const response = await adminTenantDeletionCancelHandler(c as never);
    expect(response.status).toBe(202);
    expect(cancelTenantDeletion).toHaveBeenCalledWith(c);
  });
});

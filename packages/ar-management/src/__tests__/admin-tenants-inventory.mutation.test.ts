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

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import {
  adminTenantGetHandler,
  adminTenantUpdateHandler,
  adminTenantsListHandler,
} from '../admin-tenants';
import {} from '../tenant-deletion-cancel';
import { ensureSupportedTenantId, isSingleTenantMode } from '../single-tenant-guard';
import {
  adapters,
  createAdapter,
  createContext,
  createTenantRow,
  type MockAdapter,
  type QueryOp,
} from './helpers/admin-tenants-mutation-harness';
import { must } from './helpers/must';

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

const writes = (adapter: MockAdapter | null, op: QueryOp = 'execute') =>
  (adapter?.calls ?? []).filter((call) => call.op === op);

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

describe('tenant list', () => {
  it('lists every tenant for a platform administrator, default first', async () => {
    const rows = [
      createTenantRow('main', { is_default: 1, name: 'Main' }),
      createTenantRow('second', {
        name: 'Second',
        description: 'about',
        isolation_policy: 'shared_pool',
      }),
    ];
    adapters.defaultAdapter = createAdapter(() => rows);
    const result = await run(adminTenantsListHandler);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      tenants: [
        {
          id: 'main',
          tenant_code: 'main',
          name: 'Main',
          description: null,
          isolation_policy: 'tenant_exclusive',
          lifecycle_state: 'active',
          is_default: true,
          created_at: 1,
          updated_at: 1,
        },
        {
          id: 'second',
          tenant_code: 'second',
          name: 'Second',
          description: 'about',
          isolation_policy: 'shared_pool',
          lifecycle_state: 'active',
          is_default: false,
          created_at: 1,
          updated_at: 1,
        },
      ],
      total: 2,
      single_tenant_mode: false,
      single_tenant_reason: null,
    });
    expect(adapters.defaultAdapter.calls[0]).toEqual({
      op: 'query',
      sql: `${TENANT_COLUMNS} ORDER BY is_default DESC, name ASC`,
      params: [],
    });
  });

  it('limits a scoped administrator to the tenants of the token with one JSON parameter', async () => {
    adapters.defaultAdapter = createAdapter(() => []);
    const result = await run(adminTenantsListHandler, {}, {}, {}, TENANT_ADMIN);
    expect(result.status).toBe(200);
    expect(adapters.defaultAdapter.calls[0].sql).toBe(
      `${TENANT_COLUMNS} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY is_default DESC, name ASC`
    );
    expect(adapters.defaultAdapter.calls[0].params).toEqual(['["tenant-a","tenant-b"]']);
  });

  it('adds the tenant of the administrator itself to the scope', async () => {
    adapters.defaultAdapter = createAdapter(() => []);
    await run(
      adminTenantsListHandler,
      {},
      {},
      {},
      { ...TENANT_ADMIN, tenantScope: ['*x'], tenantId: 'home' }
    );
    expect(adapters.defaultAdapter.calls[0].params).toEqual(['["*x","home"]']);
  });

  it('refuses an administrator with no tenant scope at all', async () => {
    adapters.defaultAdapter = createAdapter(() => []);
    const result = await run(
      adminTenantsListHandler,
      {},
      {},
      {},
      {
        ...TENANT_ADMIN,
        tenantScope: [],
      }
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'admin_insufficient_permissions',
      details: {
        variables: {
          required_scope: 'tenant',
          reason: 'No tenant inventory scope is available for this administrator',
        },
      },
    });
    expect(adapters.defaultAdapter.calls).toHaveLength(0);
  });

  it('shows only the single tenant, and says why, in single-tenant mode', async () => {
    vi.mocked(isSingleTenantMode).mockReturnValue(true);
    adapters.defaultAdapter = createAdapter(() => [createTenantRow('default')]);
    const result = await run(adminTenantsListHandler);
    expect(result.body.single_tenant_mode).toBe(true);
    expect(result.body.single_tenant_reason).toBe(
      'API custom domain is not configured. This deployment runs in single-tenant mode.'
    );
    expect(adapters.defaultAdapter.calls[0].sql).toBe(
      `${TENANT_COLUMNS} WHERE id = ? ORDER BY is_default DESC, name ASC`
    );
    expect(adapters.defaultAdapter.calls[0].params).toEqual(['default']);
  });

  it('answers 500 when the inventory cannot be read', async () => {
    adapters.defaultAdapter = createAdapter(() => {
      throw new Error('db down');
    });
    const result = await run(adminTenantsListHandler);
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('internal_error');
  });
});

describe('tenant get', () => {
  it('stops at the single-tenant guard before reading', async () => {
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(
      new Response('{"error":"unsupported"}', { status: 404 })
    );
    adapters.defaultAdapter = createAdapter(() => null);
    const result = await run(adminTenantGetHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'unsupported' });
    expect(adapters.defaultAdapter.calls).toHaveLength(0);
  });

  it('reads the tenant by id and answers 500 when the read fails', async () => {
    adapters.defaultAdapter = createAdapter(() => createTenantRow('second', { name: 'Second' }));
    const found = await run(adminTenantGetHandler, {}, {}, { id: 'second' });
    expect(found.body).toMatchObject({ id: 'second', name: 'Second', is_default: false });
    expect(adapters.defaultAdapter.calls[0]).toEqual({
      op: 'queryOne',
      sql: `${TENANT_COLUMNS} WHERE id = ?`,
      params: ['second'],
    });
    adapters.defaultAdapter = createAdapter(() => {
      throw new Error('db down');
    });
    expect((await run(adminTenantGetHandler, {}, {}, { id: 'second' })).status).toBe(500);
  });

  it('answers 404 with the resource name for a missing tenant', async () => {
    adapters.defaultAdapter = createAdapter(() => null);
    const result = await run(adminTenantGetHandler, {}, {}, { id: 'gone' });
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({ variables: { resource: 'tenant' } });
  });
});

describe('tenant update', () => {
  const existing = createTenantRow('second', { name: 'Old', description: 'old', updated_at: 5 });

  function setup(overrides: { collision?: boolean; updated?: unknown } = {}) {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('tenant_code = ? AND id != ?')) {
        return overrides.collision ? { id: 'other' } : null;
      }
      if (op === 'queryOne' && sql === `${TENANT_COLUMNS} WHERE id = ?`) {
        const reads = must(adapters.defaultAdapter).calls.filter(
          (call) => call.op === 'queryOne' && call.sql === `${TENANT_COLUMNS} WHERE id = ?`
        ).length;
        if (reads === 1) return existing;
        return 'updated' in overrides ? overrides.updated : { ...existing, name: 'New' };
      }
      return { rowsAffected: 1 };
    });
    return adapters.defaultAdapter;
  }

  it('answers 404 for a missing tenant and writes nothing', async () => {
    adapters.defaultAdapter = createAdapter(() => null);
    const result = await run(adminTenantUpdateHandler, { name: 'x' }, {}, { id: 'gone' });
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({ variables: { resource: 'tenant' } });
    expect(writes(adapters.defaultAdapter)).toHaveLength(0);
  });

  it('refuses an unknown key, an empty name and a malformed code with the body field', async () => {
    for (const body of [
      { id: 'x' },
      { name: '' },
      { tenant_code: 'Bad_Code' },
      { name: 'n'.repeat(201) },
    ]) {
      const adapter = setup();
      const result = await run(adminTenantUpdateHandler, body, {}, { id: 'second' });
      expect(result.status).toBe(400);
      expect(result.body.details.variables.field).toBe('body');
      expect(result.body.details.variables.reason).toEqual(expect.any(String));
      expect(writes(adapter)).toHaveLength(0);
    }
  });

  it('refuses the reserved tenant code', async () => {
    setup();
    const result = await run(
      adminTenantUpdateHandler,
      { tenant_code: 'platform' },
      {},
      { id: 'second' }
    );
    expect(result.status).toBe(400);
    expect(result.body.details.variables.reason).toBe('tenant_code is reserved');
  });

  it('updates name, code and description in that order, with the time and id last', async () => {
    const adapter = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const result = await run(
        adminTenantUpdateHandler,
        { description: 'new text', tenant_code: 'new-code', name: 'New' },
        {},
        { id: 'second' }
      );
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ id: 'second', name: 'New' });
      expect(writes(adapter)).toEqual([
        {
          op: 'execute',
          sql: 'UPDATE tenants SET name = ?, tenant_code = ?, description = ?, updated_at = ? WHERE id = ?',
          params: ['New', 'new-code', 'new text', 1767225600, 'second'],
        },
      ]);
      expect(
        writes(adapter, 'queryOne').find((call) => call.sql.includes('tenant_code = ?'))?.params
      ).toEqual(['new-code', 'second']);
      expect(createAuditLogFromContext).toHaveBeenCalledWith(
        expect.anything(),
        'tenant.updated',
        'tenant',
        'second',
        { changes: { description: 'new text', tenant_code: 'new-code', name: 'New' } }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores a null description when it is cleared', async () => {
    const adapter = setup();
    await run(adminTenantUpdateHandler, { description: null }, {}, { id: 'second' });
    expect(writes(adapter)[0].sql).toBe(
      'UPDATE tenants SET description = ?, updated_at = ? WHERE id = ?'
    );
    expect(writes(adapter)[0].params[0]).toBeNull();
  });

  it('refuses a tenant code another tenant already uses', async () => {
    const adapter = setup({ collision: true });
    const result = await run(
      adminTenantUpdateHandler,
      { tenant_code: 'taken' },
      {},
      { id: 'second' }
    );
    expect(result.status).toBe(400);
    expect(result.body.details).toEqual({
      variables: { field: 'tenant_code', reason: 'Tenant code already exists' },
    });
    expect(writes(adapter)).toHaveLength(0);
  });

  it('answers the unchanged tenant, writing and auditing nothing, when no field is given', async () => {
    const adapter = setup();
    const result = await run(adminTenantUpdateHandler, {}, {}, { id: 'second' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 'second', name: 'Old', description: 'old' });
    expect(writes(adapter)).toHaveLength(0);
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
  });

  it('answers 500 when the updated tenant cannot be read back, after auditing the change', async () => {
    setup({ updated: null });
    const result = await run(adminTenantUpdateHandler, { name: 'New' }, {}, { id: 'second' });
    expect(result.status).toBe(500);
    expect(createAuditLogFromContext).toHaveBeenCalled();
  });

  it('is refused for a tenant administrator and by the single-tenant guard', async () => {
    const adapter = setup();
    const denied = await run(
      adminTenantUpdateHandler,
      { name: 'x' },
      {},
      { id: 'second' },
      TENANT_ADMIN
    );
    expect(denied.status).toBe(403);
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(
      new Response('{"error":"unsupported"}', { status: 409 })
    );
    const blocked = await run(adminTenantUpdateHandler, { name: 'x' }, {}, { id: 'second' });
    expect(blocked.status).toBe(409);
    expect(writes(adapter)).toHaveLength(0);
  });

  it('answers 500 when the database fails', async () => {
    adapters.defaultAdapter = createAdapter(() => {
      throw new Error('db down');
    });
    expect((await run(adminTenantUpdateHandler, { name: 'x' }, {}, { id: 'second' })).status).toBe(
      500
    );
  });
});

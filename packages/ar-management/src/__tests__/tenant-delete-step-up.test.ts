import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';

/**
 * Deleting a tenant keeps its admin step-up when a machine principal does it on the deletion
 * permission: the permission opens the route, and only the exact-name step-up exemption lets a
 * machine past the gate. This runs the real handler and the real step-up gate; only the tenant
 * inventory adapter and the audit writer are replaced.
 */
const state = vi.hoisted(() => ({
  executed: [] as string[],
  // What the tenant inventory answers for the tenant row (the cancel tests make it `suspended`).
  tenantState: 'active',
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const adapter = {
    queryOne: async (sql: string) => {
      if (sql.includes('FROM tenants')) {
        return { id: 'second', is_default: 0, lifecycle_state: state.tenantState, updated_at: 100 };
      }
      // The deletion-cancel reads: no active deletion; the latest one failed; no route row.
      if (sql.includes('WHERE EXISTS')) return null;
      return null;
    },
    query: async (sql: string) =>
      sql.includes('FROM admin_jobs')
        ? [
            {
              id: 'job-failed',
              status: 'failed',
              config: '{"tenant_id":"second"}',
              progress: null,
              error_message: null,
              created_at: 1,
            },
          ]
        : [],
    execute: async (sql: string) => {
      state.executed.push(sql);
      return { rowsAffected: 1 };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string }>) =>
      statements.map((statement) => {
        state.executed.push(statement.sql);
        // The cancel's lease takeover matches nothing (no stale mark); every other statement one row.
        return {
          success: true,
          rowsAffected: statement.sql.includes('SET progress = ?, updated_at = ?') ? 0 : 1,
        };
      }),
  } as unknown as DatabaseAdapter;
  return {
    ...actual,
    createD1Adapter: () => adapter,
    requireDedicatedAdminDatabaseAdapter: () => adapter,
    createAuditLogFromContext: async () => {},
  };
});
vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditLog: async () => 'audit-1',
}));

import { adminTenantDeleteHandler, adminTenantDeletionCancelHandler } from '../admin-tenants';

const DELETE = 'admin:tenants:delete';
const EXEMPT = 'admin:step_up_exempt:tenant.delete';

function machine(permissions: string[], scope = ['*']): AdminAuthContext {
  return {
    userId: 'machine-9',
    actorId: 'machine-9',
    actorType: 'machine',
    authMethod: 'machine_access_token',
    roles: [],
    tenantScope: scope,
    permissions,
    globalPermissions: scope.includes('*') ? permissions : [],
  };
}

async function run(auth: AdminAuthContext, extraEnv: Record<string, string> = {}) {
  state.executed = [];
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.delete('/api/admin/tenants/:id', async (c) => {
    c.set('adminAuth', auth);
    c.set('tenantId' as never, 'default' as never);
    return adminTenantDeleteHandler(c as never);
  });
  const response = await app.request(
    '/api/admin/tenants/second',
    { method: 'DELETE' },
    { BASE_DOMAIN: 'op.example.com', ...extraEnv }
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe('tenant deletion by a machine principal', () => {
  it('is refused by the step-up gate without the exact-name exemption, and nothing is changed', async () => {
    const result = await run(machine([DELETE]));
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('step_up_human_required');
    expect(state.executed).toEqual([]);
  });

  it('is refused by the step-up gate with a wildcard alone: no wildcard carries the exemption', async () => {
    for (const permissions of [['*'], ['admin:*'], [DELETE, 'admin:step_up_exempt:*']]) {
      const result = await run(machine(permissions));
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('step_up_human_required');
    }
    expect(state.executed).toEqual([]);
  });

  it('is accepted with the deletion permission and the exemption, and queues the job', async () => {
    const result = await run(machine([DELETE, EXEMPT]));
    expect(result.status).toBe(202);
    expect(state.executed.some((sql) => sql.includes('INSERT INTO admin_jobs'))).toBe(true);
  });

  it('is refused before the step-up when the machine lacks the deletion permission', async () => {
    const result = await run(machine([EXEMPT]));
    expect(result.status).toBe(403);
    expect(result.body.error).not.toBe('step_up_human_required');
    expect(state.executed).toEqual([]);
  });

  it('is refused for a machine limited to some tenants, exemption or not', async () => {
    const result = await run(machine([DELETE, EXEMPT], ['tenant-a']));
    expect(result.status).toBe(403);
    expect(state.executed).toEqual([]);
  });

  it('needs only the deletion permission where the platform switched admin step-up off', async () => {
    // Deliberate: the shared gate lets a machine through while `security.admin_step_up_enforced`
    // is false, before it looks at the exemption. A platform that counts on the exemption as a
    // second barrier has to keep step-up enforced (the default).
    const result = await run(machine([DELETE]), { ADMIN_STEP_UP_ENFORCED: 'false' });
    expect(result.status).toBe(202);
    expect(state.executed.some((sql) => sql.includes('INSERT INTO admin_jobs'))).toBe(true);

    // The switch does not open the route: the deletion permission is still required.
    const refused = await run(machine([]), { ADMIN_STEP_UP_ENFORCED: 'false' });
    expect(refused.status).toBe(403);
  });
});

describe('cancelling a failed tenant deletion by a machine principal', () => {
  async function runCancel(auth: AdminAuthContext, extraEnv: Record<string, string> = {}) {
    state.executed = [];
    state.tenantState = 'suspended';
    const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
    app.post('/api/admin/tenants/:id/deletion/cancel', async (c) => {
      c.set('adminAuth', auth);
      c.set('tenantId' as never, 'default' as never);
      return adminTenantDeletionCancelHandler(c as never);
    });
    const response = await app.request(
      '/api/admin/tenants/second/deletion/cancel',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'operator abandoned the deletion' }),
      },
      { BASE_DOMAIN: 'op.example.com', ...extraEnv }
    );
    state.tenantState = 'active';
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }

  it('is refused by the step-up gate without the exact-name exemption, and nothing is changed', async () => {
    const result = await runCancel(machine([DELETE]));
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('step_up_human_required');
    expect(state.executed).toEqual([]);
  });

  it('is refused with a wildcard alone: no wildcard carries the exemption', async () => {
    for (const permissions of [['*'], ['admin:*'], [DELETE, 'admin:step_up_exempt:*']]) {
      const result = await runCancel(machine(permissions));
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('step_up_human_required');
    }
    expect(state.executed).toEqual([]);
  });

  it('is accepted with the deletion permission and the exemption, and marks the job', async () => {
    const result = await runCancel(machine([DELETE, EXEMPT]));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ cancelled_job_id: 'job-failed', route_reactivated: false });
    expect(state.executed.some((sql) => sql.includes('UPDATE admin_jobs'))).toBe(true);
  });

  it('is refused before the step-up when the machine lacks the deletion permission or is tenant-limited', async () => {
    for (const auth of [machine([EXEMPT]), machine([DELETE, EXEMPT], ['tenant-a'])]) {
      const result = await runCancel(auth);
      expect(result.status).toBe(403);
      expect(result.body.error).not.toBe('step_up_human_required');
    }
    expect(state.executed).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ error: vi.fn() })),
    })),
  };
});

import { adminAccessControlStatsHandler } from '../admin-access-control-stats';

function context() {
  return {
    env: {},
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status })),
  } as never;
}

describe('adminAccessControlStatsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('role_assignments')) return { count: 2 };
      if (sql.includes('FROM roles')) return { count: 1 };
      if (sql.includes('user_verified_attributes') && sql.includes('expires_at'))
        return { count: 3 };
      if (sql.includes('user_verified_attributes')) return { count: 4 };
      if (sql.includes('relation_definitions')) return { count: 5 };
      if (sql.includes('relationships')) return { count: 6 };
      if (sql.includes('policy_rules') && sql.includes('enabled = 1')) return { count: 7 };
      if (sql.includes('policy_rules')) return { count: 8 };
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it('queries the current RBAC, ABAC, ReBAC, and policy schemas', async () => {
    const response = await adminAccessControlStatsHandler(context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rbac: { total_roles: 1, total_assignments: 2 },
      abac: { total_attributes: 4, active_attributes: 3 },
      rebac: { total_definitions: 5, total_tuples: 6 },
      policies: { total_policies: 8, active_policies: 7 },
    });
    const sql = mocks.adapter.queryOne.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).not.toMatch(/\buser_roles\b|\buser_attributes\b|rebac_|FROM policies\b/);
  });
});

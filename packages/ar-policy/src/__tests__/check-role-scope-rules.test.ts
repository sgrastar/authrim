import { describe, expect, it, vi } from 'vitest';
import { createUnifiedCheckService, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { createTenantRuleEvaluator, toTenantPolicyRule } from '../tenant-policy';

const rule = (id: string, effect: 'allow' | 'deny', priority: number, conditions: unknown[]) =>
  toTenantPolicyRule({
    id,
    name: id,
    description: null,
    priority,
    effect,
    resource_types: JSON.stringify(['reports']),
    actions: JSON.stringify(['read']),
    conditions: JSON.stringify(conditions),
  })!;

/**
 * The subject's one assignment, of `auditor` on report r1 (`resource:reports:r1`), read as the
 * Check API reads it: the assignment, then the role it names.
 */
function database(): DatabaseAdapter {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM role_assignments')) {
        return [
          {
            id: 'ra_1',
            role_id: 'role_auditor',
            scope_type: 'resource',
            scope_target: 'resource:reports:r1',
            expires_at: null,
          },
        ];
      }
      if (sql.includes('FROM roles')) {
        return [{ id: 'role_auditor', name: 'auditor', permissions_json: '[]' }];
      }
      return [];
    }),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(),
    getType: () => 'mock',
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('Check API role scopes and tenant rules', () => {
  it('denies by a resource-scoped role on its resource, and only there', async () => {
    const evaluator = createTenantRuleEvaluator([
      rule('deny_auditors', 'deny', 1000, [
        { type: 'has_role', params: { role: 'auditor', scope: 'resource' } },
      ]),
      rule('allow_all', 'allow', 100, []),
    ]);
    const service = createUnifiedCheckService({
      db: database(),
      tenantPolicy: async () => ({
        abac: true,
        verifiedAttributes: false,
        logDecisions: false,
        evaluator,
      }),
    });
    const check = (permission: string) =>
      service.check({ subject_id: 'user_1', permission, tenant_id: 'tenant_a' });

    expect((await check('reports:r1:read')).allowed).toBe(false);
    expect((await check('reports:r2:read')).allowed).toBe(true);
  });
});

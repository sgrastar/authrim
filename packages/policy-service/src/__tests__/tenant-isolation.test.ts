/**
 * Multi-tenant Isolation Tests
 *
 * Security-critical tests for tenant data isolation:
 * - Data isolation between tenants
 * - Role assignments are tenant-scoped
 * - Cache isolation per tenant
 * - Cross-tenant access prevention
 *
 * Tenant isolation is enforced at multiple levels:
 * 1. Database queries include tenant_id in WHERE clause
 * 2. ReBAC checks include tenant_id
 * 3. Cache keys include tenant_id to prevent leakage
 *
 * @see packages/shared/src/services/unified-check-service.ts
 * @see packages/shared/src/rebac/rebac-service.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUnifiedCheckService, UnifiedCheckService } from '@authrim/shared';
import type { CheckApiRequest } from '@authrim/shared';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

/**
 * Create mock D1 database with tenant-specific role assignments
 */
function createTenantAwareD1(
  roleAssignments: Map<string, Map<string, string[]>> // tenant_id -> (subject_id -> permissions[])
): D1Database {
  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => {
        // Capture the bound parameters for tenant_id checking
        const boundParams = args;
        return {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockImplementation(() => {
            // Extract subject_id (first param) and tenant_id (second param)
            const subjectId = boundParams[0] as string;
            const tenantId = boundParams[1] as string;

            const tenantRoles = roleAssignments.get(tenantId);
            if (!tenantRoles) {
              return Promise.resolve({ results: [] });
            }

            const permissions = tenantRoles.get(subjectId);
            if (!permissions) {
              return Promise.resolve({ results: [] });
            }

            return Promise.resolve({
              results: [
                {
                  name: 'user_role',
                  permissions_json: JSON.stringify(permissions),
                },
              ],
            });
          }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        };
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
  } as unknown as D1Database;
}

/**
 * Create mock KV namespace that tracks cache operations
 */
function createMockKV(): KVNamespace & { _cache: Map<string, string> } {
  const cache = new Map<string, string>();
  return {
    _cache: cache,
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(cache.get(key) ?? null)),
    put: vi.fn().mockImplementation((key: string, value: string) => {
      cache.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      cache.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace & { _cache: Map<string, string> };
}

describe('Multi-tenant Isolation Tests', () => {
  let mockD1: D1Database;
  let mockKV: KVNamespace & { _cache: Map<string, string> };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Data Isolation Between Tenants', () => {
    it('should not allow access to permissions from another tenant', async () => {
      // Setup: user_1 has 'docs:read' permission in tenant_a, but NOT in tenant_b
      const roleAssignments = new Map([
        ['tenant_a', new Map([['user_1', ['docs:read']]])],
        // tenant_b has no permissions for user_1
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Check in tenant_a - should be allowed
      const resultA = await service.check({
        subject_id: 'user_1',
        permission: 'docs:read',
        tenant_id: 'tenant_a',
      });
      expect(resultA.allowed).toBe(true);

      // Check in tenant_b - should be denied (no cross-tenant access)
      const resultB = await service.check({
        subject_id: 'user_1',
        permission: 'docs:read',
        tenant_id: 'tenant_b',
      });
      expect(resultB.allowed).toBe(false);
    });

    it('should isolate permissions between multiple tenants', async () => {
      // Setup: Different permissions per tenant
      const roleAssignments = new Map([
        ['tenant_a', new Map([['user_1', ['docs:read', 'docs:write']]])],
        ['tenant_b', new Map([['user_1', ['docs:read']]])], // No write permission
        ['tenant_c', new Map<string, string[]>()], // No permissions
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // tenant_a: user can read and write
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'tenant_a',
          })
        ).allowed
      ).toBe(true);
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:write',
            tenant_id: 'tenant_a',
          })
        ).allowed
      ).toBe(true);

      // tenant_b: user can read but NOT write
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'tenant_b',
          })
        ).allowed
      ).toBe(true);
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:write',
            tenant_id: 'tenant_b',
          })
        ).allowed
      ).toBe(false);

      // tenant_c: user has no permissions
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'tenant_c',
          })
        ).allowed
      ).toBe(false);
    });

    it('should isolate different users in same tenant', async () => {
      const roleAssignments = new Map([
        [
          'tenant_a',
          new Map([
            ['user_admin', ['*:*']],
            ['user_editor', ['docs:read', 'docs:write']],
            ['user_viewer', ['docs:read']],
          ]),
        ],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Admin can delete
      expect(
        (
          await service.check({
            subject_id: 'user_admin',
            permission: 'docs:delete',
            tenant_id: 'tenant_a',
          })
        ).allowed
      ).toBe(true);

      // Editor cannot delete
      expect(
        (
          await service.check({
            subject_id: 'user_editor',
            permission: 'docs:delete',
            tenant_id: 'tenant_a',
          })
        ).allowed
      ).toBe(false);

      // Viewer can only read
      expect(
        (
          await service.check({
            subject_id: 'user_viewer',
            permission: 'docs:write',
            tenant_id: 'tenant_a',
          })
        ).allowed
      ).toBe(false);
    });
  });

  describe('Cross-tenant Access Prevention', () => {
    it('should deny access with wrong tenant_id', async () => {
      const roleAssignments = new Map([
        ['correct_tenant', new Map([['user_1', ['secret:access']]])],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Correct tenant - allowed
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'secret:access',
            tenant_id: 'correct_tenant',
          })
        ).allowed
      ).toBe(true);

      // Wrong tenant - denied
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'secret:access',
            tenant_id: 'wrong_tenant',
          })
        ).allowed
      ).toBe(false);

      // Similar tenant name (typo) - denied
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'secret:access',
            tenant_id: 'correct_tenan', // Missing 't'
          })
        ).allowed
      ).toBe(false);
    });

    it('should not leak permissions across tenant boundaries in batch', async () => {
      const roleAssignments = new Map([
        ['tenant_a', new Map([['user_1', ['docs:read']]])],
        ['tenant_b', new Map<string, string[]>()],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      const result = await service.batchCheck({
        checks: [
          { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'tenant_a' },
          { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'tenant_b' },
          { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'tenant_a' },
        ],
      });

      expect(result.results[0].allowed).toBe(true); // tenant_a - allowed
      expect(result.results[1].allowed).toBe(false); // tenant_b - denied
      expect(result.results[2].allowed).toBe(true); // tenant_a - allowed
    });
  });

  describe('Default Tenant Handling', () => {
    it('should use "default" tenant when tenant_id is not specified', async () => {
      const roleAssignments = new Map([
        ['default', new Map([['user_1', ['docs:read']]])],
        ['other', new Map<string, string[]>()],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // No tenant_id specified - should use 'default'
      const result = await service.check({
        subject_id: 'user_1',
        permission: 'docs:read',
        // tenant_id not specified
      } as CheckApiRequest);

      expect(result.allowed).toBe(true);
    });

    it('should not confuse default tenant with other tenants', async () => {
      const roleAssignments = new Map([
        ['default', new Map([['user_1', ['default:perm']]])],
        ['tenant_a', new Map([['user_1', ['tenant_a:perm']]])],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Default tenant permission
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'default:perm',
            tenant_id: 'default',
          })
        ).allowed
      ).toBe(true);

      // Trying to access default permission from tenant_a
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'default:perm',
            tenant_id: 'tenant_a',
          })
        ).allowed
      ).toBe(false);
    });
  });

  describe('Tenant ID Edge Cases', () => {
    it('should handle tenant_id with special characters correctly', async () => {
      const roleAssignments = new Map([
        ['tenant-with-dashes', new Map([['user_1', ['docs:read']]])],
        ['tenant_with_underscores', new Map([['user_1', ['docs:read']]])],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'tenant-with-dashes',
          })
        ).allowed
      ).toBe(true);

      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'tenant_with_underscores',
          })
        ).allowed
      ).toBe(true);
    });

    it('should handle empty string tenant_id as different from default', async () => {
      const roleAssignments = new Map([
        ['default', new Map([['user_1', ['docs:read']]])],
        ['', new Map<string, string[]>()],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Empty string tenant should NOT match 'default'
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: '',
          })
        ).allowed
      ).toBe(false);
    });

    it('should treat tenant_id as case-sensitive', async () => {
      const roleAssignments = new Map([['TenantA', new Map([['user_1', ['docs:read']]])]]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Exact match - allowed
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'TenantA',
          })
        ).allowed
      ).toBe(true);

      // Wrong case - denied
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'tenanta',
          })
        ).allowed
      ).toBe(false);

      // Wrong case - denied
      expect(
        (
          await service.check({
            subject_id: 'user_1',
            permission: 'docs:read',
            tenant_id: 'TENANTA',
          })
        ).allowed
      ).toBe(false);
    });
  });

  describe('Multiple Subjects Same Tenant', () => {
    it('should correctly handle different subjects in same tenant', async () => {
      const roleAssignments = new Map([
        [
          'shared_tenant',
          new Map([
            ['alice', ['docs:read', 'docs:write']],
            ['bob', ['docs:read']],
            ['charlie', ['billing:view']],
          ]),
        ],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Alice can write
      expect(
        (
          await service.check({
            subject_id: 'alice',
            permission: 'docs:write',
            tenant_id: 'shared_tenant',
          })
        ).allowed
      ).toBe(true);

      // Bob cannot write
      expect(
        (
          await service.check({
            subject_id: 'bob',
            permission: 'docs:write',
            tenant_id: 'shared_tenant',
          })
        ).allowed
      ).toBe(false);

      // Charlie has different permissions entirely
      expect(
        (
          await service.check({
            subject_id: 'charlie',
            permission: 'billing:view',
            tenant_id: 'shared_tenant',
          })
        ).allowed
      ).toBe(true);
      expect(
        (
          await service.check({
            subject_id: 'charlie',
            permission: 'docs:read',
            tenant_id: 'shared_tenant',
          })
        ).allowed
      ).toBe(false);
    });
  });

  describe('Same Subject Different Tenants', () => {
    it('should correctly isolate same subject_id across tenants', async () => {
      // Same user_id can have completely different permissions in different tenants
      const roleAssignments = new Map([
        ['company_a', new Map([['user@example.com', ['admin:*']]])],
        ['company_b', new Map([['user@example.com', ['viewer:read']]])],
        ['company_c', new Map<string, string[]>()], // No permissions
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      // Same user is admin in company_a
      expect(
        (
          await service.check({
            subject_id: 'user@example.com',
            permission: 'admin:delete',
            tenant_id: 'company_a',
          })
        ).allowed
      ).toBe(true);

      // Same user is only viewer in company_b
      expect(
        (
          await service.check({
            subject_id: 'user@example.com',
            permission: 'admin:delete',
            tenant_id: 'company_b',
          })
        ).allowed
      ).toBe(false);

      // Same user has no access in company_c
      expect(
        (
          await service.check({
            subject_id: 'user@example.com',
            permission: 'viewer:read',
            tenant_id: 'company_c',
          })
        ).allowed
      ).toBe(false);
    });
  });

  describe('Batch Check with Multiple Tenants', () => {
    it('should correctly process batch with checks from different tenants', async () => {
      const roleAssignments = new Map([
        ['tenant_1', new Map([['user_a', ['resource_1:action']]])],
        ['tenant_2', new Map([['user_b', ['resource_2:action']]])],
        ['tenant_3', new Map([['user_a', ['resource_3:action']]])],
      ]);
      mockD1 = createTenantAwareD1(roleAssignments);
      const service = createUnifiedCheckService({ db: mockD1 });

      const result = await service.batchCheck({
        checks: [
          { subject_id: 'user_a', permission: 'resource_1:action', tenant_id: 'tenant_1' },
          { subject_id: 'user_b', permission: 'resource_2:action', tenant_id: 'tenant_2' },
          { subject_id: 'user_a', permission: 'resource_3:action', tenant_id: 'tenant_3' },
          { subject_id: 'user_a', permission: 'resource_2:action', tenant_id: 'tenant_2' }, // user_a in wrong tenant
        ],
      });

      expect(result.results).toHaveLength(4);
      expect(result.results[0].allowed).toBe(true); // user_a in tenant_1 - correct
      expect(result.results[1].allowed).toBe(true); // user_b in tenant_2 - correct
      expect(result.results[2].allowed).toBe(true); // user_a in tenant_3 - correct
      expect(result.results[3].allowed).toBe(false); // user_a in tenant_2 - wrong tenant
    });
  });
});

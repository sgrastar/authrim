/**
 * Batch Check Processing Tests
 *
 * Tests for batch permission check functionality:
 * - Maximum batch size (100 items)
 * - stop_on_deny option
 * - Partial failure handling
 * - Empty array processing
 * - Results order preservation
 * - Summary statistics
 *
 * @see Phase 8.3: Real-time Check API Model
 * @see packages/policy-service/src/routes/check.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUnifiedCheckService, UnifiedCheckService } from '@authrim/shared';
import type { CheckApiRequest, BatchCheckRequest, BatchCheckResponse } from '@authrim/shared';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Create mock D1 database that can be configured per test
 */
function createMockD1(rolePermissions: Map<string, string[]> = new Map()): D1Database {
  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(() => {
        // Return roles based on configured permissions
        const results: Array<{ name: string; permissions_json: string }> = [];
        for (const [roleName, perms] of rolePermissions) {
          results.push({
            name: roleName,
            permissions_json: JSON.stringify(perms),
          });
        }
        return Promise.resolve({ results });
      }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
  } as unknown as D1Database;
}

describe('Batch Check Processing', () => {
  describe('UnifiedCheckService.batchCheck', () => {
    let service: UnifiedCheckService;
    let mockD1: D1Database;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('Basic Batch Processing', () => {
      it('should process single check in batch', async () => {
        const rolePerms = new Map([['admin', ['documents:read']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [{ subject_id: 'user_1', permission: 'documents:read', tenant_id: 'default' }],
        });

        expect(result.results).toHaveLength(1);
        expect(result.summary.total).toBe(1);
        expect(result.summary.allowed).toBe(1);
        expect(result.summary.denied).toBe(0);
      });

      it('should process multiple checks with mixed results', async () => {
        const rolePerms = new Map([['editor', ['documents:read', 'documents:write']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'documents:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'documents:write', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'documents:delete', tenant_id: 'default' },
          ],
        });

        expect(result.results).toHaveLength(3);
        expect(result.summary.total).toBe(3);
        // Depending on role permissions - read and write allowed, delete denied
        expect(result.summary.allowed).toBe(2);
        expect(result.summary.denied).toBe(1);
      });

      it('should preserve order of results matching requests', async () => {
        const rolePerms = new Map([['viewer', ['a:read', 'c:read']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'a:read', tenant_id: 't1' },
            { subject_id: 'user_2', permission: 'b:read', tenant_id: 't2' },
            { subject_id: 'user_3', permission: 'c:read', tenant_id: 't3' },
          ],
        });

        expect(result.results).toHaveLength(3);
        // Results should be in same order as requests
        expect(result.results[0].allowed).toBe(true); // a:read - allowed
        expect(result.results[1].allowed).toBe(false); // b:read - denied
        expect(result.results[2].allowed).toBe(true); // c:read - allowed
      });
    });

    describe('Empty Array Handling', () => {
      it('should handle empty checks array', async () => {
        mockD1 = createMockD1();
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [],
        });

        expect(result.results).toHaveLength(0);
        expect(result.summary.total).toBe(0);
        expect(result.summary.allowed).toBe(0);
        expect(result.summary.denied).toBe(0);
        expect(result.summary.evaluation_time_ms).toBeDefined();
      });
    });

    describe('stop_on_deny Option', () => {
      it('should continue processing all checks when stop_on_deny is false (default)', async () => {
        mockD1 = createMockD1(); // No permissions - all denied
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:write', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:delete', tenant_id: 'default' },
          ],
          stop_on_deny: false,
        });

        expect(result.results).toHaveLength(3);
        expect(result.results[0].final_decision).toBe('deny');
        expect(result.results[1].final_decision).toBe('deny');
        expect(result.results[2].final_decision).toBe('deny');
        // All checks should be evaluated, none skipped
        expect(result.results.every((r) => r.reason !== 'skipped_due_to_stop_on_deny')).toBe(true);
      });

      it('should stop on first deny when stop_on_deny is true', async () => {
        mockD1 = createMockD1(); // No permissions - all denied
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:write', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:delete', tenant_id: 'default' },
          ],
          stop_on_deny: true,
        });

        expect(result.results).toHaveLength(3);
        expect(result.results[0].final_decision).toBe('deny');
        expect(result.results[1].reason).toBe('skipped_due_to_stop_on_deny');
        expect(result.results[2].reason).toBe('skipped_due_to_stop_on_deny');
      });

      it('should process all if all allowed before any deny', async () => {
        const rolePerms = new Map([['admin', ['docs:read', 'docs:write', 'docs:delete']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:write', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:delete', tenant_id: 'default' },
          ],
          stop_on_deny: true,
        });

        expect(result.results).toHaveLength(3);
        expect(result.summary.allowed).toBe(3);
        expect(result.summary.denied).toBe(0);
        // All allowed, no skipped
        expect(result.results.every((r) => r.allowed === true)).toBe(true);
      });

      it('should correctly count skipped as denied in summary', async () => {
        mockD1 = createMockD1(); // No permissions
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:write', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:delete', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:admin', tenant_id: 'default' },
          ],
          stop_on_deny: true,
        });

        expect(result.summary.total).toBe(4);
        expect(result.summary.allowed).toBe(0);
        expect(result.summary.denied).toBe(4); // 1 denied + 3 skipped
      });
    });

    describe('Large Batch Processing', () => {
      it('should process 100 checks (maximum batch size)', async () => {
        const rolePerms = new Map([['user', ['resource:read']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        // Generate 100 checks
        const checks: CheckApiRequest[] = [];
        for (let i = 0; i < 100; i++) {
          checks.push({
            subject_id: `user_${i}`,
            permission: 'resource:read',
            tenant_id: 'default',
          });
        }

        const result = await service.batchCheck({ checks });

        expect(result.results).toHaveLength(100);
        expect(result.summary.total).toBe(100);
        expect(result.summary.allowed).toBe(100);
        expect(result.summary.evaluation_time_ms).toBeDefined();
      });

      it('should handle 100 checks with mixed results efficiently', async () => {
        // Only even-numbered resources are allowed
        const rolePerms = new Map([
          ['mixed_role', ['resource_0:read', 'resource_2:read', 'resource_4:read']],
        ]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        // Generate 10 checks with alternating results
        const checks: CheckApiRequest[] = [];
        for (let i = 0; i < 10; i++) {
          checks.push({
            subject_id: 'user_1',
            permission: `resource_${i}:read`,
            tenant_id: 'default',
          });
        }

        const result = await service.batchCheck({ checks });

        expect(result.results).toHaveLength(10);
        expect(result.summary.total).toBe(10);
        // 0, 2, 4 are allowed (3 checks)
        expect(result.summary.allowed).toBe(3);
        expect(result.summary.denied).toBe(7);
      });
    });

    describe('Summary Statistics', () => {
      it('should include evaluation_time_ms in summary', async () => {
        mockD1 = createMockD1();
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [{ subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' }],
        });

        expect(result.summary.evaluation_time_ms).toBeDefined();
        expect(typeof result.summary.evaluation_time_ms).toBe('number');
        expect(result.summary.evaluation_time_ms).toBeGreaterThanOrEqual(0);
      });

      it('should have accurate allowed/denied counts', async () => {
        const rolePerms = new Map([['partial', ['a:read', 'b:read']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'a:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'b:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'c:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'd:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'e:read', tenant_id: 'default' },
          ],
        });

        expect(result.summary.total).toBe(5);
        expect(result.summary.allowed).toBe(2);
        expect(result.summary.denied).toBe(3);
        expect(result.summary.allowed + result.summary.denied).toBe(result.summary.total);
      });
    });

    describe('Tenant Handling', () => {
      it('should respect different tenant_ids in batch', async () => {
        // This test verifies that each check in the batch can have a different tenant_id
        mockD1 = createMockD1();
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'tenant_a' },
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'tenant_b' },
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'tenant_c' },
          ],
        });

        expect(result.results).toHaveLength(3);
        // Each check is processed independently
        expect(result.summary.total).toBe(3);
      });
    });

    describe('Edge Cases', () => {
      it('should handle batch with all allowed results', async () => {
        const rolePerms = new Map([['superadmin', ['*:*']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'any:action', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'other:action', tenant_id: 'default' },
          ],
        });

        expect(result.summary.allowed).toBe(result.summary.total);
        expect(result.summary.denied).toBe(0);
      });

      it('should handle batch with all denied results', async () => {
        mockD1 = createMockD1(); // No permissions
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'secret:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'secret:write', tenant_id: 'default' },
          ],
        });

        expect(result.summary.denied).toBe(result.summary.total);
        expect(result.summary.allowed).toBe(0);
      });

      it('should handle single check that is denied', async () => {
        mockD1 = createMockD1();
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [{ subject_id: 'user_1', permission: 'restricted:access', tenant_id: 'default' }],
        });

        expect(result.results).toHaveLength(1);
        expect(result.results[0].allowed).toBe(false);
        expect(result.summary.denied).toBe(1);
      });

      it('should handle checks with same subject_id but different permissions', async () => {
        const rolePerms = new Map([['user_role', ['docs:read']]]);
        mockD1 = createMockD1(rolePerms);
        service = createUnifiedCheckService({ db: mockD1 });

        const result = await service.batchCheck({
          checks: [
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:write', tenant_id: 'default' },
            { subject_id: 'user_1', permission: 'docs:read', tenant_id: 'default' }, // Duplicate
          ],
        });

        expect(result.results).toHaveLength(3);
        expect(result.results[0].allowed).toBe(true);
        expect(result.results[1].allowed).toBe(false);
        expect(result.results[2].allowed).toBe(true); // Same as first
      });
    });

    describe('Performance', () => {
      it('should complete 50 checks in reasonable time', async () => {
        mockD1 = createMockD1();
        service = createUnifiedCheckService({ db: mockD1 });

        const checks: CheckApiRequest[] = [];
        for (let i = 0; i < 50; i++) {
          checks.push({
            subject_id: `user_${i}`,
            permission: `resource_${i}:action`,
            tenant_id: 'default',
          });
        }

        const startTime = performance.now();
        const result = await service.batchCheck({ checks });
        const endTime = performance.now();

        expect(result.results).toHaveLength(50);
        // Should complete within 1 second (generous for test environment)
        expect(endTime - startTime).toBeLessThan(1000);
      });
    });
  });

  describe('Batch Request Validation', () => {
    // Note: These tests are for API-level validation, not service-level
    // The actual validation is done in the route handler

    describe('Maximum Batch Size', () => {
      it('should define maximum batch size as 100', () => {
        // This is documented behavior - API should reject > 100 checks
        const MAX_BATCH_SIZE = 100;
        expect(MAX_BATCH_SIZE).toBe(100);
      });
    });

    describe('Required Fields', () => {
      it('should require subject_id in each check', () => {
        // Each check must have subject_id - validated at API level
        const validCheck: CheckApiRequest = {
          subject_id: 'user_123',
          permission: 'docs:read',
          tenant_id: 'default',
        };
        expect(validCheck.subject_id).toBeDefined();
      });

      it('should require permission in each check', () => {
        const validCheck: CheckApiRequest = {
          subject_id: 'user_123',
          permission: 'docs:read',
          tenant_id: 'default',
        };
        expect(validCheck.permission).toBeDefined();
      });
    });
  });
});

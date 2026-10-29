/**
 * AdminPolicyRepository Unit Tests
 *
 * Tests Admin Policy repository operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AdminPolicyRepository,
  type AdminPolicyCreateInput,
  type AdminPolicyConditions,
} from '../admin/admin-policy';
import { MockDatabaseAdapter } from './mock-adapter';

// =============================================================================
// Test Setup
// =============================================================================

let adapter: MockDatabaseAdapter;
let repo: AdminPolicyRepository;

beforeEach(() => {
  adapter = new MockDatabaseAdapter();
  adapter.initTable('admin_policies');
  repo = new AdminPolicyRepository(adapter);
});

// =============================================================================
// Test Data
// =============================================================================

const TEST_TENANT = 'default';

const allowPolicy: Record<string, unknown> = {
  id: 'policy-allow-users',
  tenant_id: TEST_TENANT,
  name: 'allow_user_read',
  display_name: 'Allow User Read',
  description: 'Allows reading user data',
  effect: 'allow',
  priority: 10,
  resource_pattern: 'admin:users:*',
  actions_json: JSON.stringify(['read', 'list']),
  conditions_json: JSON.stringify({
    roles: ['viewer', 'admin'],
    condition_type: 'any',
  }),
  is_active: 1,
  is_system: 0,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const denyPolicy: Record<string, unknown> = {
  id: 'policy-deny-delete',
  tenant_id: TEST_TENANT,
  name: 'deny_user_delete',
  display_name: 'Deny User Delete',
  description: 'Denies deleting users',
  effect: 'deny',
  priority: 100,
  resource_pattern: 'admin:users:*',
  actions_json: JSON.stringify(['delete']),
  conditions_json: JSON.stringify({
    attributes: {
      department: { not_equals: 'engineering' },
    },
  }),
  is_active: 1,
  is_system: 0,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const systemPolicy: Record<string, unknown> = {
  id: 'policy-system-super',
  tenant_id: TEST_TENANT,
  name: 'super_admin_full_access',
  display_name: 'Super Admin Full Access',
  description: 'Super admin has full access',
  effect: 'allow',
  priority: 1000,
  resource_pattern: '*',
  actions_json: JSON.stringify(['*']),
  conditions_json: JSON.stringify({
    roles: ['ar_super_admin'],
  }),
  is_active: 1,
  is_system: 1,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const inactivePolicy: Record<string, unknown> = {
  id: 'policy-inactive',
  tenant_id: TEST_TENANT,
  name: 'inactive_policy',
  display_name: 'Inactive Policy',
  description: 'This policy is inactive',
  effect: 'allow',
  priority: 5,
  resource_pattern: 'admin:test:*',
  actions_json: JSON.stringify(['*']),
  conditions_json: JSON.stringify({}),
  is_active: 0,
  is_system: 0,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

// =============================================================================
// Tests
// =============================================================================

describe('AdminPolicyRepository', () => {
  describe('createPolicy', () => {
    it('should create a new policy with default values', async () => {
      const input: AdminPolicyCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'test_policy',
        resource_pattern: 'admin:users:read',
      };

      const policy = await repo.createPolicy(input);

      expect(policy.name).toBe('test_policy');
      expect(policy.tenant_id).toBe(TEST_TENANT);
      expect(policy.resource_pattern).toBe('admin:users:read');
      expect(policy.effect).toBe('allow');
      expect(policy.priority).toBe(0);
      expect(policy.actions).toEqual(['*']);
      expect(policy.conditions).toEqual({});
      expect(policy.is_active).toBe(true);
      expect(policy.is_system).toBe(false);
      expect(policy.id).toBeTruthy();
    });

    it('should create policy with all options', async () => {
      const conditions: AdminPolicyConditions = {
        roles: ['admin', 'manager'],
        attributes: {
          department: { equals: 'engineering' },
          clearance_level: { gte: 3 },
        },
        condition_type: 'all',
      };

      const input: AdminPolicyCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'complex_policy',
        display_name: 'Complex Policy',
        description: 'A complex policy with conditions',
        effect: 'deny',
        priority: 50,
        resource_pattern: 'admin:users:*',
        actions: ['delete', 'modify'],
        conditions,
      };

      const policy = await repo.createPolicy(input);

      expect(policy.name).toBe('complex_policy');
      expect(policy.display_name).toBe('Complex Policy');
      expect(policy.description).toBe('A complex policy with conditions');
      expect(policy.effect).toBe('deny');
      expect(policy.priority).toBe(50);
      expect(policy.actions).toEqual(['delete', 'modify']);
      expect(policy.conditions).toEqual(conditions);
    });
  });

  describe('getPolicy', () => {
    it('should get policy by ID', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const policy = await repo.getPolicy('policy-allow-users');

      expect(policy).not.toBeNull();
      expect(policy!.id).toBe('policy-allow-users');
      expect(policy!.name).toBe('allow_user_read');
    });

    it('should return null for non-existent policy', async () => {
      const policy = await repo.getPolicy('non-existent');

      expect(policy).toBeNull();
    });
  });

  describe('getPolicyByName', () => {
    it('should get policy by name', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const policy = await repo.getPolicyByName(TEST_TENANT, 'allow_user_read');

      expect(policy).not.toBeNull();
      expect(policy!.id).toBe('policy-allow-users');
    });

    it('should return null if not found', async () => {
      const policy = await repo.getPolicyByName(TEST_TENANT, 'non_existent');

      expect(policy).toBeNull();
    });

    it('should respect tenant isolation', async () => {
      const otherTenantPolicy = { ...allowPolicy, tenant_id: 'other-tenant' };
      adapter.seed('admin_policies', [otherTenantPolicy]);

      const policy = await repo.getPolicyByName(TEST_TENANT, 'allow_user_read');

      expect(policy).toBeNull();
    });
  });

  describe('listPolicies', () => {
    it('should list all policies for tenant', async () => {
      adapter.seed('admin_policies', [allowPolicy, denyPolicy, systemPolicy]);

      const result = await repo.listPolicies(TEST_TENANT);

      expect(result.total).toBe(3);
      expect(result.policies.length).toBe(3);
      // Should be ordered by priority DESC
      expect(result.policies[0].priority).toBe(1000);
      expect(result.policies[1].priority).toBe(100);
      expect(result.policies[2].priority).toBe(10);
    });

    it('should filter by activeOnly', async () => {
      adapter.seed('admin_policies', [allowPolicy, inactivePolicy]);

      const result = await repo.listPolicies(TEST_TENANT, { activeOnly: true });

      expect(result.total).toBe(1);
      expect(result.policies.length).toBe(1);
      expect(result.policies[0].id).toBe('policy-allow-users');
    });

    it('should filter by resourcePattern', async () => {
      adapter.seed('admin_policies', [allowPolicy, denyPolicy]);

      const result = await repo.listPolicies(TEST_TENANT, {
        resourcePattern: 'admin:users',
      });

      expect(result.total).toBe(2);
      expect(result.policies.length).toBe(2);
    });

    it('should support pagination', async () => {
      adapter.seed('admin_policies', [allowPolicy, denyPolicy, systemPolicy]);

      const result = await repo.listPolicies(TEST_TENANT, {
        limit: 2,
        offset: 1,
      });

      expect(result.total).toBe(3);
      expect(result.policies.length).toBe(2);
    });

    it('should return empty for empty tenant', async () => {
      const result = await repo.listPolicies('empty-tenant');

      expect(result.total).toBe(0);
      expect(result.policies).toEqual([]);
    });
  });

  describe('getPoliciesForResource', () => {
    it('should match wildcard pattern', async () => {
      adapter.seed('admin_policies', [systemPolicy]);

      const policies = await repo.getPoliciesForResource(TEST_TENANT, 'admin:users:read', 'read');

      expect(policies.length).toBe(1);
      expect(policies[0].resource_pattern).toBe('*');
    });

    it('should match specific resource pattern', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const policies = await repo.getPoliciesForResource(TEST_TENANT, 'admin:users:123', 'read');

      expect(policies.length).toBe(1);
      expect(policies[0].id).toBe('policy-allow-users');
    });

    it('should filter by action', async () => {
      adapter.seed('admin_policies', [allowPolicy, denyPolicy]);

      const policies = await repo.getPoliciesForResource(TEST_TENANT, 'admin:users:123', 'delete');

      expect(policies.length).toBe(1);
      expect(policies[0].id).toBe('policy-deny-delete');
    });

    it('should match wildcard action', async () => {
      adapter.seed('admin_policies', [systemPolicy]);

      const policies = await repo.getPoliciesForResource(
        TEST_TENANT,
        'admin:users:123',
        'any_action'
      );

      expect(policies.length).toBe(1);
    });

    it('should return empty if no match', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const policies = await repo.getPoliciesForResource(TEST_TENANT, 'admin:clients:read', 'read');

      expect(policies).toEqual([]);
    });

    it('should ignore inactive policies', async () => {
      adapter.seed('admin_policies', [inactivePolicy]);

      const policies = await repo.getPoliciesForResource(TEST_TENANT, 'admin:test:read', 'read');

      expect(policies).toEqual([]);
    });

    it('should order by priority DESC', async () => {
      adapter.seed('admin_policies', [allowPolicy, denyPolicy, systemPolicy]);

      const policies = await repo.getPoliciesForResource(TEST_TENANT, 'admin:users:123', 'read');

      expect(policies.length).toBeGreaterThan(0);
      // Should be ordered by priority
      if (policies.length > 1) {
        expect(policies[0].priority).toBeGreaterThanOrEqual(policies[1].priority);
      }
    });
  });

  describe('updatePolicy', () => {
    it('should update policy properties', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const updates = {
        display_name: 'Updated Name',
        description: 'Updated description',
        priority: 20,
        actions: ['read', 'list', 'search'],
      };

      const updated = await repo.updatePolicy('policy-allow-users', updates);

      expect(updated).not.toBeNull();
      expect(updated!.display_name).toBe('Updated Name');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.priority).toBe(20);
      expect(updated!.actions).toEqual(['read', 'list', 'search']);
    });

    it('should not update system policy', async () => {
      adapter.seed('admin_policies', [systemPolicy]);

      const updated = await repo.updatePolicy('policy-system-super', {
        display_name: 'Hacked',
      });

      expect(updated).toBeNull();
    });

    it('should return null for non-existent policy', async () => {
      const updated = await repo.updatePolicy('non-existent', {
        display_name: 'Test',
      });

      expect(updated).toBeNull();
    });
  });

  describe('setActive', () => {
    it('should activate inactive policy', async () => {
      adapter.seed('admin_policies', [inactivePolicy]);

      const success = await repo.setActive('policy-inactive', true);

      expect(success).toBe(true);
      const policy = await repo.getPolicy('policy-inactive');
      expect(policy!.is_active).toBe(true);
    });

    it('should deactivate active policy', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const success = await repo.setActive('policy-allow-users', false);

      expect(success).toBe(true);
      const policy = await repo.getPolicy('policy-allow-users');
      expect(policy!.is_active).toBe(false);
    });

    it('should not modify system policy', async () => {
      adapter.seed('admin_policies', [systemPolicy]);

      const success = await repo.setActive('policy-system-super', false);

      expect(success).toBe(false);
    });

    it('should return false for non-existent policy', async () => {
      const success = await repo.setActive('non-existent', true);

      expect(success).toBe(false);
    });
  });

  describe('deletePolicy', () => {
    it('should delete custom policy', async () => {
      adapter.seed('admin_policies', [allowPolicy]);

      const deleted = await repo.deletePolicy('policy-allow-users');

      expect(deleted).toBe(true);
      const policy = await repo.getPolicy('policy-allow-users');
      expect(policy).toBeNull();
    });

    it('should not delete system policy', async () => {
      adapter.seed('admin_policies', [systemPolicy]);

      const deleted = await repo.deletePolicy('policy-system-super');

      expect(deleted).toBe(false);
      const policy = await repo.getPolicy('policy-system-super');
      expect(policy).not.toBeNull();
    });

    it('should return false for non-existent policy', async () => {
      const deleted = await repo.deletePolicy('non-existent');

      expect(deleted).toBe(false);
    });
  });

  describe('conditions handling', () => {
    it('should serialize and deserialize RBAC conditions', async () => {
      const conditions: AdminPolicyConditions = {
        roles: ['admin', 'manager', 'viewer'],
      };

      const input: AdminPolicyCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'rbac_policy',
        resource_pattern: 'admin:users:*',
        conditions,
      };

      const policy = await repo.createPolicy(input);

      expect(policy.conditions.roles).toEqual(['admin', 'manager', 'viewer']);
    });

    it('should serialize and deserialize ABAC conditions', async () => {
      const conditions: AdminPolicyConditions = {
        attributes: {
          department: { equals: 'engineering' },
          clearance_level: { gte: 3, lte: 10 },
          location: { in: ['US', 'CA', 'UK'] },
        },
      };

      const input: AdminPolicyCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'abac_policy',
        resource_pattern: 'admin:users:*',
        conditions,
      };

      const policy = await repo.createPolicy(input);

      expect(policy.conditions.attributes).toEqual(conditions.attributes);
    });

    it('should serialize and deserialize ReBAC conditions', async () => {
      const conditions: AdminPolicyConditions = {
        relationships: {
          supervises: {
            target_type: 'admin_user',
            permission_level: 'manager',
          },
        },
      };

      const input: AdminPolicyCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'rebac_policy',
        resource_pattern: 'admin:users:*',
        conditions,
      };

      const policy = await repo.createPolicy(input);

      expect(policy.conditions.relationships).toEqual(conditions.relationships);
    });

    it('should handle complex combined conditions', async () => {
      const conditions: AdminPolicyConditions = {
        roles: ['admin'],
        attributes: {
          department: { equals: 'security' },
        },
        relationships: {
          team_member: { target_type: 'team' },
        },
        condition_type: 'all',
      };

      const input: AdminPolicyCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'combined_policy',
        resource_pattern: 'admin:sensitive:*',
        conditions,
      };

      const policy = await repo.createPolicy(input);

      expect(policy.conditions).toEqual(conditions);
    });
  });
});

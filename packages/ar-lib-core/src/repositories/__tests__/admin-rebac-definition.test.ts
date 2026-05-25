/**
 * AdminRebacDefinitionRepository Unit Tests
 *
 * Tests Admin ReBAC Definition repository operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AdminRebacDefinitionRepository,
  type AdminRebacDefinitionCreateInput,
  type AdminRebacDefinitionUpdateInput,
} from '../admin/admin-rebac-definition';
import { MockDatabaseAdapter } from './mock-adapter';

// =============================================================================
// Test Setup
// =============================================================================

let adapter: MockDatabaseAdapter;
let repo: AdminRebacDefinitionRepository;

beforeEach(() => {
  adapter = new MockDatabaseAdapter();
  adapter.initTable('admin_rebac_definitions');
  repo = new AdminRebacDefinitionRepository(adapter);
});

// =============================================================================
// Test Data
// =============================================================================

const TEST_TENANT = 'default';

const systemDefinition: Record<string, unknown> = {
  id: 'def-system-owner',
  tenant_id: TEST_TENANT,
  relation_name: 'system_owner',
  display_name: 'System Owner',
  description: 'Owns a system resource',
  priority: 100,
  is_system: 1,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const customDefinition: Record<string, unknown> = {
  id: 'def-custom-supervises',
  tenant_id: TEST_TENANT,
  relation_name: 'admin_supervises',
  display_name: 'Supervises',
  description: 'Admin user supervises another admin user',
  priority: 50,
  is_system: 0,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const teamMemberDefinition: Record<string, unknown> = {
  id: 'def-team-member',
  tenant_id: TEST_TENANT,
  relation_name: 'team_member',
  display_name: 'Team Member',
  description: 'Member of a team',
  priority: 10,
  is_system: 0,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

// =============================================================================
// Tests
// =============================================================================

describe('AdminRebacDefinitionRepository', () => {
  describe('createDefinition', () => {
    it('should create a new definition with defaults', async () => {
      const input: AdminRebacDefinitionCreateInput = {
        tenant_id: TEST_TENANT,
        relation_name: 'admin_reports_to',
      };

      const definition = await repo.createDefinition(input);

      expect(definition.relation_name).toBe('admin_reports_to');
      expect(definition.tenant_id).toBe(TEST_TENANT);
      expect(definition.display_name).toBeNull();
      expect(definition.description).toBeNull();
      expect(definition.priority).toBe(0);
      expect(definition.is_system).toBe(false);
      expect(definition.id).toBeTruthy();
      expect(definition.created_at).toBeTruthy();
      expect(definition.updated_at).toBeTruthy();
    });

    it('should create definition with all properties', async () => {
      const input: AdminRebacDefinitionCreateInput = {
        tenant_id: TEST_TENANT,
        relation_name: 'admin_supervises',
        display_name: 'Supervises',
        description: 'Admin user supervises another admin user',
        priority: 50,
      };

      const definition = await repo.createDefinition(input);

      expect(definition.relation_name).toBe('admin_supervises');
      expect(definition.display_name).toBe('Supervises');
      expect(definition.description).toBe('Admin user supervises another admin user');
      expect(definition.priority).toBe(50);
    });

    it('should reject missing tenant_id', async () => {
      const input: AdminRebacDefinitionCreateInput = {
        relation_name: 'test_relation',
      };

      await expect(repo.createDefinition(input)).rejects.toThrow(
        'Repository create requires tenantId'
      );
    });
  });

  describe('getDefinition', () => {
    it('should get definition by ID', async () => {
      adapter.seed('admin_rebac_definitions', [customDefinition]);

      const definition = await repo.getDefinition('def-custom-supervises');

      expect(definition).not.toBeNull();
      expect(definition!.id).toBe('def-custom-supervises');
      expect(definition!.relation_name).toBe('admin_supervises');
    });

    it('should return null for non-existent definition', async () => {
      const definition = await repo.getDefinition('non-existent');

      expect(definition).toBeNull();
    });
  });

  describe('getDefinitionByName', () => {
    it('should get definition by relation name', async () => {
      adapter.seed('admin_rebac_definitions', [customDefinition]);

      const definition = await repo.getDefinitionByName(TEST_TENANT, 'admin_supervises');

      expect(definition).not.toBeNull();
      expect(definition!.id).toBe('def-custom-supervises');
    });

    it('should return null if not found', async () => {
      const definition = await repo.getDefinitionByName(TEST_TENANT, 'non_existent');

      expect(definition).toBeNull();
    });

    it('should respect tenant isolation', async () => {
      const otherTenantDef = { ...customDefinition, tenant_id: 'other-tenant' };
      adapter.seed('admin_rebac_definitions', [otherTenantDef]);

      const definition = await repo.getDefinitionByName(TEST_TENANT, 'admin_supervises');

      expect(definition).toBeNull();
    });
  });

  describe('listDefinitions', () => {
    it('should list all definitions for tenant', async () => {
      adapter.seed('admin_rebac_definitions', [customDefinition, teamMemberDefinition]);

      const definitions = await repo.listDefinitions(TEST_TENANT);

      expect(definitions.length).toBe(2);
      // Should be ordered by priority DESC, relation_name ASC
      expect(definitions[0].priority).toBe(50);
      expect(definitions[1].priority).toBe(10);
    });

    it('should include system definitions when includeSystem is true', async () => {
      adapter.seed('admin_rebac_definitions', [systemDefinition, customDefinition]);

      const definitions = await repo.listDefinitions(TEST_TENANT, { includeSystem: true });

      expect(definitions.length).toBe(2);
      expect(definitions.some((d) => d.is_system)).toBe(true);
    });

    it('should exclude system definitions by default', async () => {
      adapter.seed('admin_rebac_definitions', [systemDefinition, customDefinition]);

      const definitions = await repo.listDefinitions(TEST_TENANT);

      expect(definitions.length).toBe(1);
      expect(definitions[0].is_system).toBe(false);
    });

    it('should support pagination', async () => {
      adapter.seed('admin_rebac_definitions', [
        systemDefinition,
        customDefinition,
        teamMemberDefinition,
      ]);

      const definitions = await repo.listDefinitions(TEST_TENANT, {
        includeSystem: true,
        limit: 2,
        offset: 1,
      });

      expect(definitions.length).toBe(2);
    });

    it('should return empty array for empty tenant', async () => {
      const definitions = await repo.listDefinitions('empty-tenant');

      expect(definitions).toEqual([]);
    });

    it('should order by priority DESC then relation_name ASC', async () => {
      const def1 = { ...customDefinition, id: 'def-1', relation_name: 'b_relation', priority: 50 };
      const def2 = { ...customDefinition, id: 'def-2', relation_name: 'a_relation', priority: 50 };
      const def3 = { ...customDefinition, id: 'def-3', relation_name: 'c_relation', priority: 10 };

      adapter.seed('admin_rebac_definitions', [def1, def2, def3]);

      const definitions = await repo.listDefinitions(TEST_TENANT);

      expect(definitions.length).toBe(3);
      // Same priority, so alphabetical by relation_name
      expect(definitions[0].relation_name).toBe('a_relation');
      expect(definitions[1].relation_name).toBe('b_relation');
      // Lower priority comes last
      expect(definitions[2].relation_name).toBe('c_relation');
    });
  });

  describe('updateDefinition', () => {
    it('should update definition properties', async () => {
      adapter.seed('admin_rebac_definitions', [customDefinition]);

      const update: AdminRebacDefinitionUpdateInput = {
        display_name: 'Updated Supervises',
        description: 'Updated description',
        priority: 60,
      };

      const updated = await repo.updateDefinition('def-custom-supervises', update);

      expect(updated).not.toBeNull();
      expect(updated!.display_name).toBe('Updated Supervises');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.priority).toBe(60);
    });

    it('should prevent updating system definitions', async () => {
      adapter.seed('admin_rebac_definitions', [systemDefinition]);

      const update: AdminRebacDefinitionUpdateInput = {
        display_name: 'Hacked',
      };

      await expect(repo.updateDefinition('def-system-owner', update)).rejects.toThrow(
        'Cannot update system ReBAC definition'
      );
    });

    it('should return null for non-existent definition', async () => {
      const update: AdminRebacDefinitionUpdateInput = {
        display_name: 'Test',
      };

      const updated = await repo.updateDefinition('non-existent', update);

      expect(updated).toBeNull();
    });

    it('should return existing definition if no updates provided', async () => {
      adapter.seed('admin_rebac_definitions', [customDefinition]);

      const updated = await repo.updateDefinition('def-custom-supervises', {});

      expect(updated).not.toBeNull();
      expect(updated!.id).toBe('def-custom-supervises');
    });
  });

  describe('deleteDefinition', () => {
    it('should delete custom definition', async () => {
      adapter.seed('admin_rebac_definitions', [customDefinition]);

      const deleted = await repo.deleteDefinition('def-custom-supervises');

      expect(deleted).toBe(true);
      const definition = await repo.getDefinition('def-custom-supervises');
      expect(definition).toBeNull();
    });

    it('should prevent deleting system definitions', async () => {
      adapter.seed('admin_rebac_definitions', [systemDefinition]);

      await expect(repo.deleteDefinition('def-system-owner')).rejects.toThrow(
        'Cannot delete system ReBAC definition'
      );
    });

    it('should return false for non-existent definition', async () => {
      const deleted = await repo.deleteDefinition('non-existent');

      expect(deleted).toBe(false);
    });
  });

  describe('relation_name uniqueness', () => {
    it('should allow same relation_name in different tenants', async () => {
      const input1: AdminRebacDefinitionCreateInput = {
        tenant_id: 'tenant-1',
        relation_name: 'admin_supervises',
      };

      const input2: AdminRebacDefinitionCreateInput = {
        tenant_id: 'tenant-2',
        relation_name: 'admin_supervises',
      };

      const def1 = await repo.createDefinition(input1);
      const def2 = await repo.createDefinition(input2);

      expect(def1.relation_name).toBe('admin_supervises');
      expect(def2.relation_name).toBe('admin_supervises');
      expect(def1.tenant_id).not.toBe(def2.tenant_id);
    });
  });

  describe('priority handling', () => {
    it('should handle negative priority', async () => {
      const input: AdminRebacDefinitionCreateInput = {
        tenant_id: TEST_TENANT,
        relation_name: 'low_priority_relation',
        priority: -10,
      };

      const definition = await repo.createDefinition(input);

      expect(definition.priority).toBe(-10);
    });

    it('should handle large priority values', async () => {
      const input: AdminRebacDefinitionCreateInput = {
        tenant_id: TEST_TENANT,
        relation_name: 'high_priority_relation',
        priority: 9999,
      };

      const definition = await repo.createDefinition(input);

      expect(definition.priority).toBe(9999);
    });
  });
});

/**
 * AdminRoleRepository Unit Tests
 *
 * Tests Admin Role repository operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AdminRoleRepository } from '../admin/admin-role';
import { MockDatabaseAdapter } from './mock-adapter';
import type { AdminRoleCreateInput, AdminRoleUpdateInput } from '../../types/admin-user';

// =============================================================================
// Test Setup
// =============================================================================

let adapter: MockDatabaseAdapter;
let repo: AdminRoleRepository;

beforeEach(() => {
  adapter = new MockDatabaseAdapter();
  adapter.initTable('admin_roles');
  repo = new AdminRoleRepository(adapter);
});

// =============================================================================
// Test Data
// =============================================================================

const TEST_TENANT = 'default';

const systemRole: Record<string, unknown> = {
  id: 'role-system-super',
  tenant_id: TEST_TENANT,
  name: 'super_admin',
  display_name: 'Super Administrator',
  description: 'Full system access',
  permissions_json: JSON.stringify(['*']),
  hierarchy_level: 100,
  role_type: 'system',
  is_system: 1,
  inherits_from: null,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const builtinRole: Record<string, unknown> = {
  id: 'role-builtin-viewer',
  tenant_id: TEST_TENANT,
  name: 'viewer',
  display_name: 'Viewer',
  description: 'Read-only access',
  permissions_json: JSON.stringify(['admin:admin_users:read', 'admin:admin_roles:read']),
  hierarchy_level: 10,
  role_type: 'builtin',
  is_system: 0,
  inherits_from: null,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

const customRole: Record<string, unknown> = {
  id: 'role-custom-security',
  tenant_id: TEST_TENANT,
  name: 'security_admin',
  display_name: 'Security Administrator',
  description: 'Manages security settings',
  permissions_json: JSON.stringify(['admin:admin_audit:read', 'admin:ip_allowlist:write']),
  hierarchy_level: 50,
  role_type: 'custom',
  is_system: 0,
  inherits_from: null,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
};

// =============================================================================
// Tests
// =============================================================================

describe('AdminRoleRepository', () => {
  describe('createRole', () => {
    it('should create a new custom role', async () => {
      const input: AdminRoleCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'billing_admin',
        display_name: 'Billing Administrator',
        description: 'Manages billing',
        permissions: ['admin:users:read', 'admin:users:write'],
        hierarchy_level: 30,
        role_type: 'custom',
      };

      const role = await repo.createRole(input);

      expect(role.name).toBe('billing_admin');
      expect(role.display_name).toBe('Billing Administrator');
      expect(role.description).toBe('Manages billing');
      expect(role.permissions).toEqual(['admin:users:read', 'admin:users:write']);
      expect(role.hierarchy_level).toBe(30);
      expect(role.role_type).toBe('custom');
      expect(role.is_system).toBe(false);
      expect(role.id).toBeTruthy();
      expect(role.created_at).toBeTruthy();
      expect(role.updated_at).toBeTruthy();
    });

    it('should create role with inheritance', async () => {
      adapter.seed('admin_roles', [builtinRole]);

      const input: AdminRoleCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'extended_viewer',
        display_name: 'Extended Viewer',
        permissions: ['admin:audit:read'],
        inherits_from: 'role-builtin-viewer',
      };

      const role = await repo.createRole(input);

      expect(role.inherits_from).toBe('role-builtin-viewer');
    });

    it('should default to custom role_type and hierarchy_level 0', async () => {
      const input: AdminRoleCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'basic_role',
        permissions: ['admin:users:read'],
      };

      const role = await repo.createRole(input);

      expect(role.role_type).toBe('custom');
      expect(role.hierarchy_level).toBe(0);
      expect(role.is_system).toBe(false);
    });
  });

  describe('updateRole', () => {
    it('should update custom role properties', async () => {
      adapter.seed('admin_roles', [customRole]);

      const update: AdminRoleUpdateInput = {
        display_name: 'Security Manager',
        description: 'Updated description',
        permissions: ['admin:admin_audit:read', 'admin:security:write'],
        hierarchy_level: 60,
      };

      const updated = await repo.updateRole('role-custom-security', update);

      expect(updated).not.toBeNull();
      expect(updated!.display_name).toBe('Security Manager');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.permissions).toEqual(['admin:admin_audit:read', 'admin:security:write']);
      expect(updated!.hierarchy_level).toBe(60);
    });

    it('should prevent updating system roles', async () => {
      adapter.seed('admin_roles', [systemRole]);

      const update: AdminRoleUpdateInput = {
        display_name: 'Hacked Super Admin',
      };

      await expect(repo.updateRole('role-system-super', update)).rejects.toThrow(
        'Cannot update system role'
      );
    });

    it('should return null for non-existent role', async () => {
      const update: AdminRoleUpdateInput = {
        display_name: 'Does Not Exist',
      };

      const result = await repo.updateRole('non-existent', update);

      expect(result).toBeNull();
    });

    it('should return existing role if no updates provided', async () => {
      adapter.seed('admin_roles', [customRole]);

      const result = await repo.updateRole('role-custom-security', {});

      expect(result).not.toBeNull();
      expect(result!.id).toBe('role-custom-security');
    });
  });

  describe('deleteRole', () => {
    it('should delete custom role', async () => {
      adapter.seed('admin_roles', [customRole]);

      const deleted = await repo.deleteRole('role-custom-security');

      expect(deleted).toBe(true);
      const allRoles = adapter.getAll('admin_roles');
      expect(allRoles.length).toBe(0);
    });

    it('should prevent deleting system roles', async () => {
      adapter.seed('admin_roles', [systemRole]);

      await expect(repo.deleteRole('role-system-super')).rejects.toThrow(
        'Cannot delete system or builtin role'
      );
    });

    it('should prevent deleting builtin roles', async () => {
      adapter.seed('admin_roles', [builtinRole]);

      await expect(repo.deleteRole('role-builtin-viewer')).rejects.toThrow(
        'Cannot delete system or builtin role'
      );
    });

    it('should return false for non-existent role', async () => {
      const result = await repo.deleteRole('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('findByName', () => {
    it('should find role by name', async () => {
      adapter.seed('admin_roles', [customRole]);

      const role = await repo.findByName(TEST_TENANT, 'security_admin');

      expect(role).not.toBeNull();
      expect(role!.id).toBe('role-custom-security');
      expect(role!.name).toBe('security_admin');
    });

    it('should return null if role not found', async () => {
      adapter.seed('admin_roles', [customRole]);

      const role = await repo.findByName(TEST_TENANT, 'non_existent');

      expect(role).toBeNull();
    });

    it('should respect tenant isolation', async () => {
      const otherTenantRole = { ...customRole, tenant_id: 'other-tenant' };
      adapter.seed('admin_roles', [otherTenantRole]);

      const role = await repo.findByName(TEST_TENANT, 'security_admin');

      expect(role).toBeNull();
    });
  });

  describe('getRolesByTenant', () => {
    it('should get all roles for tenant', async () => {
      adapter.seed('admin_roles', [systemRole, builtinRole, customRole]);

      const roles = await repo.getRolesByTenant(TEST_TENANT);

      expect(roles.length).toBe(3);
      // Should be ordered by hierarchy_level DESC, name ASC
      expect(roles[0].hierarchy_level).toBe(100); // super_admin
      expect(roles[1].hierarchy_level).toBe(50); // security_admin
      expect(roles[2].hierarchy_level).toBe(10); // viewer
    });

    it('should return empty array if no roles found', async () => {
      const roles = await repo.getRolesByTenant('empty-tenant');

      expect(roles).toEqual([]);
    });

    it('should filter by tenant', async () => {
      const otherTenantRole = { ...customRole, id: 'other-role', tenant_id: 'other-tenant' };
      adapter.seed('admin_roles', [customRole, otherTenantRole]);

      const roles = await repo.getRolesByTenant(TEST_TENANT);

      expect(roles.length).toBe(1);
      expect(roles[0].id).toBe('role-custom-security');
    });
  });

  describe('getSystemRoles', () => {
    it('should get only canonical default system roles', async () => {
      adapter.seed('admin_roles', [systemRole, builtinRole, customRole]);

      const roles = await repo.getSystemRoles();

      expect(roles.length).toBe(1);
      expect(roles[0].is_system).toBe(true);
      expect(roles[0].name).toBe('super_admin');
    });

    it('should ignore legacy tenant-scoped system role copies', async () => {
      adapter.seed('admin_roles', [
        systemRole,
        {
          ...systemRole,
          id: 'role-system-super-first',
          tenant_id: 'first',
        },
      ]);

      const roles = await repo.getSystemRoles();

      expect(roles).toHaveLength(1);
      expect(roles[0].id).toBe('role-system-super');
    });

    it('should return empty array if no system roles', async () => {
      adapter.seed('admin_roles', [builtinRole, customRole]);

      const roles = await repo.getSystemRoles();

      expect(roles).toEqual([]);
    });

    it('should order by hierarchy_level DESC', async () => {
      const systemRole2 = {
        ...systemRole,
        id: 'role-system-admin',
        name: 'system_admin',
        hierarchy_level: 90,
      };
      adapter.seed('admin_roles', [systemRole, systemRole2]);

      const roles = await repo.getSystemRoles();

      expect(roles.length).toBe(2);
      expect(roles[0].hierarchy_level).toBe(100);
      expect(roles[1].hierarchy_level).toBe(90);
    });
  });

  describe('permission handling', () => {
    it('should serialize and deserialize permissions correctly', async () => {
      const permissions = ['admin:users:read', 'admin:users:write', 'admin:users:delete'];

      const input: AdminRoleCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'test_role',
        permissions,
      };

      const role = await repo.createRole(input);

      expect(role.permissions).toEqual(permissions);
    });

    it('should handle wildcard permission', async () => {
      const input: AdminRoleCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'admin',
        permissions: ['*'],
      };

      const role = await repo.createRole(input);

      expect(role.permissions).toEqual(['*']);
    });

    it('should handle empty permissions array', async () => {
      const input: AdminRoleCreateInput = {
        tenant_id: TEST_TENANT,
        name: 'empty_role',
        permissions: [],
      };

      const role = await repo.createRole(input);

      expect(role.permissions).toEqual([]);
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { RoleRepository } from '../core/role';

describe('RoleRepository tenant isolation', () => {
  let adapter: MockDatabaseAdapter;

  const seedUserRoles = () => {
    adapter.initTable('user_roles', 'pk');
    adapter.seed('user_roles', [
      {
        pk: 'tenant-a:shared-user:shared-role',
        tenant_id: 'tenant-a',
        user_id: 'shared-user',
        role_id: 'shared-role',
        created_at: 100,
      },
      {
        pk: 'tenant-a:other-user:shared-role',
        tenant_id: 'tenant-a',
        user_id: 'other-user',
        role_id: 'shared-role',
        created_at: 110,
      },
      {
        pk: 'tenant-b:shared-user:shared-role',
        tenant_id: 'tenant-b',
        user_id: 'shared-user',
        role_id: 'shared-role',
        created_at: 200,
      },
    ]);
  };

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
  });

  it('resolves duplicated user-role assignments within the repository tenant only', async () => {
    seedUserRoles();

    const tenantARepository = new RoleRepository(adapter, 'tenant-a');
    const tenantBRepository = new RoleRepository(adapter, 'tenant-b');

    await expect(
      tenantARepository.getUserRoleAssignment('shared-user', 'shared-role')
    ).resolves.toMatchObject({
      tenant_id: 'tenant-a',
      user_id: 'shared-user',
      role_id: 'shared-role',
    });
    await expect(
      tenantBRepository.getUserRoleAssignment('shared-user', 'shared-role')
    ).resolves.toMatchObject({
      tenant_id: 'tenant-b',
      user_id: 'shared-user',
      role_id: 'shared-role',
    });

    expect(adapter.getQueryLog()).toEqual([
      expect.objectContaining({
        sql: 'SELECT * FROM user_roles WHERE tenant_id = ? AND user_id = ? AND role_id = ?',
        params: ['tenant-a', 'shared-user', 'shared-role'],
      }),
      expect.objectContaining({
        sql: 'SELECT * FROM user_roles WHERE tenant_id = ? AND user_id = ? AND role_id = ?',
        params: ['tenant-b', 'shared-user', 'shared-role'],
      }),
    ]);
  });

  it('deletes duplicated user-role assignments only within the repository tenant', async () => {
    seedUserRoles();

    const tenantARepository = new RoleRepository(adapter, 'tenant-a');
    const tenantBRepository = new RoleRepository(adapter, 'tenant-b');

    await expect(tenantARepository.removeAllRolesFromUser('shared-user')).resolves.toBe(1);

    await expect(
      tenantARepository.getUserRoleAssignment('shared-user', 'shared-role')
    ).resolves.toBeNull();
    await expect(
      tenantBRepository.getUserRoleAssignment('shared-user', 'shared-role')
    ).resolves.toMatchObject({
      tenant_id: 'tenant-b',
      user_id: 'shared-user',
      role_id: 'shared-role',
    });
  });

  it('counts duplicated role assignments only within the repository tenant', async () => {
    seedUserRoles();

    const tenantARepository = new RoleRepository(adapter, 'tenant-a');
    const tenantBRepository = new RoleRepository(adapter, 'tenant-b');

    await expect(tenantARepository.countUsersWithRole('shared-role')).resolves.toBe(2);
    await expect(tenantBRepository.countUsersWithRole('shared-role')).resolves.toBe(1);
  });

  it('rejects empty repository tenantId', () => {
    expect(() => new RoleRepository(adapter, ' ')).toThrow('RoleRepository requires tenantId');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { IStorageAdapter } from '../../interfaces';
import { RoleAssignmentStore } from '../role-assignment-store';

function createAdapter(rows: unknown[] = []) {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    query: vi.fn().mockResolvedValue(rows),
    execute: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as IStorageAdapter;
}

const existing = {
  id: 'ra-1',
  tenant_id: 'tenant-a',
  subject_id: 'user-1',
  role_id: 'role-reader',
  scope_type: 'global' as const,
  scope_target: '',
  expires_at: null,
  assigned_by: 'admin-1',
  metadata_json: null,
  created_at: 100,
  updated_at: 100,
};

describe('RoleAssignmentStore authorization boundaries', () => {
  it('does not let partial updates spoof immutable tenant, subject, role, or assigner fields', async () => {
    const adapter = createAdapter([existing]);
    const store = new RoleAssignmentStore(adapter);

    const updated = await store.updateRoleAssignment('tenant-a', 'ra-1', {
      tenant_id: 'tenant-b',
      subject_id: 'attacker',
      role_id: 'role-admin',
      assigned_by: 'attacker',
      created_at: 999,
      scope_type: 'resource',
      scope_target: 'document:1',
    });

    expect(updated).toMatchObject({
      id: 'ra-1',
      tenant_id: 'tenant-a',
      subject_id: 'user-1',
      role_id: 'role-reader',
      assigned_by: 'admin-1',
      created_at: 100,
      scope_type: 'resource',
      scope_target: 'document:1',
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND id = ?'),
      expect.arrayContaining(['tenant-a', 'ra-1'])
    );
    expect(adapter.execute).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['tenant-b', 'attacker', 'role-admin'])
    );
  });

  it('fails closed when the tenant-scoped assignment does not exist', async () => {
    const adapter = createAdapter([]);
    const store = new RoleAssignmentStore(adapter);

    await expect(
      store.updateRoleAssignment('tenant-b', 'ra-1', { scope_type: 'global' })
    ).rejects.toThrow('Role assignment not found: ra-1');
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('checks role existence in both assignment and role tenant scopes', async () => {
    const adapter = createAdapter([{ count: 1 }]);
    const store = new RoleAssignmentStore(adapter);

    await expect(store.hasRole('tenant-a', 'user-1', 'admin')).resolves.toBe(true);
    expect(adapter.query).toHaveBeenCalledWith(
      expect.stringMatching(/ra\.tenant_id = \?[\s\S]*r\.tenant_id = \?/),
      ['user-1', 'tenant-a', 'tenant-a', 'admin', expect.any(Number)]
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  assignRoleToUser,
  createDomainMapping,
  deleteDomainMapping,
  getMappingCountByVersion,
  joinOrganization,
  listDomainMappings,
  resolveAllOrgsByDomainHash,
} from '../org-domain-resolver';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('org-domain-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves organizations from an adapter-backed query', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        id: 'odm-1',
        tenant_id: 'tenant-1',
        domain_hash: 'hash',
        domain_hash_version: 1,
        org_id: 'org-1',
        auto_join_enabled: 1,
        membership_type: 'member',
        auto_assign_role_id: 'role-1',
        verified: 1,
        priority: 10,
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await resolveAllOrgsByDomainHash(adapter, 'hash', 'tenant-1', {
      allow_unverified_domain_mappings: false,
    });

    expect(result).toEqual([
      {
        org_id: 'org-1',
        auto_join_enabled: true,
        auto_assign_role_id: 'role-1',
        membership_type: 'member',
        verified: true,
        priority: 10,
      },
    ]);
  });

  it('creates organization membership through adapter execute', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({ id: 'org-1' }).mockResolvedValueOnce(null);
    vi.mocked(adapter.execute).mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const result = await joinOrganization(adapter, 'user-1', 'org-1', 'tenant-1', 'admin');

    expect(result.success).toBe(true);
    expect(result.org_id).toBe('org-1');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO org_memberships'),
      expect.arrayContaining(['tenant-1', 'user-1', 'org-1', 'admin'])
    );
  });

  it('assigns org-scoped roles through adapter execute', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({ id: 'role-1' }).mockResolvedValueOnce(null);
    vi.mocked(adapter.execute).mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const result = await assignRoleToUser(adapter, 'user-1', 'role-1', 'org-1', 'tenant-1');

    expect(result.success).toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO role_assignments'),
      expect.arrayContaining(['tenant-1', 'user-1', 'role-1', 'org:org-1'])
    );
  });

  it('lists domain mappings with adapter-backed pagination', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({ count: 1 });
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        id: 'odm-1',
        tenant_id: 'tenant-1',
        domain_hash: 'hash',
        domain_hash_version: 1,
        org_id: 'org-1',
        auto_join_enabled: 1,
        membership_type: 'member',
        auto_assign_role_id: null,
        verified: 1,
        priority: 10,
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await listDomainMappings(adapter, 'tenant-1', { limit: 20, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.mappings[0]?.org_id).toBe('org-1');
  });

  it('creates and deletes domain mappings through adapter execute', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const created = await createDomainMapping(adapter, 'tenant-1', 'hash', 1, 'org-1');
    const deleted = await deleteDomainMapping(adapter, created.id, 'tenant-1');

    expect(created.tenant_id).toBe('tenant-1');
    expect(deleted).toBe(true);
  });

  it('aggregates mapping counts by hash version from adapter queries', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      { domain_hash_version: 1, count: 2 },
      { domain_hash_version: 2, count: 5 },
    ]);

    await expect(getMappingCountByVersion(adapter, 'tenant-1')).resolves.toEqual({
      1: 2,
      2: 5,
    });
  });
});

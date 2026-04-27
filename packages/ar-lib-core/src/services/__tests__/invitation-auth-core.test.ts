import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  applyInvitationAssignments,
  assignTenantRoleToUser,
  consumeInvitationUse,
  findActiveInvitationByToken,
  hasRemainingInvitationUses,
} from '../invitation-auth-core';

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

describe('invitation-auth-core', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds active invitations through an adapter-backed lookup', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      id: 'invite-1',
      token: 'token-1',
      tenant_id: 'tenant-1',
      invited_email: 'user@example.com',
      role_id: 'role-1',
      org_id: 'org-1',
      max_uses: 3,
      use_count: 1,
      expires_at: 200,
    });

    const result = await findActiveInvitationByToken(adapter, 'token-1', 100);

    expect(result?.tenant_id).toBe('tenant-1');
    expect(adapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM tenant_invitations'),
      ['token-1', 100]
    );
  });

  it('tracks remaining invitation uses', () => {
    expect(
      hasRemainingInvitationUses({
        id: 'invite-1',
        token: 'token-1',
        tenant_id: 'tenant-1',
        invited_email: null,
        role_id: null,
        org_id: null,
        max_uses: -1,
        use_count: 99,
        expires_at: 200,
      })
    ).toBe(true);

    expect(
      hasRemainingInvitationUses({
        id: 'invite-2',
        token: 'token-2',
        tenant_id: 'tenant-1',
        invited_email: null,
        role_id: null,
        org_id: null,
        max_uses: 2,
        use_count: 2,
        expires_at: 200,
      })
    ).toBe(false);
  });

  it('consumes invitation use only when the guarded update succeeds', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });

    await expect(consumeInvitationUse(adapter, 'invite-1', 100)).resolves.toBe(true);
    await expect(consumeInvitationUse(adapter, 'invite-1', 100)).resolves.toBe(false);
  });

  it('reuses an existing tenant-scoped role assignment', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne)
      .mockResolvedValueOnce({ id: 'role-1' })
      .mockResolvedValueOnce({ id: 'assignment-1' });

    const result = await assignTenantRoleToUser(adapter, 'user-1', 'role-1', 'tenant-1');

    expect(result).toEqual({
      success: true,
      assignment_id: 'assignment-1',
      error: 'Already assigned',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('applies tenant role and organization membership via portable inserts', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne)
      .mockResolvedValueOnce({ id: 'role-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce(null);
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const result = await applyInvitationAssignments(adapter, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      roleId: 'role-1',
      orgId: 'org-1',
    });

    expect(result.roleAssignment?.success).toBe(true);
    expect(result.orgMembership?.success).toBe(true);
    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO role_assignments'),
      expect.arrayContaining(['tenant-1', 'user-1', 'role-1', 'tenant-1'])
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO org_memberships'),
      expect.arrayContaining(['tenant-1', 'user-1', 'org-1', 'member'])
    );
  });
});

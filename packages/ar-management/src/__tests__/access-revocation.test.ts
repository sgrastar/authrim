import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invalidateUserCache: vi.fn(),
  invalidateSubjectRBACCache: vi.fn(),
  getStatus: vi.fn(),
  lifecycle: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    invalidateUserCache: mocks.invalidateUserCache,
    invalidateSubjectRBACCache: mocks.invalidateSubjectRBACCache,
  };
});
vi.mock('../account-status', () => ({
  getCanonicalAccountStatus: mocks.getStatus,
  transitionAccountLifecycle: mocks.lifecycle,
}));

import {
  removeOrganizationMembership,
  removeRoleAssignment,
  suspendAccount,
  type RevocationContext,
} from '../access-revocation';

function context(
  rowsAffected = 1,
  options: { env?: Record<string, unknown>; onCacheFailure?: 'throw' | 'warn' } = {}
) {
  const audit = vi.fn(async () => undefined);
  const log = { warn: vi.fn() };
  const adapter = { execute: vi.fn().mockResolvedValue({ success: true, rowsAffected }) };
  return {
    audit,
    log,
    adapter,
    value: {
      env: (options.env ?? { REBAC_CACHE: {} }) as never,
      tenantId: 'tenant-a',
      adapter: adapter as never,
      audit,
      log: log as never,
      onCacheFailure: options.onCacheFailure ?? 'throw',
    } satisfies RevocationContext,
  };
}

const active = (overrides: Record<string, unknown> = {}) => ({
  id: 'account:user-1',
  lifecycle_state: 'active',
  status: 'active',
  lifecycle_version_ms: null,
  lifecycle_operation_id: null,
  ...overrides,
});

describe('access revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invalidateUserCache.mockResolvedValue(undefined);
    mocks.invalidateSubjectRBACCache.mockResolvedValue(undefined);
    mocks.lifecycle.mockResolvedValue('taken');
  });

  it('removes a role assignment of that user, drops its caches and audits it', async () => {
    const ctx = context();
    expect(
      await removeRoleAssignment(ctx.value, {
        userId: 'user-1',
        assignmentId: 'ra-1',
        details: { access_review_id: 'rev-1' },
        audit: { id: 'access-review.rev-1.item-1', at: 1 },
      })
    ).toBe('removed');
    expect(ctx.adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM role_assignments WHERE tenant_id = ? AND id = ? AND subject_id = ?',
      ['tenant-a', 'ra-1', 'user-1']
    );
    expect(mocks.invalidateSubjectRBACCache).toHaveBeenCalledWith({}, 'tenant-a', 'user-1');
    // The user cache too, reporting a failed delete (this context retries until it is gone).
    expect(mocks.invalidateUserCache).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'user-1',
      {
        throwOnFailure: true,
      }
    );
    expect(ctx.audit).toHaveBeenCalledWith(
      'role_assignment.removed',
      'role_assignment',
      'ra-1',
      { user_id: 'user-1', access_review_id: 'rev-1' },
      { id: 'access-review.rev-1.item-1', at: 1 }
    );
  });

  it('finishes the rest when the assignment is already gone (a retry)', async () => {
    const ctx = context(0);
    expect(
      await removeRoleAssignment(ctx.value, {
        userId: 'user-1',
        assignmentId: 'ra-1',
        audit: { id: 'stable', at: 2 },
      })
    ).toBe('already_removed');
    expect(mocks.invalidateUserCache).toHaveBeenCalled();
    expect(ctx.audit).toHaveBeenCalledWith(
      'role_assignment.removed',
      'role_assignment',
      'ra-1',
      { user_id: 'user-1', already_removed: true },
      { id: 'stable', at: 2 }
    );
  });

  it('fails a removal whose caches cannot be dropped, before auditing it, when asked to', async () => {
    mocks.invalidateSubjectRBACCache.mockRejectedValueOnce(new Error('kv_unavailable'));
    const ctx = context();
    await expect(
      removeOrganizationMembership(ctx.value, { userId: 'user-1', orgId: 'org-1' })
    ).rejects.toThrow('access_cache_invalidation_failed');
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it('fails a removal whose user cache cannot be dropped, when asked to', async () => {
    mocks.invalidateUserCache.mockRejectedValueOnce(new Error('kv_unavailable'));
    const ctx = context();
    await expect(
      removeRoleAssignment(ctx.value, { userId: 'user-1', assignmentId: 'ra-1' })
    ).rejects.toThrow('access_cache_invalidation_failed');
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it('only warns about caches for an Admin API request (they expire on their own)', async () => {
    mocks.invalidateSubjectRBACCache.mockRejectedValueOnce(new Error('kv_unavailable'));
    const ctx = context(1, { onCacheFailure: 'warn' });
    expect(
      await removeOrganizationMembership(ctx.value, { userId: 'user-1', orgId: 'org-1' })
    ).toBe('removed');
    expect(ctx.log.warn).toHaveBeenCalled();
    expect(ctx.audit).toHaveBeenCalledWith(
      'organization_membership.removed',
      'organization',
      'org-1',
      { user_id: 'user-1' },
      undefined
    );
  });

  it('works without the RBAC cache binding', async () => {
    const ctx = context(1, { env: {} });
    await removeRoleAssignment(ctx.value, { userId: 'user-1', assignmentId: 'ra-1' });
    expect(mocks.invalidateSubjectRBACCache).not.toHaveBeenCalled();
    expect(mocks.invalidateUserCache).toHaveBeenCalled();
  });

  it('suspends an active account as one transition, then drops its caches and audits it', async () => {
    mocks.getStatus.mockResolvedValue(active());
    const ctx = context();
    expect(
      await suspendAccount(ctx.value, {
        userId: 'user-1',
        operationId: 'access-review:rev-1:item-1',
        versionMs: 1_800_000_000_000,
        reasonCode: 'access_review',
        audit: { id: 'audit-1', at: 3 },
      })
    ).toBe('suspended');
    // The shared transition: sign-in and sessions first, then the account and its subject.
    expect(mocks.lifecycle).toHaveBeenCalledWith(expect.anything(), ctx.adapter, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      lifecycle: 'suspended',
      status: 'suspended',
      metadataPatch: { suspended_at: 1_800_000_000, suspended_until: null },
      versionMs: 1_800_000_000_000,
      operationId: 'access-review:rev-1:item-1',
      revokeSessions: true,
    });
    expect(ctx.audit).toHaveBeenCalledWith(
      'user.suspend',
      'user',
      'user-1',
      { reason_code: 'access_review', previous_status: 'active' },
      { id: 'audit-1', at: 3 }
    );
  });

  it('finishes its own interrupted suspension, and leaves others alone', async () => {
    const input = {
      userId: 'user-1',
      operationId: 'op-1',
      versionMs: 1,
      reasonCode: 'access_review',
    };
    // Suspended by this operation before: the rest is done again.
    mocks.getStatus.mockResolvedValueOnce(
      active({ lifecycle_state: 'suspended', status: 'suspended', lifecycle_operation_id: 'op-1' })
    );
    const own = context();
    expect(await suspendAccount(own.value, input)).toBe('suspended');
    expect(mocks.lifecycle).toHaveBeenCalled();
    expect(own.audit).toHaveBeenCalled();

    vi.clearAllMocks();
    for (const [status, outcome] of [
      [null, 'not_found'],
      [
        active({ lifecycle_state: 'suspended', lifecycle_operation_id: 'other' }),
        'already_suspended',
      ],
      [active({ lifecycle_state: 'deleted' }), 'not_active'],
    ] as const) {
      mocks.getStatus.mockResolvedValueOnce(status);
      const ctx = context();
      expect(await suspendAccount(ctx.value, input)).toBe(outcome);
      expect(mocks.lifecycle).not.toHaveBeenCalled();
      expect(ctx.audit).not.toHaveBeenCalled();
    }
  });

  it('finishes caches and audit of its own started suspension that another one replaced', async () => {
    mocks.getStatus.mockResolvedValueOnce(
      active({ lifecycle_state: 'locked', status: 'locked', lifecycle_operation_id: 'other' })
    );
    const ctx = context();
    expect(
      await suspendAccount(ctx.value, {
        userId: 'user-1',
        operationId: 'op-1',
        versionMs: 1,
        reasonCode: 'access_review',
        audit: { id: 'audit-1', at: 1 },
        started: true,
      })
    ).toBe('not_active');
    // The newer state stays.
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    expect(mocks.invalidateUserCache).toHaveBeenCalled();
    expect(ctx.audit).toHaveBeenCalledWith(
      'user.suspend',
      'user',
      'user-1',
      { reason_code: 'access_review', superseded: true },
      { id: 'audit-1', at: 1 }
    );
  });

  it('finishes its started suspension that another one replaced after it was read', async () => {
    mocks.getStatus.mockResolvedValueOnce(
      active({ lifecycle_state: 'suspended', status: 'suspended', lifecycle_operation_id: 'op-1' })
    );
    mocks.lifecycle.mockResolvedValueOnce('superseded');
    const ctx = context();
    expect(
      await suspendAccount(ctx.value, {
        userId: 'user-1',
        operationId: 'op-1',
        versionMs: 1,
        reasonCode: 'access_review',
        audit: { id: 'audit-1', at: 1 },
        started: true,
      })
    ).toBe('not_active');
    expect(mocks.invalidateUserCache).toHaveBeenCalled();
    expect(ctx.audit).toHaveBeenCalledWith(
      'user.suspend',
      'user',
      'user-1',
      { reason_code: 'access_review', superseded: true },
      { id: 'audit-1', at: 1 }
    );
  });

  it('fails when a newer transition took the account meanwhile', async () => {
    mocks.getStatus.mockResolvedValueOnce(active());
    mocks.lifecycle.mockResolvedValueOnce('superseded');
    const ctx = context();
    await expect(
      suspendAccount(ctx.value, {
        userId: 'user-1',
        operationId: 'op-1',
        versionMs: 1,
        reasonCode: 'access_review',
      })
    ).rejects.toThrow('account_lifecycle_superseded');
    expect(ctx.audit).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
  adapter: { marker: 'admin-adapter' },
}));
vi.mock('@authrim/ar-lib-core', () => ({
  evaluateAdminCredentialEligibility: mocks.evaluate,
  requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
}));
import { AdminCredentialEligibilityEntrypoint } from '../admin-credential-eligibility-entrypoint';

const PROPS = { caller: 'ar-vc', environmentId: 'test' };

function worker(props: Record<string, unknown> | null = PROPS, envName = 'test') {
  return new AdminCredentialEligibilityEntrypoint(
    { props: props ?? undefined } as unknown as ConstructorParameters<
      typeof AdminCredentialEligibilityEntrypoint
    >[0],
    { AUTHRIM_ENVIRONMENT_NAME: envName } as Env
  );
}

describe('admin credential eligibility entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluate.mockResolvedValue({ eligible: true, email: 'a@example.com', name: 'A' });
  });

  it('returns the shared predicate result for the home tenant admin', async () => {
    await expect(
      worker().checkAdminCredentialEligibility({ tenantId: 'tenant-a', adminUserId: 'admin-1' })
    ).resolves.toEqual({ eligible: true, email: 'a@example.com', name: 'A' });
    expect(mocks.evaluate).toHaveBeenCalledWith(mocks.adapter, {
      tenantId: 'tenant-a',
      adminUserId: 'admin-1',
      now: expect.any(Number) as number,
    });
  });

  it('returns only the decision when not eligible', async () => {
    mocks.evaluate.mockResolvedValue({ eligible: false });
    await expect(
      worker().checkAdminCredentialEligibility({ tenantId: 'tenant-a', adminUserId: 'admin-1' })
    ).resolves.toEqual({ eligible: false });
  });

  it.each([
    ['another caller', { caller: 'ar-auth', environmentId: 'test' }],
    ['another environment', { caller: 'ar-vc', environmentId: 'other' }],
    ['no props', null],
  ])('rejects %s before touching the Admin database', async (_name, props) => {
    await expect(
      worker(props).checkAdminCredentialEligibility({
        tenantId: 'tenant-a',
        adminUserId: 'admin-1',
      })
    ).rejects.toThrow('admin_credential_eligibility_unauthorized');
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it('rejects when the environment name is not configured', async () => {
    await expect(
      worker(PROPS, '').checkAdminCredentialEligibility({
        tenantId: 'tenant-a',
        adminUserId: 'admin-1',
      })
    ).rejects.toThrow('admin_credential_eligibility_unauthorized');
  });

  it.each([
    [undefined, 'admin-1'],
    ['tenant/other', 'admin-1'],
    ['tenant-a', ''],
    ['tenant-a', 123],
    ['tenant-a', 'a'.repeat(257)],
  ])('rejects malformed identifiers (%j, %j)', async (tenantId, adminUserId) => {
    await expect(
      worker().checkAdminCredentialEligibility({
        tenantId: tenantId as string,
        adminUserId: adminUserId as string,
      })
    ).rejects.toThrow('admin_credential_eligibility_unauthorized');
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});

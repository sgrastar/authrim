import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  metadataDb: { name: 'tenant-metadata' },
  resolveAdapter: vi.fn(),
  resolveEffectiveSettings: vi.fn(),
  findActiveInvitationByToken: vi.fn(),
  findInvitationById: vi.fn(),
  reserveInvitationUse: vi.fn(),
  claimInvitationReservation: vi.fn(),
  releaseInvitationReservation: vi.fn(),
  applyInvitationAssignments: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveAdapter,
  resolveEffectiveSettings: mocks.resolveEffectiveSettings,
}));

vi.mock('@authrim/ar-lib-core/services/invitation-auth-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/services/invitation-auth-core')>()),
  findActiveInvitationByToken: mocks.findActiveInvitationByToken,
  findInvitationById: mocks.findInvitationById,
  reserveInvitationUse: mocks.reserveInvitationUse,
  claimInvitationReservation: mocks.claimInvitationReservation,
  releaseInvitationReservation: mocks.releaseInvitationReservation,
  applyInvitationAssignments: mocks.applyInvitationAssignments,
}));

import {
  applyExternalSignupInvitation,
  externalSignupInvitationRequirement,
  releaseExternalSignupInvitation,
  reserveExternalSignupInvitation,
} from '../services/signup-invitation';

const env = { SETTINGS: {} } as unknown as Env;
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
const accountDb = { name: 'account-core' } as never;
const invitation = {
  id: 'invite-1',
  token: 'invite-token',
  tenant_id: 'tenant-a',
  invited_email: null as string | null,
  role_id: 'role-1',
  org_id: null,
  max_uses: 5,
  use_count: 1,
  expires_at: 2_000_000_000,
};

describe('invitations carried by an external sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAdapter.mockResolvedValue(mocks.metadataDb);
    mocks.findActiveInvitationByToken.mockResolvedValue(invitation);
    mocks.findInvitationById.mockResolvedValue(invitation);
    mocks.reserveInvitationUse.mockResolvedValue({ status: 'reserved', reservationId: 'inr-1' });
    mocks.claimInvitationReservation.mockResolvedValue(true);
    mocks.applyInvitationAssignments.mockResolvedValue({ roleAssignment: { success: true } });
    mocks.resolveEffectiveSettings.mockResolvedValue({});
  });

  it('reserves a use held by the sign-in flow, in the tenant metadata database', async () => {
    const reserved = await reserveExternalSignupInvitation(env, {
      token: 'invite-token',
      tenantId: 'tenant-a',
      flowId: 'flow-1',
    });

    expect(reserved).toEqual({ inviteId: 'invite-1', inviteReservationId: 'inr-1' });
    expect(mocks.resolveAdapter).toHaveBeenCalledWith(env, expect.any(String), {
      tenantId: 'tenant-a',
    });
    expect(mocks.reserveInvitationUse).toHaveBeenCalledWith(mocks.metadataDb, {
      invitationId: 'invite-1',
      tenantId: 'tenant-a',
      holder: 'external:flow-1',
    });
  });

  it.each([
    ['an unknown invitation', null, 'reserved'],
    ["another tenant's invitation", { ...invitation, tenant_id: 'tenant-b' }, 'reserved'],
    ['an invitation without a use left', invitation, 'unavailable'],
  ])('reserves nothing from %s', async (_label, found, reservation) => {
    mocks.findActiveInvitationByToken.mockResolvedValue(found);
    mocks.reserveInvitationUse.mockResolvedValue(
      reservation === 'unavailable'
        ? { status: 'unavailable' }
        : { status: 'reserved', reservationId: 'inr-1' }
    );

    const reserved = await reserveExternalSignupInvitation(env, {
      token: 'invite-token',
      tenantId: 'tenant-a',
      flowId: 'flow-1',
    });

    expect(reserved).toBeNull();
  });

  it.each([
    ['names no email', null, 'required', { invitedEmail: null, requireVerifiedEmail: false }],
    [
      'names an email, proof optional',
      'invited@example.com',
      'optional',
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: false },
    ],
    [
      'names an email, proof required',
      'invited@example.com',
      'required',
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: true },
    ],
  ])('tells identity handling what an invitation that %s asks', async (_l, email, policy, want) => {
    mocks.findInvitationById.mockResolvedValue({ ...invitation, invited_email: email });
    mocks.resolveEffectiveSettings.mockResolvedValue({
      'authentication-methods.invitation.email_verification': policy,
    });

    expect(
      await externalSignupInvitationRequirement(env, { tenantId: 'tenant-a', inviteId: 'invite-1' })
    ).toEqual(want);
  });

  it('asks nothing for an invitation that was deleted', async () => {
    mocks.findInvitationById.mockResolvedValue(null);

    expect(
      await externalSignupInvitationRequirement(env, { tenantId: 'tenant-a', inviteId: 'invite-1' })
    ).toBeNull();
  });

  it('claims the reservation for the new account, then assigns in its account database', async () => {
    const applied = await applyExternalSignupInvitation(env, log, {
      inviteId: 'invite-1',
      inviteReservationId: 'inr-1',
      tenantId: 'tenant-a',
      userId: 'user-new',
      accountCoreAdapter: accountDb,
    });

    expect(applied).toBe(true);
    expect(mocks.claimInvitationReservation).toHaveBeenCalledWith(mocks.metadataDb, {
      reservationId: 'inr-1',
      invitationId: 'invite-1',
      tenantId: 'tenant-a',
      userId: 'user-new',
    });
    expect(mocks.applyInvitationAssignments).toHaveBeenCalledWith(accountDb, {
      userId: 'user-new',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      orgId: null,
    });
    expect(mocks.claimInvitationReservation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyInvitationAssignments.mock.invocationCallOrder[0]
    );
  });

  it.each([
    [
      'the reservation is no longer held',
      () => mocks.claimInvitationReservation.mockResolvedValue(false),
    ],
    ['the invitation was deleted', () => mocks.findInvitationById.mockResolvedValue(null)],
    ['storage fails', () => mocks.resolveAdapter.mockRejectedValue(new Error('down'))],
  ])('assigns nothing, and does not throw, when %s', async (_label, arrange) => {
    arrange();

    const applied = await applyExternalSignupInvitation(env, log, {
      inviteId: 'invite-1',
      inviteReservationId: 'inr-1',
      tenantId: 'tenant-a',
      userId: 'user-new',
      accountCoreAdapter: accountDb,
    });

    expect(applied).toBe(false);
    expect(mocks.applyInvitationAssignments).not.toHaveBeenCalled();
  });

  it('gives a use back, and swallows a failure to do so', async () => {
    await releaseExternalSignupInvitation(env, log, {
      inviteId: 'invite-1',
      inviteReservationId: 'inr-1',
      tenantId: 'tenant-a',
    });
    expect(mocks.releaseInvitationReservation).toHaveBeenCalledWith(mocks.metadataDb, {
      reservationId: 'inr-1',
      invitationId: 'invite-1',
      tenantId: 'tenant-a',
    });

    mocks.releaseInvitationReservation.mockRejectedValue(new Error('down'));
    await expect(
      releaseExternalSignupInvitation(env, log, {
        inviteId: 'invite-1',
        inviteReservationId: 'inr-1',
        tenantId: 'tenant-a',
      })
    ).resolves.toBeUndefined();
  });
});

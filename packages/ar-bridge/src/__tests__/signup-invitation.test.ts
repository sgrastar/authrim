import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  metadataDb: { name: 'tenant-metadata' },
  resolveAdapter: vi.fn(),
  reserve: vi.fn(),
  requirement: vi.fn(),
  apply: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveAdapter,
}));

vi.mock('@authrim/ar-lib-core/services/external-signup-invitation', () => ({
  reserveExternalSignupInvitation: mocks.reserve,
  externalSignupInvitationRequirement: mocks.requirement,
  applyExternalSignupInvitation: mocks.apply,
  releaseExternalSignupInvitation: mocks.release,
}));

import {
  EXTERNAL_INVITATION_RESERVATION_TTL_SECONDS,
  applyExternalSignupInvitation,
  externalSignupInvitationRequirement,
  releaseExternalSignupInvitation,
  reserveExternalSignupInvitation,
} from '../services/signup-invitation';

const env = { SETTINGS: {} } as unknown as Env;
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
const accountDb = { name: 'account-core' } as never;
const invitation = { inviteId: 'invite-1', inviteReservationId: 'inr-1' };

describe('invitations carried by an external sign-in (bridge side)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAdapter.mockResolvedValue(mocks.metadataDb);
    mocks.reserve.mockResolvedValue(invitation);
    mocks.requirement.mockResolvedValue(null);
    mocks.apply.mockResolvedValue(true);
    mocks.release.mockResolvedValue(undefined);
  });

  it('reserves a use held by the sign-in flow, in the tenant metadata database, briefly', async () => {
    const reserved = await reserveExternalSignupInvitation(env, {
      token: 'invite-token',
      tenantId: 'tenant-a',
      flowId: 'flow-1',
    });

    expect(reserved).toEqual(invitation);
    expect(mocks.resolveAdapter).toHaveBeenCalledWith(env, expect.any(String), {
      tenantId: 'tenant-a',
    });
    expect(mocks.reserve).toHaveBeenCalledWith(mocks.metadataDb, {
      token: 'invite-token',
      tenantId: 'tenant-a',
      holder: 'external:flow-1',
      ttlSeconds: EXTERNAL_INVITATION_RESERVATION_TTL_SECONDS,
    });
    // As long as the state and a provisioning continuation last, not the hour other sign-ups get.
    expect(EXTERNAL_INVITATION_RESERVATION_TTL_SECONDS).toBe(15 * 60);
  });

  it('reads what the invitation asks in the tenant metadata database', async () => {
    await externalSignupInvitationRequirement(env, { tenantId: 'tenant-a', inviteId: 'invite-1' });

    expect(mocks.requirement).toHaveBeenCalledWith(env, mocks.metadataDb, {
      tenantId: 'tenant-a',
      inviteId: 'invite-1',
    });
  });

  it('applies in the account database and reads the reservation in the tenant metadata one', async () => {
    await applyExternalSignupInvitation(env, log, {
      ...invitation,
      tenantId: 'tenant-a',
      userId: 'user-new',
      accountCoreAdapter: accountDb,
    });

    const [resolveDb, assignmentsDb, , input] = mocks.apply.mock.calls[0] as [
      () => Promise<unknown>,
      unknown,
      unknown,
      unknown,
    ];
    expect(await resolveDb()).toBe(mocks.metadataDb);
    expect(assignmentsDb).toBe(accountDb);
    expect(input).toEqual({ ...invitation, tenantId: 'tenant-a', userId: 'user-new' });
  });

  it('gives a use back in the tenant metadata database', async () => {
    await releaseExternalSignupInvitation(env, log, { ...invitation, tenantId: 'tenant-a' });

    const [resolveDb, , input] = mocks.release.mock.calls[0] as [
      () => Promise<unknown>,
      unknown,
      unknown,
    ];
    expect(await resolveDb()).toBe(mocks.metadataDb);
    expect(input).toEqual({ ...invitation, tenantId: 'tenant-a' });
  });
});

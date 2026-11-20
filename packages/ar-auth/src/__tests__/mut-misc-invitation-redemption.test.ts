import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getChallenge: vi.fn(),
  storeLookup: vi.fn(),
  findByToken: vi.fn(),
  findById: vi.fn(),
  reserve: vi.fn(),
  claim: vi.fn(),
  assign: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: () => ({ coreAdapter: 'core-db' }),
  getChallengeStoreByChallengeId: mocks.storeLookup,
}));
vi.mock('@authrim/ar-lib-core/services/invitation-auth-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/services/invitation-auth-core')>()),
  findActiveInvitationByToken: mocks.findByToken,
  findInvitationById: mocks.findById,
  reserveInvitationUse: mocks.reserve,
  claimInvitationReservation: mocks.claim,
  applyInvitationAssignments: mocks.assign,
}));

import {
  completeSignupInvitation,
  signupInvitationFromMetadata,
  startSignupInvitation,
} from '../invitation-redemption';

const NOW_MS = Date.UTC(2026, 10, 19, 10, 0, 0, 700);
const PROOF = 'p'.repeat(43);
const invitation = { id: 'inv-1', tenant_id: 'tenant-1', invited_email: 'Invited@Example.com' };
const c = { env: { E: 1 } } as unknown as Context<{ Bindings: Env }>;

const start = (overrides: Record<string, unknown> = {}) =>
  startSignupInvitation(c, {
    token: 't'.repeat(32),
    tenantId: 'tenant-1',
    email: 'invited@EXAMPLE.com',
    holder: 'challenge-1',
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  mocks.storeLookup.mockReset().mockResolvedValue({ getChallengeRpc: mocks.getChallenge });
  mocks.getChallenge.mockReset().mockResolvedValue({
    type: 'invitation_email_proof',
    tenantId: 'tenant-1',
    email: 'INVITED@example.com',
    metadata: { invitation_id: 'inv-1' },
  });
  mocks.findByToken.mockReset().mockResolvedValue(invitation);
  mocks.reserve.mockReset().mockResolvedValue({ status: 'reserved', reservationId: 'res-1' });
  mocks.findById.mockReset().mockResolvedValue({ id: 'inv-1', role_id: null, org_id: null });
  mocks.claim.mockReset().mockResolvedValue(true);
  mocks.assign.mockReset().mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe('startSignupInvitation email proof', () => {
  it('compares the invited email without case and accepts a matching proof', async () => {
    await expect(start({ emailProof: PROOF })).resolves.toMatchObject({
      ok: true,
      emailVerified: true,
      reservation: { invite_id: 'inv-1', invite_reservation_id: 'res-1' },
    });
    expect(mocks.findByToken).toHaveBeenCalledWith(
      'core-db',
      't'.repeat(32),
      Math.floor(NOW_MS / 1000)
    );
    expect(mocks.getChallenge).toHaveBeenCalledWith(`invitation_email_proof:${PROOF}`);
  });

  it('refuses another email', async () => {
    await expect(start({ email: 'other@example.com' })).resolves.toEqual({
      ok: false,
      reason: 'email_mismatch',
    });
  });

  it.each([
    ['a malformed proof', { emailProof: 'short' }, (): void => undefined],
    [
      'an unreadable proof',
      { emailProof: PROOF },
      (): void => {
        mocks.getChallenge.mockRejectedValue(new Error('x'));
      },
    ],
    [
      'a proof for another invitation',
      { emailProof: PROOF },
      (): void => {
        mocks.getChallenge.mockResolvedValue({
          type: 'invitation_email_proof',
          tenantId: 'tenant-1',
          email: 'invited@example.com',
          metadata: { invitation_id: 'inv-2' },
        });
      },
    ],
    ['no proof', {}, (): void => undefined],
  ])('requires email verification for %s', async (_label, overrides, arrange) => {
    arrange();
    await expect(start(overrides)).resolves.toEqual({
      ok: false,
      reason: 'email_verification_required',
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('does not look a proof up when the format is wrong', async () => {
    await start({ emailProof: `${PROOF}=` });
    expect(mocks.storeLookup).not.toHaveBeenCalled();
  });
});

describe('signupInvitationFromMetadata', () => {
  it.each([
    [{ invite_id: '', invite_reservation_id: 'r' }],
    [{ invite_id: 'i', invite_reservation_id: '' }],
    [{ invite_id: 'i' }],
    [undefined],
  ])('reads %j as no reservation', (metadata) => {
    expect(signupInvitationFromMetadata(metadata)).toBeNull();
  });

  it('reads a recorded reservation', () => {
    expect(signupInvitationFromMetadata({ invite_id: 'i', invite_reservation_id: 'r' })).toEqual({
      invite_id: 'i',
      invite_reservation_id: 'r',
    });
  });
});

describe('completeSignupInvitation', () => {
  const log = { warn: vi.fn() };
  const db = {
    invitations: () => 'inv-db' as unknown as DatabaseAdapter,
    assignments: 'acct-db' as unknown as DatabaseAdapter,
  };
  const complete = (now?: number) =>
    completeSignupInvitation(db, log, {
      reservation: { invite_id: 'inv-1', invite_reservation_id: 'res-1' },
      tenantId: 'tenant-1',
      userId: 'user-1',
      ...(now === undefined ? {} : { now }),
    });

  beforeEach(() => log.warn.mockReset());

  it('claims the reservation at the current second and applies the assignments', async () => {
    await expect(complete()).resolves.toBe(true);
    expect(mocks.claim).toHaveBeenCalledWith('inv-db', {
      reservationId: 'res-1',
      invitationId: 'inv-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: Math.floor(NOW_MS / 1000),
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports a missing invitation', async () => {
    mocks.findById.mockResolvedValue(null);
    await expect(complete(5)).resolves.toBe(false);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Invitation recorded on the challenge no longer exists',
      expect.objectContaining({ reason: 'not_found' })
    );
  });

  it('reports a reservation no longer held', async () => {
    mocks.claim.mockResolvedValue(false);
    await expect(complete(5)).resolves.toBe(false);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Invitation use reserved by the sign-up is no longer held',
      expect.objectContaining({ reason: 'reservation_lost' })
    );
  });

  it('reports a failure without throwing', async () => {
    mocks.assign.mockRejectedValue(new Error('down'));
    await expect(complete(5)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith('Failed to apply invitation assignments', {
      invite_id: 'inv-1',
      tenant_id: 'tenant-1',
      error: 'Error: down',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GUEST_LIFECYCLE_POLICY,
  resolveAccountRegistrationState,
  canUpgradeGuest,
  canUseGuestAccount,
  getGuestDeletionDueAt,
  getGuestUpgradeHoldUntil,
  isGuestDeletionDue,
  validateGuestLifecyclePolicy,
  type GuestLifecycleSnapshot,
} from '../guest-lifecycle';

const account: GuestLifecycleSnapshot = {
  subjectKind: 'human',
  registrationState: 'guest',
  state: 'active',
  createdAt: 1_000,
  deletionDueAt: 87_400,
  upgradeHoldUntil: null,
};

describe('human guest lifecycle', () => {
  it('uses creation time, with deletion disabled by default', () => {
    expect(getGuestDeletionDueAt(1000, 1)).toBe(87400);
    expect(
      getGuestDeletionDueAt(1000, DEFAULT_GUEST_LIFECYCLE_POLICY.deletionAfterDays)
    ).toBeNull();
  });

  it.each([0, -1, 1.5, 3651, NaN, Infinity])('rejects invalid retention %s', (days) => {
    expect(() => getGuestDeletionDueAt(1000, days)).toThrow('invalid_guest_deletion_days');
  });

  it.each([0, -1, 1.5, 61, NaN, Infinity])('rejects invalid hold %s', (minutes) => {
    expect(() =>
      validateGuestLifecyclePolicy({
        ...DEFAULT_GUEST_LIFECYCLE_POLICY,
        upgradeHoldMinutes: minutes,
      })
    ).toThrow('invalid_guest_hold_minutes');
  });

  it('allows access and upgrade after becoming eligible for cleanup', () => {
    expect(isGuestDeletionDue(account, 87399)).toBe(false);
    expect(isGuestDeletionDue(account, 87400)).toBe(true);
    expect(canUseGuestAccount(account)).toBe(true);
    expect(canUpgradeGuest(account, DEFAULT_GUEST_LIFECYCLE_POLICY, 'email', true, ['email'])).toBe(
      true
    );
  });

  it('honors the acquired hold without extending it on retry or policy edits', () => {
    const until = getGuestUpgradeHoldUntil(account, 87400, 10);
    const held = { ...account, upgradeHoldUntil: until };
    expect(until).toBe(88000);
    expect(isGuestDeletionDue(held, 87999)).toBe(false);
    expect(isGuestDeletionDue(held, 88000)).toBe(true);
    expect(getGuestUpgradeHoldUntil(held, 89000, 60)).toBe(until);
    expect(canUseGuestAccount(held)).toBe(true);
  });

  it.each(['device', 'agent'] as const)('does not clean up or upgrade a %s', (subjectKind) => {
    const other = { ...account, subjectKind };
    expect(isGuestDeletionDue(other, 90000)).toBe(false);
    expect(
      canUpgradeGuest(other, DEFAULT_GUEST_LIFECYCLE_POLICY, 'passkey', true, ['passkey'])
    ).toBe(false);
    expect(() => getGuestUpgradeHoldUntil(other, 90000, 10)).toThrow('guest_upgrade_unavailable');
  });

  it.each(['deleting', 'deleted'] as const)('denies access, upgrade and hold when %s', (state) => {
    const removed = { ...account, state };
    expect(canUseGuestAccount(removed)).toBe(false);
    expect(canUpgradeGuest(removed, DEFAULT_GUEST_LIFECYCLE_POLICY, 'email', true, ['email'])).toBe(
      false
    );
    expect(() => getGuestUpgradeHoldUntil(removed, 90000, 10)).toThrow('guest_upgrade_unavailable');
  });

  it('excludes a promoted user from guest cleanup', () => {
    expect(isGuestDeletionDue({ ...account, registrationState: 'registered' }, 90000)).toBe(false);
  });

  it.each([
    [false, true, ['email'], 'email'],
    [true, false, ['email'], 'email'],
    [true, true, [], 'email'],
    [true, true, ['social'], 'social'],
    [true, true, ['phone'], 'phone'],
  ] as const)(
    'requires current global, method and client permission: %s %s %s %s',
    (upgradeEnabled, methodEnabled, allowedMethods, method) => {
      expect(
        canUpgradeGuest(
          account,
          { ...DEFAULT_GUEST_LIFECYCLE_POLICY, upgradeEnabled },
          method,
          methodEnabled,
          allowedMethods
        )
      ).toBe(false);
    }
  );
});

describe('registration state projection', () => {
  it.each([
    ['guest', null, 'guest'],
    ['registered', null, 'registered'],
    ['registered', 'active', 'guest'],
    ['registered', 'upgrading', 'guest'],
    ['guest', 'registered', 'registered'],
    ['registered', 'registered', 'registered'],
    ['guest', 'deleting', 'guest'],
    ['guest', 'deleted', 'guest'],
  ] as const)('maps %s / %s to %s', (type, phase, expected) => {
    expect(resolveAccountRegistrationState(type, phase)).toBe(expected);
  });
});

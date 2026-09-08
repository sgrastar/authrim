/**
 * Human guest lifecycle policy. Timestamps are Unix seconds.
 * Persistence callers must serialize hold acquisition, upgrade, and deletion using
 * an account-scoped compare-and-swap; these decisions alone are not a write fence.
 */
export const GUEST_LIFECYCLE_SCOPE = 'account:lifecycle:read';
export const GUEST_RETENTION_PRESETS = [1, 7, 14, 30, 90, 180, 365] as const;

export interface GuestLifecyclePolicy {
  deletionAfterDays: number | null;
  upgradeEnabled: boolean;
  upgradeHoldMinutes: number;
}

export const DEFAULT_GUEST_LIFECYCLE_POLICY: Readonly<GuestLifecyclePolicy> = Object.freeze({
  deletionAfterDays: null,
  upgradeEnabled: true,
  upgradeHoldMinutes: 10,
});

export interface GuestLifecycleSnapshot {
  /** Device and agent identities must never inherit human guest retention. */
  subjectKind: 'human' | 'device' | 'agent';
  accountKind: 'guest' | 'registered';
  state: 'active' | 'deleting' | 'deleted';
  createdAt: number;
  deletionDueAt: number | null;
  /** Non-null remains recorded after expiry, preventing another hold. */
  upgradeHoldUntil: number | null;
}

function assertIntegerRange(value: number, min: number, max: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`invalid_guest_${field}`);
  }
}

function assertTimestamp(value: number): void {
  assertIntegerRange(value, 0, Number.MAX_SAFE_INTEGER, 'timestamp');
}

export function validateGuestLifecyclePolicy(policy: GuestLifecyclePolicy): void {
  if (typeof policy.upgradeEnabled !== 'boolean') throw new Error('invalid_guest_upgrade_enabled');
  if (policy.deletionAfterDays !== null) {
    assertIntegerRange(policy.deletionAfterDays, 1, 3650, 'deletion_days');
  }
  assertIntegerRange(policy.upgradeHoldMinutes, 1, 60, 'hold_minutes');
}

/** Snapshot this deadline at creation; policy edits must not rewrite it implicitly. */
export function getGuestDeletionDueAt(
  createdAt: number,
  deletionAfterDays: number | null
): number | null {
  assertTimestamp(createdAt);
  if (deletionAfterDays === null) return null;
  assertIntegerRange(deletionAfterDays, 1, 3650, 'deletion_days');
  const dueAt = createdAt + deletionAfterDays * 86400;
  assertTimestamp(dueAt);
  return dueAt;
}

export function canUseGuestAccount(account: GuestLifecycleSnapshot): boolean {
  // Passing the deletion deadline does not itself revoke access.
  return (
    account.subjectKind === 'human' && account.accountKind === 'guest' && account.state === 'active'
  );
}

export function isGuestDeletionDue(account: GuestLifecycleSnapshot, now: number): boolean {
  assertTimestamp(now);
  return (
    canUseGuestAccount(account) &&
    account.deletionDueAt !== null &&
    account.deletionDueAt <= now &&
    (account.upgradeHoldUntil === null || account.upgradeHoldUntil <= now)
  );
}

export function canUpgradeGuest(
  account: GuestLifecycleSnapshot,
  policy: GuestLifecyclePolicy,
  method: string,
  methodEnabled: boolean,
  clientAllowedMethods: readonly string[]
): boolean {
  validateGuestLifecyclePolicy(policy);
  return (
    canUseGuestAccount(account) &&
    policy.upgradeEnabled &&
    methodEnabled &&
    (method === 'email' || method === 'passkey') &&
    clientAllowedMethods.includes(method)
  );
}

/** Invoke only after the authenticated upgrade request has passed all allow checks. */
export function getGuestUpgradeHoldUntil(
  account: GuestLifecycleSnapshot,
  now: number,
  holdMinutes: number
): number {
  assertTimestamp(now);
  assertIntegerRange(holdMinutes, 1, 60, 'hold_minutes');
  if (!canUseGuestAccount(account)) throw new Error('guest_upgrade_unavailable');
  if (account.upgradeHoldUntil !== null) return account.upgradeHoldUntil;
  const until = now + holdMinutes * 60;
  assertTimestamp(until);
  return until;
}

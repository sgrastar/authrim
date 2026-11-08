/**
 * Unfinished sign-ups (lite Login UI plan PR6b). A sign-up makes the account at its start (the
 * code is sent to it, the passkey ceremony is begun for it), before the person has proven
 * anything; one never finished leaves an account behind. Such an account is marked in
 * `account_registration_pending` on its tenant core shard, with when it may be cleaned up, and
 * the mark is removed when the sign-up completes. A later job deletes accounts whose mark has
 * expired (PR6b-2).
 *
 * - account-lifecycle.registration.pending_ttl_hours: how long a new mark lasts (KV, env, then
 *   72 h). Each mark keeps the deadline it was made with.
 *
 * The mark is written with the account (the same batch), never after it: an account without its
 * mark would never be cleaned up. A mark whose account is gone is harmless (the job finds no
 * account and drops it).
 */

import type { DatabaseAdapter } from '../db';
import type { Env } from '../types/env';
import type {
  AccountRegistrationPendingFlow,
  AccountRegistrationPendingMark,
} from './account-registration-pending-mark';
import { resolveEffectiveSettings } from './effective-settings';

export * from './account-registration-pending-mark';

const TTL_KEY = 'account-lifecycle.registration.pending_ttl_hours';
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 720;

export function isValidAccountRegistrationPendingTtlHours(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TTL_HOURS &&
    value <= MAX_TTL_HOURS
  );
}

/** How long a new mark lasts for the tenant (an invalid stored value refuses, never a default). */
export async function resolveAccountRegistrationPendingTtlHours(
  env: Env,
  tenantId: string,
  options: { fresh?: boolean } = {}
): Promise<number> {
  const values = await resolveEffectiveSettings(env, 'account-lifecycle', {
    tenantId,
    fresh: options.fresh,
  });
  const hours = values[TTL_KEY];
  if (!isValidAccountRegistrationPendingTtlHours(hours)) {
    throw new Error('account_registration_pending_ttl_invalid');
  }
  return hours;
}

/** A new mark for a sign-up starting now, with the tenant's lifetime. */
export async function newAccountRegistrationPendingMark(
  env: Env,
  tenantId: string,
  flow: AccountRegistrationPendingFlow,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<AccountRegistrationPendingMark> {
  const hours = await resolveAccountRegistrationPendingTtlHours(env, tenantId);
  return { flow, createdAt: nowSeconds, expiresAt: nowSeconds + hours * 3600 };
}

/** The sign-up completed: its account is no longer one to clean up. */
export async function clearAccountRegistrationPending(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  await adapter.execute(
    'DELETE FROM account_registration_pending WHERE tenant_id = ? AND user_id = ?',
    [tenantId, userId]
  );
}

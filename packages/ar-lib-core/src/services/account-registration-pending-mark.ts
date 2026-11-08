/**
 * The mark of an unfinished sign-up's account, as written with the account (see
 * account-registration-pending.ts). Plain values and statements only: the repository layer
 * writes it in the account's own batch.
 */

/** The sign-ups that make the account before it is proven. */
export type AccountRegistrationPendingFlow = 'email_code' | 'passkey';

export function isAccountRegistrationPendingFlow(
  value: unknown
): value is AccountRegistrationPendingFlow {
  return value === 'email_code' || value === 'passkey';
}

/** A mark as written with its account: when it was made and when it may be cleaned up. */
export interface AccountRegistrationPendingMark {
  flow: AccountRegistrationPendingFlow;
  /** Epoch seconds. */
  createdAt: number;
  /** Epoch seconds, not before createdAt. */
  expiresAt: number;
}

export function isValidAccountRegistrationPendingMark(
  value: unknown
): value is AccountRegistrationPendingMark {
  if (typeof value !== 'object' || value === null) return false;
  const mark = value as Record<string, unknown>;
  return (
    Object.keys(mark).every(
      (key) => key === 'flow' || key === 'createdAt' || key === 'expiresAt'
    ) &&
    isAccountRegistrationPendingFlow(mark.flow) &&
    Number.isSafeInteger(mark.createdAt) &&
    Number.isSafeInteger(mark.expiresAt) &&
    (mark.createdAt as number) >= 0 &&
    (mark.expiresAt as number) >= (mark.createdAt as number)
  );
}

/**
 * The statement that writes the mark (in the batch that writes its account). An account made
 * again by the same sign-up (a resumed provisioning) keeps the mark it had.
 */
export function accountRegistrationPendingInsertStatement(
  tenantId: string,
  userId: string,
  mark: AccountRegistrationPendingMark
): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO account_registration_pending (tenant_id, user_id, flow, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    params: [tenantId, userId, mark.flow, mark.createdAt, mark.expiresAt],
  };
}

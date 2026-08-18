import type { DatabaseAdapter } from '@authrim/ar-lib-core';

export interface ActiveAccountLegalHold {
  holdId: string;
  reasonCode: string;
}

/**
 * Resolve the authoritative account-scoped hold by legacy/runtime user ID.
 *
 * An elapsed expires_at is deliberately still active until the expiry worker records the audited
 * state transition. Destructive callers must therefore gate only on the authoritative state.
 */
export async function findActiveAccountLegalHold(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<ActiveAccountLegalHold | null> {
  const row = await adapter.queryOne<{ hold_id: string; reason_code: string }>(
    `SELECT hold.id AS hold_id, hold.reason_code
       FROM legal_holds hold
       JOIN identity_accounts account
         ON account.id = hold.subject_id AND account.tenant_id = hold.tenant_id
      WHERE hold.tenant_id = ? AND hold.subject_type = 'account'
        AND account.legacy_user_id = ? AND hold.state = 'active'
      LIMIT 1`,
    [tenantId, userId],
    { consistencyClass: 'primary_required' }
  );
  if (!row || typeof row.hold_id !== 'string' || typeof row.reason_code !== 'string') {
    return null;
  }
  return { holdId: row.hold_id, reasonCode: row.reason_code };
}

import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';
import {
  getMissingRequiredCustomClaims,
  type GetMissingRequiredCustomClaimsParams,
  type MissingRequiredCustomClaim,
} from './write-validator';

/**
 * Account lifecycle stages are intentionally separate from users_core.status.
 * status controls operational access (active/suspended/locked), while lifecycle_state
 * describes where the account is in its provisioning/completion journey.
 *
 * Planned values:
 * - invited
 * - pending_verification
 * - provisioning
 * - incomplete
 * - active
 * - dormant
 * - archived
 * - deprovisioned
 */
export type UserLifecycleState =
  | 'invited'
  | 'pending_verification'
  | 'provisioning'
  | 'incomplete'
  | 'active'
  | 'dormant'
  | 'archived'
  | 'deprovisioned';

export interface SyncUserLifecycleStateResult {
  lifecycleState: UserLifecycleState;
  missingRequiredFields: MissingRequiredCustomClaim[];
}

export interface SetUserLifecycleStateParams {
  db: DatabaseSource;
  tenantId: string;
  userId: string;
  lifecycleState: UserLifecycleState;
}

export interface SyncUserLifecycleStateParams extends GetMissingRequiredCustomClaimsParams {
  stateDb?: DatabaseSource;
}

export async function setUserLifecycleState(
  params: SetUserLifecycleStateParams
): Promise<UserLifecycleState> {
  const { db, tenantId, userId, lifecycleState } = params;
  const adapter = ensureDatabaseAdapter(db, 'custom-claims-lifecycle');

  const currentRow = await adapter.queryOne<{ lifecycle_state: string | null }>(
    'SELECT lifecycle_state FROM users_core WHERE id = ? AND tenant_id = ?',
    [userId, tenantId]
  );

  if (!currentRow || currentRow.lifecycle_state === lifecycleState) {
    return lifecycleState;
  }

  await adapter.execute(
    'UPDATE users_core SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
    [lifecycleState, Date.now(), userId, tenantId]
  );

  return lifecycleState;
}

export async function syncUserLifecycleState(
  params: SyncUserLifecycleStateParams
): Promise<SyncUserLifecycleStateResult> {
  const { db, stateDb = params.schemaDb ?? db, tenantId, userId } = params;
  const missingRequiredFields = await getMissingRequiredCustomClaims(params);
  const lifecycleState: UserLifecycleState =
    missingRequiredFields.length > 0 ? 'incomplete' : 'active';

  await setUserLifecycleState({
    db: stateDb,
    tenantId,
    userId,
    lifecycleState,
  });

  return {
    lifecycleState,
    missingRequiredFields,
  };
}

import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';
import type { Env } from '../../types/env';
import type { AccountAuthenticationLifecycle } from '../../durable-objects/SessionRevocationStore';
import {
  getSessionRevocationStore,
  transitionAccountAuthenticationState,
} from '../session-revocation-store';
import {
  getMissingRequiredCustomClaims,
  type GetMissingRequiredCustomClaimsParams,
  type MissingRequiredCustomClaim,
} from './write-validator';

/**
 * Account lifecycle stages are intentionally separate from operational account status.
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
  accountAuthenticationEnv?: Pick<Env, 'SESSION_REVOCATION_STORE'>;
  accountAuthenticationOperationId?: string;
}

export interface SyncUserLifecycleStateParams extends GetMissingRequiredCustomClaimsParams {
  stateDb?: DatabaseSource;
  accountAuthenticationEnv?: Pick<Env, 'SESSION_REVOCATION_STORE'>;
  accountAuthenticationOperationId?: string;
}

function lifecycleTimestampToMilliseconds(value: number | string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  let milliseconds: number;
  if (Number.isFinite(numeric)) {
    const absolute = Math.abs(numeric);
    milliseconds =
      absolute < 100_000_000_000
        ? numeric * 1000
        : absolute < 100_000_000_000_000
          ? numeric
          : absolute < 100_000_000_000_000_000
            ? numeric / 1000
            : numeric / 1_000_000;
  } else {
    milliseconds = Date.parse(String(value));
  }
  milliseconds = Math.trunc(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error('account_authentication_lifecycle_version_invalid');
  }
  return milliseconds;
}

export async function setUserLifecycleState(
  params: SetUserLifecycleStateParams
): Promise<UserLifecycleState> {
  const { db, tenantId, userId, lifecycleState } = params;
  const adapter = ensureDatabaseAdapter(db, 'custom-claims-lifecycle');

  const currentRow = await adapter.queryOne<{
    id: string;
    lifecycle_state: string | null;
    subject_lifecycle_state: string | null;
    directory_publication_state: string | null;
    account_updated_at: number | string;
  }>(
    `SELECT account.id,
            account.lifecycle_state,
            subject.lifecycle_state AS subject_lifecycle_state,
            account.directory_publication_state,
            account.updated_at AS account_updated_at
       FROM identity_accounts account
       LEFT JOIN identity_subjects subject
         ON subject.id = account.primary_subject_id
        AND subject.tenant_id = account.tenant_id
      WHERE account.legacy_user_id = ? AND account.tenant_id = ?`,
    [userId, tenantId]
  );

  if (!currentRow) {
    return lifecycleState;
  }

  const restrictiveSubjectLifecycle = (
    ['suspended', 'locked', 'deleting', 'deleted'] as const
  ).find((candidate) => candidate === currentRow.subject_lifecycle_state);
  const subjectAuthenticationLifecycle: AccountAuthenticationLifecycle =
    currentRow.subject_lifecycle_state === 'active'
      ? 'active'
      : (restrictiveSubjectLifecycle ?? 'inactive');
  const authenticationLifecycle: AccountAuthenticationLifecycle =
    lifecycleState !== 'active' || currentRow.directory_publication_state !== 'active'
      ? 'inactive'
      : subjectAuthenticationLifecycle;
  const operationId = params.accountAuthenticationOperationId ?? crypto.randomUUID();
  if (currentRow.lifecycle_state === lifecycleState) {
    if (params.accountAuthenticationEnv) {
      const sourceVersionMs = lifecycleTimestampToMilliseconds(currentRow.account_updated_at);
      const accountId = `account:${userId}`;
      const store = getSessionRevocationStore(params.accountAuthenticationEnv, tenantId, userId);
      const state = await store.getAccountStateRpc(tenantId, userId, accountId);
      if (state.lifecycle === authenticationLifecycle) return lifecycleState;
      if (state.lifecycleVersionMs !== null && state.lifecycleVersionMs >= sourceVersionMs) {
        throw new Error('account_authentication_lifecycle_reconciliation_conflict');
      }
      await transitionAccountAuthenticationState(params.accountAuthenticationEnv, {
        tenantId,
        userId,
        lifecycle: authenticationLifecycle,
        sourceVersionMs,
        operationId,
        revokeSessions: authenticationLifecycle !== 'active',
      });
    }
    return lifecycleState;
  }

  const sourceVersionMs = Date.now();
  if (params.accountAuthenticationEnv && authenticationLifecycle !== 'active') {
    await transitionAccountAuthenticationState(params.accountAuthenticationEnv, {
      tenantId,
      userId,
      lifecycle: authenticationLifecycle,
      sourceVersionMs,
      operationId,
      revokeSessions: true,
    });
  }

  await adapter.execute(
    'UPDATE identity_accounts SET lifecycle_state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
    [lifecycleState, sourceVersionMs, currentRow.id, tenantId]
  );

  if (params.accountAuthenticationEnv && authenticationLifecycle === 'active') {
    await transitionAccountAuthenticationState(params.accountAuthenticationEnv, {
      tenantId,
      userId,
      lifecycle: authenticationLifecycle,
      sourceVersionMs,
      operationId,
      revokeSessions: false,
    });
  }

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
    accountAuthenticationEnv: params.accountAuthenticationEnv,
    accountAuthenticationOperationId: params.accountAuthenticationOperationId,
  });

  return {
    lifecycleState,
    missingRequiredFields,
  };
}

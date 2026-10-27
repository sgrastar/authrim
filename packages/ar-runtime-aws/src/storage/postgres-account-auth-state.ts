/** Durable account authentication state for the AWS sign-in profile. */

import type {
  AccountAuthenticationLifecycle,
  AccountAuthenticationSnapshot,
} from '@authrim/ar-lib-core';
import type { PostgresQueryClient } from './postgres-transient-state';

type AccountRow = {
  lifecycle: AccountAuthenticationLifecycle | null;
  lifecycle_version_ms: string | number | null;
  lifecycle_operation_id: string | null;
  revoked_after_ms: string | number | null;
  last_login_at_ms: string | number | null;
};

type CounterResultRow = {
  lifecycle: AccountAuthenticationLifecycle | null;
  counter: string | number | null;
};

const STATE_TABLE = 'authrim_aws_account_auth_state';
const COUNTER_TABLE = 'authrim_aws_passkey_counters';
const SAFE_TENANT_ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;
const SAFE_USER_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CREDENTIAL_ID = /^[a-zA-Z0-9_.:-]{1,256}$/u;
const LIFECYCLES = new Set<AccountAuthenticationLifecycle>([
  'active',
  'suspended',
  'locked',
  'deleting',
  'deleted',
  'inactive',
]);

function assertIdentity(tenantId: string, userId: string, accountId: string): void {
  if (
    !SAFE_TENANT_ID.test(tenantId) ||
    !SAFE_USER_ID.test(userId) ||
    accountId !== `account:${userId}`
  ) {
    throw new Error('session_revocation_identity_invalid');
  }
}

function assertPositiveTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}_timestamp_invalid`);
}

function assertCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('passkey_counter_invalid');
}

function nullableMs(value: string | number | null): number | null {
  if (value === null) return null;
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Invalid account authentication timestamp');
  }
  return result;
}

function accountSnapshot(row: AccountRow | undefined): AccountAuthenticationSnapshot {
  if (!row) {
    return {
      revokedAfterMs: null,
      lastLoginAtMs: null,
      lifecycle: null,
      lifecycleVersionMs: null,
      lifecycleOperationId: null,
    };
  }
  if (row.lifecycle !== null && !LIFECYCLES.has(row.lifecycle)) {
    throw new Error('Invalid account authentication lifecycle');
  }
  return {
    revokedAfterMs: nullableMs(row.revoked_after_ms),
    lastLoginAtMs: nullableMs(row.last_login_at_ms),
    lifecycle: row.lifecycle,
    lifecycleVersionMs: nullableMs(row.lifecycle_version_ms),
    lifecycleOperationId: row.lifecycle_operation_id,
  };
}

/**
 * The account row is durable and must be restored or explicitly initialized from
 * a trusted source lifecycle. Reads never turn an absent row into `active`.
 */
export class PostgresAccountAuthStateStore {
  constructor(private readonly db: PostgresQueryClient) {}

  async getAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot> {
    assertIdentity(tenantId, userId, accountId);
    const result = await this.db.query<AccountRow>(
      `/* aws-account-auth:get-state */
       SELECT lifecycle, lifecycle_version_ms, lifecycle_operation_id,
              revoked_after_ms, last_login_at_ms
       FROM ${STATE_TABLE}
       WHERE tenant_id = $1 AND user_id = $2 AND account_id = $3`,
      [tenantId, userId, accountId]
    );
    return accountSnapshot(result.rows[0]);
  }

  async initializeAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number
  ): Promise<AccountAuthenticationSnapshot> {
    assertIdentity(tenantId, userId, accountId);
    if (!LIFECYCLES.has(lifecycle)) throw new Error('account_authentication_lifecycle_invalid');
    assertPositiveTimestamp(sourceVersionMs, 'account_auth_state');
    const result = await this.db.query<AccountRow>(
      `/* aws-account-auth:initialize-state */
       INSERT INTO ${STATE_TABLE} AS current
         (tenant_id, user_id, account_id, lifecycle, lifecycle_version_ms,
          lifecycle_operation_id, revoked_after_ms, last_login_at_ms)
       VALUES ($1, $2, $3, $4, $5::bigint, NULL, NULL, NULL)
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET account_id = current.account_id
       RETURNING lifecycle, lifecycle_version_ms, lifecycle_operation_id,
                 revoked_after_ms, last_login_at_ms`,
      [tenantId, userId, accountId, lifecycle, sourceVersionMs]
    );
    if (!result.rows[0]) throw new Error('Account authentication state unavailable');
    return accountSnapshot(result.rows[0]);
  }

  /**
   * A single SQL statement locks the account row and conditionally upserts the
   * credential counter. A missing/inactive account never creates a counter.
   * The source credential counter is a floor if replication lagged behind it.
   */
  async advancePasskeyCounterRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    credentialId: string,
    sourceCounter: number,
    newCounter: number,
    observedAtMs: number
  ): Promise<{ counter: number; advanced: boolean }> {
    assertIdentity(tenantId, userId, accountId);
    if (!SAFE_CREDENTIAL_ID.test(credentialId)) {
      throw new Error('account_authentication_credential_id_invalid');
    }
    assertCounter(sourceCounter);
    assertCounter(newCounter);
    assertPositiveTimestamp(observedAtMs, 'passkey_counter');
    const result = await this.db.query<CounterResultRow>(
      `/* aws-account-auth:advance-passkey-counter */
       WITH account AS MATERIALIZED (
         SELECT lifecycle FROM ${STATE_TABLE}
         WHERE tenant_id = $1 AND user_id = $2 AND account_id = $3
         FOR UPDATE
       ), advanced AS (
         INSERT INTO ${COUNTER_TABLE} AS current
           (tenant_id, user_id, credential_id, counter, updated_at_ms)
         SELECT $1, $2, $4, $6::bigint, $7::bigint
         FROM account
         WHERE lifecycle = 'active'
           AND (($5::bigint = 0 AND $6::bigint = 0) OR $6::bigint > $5::bigint)
         ON CONFLICT (tenant_id, user_id, credential_id) DO UPDATE
           SET counter = EXCLUDED.counter,
               updated_at_ms = EXCLUDED.updated_at_ms
         WHERE (EXCLUDED.counter = 0 AND current.counter = 0 AND $5::bigint = 0)
            OR EXCLUDED.counter > GREATEST(current.counter, $5::bigint)
         RETURNING counter
       )
       SELECT (SELECT lifecycle FROM account) AS lifecycle,
              (SELECT counter FROM advanced) AS counter`,
      [tenantId, userId, accountId, credentialId, sourceCounter, newCounter, observedAtMs]
    );
    const row = result.rows[0];
    if (!row || row.lifecycle === null) throw new Error('account_auth_state_uninitialized');
    if (row.lifecycle !== 'active') throw new Error('account_authentication_not_allowed');
    if (row.counter === null) throw new Error('passkey_counter_replay');
    const counter = nullableMs(row.counter);
    if (counter === null) throw new Error('passkey_counter_replay');
    return { counter, advanced: counter !== 0 };
  }
}

import type { DatabaseAdapter, PreparedStatement, ExecuteResult } from './adapter';

export interface LegalHoldMutationIdentity {
  tenantId: string;
  accountId: string;
  holdId: string;
  eventId: string;
  operationId: string;
  actor: string;
  reasonCode: string;
  now: number;
}
export interface CreateLegalHoldInput extends LegalHoldMutationIdentity {
  caseReference: string | null;
  expiresAt: number | null;
}
export interface ReleaseLegalHoldInput extends LegalHoldMutationIdentity {
  expectedVersion: number;
}
export interface AccountGovernanceMutationCapability {
  createLegalHold(input: CreateLegalHoldInput): Promise<ExecuteResult[]>;
  releaseLegalHold(input: ReleaseLegalHoldInput): Promise<ExecuteResult[]>;
  transitionAccountDeletion(input: AccountDeletionInput): Promise<boolean>;
  putSupportContext(input: PutSupportContextInput): Promise<ExecuteResult>;
}

export interface PutSupportContextInput {
  tenantId: string;
  accountId: string;
  actor: string;
  expectedVersion: number;
  contextJson: string;
  now: number;
}

export function supportContextStatement(input: PutSupportContextInput): PreparedStatement {
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 1 ||
    [input.tenantId, input.accountId, input.actor].some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        value.length > 256 ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    )
  )
    throw new Error('account_governance_input_invalid');
  let document: unknown;
  try {
    document = JSON.parse(input.contextJson) as unknown;
  } catch {
    throw new Error('account_governance_input_invalid');
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    new TextEncoder().encode(input.contextJson).length > 32768
  )
    throw new Error('account_governance_input_invalid');
  const { tenantId, accountId, actor, expectedVersion, contextJson, now } = input;
  return expectedVersion === 0
    ? {
        sql: `INSERT INTO account_support_contexts (tenant_id,account_id,context_json,version,created_by,updated_by,created_at,updated_at)
      SELECT ?,?,?,1,?,?,?,? WHERE EXISTS (SELECT 1 FROM identity_accounts WHERE tenant_id=? AND id=?)
      ON CONFLICT(tenant_id,account_id) DO NOTHING`,
        params: [tenantId, accountId, contextJson, actor, actor, now, now, tenantId, accountId],
      }
    : {
        sql: `UPDATE account_support_contexts SET context_json=?,version=version+1,updated_by=?,updated_at=?
      WHERE tenant_id=? AND account_id=? AND version=?
      AND EXISTS (SELECT 1 FROM identity_accounts WHERE tenant_id=? AND id=?)`,
        params: [
          contextJson,
          actor,
          now,
          tenantId,
          accountId,
          expectedVersion,
          tenantId,
          accountId,
        ],
      };
}

export async function putAccountSupportContext(
  adapter: DatabaseAdapter,
  input: PutSupportContextInput
): Promise<ExecuteResult> {
  const statement = supportContextStatement(input);
  if (adapter.accountGovernanceMutations)
    return adapter.accountGovernanceMutations.putSupportContext(input);
  assertNativeGovernanceBackend(adapter);
  const result = await adapter.execute(statement.sql, statement.params);
  return nativePointWriteResult(adapter, result);
}

export interface AccountDeletionInput {
  tenantId: string;
  accountId: string;
  state: 'deleting' | 'deleted';
  now: number;
}

export function accountDeletionPlan(input: AccountDeletionInput): PreparedStatement[] {
  if (
    !['deleting', 'deleted'].includes(input.state) ||
    !Number.isSafeInteger(input.now) ||
    input.now < 1 ||
    [input.tenantId, input.accountId].some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        value.length > 256 ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    )
  )
    throw new Error('account_governance_input_invalid');
  const { tenantId, accountId, state, now } = input;
  return [
    {
      sql: `UPDATE account_legal_hold_states SET updated_at=CASE WHEN updated_at >= ? THEN updated_at+1 ELSE ? END
      WHERE tenant_id=? AND account_id=? AND projection_state='inactive' AND active_hold_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=? AND h.subject_id=?
        AND h.subject_type='account' AND h.state='active')`,
      params: [now, now, tenantId, accountId, tenantId, accountId],
    },
    {
      sql: `UPDATE identity_accounts SET lifecycle_state=?,updated_at=CASE WHEN updated_at > ? THEN updated_at ELSE ? END,
      deleted_at=CASE WHEN deleted_at IS NULL THEN ? ELSE deleted_at END
      WHERE tenant_id=? AND id=? AND lifecycle_state<>? ${state === 'deleting' ? "AND lifecycle_state<>'deleted'" : ''}
      AND EXISTS (SELECT 1 FROM account_legal_hold_states g WHERE g.tenant_id=? AND g.account_id=?
        AND g.projection_state='inactive' AND g.active_hold_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=? AND h.subject_id=?
        AND h.subject_type='account' AND h.state='active')`,
      params: [
        state,
        now,
        now,
        now,
        tenantId,
        accountId,
        state,
        tenantId,
        accountId,
        tenantId,
        accountId,
      ],
    },
  ];
}

/** Beginning deletion fences future holds before any cross-database PII cleanup can start. */
export async function transitionCanonicalAccountDeletion(
  adapter: DatabaseAdapter,
  input: AccountDeletionInput
): Promise<boolean> {
  const statements = accountDeletionPlan(input);
  if (adapter.accountGovernanceMutations)
    return adapter.accountGovernanceMutations.transitionAccountDeletion(input);
  const results = await executeGuardedNativePlan(adapter, statements[0], statements.slice(1));
  if (results.length !== 1 || results.some((result) => !result.success))
    throw new Error('account_deletion_result_unknown');
  if (results[0].rowsAffected === 1) return true;
  const same = await adapter.queryOne<{ id: string }>(
    `SELECT a.id FROM identity_accounts a
    JOIN account_legal_hold_states g ON g.tenant_id=a.tenant_id AND g.account_id=a.id
    WHERE a.tenant_id=? AND a.id=? AND a.lifecycle_state=? AND g.projection_state='inactive' AND g.active_hold_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=a.tenant_id AND h.subject_id=a.id
      AND h.subject_type='account' AND h.state='active')`,
    [input.tenantId, input.accountId, input.state]
  );
  return same !== null;
}

export function assertLegalHoldMutation(input: CreateLegalHoldInput | ReleaseLegalHoldInput): void {
  for (const value of [
    input.tenantId,
    input.accountId,
    input.holdId,
    input.eventId,
    input.operationId,
    input.actor,
  ]) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 256 ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error('account_governance_input_invalid');
  }
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.reasonCode) ||
    !Number.isSafeInteger(input.now) ||
    input.now < 1
  )
    throw new Error('account_governance_input_invalid');
  if (
    'expectedVersion' in input &&
    (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
  )
    throw new Error('account_governance_input_invalid');
  if (
    'caseReference' in input &&
    input.caseReference !== null &&
    (typeof input.caseReference !== 'string' ||
      !input.caseReference ||
      input.caseReference.length > 256 ||
      [...input.caseReference].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ))
  )
    throw new Error('account_governance_input_invalid');
  if (
    'expiresAt' in input &&
    input.expiresAt !== null &&
    (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now)
  )
    throw new Error('account_governance_input_invalid');
}

/** An actual write to the authority row serializes hold creation with destructive transitions.
 * The projection generation remains owned by hold transitions, preserving existing trigger semantics.
 * All following statements must execute in the same atomic batch/transaction.
 */
export function legalHoldGuardStatement(
  tenantId: string,
  accountId: string,
  now: number
): PreparedStatement {
  return {
    sql: `UPDATE account_legal_hold_states
    SET updated_at=CASE WHEN updated_at >= ? THEN updated_at+1 ELSE ? END
    WHERE tenant_id=? AND account_id=? AND projection_state='inactive' AND active_hold_id IS NULL
      AND EXISTS (SELECT 1 FROM identity_accounts a WHERE a.tenant_id=? AND a.id=?
        AND a.lifecycle_state NOT IN ('deleting','deleted'))
      AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=? AND h.subject_id=?
        AND h.subject_type='account' AND h.state='active')`,
    params: [now, now, tenantId, accountId, tenantId, accountId, tenantId, accountId],
  };
}

export function createLegalHoldPlan(input: CreateLegalHoldInput): PreparedStatement[] {
  assertLegalHoldMutation(input);
  const {
    holdId,
    tenantId,
    accountId,
    reasonCode,
    caseReference,
    expiresAt,
    actor,
    now,
    eventId,
    operationId,
  } = input;
  return [
    {
      sql: `INSERT INTO legal_holds (
                id, tenant_id, subject_type, subject_id, state, reason_code, case_reference,
                expires_at, version, created_by, created_at, updated_at
              ) SELECT ?, ?, 'account', ?, 'active', ?, ?, ?, 1, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM account_legal_hold_states g
                JOIN identity_accounts a ON a.tenant_id=g.tenant_id AND a.id=g.account_id
                WHERE g.tenant_id=? AND g.account_id=? AND g.projection_state='inactive'
                  AND g.active_hold_id IS NULL AND a.lifecycle_state NOT IN ('deleting','deleted'))
                AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=? AND h.subject_id=?
                  AND h.subject_type='account' AND h.state='active')
              ON CONFLICT (id) DO NOTHING`,
      params: [
        holdId,
        tenantId,
        accountId,
        reasonCode,
        caseReference,
        expiresAt,
        actor,
        now,
        now,
        tenantId,
        accountId,
        tenantId,
        accountId,
      ],
    },
    {
      sql: `INSERT INTO legal_hold_events (
                event_id, hold_id, tenant_id, account_id, event_type, hold_version,
                projection_generation, actor_id, reason_code, case_reference,
                effective_at, created_at
              )
              SELECT ?, hold.id, hold.tenant_id, hold.subject_id, 'created', hold.version,
                     authority.projection_generation, ?, hold.reason_code,
                     hold.case_reference, hold.created_at, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.state = 'active' AND hold.version = 1 AND hold.reason_code = ?
                 AND authority.projection_state = 'active'
                 AND authority.active_hold_id = hold.id
                 AND ((hold.case_reference IS NULL AND CAST(? AS TEXT) IS NULL) OR hold.case_reference = ?)
                 AND ((hold.expires_at IS NULL AND CAST(? AS BIGINT) IS NULL) OR hold.expires_at = ?)
              ON CONFLICT DO NOTHING`,
      params: [
        eventId,
        actor,
        now,
        holdId,
        tenantId,
        accountId,
        reasonCode,
        caseReference,
        caseReference,
        expiresAt,
        expiresAt,
      ],
    },
    {
      sql: `INSERT INTO legal_hold_projection_outbox (
                operation_id, tenant_id, hold_id, account_id, projection_generation, hold_version,
                projection_state, next_attempt_at, created_at, updated_at
              )
              SELECT ?, hold.tenant_id, hold.id, hold.subject_id, authority.projection_generation,
                     hold.version, 'active', ?, ?, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ?
                 AND hold.subject_id = ? AND hold.state = 'active'
                 AND hold.version = 1 AND authority.projection_state = 'active'
                 AND authority.active_hold_id = hold.id AND EXISTS (
                   SELECT 1 FROM legal_hold_events event WHERE event.event_id = ?
                 )
              ON CONFLICT (operation_id) DO NOTHING`,
      params: [operationId, now, now, now, holdId, tenantId, accountId, eventId],
    },
  ];
}

export function releaseLegalHoldPlan(input: ReleaseLegalHoldInput): PreparedStatement[] {
  assertLegalHoldMutation(input);
  const {
    holdId,
    tenantId,
    accountId,
    reasonCode,
    expectedVersion,
    actor,
    now,
    eventId,
    operationId,
  } = input;
  return [
    {
      sql: `UPDATE legal_holds
                 SET state = 'released', released_by = ?, released_at = ?, release_reason = ?,
                     version = version + 1, updated_at = ?
               WHERE id = ? AND tenant_id = ? AND subject_type = 'account' AND subject_id = ?
                 AND state = 'active' AND version = ?`,
      params: [actor, now, reasonCode, now, holdId, tenantId, accountId, expectedVersion],
    },
    {
      sql: `INSERT INTO legal_hold_events (
                event_id, hold_id, tenant_id, account_id, event_type, hold_version,
                projection_generation, actor_id, reason_code, case_reference,
                effective_at, created_at
              )
              SELECT ?, hold.id, hold.tenant_id, hold.subject_id, 'released', hold.version,
                     authority.projection_generation, ?, ?, hold.case_reference, ?, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.state = 'released' AND hold.version = ?
                 AND authority.projection_state = 'inactive'
                 AND authority.active_hold_id IS NULL
              ON CONFLICT DO NOTHING`,
      params: [
        eventId,
        actor,
        reasonCode,
        now,
        now,
        holdId,
        tenantId,
        accountId,
        expectedVersion + 1,
      ],
    },
    {
      sql: `INSERT INTO legal_hold_projection_outbox (
                operation_id, tenant_id, hold_id, account_id, projection_generation, hold_version,
                projection_state, next_attempt_at, created_at, updated_at
              )
              SELECT ?, hold.tenant_id, hold.id, hold.subject_id, authority.projection_generation,
                     hold.version, 'inactive', ?, ?, ?
                FROM legal_holds hold
                JOIN account_legal_hold_states authority
                  ON authority.tenant_id = hold.tenant_id
                 AND authority.account_id = hold.subject_id
               WHERE hold.id = ? AND hold.tenant_id = ? AND hold.subject_id = ?
                 AND hold.state = 'released' AND hold.version = ?
                 AND authority.projection_state = 'inactive'
                 AND authority.active_hold_id IS NULL AND EXISTS (
                   SELECT 1 FROM legal_hold_events event WHERE event.event_id = ?
                 )
              ON CONFLICT (operation_id) DO NOTHING`,
      params: [
        operationId,
        now,
        now,
        now,
        holdId,
        tenantId,
        accountId,
        expectedVersion + 1,
        eventId,
      ],
    },
  ];
}

export async function createAccountLegalHold(
  adapter: DatabaseAdapter,
  input: CreateLegalHoldInput
): Promise<ExecuteResult[]> {
  assertLegalHoldMutation(input);
  if (adapter.accountGovernanceMutations)
    return adapter.accountGovernanceMutations.createLegalHold(input);
  const statements = createLegalHoldPlan(input);
  return executeGuardedNativePlan(
    adapter,
    legalHoldGuardStatement(input.tenantId, input.accountId, input.now),
    statements
  );
}
export async function releaseAccountLegalHold(
  adapter: DatabaseAdapter,
  input: ReleaseLegalHoldInput
): Promise<ExecuteResult[]> {
  assertLegalHoldMutation(input);
  if (adapter.accountGovernanceMutations)
    return adapter.accountGovernanceMutations.releaseLegalHold(input);
  assertNativeGovernanceBackend(adapter);
  return (await adapter.batch(releaseLegalHoldPlan(input))).map((result) =>
    nativePointWriteResult(adapter, result)
  );
}

/** These reviewed statements target at most one row by a primary/unique key.
 * D1's aggregate changes includes native trigger writes; PostgreSQL returns direct row counts.
 * Normalize only this point-write contract, never an arbitrary DatabaseAdapter batch.
 */
function nativePointWriteResult(adapter: DatabaseAdapter, result: ExecuteResult): ExecuteResult {
  if (
    !result.success ||
    !Number.isSafeInteger(result.rowsAffected) ||
    result.rowsAffected < 0 ||
    (adapter.getType() !== 'd1' && result.rowsAffected > 1)
  )
    throw new Error('account_governance_write_failed');
  return adapter.getType() === 'd1'
    ? { ...result, rowsAffected: result.rowsAffected > 0 ? 1 : result.rowsAffected }
    : result;
}

function assertNativeGovernanceBackend(adapter: DatabaseAdapter): void {
  if (!['d1', 'postgres'].includes(adapter.getType()))
    throw new Error('account_governance_capability_required');
}

async function executeGuardedNativePlan(
  adapter: DatabaseAdapter,
  guard: PreparedStatement,
  statements: PreparedStatement[]
): Promise<ExecuteResult[]> {
  assertNativeGovernanceBackend(adapter);
  if (adapter.getType() === 'd1') {
    // D1's callback transaction is not atomic. Batch is atomic and each statement retains
    // the same authority predicates, evaluated without interleaving another writer.
    return (await adapter.batch([guard, ...statements]))
      .slice(1)
      .map((result) => nativePointWriteResult(adapter, result));
  }
  return adapter.transaction(async (tx) => {
    const guarded = await tx.execute(guard.sql, guard.params);
    if (!guarded.success) throw new Error('account_governance_guard_failed');
    if (guarded.rowsAffected !== 1)
      return statements.map(() => ({ success: true, rowsAffected: 0 }));
    const results = [];
    for (const statement of statements)
      results.push(await tx.execute(statement.sql, statement.params));
    if (results.some((result) => !result.success))
      throw new Error('account_governance_write_failed');
    return results;
  });
}

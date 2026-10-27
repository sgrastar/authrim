import type { DatabaseAdapter, PreparedStatement } from './adapter';

export interface RecordLastLoginInput {
  tenantId: string;
  userId: string;
  accountId: string;
  /** Stable across retries of this successful authentication observation. */
  operationId: string;
  observedAtMs: number;
}

/** Database-owned atomic operations whose native trigger effects must not be omitted. */
export interface ProtectedIdentityMutationCapability {
  readonly version: 'protected-identity-v1';
  recordLastLogin(input: RecordLastLoginInput): Promise<boolean>;
}

export function assertRecordLastLoginInput(input: RecordLastLoginInput): void {
  for (const value of [input.tenantId, input.userId, input.accountId, input.operationId]) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 512 ||
      [...value].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new Error('protected_identity_mutation_input_invalid');
    }
  }
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 1) {
    throw new Error('protected_identity_mutation_input_invalid');
  }
}

/**
 * A narrow, monotonic patch. It never rewrites lifecycle/display/registration fields
 * from a stale object, and never parses unrelated JSON numbers in JavaScript.
 * D1 and PostgreSQL retain their native atomic outbox/group trigger effects.
 */
export function recordLastLoginStatement(
  dialect: 'd1' | 'postgres',
  input: RecordLastLoginInput,
  table = 'identity_accounts'
): PreparedStatement {
  assertRecordLastLoginInput(input);
  if (!/^(?:identity_accounts|"authrim_[a-z0-9_]{1,55}"\."identity_accounts")$/u.test(table)) {
    throw new Error('protected_identity_table_invalid');
  }
  const metadata = "COALESCE(metadata_json, '{}')";
  const valid =
    dialect === 'postgres'
      ? `jsonb_typeof(${metadata}::jsonb) = 'object'`
      : `json_valid(${metadata}) AND json_type(${metadata}) = 'object'`;
  const prior =
    dialect === 'postgres'
      ? `CASE WHEN jsonb_typeof(${metadata}::jsonb->'last_login_at') = 'number'
        AND (${metadata}::jsonb->>'last_login_at') ~ '^[1-9][0-9]*$'
        THEN (${metadata}::jsonb->>'last_login_at')::numeric END`
      : `CASE WHEN json_type(${metadata}, '$.last_login_at') = 'integer'
        AND json_extract(${metadata}, '$.last_login_at') > 0
        THEN json_extract(${metadata}, '$.last_login_at') END`;
  // Avoid the JSONB '?' operator: adapters reserve '?' for positional parameters.
  const missing =
    dialect === 'postgres'
      ? `${metadata}::jsonb->'last_login_at' IS NULL`
      : `json_type(${metadata}, '$.last_login_at') IS NULL`;
  const patch =
    dialect === 'postgres'
      ? `jsonb_set(${metadata}::jsonb, '{last_login_at}', to_jsonb(CAST(? AS bigint)))::text`
      : `json_set(${metadata}, '$.last_login_at', CAST(? AS INTEGER))`;
  return {
    sql: `UPDATE ${table}
      SET metadata_json = ${patch},
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE tenant_id = ? AND legacy_user_id = ? AND id = ?
        AND lifecycle_state = 'active' AND directory_publication_state = 'active'
        AND ${valid} AND (${missing} OR (${prior}) < ?)`,
    params: [
      input.observedAtMs,
      input.observedAtMs,
      input.observedAtMs,
      input.tenantId,
      input.userId,
      input.accountId,
      input.observedAtMs,
    ],
  };
}

/** Actual shared repository entry point; unsupported adapters cannot silently omit protections. */
export async function recordCanonicalLastLogin(
  adapter: DatabaseAdapter,
  input: RecordLastLoginInput
): Promise<boolean> {
  assertRecordLastLoginInput(input);
  if (adapter.protectedIdentityMutations) {
    if (adapter.protectedIdentityMutations.version !== 'protected-identity-v1') {
      throw new Error('protected_identity_mutation_capability_invalid');
    }
    return adapter.protectedIdentityMutations.recordLastLogin(input);
  }
  const dialect = adapter.getType();
  if (dialect !== 'd1' && dialect !== 'postgres') {
    throw new Error('protected_identity_mutation_backend_unsupported');
  }
  const statement = recordLastLoginStatement(dialect, input);
  const result = await adapter.execute(statement.sql, statement.params);
  if (!result.success) throw new Error('protected_identity_mutation_result_unknown');
  return result.rowsAffected > 0;
}

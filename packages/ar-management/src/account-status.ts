/**
 * An end user's account status as the Admin API reads and sets it: the canonical account's
 * lifecycle state with its `metadata_json.status`, and the subject's lifecycle state.
 */
import {
  findCanonicalAccountAuthenticationState,
  initializeAccountAuthenticationFromAccount,
  readAccountAuthenticationState,
  transitionAccountAuthenticationState,
  type AccountAuthenticationLifecycle,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface CanonicalAccountStatus {
  id: string;
  lifecycle_state: string;
  status: string;
  /** The lifecycle transition the account last took (version and operation), when recorded. */
  lifecycle_version_ms: number | null;
  lifecycle_operation_id: string | null;
}

export async function getCanonicalAccountStatus(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<CanonicalAccountStatus | null> {
  const account = await adapter.queryOne<{
    id: string;
    lifecycle_state: string;
    metadata_json: string | null;
  }>(
    'SELECT id, lifecycle_state, metadata_json FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
    [userId, tenantId]
  );
  if (!account) return null;
  const metadata = parseJsonObject(account.metadata_json);
  return {
    id: account.id,
    lifecycle_state: account.lifecycle_state,
    status:
      typeof metadata.status === 'string'
        ? metadata.status
        : account.lifecycle_state === 'active'
          ? 'active'
          : account.lifecycle_state,
    lifecycle_version_ms:
      typeof metadata.lifecycle_version_ms === 'number' ? metadata.lifecycle_version_ms : null,
    lifecycle_operation_id:
      typeof metadata.lifecycle_operation_id === 'string' ? metadata.lifecycle_operation_id : null,
  };
}

const METADATA_KEY = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Sets an account's status and its subject's lifecycle together, as lifecycle transition
 * `operationId` of version `versionMs` (the one its authentication state took). An older
 * transition never overwrites a newer one, and another transition of the same version is refused
 * as the authentication state refuses it: the account changes only while its recorded version is
 * older, or the same with the same operation (a retry), and the subject only along with it.
 * Returns whether the account took this transition.
 */
export async function updateCanonicalAccountStatus(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  status: string,
  metadataPatch: Record<string, unknown> = {},
  versionMs: number,
  operationId: string
): Promise<boolean> {
  const lifecycleState = status === 'active' ? 'active' : status;
  const account = await adapter.queryOne<{ id: string; primary_subject_id: string | null }>(
    'SELECT id, primary_subject_id FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
    [userId, tenantId]
  );
  if (!account) return false;

  const paths: string[] = [
    "'$.status', ?",
    "'$.lifecycle_version_ms', ?",
    "'$.lifecycle_operation_id', ?",
  ];
  const values: unknown[] = [status, versionMs, operationId];
  for (const [key, value] of Object.entries(metadataPatch)) {
    if (!METADATA_KEY.test(key)) throw new Error('account_status_metadata_key_invalid');
    paths.push(`'$.${key}', ?`);
    values.push(value);
  }
  const versionOf = (column: string) =>
    `COALESCE(CAST(json_extract(${column}, '$.lifecycle_version_ms') AS INTEGER), 0)`;
  const operationOf = (column: string) => `json_extract(${column}, '$.lifecycle_operation_id')`;
  // Deletion only goes forward: an account being deleted or deleted is never set otherwise.
  const notDeleted =
    status === 'deleting' || status === 'deleted'
      ? '1 = 1'
      : "lifecycle_state NOT IN ('deleting', 'deleted')";
  const statements = [
    {
      sql: `UPDATE identity_accounts
               SET lifecycle_state = ?,
                   metadata_json = json_set(COALESCE(metadata_json, '{}'), ${paths.join(', ')}),
                   updated_at = ?
             WHERE id = ? AND tenant_id = ?
               AND ${notDeleted}
               AND (${versionOf('metadata_json')} < ?
                    OR (${versionOf('metadata_json')} = ? AND ${operationOf('metadata_json')} = ?))`,
      params: [
        lifecycleState,
        ...values,
        versionMs,
        account.id,
        tenantId,
        versionMs,
        versionMs,
        operationId,
      ],
    },
    ...(account.primary_subject_id
      ? [
          {
            sql: `UPDATE identity_subjects SET lifecycle_state = ?, updated_at = ?
                   WHERE id = ? AND tenant_id = ?
                     AND ${notDeleted}
                     AND EXISTS (
                       SELECT 1 FROM identity_accounts a
                        WHERE a.id = ? AND a.tenant_id = ?
                          AND a.lifecycle_state = ?
                          AND ${versionOf('a.metadata_json')} = ?
                          AND ${operationOf('a.metadata_json')} = ?
                     )`,
            params: [
              lifecycleState,
              versionMs,
              account.primary_subject_id,
              tenantId,
              account.id,
              tenantId,
              lifecycleState,
              versionMs,
              operationId,
            ],
          },
        ]
      : []),
  ];
  const results = await adapter.batch(statements);
  return (results[0]?.rowsAffected ?? 0) > 0;
}

/**
 * The authentication state refused a transition: an older one, another of the same version, or
 * one away from a deletion.
 */
export function isLifecycleTransitionRefused(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('account_authentication_lifecycle_stale') ||
      error.message.includes('account_authentication_lifecycle_conflict') ||
      error.message.includes('account_authentication_lifecycle_terminal'))
  );
}

/** Initializes the account's authentication state from the account, when it has none yet. */
export async function initializeFromAccount(
  env: Env,
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<void> {
  const state = await readAccountAuthenticationState(env, tenantId, userId);
  if (state.lifecycle !== null) return;
  const hydration = await findCanonicalAccountAuthenticationState(adapter, tenantId, userId);
  if (hydration) await initializeAccountAuthenticationFromAccount(env, tenantId, userId, hydration);
}

/**
 * One lifecycle transition of an end user's account, made the same way on every path, in the
 * order that keeps sign-in refused whenever the two disagree:
 *
 * - Suspending, locking or deactivating: the authentication state first (sign-in is refused and
 *   sessions revoked at once), then the account and its subject.
 * - Activating: the account and its subject first, then the authentication state, so sign-in is
 *   allowed only once both are active.
 *
 * Both refuse an older transition and another of the same version; the account and its subject
 * change only while no newer one did. Retrying the same operation finishes it, also when an
 * earlier attempt was taken under another version (the version that attempt recorded is used).
 *
 * `superseded`: a newer transition (or another of the same version) decides the account instead.
 * For an activation the account may already show active while the authentication state, holding
 * the other transition, still refuses sign-in: activating again settles both.
 */
export async function transitionAccountLifecycle(
  env: Env,
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    userId: string;
    /** The authentication state, and the account's status and lifecycle state. */
    lifecycle: AccountAuthenticationLifecycle;
    status: string;
    metadataPatch?: Record<string, unknown>;
    versionMs: number;
    operationId: string;
    revokeSessions: boolean;
  }
): Promise<'taken' | 'superseded'> {
  /** The authentication state takes it; null when it holds another transition. */
  const authentication = async (versionMs: number): Promise<number | null> => {
    try {
      await transitionAccountAuthenticationState(env, {
        tenantId: input.tenantId,
        userId: input.userId,
        lifecycle: input.lifecycle,
        sourceVersionMs: versionMs,
        operationId: input.operationId,
        revokeSessions: input.revokeSessions,
      });
      return versionMs;
    } catch (error) {
      if (!isLifecycleTransitionRefused(error)) throw error;
      // This very operation, taken before under another version: it stands.
      const state = await readAccountAuthenticationState(env, input.tenantId, input.userId);
      return state.lifecycleOperationId === input.operationId &&
        state.lifecycle === input.lifecycle &&
        state.lifecycleVersionMs !== null
        ? state.lifecycleVersionMs
        : null;
    }
  };
  /** The account and its subject take it; null when they hold another transition. */
  const account = async (versionMs: number): Promise<number | null> => {
    if (
      await updateCanonicalAccountStatus(
        adapter,
        input.tenantId,
        input.userId,
        input.status,
        input.metadataPatch,
        versionMs,
        input.operationId
      )
    ) {
      return versionMs;
    }
    const current = await getCanonicalAccountStatus(adapter, input.tenantId, input.userId);
    if (
      current?.lifecycle_operation_id === input.operationId &&
      current.lifecycle_version_ms !== null &&
      current.lifecycle_version_ms !== versionMs
    ) {
      // Taken before under another version: finish it as that one.
      return (await updateCanonicalAccountStatus(
        adapter,
        input.tenantId,
        input.userId,
        input.status,
        input.metadataPatch,
        current.lifecycle_version_ms,
        input.operationId
      ))
        ? current.lifecycle_version_ms
        : null;
    }
    return null;
  };

  if (input.lifecycle === 'active') {
    // An authentication state not initialized yet would start from the account, so once the
    // account is active it would allow sign-in even if the step below never ran: it starts from
    // the account as it is now, before the account changes.
    await initializeFromAccount(env, adapter, input.tenantId, input.userId);
    const taken = await account(input.versionMs);
    if (taken === null) return 'superseded';
    return (await authentication(taken)) === null ? 'superseded' : 'taken';
  }
  const taken = await authentication(input.versionMs);
  if (taken === null) return 'superseded';
  return (await account(taken)) === null ? 'superseded' : 'taken';
}

/**
 * Revoking a user's upstream identity provider tokens, as ar-management asks ar-bridge to before a
 * PII-only deletion erases them (`DELETE /api/admin/users/:id/pii`).
 *
 * The call is internal: ar-management calls the RPC on ar-bridge's named
 * `ExternalIdpAdminEntrypoint` (props-authenticated, bound only by ar-management) with the tenant
 * and the user only. ar-bridge reads the user's active linked identities, decrypts their stored
 * tokens and revokes them at each provider (RFC 7009); no token value crosses the binding, and
 * the answer holds no token, linked identity id or provider subject.
 *
 * It is best-effort and time-boxed (`timeoutMs`, for the whole call; the identities run side by
 * side): a revocation not done by the deadline is answered `timed_out` (its provider requests
 * are aborted then), as is one not started by then. The caller
 * never fails the deletion on any answer, nor on the call failing.
 */

/** The time limit when nothing is configured (`external_idp.token_revocation_timeout_ms`). */
export const DEFAULT_EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS = 3000;
export const MIN_EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS = 500;
export const MAX_EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS = 10000;

/** A time limit within the allowed range (anything else: the default). */
export function normalizeExternalIdpTokenRevocationTimeoutMs(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS &&
    value <= MAX_EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS
    ? value
    : DEFAULT_EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS;
}

/**
 * The error message of a call that ran out of time before it had read the user's identities
 * (an RPC error keeps its message): not an empty answer, which means nothing to revoke.
 */
export const USER_TOKEN_REVOCATION_TIMED_OUT = 'user_token_revocation_timed_out';

export interface RevokeUserLinkedIdentityTokensInput {
  schemaVersion: 1;
  tenantId: string;
  userId: string;
  /** Time limit for the revocations, in milliseconds (normalized by the callee). */
  timeoutMs: number;
}

export type LinkedIdentityTokenRevocationOutcome =
  /** Every stored token was revoked. */
  | 'revoked'
  /** One of the stored tokens was revoked, the other was not. */
  | 'partially_revoked'
  /** The provider has no revocation endpoint: the tokens stay valid until they expire. */
  | 'not_supported'
  /** The provider refused, could not be reached, or is no longer configured. */
  | 'failed'
  /** Not done by the deadline (aborted, or not started): the provider may or may not have it. */
  | 'timed_out';

export interface LinkedIdentityTokenRevocationEntry {
  /** The tenant's provider configuration id (not the person's subject at the provider). */
  providerId: string;
  outcome: LinkedIdentityTokenRevocationOutcome;
}

export interface RevokeUserLinkedIdentityTokensResult {
  schemaVersion: 1;
  /** One entry per active linked identity that held a stored token. */
  identities: LinkedIdentityTokenRevocationEntry[];
}

/** ar-bridge's admin entrypoint as ar-management binds it: the admin fetch and this one RPC. */
export type ExternalIdpAdminServiceBinding = Fetcher & {
  revokeUserLinkedIdentityTokens(
    input: RevokeUserLinkedIdentityTokensInput
  ): Promise<RevokeUserLinkedIdentityTokensResult>;
};

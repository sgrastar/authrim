/**
 * Revoking the user's upstream identity provider tokens before a PII-only deletion erases them
 * (`DELETE /api/admin/users/:id/pii`).
 *
 * The erasure nulls the linked identities' stored tokens; a grant left at the provider then stays
 * valid until it expires and can no longer be revoked. So ar-bridge revokes them first, through
 * its admin entrypoint's RPC (`EXTERNAL_IDP_ADMIN.revokeUserLinkedIdentityTokens`), given the
 * tenant and the user only: ar-bridge reads and decrypts the tokens itself, and this side never
 * holds one (it only checks whether any is stored, to skip the call when none is).
 *
 * Best-effort, as decided for this deletion: a revocation that fails, is not supported by the
 * provider, or is not done within the time limit (`external_idp.token_revocation_timeout_ms`:
 * KV, then the environment variable, then the default; for the whole call, the identities run
 * side by side) never stops or fails the deletion. What happened is returned as a summary (counts by
 * outcome, no token, linked identity id or provider subject) for the deletion's audit entry.
 */
import {
  EXTERNAL_IDP_SETTINGS_META,
  normalizeExternalIdpTokenRevocationTimeoutMs,
  readSettingEnvValue,
  resolveEffectiveSettings,
  USER_TOKEN_REVOCATION_TIMED_OUT,
  type DatabaseAdapter,
  type Env,
  type LinkedIdentityTokenRevocationOutcome,
} from '@authrim/ar-lib-core';

export type UpstreamTokenRevocationStatus =
  /** No active linked identity holds a stored token: nothing to revoke, no call made. */
  | 'no_tokens'
  /** Every stored token was revoked. */
  | 'completed'
  /** ar-bridge answered, but not every identity's tokens were revoked (see the counts). */
  | 'incomplete'
  /** ar-bridge is not bound (the bridge component is not deployed). */
  | 'unavailable'
  /** ar-bridge did not answer within the time limit. */
  | 'timed_out'
  /** The call to ar-bridge failed. */
  | 'failed';

export interface UpstreamTokenRevocationSummary {
  status: UpstreamTokenRevocationStatus;
  /** Linked identities that held a stored token, as ar-bridge reported them. */
  identities: number;
  outcomes: Partial<Record<LinkedIdentityTokenRevocationOutcome, number>>;
}

/** Added to the time limit for the whole call (ar-bridge's reads and the binding itself). */
const CALL_GRACE_MS = 2000;

const STATUS_SEVERITY: readonly UpstreamTokenRevocationStatus[] = [
  'no_tokens',
  'completed',
  'incomplete',
  'unavailable',
  'timed_out',
  'failed',
];

const KNOWN_OUTCOMES: ReadonlySet<unknown> = new Set<LinkedIdentityTokenRevocationOutcome>([
  'revoked',
  'partially_revoked',
  'not_supported',
  'failed',
  'timed_out',
]);

interface RevocationLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Whether an active linked identity of the user holds a stored token (its ciphertext only). */
export async function hasStoredUpstreamTokens(
  pii: DatabaseAdapter,
  input: { tenantId: string; userId: string }
): Promise<boolean> {
  const row = await pii.queryOne<{ upstream_token_identity: number }>(
    `SELECT 1 AS upstream_token_identity FROM linked_identities
      WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active'
        AND (access_token_encrypted IS NOT NULL OR refresh_token_encrypted IS NOT NULL)
      LIMIT 1`,
    [input.tenantId, input.userId],
    { consistencyClass: 'primary_required' }
  );
  return Boolean(row);
}

async function resolveRevocationTimeoutMs(env: Env, tenantId: string): Promise<number> {
  try {
    const values = await resolveEffectiveSettings(env, 'external-idp', { tenantId });
    return normalizeExternalIdpTokenRevocationTimeoutMs(
      values['external_idp.token_revocation_timeout_ms']
    );
  } catch {
    // The tenant's settings could not be read: the environment variable (parsed as the
    // settings resolution parses it), else the default.
    return normalizeExternalIdpTokenRevocationTimeoutMs(
      readSettingEnvValue(
        env as unknown as Record<string, unknown>,
        EXTERNAL_IDP_SETTINGS_META['external_idp.token_revocation_timeout_ms']
      )
    );
  }
}

const CALL_TIMED_OUT = Symbol('call_timed_out');

/**
 * Revoke the user's stored upstream tokens, best-effort and time-limited. Never throws: every
 * failure is the returned summary (and a warning without token values).
 */
export async function revokeUpstreamTokensBeforeErasure(
  env: Env,
  pii: DatabaseAdapter,
  input: { tenantId: string; userId: string },
  log: RevocationLogger
): Promise<UpstreamTokenRevocationSummary> {
  const summary = (
    status: UpstreamTokenRevocationStatus,
    identities = 0,
    outcomes: UpstreamTokenRevocationSummary['outcomes'] = {}
  ): UpstreamTokenRevocationSummary => ({ status, identities, outcomes });
  try {
    if (!(await hasStoredUpstreamTokens(pii, input))) return summary('no_tokens');
    const bridge = env.EXTERNAL_IDP_ADMIN;
    if (typeof bridge?.revokeUserLinkedIdentityTokens !== 'function') {
      log.warn('Upstream tokens erased without revocation: the bridge is not bound');
      return summary('unavailable');
    }
    const timeoutMs = await resolveRevocationTimeoutMs(env, input.tenantId);
    const call = Promise.resolve(
      bridge.revokeUserLinkedIdentityTokens({
        schemaVersion: 1,
        tenantId: input.tenantId,
        userId: input.userId,
        timeoutMs,
      })
    );
    // The call is not awaited past the deadline; a later rejection is not unhandled.
    call.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof CALL_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(CALL_TIMED_OUT), timeoutMs + CALL_GRACE_MS);
    });
    let answer: Awaited<typeof call> | typeof CALL_TIMED_OUT;
    try {
      answer = await Promise.race([call, deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (answer === CALL_TIMED_OUT) {
      log.warn('Upstream token revocation did not answer in time; erasing anyway', {
        timeoutMs,
      });
      return summary('timed_out');
    }
    if (!answer || answer.schemaVersion !== 1 || !Array.isArray(answer.identities)) {
      throw new Error('upstream_token_revocation_answer_invalid');
    }
    const outcomes: UpstreamTokenRevocationSummary['outcomes'] = {};
    for (const entry of answer.identities) {
      // An outcome this side does not know is not taken for a revocation.
      const outcome = KNOWN_OUTCOMES.has(entry?.outcome) ? entry.outcome : 'failed';
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    const identities = answer.identities.length;
    const complete = (outcomes.revoked ?? 0) === identities;
    if (!complete) {
      log.warn('Some upstream tokens were erased without being revoked', {
        identities,
        outcomes,
      });
    }
    return summary(complete ? 'completed' : 'incomplete', identities, outcomes);
  } catch (error) {
    if (error instanceof Error && error.message === USER_TOKEN_REVOCATION_TIMED_OUT) {
      log.warn('Upstream token revocation did not read the identities in time; erasing anyway');
      return summary('timed_out');
    }
    log.warn('Upstream token revocation failed; erasing anyway', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return summary('failed');
  }
}

/** Both passes' summaries as one (the second pass only revokes tokens stored since the first). */
export function mergeUpstreamTokenRevocationSummaries(
  first: UpstreamTokenRevocationSummary,
  second: UpstreamTokenRevocationSummary | null
): UpstreamTokenRevocationSummary {
  if (!second || second.status === 'no_tokens') return first;
  if (first.status === 'no_tokens') return second;
  const outcomes = { ...first.outcomes };
  for (const [outcome, count] of Object.entries(second.outcomes) as Array<
    [LinkedIdentityTokenRevocationOutcome, number]
  >) {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + count;
  }
  const status =
    STATUS_SEVERITY.indexOf(second.status) > STATUS_SEVERITY.indexOf(first.status)
      ? second.status
      : first.status;
  return { status, identities: first.identities + second.identities, outcomes };
}

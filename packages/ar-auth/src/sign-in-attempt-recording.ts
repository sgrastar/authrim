/**
 * Recording failed sign-in attempts against their Flow interaction (see ar-lib-core
 * sign-in-attempts).
 *
 * A start step (passkey or TOTP options, email code send) is told the interaction by the Login UI
 * in the `X-Authrim-Interaction-Id` header. It keeps the interaction with its challenge only when
 * it is a live interaction of the tenant. The verify step reads it from the consumed
 * challenge alone: nothing a request sends at verify time can point a failure at another
 * interaction. Recording runs after the response and never fails a sign-in.
 */
import type { Context } from 'hono';
import {
  SIGN_IN_ATTEMPT_INTERACTION_HEADER,
  SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY,
  createAuthContextFromHono,
  getLogger,
  loadInvestigationSubjectHmacKeysFromEnv,
  recordSignInAttemptFailure,
  resolveSignInAttemptInteraction,
  signInAttemptInteractionFromMetadata,
  type Env,
  type InvestigationSubjectHmacKeys,
  type SignInAttemptMethod,
  type SignInAttemptReasonCode,
} from '@authrim/ar-lib-core';

/**
 * The challenge metadata naming the interaction this start step was told about (the header, or
 * the interaction a start body already carries), when it is a live interaction of the tenant;
 * empty otherwise. The start step's client is not compared: the Login UI signs in as its own
 * Direct Auth client, while the interaction belongs to the relying party's client.
 */
export async function signInAttemptInteractionMetadata(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  bodyInteractionId?: string | null
): Promise<Record<string, string>> {
  const interactionId = bodyInteractionId ?? c.req.header(SIGN_IN_ATTEMPT_INTERACTION_HEADER);
  if (!interactionId) return {};
  try {
    const validated = await resolveSignInAttemptInteraction(
      createAuthContextFromHono(c, tenantId).coreAdapter,
      { tenantId, interactionId }
    );
    return validated ? { [SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY]: validated } : {};
  } catch {
    // An attempt that cannot be tied to its interaction is just not recorded.
    return {};
  }
}

function investigationKeys(c: Context<{ Bindings: Env }>): InvestigationSubjectHmacKeys | null {
  try {
    return loadInvestigationSubjectHmacKeysFromEnv(c.env);
  } catch {
    getLogger(c)
      .module('SIGN-IN-ATTEMPTS')
      .warn('Investigation keyring is malformed; attempts are recorded without subject hashes');
    return null;
  }
}

/**
 * Records a failed attempt of the challenge's interaction after the response. Does nothing when
 * the challenge was not tied to an interaction.
 */
export function scheduleSignInAttemptFailure(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    metadata: Record<string, unknown> | null | undefined;
    method: SignInAttemptMethod;
    reasonCode: SignInAttemptReasonCode;
    userId?: string | null;
  }
): void {
  const interactionId = signInAttemptInteractionFromMetadata(input.metadata);
  if (!interactionId) return;
  const recording = (async () => {
    await recordSignInAttemptFailure(
      createAuthContextFromHono(c, input.tenantId).coreAdapter,
      investigationKeys(c),
      {
        tenantId: input.tenantId,
        interactionId,
        method: input.method,
        reasonCode: input.reasonCode,
        userId: input.userId && input.userId !== 'unknown' ? input.userId : null,
      }
    );
  })().catch((error: unknown) => {
    // The error's type only: a database error can quote what it was given.
    getLogger(c)
      .module('SIGN-IN-ATTEMPTS')
      .warn('Failed to record a failed sign-in attempt', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
  });
  try {
    c.executionCtx.waitUntil(recording);
  } catch {
    // No execution context (tests, local tools): the recording runs on its own.
  }
}

/**
 * A recorder for one verify step: `failed(response, reason, userId?)` records the failure and
 * returns the response unchanged. `knownUserId` is the account the step already knows from its
 * challenge: every failure is recorded with it unless the call names another (`null`: none), so
 * no failure of a known account is left out of its attempts.
 */
export function signInAttemptFailureRecorder(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  metadata: Record<string, unknown> | null | undefined,
  method: SignInAttemptMethod,
  knownUserId: string | null = null
) {
  return <T>(response: T, reasonCode: SignInAttemptReasonCode, userId?: string | null): T => {
    scheduleSignInAttemptFailure(c, {
      tenantId,
      metadata,
      method,
      reasonCode,
      userId: userId === undefined ? knownUserId : userId,
    });
    return response;
  };
}

/**
 * Why the account's authentication state refused a verified proof: a replayed passkey counter or
 * TOTP time step, or an account that may not sign in (suspended, locked, being deleted).
 */
export function accountAuthenticationDenialReason(error: unknown): SignInAttemptReasonCode {
  const message = error instanceof Error ? error.message : '';
  return message === 'passkey_counter_replay' || message === 'totp_time_step_replay'
    ? 'replay_detected'
    : 'account_unavailable';
}

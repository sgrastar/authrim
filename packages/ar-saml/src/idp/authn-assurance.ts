/**
 * Authentication assurance (AAL) in the SAML IdP: the AAL a sign-in must have for an
 * AuthnRequest, sending the person to authenticate again when it falls short (a step-up), and the
 * AuthnContextClassRef the assertion carries for the AAL reached.
 *
 * The AAL required is the higher of
 * - the SP's own minimum (`SAMLSPConfig.minimumAal`, which applies whether or not tenant-wide
 *   assurance is on), and
 * - the AAL of the AuthnContextClassRef the request asks for (RequestedAuthnContext), through the
 *   tenant's table `assurance.saml_authn_context_aal` (only while `assurance.enabled`; see
 *   authn-context-assurance.ts for how Comparison is read).
 * Where neither applies nothing is read and nothing changes.
 *
 * The AAL reached comes from the evidence the session records, as for an OIDC authorization
 * (evaluateSessionAssurance): after a step-up, only a session proven after the step-up began
 * counts, and it is combined with the factors of the session the person stepped up from.
 *
 * A sign-in below the requirement is sent to authenticate again once. The step-up is recorded in
 * the stored request (`assuranceStepUp`), so when the person comes back and still falls short, the
 * answer is NoAuthnContext, not another trip to the login page. A passive request is never sent
 * (NoPassive). Nothing here says the AAL a person holds or an SP requires in a response.
 */

import {
  evaluateSessionAssurance,
  getSessionStoreBySessionId,
  isAAL,
  isShardedSessionId,
  maxAAL,
  meetsAAL,
  parseSAMLAuthnContextAAL,
  parseUpstreamAcrMappings,
  readMinimumAAL,
  resolveEffectiveSettings,
  type AAL,
  type AssuranceLevel,
  type Env,
  type SAMLAuthnRequest,
  type SAMLRequestContext,
  type SAMLSPConfig,
} from '@authrim/ar-lib-core';
import {
  resolveSAMLAssuranceAuthnContext,
  selectSAMLAssuranceClassRef,
  type SAMLClassRefGuard,
  type SAMLRequestedAssurance,
} from './authn-context-assurance';

/** The session being answered from: whose it is, and what it records of the authentication. */
export interface SAMLAssuranceSession {
  userId: string;
  sessionId: string;
  /** The session's data (amr, unverified_amr, upstream_acr, proven_at, ...). */
  data?: Record<string, unknown>;
}

/** What checking a sign-in against the AAL a request requires found. */
export type SAMLAuthnAssuranceCheck =
  /** Nothing requires an AAL, and no class reference of the assertion depends on one. */
  | { outcome: 'not_required' }
  | {
      outcome: 'met';
      aal: AssuranceLevel;
      /**
       * What the class reference finally put in the assertion is checked against: the AAL reached
       * and the tenant's table (empty while assurance levels are off).
       */
      guard: SAMLClassRefGuard;
      /**
       * The class reference to put in the assertion (SPs in `assurance` mode, when the table has
       * one that fits); undefined leaves the choice to the existing handling.
       */
      classRef?: string;
      /** The stored request's step-up, with the session it was verified against. */
      assuranceStepUp?: NonNullable<SAMLRequestContext['assuranceStepUp']>;
    }
  /** Authenticate again, combining this session's factors with the new sign-in's. */
  | { outcome: 'step_up'; requiredAal: AAL; priorSessionId: string; actual: AssuranceLevel }
  /** The request is passive: the person cannot be sent to authenticate again. */
  | { outcome: 'no_passive'; requiredAal: AAL; actual: AssuranceLevel }
  /** The requirement cannot be met (again): NoAuthnContext. */
  | {
      outcome: 'insufficient';
      reason: 'unsatisfiable' | 'step_up_unmet' | 'no_class_ref' | 'session_ended';
      requiredAal: AAL | null;
      actual?: AssuranceLevel;
    }
  /** The settings could not be read: neither met nor insufficient. */
  | { outcome: 'unavailable'; error: unknown };

/**
 * When a session last recorded a proof of authentication (milliseconds): the later of its proof
 * time (`proven_at`) and that of a re-authentication since (`reauth_proven_at`). Undefined when it
 * records neither, as an external IdP's login does not (its times are in that IdP's clock).
 */
export function sessionProvenAt(data: Record<string, unknown> | undefined): number | undefined {
  const times = [data?.proven_at, data?.reauth_proven_at].filter(
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  );
  return times.length > 0 ? Math.max(...times) : undefined;
}

/** The step-up a stored request records, as far as it can be trusted to be one. */
export function readSAMLAssuranceStepUp(
  context: SAMLRequestContext | undefined
): NonNullable<SAMLRequestContext['assuranceStepUp']> | undefined {
  const stepUp = context?.assuranceStepUp as Record<string, unknown> | undefined;
  if (!stepUp || typeof stepUp !== 'object') return undefined;
  if (typeof stepUp.issuedAt !== 'number' || !Number.isSafeInteger(stepUp.issuedAt)) {
    return undefined;
  }
  // A step-up whose target cannot be read still counts as one tried (never again).
  const completed = stepUp.completed as { sessionId?: unknown; aal?: unknown } | undefined;
  return {
    issuedAt: stepUp.issuedAt,
    priorSessionId:
      typeof stepUp.priorSessionId === 'string' && isShardedSessionId(stepUp.priorSessionId)
        ? stepUp.priorSessionId
        : undefined,
    requiredAal: isAAL(stepUp.requiredAal) ? stepUp.requiredAal : 'AAL3',
    ...(completed && typeof completed.sessionId === 'string' && isAAL(completed.aal)
      ? { completed: { sessionId: completed.sessionId, aal: completed.aal } }
      : {}),
  };
}

export async function checkSAMLAuthnAssurance(input: {
  env: Env;
  tenantId: string;
  /** The request answered; an IdP-initiated sign-in has none (`{}`). */
  authnRequest: Pick<SAMLAuthnRequest, 'requestedAuthnContext' | 'isPassive'>;
  spConfig: Pick<SAMLSPConfig, 'minimumAal' | 'authnContextClassRefMode'>;
  session: SAMLAssuranceSession;
  /** The context the stored request carried back, when it was resumed. */
  requestContext?: SAMLRequestContext;
  onUnrecorded?: () => void;
  now?: () => number;
}): Promise<SAMLAuthnAssuranceCheck> {
  const { authnRequest, session } = input;
  // A stored minimum that is not a level counts as the highest, never as none.
  const spMinimum = readMinimumAAL(input.spConfig.minimumAal);
  const requestedRefs = authnRequest.requestedAuthnContext?.authnContextClassRef ?? [];
  const assuranceMode = input.spConfig.authnContextClassRefMode === 'assurance';
  if (!spMinimum && requestedRefs.length === 0 && !assuranceMode) {
    return { outcome: 'not_required' };
  }

  let settings: Record<string, unknown>;
  try {
    settings = await resolveEffectiveSettings(input.env, 'assurance', {
      tenantId: input.tenantId,
    });
  } catch (error) {
    return { outcome: 'unavailable', error };
  }
  // The tenant's table and mappings apply while assurance is on.
  const enabled = settings['assurance.enabled'] === true;
  const classRefAal = enabled
    ? parseSAMLAuthnContextAAL(settings['assurance.saml_authn_context_aal'])
    : {};
  const hasTable = Object.keys(classRefAal).length > 0;
  const request: SAMLRequestedAssurance =
    hasTable && requestedRefs.length > 0
      ? resolveSAMLAssuranceAuthnContext({
          requested: authnRequest.requestedAuthnContext,
          classRefAal,
        })
      : { kind: 'unmapped' };

  if (request.kind === 'mapped' && request.unsatisfiable) {
    return { outcome: 'insufficient', reason: 'unsatisfiable', requiredAal: null };
  }
  const requestRequired = request.kind === 'mapped' ? request.requiredAal : null;
  const required: AAL | null =
    spMinimum && requestRequired
      ? (maxAAL(spMinimum, requestRequired) as AAL)
      : (spMinimum ?? requestRequired);
  const selectsClassRef = assuranceMode && hasTable;
  // A request that names a reference of the table is judged even when it needs no AAL (a
  // `maximum` one): the reference finally issued is checked against the AAL reached.
  if (!required && !selectsClassRef && request.kind !== 'mapped') {
    return { outcome: 'not_required' };
  }

  // What the session proves. A request that came back from a step-up counts only a session proven
  // after it began; one already verified against that step-up (it returned through the
  // attribute release consent screen, the session holding the combined evidence by now) is not
  // judged again on what a combined session records.
  const stepUp = readSAMLAssuranceStepUp(input.requestContext);
  let actual: AssuranceLevel;
  let assuranceStepUp: NonNullable<SAMLRequestContext['assuranceStepUp']> | undefined;
  if (stepUp?.completed && stepUp.completed.sessionId === session.sessionId) {
    actual = stepUp.completed.aal;
    assuranceStepUp = stepUp;
  } else {
    const evaluation = await evaluateSessionAssurance({
      sessionId: session.sessionId,
      sessionData: session.data,
      sessionDataUserId: session.userId,
      sessionUserId: session.userId,
      upstreamAcrMappings: enabled
        ? parseUpstreamAcrMappings(settings['assurance.upstream_acr_mappings'])
        : {},
      reauthIssuedAt: stepUp?.issuedAt,
      stepUp: stepUp
        ? { issuedAt: stepUp.issuedAt, priorSessionId: stepUp.priorSessionId }
        : undefined,
      getSessionStore: (id) => getSessionStoreBySessionId(input.env, id, input.tenantId).stub,
      onUnrecorded: input.onUnrecorded,
      now: input.now,
    });
    if (evaluation.sessionEnded) {
      return { outcome: 'insufficient', reason: 'session_ended', requiredAal: required };
    }
    actual = evaluation.aal;
    // Recorded only for a level the request can rely on (not AAL0).
    if (stepUp && actual !== 'AAL0') {
      assuranceStepUp = { ...stepUp, completed: { sessionId: session.sessionId, aal: actual } };
    } else {
      assuranceStepUp = stepUp;
    }
  }

  if (required && !meetsAAL(actual, required)) {
    // No sign-in can be asked for in a passive request.
    if (authnRequest.isPassive) return { outcome: 'no_passive', requiredAal: required, actual };
    // Sent once; a sign-in that still falls short is not sent again.
    if (stepUp)
      return { outcome: 'insufficient', reason: 'step_up_unmet', requiredAal: required, actual };
    return { outcome: 'step_up', requiredAal: required, priorSessionId: session.sessionId, actual };
  }

  let classRef: string | undefined;
  if (selectsClassRef) {
    // An assertion in assurance mode carries the class reference of the AAL reached. A request
    // for references the table does not list is answered as before.
    const unmappedRequest = request.kind === 'unmapped' && requestedRefs.length > 0;
    if (!unmappedRequest) {
      classRef = selectSAMLAssuranceClassRef({ actual, classRefAal, request }) ?? undefined;
      if (!classRef && request.kind === 'mapped') {
        return { outcome: 'insufficient', reason: 'no_class_ref', requiredAal: required, actual };
      }
    }
  }
  return {
    outcome: 'met',
    aal: actual,
    guard: { reached: actual, classRefAal, request },
    ...(classRef ? { classRef } : {}),
    ...(assuranceStepUp ? { assuranceStepUp } : {}),
  };
}

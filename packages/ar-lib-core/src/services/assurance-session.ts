/**
 * What a session proves about the authentication behind it (NIST SP 800-63B AAL), for the
 * protocols that answer an authentication request from a session: OIDC authorize and the SAML IdP.
 *
 * `evaluateSessionAssurance` reads the evidence the session records (`sessionAssuranceEvidence`),
 * decides whether it counts for the request, and, when the request came back from a step-up,
 * combines it with the factors of the session the user stepped up from (one authentication, two
 * factors) and records the combination in the session. It does not decide what a request requires,
 * nor where to send a user who falls short: both differ per protocol, and stay with the caller.
 *
 * - Only the session of the user being authorized counts (`ownSession`): a cookie may carry
 *   another user's session.
 * - After a re-authentication was asked for (`reauthIssuedAt`), only a session proven after it is
 *   its result; an older session of the user (switched in by cookie) counts for nothing. A login
 *   that records no proof time (an external IdP's: its times are in that IdP's clock) never counts.
 * - A completed step-up combines only with the earlier session when that is still the user's live
 *   session and the current one records that its authentication was proven after the step-up began
 *   (`proven_at`, milliseconds; a session without it is never combined).
 * - The combination is written only over the evidence this call read (`ifDataMatches`): a
 *   concurrent step-up of the same session keeps its own factors, which are merged rather than
 *   replaced. A session that ended meanwhile ends the evaluation (`sessionEnded`).
 */

import type { AAL } from '../types/settings/assurance-levels';
import type { Session, SessionData } from '../durable-objects/SessionStore';
import {
  computeAAL,
  mergeStepUpEvidence,
  sessionAssuranceEvidence,
  type AssuranceLevel,
  type AuthenticationEvidence,
} from './assurance';

/** The part of a session store this needs (the SessionStore Durable Object's RPC methods). */
export interface SessionAssuranceStore {
  getSessionRpc(sessionId: string): Promise<unknown>;
  updateSessionDataRpc(
    sessionId: string,
    dataUpdates: Partial<SessionData>,
    options?: { ifDataMatches?: Partial<SessionData> }
  ): Promise<unknown>;
}

export interface EvaluateSessionAssuranceInput {
  /** The session cookie's session id, when there is one. */
  sessionId?: string;
  /** The session's data (amr, unverified_amr, upstream_acr, proven_at, ...). */
  sessionData?: Record<string, unknown>;
  /** The user the session belongs to. */
  sessionDataUserId?: string;
  /** The user being authorized (for a confirmation: the user it names). */
  sessionUserId: string;
  /** `assurance.upstream_acr_mappings`, parsed. */
  upstreamAcrMappings: Readonly<Record<string, AAL>>;
  /**
   * When a re-authentication was asked for (milliseconds): only a session proven after it is its
   * result. Undefined: no re-authentication was asked for.
   */
  reauthIssuedAt?: number;
  /**
   * The step-up this request came back from, if it did: when it began (milliseconds) and the
   * session the user stepped up from. Pass it only for a request that came back from one.
   */
  stepUp?: { issuedAt: number; priorSessionId?: string };
  /** The store of a session, for reading the earlier session and recording the combination. */
  getSessionStore(sessionId: string): SessionAssuranceStore;
  /** The current time in milliseconds. */
  now?: () => number;
  /** The combination could not be recorded in the session (this call's own evidence stands). */
  onUnrecorded?: () => void;
}

export type SessionAssuranceEvaluation =
  /** The session ended while the step-up was being combined: nothing it proved may be used. */
  | { sessionEnded: true }
  | {
      sessionEnded?: false;
      /** The session belongs to the user being authorized. */
      ownSession: boolean;
      /** Whether the session's evidence counts for this authentication. */
      evidenceSession: boolean;
      /** The session's proof time (milliseconds), when it records one. */
      provenAt: number | undefined;
      /** What the authentication proved: the session's, combined with the earlier one's if stepped up. */
      evidence: AuthenticationEvidence;
      /** The AAL of that evidence. */
      aal: AssuranceLevel;
      /** The methods of the combined evidence, when a step-up was combined (else undefined). */
      combinedAmr?: string[];
    };

/** Whether the session was proven (as a whole) at or after the step-up began. */
function reauthResultOfStepUp(provenAt: number | undefined, stepUp: { issuedAt: number }): boolean {
  return provenAt !== undefined && provenAt >= stepUp.issuedAt;
}

/**
 * The method(s) a session's latest re-authentication proved and when (milliseconds), as the
 * server recorded them (`reauth_proven_amr`, `reauth_proven_at`), or undefined when it has none.
 */
function sessionReauthPair(
  data: Record<string, unknown> | undefined
): { amr: string[]; at: number } | undefined {
  const at = data?.reauth_proven_at;
  const amr = data?.reauth_proven_amr;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || !Array.isArray(amr)) {
    return undefined;
  }
  const methods = amr.filter((method): method is string => typeof method === 'string');
  return methods.length > 0 ? { amr: methods, at } : undefined;
}

export async function evaluateSessionAssurance(
  input: EvaluateSessionAssuranceInput
): Promise<SessionAssuranceEvaluation> {
  const { sessionId, sessionData, upstreamAcrMappings } = input;
  const ownSession = input.sessionDataUserId === input.sessionUserId;
  const provenAt = typeof sessionData?.proven_at === 'number' ? sessionData.proven_at : undefined;
  // After a re-authentication, only a session proven after it was asked for is its result: an
  // older session of the user (switched in by cookie) counts for nothing. An external IdP login
  // records no proof time (its IdP's times are in that IdP's clock), so it never counts here.
  const reauthResult =
    input.reauthIssuedAt === undefined ||
    (provenAt !== undefined && provenAt >= input.reauthIssuedAt);
  const evidenceSession = ownSession && reauthResult;
  let evidence = sessionAssuranceEvidence(
    evidenceSession ? sessionData : undefined,
    upstreamAcrMappings
  );
  let combinedAmr: string[] | undefined;

  // A completed step-up: the factors the earlier session had proven, with the one just completed,
  // provided the earlier session is still that user's live session and the current one records
  // that its authentication was proven after the step-up began (proven_at, milliseconds; a
  // session without it is never combined).
  const stepUp = input.stepUp;

  /**
   * Records the combined evidence in the session, written only over what this call read: another
   * step-up of the same session may have combined its own factors meanwhile, and those are kept
   * rather than replaced. Returns false when the session ended meanwhile.
   */
  const recordCombination = async (
    combined: AuthenticationEvidence,
    combinedProvenAt: number,
    initialReauthProof: Record<string, unknown>
  ): Promise<boolean> => {
    const store = input.getSessionStore(sessionId as string);
    let read = sessionData;
    let stored = combined;
    let storedProvenAt = combinedProvenAt;
    let written = false;
    let ownReauthProof = initialReauthProof;
    for (let attempt = 0; attempt < 3 && !written; attempt++) {
      const updates = {
        amr: [...stored.amr],
        unverified_amr: [...(stored.unverifiedMethods ?? [])],
        ...(stored.upstreamAcr ? { upstream_acr: stored.upstreamAcr } : {}),
        proven_at: storedProvenAt,
        ...ownReauthProof,
      };
      const updated = (await store.updateSessionDataRpc(sessionId as string, updates, {
        ifDataMatches: {
          amr: read?.amr,
          unverified_amr: read?.unverified_amr,
          upstream_acr: read?.upstream_acr,
          proven_at: read?.proven_at,
          // Writing its own pair, a re-authentication completed meanwhile (a newer pair) must
          // fail the write rather than be replaced; without one, the newer pair is merged over.
          ...('reauth_proven_at' in ownReauthProof
            ? {
                reauth_proven_amr: read?.reauth_proven_amr,
                reauth_proven_at: read?.reauth_proven_at,
              }
            : {}),
        } as Partial<SessionData>,
      })) as Session | null;
      if (!updated) {
        // The session ended meanwhile: nothing it proved may be used.
        return false;
      }
      const latest = updated.data as Record<string, unknown> | undefined;
      written = Object.entries(updates).every(
        ([field, value]) => JSON.stringify(latest?.[field]) === JSON.stringify(value)
      );
      if (!written) {
        read = latest;
        if (typeof latest?.reauth_proven_at === 'number') ownReauthProof = {};
        stored = mergeStepUpEvidence(
          sessionAssuranceEvidence(latest, upstreamAcrMappings),
          combined
        );
        storedProvenAt = Math.min(
          typeof latest?.proven_at === 'number' ? latest.proven_at : 0,
          combinedProvenAt
        );
      }
    }
    if (!written) {
      // This request's own evidence stands; the session keeps what was written last.
      input.onUnrecorded?.();
    }
    return true;
  };

  if (stepUp && sessionId && ownSession && provenAt !== undefined && provenAt >= stepUp.issuedAt) {
    const priorSessionId = stepUp.priorSessionId;
    if (priorSessionId && priorSessionId !== sessionId) {
      const now = input.now ?? Date.now;
      const prior = (await input
        .getSessionStore(priorSessionId)
        .getSessionRpc(priorSessionId)) as Session | null;
      if (prior && prior.userId === input.sessionUserId && prior.expiresAt > now()) {
        evidence = mergeStepUpEvidence(
          sessionAssuranceEvidence(
            prior.data as Record<string, unknown> | undefined,
            upstreamAcrMappings
          ),
          evidence
        );
        // The combined evidence is as old as its oldest proof (0: unknown, never fresh), so it
        // cannot pass for a later step-up's own authentication.
        const combinedProvenAt =
          typeof prior.data?.proven_at === 'number' ? Math.min(prior.data.proven_at, provenAt) : 0;
        // The step-up's own login, just proven, stays what a later re-authentication can take,
        // paired with its own time, while the combined evidence counts from its oldest proof.
        const ownUnverified = Array.isArray(sessionData?.unverified_amr)
          ? sessionData.unverified_amr
          : [];
        const ownProvenAmr = (Array.isArray(sessionData?.amr) ? sessionData.amr : []).filter(
          (method) => !ownUnverified.includes(method)
        );
        const ownReauthProof =
          typeof sessionData?.reauth_proven_at === 'number' ||
          ownProvenAmr.length === 0 ||
          provenAt === undefined
            ? {}
            : { reauth_proven_amr: ownProvenAmr, reauth_proven_at: provenAt };
        if (!(await recordCombination(evidence, combinedProvenAt, ownReauthProof))) {
          return { sessionEnded: true };
        }
        combinedAmr = [...evidence.amr];
      }
    }
  } else if (stepUp && sessionId && ownSession && !reauthResultOfStepUp(provenAt, stepUp)) {
    // The step-up was completed in the session the user stepped up from: it records the method
    // just proven (and when) beside its older proof, in `reauth_proven_amr` and `reauth_proven_at`
    // (a re-authentication in the session). That pair is the new factor, as fresh as its time; the
    // rest of the session's evidence stays what it was, as old as its `proven_at`, and is combined
    // with the pair. The older factors are not dated again: a later step-up still finds them old.
    // The same holds for a session that holds an earlier step-up's combination (its factors with
    // that pair) and comes back through a later screen (consent): the earlier session is not read.
    const pair = sessionReauthPair(sessionData);
    if (pair && pair.at >= stepUp.issuedAt) {
      const fresh: AuthenticationEvidence = {
        amr: pair.amr,
        unverifiedMethods: [],
        upstreamAcr: null,
        upstreamAcrMappings,
      };
      evidence = mergeStepUpEvidence(
        sessionAssuranceEvidence(sessionData, upstreamAcrMappings),
        fresh
      );
      // Still as old as the session's own oldest proof; the pair it has stays as it is.
      if (!(await recordCombination(evidence, provenAt ?? 0, {}))) {
        return { sessionEnded: true };
      }
      combinedAmr = [...evidence.amr];
    }
  }

  return {
    ownSession,
    // A step-up completed by the session's own re-authentication counts as the session's evidence.
    evidenceSession: evidenceSession || (ownSession && combinedAmr !== undefined),
    provenAt,
    evidence,
    aal: computeAAL(evidence),
    ...(combinedAmr ? { combinedAmr } : {}),
  };
}

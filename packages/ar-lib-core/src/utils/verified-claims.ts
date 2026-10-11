/**
 * OpenID Connect for Identity Assurance 1.0 `verified_claims`, in the smallest form Authrim backs:
 * a person whose identity was proofed (IAL2 or IAL3, from valid evidence) is released the claims
 * the tenant's profile lists, under the profile's trust framework and assurance level.
 *
 * The request (`claims` parameter, userinfo or id_token) is answered as the specification asks:
 * - each request of a list is answered on its own, and the list is answered with a list;
 * - a request whose `verification` constraints (trust_framework, assurance_level, time) the
 *   person's state does not meet is left out whole, without an error (5.7.4);
 * - only what the request names is released: claims in `claims`, and the `assurance_level` and
 *   `time` of `verification` only when asked for (the RP "shall explicitly request any data"
 *   it wants added, 5.4);
 * - a claim is released only if the tenant's profile lists it and the request's scopes and the
 *   client's claims policy allow it (`canReleaseClaim`), exactly as outside verified_claims.
 *
 * No evidence is described: the profile cannot say how a person was proofed beyond its trust
 * framework and level, so a request that filters on `evidence` cannot be met and is left out.
 */

import type { IAL } from '../types/settings/assurance-levels';
import type { IDAProfile } from '../services/identity-assurance';
import type { ClaimRequestEntry, OIDCIndividualClaimRequest } from './oidc-claims';

/** What the person's evidence supports now: the effective IAL and when it was verified. */
export interface VerifiedClaimsState {
  level: IAL;
  /** Epoch milliseconds the evidence the level rests on was verified at. */
  verifiedAt: number | null;
}

export interface VerifiedClaimsElement {
  verification: {
    trust_framework: string;
    assurance_level?: string;
    time?: string;
  };
  claims: Record<string, unknown>;
}

export interface BuildVerifiedClaimsInput {
  /** The `verified_claims` entry of the claims request's section: an object or a list of them. */
  request: ClaimRequestEntry;
  profile: IDAProfile;
  state: VerifiedClaimsState;
  /** The person's claim values by name (the standard claims). */
  claimValues: Record<string, unknown>;
  /** Whether the request's scopes and the client's policy allow a claim to be released. */
  canReleaseClaim: (claimName: string) => boolean;
  /** Epoch milliseconds now. */
  now: number;
}

/** A plain JSON object, not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key);
}

/** `value` and `values` of a claims request constraint, against what the OP holds. */
function meetsValueConstraint(actual: unknown, constraint: Record<string, unknown>): boolean {
  if (own(constraint, 'value') && actual !== constraint.value) return false;
  if (own(constraint, 'values')) {
    const values = constraint.values;
    if (!Array.isArray(values) || !values.includes(actual)) return false;
  }
  return true;
}

/** The verification time as IDA writes it: ISO 8601 to the second, in UTC. */
function verificationTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Whether a request holds any constraint (a value, values or max_age) anywhere inside it. */
function holdsConstraint(request: unknown): boolean {
  if (Array.isArray(request)) return request.some(holdsConstraint);
  if (!isObject(request)) return false;
  if (own(request, 'value') || own(request, 'values') || own(request, 'max_age')) return true;
  return Object.values(request).some(holdsConstraint);
}

/**
 * Whether the person's state meets the `verification` constraints of one request, and which of its
 * optional elements it asks for. Null: the request cannot be met and is left out.
 */
function readVerification(
  verification: unknown,
  profile: IDAProfile,
  state: VerifiedClaimsState,
  now: number
): { assuranceLevel?: string; time?: string } | null {
  if (verification === undefined || verification === null) return {};
  if (!isObject(verification)) return null;

  const trust = verification.trust_framework;
  if (trust !== undefined && trust !== null) {
    if (!isObject(trust) || !meetsValueConstraint(profile.trustFramework, trust)) return null;
  }

  const result: { assuranceLevel?: string; time?: string } = {};

  if (own(verification, 'assurance_level')) {
    const asked = verification.assurance_level;
    const level = state.level === 'IAL1' ? undefined : profile.assuranceLevels[state.level];
    if (asked !== null) {
      if (!isObject(asked)) return null;
      // A constraint on a level the profile gives this IAL no value for cannot be met.
      if ((own(asked, 'value') || own(asked, 'values')) && !meetsValueConstraint(level, asked)) {
        return null;
      }
    }
    if (level !== undefined) result.assuranceLevel = level;
  }

  if (own(verification, 'time')) {
    const asked = verification.time;
    if (state.verifiedAt === null) return null;
    const time = verificationTime(state.verifiedAt);
    if (asked !== null) {
      if (!isObject(asked)) return null;
      if (!meetsValueConstraint(time, asked)) return null;
      if (own(asked, 'max_age')) {
        const maxAge = asked.max_age;
        if (typeof maxAge !== 'number' || !Number.isFinite(maxAge) || maxAge < 0) return null;
        // Elapsed time since the verification, in seconds.
        if ((now - state.verifiedAt) / 1000 > maxAge) return null;
      }
    }
    result.time = time;
  }

  // The profile describes no evidence: a filter on it cannot be met. Left unconstrained, evidence
  // is data this OP does not have, which is omitted.
  if (own(verification, 'evidence') && holdsConstraint(verification.evidence)) return null;

  return result;
}

function answerOne(
  request: OIDCIndividualClaimRequest,
  input: BuildVerifiedClaimsInput
): VerifiedClaimsElement | null {
  const verification = readVerification(
    request.verification,
    input.profile,
    input.state,
    input.now
  );
  if (!verification) return null;

  const requested = request.claims;
  if (!isObject(requested)) return null;

  const claims: Record<string, unknown> = {};
  for (const claimName of input.profile.claims) {
    if (!own(requested, claimName)) continue;
    const asked = requested[claimName];
    if (asked !== null && !isObject(asked)) continue;
    const value = own(input.claimValues, claimName) ? input.claimValues[claimName] : undefined;
    if (value === undefined || value === null || value === '') continue;
    if (!input.canReleaseClaim(claimName)) continue;
    // A value the RP asked for is part of the query: a claim holding another is omitted (5.7.4).
    if (asked !== null && !meetsValueConstraint(value, asked)) continue;
    claims[claimName] = value;
  }
  if (Object.keys(claims).length === 0) return null;

  return {
    verification: {
      trust_framework: input.profile.trustFramework,
      ...(verification.assuranceLevel !== undefined
        ? { assurance_level: verification.assuranceLevel }
        : {}),
      ...(verification.time !== undefined ? { time: verification.time } : {}),
    },
    claims,
  };
}

/**
 * The `verified_claims` answer to a request: an object for an object request, a list for a list,
 * or undefined when nothing can be released (IAL1, or no request it can answer).
 */
export function buildVerifiedClaims(
  input: BuildVerifiedClaimsInput
): VerifiedClaimsElement | VerifiedClaimsElement[] | undefined {
  // No proofing, nothing to verify: IAL1 releases no verified_claims whatever is asked.
  if (input.state.level === 'IAL1') return undefined;
  const { request } = input;
  if (Array.isArray(request)) {
    const answers = request
      .filter(isObject)
      .map((each) => answerOne(each, input))
      .filter((answer): answer is VerifiedClaimsElement => answer !== null);
    return answers.length > 0 ? answers : undefined;
  }
  if (!isObject(request)) return undefined;
  return answerOne(request, input) ?? undefined;
}

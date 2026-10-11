/**
 * The claims about a person's identity assurance an ID token or UserInfo response can carry:
 * `eduperson_assurance` (the assurance values of the person's IAL) and `verified_claims`
 * (OpenID Connect for Identity Assurance). Both come from the person's evidence, read when they
 * are released and never cached or stored, so evidence revoked or expired stops them with the
 * next response. Neither is ever taken from a mapping, a token, or a user-editable attribute.
 *
 * - They apply only while `assurance.enabled`, and only with something configured to release:
 *   `assurance.ial_assurance_values` for eduperson_assurance, `assurance.ida_profile` for
 *   verified_claims. Otherwise nothing changes, and no evidence is read.
 * - They are released only to a request that asks for them: eduperson_assurance by its scope (where
 *   the response carries scope claims) or the claims parameter, verified_claims by the claims
 *   parameter alone. The client's claims policy applies as it does for any claim.
 * - Evidence is read once for both claims, and only when one of them is to be released. A read that
 *   fails releases neither (and is logged): it is never taken for "no evidence", which would release
 *   the IAL1 values to someone who may hold more, nor for evidence, which could release too much.
 * - The IAL released is the person's effective IAL and no other.
 */

import type { DatabaseAdapter } from '../db/adapter';
import {
  canReleaseClaim,
  EDUPERSON_ASSURANCE_CLAIM,
  VERIFIED_CLAIMS_CLAIM,
  type ClaimsTarget,
  type OIDCClaimsClientPolicy,
  type ParsedClaimsRequest,
} from '../utils/oidc-claims';
import { buildVerifiedClaims, type VerifiedClaimsElement } from '../utils/verified-claims';
import {
  assuranceValuesForIAL,
  parseIALAssuranceValues,
  parseIDAProfile,
  resolveUserEffectiveIAL,
} from './identity-assurance';

export interface AssuranceClaimsInput {
  target: ClaimsTarget;
  tenantId: string;
  /** The person (the user's id, not a pairwise sub): the owner of the evidence. */
  userId: string;
  /** The scopes the response is issued under. */
  scopes: readonly string[];
  claimsRequest?: ParsedClaimsRequest;
  clientPolicy?: OIDCClaimsClientPolicy | null;
  /** Whether the response carries the scope claims (UserInfo and an ID token without UserInfo). */
  includeScopeClaims: boolean;
  /** The person's claim values by name, which verified_claims are made of. */
  claimValues: Record<string, unknown>;
  /** The `assurance` settings. Called only when a claim is to be released. */
  loadSettings: () => Promise<Record<string, unknown>>;
  /** The store that holds the person's canonical identity. Called only when evidence is to be read. */
  getAdapter: () => DatabaseAdapter | Promise<DatabaseAdapter>;
  /** Reports a failure to read the settings or the evidence. */
  onError: (message: string, error: unknown) => void;
  now?: number;
}

export interface AssuranceClaims {
  eduperson_assurance?: string[];
  verified_claims?: VerifiedClaimsElement | VerifiedClaimsElement[];
}

/** Which of the two claims this request asks for and the client's policy lets through. */
export function requestedAssuranceClaims(
  input: Pick<
    AssuranceClaimsInput,
    'target' | 'scopes' | 'claimsRequest' | 'clientPolicy' | 'includeScopeClaims'
  >
): { eduPersonAssurance: boolean; verifiedClaims: boolean } {
  const scopes = new Set(input.scopes);
  const policy = input.clientPolicy ?? {};
  const section = input.claimsRequest?.[input.target] ?? {};
  const asked = (claim: string) => Object.hasOwn(section, claim);

  const eduPersonAssurance =
    (asked(EDUPERSON_ASSURANCE_CLAIM) ||
      (input.includeScopeClaims && scopes.has(EDUPERSON_ASSURANCE_CLAIM))) &&
    canReleaseClaim(EDUPERSON_ASSURANCE_CLAIM, scopes, policy);

  // A null request names no claims, so there is nothing to answer.
  const verifiedClaims =
    asked(VERIFIED_CLAIMS_CLAIM) &&
    section[VERIFIED_CLAIMS_CLAIM] !== null &&
    canReleaseClaim(VERIFIED_CLAIMS_CLAIM, scopes, policy);

  return { eduPersonAssurance, verifiedClaims };
}

/** The assurance claims to release to this response; empty when none is to be. Never throws. */
export async function resolveAssuranceClaims(
  input: AssuranceClaimsInput
): Promise<AssuranceClaims> {
  const wanted = requestedAssuranceClaims(input);
  if (!wanted.eduPersonAssurance && !wanted.verifiedClaims) return {};

  try {
    const settings = await input.loadSettings();
    if (settings['assurance.enabled'] !== true) return {};

    const values = wanted.eduPersonAssurance
      ? parseIALAssuranceValues(settings['assurance.ial_assurance_values'])
      : {};
    const releaseValues = Object.keys(values).length > 0;
    const profile = wanted.verifiedClaims
      ? parseIDAProfile(settings['assurance.ida_profile'])
      : null;
    if (!releaseValues && !profile) return {};

    const now = input.now ?? Date.now();
    const effective = await resolveUserEffectiveIAL(
      await input.getAdapter(),
      input.tenantId,
      input.userId,
      now
    );

    const result: AssuranceClaims = {};
    if (releaseValues) {
      const released = assuranceValuesForIAL(effective.level, values);
      if (released.length > 0) result.eduperson_assurance = released;
    }
    if (profile) {
      const scopes = new Set(input.scopes);
      const policy = input.clientPolicy ?? {};
      const request = input.claimsRequest?.[input.target]?.[VERIFIED_CLAIMS_CLAIM];
      const verified = request
        ? buildVerifiedClaims({
            request,
            profile,
            state: { level: effective.level, verifiedAt: effective.verifiedAt },
            claimValues: input.claimValues,
            canReleaseClaim: (claimName) => canReleaseClaim(claimName, scopes, policy),
            now,
          })
        : undefined;
      if (verified) result.verified_claims = verified;
    }
    return result;
  } catch (error) {
    input.onError('Failed to resolve identity assurance claims', error);
    return {};
  }
}

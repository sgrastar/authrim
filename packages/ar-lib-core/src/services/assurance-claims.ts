/**
 * The claim about a person's identity assurance an ID token or UserInfo response can carry:
 * `eduperson_assurance` (the assurance values of the person's IAL). It comes from the person's
 * evidence, read when it is released and never stored or cached across requests, so evidence
 * revoked or expired stops it with the next response. It is never taken from a mapping, a token
 * claim rule, or a user-editable attribute.
 *
 * - It applies only while `assurance.enabled`, and only with `assurance.ial_assurance_values`
 *   configured. Otherwise nothing changes, and no evidence is read.
 * - It is released only to a request that asks for it: the eduperson_assurance scope (where the
 *   response carries scope claims) or the claims parameter, as for a standard claim. The client's
 *   claims policy applies as it does for any claim.
 * - A read that fails releases nothing (and is logged): it is never taken for "no evidence", which
 *   would release the IAL1 values to someone who may hold more.
 * - The IAL released is the person's effective IAL and no other. A read an IAL requirement of the
 *   same request already made (requestScope) is shared, not repeated.
 */

import type { DatabaseAdapter } from '../db/adapter';
import {
  canReleaseClaim,
  EDUPERSON_ASSURANCE_CLAIM,
  type ClaimsTarget,
  type OIDCClaimsClientPolicy,
  type ParsedClaimsRequest,
} from '../utils/oidc-claims';
import {
  assuranceValuesForIAL,
  parseIALAssuranceValues,
  resolveUserEffectiveIALOnce,
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
  /** The `assurance` settings. Called only when the claim is to be released. */
  loadSettings: () => Promise<Record<string, unknown>>;
  /** The store that holds the person's canonical identity. Called only when evidence is to be read. */
  getAdapter: () => DatabaseAdapter | Promise<DatabaseAdapter>;
  /** The request (its Hono context): evidence it already read is not read again. */
  requestScope?: object;
  /** Reports a failure to read the settings or the evidence. */
  onError: (message: string, error: unknown) => void;
  now?: number;
}

export interface AssuranceClaims {
  eduperson_assurance?: string[];
}

/** Whether this request names eduperson_assurance (by its scope or in the claims parameter). */
export function asksForEduPersonAssurance(
  input: Pick<AssuranceClaimsInput, 'target' | 'scopes' | 'claimsRequest' | 'includeScopeClaims'>
): boolean {
  const section = input.claimsRequest?.[input.target] ?? {};
  return (
    Object.hasOwn(section, EDUPERSON_ASSURANCE_CLAIM) ||
    (input.includeScopeClaims && input.scopes.includes(EDUPERSON_ASSURANCE_CLAIM))
  );
}

/** Whether this request asks for eduperson_assurance and the client's policy lets it through. */
export function requestsEduPersonAssurance(
  input: Pick<
    AssuranceClaimsInput,
    'target' | 'scopes' | 'claimsRequest' | 'clientPolicy' | 'includeScopeClaims'
  >
): boolean {
  return (
    asksForEduPersonAssurance(input) &&
    canReleaseClaim(EDUPERSON_ASSURANCE_CLAIM, new Set(input.scopes), input.clientPolicy ?? {})
  );
}

/** The assurance claim to release to this response; empty when none is to be. Never throws. */
export async function resolveAssuranceClaims(
  input: AssuranceClaimsInput
): Promise<AssuranceClaims> {
  if (!requestsEduPersonAssurance(input)) return {};

  try {
    const settings = await input.loadSettings();
    if (settings['assurance.enabled'] !== true) return {};

    const values = parseIALAssuranceValues(settings['assurance.ial_assurance_values']);
    if (Object.keys(values).length === 0) return {};

    const effective = await resolveUserEffectiveIALOnce(
      input.requestScope,
      await input.getAdapter(),
      input.tenantId,
      input.userId,
      input.now ?? Date.now()
    );
    const released = assuranceValuesForIAL(effective.level, values);
    return released.length > 0 ? { eduperson_assurance: released } : {};
  } catch (error) {
    input.onError('Failed to resolve identity assurance claims', error);
    return {};
  }
}

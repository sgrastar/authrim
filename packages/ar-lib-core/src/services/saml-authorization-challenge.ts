/**
 * The authorization challenge of a SAML sign-in that has to be proven again.
 *
 * When the SAML IdP SSO endpoint needs a new authentication of a person who is already signed in
 * (a ForceAuthn request, or a step-up to a higher AAL), it sends them to the Login UI with a
 * `reauth` challenge, as /authorize does for prompt=login. The Login UI runtime Flow takes the
 * challenge's id and accepts only a session proven after the challenge was issued, and only for the
 * user it was issued for (the same rule as for an OIDC re-authentication, which the sign-in methods
 * already apply to every authorization challenge).
 *
 * The challenge is bound, by the server alone, to the request it was issued for: the SP, the
 * AuthnRequest and the tenant. Nothing a browser sends is trusted for that binding. A challenge of
 * this protocol is never an OIDC authorization request and an OIDC one is never a SAML request:
 * `metadata.protocol` tells them apart.
 *
 * The keys `sessionUserId` and `reauth_issued_at` are the ones an OIDC re-authentication challenge
 * uses, so that the checks every sign-in method already makes on them apply unchanged.
 */

import type { StoreChallengeRequest } from '../durable-objects/ChallengeStore';
import type { Env } from '../types/env';
import { getChallengeStoreByChallengeId } from '../utils/challenge-sharding';

/** `metadata.protocol` of a SAML authorization challenge. An OIDC one has none. */
export const SAML_AUTHORIZATION_CHALLENGE_PROTOCOL = 'saml';

export interface SAMLReauthChallengeInput {
  tenantId: string;
  /** The AuthnRequest the sign-in answers (its ID). */
  requestId: string;
  /** The SP the request came from (its entity ID). */
  spEntityId: string;
  /** The person who is signed in and has to prove themselves again: only they can answer it. */
  subjectUserId: string;
  /** When the person is sent (milliseconds): only a proof made at or after it answers the challenge. */
  issuedAt: number;
  /** The tenant's issuer URL, where the sign-in continues. */
  issuer: string;
  /** How long the challenge lasts (seconds): the lifetime of the stored AuthnRequest. */
  ttlSeconds: number;
}

/** What a SAML challenge is bound to. */
export interface SAMLAuthorizationChallengeBinding {
  requestId: string;
  spEntityId: string;
  tenantId: string;
  issuer: string | null;
}

/** Whether the challenge's metadata says it belongs to a SAML request. */
export function isSAMLAuthorizationChallenge(
  metadata: Record<string, unknown> | undefined | null
): boolean {
  return metadata?.protocol === SAML_AUTHORIZATION_CHALLENGE_PROTOCOL;
}

/**
 * What a stored challenge is bound to, or null when it is not a SAML challenge or lacks any part
 * of the binding (such a challenge is never accepted as one).
 */
export function readSAMLAuthorizationChallengeBinding(challenge: {
  tenantId?: unknown;
  metadata?: Record<string, unknown> | null;
}): SAMLAuthorizationChallengeBinding | null {
  const metadata = challenge.metadata;
  if (!isSAMLAuthorizationChallenge(metadata)) return null;
  const requestId = metadata?.saml_request_id;
  const spEntityId = metadata?.saml_sp_entity_id;
  const tenantId = challenge.tenantId;
  if (
    typeof requestId !== 'string' ||
    !requestId ||
    typeof spEntityId !== 'string' ||
    !spEntityId ||
    typeof tenantId !== 'string' ||
    !tenantId ||
    // The binding is kept in both places and has to agree.
    metadata?.tenant_id !== tenantId
  ) {
    return null;
  }
  return {
    requestId,
    spEntityId,
    tenantId,
    issuer: typeof metadata?.issuer === 'string' && metadata.issuer ? metadata.issuer : null,
  };
}

/**
 * Store a `reauth` challenge for a SAML request and return its id (put it on the Login UI URL as
 * `challenge_id`). The tenant's ChallengeStore holds it; it expires with the stored request.
 */
export async function createSAMLReauthChallenge(
  env: Env,
  input: SAMLReauthChallengeInput
): Promise<string> {
  const challengeId = crypto.randomUUID();
  const store = (await getChallengeStoreByChallengeId(env, challengeId, input.tenantId)) as {
    storeChallengeRpc(request: StoreChallengeRequest): Promise<{ success: boolean }>;
  };
  await store.storeChallengeRpc({
    id: challengeId,
    tenantId: input.tenantId,
    type: 'reauth',
    userId: input.subjectUserId,
    challenge: challengeId,
    ttl: input.ttlSeconds,
    metadata: {
      protocol: SAML_AUTHORIZATION_CHALLENGE_PROTOCOL,
      saml_request_id: input.requestId,
      saml_sp_entity_id: input.spEntityId,
      tenant_id: input.tenantId,
      issuer: input.issuer,
      // The names an OIDC re-authentication challenge uses (see the file comment).
      sessionUserId: input.subjectUserId,
      reauth_issued_at: input.issuedAt,
    },
  });
  return challengeId;
}

/**
 * The path at which the SAML IdP SSO endpoint resumes a request after the person has signed in
 * (relative, so that it is the origin the browser is on that answers). It is built from the
 * challenge's own binding, never from what a browser sends.
 */
export function buildSAMLSSOResumePath(
  binding: Pick<SAMLAuthorizationChallengeBinding, 'requestId' | 'spEntityId'>
): string {
  const params = new URLSearchParams({
    saml_request_id: binding.requestId,
    saml_sp_entity_id: binding.spEntityId,
    return_to: 'saml_sso',
  });
  return `/saml/idp/sso?${params.toString()}`;
}

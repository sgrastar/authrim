/**
 * What the Login UI runtime Flow and the sign-in methods do with the authorization challenge of a
 * SAML request (see ar-lib-core's saml-authorization-challenge.ts for what it holds).
 *
 * The SAML IdP SSO endpoint issues a `reauth` challenge when a person who is signed in has to
 * prove themselves again (ForceAuthn, or a step-up to a higher AAL). The Flow accepts it only for
 * the SAML request, SP and tenant it was issued for, all read from the challenge and compared with
 * what the browser says, never taken from the browser. A challenge that is not bound that way is
 * not accepted as a SAML one, and a SAML challenge is not accepted for an OIDC client (nor an OIDC
 * one for a SAML SP): `metadata.protocol` tells them apart.
 *
 * The challenge is not used up when a sign-in answers it. It grants nothing by itself: the person
 * is sent back to the SSO endpoint, which uses up the stored AuthnRequest (once) and judges the
 * session's proof against the time it sent the person. A challenge that outlives the sign-in can
 * therefore be read again (a reload of the Login UI after the sign-in carries on) but opens nothing.
 */

import {
  getChallengeStoreByChallengeId,
  type Env,
  buildSAMLSSOResumePath,
  isSAMLAuthorizationChallenge,
  readSAMLAuthorizationChallengeBinding,
  type SAMLAuthorizationChallengeBinding,
} from '@authrim/ar-lib-core';

/** The challenge as stored, as far as these checks read it. */
export interface StoredAuthorizationChallenge {
  tenantId?: unknown;
  type?: unknown;
  metadata?: Record<string, unknown> | null;
}

export type SAMLChallengeBindingCheck =
  | { ok: true; binding: SAMLAuthorizationChallengeBinding }
  | { ok: false; reason: 'wrong_protocol' | 'not_bound' };

/**
 * Whether a stored challenge may be used for the SAML request a Flow was started for.
 *
 * `wrong_protocol`: the challenge belongs to an OIDC authorization request.
 * `not_bound`: it is a SAML challenge but not for this tenant, SP or request, or it is not a
 * re-authentication, or the Flow target also names an OIDC client.
 */
export function checkSAMLChallengeForFlow(
  challenge: StoredAuthorizationChallenge,
  flow: {
    tenantId: string;
    /** The kind of target the Flow is chosen for, and its id: the Flow assignment is looked up by them. */
    targetType: string;
    targetId: string | null;
    /** The SAML SP the Flow target names. */
    samlSpId: string | null;
    /** The OIDC client the Flow target names: a SAML Flow has none. */
    clientId: string | null;
    samlRequestId: string | null;
    samlSpEntityId: string | null;
  }
): SAMLChallengeBindingCheck {
  if (!isSAMLAuthorizationChallenge(challenge.metadata)) {
    return { ok: false, reason: 'wrong_protocol' };
  }
  const binding = readSAMLAuthorizationChallengeBinding({
    tenantId: challenge.tenantId,
    metadata: challenge.metadata,
  });
  if (
    !binding ||
    challenge.type !== 'reauth' ||
    flow.clientId !== null ||
    // The Flow that runs is the one assigned to the target: it must be this SP's, not another's.
    flow.targetType !== 'saml_sp' ||
    binding.spEntityId !== flow.targetId ||
    binding.tenantId !== flow.tenantId ||
    !flow.samlSpId ||
    binding.spEntityId !== flow.samlSpId ||
    binding.spEntityId !== flow.samlSpEntityId ||
    !flow.samlRequestId ||
    binding.requestId !== flow.samlRequestId
  ) {
    return { ok: false, reason: 'not_bound' };
  }
  return { ok: true, binding };
}

/**
 * How a sign-in that answers a challenge continues when the challenge is a SAML one: the person
 * goes back to the SSO endpoint for the request it is bound to. Null when the challenge is not a
 * SAML one (it is continued as an OIDC authorization request); `invalid` for a SAML one that is
 * not usable (not a re-authentication, other tenant, or missing a part of its binding).
 */
export function continueSAMLChallenge(
  challenge: StoredAuthorizationChallenge,
  tenantId: string
): { kind: 'continue'; type: 'reauth'; redirectUrl: string } | { kind: 'invalid' } | null {
  if (!isSAMLAuthorizationChallenge(challenge.metadata)) return null;
  const binding = readSAMLAuthorizationChallengeBinding({
    tenantId: challenge.tenantId,
    metadata: challenge.metadata,
  });
  if (!binding || binding.tenantId !== tenantId || challenge.type !== 'reauth') {
    return { kind: 'invalid' };
  }
  return { kind: 'continue', type: 'reauth', redirectUrl: buildSAMLSSOResumePath(binding) };
}

/**
 * Whether a sign-in method that proves a person for this authorization challenge may only finish
 * the browser session, never produce an OIDC authorization code or a token. That is so for the
 * challenge of a SAML request, and also for one that cannot be found (gone since the sign-in
 * began): nothing then says it is an OIDC request. Throws when the challenge cannot be read, so
 * that nothing is issued on a guess.
 *
 * Direct Auth makes an artifact (and an authorization code) once a method has proven the person;
 * the code is what /token exchanges. A SAML re-authentication must not become a way to get one,
 * least of all by a method the tenant allows for re-authentication only.
 */
export async function isBrowserSessionOnlyChallenge(
  env: Env,
  tenantId: string,
  challengeId: string
): Promise<boolean> {
  const store = (await getChallengeStoreByChallengeId(env, challengeId, tenantId)) as {
    getChallengeRpc(id: string): Promise<{
      tenantId?: unknown;
      metadata?: Record<string, unknown> | null;
    } | null>;
  };
  const challenge = await store.getChallengeRpc(challengeId);
  if (!challenge || challenge.tenantId !== tenantId) return true;
  return isSAMLAuthorizationChallenge(challenge.metadata);
}

/**
 * The AuthnRequest the SAML IdP SSO endpoint keeps while a person signs in, and sending the person
 * to sign in.
 *
 * The request is stored (SAMLRequestStore) with the context the SSO endpoint needs to recognise
 * the sign-in it asked for: that a new sign-in was asked for (ForceAuthn) and when, and the
 * step-up to a higher AAL and when. A session counts as that sign-in only when it was proven after
 * the person was sent, so a person who comes back is answered, not sent again.
 *
 * A person who is signed in and sent to prove themselves again is given a `reauth` challenge
 * (see ar-lib-core's saml-authorization-challenge.ts), so that the Login UI does not complete the
 * sign-in with the session they already have.
 */

import type { Context } from 'hono';
import type {
  AAL,
  Env,
  SAMLAuthnRequest,
  SAMLRequestData,
  SAMLRequestContext,
} from '@authrim/ar-lib-core';
import {
  buildIssuerUrl,
  buildSAMLRequestStoreInstanceName,
  createConfigurationError,
  createSAMLLoginNonce,
  createSAMLReauthChallenge,
  getUIConfig,
  resolveSamlRequestTtlSeconds,
} from '@authrim/ar-lib-core';
import { getSAMLInteractiveLoginUrlPolicy } from '../common/entity-id';
import { DEFAULTS } from '../common/constants';

/** What a resumed request's login keeps of its nonce (see redirectToSAMLLogin). */
export type ResumedSAMLLogin =
  | { nonce: string; hash: string }
  | { hash: string; nonce?: undefined }
  | 'none';

/** The parts of a stored request's context that follow the request through its sign-ins. */
export function carrySAMLRequestContext(
  context: SAMLRequestContext | undefined
): SAMLRequestContext {
  return {
    ...(context?.reauthentication ? { reauthentication: context.reauthentication } : {}),
    ...(context?.assuranceStepUp ? { assuranceStepUp: context.assuranceStepUp } : {}),
    // When the person was first sent to sign in for it: a send again keeps it, so a session made
    // after the first send is not taken for single sign-on once the person is sent once more.
    ...(typeof context?.sentToSignInAt === 'number' && Number.isSafeInteger(context.sentToSignInAt)
      ? { sentToSignInAt: context.sentToSignInAt }
      : {}),
    // The hash of the nonce the browser was sent to sign in with: a login cancel needs it after
    // the request comes back through another screen.
    ...(typeof context?.loginNonceHash === 'string' && context.loginNonceHash
      ? { loginNonceHash: context.loginNonceHash }
      : {}),
  };
}

/** When the person was sent to sign in again for ForceAuthn, if the stored request says so. */
export function readSAMLReauthentication(
  context: SAMLRequestContext | undefined
): { issuedAt: number } | undefined {
  const issuedAt = (context?.reauthentication as { issuedAt?: unknown } | undefined)?.issuedAt;
  return typeof issuedAt === 'number' && Number.isSafeInteger(issuedAt) ? { issuedAt } : undefined;
}

/** The SAML request store instance (Workers) of an SP's requests to this IdP. */
function idpRequestStore(env: Env, tenantId: string, spEntityId: string): DurableObjectStub {
  return env.SAML_REQUEST_STORE.get(
    env.SAML_REQUEST_STORE.idFromName(
      buildSAMLRequestStoreInstanceName(tenantId, 'idp', spEntityId)
    )
  );
}

async function callIdPRequestStore(
  env: Env,
  tenantId: string,
  spEntityId: string,
  operation: 'create' | 'read' | 'update' | 'complete',
  body: Record<string, unknown>
): Promise<Response> {
  return idpRequestStore(env, tenantId, spEntityId).fetch(
    `https://saml-request-store/authn/${operation}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spEntityId, ...body }),
    }
  );
}

/** A stored request read back: its type, SP and id must be the ones asked for. */
function assertStoredAuthnRequest(
  storedRequest: SAMLRequestData | null,
  requestId: string,
  spEntityId: string
): SAMLRequestData {
  if (!storedRequest) {
    throw new Error('Stored SAML request not found or already used');
  }
  if (
    storedRequest.type !== 'authn_request' ||
    storedRequest.issuer !== spEntityId ||
    storedRequest.requestId !== requestId ||
    !storedRequest.data ||
    typeof storedRequest.revision !== 'number'
  ) {
    throw new Error('Stored SAML request is invalid');
  }
  return storedRequest;
}

/**
 * Read a stored AuthnRequest that is waiting, without using it up: it is used up only when the
 * SP is answered (completeStoredAuthnRequest), after the request has been checked again.
 */
export async function readStoredAuthnRequest(
  env: Env,
  tenantId: string,
  requestId: string,
  spEntityId: string
): Promise<SAMLRequestData> {
  let storedRequest: SAMLRequestData | null;
  if (env.SAML_RUNTIME_PORTS) {
    storedRequest = await env.SAML_RUNTIME_PORTS.requests.read({ tenantId, spEntityId, requestId });
  } else {
    const response = await callIdPRequestStore(env, tenantId, spEntityId, 'read', { requestId });
    storedRequest = response.ok ? await response.json<SAMLRequestData>() : null;
  }
  return assertStoredAuthnRequest(storedRequest, requestId, spEntityId);
}

/**
 * Use up a stored AuthnRequest once, right before the SP is answered for it: a request answered
 * in another tab, or changed since it was read (`expectedRevision`), is not answered again. A
 * login cancel uses it up only if it was sent to sign in with that nonce (`loginNonceHash`); any
 * other is left as it is.
 */
export async function completeStoredAuthnRequest(
  env: Env,
  tenantId: string,
  requestId: string,
  spEntityId: string,
  options: { expectedRevision?: number; loginNonceHash?: string } = {}
): Promise<SAMLRequestData> {
  let storedRequest: SAMLRequestData | null;
  if (env.SAML_RUNTIME_PORTS) {
    storedRequest = await env.SAML_RUNTIME_PORTS.requests.complete({
      tenantId,
      spEntityId,
      requestId,
      ...options,
    });
  } else {
    const response = await callIdPRequestStore(env, tenantId, spEntityId, 'complete', {
      requestId,
      ...options,
    });
    storedRequest = response.ok ? await response.json<SAMLRequestData>() : null;
  }
  return assertStoredAuthnRequest(storedRequest, requestId, spEntityId);
}

/**
 * Until when a request's id is kept once it is stored: as long as the SP's request could still be
 * accepted (validateAuthnRequest: IssueInstant + the request lifetime + the clock skew), and not
 * less than the stored request's own expiry.
 */
export function authnRequestRetainUntil(
  authnRequest: SAMLAuthnRequest,
  requestTtlSeconds: number,
  expiresAt: number
): number {
  const issuedAt = Date.parse(authnRequest.issueInstant);
  const acceptableUntil = Number.isFinite(issuedAt)
    ? issuedAt + (requestTtlSeconds + DEFAULTS.CLOCK_SKEW_SECONDS) * 1000
    : expiresAt;
  return Math.max(expiresAt, acceptableUntil);
}

/**
 * Keep an AuthnRequest while the person signs in or answers a screen: a request that arrives is
 * stored once (`storedRevision` absent; one already known is a replay and is refused), a stored
 * one only has its context replaced at the revision it was read at. Its expiry counts from when
 * it first arrived and is never extended. Returns the stored request.
 */
export async function saveStoredAuthnRequest(
  env: Env,
  tenantId: string,
  input: {
    authnRequest: SAMLAuthnRequest;
    relayState?: string;
    context: SAMLRequestContext;
    /** The revision a stored request was read at; absent for a request that arrived now. */
    storedRevision?: number;
    /** The request's lifetime (seconds), when the caller has read it already. */
    requestTtlSeconds?: number;
  }
): Promise<SAMLRequestData> {
  const { authnRequest } = input;
  const spEntityId = authnRequest.issuer;
  if (input.storedRevision !== undefined) {
    let updated: SAMLRequestData | null;
    if (env.SAML_RUNTIME_PORTS) {
      updated = await env.SAML_RUNTIME_PORTS.requests.update({
        tenantId,
        spEntityId,
        requestId: authnRequest.id,
        expectedRevision: input.storedRevision,
        context: input.context,
      });
    } else {
      const response = await callIdPRequestStore(env, tenantId, spEntityId, 'update', {
        requestId: authnRequest.id,
        expectedRevision: input.storedRevision,
        context: input.context,
      });
      updated = response.ok ? await response.json<SAMLRequestData>() : null;
    }
    return assertStoredAuthnRequest(updated, authnRequest.id, spEntityId);
  }

  const requestTtlSeconds =
    input.requestTtlSeconds ?? (await resolveSamlRequestTtlSeconds(env, tenantId));
  const now = Date.now();
  const expiresAt = now + requestTtlSeconds * 1000;
  const request: SAMLRequestData = {
    requestId: authnRequest.id,
    issuer: spEntityId,
    destination: authnRequest.destination ?? '',
    acsUrl: authnRequest.assertionConsumerServiceURL,
    binding: 'post', // Default response binding
    type: 'authn_request',
    data: authnRequest,
    relayState: input.relayState,
    context: input.context,
    used: false,
    createdAt: now,
    expiresAt,
    retainUntil: authnRequestRetainUntil(authnRequest, requestTtlSeconds, expiresAt),
    revision: 1,
  };
  let created: boolean;
  if (env.SAML_RUNTIME_PORTS) {
    created = await env.SAML_RUNTIME_PORTS.requests.create({ tenantId, spEntityId, request });
  } else {
    const response = await callIdPRequestStore(env, tenantId, spEntityId, 'create', { request });
    created = response.status === 201;
  }
  if (!created) {
    // The same request was stored before (it is waiting, answered, or expired): a replay.
    throw new Error('SAML AuthnRequest was already received');
  }
  return request;
}

/**
 * Store the request and redirect to the login page, which returns to the SSO endpoint with the
 * request's id. A new sign-in asked for (`forceReauthentication`) is marked with `force_authn`;
 * the AAL a step-up aims for with `required_aal`.
 *
 * A person who is already signed in (`signInAgain`: who, and when they are sent, which is the
 * time the stored request's context records too) is given a `reauth` challenge bound to this
 * request, SP and tenant; its id goes on the URL as `challenge_id`, and the person is sent to the
 * re-authentication screen instead of the sign-in page. Without one the Login UI would complete
 * the sign-in with the session the person already has.
 * When the challenge cannot be stored the person is not sent (the error is thrown): an
 * authentication that cannot be asked for is not skipped.
 *
 * UI configured: redirect to the external UI. Not configured: a configuration error.
 */
export async function redirectToSAMLLogin(
  c: Context<{ Bindings: Env }>,
  input: {
    env: Env;
    tenantId: string;
    authnRequest: SAMLAuthnRequest;
    relayState?: string;
    forceReauthentication: boolean;
    requiredAal?: AAL;
    signInAgain?: { subjectUserId: string; issuedAt: number };
    context?: SAMLRequestContext;
    /**
     * What a resumed request keeps of its login nonce. A resume never issues a nonce: the stored
     * request's ORIGINAL hash is carried over (so only the browser given the original nonce can
     * cancel it), and the nonce goes on the login URL only when the presented one matched it. A
     * request stored before nonces stays without one (`none`). Absent for a request that arrives
     * fresh: a new nonce is issued.
     */
    resumedLogin?: ResumedSAMLLogin;
    /** The revision a stored request was read at (a resume); absent for one that arrived now. */
    storedRevision?: number;
  }
): Promise<Response> {
  const { env, tenantId, authnRequest } = input;
  const requestTtlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);
  // The browser sent to sign in holds this nonce (on the login URL); the request keeps its hash
  // only. A request that arrives fresh gets a new one; a resumed one keeps the matched one.
  const loginNonce =
    input.resumedLogin === 'none' ? null : (input.resumedLogin ?? (await createSAMLLoginNonce()));
  // Only a nonce the browser presented (or that was just issued) goes on the login URL.
  const loginNonceOnUrl = loginNonce?.nonce;
  await saveStoredAuthnRequest(env, tenantId, {
    authnRequest,
    relayState: input.relayState,
    // When the person was first sent: a session made since answers the request only if its
    // sign-in ran for it (sso.ts, sessionAnswersSAMLRequest).
    context: {
      ...input.context,
      sentToSignInAt: input.context?.sentToSignInAt ?? Date.now(),
      ...(loginNonce ? { loginNonceHash: loginNonce.hash } : {}),
    },
    ...(input.storedRevision !== undefined ? { storedRevision: input.storedRevision } : {}),
    requestTtlSeconds,
  });

  const uiConfig = await getUIConfig(env, tenantId);
  if (uiConfig?.baseUrl) {
    // Only a sign-in that is asked for again can have a challenge to answer.
    const challengeId =
      input.forceReauthentication && input.signInAgain
        ? await createSAMLReauthChallenge(env, {
            tenantId,
            requestId: authnRequest.id,
            spEntityId: authnRequest.issuer,
            subjectUserId: input.signInAgain.subjectUserId,
            issuedAt: input.signInAgain.issuedAt,
            issuer: buildIssuerUrl(env, tenantId),
            ttlSeconds: requestTtlSeconds,
          })
        : undefined;

    const loginUrlPolicy = await getSAMLInteractiveLoginUrlPolicy(env, tenantId);
    const loginBaseUrl =
      loginUrlPolicy === 'tenant_host' ? buildIssuerUrl(env, tenantId) : uiConfig.baseUrl;
    // A person who is signed in and has to prove themselves again goes to the re-authentication
    // screen, as for an OIDC prompt=login: it offers the methods the tenant allows for
    // re-authentication (which are not the ones allowed for sign-in) and asks for human
    // verification as a re-authentication does. Anyone else goes to the sign-in page.
    const loginPath = challengeId
      ? uiConfig.paths?.reauth || '/reauth'
      : uiConfig.paths?.login || '/login';
    const loginUrl = new URL(loginPath, loginBaseUrl);
    loginUrl.searchParams.set('saml_request_id', authnRequest.id);
    if (loginNonceOnUrl) loginUrl.searchParams.set('saml_login_nonce', loginNonceOnUrl);
    loginUrl.searchParams.set('saml_sp_entity_id', authnRequest.issuer);
    loginUrl.searchParams.set('return_to', 'saml_sso');
    if (input.forceReauthentication) {
      loginUrl.searchParams.set('force_authn', 'true');
    }
    if (input.requiredAal) {
      loginUrl.searchParams.set('required_aal', input.requiredAal);
    }
    if (challengeId) {
      loginUrl.searchParams.set('challenge_id', challengeId);
    }
    if (loginUrlPolicy === 'ui_base_url' && tenantId) {
      loginUrl.searchParams.set('tenant_hint', tenantId);
    }
    return c.redirect(loginUrl.toString());
  }

  // No UI configured
  return c.json(createConfigurationError(), 500);
}

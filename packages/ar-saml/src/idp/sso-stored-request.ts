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
  createSAMLReauthChallenge,
  getUIConfig,
  resolveSamlRequestTtlSeconds,
} from '@authrim/ar-lib-core';
import { getSAMLInteractiveLoginUrlPolicy } from '../common/entity-id';

/** The parts of a stored request's context that follow the request through its sign-ins. */
export function carrySAMLRequestContext(
  context: SAMLRequestContext | undefined
): SAMLRequestContext {
  return {
    ...(context?.reauthentication ? { reauthentication: context.reauthentication } : {}),
    ...(context?.assuranceStepUp ? { assuranceStepUp: context.assuranceStepUp } : {}),
  };
}

/** When the person was sent to sign in again for ForceAuthn, if the stored request says so. */
export function readSAMLReauthentication(
  context: SAMLRequestContext | undefined
): { issuedAt: number } | undefined {
  const issuedAt = (context?.reauthentication as { issuedAt?: unknown } | undefined)?.issuedAt;
  return typeof issuedAt === 'number' && Number.isSafeInteger(issuedAt) ? { issuedAt } : undefined;
}

/**
 * Consume the stored AuthnRequest of a request id: it is returned once and cannot be used again.
 */
export async function consumeStoredAuthnRequest(
  env: Env,
  tenantId: string,
  requestId: string,
  spEntityId: string
): Promise<SAMLRequestData> {
  let storedRequest: SAMLRequestData | null;
  if (env.SAML_RUNTIME_PORTS) {
    storedRequest = await env.SAML_RUNTIME_PORTS.requests.consume({
      tenantId,
      spEntityId,
      requestId,
    });
  } else {
    const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(
      buildSAMLRequestStoreInstanceName(tenantId, 'idp', spEntityId)
    );
    const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);
    const response = await samlRequestStore.fetch(
      `https://saml-request-store/consume/${encodeURIComponent(requestId)}`,
      { method: 'POST' }
    );
    storedRequest = response.ok ? await response.json<SAMLRequestData>() : null;
  }

  if (!storedRequest) {
    throw new Error('Stored SAML request not found or already used');
  }
  if (
    storedRequest.type !== 'authn_request' ||
    storedRequest.issuer !== spEntityId ||
    storedRequest.requestId !== requestId ||
    !storedRequest.data
  ) {
    throw new Error('Stored SAML request is invalid');
  }

  return storedRequest;
}

/**
 * Store the AuthnRequest for later retrieval after login.
 */
export async function storeAuthnRequest(
  env: Env,
  tenantId: string,
  authnRequest: SAMLAuthnRequest,
  relayState?: string,
  context?: SAMLRequestContext,
  /** The request's lifetime (seconds), when the caller has read it already. */
  knownRequestTtlSeconds?: number
): Promise<void> {
  const requestTtlSeconds =
    knownRequestTtlSeconds ?? (await resolveSamlRequestTtlSeconds(env, tenantId));
  if (env.SAML_RUNTIME_PORTS) {
    await env.SAML_RUNTIME_PORTS.requests.store({
      tenantId,
      spEntityId: authnRequest.issuer,
      request: {
        requestId: authnRequest.id,
        issuer: authnRequest.issuer,
        destination: authnRequest.destination ?? '',
        acsUrl: authnRequest.assertionConsumerServiceURL,
        binding: 'post',
        type: 'authn_request',
        data: authnRequest,
        relayState,
        context,
        used: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + requestTtlSeconds * 1000,
      },
    });
    return;
  }
  const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(
    buildSAMLRequestStoreInstanceName(tenantId, 'idp', authnRequest.issuer)
  );
  const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

  await samlRequestStore.fetch('https://saml-request-store/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: authnRequest.id,
      issuer: authnRequest.issuer,
      destination: authnRequest.destination,
      acsUrl: authnRequest.assertionConsumerServiceURL,
      binding: 'post', // Default response binding
      type: 'authn_request',
      data: authnRequest,
      relayState,
      context,
      used: false,
      expiresAt: Date.now() + requestTtlSeconds * 1000,
    }),
  });
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
  }
): Promise<Response> {
  const { env, tenantId, authnRequest } = input;
  const requestTtlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);
  await storeAuthnRequest(
    env,
    tenantId,
    authnRequest,
    input.relayState,
    input.context,
    requestTtlSeconds
  );

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

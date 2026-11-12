/**
 * `GET /saml/idp/login-cancel`: answers the SP for a sign-in the person stopped at the Login UI.
 *
 * The Login UI runtime ends the interaction and hands the browser here with a one-time token
 * (ar-lib-core `saml-login-cancel.ts`). Nothing is answered for a request id alone: the
 * interaction must have been ended by that cancel, the token must match (and be recent), and the
 * grant is used up before the stored AuthnRequest is, so the SP is answered once. The stored
 * request is used up only if it was sent to sign in with the login nonce the interaction was
 * started with (a conditional consume: a mismatch consumes nothing), so someone who merely knows a
 * request id cannot cancel it.
 *
 * The status is `Responder` / `AuthnFailed`: the IdP did not authenticate the principal, because
 * the principal withdrew from signing in. (`RequestDenied` says the IdP chose not to respond to a
 * request it could process; it is what a refused attribute release answers.) Either way the SP
 * gets a failure Response in reply to its request, to its ACS with its RelayState.
 */
import type { Context } from 'hono';
import type { Env, SAMLAuthnRequest } from '@authrim/ar-lib-core';
import {
  claimSAMLLoginCancel,
  getLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveSamlRequestTtlSeconds,
} from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../common/constants';
import { getSPConfig } from '../admin/providers';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import { resolveSAMLResponseDestination } from './response-destination';
import { scheduleSAMLPolicyFailureAudit } from './audit';
import { consumeStoredAuthnRequest } from './sso-stored-request';
import { generateSAMLProtocolErrorResponse, sendSAMLResponse } from './sso';

function noGrant(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'saml_error',
      message: 'This sign-in cannot be answered',
      status_code: STATUS_CODES.REQUEST_DENIED,
    },
    400,
    { 'Cache-Control': 'no-store' }
  );
}

export async function handleIdPLoginCancel(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-IDP');
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const interactionId = c.req.query('interaction_id') ?? '';
  const token = c.req.query('token') ?? '';
  try {
    const db = await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-idp-login-cancel', {
      tenantId,
    });
    const requestTtlSeconds = await resolveSamlRequestTtlSeconds(env, tenantId);
    const claimed = await claimSAMLLoginCancel(
      db,
      tenantId,
      { interactionId, token },
      { maxAgeMs: requestTtlSeconds * 1000 }
    );
    if (!claimed) return noGrant(c);

    const storedRequest = await consumeStoredAuthnRequest(
      env,
      tenantId,
      claimed.requestId,
      claimed.spEntityId,
      // Used up only if the request was sent to sign in with the nonce this interaction started
      // with; otherwise left untouched.
      { loginNonceHash: claimed.loginNonceHash }
    );
    const authnRequest = storedRequest.data as SAMLAuthnRequest;
    const spConfig = await getSPConfig(env, tenantId, claimed.spEntityId);
    if (!spConfig) return noGrant(c);

    const { issuerUrl, idpEntityId } = await getSAMLLocalEntityIds(env, tenantId);
    scheduleSAMLPolicyFailureAudit(c, {
      tenantId,
      spEntityId: claimed.spEntityId,
      authnRequestId: authnRequest.id,
      failureKind: 'login_cancelled',
      policyDetails: { user_decision: 'cancel' },
    });
    const responseXml = await generateSAMLProtocolErrorResponse(
      issuerUrl,
      idpEntityId,
      env,
      authnRequest,
      spConfig,
      tenantId,
      STATUS_CODES.RESPONDER,
      STATUS_CODES.AUTHN_FAILED,
      'The user cancelled the sign-in'
    );
    return sendSAMLResponse(
      c,
      resolveSAMLResponseDestination(authnRequest, spConfig),
      responseXml,
      storedRequest.relayState
    );
  } catch (error) {
    log.error('SAML sign-in cancel error', {}, error as Error);
    return c.json(
      {
        error: 'saml_error',
        message: 'Sign-in cancel processing failed',
        status_code: STATUS_CODES.RESPONDER,
      },
      400,
      { 'Cache-Control': 'no-store' }
    );
  }
}

/**
 * SAML SP Single Logout (SLO) Endpoint
 *
 * Handles:
 * 1. LogoutRequest from IdP - Terminates SP session and sends LogoutResponse
 * 2. LogoutResponse from IdP - Confirms logout completion (for SP-initiated logout)
 *
 * Supports HTTP-POST and HTTP-Redirect bindings.
 *
 * POST /saml/sp/slo
 * GET  /saml/sp/slo
 */

import type { Context } from 'hono';
import type { Env, SAMLIdPConfig } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  buildIssuerUrl,
  usesNakedDomainIssuer,
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';
import {
  parseLogoutRequestPost,
  parseLogoutRequestRedirect,
  parseLogoutResponsePost,
  parseLogoutResponseRedirect,
  buildLogoutResponse,
  buildLogoutRequest,
  encodeForPostBinding,
  type ParsedLogoutRequest,
  type ParsedLogoutResponse,
} from '../common/slo-messages';
import { parsePostBindingFormDataWithLimit } from '../common/message-limits';
import { base64Decode, generateSAMLId, nowAsDateTime } from '../common/xml-utils';
import { STATUS_CODES, DEFAULTS } from '../common/constants';
import { signXml, verifyXmlSignature, hasSignature } from '../common/signature';
import { getSAMLSigningMaterial, getSAMLSigningPolicy } from '../common/saml-signing-keys';
import { getIdPConfigByEntityId } from '../admin/providers';
import { findActiveSamlUserByEmail, getSamlUserNameIdById } from '../common/user-store';
import { requireSAMLTenantId, resolveSAMLTenantIdFromContext } from '../common/tenant';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';

/**
 * Handle SP Single Logout (both POST and GET)
 */
export async function handleSPSLO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;
  const log = getLogger(c).module('SAML-SP');
  const issuerUrl = buildIssuerUrl(env, resolveSAMLTenantIdFromContext(c));

  try {
    if (method === 'GET') {
      return handleRedirectBinding(c, env, issuerUrl);
    } else {
      return handlePostBinding(c, env, issuerUrl);
    }
  } catch (error) {
    log.error('SP SLO Error', { method }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Handle HTTP-POST binding
 */
async function handlePostBinding(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string
): Promise<Response> {
  const formData = await parsePostBindingFormDataWithLimit(c.req);
  const samlRequest = formData.get('SAMLRequest') as string | null;
  const samlResponse = formData.get('SAMLResponse') as string | null;
  const relayState = formData.get('RelayState') as string | null;

  if (samlRequest) {
    const logoutRequest = parseLogoutRequestPost(samlRequest);
    return processLogoutRequest(c, env, issuerUrl, logoutRequest, relayState, 'post', samlRequest);
  } else if (samlResponse) {
    const logoutResponse = parseLogoutResponsePost(samlResponse);
    return processLogoutResponse(c, env, logoutResponse, relayState, samlResponse);
  } else {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'SAMLRequest or SAMLResponse' },
    });
  }
}

/**
 * Handle HTTP-Redirect binding
 */
async function handleRedirectBinding(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string
): Promise<Response> {
  const url = new URL(c.req.url);
  const samlRequest = url.searchParams.get('SAMLRequest');
  const samlResponse = url.searchParams.get('SAMLResponse');
  const relayState = url.searchParams.get('RelayState');

  if (samlRequest) {
    const logoutRequest = parseLogoutRequestRedirect(samlRequest);
    return processLogoutRequest(c, env, issuerUrl, logoutRequest, relayState, 'redirect');
  } else if (samlResponse) {
    const logoutResponse = parseLogoutResponseRedirect(samlResponse);
    return processLogoutResponse(c, env, logoutResponse, relayState);
  } else {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'SAMLRequest or SAMLResponse' },
    });
  }
}

/**
 * Process LogoutRequest from IdP
 */
async function processLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  logoutRequest: ParsedLogoutRequest,
  relayState: string | null,
  binding: 'post' | 'redirect',
  samlBase64?: string
): Promise<Response> {
  const log = getLogger(c).module('SAML-SP');

  // Get IdP configuration
  const idpConfig = await getIdPConfigByEntityId(
    env,
    resolveSAMLTenantIdFromContext(c),
    logoutRequest.issuer
  );

  if (!idpConfig) {
    log.error('Unknown IdP', { issuer: logoutRequest.issuer });
    return createErrorResponse(c, AR_ERROR_CODES.SAML_INVALID_RESPONSE);
  }

  // Verify signature if present (for POST binding with embedded signature)
  if (samlBase64) {
    const decodedXml = base64Decode(samlBase64);
    if (hasSignature(decodedXml)) {
      try {
        // Use expectedId and strictXswProtection to prevent XSW attacks
        verifyXmlSignature(decodedXml, {
          certificateOrKey: idpConfig.certificate,
          expectedId: logoutRequest.id,
          strictXswProtection: true,
        });
      } catch (error) {
        log.error('LogoutRequest signature verification failed', { binding }, error as Error);
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    }
  }

  // Validate LogoutRequest
  validateLogoutRequest(logoutRequest, issuerUrl);

  // Terminate session by NameID
  await terminateSessionByNameId(c, env, logoutRequest.nameId, logoutRequest.sessionIndex);

  // Clear session cookie
  const cookieHeader = 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  // Build and send LogoutResponse to IdP
  return sendLogoutResponse(
    c,
    env,
    issuerUrl,
    idpConfig,
    {
      inResponseTo: logoutRequest.id,
      statusCode: STATUS_CODES.SUCCESS,
      relayState,
      binding,
    },
    cookieHeader
  );
}

/**
 * Process LogoutResponse from IdP (for SP-initiated logout)
 */
async function processLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  logoutResponse: ParsedLogoutResponse,
  relayState: string | null,
  samlBase64?: string
): Promise<Response> {
  const log = getLogger(c).module('SAML-SP');

  // Get IdP configuration
  const idpConfig = await getIdPConfigByEntityId(
    env,
    resolveSAMLTenantIdFromContext(c),
    logoutResponse.issuer
  );

  // Verify signature if present
  if (idpConfig && samlBase64) {
    const decodedXml = base64Decode(samlBase64);
    if (hasSignature(decodedXml)) {
      try {
        // Use expectedId and strictXswProtection to prevent XSW attacks
        verifyXmlSignature(decodedXml, {
          certificateOrKey: idpConfig.certificate,
          expectedId: logoutResponse.id,
          strictXswProtection: true,
        });
      } catch (error) {
        log.error('LogoutResponse signature verification failed', {}, error as Error);
        // Log but continue - some IdPs may not sign LogoutResponses
      }
    }
  }

  // Check status
  if (logoutResponse.statusCode !== STATUS_CODES.SUCCESS) {
    log.warn('IdP returned logout error', {
      statusCode: logoutResponse.statusCode,
      statusMessage: logoutResponse.statusMessage,
    });
  }

  // Clear session cookie and redirect to logout complete
  let returnUrl = relayState;
  if (!returnUrl) {
    const logoutCompleteRedirect = await buildLogoutCompleteUrlForSP(c, env);
    if (logoutCompleteRedirect.type === 'error') {
      return logoutCompleteRedirect.response;
    }
    returnUrl = logoutCompleteRedirect.url;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: returnUrl,
      'Set-Cookie': 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

/**
 * Validate LogoutRequest from IdP
 */
function validateLogoutRequest(logoutRequest: ParsedLogoutRequest, issuerUrl: string): void {
  // Check request is not expired
  const issueInstant = new Date(logoutRequest.issueInstant);
  const now = new Date();
  const skewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
  const maxAge = DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000;

  if (issueInstant.getTime() > now.getTime() + skewMs) {
    throw new Error('LogoutRequest IssueInstant is in the future');
  }

  if (now.getTime() - issueInstant.getTime() > maxAge + skewMs) {
    throw new Error('LogoutRequest has expired');
  }

  // Validate Destination if present
  if (logoutRequest.destination) {
    const expectedDestination = `${issuerUrl}/saml/sp/slo`;
    if (logoutRequest.destination !== expectedDestination) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Destination in SAML LogoutRequest');
    }
  }
}

/**
 * Terminate session by NameID (sharded)
 *
 * Note: With sharded SessionStore, we can only delete sessions if sessionIndex
 * (which should be the Authrim sessionId) is provided. User-based session deletion
 * would require a userId -> sessionIds index which is not implemented.
 */
async function terminateSessionByNameId(
  c: Context<{ Bindings: Env }>,
  env: Env,
  nameId: string,
  sessionIndex?: string
): Promise<void> {
  const log = getLogger(c).module('SAML-SP');

  try {
    // If sessionIndex is provided and is a valid sharded session ID, delete that specific session
    if (sessionIndex && isShardedSessionId(sessionIndex)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(
          env,
          sessionIndex,
          resolveSAMLTenantIdFromContext(c)
        );
        const response = await sessionStore.fetch(`https://session-store/session/${sessionIndex}`, {
          method: 'DELETE',
        });
        if (response.ok) {
          log.info('Terminated session', { sessionIndex });
          return;
        } else {
          log.debug('Session not found or already deleted', { sessionIndex });
        }
      } catch (error) {
        log.error('Failed to delete session', { sessionIndex }, error as Error);
      }
    } else if (sessionIndex) {
      log.warn('sessionIndex is not in sharded format, cannot delete', { sessionIndex });
    }

    // Without a valid sessionIndex, we cannot delete by userId in sharded SessionStore
    // Log warning for debugging
    // PII/Non-PII DB separation: search email in PII DB
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const user = await findActiveSamlUserByEmail(env, tenantId, nameId);
    if (user) {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn(
        'Cannot delete all sessions for user (sharded SessionStore requires sessionIndex). Ensure the IdP includes sessionIndex in LogoutRequest.',
        {}
      );
    } else {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn('No user found for logout request', {});
    }
  } catch (error) {
    log.error('Error terminating session', {}, error as Error);
  }
}

/**
 * Send LogoutResponse to IdP
 */
async function sendLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  idpConfig: SAMLIdPConfig,
  options: {
    inResponseTo: string;
    statusCode: string;
    statusMessage?: string;
    relayState: string | null;
    binding: 'post' | 'redirect';
  },
  cookieHeader: string
): Promise<Response> {
  const { inResponseTo, statusCode, statusMessage, relayState, binding } = options;

  const destination = idpConfig.sloUrl || idpConfig.ssoUrl;
  const responseId = generateSAMLId();
  const issuer = `${issuerUrl}/saml/sp`;

  // Build LogoutResponse
  let responseXml = buildLogoutResponse({
    id: responseId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    inResponseTo,
    statusCode,
    statusMessage,
  });

  const log = getLogger(c).module('SAML-SP');

  // Sign the response
  try {
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId,
      role: 'sp',
      counterpartyEntityId: idpConfig.entityId,
      policy: getSAMLSigningPolicy(idpConfig),
    });

    responseXml = signXml(responseXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${responseId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    log.error('Error signing LogoutResponse', {}, error as Error);
    // Continue without signature if signing fails
  }

  // Send via HTTP-POST binding (recommended for responses)
  return sendPostBindingResponse(destination, responseXml, relayState, cookieHeader);
}

/**
 * Send LogoutResponse via HTTP-POST binding
 */
function sendPostBindingResponse(
  destination: string,
  responseXml: string,
  relayState: string | null,
  cookieHeader: string
): Response {
  const encodedResponse = encodeForPostBinding(responseXml);
  const fields = [{ name: 'SAMLResponse', value: encodedResponse }];
  if (relayState) {
    fields.push({ name: 'RelayState', value: relayState });
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML Logout',
    actionUrl: destination,
    fields,
    buttonText: 'Continue',
    additionalHeaders: {
      'Set-Cookie': cookieHeader,
    },
  });
}

/**
 * Initiate SP-initiated logout (send LogoutRequest to IdP)
 */
export async function initiateSPLogout(
  env: Env,
  userId: string,
  idpConfig: SAMLIdPConfig,
  sessionIndex?: string,
  returnUrl?: string,
  tenantId?: string
): Promise<{ html: string }> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SP-initiated SLO tenant');
  // Get user info for NameID (PII/Non-PII DB separation)
  const nameId = await getSamlUserNameIdById(env, resolvedTenantId, userId);

  if (!nameId) {
    throw new Error('Logout request could not be processed');
  }
  const issuer = `${buildIssuerUrl(env, resolvedTenantId)}/saml/sp`;
  const destination = idpConfig.sloUrl || idpConfig.ssoUrl;
  const requestId = generateSAMLId();

  // Build LogoutRequest
  let logoutRequestXml = buildLogoutRequest({
    id: requestId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    nameId,
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    sessionIndex,
  });

  // Sign the request
  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId: resolvedTenantId,
      role: 'sp',
      counterpartyEntityId: idpConfig.entityId,
      policy: getSAMLSigningPolicy(idpConfig),
    });

    logoutRequestXml = signXml(logoutRequestXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${requestId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    const log = createLogger().module('SAML-SP-SLO');
    log.error('Error signing LogoutRequest', { action: 'sign_logout_request' }, error as Error);
  }

  // Encode for POST binding
  const encodedRequest = encodeForPostBinding(logoutRequestXml);
  const fields = [{ name: 'SAMLRequest', value: encodedRequest }];
  if (returnUrl) {
    fields.push({ name: 'RelayState', value: returnUrl });
  }

  const response = buildSAMLPostBindingResponse({
    title: 'SAML Logout',
    actionUrl: destination,
    fields,
    buttonText: 'Continue to Logout',
  });

  return { html: await response.text() };
}

/**
 * Build logout complete URL based on UI config (for SP)
 * Supports conformance mode (built-in redirect) and external UI
 */
type LogoutCompleteResultSP =
  | { type: 'redirect'; url: string }
  | { type: 'error'; response: Response };

async function buildLogoutCompleteUrlForSP(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<LogoutCompleteResultSP> {
  const tenantId = resolveSAMLTenantIdFromContext(c);

  // Conformance mode: use built-in path
  if (await shouldUseBuiltinForms(env)) {
    const issuerUrl = buildIssuerUrl(env, tenantId);
    return { type: 'redirect', url: `${issuerUrl}/logout-complete` };
  }

  // Normal mode: use UI config
  const uiConfig = await getUIConfig(env);
  if (!uiConfig?.baseUrl) {
    return { type: 'error', response: c.json(createConfigurationError(), 500) };
  }

  const url = buildUIUrl(
    uiConfig,
    'logoutComplete',
    {},
    usesNakedDomainIssuer(env, tenantId) ? undefined : tenantId
  );
  return { type: 'redirect', url };
}

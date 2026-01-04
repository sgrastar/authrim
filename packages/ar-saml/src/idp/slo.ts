/**
 * SAML IdP Single Logout (SLO) Endpoint
 *
 * Handles both:
 * 1. LogoutRequest from SP - Terminates IdP session and sends LogoutResponse
 * 2. LogoutResponse from SP - Confirms logout completion from SP-initiated flow
 *
 * Supports HTTP-POST and HTTP-Redirect bindings.
 *
 * POST /saml/idp/slo
 * GET  /saml/idp/slo
 */

import type { Context } from 'hono';
import type { Env, SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  getTenantIdFromContext,
  buildIssuerUrl,
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';
import {
  parseLogoutRequestPost,
  parseLogoutRequestRedirect,
  parseLogoutResponsePost,
  parseLogoutResponseRedirect,
  buildLogoutResponse,
  encodeForPostBinding,
  type ParsedLogoutRequest,
  type ParsedLogoutResponse,
} from '../common/slo-messages';
import { generateSAMLId, nowAsDateTime } from '../common/xml-utils';
import { STATUS_CODES, DEFAULTS } from '../common/constants';
import { signXml } from '../common/signature';
import { getSigningKey, getSigningCertificate } from '../common/key-utils';
import { getSPConfig } from '../admin/providers';

/**
 * Handle Single Logout request/response (POST binding)
 */
export async function handleIdPSLO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;
  const log = getLogger(c).module('SAML-IDP');

  try {
    if (method === 'GET') {
      return handleRedirectBinding(c, env);
    } else {
      return handlePostBinding(c, env);
    }
  } catch (error) {
    log.error('IdP SLO Error', { method }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Handle HTTP-POST binding
 */
async function handlePostBinding(c: Context<{ Bindings: Env }>, env: Env): Promise<Response> {
  const formData = await c.req.formData();
  const samlRequest = formData.get('SAMLRequest') as string | null;
  const samlResponse = formData.get('SAMLResponse') as string | null;
  const relayState = formData.get('RelayState') as string | null;

  if (samlRequest) {
    const logoutRequest = parseLogoutRequestPost(samlRequest);
    return processLogoutRequest(c, env, logoutRequest, relayState, 'post');
  } else if (samlResponse) {
    const logoutResponse = parseLogoutResponsePost(samlResponse);
    return processLogoutResponse(c, env, logoutResponse, relayState);
  } else {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'SAMLRequest or SAMLResponse' },
    });
  }
}

/**
 * Handle HTTP-Redirect binding
 */
async function handleRedirectBinding(c: Context<{ Bindings: Env }>, env: Env): Promise<Response> {
  const url = new URL(c.req.url);
  const samlRequest = url.searchParams.get('SAMLRequest');
  const samlResponse = url.searchParams.get('SAMLResponse');
  const relayState = url.searchParams.get('RelayState');

  if (samlRequest) {
    const logoutRequest = parseLogoutRequestRedirect(samlRequest);
    return processLogoutRequest(c, env, logoutRequest, relayState, 'redirect');
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
 * Process LogoutRequest from SP
 */
async function processLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  logoutRequest: ParsedLogoutRequest,
  relayState: string | null,
  binding: 'post' | 'redirect'
): Promise<Response> {
  const log = getLogger(c).module('SAML-IDP');

  // Validate LogoutRequest
  validateLogoutRequest(logoutRequest, env);

  // Get SP configuration
  const spConfig = await getSPConfig(env, logoutRequest.issuer);
  if (!spConfig) {
    return sendLogoutResponse(c, env, {
      inResponseTo: logoutRequest.id,
      destination: '', // Unknown SP
      statusCode: STATUS_CODES.REQUEST_DENIED,
      statusMessage: 'Unknown Service Provider',
      relayState,
      binding,
    });
  }

  // Find and terminate session by NameID
  const sessionTerminated = await terminateSessionByNameId(
    c,
    env,
    logoutRequest.nameId,
    logoutRequest.sessionIndex
  );

  if (!sessionTerminated) {
    // PII Protection: Do not log NameID (may contain email/PII)
    log.warn('No session found for logout request', {});
    // Still return success - session may have already been terminated
  }

  // Clear IdP session cookie
  const cookieHeader = 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  // Build and send LogoutResponse
  return sendLogoutResponse(
    c,
    env,
    {
      inResponseTo: logoutRequest.id,
      destination: spConfig.sloUrl || spConfig.acsUrl, // Fallback to ACS if no SLO URL
      statusCode: STATUS_CODES.SUCCESS,
      relayState,
      binding,
    },
    cookieHeader
  );
}

/**
 * Process LogoutResponse from SP (for IdP-initiated SLO)
 */
async function processLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  logoutResponse: ParsedLogoutResponse,
  relayState: string | null
): Promise<Response> {
  const log = getLogger(c).module('SAML-IDP');

  // Validate LogoutResponse
  if (logoutResponse.statusCode !== STATUS_CODES.SUCCESS) {
    log.warn('SP returned logout error', {
      statusCode: logoutResponse.statusCode,
      statusMessage: logoutResponse.statusMessage,
    });
  }

  // TODO: If we're propagating logout to multiple SPs, continue to next SP here

  // Redirect to logout complete page
  const logoutCompleteRedirect = await buildLogoutCompleteUrl(c, env, relayState);
  if (logoutCompleteRedirect.type === 'error') {
    return logoutCompleteRedirect.response;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: logoutCompleteRedirect.url,
      'Set-Cookie': 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

/**
 * Validate LogoutRequest
 */
function validateLogoutRequest(logoutRequest: ParsedLogoutRequest, env: Env): void {
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

  // Check NotOnOrAfter if present
  if (logoutRequest.notOnOrAfter) {
    const notOnOrAfter = new Date(logoutRequest.notOnOrAfter);
    if (now.getTime() > notOnOrAfter.getTime() + skewMs) {
      throw new Error('LogoutRequest has expired (NotOnOrAfter)');
    }
  }

  // Validate Destination if present
  if (logoutRequest.destination) {
    const expectedDestination = `${env.ISSUER_URL}/saml/idp/slo`;
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
): Promise<boolean> {
  const log = getLogger(c).module('SAML-IDP');

  try {
    // If sessionIndex is provided and is a valid sharded session ID, delete that specific session
    if (sessionIndex && isShardedSessionId(sessionIndex)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(env, sessionIndex);
        const response = await sessionStore.fetch(
          new Request(`https://session-store/session/${sessionIndex}`, {
            method: 'DELETE',
          })
        );
        if (response.ok) {
          log.info('Terminated session', { sessionIndex });
          return true;
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
    const tenantId = 'default';
    let user: { id: string } | null = null;
    const piiAdapter: DatabaseAdapter | null = env.DB_PII
      ? new D1Adapter({ db: env.DB_PII })
      : null;
    if (piiAdapter) {
      const userPII = await piiAdapter.queryOne<{ id: string }>(
        'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?',
        [tenantId, nameId]
      );
      if (userPII) {
        // Verify user exists in Core DB
        const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
        const userCore = await coreAdapter.queryOne<{ id: string }>(
          'SELECT id FROM users_core WHERE id = ? AND is_active = 1',
          [userPII.id]
        );
        if (userCore) {
          user = { id: userCore.id };
        }
      }
    }
    if (user) {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn(
        'Cannot delete all sessions for user (sharded SessionStore requires sessionIndex). Ensure the SP includes sessionIndex in LogoutRequest.',
        {}
      );
      // Return true to indicate the logout request was processed (even if we couldn't delete all sessions)
      // The session cookie will still be cleared by the caller
      return true;
    } else {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn('No user found for logout request', {});
      return false;
    }
  } catch (error) {
    log.error('Error terminating session', {}, error as Error);
    return false;
  }
}

/**
 * Send LogoutResponse to SP
 */
async function sendLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  options: {
    inResponseTo: string;
    destination: string;
    statusCode: string;
    statusMessage?: string;
    relayState: string | null;
    binding: 'post' | 'redirect';
  },
  cookieHeader?: string
): Promise<Response> {
  const { inResponseTo, destination, statusCode, statusMessage, relayState, binding } = options;

  // If no destination, redirect to logout complete page
  if (!destination) {
    const logoutCompleteRedirect = await buildLogoutCompleteUrl(c, env, relayState);
    if (logoutCompleteRedirect.type === 'error') {
      return logoutCompleteRedirect.response;
    }

    const headers: Record<string, string> = {
      Location: logoutCompleteRedirect.url,
    };
    if (cookieHeader) {
      headers['Set-Cookie'] = cookieHeader;
    }

    return new Response(null, {
      status: 302,
      headers,
    });
  }

  // Build LogoutResponse
  const responseId = generateSAMLId();
  const issuer = `${env.ISSUER_URL}/saml/idp`;

  let responseXml = buildLogoutResponse({
    id: responseId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    inResponseTo,
    statusCode,
    statusMessage,
  });

  const log = getLogger(c).module('SAML-IDP');

  // Sign the response
  try {
    const { privateKeyPem } = await getSigningKey(env);
    const certificate = await getSigningCertificate(env);

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

  // Send via appropriate binding
  if (binding === 'post') {
    return sendPostBindingResponse(destination, responseXml, relayState, cookieHeader);
  } else {
    // For redirect binding, we would need to deflate and encode
    // For simplicity, use POST binding for responses
    return sendPostBindingResponse(destination, responseXml, relayState, cookieHeader);
  }
}

/**
 * Send LogoutResponse via HTTP-POST binding
 */
function sendPostBindingResponse(
  destination: string,
  responseXml: string,
  relayState: string | null,
  cookieHeader?: string
): Response {
  const encodedResponse = encodeForPostBinding(responseXml);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SAML Logout</title>
</head>
<body onload="document.forms[0].submit()">
  <noscript>
    <p>JavaScript is disabled. Click the button to continue.</p>
  </noscript>
  <form method="POST" action="${escapeHtml(destination)}">
    <input type="hidden" name="SAMLResponse" value="${escapeHtml(encodedResponse)}" />
    ${relayState ? `<input type="hidden" name="RelayState" value="${escapeHtml(relayState)}" />` : ''}
    <noscript>
      <button type="submit">Continue</button>
    </noscript>
  </form>
</body>
</html>`;

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };

  if (cookieHeader) {
    headers['Set-Cookie'] = cookieHeader;
  }

  return new Response(html, { headers });
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Build logout complete URL based on UI config
 * Supports conformance mode (built-in redirect) and external UI
 */
type LogoutCompleteResult =
  | { type: 'redirect'; url: string }
  | { type: 'error'; response: Response };

async function buildLogoutCompleteUrl(
  c: Context<{ Bindings: Env }>,
  env: Env,
  relayState?: string | null
): Promise<LogoutCompleteResult> {
  const tenantId = getTenantIdFromContext(c);

  // Conformance mode: use built-in path
  if (await shouldUseBuiltinForms(env)) {
    const issuerUrl = buildIssuerUrl(env, tenantId);
    const url = new URL('/logout-complete', issuerUrl);
    if (relayState) {
      url.searchParams.set('relay_state', relayState);
    }
    return { type: 'redirect', url: url.toString() };
  }

  // Normal mode: use UI config
  const uiConfig = await getUIConfig(env);
  if (!uiConfig?.baseUrl) {
    return { type: 'error', response: c.json(createConfigurationError(), 500) };
  }

  const queryParams: Record<string, string> = {};
  if (relayState) {
    queryParams.relay_state = relayState;
  }
  const url = buildUIUrl(
    uiConfig,
    'logoutComplete',
    queryParams,
    tenantId !== 'default' ? tenantId : undefined
  );
  return { type: 'redirect', url };
}

/**
 * Initiate IdP-initiated SLO (send LogoutRequest to SP)
 */
export async function initiateIdPLogout(
  env: Env,
  userId: string,
  spConfig: SAMLSPConfig,
  sessionIndex?: string
): Promise<{ logoutRequestXml: string; destination: string }> {
  // Get user info for NameID (PII/Non-PII DB separation)
  let nameId: string | null = null;
  const piiAdapter: DatabaseAdapter | null = env.DB_PII ? new D1Adapter({ db: env.DB_PII }) : null;
  if (piiAdapter) {
    const userPII = await piiAdapter.queryOne<{ email: string }>(
      'SELECT email FROM users_pii WHERE id = ?',
      [userId]
    );
    nameId = userPII?.email || null;
  }

  if (!nameId) {
    throw new Error('Logout request could not be processed');
  }
  const issuer = `${env.ISSUER_URL}/saml/idp`;
  const destination = spConfig.sloUrl || spConfig.acsUrl;

  // Build LogoutRequest
  const { buildLogoutRequest } = await import('../common/slo-messages');

  let logoutRequestXml = buildLogoutRequest({
    id: generateSAMLId(),
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    nameId,
    nameIdFormat: spConfig.nameIdFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    sessionIndex,
  });

  // Sign the request
  try {
    const { privateKeyPem } = await getSigningKey(env);
    const certificate = await getSigningCertificate(env);

    logoutRequestXml = signXml(logoutRequestXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${logoutRequestXml.match(/ID="([^"]+)"/)?.[1]}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    const log = createLogger().module('SAML-IDP-SLO');
    log.error('Error signing LogoutRequest', { action: 'sign_logout_request' }, error as Error);
  }

  return { logoutRequestXml, destination };
}

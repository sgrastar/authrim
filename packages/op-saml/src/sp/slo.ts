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
import type { Env, SAMLIdPConfig } from '@authrim/shared';
import { getSessionStoreBySessionId, isShardedSessionId } from '@authrim/shared';
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
import { generateSAMLId, nowAsDateTime } from '../common/xml-utils';
import { STATUS_CODES, DEFAULTS } from '../common/constants';
import { signXml, verifyXmlSignature, hasSignature } from '../common/signature';
import { getSigningKey, getSigningCertificate } from '../common/key-utils';
import { getIdPConfigByEntityId } from '../admin/providers';

/**
 * Handle SP Single Logout (both POST and GET)
 */
export async function handleSPSLO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;

  try {
    if (method === 'GET') {
      return handleRedirectBinding(c, env);
    } else {
      return handlePostBinding(c, env);
    }
  } catch (error) {
    console.error('SP SLO Error:', error);
    return c.json(
      {
        error: 'sp_slo_error',
        message: error instanceof Error ? error.message : 'SP single logout failed',
      },
      500
    );
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
    return processLogoutRequest(c, env, logoutRequest, relayState, 'post', samlRequest);
  } else if (samlResponse) {
    const logoutResponse = parseLogoutResponsePost(samlResponse);
    return processLogoutResponse(c, env, logoutResponse, relayState, samlResponse);
  } else {
    return c.json({ error: 'Missing SAMLRequest or SAMLResponse' }, 400);
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
    return c.json({ error: 'Missing SAMLRequest or SAMLResponse' }, 400);
  }
}

/**
 * Process LogoutRequest from IdP
 */
async function processLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  logoutRequest: ParsedLogoutRequest,
  relayState: string | null,
  binding: 'post' | 'redirect',
  originalXml?: string
): Promise<Response> {
  // Get IdP configuration
  const idpConfig = await getIdPConfigByEntityId(env, logoutRequest.issuer);

  if (!idpConfig) {
    console.error('Unknown IdP:', logoutRequest.issuer);
    return c.json({ error: 'Unknown Identity Provider' }, 400);
  }

  // Verify signature if present (for POST binding with embedded signature)
  if (originalXml && hasSignature(atob(originalXml))) {
    try {
      verifyXmlSignature(atob(originalXml), { certificateOrKey: idpConfig.certificate });
    } catch (error) {
      console.error('LogoutRequest signature verification failed:', error);
      return c.json({ error: 'Invalid signature on LogoutRequest' }, 400);
    }
  }

  // Validate LogoutRequest
  validateLogoutRequest(logoutRequest, env);

  // Terminate session by NameID
  await terminateSessionByNameId(env, logoutRequest.nameId, logoutRequest.sessionIndex);

  // Clear session cookie
  const cookieHeader = 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  // Build and send LogoutResponse to IdP
  return sendLogoutResponse(
    c,
    env,
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
  originalXml?: string
): Promise<Response> {
  // Get IdP configuration
  const idpConfig = await getIdPConfigByEntityId(env, logoutResponse.issuer);

  // Verify signature if present
  if (idpConfig && originalXml && hasSignature(atob(originalXml))) {
    try {
      verifyXmlSignature(atob(originalXml), { certificateOrKey: idpConfig.certificate });
    } catch (error) {
      console.error('LogoutResponse signature verification failed:', error);
      // Log but continue - some IdPs may not sign LogoutResponses
    }
  }

  // Check status
  if (logoutResponse.statusCode !== STATUS_CODES.SUCCESS) {
    console.warn(
      'IdP returned logout error:',
      logoutResponse.statusCode,
      logoutResponse.statusMessage
    );
  }

  // Clear session cookie and redirect to logout complete
  const returnUrl = relayState || `${env.UI_BASE_URL}/logout-complete`;

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

  // Validate Destination if present
  if (logoutRequest.destination) {
    const expectedDestination = `${env.ISSUER_URL}/saml/sp/slo`;
    if (logoutRequest.destination !== expectedDestination) {
      throw new Error(`Invalid Destination: expected ${expectedDestination}`);
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
  env: Env,
  nameId: string,
  sessionIndex?: string
): Promise<void> {
  try {
    // If sessionIndex is provided and is a valid sharded session ID, delete that specific session
    if (sessionIndex && isShardedSessionId(sessionIndex)) {
      try {
        const sessionStore = getSessionStoreBySessionId(env, sessionIndex);
        const response = await sessionStore.fetch(
          new Request(`https://session-store/session/${sessionIndex}`, {
            method: 'DELETE',
          })
        );
        if (response.ok) {
          console.log('SAML SP SLO: Terminated session:', sessionIndex);
          return;
        } else {
          console.debug('SAML SP SLO: Session not found or already deleted:', sessionIndex);
        }
      } catch (error) {
        console.warn('SAML SP SLO: Failed to delete session:', sessionIndex, error);
      }
    } else if (sessionIndex) {
      console.warn(
        'SAML SP SLO: sessionIndex is not in sharded format, cannot delete:',
        sessionIndex
      );
    }

    // Without a valid sessionIndex, we cannot delete by userId in sharded SessionStore
    // Log warning for debugging
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(nameId).first();
    if (user) {
      console.warn(
        `SAML SP SLO: Cannot delete all sessions for user ${user.id as string} (NameID: ${nameId}) - ` +
          'sharded SessionStore requires sessionId (sessionIndex). ' +
          'Ensure the IdP includes sessionIndex in LogoutRequest.'
      );
    } else {
      console.warn('SAML SP SLO: No user found for NameID:', nameId);
    }
  } catch (error) {
    console.error('Error terminating session:', error);
  }
}

/**
 * Send LogoutResponse to IdP
 */
async function sendLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
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
  const issuer = `${env.ISSUER_URL}/saml/sp`;

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
    console.error('Error signing LogoutResponse:', error);
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

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
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
  returnUrl?: string
): Promise<{ html: string }> {
  // Get user info for NameID
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();

  if (!user) {
    throw new Error('User not found');
  }

  const nameId = user.email as string;
  const issuer = `${env.ISSUER_URL}/saml/sp`;
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
    const { privateKeyPem } = await getSigningKey(env);
    const certificate = await getSigningCertificate(env);

    logoutRequestXml = signXml(logoutRequestXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${requestId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    console.error('Error signing LogoutRequest:', error);
  }

  // Encode for POST binding
  const encodedRequest = encodeForPostBinding(logoutRequestXml);

  // Build auto-submit form
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
    <input type="hidden" name="SAMLRequest" value="${escapeHtml(encodedRequest)}" />
    ${returnUrl ? `<input type="hidden" name="RelayState" value="${escapeHtml(returnUrl)}" />` : ''}
    <noscript>
      <button type="submit">Continue to Logout</button>
    </noscript>
  </form>
</body>
</html>`;

  return { html };
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

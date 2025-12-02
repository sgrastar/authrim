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
import type { Env, SAMLSPConfig } from '@authrim/shared';
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

  try {
    if (method === 'GET') {
      return handleRedirectBinding(c, env);
    } else {
      return handlePostBinding(c, env);
    }
  } catch (error) {
    console.error('IdP SLO Error:', error);
    return c.json(
      {
        error: 'slo_error',
        message: error instanceof Error ? error.message : 'Single logout failed',
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
    return processLogoutRequest(c, env, logoutRequest, relayState, 'post');
  } else if (samlResponse) {
    const logoutResponse = parseLogoutResponsePost(samlResponse);
    return processLogoutResponse(c, env, logoutResponse, relayState);
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
 * Process LogoutRequest from SP
 */
async function processLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  logoutRequest: ParsedLogoutRequest,
  relayState: string | null,
  binding: 'post' | 'redirect'
): Promise<Response> {
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
    env,
    logoutRequest.nameId,
    logoutRequest.sessionIndex
  );

  if (!sessionTerminated) {
    console.warn('No session found for NameID:', logoutRequest.nameId);
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
  // Validate LogoutResponse
  if (logoutResponse.statusCode !== STATUS_CODES.SUCCESS) {
    console.warn(
      'SP returned logout error:',
      logoutResponse.statusCode,
      logoutResponse.statusMessage
    );
  }

  // TODO: If we're propagating logout to multiple SPs, continue to next SP here

  // Redirect to logout complete page
  const logoutCompleteUrl = new URL(`${env.UI_BASE_URL}/logout-complete`);
  if (relayState) {
    logoutCompleteUrl.searchParams.set('relay_state', relayState);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: logoutCompleteUrl.toString(),
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
      throw new Error(`Invalid Destination: expected ${expectedDestination}`);
    }
  }
}

/**
 * Terminate session by NameID
 */
async function terminateSessionByNameId(
  env: Env,
  nameId: string,
  sessionIndex?: string
): Promise<boolean> {
  try {
    // Find user by email (assuming NameID is email)
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(nameId).first();

    if (!user) {
      return false;
    }

    const userId = user.id as string;

    // Get SessionStore
    const sessionStoreId = env.SESSION_STORE.idFromName('default');
    const sessionStore = env.SESSION_STORE.get(sessionStoreId);

    // If sessionIndex is provided, try to delete specific session
    if (sessionIndex) {
      await sessionStore.fetch(
        new Request(`https://session-store/session/${sessionIndex}`, {
          method: 'DELETE',
        })
      );
    }

    // Also delete all sessions for the user (SAML SLO should be comprehensive)
    await sessionStore.fetch(
      new Request(`https://session-store/sessions/user/${userId}`, {
        method: 'DELETE',
      })
    );

    return true;
  } catch (error) {
    console.error('Error terminating session:', error);
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
    const logoutCompleteUrl = new URL(`${env.UI_BASE_URL}/logout-complete`);
    if (relayState) {
      logoutCompleteUrl.searchParams.set('relay_state', relayState);
    }

    const headers: Record<string, string> = {
      Location: logoutCompleteUrl.toString(),
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
 * Initiate IdP-initiated SLO (send LogoutRequest to SP)
 */
export async function initiateIdPLogout(
  env: Env,
  userId: string,
  spConfig: SAMLSPConfig,
  sessionIndex?: string
): Promise<{ logoutRequestXml: string; destination: string }> {
  // Get user info for NameID
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();

  if (!user) {
    throw new Error('User not found');
  }

  const nameId = user.email as string;
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
    console.error('Error signing LogoutRequest:', error);
  }

  return { logoutRequestXml, destination };
}

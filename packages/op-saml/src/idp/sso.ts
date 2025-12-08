/**
 * SAML IdP SSO Endpoint
 *
 * Handles SP-initiated SSO flow:
 * 1. Receive AuthnRequest from SP (POST or Redirect binding)
 * 2. Verify user authentication (via SessionStore)
 * 3. Generate SAML Assertion and Response
 * 4. Return signed Response to SP's ACS URL
 *
 * GET  /saml/idp/sso - HTTP-Redirect Binding
 * POST /saml/idp/sso - HTTP-POST Binding
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import type { SAMLAuthnRequest, SAMLSPConfig } from '@authrim/shared';
import { getSessionStoreBySessionId, isShardedSessionId } from '@authrim/shared';
import * as pako from 'pako';
import {
  parseXml,
  findElement,
  getAttribute,
  getTextContent,
  base64Decode,
  generateSAMLId,
  nowAsDateTime,
  offsetDateTime,
} from '../common/xml-utils';
import {
  SAML_NAMESPACES,
  STATUS_CODES,
  DEFAULTS,
  NAMEID_FORMATS,
  AUTHN_CONTEXT,
} from '../common/constants';
import { signXml } from '../common/signature';
import { getSigningKey, getSigningCertificate } from '../common/key-utils';
import { buildSAMLResponse } from './assertion';
import { getSPConfig } from '../admin/providers';

/**
 * Handle SSO request (both GET and POST)
 */
export async function handleIdPSSO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;

  try {
    // Parse AuthnRequest based on binding
    let authnRequest: SAMLAuthnRequest;
    let relayState: string | undefined;

    if (method === 'GET') {
      // HTTP-Redirect Binding
      const { authnRequest: req, relayState: rs } = await parseRedirectBinding(c);
      authnRequest = req;
      relayState = rs;
    } else {
      // HTTP-POST Binding
      const { authnRequest: req, relayState: rs } = await parsePostBinding(c);
      authnRequest = req;
      relayState = rs;
    }

    // Validate AuthnRequest
    await validateAuthnRequest(authnRequest, env);

    // Get SP configuration
    const spConfig = await getSPConfig(env, authnRequest.issuer);
    if (!spConfig) {
      return createErrorResponse(c, 'Unknown Service Provider', STATUS_CODES.REQUEST_DENIED);
    }

    // Check user authentication
    const userId = await checkUserAuthentication(c, env);

    if (!userId) {
      // User not authenticated - redirect to login
      // Store AuthnRequest in SAMLRequestStore for later retrieval
      await storeAuthnRequest(env, authnRequest, relayState);

      // Redirect to login page with return URL
      const loginUrl = new URL(`${env.UI_BASE_URL}/login`);
      loginUrl.searchParams.set('saml_request_id', authnRequest.id);
      loginUrl.searchParams.set('return_to', 'saml_sso');

      return c.redirect(loginUrl.toString());
    }

    // Get user information
    const userInfo = await getUserInfo(env, userId);
    if (!userInfo) {
      return createErrorResponse(c, 'User not found', STATUS_CODES.UNKNOWN_PRINCIPAL);
    }

    // Generate SAML Response
    const responseXml = await generateSAMLResponse(env, authnRequest, spConfig, userInfo);

    // Return response based on SP's preferred binding
    return sendSAMLResponse(c, spConfig, responseXml, relayState);
  } catch (error) {
    console.error('SSO Error:', error);
    return createErrorResponse(
      c,
      error instanceof Error ? error.message : 'SSO processing failed',
      STATUS_CODES.RESPONDER
    );
  }
}

/**
 * Parse HTTP-Redirect binding parameters
 */
async function parseRedirectBinding(c: Context<{ Bindings: Env }>): Promise<{
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
}> {
  const url = new URL(c.req.url);
  const samlRequest = url.searchParams.get('SAMLRequest');
  const relayState = url.searchParams.get('RelayState') || undefined;

  if (!samlRequest) {
    throw new Error('Missing SAMLRequest parameter');
  }

  // Decode: URL decode -> Base64 decode -> Inflate (deflate decompress)
  const base64Decoded = base64Decode(samlRequest);
  const inflated = pako.inflateRaw(
    Uint8Array.from(base64Decoded, (c) => c.charCodeAt(0)),
    { to: 'string' }
  );

  return {
    authnRequest: parseAuthnRequestXml(inflated),
    relayState,
  };
}

/**
 * Parse HTTP-POST binding parameters
 */
async function parsePostBinding(c: Context<{ Bindings: Env }>): Promise<{
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
}> {
  const formData = await c.req.formData();
  const samlRequest = formData.get('SAMLRequest') as string;
  const relayState = (formData.get('RelayState') as string) || undefined;

  if (!samlRequest) {
    throw new Error('Missing SAMLRequest parameter');
  }

  // Decode: Base64 decode only (no compression for POST binding)
  const xmlString = base64Decode(samlRequest);

  return {
    authnRequest: parseAuthnRequestXml(xmlString),
    relayState,
  };
}

/**
 * Parse AuthnRequest XML into structured data
 */
function parseAuthnRequestXml(xml: string): SAMLAuthnRequest {
  const doc = parseXml(xml);
  const authnRequestElement = findElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest');

  if (!authnRequestElement) {
    throw new Error('Invalid AuthnRequest: missing AuthnRequest element');
  }

  const id = getAttribute(authnRequestElement, 'ID');
  const issueInstant = getAttribute(authnRequestElement, 'IssueInstant');
  const destination = getAttribute(authnRequestElement, 'Destination');
  const assertionConsumerServiceURL = getAttribute(
    authnRequestElement,
    'AssertionConsumerServiceURL'
  );
  const protocolBinding = getAttribute(authnRequestElement, 'ProtocolBinding');
  const forceAuthnAttr = getAttribute(authnRequestElement, 'ForceAuthn');
  const isPassiveAttr = getAttribute(authnRequestElement, 'IsPassive');

  if (!id || !issueInstant) {
    throw new Error('Invalid AuthnRequest: missing required attributes');
  }

  // Parse Issuer
  const issuerElement = findElement(authnRequestElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement);

  if (!issuer) {
    throw new Error('Invalid AuthnRequest: missing Issuer');
  }

  // Parse NameIDPolicy (optional)
  let nameIdPolicy: SAMLAuthnRequest['nameIdPolicy'] | undefined;
  const nameIdPolicyElement = findElement(
    authnRequestElement,
    SAML_NAMESPACES.SAML2P,
    'NameIDPolicy'
  );
  if (nameIdPolicyElement) {
    const format = getAttribute(nameIdPolicyElement, 'Format');
    nameIdPolicy = {
      format: format as NonNullable<SAMLAuthnRequest['nameIdPolicy']>['format'],
      allowCreate: getAttribute(nameIdPolicyElement, 'AllowCreate') === 'true',
      spNameQualifier: getAttribute(nameIdPolicyElement, 'SPNameQualifier') || undefined,
    };
  }

  return {
    id,
    issueInstant,
    destination: destination || undefined,
    assertionConsumerServiceURL: assertionConsumerServiceURL || undefined,
    protocolBinding: protocolBinding as SAMLAuthnRequest['protocolBinding'],
    issuer,
    nameIdPolicy,
    forceAuthn: forceAuthnAttr === 'true',
    isPassive: isPassiveAttr === 'true',
  };
}

/**
 * Validate AuthnRequest
 */
async function validateAuthnRequest(authnRequest: SAMLAuthnRequest, env: Env): Promise<void> {
  // Check request is not expired (allow clock skew)
  const issueInstant = new Date(authnRequest.issueInstant);
  const now = new Date();
  const skewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
  const maxAge = DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000;

  if (issueInstant.getTime() > now.getTime() + skewMs) {
    throw new Error('AuthnRequest IssueInstant is in the future');
  }

  if (now.getTime() - issueInstant.getTime() > maxAge + skewMs) {
    throw new Error('AuthnRequest has expired');
  }

  // Validate Destination if present
  if (authnRequest.destination) {
    const expectedDestination = `${env.ISSUER_URL}/saml/idp/sso`;
    if (authnRequest.destination !== expectedDestination) {
      throw new Error(`Invalid Destination: expected ${expectedDestination}`);
    }
  }
}

/**
 * Check if user is authenticated (sharded)
 */
async function checkUserAuthentication(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<string | null> {
  // Check for session cookie
  const sessionId = c.req.header('Cookie')?.match(/authrim_session=([^;]+)/)?.[1];

  if (!sessionId) {
    return null;
  }

  // Verify session with SessionStore (sharded)
  if (!isShardedSessionId(sessionId)) {
    return null;
  }

  try {
    const sessionStore = getSessionStoreBySessionId(env, sessionId);
    const response = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionId}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      return null;
    }

    const session = (await response.json()) as { userId?: string };
    return session.userId || null;
  } catch {
    return null;
  }
}

/**
 * Store AuthnRequest for later retrieval after login
 */
async function storeAuthnRequest(
  env: Env,
  authnRequest: SAMLAuthnRequest,
  relayState?: string
): Promise<void> {
  const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(`issuer:${authnRequest.issuer}`);
  const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

  await samlRequestStore.fetch(
    new Request('https://saml-request-store/store', {
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
        expiresAt: Date.now() + DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000,
      }),
    })
  );
}

/**
 * Get user information from database
 */
async function getUserInfo(
  env: Env,
  userId: string
): Promise<{ id: string; email: string; name?: string } | null> {
  const result = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  return {
    id: result.id as string,
    email: result.email as string,
    name: result.name as string | undefined,
  };
}

/**
 * Generate SAML Response with Assertion
 */
async function generateSAMLResponse(
  env: Env,
  authnRequest: SAMLAuthnRequest,
  spConfig: SAMLSPConfig,
  userInfo: { id: string; email: string; name?: string }
): Promise<string> {
  const issuerUrl = env.ISSUER_URL;
  const { privateKeyPem, kid } = await getSigningKey(env);
  const certificate = await getSigningCertificate(env);

  // Determine NameID value based on format
  let nameIdValue: string;
  const nameIdFormat =
    authnRequest.nameIdPolicy?.format || spConfig.nameIdFormat || NAMEID_FORMATS.EMAIL;

  switch (nameIdFormat) {
    case NAMEID_FORMATS.EMAIL:
      nameIdValue = userInfo.email;
      break;
    case NAMEID_FORMATS.PERSISTENT:
    case NAMEID_FORMATS.TRANSIENT:
      nameIdValue = userInfo.id;
      break;
    default:
      nameIdValue = userInfo.email;
  }

  // Determine ACS URL
  const acsUrl = authnRequest.assertionConsumerServiceURL || spConfig.acsUrl;

  // Build SAML Response
  const responseXml = buildSAMLResponse({
    responseId: generateSAMLId(),
    assertionId: generateSAMLId(),
    issueInstant: nowAsDateTime(),
    issuer: `${issuerUrl}/saml/idp`,
    destination: acsUrl,
    inResponseTo: authnRequest.id,
    recipientUrl: acsUrl,
    audienceRestriction: spConfig.entityId,
    nameId: nameIdValue,
    nameIdFormat,
    authnInstant: nowAsDateTime(),
    sessionIndex: generateSAMLId(),
    notBefore: nowAsDateTime(),
    notOnOrAfter: offsetDateTime(
      spConfig.assertionValiditySeconds || DEFAULTS.ASSERTION_VALIDITY_SECONDS
    ),
    authnContextClassRef: AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT,
    attributes: buildAttributes(userInfo, spConfig.attributeMapping),
  });

  // Sign the response if required
  if (spConfig.signResponses || spConfig.signAssertions) {
    return signXml(responseXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${responseXml.match(/Response[^>]*ID="([^"]+)"/)?.[1]}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  }

  return responseXml;
}

/**
 * Build SAML attributes from user info and mapping
 */
function buildAttributes(
  userInfo: { id: string; email: string; name?: string },
  attributeMapping: Record<string, string>
): Array<{ name: string; values: string[] }> {
  const attributes: Array<{ name: string; values: string[] }> = [];

  // Add mapped attributes
  for (const [claim, samlAttr] of Object.entries(attributeMapping)) {
    let value: string | undefined;

    switch (claim) {
      case 'email':
        value = userInfo.email;
        break;
      case 'name':
        value = userInfo.name;
        break;
      case 'sub':
        value = userInfo.id;
        break;
      default:
        // Skip unknown claims
        continue;
    }

    if (value) {
      attributes.push({
        name: samlAttr,
        values: [value],
      });
    }
  }

  return attributes;
}

/**
 * Send SAML Response to SP's ACS
 */
function sendSAMLResponse(
  c: Context<{ Bindings: Env }>,
  spConfig: SAMLSPConfig,
  responseXml: string,
  relayState?: string
): Response {
  // Encode response as Base64
  const encodedResponse = btoa(responseXml);

  // Build auto-submit form (HTTP-POST binding)
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SAML SSO</title>
</head>
<body onload="document.forms[0].submit()">
  <noscript>
    <p>JavaScript is disabled. Click the button to continue.</p>
  </noscript>
  <form method="POST" action="${escapeHtml(spConfig.acsUrl)}">
    <input type="hidden" name="SAMLResponse" value="${escapeHtml(encodedResponse)}" />
    ${relayState ? `<input type="hidden" name="RelayState" value="${escapeHtml(relayState)}" />` : ''}
    <noscript>
      <button type="submit">Continue to Service Provider</button>
    </noscript>
  </form>
</body>
</html>
`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

/**
 * Create SAML error response
 */
function createErrorResponse(
  c: Context<{ Bindings: Env }>,
  message: string,
  statusCode: string
): Response {
  return c.json(
    {
      error: 'saml_error',
      message,
      status_code: statusCode,
    },
    400
  );
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

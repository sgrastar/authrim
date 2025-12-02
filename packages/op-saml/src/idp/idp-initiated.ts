/**
 * IdP-Initiated SSO Endpoint
 *
 * Allows the IdP to initiate SSO without receiving an AuthnRequest from the SP.
 * GET /saml/idp/init?sp=<sp_entity_id>
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import type { SAMLSPConfig } from '@authrim/shared';
import { generateSAMLId, nowAsDateTime, offsetDateTime } from '../common/xml-utils';
import { NAMEID_FORMATS, AUTHN_CONTEXT, DEFAULTS, STATUS_CODES } from '../common/constants';
import { getSigningKey, getSigningCertificate } from '../common/key-utils';
import { signXml } from '../common/signature';
import { buildSAMLResponse } from './assertion';
import { getSPConfig, listSPConfigs } from '../admin/providers';

/**
 * Handle IdP-initiated SSO
 */
export async function handleIdPInitiated(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  try {
    // Get SP entity ID from query parameter
    const spEntityId = c.req.query('sp');

    if (!spEntityId) {
      // Return list of available SPs if no SP specified
      const sps = await listSPConfigs(env);
      return c.html(buildSPSelectionPage(env.ISSUER_URL, sps));
    }

    // Get SP configuration
    const spConfig = await getSPConfig(env, spEntityId);
    if (!spConfig) {
      return c.json({ error: 'Unknown Service Provider' }, 404);
    }

    // Check user authentication
    const userId = await checkUserAuthentication(c, env);

    if (!userId) {
      // Redirect to login with return URL
      const loginUrl = new URL(`${env.UI_BASE_URL}/login`);
      loginUrl.searchParams.set(
        'return_to',
        `${env.ISSUER_URL}/saml/idp/init?sp=${encodeURIComponent(spEntityId)}`
      );
      return c.redirect(loginUrl.toString());
    }

    // Get user information
    const userInfo = await getUserInfo(env, userId);
    if (!userInfo) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Generate SAML Response (no InResponseTo since this is IdP-initiated)
    const responseXml = await generateIdPInitiatedResponse(env, spConfig, userInfo);

    // Return auto-submit form
    return sendSAMLResponse(c, spConfig, responseXml);
  } catch (error) {
    console.error('IdP-Initiated SSO Error:', error);
    return c.json(
      {
        error: 'idp_init_error',
        message: error instanceof Error ? error.message : 'IdP-initiated SSO failed',
      },
      500
    );
  }
}

/**
 * Check if user is authenticated
 */
async function checkUserAuthentication(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<string | null> {
  const sessionId = c.req.header('Cookie')?.match(/authrim_session=([^;]+)/)?.[1];

  if (!sessionId) {
    return null;
  }

  const sessionStoreId = env.SESSION_STORE.idFromName('default');
  const sessionStore = env.SESSION_STORE.get(sessionStoreId);

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
 * Generate SAML Response for IdP-initiated SSO
 */
async function generateIdPInitiatedResponse(
  env: Env,
  spConfig: SAMLSPConfig,
  userInfo: { id: string; email: string; name?: string }
): Promise<string> {
  const issuerUrl = env.ISSUER_URL;
  const { privateKeyPem } = await getSigningKey(env);
  const certificate = await getSigningCertificate(env);

  // Determine NameID value
  let nameIdValue: string;
  const nameIdFormat = spConfig.nameIdFormat || NAMEID_FORMATS.EMAIL;

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

  // Build attributes from mapping
  const attributes = buildAttributes(userInfo, spConfig.attributeMapping);

  // Build SAML Response (no InResponseTo for IdP-initiated)
  const responseId = generateSAMLId();
  const responseXml = buildSAMLResponse({
    responseId,
    assertionId: generateSAMLId(),
    issueInstant: nowAsDateTime(),
    issuer: `${issuerUrl}/saml/idp`,
    destination: spConfig.acsUrl,
    // No inResponseTo for IdP-initiated
    recipientUrl: spConfig.acsUrl,
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
    attributes,
  });

  // Sign if required
  if (spConfig.signResponses || spConfig.signAssertions) {
    return signXml(responseXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${responseId}`,
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
        continue;
    }

    if (value) {
      attributes.push({ name: samlAttr, values: [value] });
    }
  }

  return attributes;
}

/**
 * Send SAML Response via auto-submit form
 */
function sendSAMLResponse(
  c: Context<{ Bindings: Env }>,
  spConfig: SAMLSPConfig,
  responseXml: string,
  relayState?: string
): Response {
  const encodedResponse = btoa(responseXml);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SAML SSO - Redirecting...</title>
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
 * Build SP selection page
 */
function buildSPSelectionPage(
  issuerUrl: string,
  sps: Array<{ id: string; name: string; entityId: string }>
): string {
  const spLinks = sps
    .map(
      (sp) =>
        `<li><a href="${issuerUrl}/saml/idp/init?sp=${encodeURIComponent(sp.entityId)}">${escapeHtml(sp.name)}</a></li>`
    )
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Select Service Provider</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    ul { list-style: none; padding: 0; }
    li { margin: 10px 0; }
    a { color: #0066cc; text-decoration: none; padding: 10px 15px; display: inline-block; border: 1px solid #ddd; border-radius: 5px; }
    a:hover { background: #f0f0f0; }
  </style>
</head>
<body>
  <h1>Select Service Provider</h1>
  <p>Choose a service provider to sign in to:</p>
  <ul>
    ${spLinks || '<li>No service providers configured.</li>'}
  </ul>
</body>
</html>
`;
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

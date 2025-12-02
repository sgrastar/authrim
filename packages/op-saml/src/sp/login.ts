/**
 * SAML SP Login Initiation Endpoint
 *
 * Starts SP-initiated SSO by generating an AuthnRequest and redirecting to IdP.
 * GET /saml/sp/login?idp=<idp_id>
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import type { SAMLIdPConfig } from '@authrim/shared';
import * as pako from 'pako';
import { SAML_NAMESPACES, BINDING_URIS, NAMEID_FORMATS } from '../common/constants';
import {
  createDocument,
  createElement,
  setAttribute,
  setTextContent,
  appendChild,
  addNamespaceDeclarations,
  serializeXml,
  generateSAMLId,
  nowAsDateTime,
  base64Encode,
} from '../common/xml-utils';
import { signRedirectBinding } from '../common/signature';
import { getSigningKey } from '../common/key-utils';
import { getIdPConfig, listIdPConfigs } from '../admin/providers';

/**
 * Handle SP login initiation
 */
export async function handleSPLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  try {
    // Get IdP ID from query parameter
    const idpId = c.req.query('idp');
    const returnUrl = c.req.query('return_url') || `${env.UI_BASE_URL}/`;

    if (!idpId) {
      // Return list of available IdPs if no IdP specified
      const idps = await listIdPConfigs(env);
      return c.html(buildIdPSelectionPage(env.ISSUER_URL, idps, returnUrl));
    }

    // Get IdP configuration
    const idpConfig = await getIdPConfig(env, idpId);
    if (!idpConfig) {
      return c.json({ error: 'Unknown Identity Provider' }, 404);
    }

    // Generate AuthnRequest
    const authnRequestXml = buildAuthnRequest(env, idpConfig);

    // Store request in SAMLRequestStore for later validation
    const requestId = authnRequestXml.match(/ID="([^"]+)"/)?.[1] || '';
    await storeAuthnRequest(env, requestId, idpConfig.entityId, returnUrl);

    // Redirect to IdP based on preferred binding
    if (idpConfig.allowedBindings.includes('redirect')) {
      return redirectToIdP(c, env, idpConfig, authnRequestXml, returnUrl);
    } else {
      return postToIdP(c, idpConfig, authnRequestXml, returnUrl);
    }
  } catch (error) {
    console.error('SP Login Error:', error);
    return c.json(
      {
        error: 'sp_login_error',
        message: error instanceof Error ? error.message : 'SP login initiation failed',
      },
      500
    );
  }
}

/**
 * Build SAML AuthnRequest
 */
function buildAuthnRequest(env: Env, idpConfig: SAMLIdPConfig): string {
  const issuerUrl = env.ISSUER_URL;
  const spEntityId = `${issuerUrl}/saml/sp`;
  const acsUrl = `${issuerUrl}/saml/sp/acs`;

  const doc = createDocument();

  // Create AuthnRequest element
  const authnRequest = createElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest', 'samlp');
  setAttribute(authnRequest, 'ID', generateSAMLId());
  setAttribute(authnRequest, 'Version', '2.0');
  setAttribute(authnRequest, 'IssueInstant', nowAsDateTime());
  setAttribute(authnRequest, 'Destination', idpConfig.ssoUrl);
  setAttribute(authnRequest, 'AssertionConsumerServiceURL', acsUrl);
  setAttribute(authnRequest, 'ProtocolBinding', BINDING_URIS.HTTP_POST);

  // Add namespace declarations
  addNamespaceDeclarations(authnRequest, {
    samlp: SAML_NAMESPACES.SAML2P,
    saml: SAML_NAMESPACES.SAML2,
  });

  // Add Issuer
  const issuerElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
  setTextContent(issuerElement, spEntityId);
  appendChild(authnRequest, issuerElement);

  // Add NameIDPolicy
  const nameIdPolicy = createElement(doc, SAML_NAMESPACES.SAML2P, 'NameIDPolicy', 'samlp');
  setAttribute(nameIdPolicy, 'Format', idpConfig.nameIdFormat || NAMEID_FORMATS.EMAIL);
  setAttribute(nameIdPolicy, 'AllowCreate', 'true');
  appendChild(authnRequest, nameIdPolicy);

  // Append to document and serialize
  appendChild(doc, authnRequest);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}

/**
 * Store AuthnRequest for later validation
 */
async function storeAuthnRequest(
  env: Env,
  requestId: string,
  idpEntityId: string,
  returnUrl: string
): Promise<void> {
  const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(`issuer:${idpEntityId}`);
  const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

  await samlRequestStore.fetch(
    new Request('https://saml-request-store/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        issuer: `${env.ISSUER_URL}/saml/sp`,
        destination: env.ISSUER_URL,
        binding: 'post',
        type: 'authn_request',
        relayState: returnUrl,
        expiresAt: Date.now() + 300 * 1000, // 5 minutes
      }),
    })
  );
}

/**
 * Redirect to IdP using HTTP-Redirect binding
 */
async function redirectToIdP(
  c: Context<{ Bindings: Env }>,
  env: Env,
  idpConfig: SAMLIdPConfig,
  authnRequestXml: string,
  returnUrl: string
): Promise<Response> {
  // Deflate and Base64 encode the request
  const deflated = pako.deflateRaw(authnRequestXml);
  const base64Encoded = base64Encode(String.fromCharCode(...deflated));

  // Build redirect URL
  const url = new URL(idpConfig.ssoUrl);
  url.searchParams.set('SAMLRequest', base64Encoded);
  url.searchParams.set('RelayState', returnUrl);

  // Sign if we have signing capability
  try {
    const { privateKeyPem } = await getSigningKey(env);
    const { signedUrl } = await signRedirectBinding(
      'SAMLRequest',
      base64Encoded,
      returnUrl,
      privateKeyPem
    );
    return c.redirect(`${idpConfig.ssoUrl}?${signedUrl}`);
  } catch {
    // If signing fails, redirect without signature
    return c.redirect(url.toString());
  }
}

/**
 * POST to IdP using HTTP-POST binding
 */
function postToIdP(
  c: Context<{ Bindings: Env }>,
  idpConfig: SAMLIdPConfig,
  authnRequestXml: string,
  returnUrl: string
): Response {
  // Base64 encode the request (no deflate for POST binding)
  const base64Encoded = base64Encode(authnRequestXml);

  // Build auto-submit form
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Redirecting to Identity Provider...</title>
</head>
<body onload="document.forms[0].submit()">
  <noscript>
    <p>JavaScript is disabled. Click the button to continue.</p>
  </noscript>
  <form method="POST" action="${escapeHtml(idpConfig.ssoUrl)}">
    <input type="hidden" name="SAMLRequest" value="${escapeHtml(base64Encoded)}" />
    <input type="hidden" name="RelayState" value="${escapeHtml(returnUrl)}" />
    <noscript>
      <button type="submit">Continue to Identity Provider</button>
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
 * Build IdP selection page
 */
function buildIdPSelectionPage(
  issuerUrl: string,
  idps: Array<{ id: string; name: string; entityId: string }>,
  returnUrl: string
): string {
  const idpLinks = idps
    .map(
      (idp) =>
        `<li><a href="${issuerUrl}/saml/sp/login?idp=${encodeURIComponent(idp.id)}&return_url=${encodeURIComponent(returnUrl)}">${escapeHtml(idp.name)}</a></li>`
    )
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Select Identity Provider</title>
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
  <h1>Select Identity Provider</h1>
  <p>Choose an identity provider to sign in with:</p>
  <ul>
    ${idpLinks || '<li>No identity providers configured.</li>'}
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

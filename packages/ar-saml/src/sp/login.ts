/**
 * SAML SP Login Initiation Endpoint
 *
 * Starts SP-initiated SSO by generating an AuthnRequest and redirecting to IdP.
 * GET /saml/sp/login?idp=<idp_id>
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { SAMLIdPConfig } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildIssuerUrl,
  buildSAMLRequestStoreInstanceName,
  getLogger,
  verifyHumanVerificationWithRunner,
} from '@authrim/ar-lib-core';
import * as pako from 'pako';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
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
  base64EncodeBytes,
} from '../common/xml-utils';
import { signRedirectBinding } from '../common/signature';
import { getSAMLSigningMaterial, getSAMLSigningPolicy } from '../common/saml-signing-keys';
import { getIdPConfig, listIdPConfigs } from '../admin/providers';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize } from '../common/relay-state';
import { buildSAMLRequestBindingCookie } from './request-browser-binding';

function remoteIp(c: Context<{ Bindings: Env }>): string | undefined {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    undefined
  );
}

async function verifySPLoginHumanVerification(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  try {
    const result = await verifyHumanVerificationWithRunner(c.env, {
      tenantId,
      action: 'login',
      responseToken:
        c.req.query('human_verification_response') ?? c.req.query('cf_turnstile_response'),
      remoteIp: remoteIp(c),
    });
    if (result.verified) return null;
  } catch {
    // Provider, configuration, and Runner failures share the same public denial.
  }

  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field: 'human_verification_response' },
  });
}

/**
 * Handle SP login initiation
 */
export async function handleSPLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-SP');

  try {
    // Get IdP ID from query parameter
    const idpId = c.req.query('idp');
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const turnstileError = await verifySPLoginHumanVerification(c, tenantId);
    if (turnstileError) return turnstileError;
    const { issuerUrl, spEntityId } = await getSAMLLocalEntityIds(env, tenantId);

    // Determine return URL with UI config fallback. Only local Authrim/Login UI origins are accepted.
    const requestedReturnUrl = c.req.query('return_url');
    const uiConfig = await getUIConfig(env);
    const defaultReturnUrl = uiConfig?.baseUrl ? `${uiConfig.baseUrl}/` : `${issuerUrl}/`;
    const returnUrl = resolveSafeReturnUrl(env, tenantId, requestedReturnUrl) ?? defaultReturnUrl;

    if (!idpId) {
      // Return list of available IdPs if no IdP specified
      const idps = await listIdPConfigs(env, tenantId);
      return c.html(buildIdPSelectionPage(issuerUrl, idps, returnUrl));
    }

    // Get IdP configuration
    const idpConfig = await getIdPConfig(env, tenantId, idpId);
    if (!idpConfig) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const outboundIdpConfig = withSPInitiatedSsoEndpoint(idpConfig);

    // Generate AuthnRequest
    const authnRequestXml = buildAuthnRequest(issuerUrl, spEntityId, outboundIdpConfig);

    // Store request in SAMLRequestStore for later validation
    const requestId = authnRequestXml.match(/ID="([^"]+)"/)?.[1] || '';
    if (!requestId) {
      throw new Error('Generated SAML AuthnRequest is missing ID');
    }
    await storeAuthnRequest(
      env,
      tenantId,
      requestId,
      spEntityId,
      outboundIdpConfig.entityId,
      returnUrl
    );

    // RelayState is limited by the SAML bindings; use the opaque request ID, not the return URL.
    const relayState = requestId;
    assertSAMLRelayStateSize(relayState);

    // Redirect to IdP based on preferred binding
    const response = outboundIdpConfig.allowedBindings.includes('redirect')
      ? await redirectToIdP(c, env, outboundIdpConfig, authnRequestXml, relayState)
      : postToIdP(outboundIdpConfig, authnRequestXml, relayState);
    response.headers.append('Set-Cookie', buildSAMLRequestBindingCookie(requestId));
    return response;
  } catch (error) {
    log.error('SP Login Error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function deriveRedirectSsoUrl(ssoUrl: string): string | null {
  try {
    const url = new URL(ssoUrl);
    if (!/\/POST\/SSO\/?$/iu.test(url.pathname)) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/POST\/SSO\/?$/iu, '/Redirect/SSO');
    return url.toString();
  } catch {
    return null;
  }
}

function withSPInitiatedSsoEndpoint(idpConfig: SAMLIdPConfig): SAMLIdPConfig {
  if (!idpConfig.allowedBindings.includes('redirect')) {
    return idpConfig;
  }

  const redirectSsoUrl = deriveRedirectSsoUrl(idpConfig.ssoUrl);
  if (!redirectSsoUrl) {
    return idpConfig;
  }

  return {
    ...idpConfig,
    ssoUrl: redirectSsoUrl,
  };
}

/**
 * Build SAML AuthnRequest
 */
function buildAuthnRequest(
  issuerUrl: string,
  spEntityId: string,
  idpConfig: SAMLIdPConfig
): string {
  const acsUrl = `${issuerUrl}/saml/sp/acs`;
  const providerName = idpConfig.providerName?.trim() || 'Authrim';

  const doc = createDocument();

  // Create AuthnRequest element
  const authnRequest = createElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest', 'samlp');
  setAttribute(authnRequest, 'ID', generateSAMLId());
  setAttribute(authnRequest, 'Version', '2.0');
  setAttribute(authnRequest, 'IssueInstant', nowAsDateTime());
  setAttribute(authnRequest, 'Destination', idpConfig.ssoUrl);
  setAttribute(authnRequest, 'AssertionConsumerServiceURL', acsUrl);
  setAttribute(authnRequest, 'ProtocolBinding', BINDING_URIS.HTTP_POST);
  setAttribute(authnRequest, 'ProviderName', providerName);

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
  tenantId: string,
  requestId: string,
  spEntityId: string,
  idpEntityId: string,
  returnUrl: string
): Promise<void> {
  const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(
    buildSAMLRequestStoreInstanceName(tenantId, 'sp', idpEntityId)
  );
  const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

  await samlRequestStore.fetch('https://saml-request-store/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      issuer: spEntityId,
      destination: idpEntityId,
      binding: 'post',
      type: 'authn_request',
      relayState: returnUrl,
      expiresAt: Date.now() + 300 * 1000, // 5 minutes
    }),
  });
}

/**
 * Redirect to IdP using HTTP-Redirect binding
 */
async function redirectToIdP(
  c: Context<{ Bindings: Env }>,
  env: Env,
  idpConfig: SAMLIdPConfig,
  authnRequestXml: string,
  relayState: string
): Promise<Response> {
  // Deflate and Base64 encode the request
  const deflated = pako.deflateRaw(authnRequestXml);
  const base64Encoded = base64EncodeBytes(deflated);

  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { privateKeyPem } = await getSAMLSigningMaterial(env, {
    tenantId,
    role: 'sp',
    counterpartyEntityId: idpConfig.entityId,
    policy: getSAMLSigningPolicy(idpConfig),
  });
  const { signedUrl } = await signRedirectBinding(
    'SAMLRequest',
    base64Encoded,
    relayState,
    privateKeyPem
  );
  return c.redirect(`${idpConfig.ssoUrl}?${signedUrl}`);
}

/**
 * POST to IdP using HTTP-POST binding
 */
function postToIdP(
  idpConfig: SAMLIdPConfig,
  authnRequestXml: string,
  relayState: string
): Response {
  assertSAMLRelayStateSize(relayState);
  // Base64 encode the request (no deflate for POST binding)
  const base64Encoded = base64Encode(authnRequestXml);

  return buildSAMLPostBindingResponse({
    title: 'SAML SSO - Redirecting...',
    actionUrl: idpConfig.ssoUrl,
    fields: [
      { name: 'SAMLRequest', value: base64Encoded },
      { name: 'RelayState', value: relayState },
    ],
    buttonText: 'Continue to Identity Provider',
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

function resolveSafeReturnUrl(
  env: Env,
  tenantId: string,
  value: string | undefined
): string | null {
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const allowedOrigins = new Set(
    [
      getUrlOrigin(buildIssuerUrl(env, tenantId)),
      getUrlOrigin((env as unknown as Record<string, unknown>).UI_URL),
    ].filter((origin): origin is string => Boolean(origin))
  );

  return allowedOrigins.has(url.origin) ? url.toString() : null;
}

function getUrlOrigin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

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
import type { Env } from '@authrim/ar-lib-core';
import type { SAMLAuthnRequest, SAMLRequestData, SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  getUIConfig,
  getTenantSettings,
  buildIssuerUrl,
  buildSAMLRequestStoreInstanceName,
  shouldUseBuiltinForms,
  createConfigurationError,
  getLogger,
} from '@authrim/ar-lib-core';
import {
  parseXml,
  findDirectChildElement,
  getAttribute,
  getTextContent,
  generateSAMLId,
  base64Encode,
} from '../common/xml-utils';
import {
  decodePostBindingMessage,
  inflateRedirectBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../common/message-limits';
import { SAML_NAMESPACES, STATUS_CODES, DEFAULTS } from '../common/constants';
import { buildSAMLResponse } from './assertion';
import { getSPConfig } from '../admin/providers';
import { getSamlUserInfoById, type SAMLUserInfo } from '../common/user-store';
import { getSAMLSigningMaterial, getSAMLSigningPolicy } from '../common/saml-signing-keys';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import {
  buildSAMLAttributesForSPWithDiagnostics,
  MissingRequiredSAMLAttributeError,
} from './attributes';
import {
  SAMLAuthnRequestSignatureValidationError,
  validateSAMLAuthnRequestSignature,
  type SAMLRedirectSignatureInput,
} from './authn-request-signature';
import {
  parseRequestedAuthnContext,
  resolveSAMLAuthnContextClassRef,
  SAMLAuthnContextPolicyError,
} from './authn-context';
import { resolveSAMLAuthnInteraction } from './authn-request-policy';
import {
  InvalidSAMLResponseDestinationError,
  resolveSAMLResponseDestination,
  UnsupportedSAMLResponseBindingError,
  validateSAMLResponseProtocolBinding,
} from './response-destination';
import { getSAMLInteractiveLoginUrlPolicy } from '../common/entity-id';
import { applySAMLResponseSigningPolicy } from './signing';
import { applySAMLAssertionEncryptionPolicy } from './encryption';
import {
  createSAMLSessionIndex,
  SAMLNameIDPolicyError,
  resolveSAMLNameIDFormat,
  resolveSAMLNameIDValue,
  resolveSAMLPairwiseSecret,
  resolveSAMLPersistentNameIDRegistryStore,
  resolveSAMLTransientNameIDStore,
} from './subject';
import { extractAuthrimSessionIdFromCookieHeader } from '../common/session-cookie';
import {
  applySAMLErrorResponseOverride,
  buildSAMLIdPErrorResponse,
  getSAMLAttributeReleaseFailureStatusMessage,
} from './error-response';
import { scheduleSAMLPolicyFailureAudit } from './audit';
import { buildSAMLAssertionTiming } from './assertion-timing';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { getSAMLLocalEntityIds } from '../common/entity-id';

interface AuthenticatedSAMLSession {
  userId: string;
  sessionId: string;
  acr?: string;
  amr?: string[];
}

interface ParsedAuthnRequestInput {
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
  binding: 'redirect' | 'post';
  xml: string;
  storedRequestValidated?: boolean;
  redirectSignature?: SAMLRedirectSignatureInput;
}

/**
 * Handle SSO request (both GET and POST)
 */
export async function handleIdPSSO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;
  const log = getLogger(c).module('SAML-IDP');
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { issuerUrl, idpEntityId } = await getSAMLLocalEntityIds(env, tenantId);

  try {
    // Parse AuthnRequest based on binding
    let parsedInput: ParsedAuthnRequestInput;

    if (method === 'GET') {
      // HTTP-Redirect Binding
      parsedInput = (await parseStoredAuthnRequest(c, tenantId)) ?? (await parseRedirectBinding(c));
    } else {
      // HTTP-POST Binding
      parsedInput = await parsePostBinding(c);
    }

    const { authnRequest, relayState } = parsedInput;

    // Validate AuthnRequest
    await validateAuthnRequest(authnRequest, issuerUrl);

    // Get SP configuration
    const spConfig = await getSPConfig(env, tenantId, authnRequest.issuer);
    if (!spConfig) {
      return createErrorResponse(c, 'Unknown Service Provider', STATUS_CODES.REQUEST_DENIED);
    }

    try {
      if (!parsedInput.storedRequestValidated) {
        await validateSAMLAuthnRequestSignature({
          authnRequest,
          spConfig,
          binding: parsedInput.binding,
          xml: parsedInput.xml,
          redirectSignature: parsedInput.redirectSignature,
        });
      }
      validateSAMLResponseProtocolBinding(authnRequest);
      resolveSAMLResponseDestination(authnRequest, spConfig);
    } catch (error) {
      if (error instanceof SAMLAuthnRequestSignatureValidationError) {
        log.warn('SAML AuthnRequest signature policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: error.failureKind,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: error.failureKind,
          policyDetails: error.details,
        });

        const responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.REQUESTER,
          STATUS_CODES.REQUEST_DENIED,
          'SAML request was rejected by IdP policy',
          error.failureKind
        );
        return sendSAMLResponse(
          c,
          resolveSAMLResponseDestination(authnRequest, spConfig),
          responseXml,
          relayState
        );
      }

      if (error instanceof InvalidSAMLResponseDestinationError) {
        log.warn('SAML AuthnRequest ACS URL policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_invalid_acs_url',
          policyDetails: {
            requested_acs_url: error.requestedAcsUrl,
            allowed_acs_urls: error.allowedAcsUrls,
          },
        });
      }

      if (error instanceof UnsupportedSAMLResponseBindingError) {
        log.warn('SAML AuthnRequest response binding policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          requestedBinding: error.requestedBinding,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_unsupported_response_binding',
          policyDetails: {
            requested_binding: error.requestedBinding,
            supported_bindings: error.supportedBindings,
          },
        });

        const responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.REQUESTER,
          STATUS_CODES.UNSUPPORTED_BINDING,
          'Requested SAML response binding is not supported',
          'authn_request_unsupported_response_binding'
        );
        return sendSAMLResponse(
          c,
          resolveSAMLResponseDestination(authnRequest, spConfig),
          responseXml,
          relayState
        );
      }

      throw error;
    }

    // Check user authentication
    const authenticatedSession = await checkUserAuthentication(c, env);
    const authnInteraction = resolveSAMLAuthnInteraction(authnRequest, authenticatedSession);

    if (authnInteraction.action === 'protocol_error') {
      log.warn('SAML AuthnRequest interaction policy failed', {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: authnRequest.id,
        failureKind: authnInteraction.failureKind,
      });
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: authnRequest.id,
        failureKind: authnInteraction.failureKind,
        policyDetails: authnInteraction.policyDetails,
      });

      const responseXml = await generateSAMLProtocolErrorResponse(
        issuerUrl,
        idpEntityId,
        env,
        authnRequest,
        spConfig,
        tenantId,
        authnInteraction.statusCode,
        authnInteraction.secondLevelStatusCode,
        authnInteraction.statusMessage,
        authnInteraction.failureKind
      );
      return sendSAMLResponse(
        c,
        resolveSAMLResponseDestination(authnRequest, spConfig),
        responseXml,
        relayState
      );
    }

    if (authnInteraction.action === 'interactive_login') {
      // User not authenticated - redirect to login
      // Store AuthnRequest in SAMLRequestStore for later retrieval
      await storeAuthnRequest(env, tenantId, authnRequest, relayState);

      // Redirect to login page with return URL
      // Conformance mode: use builtin forms
      // UI configured: redirect to external UI
      // Neither: return configuration error
      const uiConfig = await getUIConfig(env);

      if (await shouldUseBuiltinForms(env)) {
        // Conformance mode: redirect to builtin login
        const loginUrl = new URL('/flow/login', buildIssuerUrl(env, tenantId));
        loginUrl.searchParams.set('saml_request_id', authnRequest.id);
        loginUrl.searchParams.set('saml_sp_entity_id', authnRequest.issuer);
        loginUrl.searchParams.set('return_to', 'saml_sso');
        if (authnInteraction.forceReauthentication) {
          loginUrl.searchParams.set('force_authn', 'true');
        }
        return c.redirect(loginUrl.toString());
      }

      if (uiConfig?.baseUrl) {
        const loginPath = uiConfig.paths?.login || '/login';
        const loginUrlPolicy = await getSAMLInteractiveLoginUrlPolicy(env, tenantId);
        const loginBaseUrl =
          loginUrlPolicy === 'tenant_host' ? buildIssuerUrl(env, tenantId) : uiConfig.baseUrl;
        const loginUrl = new URL(loginPath, loginBaseUrl);
        loginUrl.searchParams.set('saml_request_id', authnRequest.id);
        loginUrl.searchParams.set('saml_sp_entity_id', authnRequest.issuer);
        loginUrl.searchParams.set('return_to', 'saml_sso');
        if (authnInteraction.forceReauthentication) {
          loginUrl.searchParams.set('force_authn', 'true');
        }
        if (loginUrlPolicy === 'ui_base_url' && tenantId) {
          loginUrl.searchParams.set('tenant_hint', tenantId);
        }
        return c.redirect(loginUrl.toString());
      }

      // No UI configured and conformance mode disabled
      return c.json(createConfigurationError(), 500);
    }

    // Get user information
    const userInfo = await getUserInfo(env, tenantId, authnInteraction.session.userId);
    if (!userInfo) {
      return createErrorResponse(c, 'Authentication failed', STATUS_CODES.UNKNOWN_PRINCIPAL);
    }

    // Generate SAML Response
    let responseXml: string;
    try {
      responseXml = await generateSAMLResponse(
        issuerUrl,
        idpEntityId,
        env,
        authnRequest,
        spConfig,
        userInfo,
        tenantId,
        authnInteraction.session,
        log
      );
    } catch (error) {
      if (error instanceof MissingRequiredSAMLAttributeError) {
        log.warn('SAML attribute release policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          missingAttributes: error.missingAttributes,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'required_attribute_missing',
          missingAttributes: error.missingAttributes,
        });

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.RESPONDER,
          STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE,
          getSAMLAttributeReleaseFailureStatusMessage(
            {
              attributeReleaseFailureUserMessageMode:
                await resolveAttributeReleaseFailureUserMessageMode(env, tenantId, spConfig),
            },
            error.missingAttributes
          ),
          'required_attribute_missing'
        );
      } else if (error instanceof SAMLAuthnContextPolicyError) {
        log.warn('SAML RequestedAuthnContext policy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          requestedAuthnContext: error.requestedAuthnContext,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_unsupported_authn_context',
          policyDetails: {
            requested_authn_context: error.requestedAuthnContext,
          },
        });

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.RESPONDER,
          STATUS_CODES.NO_AUTHN_CONTEXT,
          'Requested authentication context could not be satisfied',
          'authn_request_unsupported_authn_context'
        );
      } else if (error instanceof SAMLNameIDPolicyError) {
        log.warn('SAML NameIDPolicy failed', {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          details: error.details,
        });
        scheduleSAMLPolicyFailureAudit(c, {
          tenantId,
          spEntityId: spConfig.entityId,
          authnRequestId: authnRequest.id,
          failureKind: 'authn_request_invalid_nameid_policy',
          policyDetails: error.details,
        });

        responseXml = await generateSAMLProtocolErrorResponse(
          issuerUrl,
          idpEntityId,
          env,
          authnRequest,
          spConfig,
          tenantId,
          STATUS_CODES.REQUESTER,
          STATUS_CODES.INVALID_NAMEID_POLICY,
          'Requested NameID policy could not be satisfied',
          'authn_request_invalid_nameid_policy'
        );
      } else {
        throw error;
      }
    }

    // Return response based on SP's preferred binding
    return sendSAMLResponse(
      c,
      resolveSAMLResponseDestination(authnRequest, spConfig),
      responseXml,
      relayState
    );
  } catch (error) {
    log.error('SSO Error', { method }, error as Error);
    // SECURITY: Do not expose internal error details in response
    return createErrorResponse(c, 'SSO processing failed', STATUS_CODES.RESPONDER);
  }
}

async function resolveAttributeReleaseFailureUserMessageMode(
  env: Env,
  tenantId: string,
  spConfig: SAMLSPConfig
): Promise<SAMLSPConfig['attributeReleaseFailureUserMessageMode']> {
  if (spConfig.attributeReleaseFailureUserMessageMode) {
    return spConfig.attributeReleaseFailureUserMessageMode;
  }

  const authrimSettings =
    (await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tenant')) ??
    (await getTenantSettings(env.SETTINGS, tenantId, 'tenant'));
  const mode = authrimSettings?.[TENANT_SAML_ATTRIBUTE_RELEASE_FAILURE_MESSAGE_MODE];
  return mode === 'detailed' || mode === 'generic' ? mode : 'generic';
}

/**
 * Parse HTTP-Redirect binding parameters
 */
async function parseRedirectBinding(c: Context<{ Bindings: Env }>): Promise<{
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
  binding: 'redirect';
  xml: string;
  redirectSignature: SAMLRedirectSignatureInput;
}> {
  const url = new URL(c.req.url);
  const samlRequest = url.searchParams.get('SAMLRequest');
  const relayState = url.searchParams.get('RelayState') || undefined;

  if (!samlRequest) {
    throw new Error('Missing SAMLRequest parameter');
  }

  // Decode: URL decode -> Base64 decode -> Inflate (deflate decompress)
  const inflated = inflateRedirectBindingMessage(samlRequest, 'SAML AuthnRequest');

  return {
    authnRequest: parseAuthnRequestXml(inflated),
    relayState,
    binding: 'redirect',
    xml: inflated,
    redirectSignature: {
      samlMessage: getRawQueryParam(url.search, 'SAMLRequest') ?? encodeURIComponent(samlRequest),
      relayState: getRawQueryParam(url.search, 'RelayState'),
      signature: url.searchParams.get('Signature') || undefined,
      sigAlg: url.searchParams.get('SigAlg') || undefined,
    },
  };
}

async function parseStoredAuthnRequest(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<ParsedAuthnRequestInput | null> {
  const url = new URL(c.req.url);
  const requestId = url.searchParams.get('saml_request_id');
  if (!requestId) {
    return null;
  }

  const spEntityId = url.searchParams.get('saml_sp_entity_id');
  if (!spEntityId) {
    throw new Error('Missing saml_sp_entity_id parameter');
  }

  const samlRequestStoreId = c.env.SAML_REQUEST_STORE.idFromName(
    buildSAMLRequestStoreInstanceName(tenantId, 'idp', spEntityId)
  );
  const samlRequestStore = c.env.SAML_REQUEST_STORE.get(samlRequestStoreId);
  const response = await samlRequestStore.fetch(
    `https://saml-request-store/consume/${encodeURIComponent(requestId)}`,
    { method: 'POST' }
  );

  if (!response.ok) {
    throw new Error('Stored SAML request not found or already used');
  }

  const storedRequest = (await response.json()) as SAMLRequestData;
  if (
    storedRequest.type !== 'authn_request' ||
    storedRequest.issuer !== spEntityId ||
    storedRequest.requestId !== requestId ||
    !storedRequest.data
  ) {
    throw new Error('Stored SAML request is invalid');
  }

  return {
    authnRequest: storedRequest.data as SAMLAuthnRequest,
    relayState: storedRequest.relayState,
    binding: storedRequest.binding === 'post' ? 'post' : 'redirect',
    xml: '',
    storedRequestValidated: true,
  };
}

/**
 * Parse HTTP-POST binding parameters
 */
async function parsePostBinding(c: Context<{ Bindings: Env }>): Promise<{
  authnRequest: SAMLAuthnRequest;
  relayState?: string;
  binding: 'post';
  xml: string;
}> {
  const formData = await parsePostBindingFormDataWithLimit(c.req);
  const samlRequest = formData.get('SAMLRequest') as string;
  const relayState = (formData.get('RelayState') as string) || undefined;

  if (!samlRequest) {
    throw new Error('Missing SAMLRequest parameter');
  }

  // Decode: Base64 decode only (no compression for POST binding)
  const xmlString = decodePostBindingMessage(samlRequest, 'SAML AuthnRequest');

  return {
    authnRequest: parseAuthnRequestXml(xmlString),
    relayState,
    binding: 'post',
    xml: xmlString,
  };
}

function getRawQueryParam(search: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const query = search.startsWith('?') ? search.slice(1) : search;
  const match = query.split('&').find((part) => part.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

/**
 * Parse AuthnRequest XML into structured data
 */
function parseAuthnRequestXml(xml: string): SAMLAuthnRequest {
  const doc = parseXml(xml);
  const authnRequestElement = doc.documentElement;

  if (
    !authnRequestElement ||
    authnRequestElement.namespaceURI !== SAML_NAMESPACES.SAML2P ||
    authnRequestElement.localName !== 'AuthnRequest'
  ) {
    throw new Error('Invalid AuthnRequest: missing AuthnRequest element');
  }

  const id = getAttribute(authnRequestElement, 'ID');
  const issueInstant = getAttribute(authnRequestElement, 'IssueInstant');
  const destination = getAttribute(authnRequestElement, 'Destination');
  const assertionConsumerServiceURL = getAttribute(
    authnRequestElement,
    'AssertionConsumerServiceURL'
  );
  const assertionConsumerServiceIndex = parseOptionalNonNegativeInteger(
    getAttribute(authnRequestElement, 'AssertionConsumerServiceIndex')
  );
  const protocolBinding = getAttribute(authnRequestElement, 'ProtocolBinding');
  const forceAuthnAttr = getAttribute(authnRequestElement, 'ForceAuthn');
  const isPassiveAttr = getAttribute(authnRequestElement, 'IsPassive');

  if (!id || !issueInstant) {
    throw new Error('Invalid AuthnRequest: missing required attributes');
  }

  // Parse Issuer
  const issuerElement = findDirectChildElement(
    authnRequestElement,
    SAML_NAMESPACES.SAML2,
    'Issuer'
  );
  const issuer = getTextContent(issuerElement);

  if (!issuer) {
    throw new Error('Invalid AuthnRequest: missing Issuer');
  }

  // Parse NameIDPolicy (optional)
  let nameIdPolicy: SAMLAuthnRequest['nameIdPolicy'] | undefined;
  const nameIdPolicyElement = findDirectChildElement(
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
  const requestedAuthnContext = parseRequestedAuthnContext(authnRequestElement);

  return {
    id,
    issueInstant,
    destination: destination || undefined,
    assertionConsumerServiceURL: assertionConsumerServiceURL || undefined,
    assertionConsumerServiceIndex: assertionConsumerServiceIndex ?? undefined,
    protocolBinding: protocolBinding as SAMLAuthnRequest['protocolBinding'],
    issuer,
    nameIdPolicy,
    requestedAuthnContext,
    forceAuthn: forceAuthnAttr === 'true',
    isPassive: isPassiveAttr === 'true',
  };
}

/**
 * Validate AuthnRequest
 */
async function validateAuthnRequest(
  authnRequest: SAMLAuthnRequest,
  issuerUrl: string
): Promise<void> {
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
    const expectedDestination = `${issuerUrl}/saml/idp/sso`;
    if (authnRequest.destination !== expectedDestination) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Destination in SAML AuthnRequest');
    }
  }
}

function parseOptionalNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Check if user is authenticated (sharded)
 */
async function checkUserAuthentication(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<AuthenticatedSAMLSession | null> {
  // Check for session cookie
  const sessionId = extractAuthrimSessionIdFromCookieHeader(c.req.header('Cookie'));

  if (!sessionId) {
    return null;
  }

  // Verify session with SessionStore (sharded)
  if (!isShardedSessionId(sessionId)) {
    return null;
  }

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(
      env,
      sessionId,
      resolveSAMLTenantIdFromContext(c)
    );
    const response = await sessionStore.fetch(`https://session-store/session/${sessionId}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return null;
    }

    const session = (await response.json()) as {
      userId?: string;
      data?: { acr?: unknown; amr?: unknown };
    };
    return session.userId
      ? {
          userId: session.userId,
          sessionId,
          acr: typeof session.data?.acr === 'string' ? session.data.acr : undefined,
          amr: Array.isArray(session.data?.amr)
            ? session.data.amr.filter((value): value is string => typeof value === 'string')
            : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Store AuthnRequest for later retrieval after login
 */
async function storeAuthnRequest(
  env: Env,
  tenantId: string,
  authnRequest: SAMLAuthnRequest,
  relayState?: string
): Promise<void> {
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
      used: false,
      expiresAt: Date.now() + DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000,
    }),
  });
}

/**
 * Get user information from database
 */
async function getUserInfo(
  env: Env,
  tenantId: string,
  userId: string
): Promise<SAMLUserInfo | null> {
  return getSamlUserInfoById(env, tenantId, userId);
}

/**
 * Generate SAML Response with Assertion
 */
async function generateSAMLResponse(
  issuerUrl: string,
  idpEntityId: string,
  env: Env,
  authnRequest: SAMLAuthnRequest,
  spConfig: SAMLSPConfig,
  userInfo: SAMLUserInfo,
  tenantId: string,
  authSession: AuthenticatedSAMLSession,
  log?: { debug(message: string, context?: Record<string, unknown>): void }
): Promise<string> {
  const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
    tenantId,
    role: 'idp',
    counterpartyEntityId: spConfig.entityId,
    policy: getSAMLSigningPolicy(spConfig),
  });

  const nameIdFormat = resolveSAMLNameIDFormat(authnRequest, spConfig);
  const nameIdValue = await resolveSAMLNameIDValue(userInfo, nameIdFormat, {
    tenantId,
    spEntityId: spConfig.entityId,
    pairwiseSalt: await resolveSAMLPairwiseSecret(env, tenantId),
    persistentRegistry: resolveSAMLPersistentNameIDRegistryStore(env),
    allowCreate: authnRequest.nameIdPolicy?.allowCreate ?? true,
    transientStore: resolveSAMLTransientNameIDStore(env),
    transientTtlSeconds: spConfig.assertionValiditySeconds || DEFAULTS.ASSERTION_VALIDITY_SECONDS,
    sessionId: authSession.sessionId,
  });

  // Determine ACS URL
  const acsUrl = resolveSAMLResponseDestination(authnRequest, spConfig);
  const attributeRelease = buildSAMLAttributesForSPWithDiagnostics(userInfo, spConfig);
  if (attributeRelease.optionalMissingAttributes.length > 0) {
    log?.debug('Optional SAML attributes omitted', {
      tenantId,
      spEntityId: spConfig.entityId,
      authnRequestId: authnRequest.id,
      missingAttributes: attributeRelease.optionalMissingAttributes,
    });
  }

  const authnContextClassRef = resolveSAMLAuthnContextClassRef(authnRequest, {
    spConfig,
    session: {
      acr: authSession.acr,
      amr: authSession.amr,
    },
  });
  const timing = buildSAMLAssertionTiming({
    assertionValiditySeconds:
      spConfig.assertionValiditySeconds || DEFAULTS.ASSERTION_VALIDITY_SECONDS,
  });

  // Build SAML Response
  let responseXml = buildSAMLResponse({
    responseId: generateSAMLId(),
    assertionId: generateSAMLId(),
    issueInstant: timing.issueInstant,
    issuer: idpEntityId,
    destination: acsUrl,
    inResponseTo: authnRequest.id,
    recipientUrl: acsUrl,
    audienceRestriction: spConfig.entityId,
    nameId: nameIdValue,
    nameIdFormat,
    authnInstant: timing.authnInstant,
    sessionIndex: await createSAMLSessionIndex(env.STATE_STORE, {
      tenantId,
      spEntityId: spConfig.entityId,
      sessionId: authSession.sessionId,
      ttlSeconds: DEFAULTS.SESSION_VALIDITY_SECONDS,
    }),
    notBefore: timing.notBefore,
    notOnOrAfter: timing.notOnOrAfter,
    authnContextClassRef,
    attributes: attributeRelease.attributes,
  });

  const encryptFullAssertion = Boolean(spConfig.encryptAssertions);
  const encryptNameIdOnly = !encryptFullAssertion && Boolean(spConfig.encryptNameID);

  if (encryptNameIdOnly) {
    responseXml = await applySAMLAssertionEncryptionPolicy(responseXml, spConfig);
  }

  if (spConfig.signAssertions) {
    responseXml = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: true, signResponses: false },
      { privateKeyPem, certificate }
    );
  }

  if (encryptFullAssertion) {
    responseXml = await applySAMLAssertionEncryptionPolicy(responseXml, spConfig);
  }

  if (spConfig.signResponses) {
    responseXml = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: false, signResponses: true },
      { privateKeyPem, certificate }
    );
  }

  return responseXml;
}

async function generateSAMLProtocolErrorResponse(
  issuerUrl: string,
  idpEntityId: string,
  env: Env,
  authnRequest: SAMLAuthnRequest,
  spConfig: SAMLSPConfig,
  tenantId: string,
  statusCode: string,
  secondLevelStatusCode: string | undefined,
  statusMessage: string,
  failureKind?: string
): Promise<string> {
  const signingMaterial =
    spConfig.signResponses || spConfig.signAssertions
      ? await getSAMLSigningMaterial(env, {
          tenantId,
          role: 'idp',
          counterpartyEntityId: spConfig.entityId,
          policy: getSAMLSigningPolicy(spConfig),
        })
      : undefined;

  const resolvedStatus = applySAMLErrorResponseOverride(spConfig, {
    failureKind,
    statusCode,
    secondLevelStatusCode,
    statusMessage,
  });

  return buildSAMLIdPErrorResponse({
    issuer: idpEntityId,
    destination: resolveSAMLResponseDestination(authnRequest, spConfig),
    inResponseTo: authnRequest.id,
    statusCode: resolvedStatus.statusCode,
    secondLevelStatusCode: resolvedStatus.secondLevelStatusCode,
    statusMessage: resolvedStatus.statusMessage,
    spConfig,
    signingMaterial,
  });
}

/**
 * Send SAML Response to SP's ACS
 */
function sendSAMLResponse(
  c: Context<{ Bindings: Env }>,
  acsUrl: string,
  responseXml: string,
  relayState?: string
): Response {
  // Encode response as Base64
  const encodedResponse = base64Encode(responseXml);
  const fields = [{ name: 'SAMLResponse', value: encodedResponse }];
  if (relayState) {
    fields.push({ name: 'RelayState', value: relayState });
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML SSO',
    actionUrl: acsUrl,
    fields,
    buttonText: 'Continue to Service Provider',
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
const TENANT_SAML_ATTRIBUTE_RELEASE_FAILURE_MESSAGE_MODE =
  'tenant.saml_attribute_release_failure_message_mode';

/**
 * SAML SP Assertion Consumer Service (ACS) Endpoint
 *
 * Receives and validates SAML Response from IdP, then creates Authrim session.
 * POST /saml/sp/acs
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { SAMLIdPConfig, SAMLAssertion, SAMLRequestData } from '@authrim/ar-lib-core';
import {
  getSessionStoreForNewSession,
  type DatabaseAdapter,
  ensureDatabaseAdapter,
  requireAdminDatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildIssuerUrl,
  buildSAMLRequestStoreInstanceName,
  getLogger,
  createLogger,
  validateCustomClaimWrite,
  persistCustomClaimWrite,
  syncUserLifecycleState,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveAccountDataContextByIdentifier,
  type AuthAccountProvisioningInput,
  getChallengeStoreByChallengeId,
  CanonicalRuntimeUserStore,
  resolveRuntimeIdentityMappingBinding,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Audit Log
  createAuditLog,
} from '@authrim/ar-lib-core';
import { executeRuntimeMapping, type SourceValueEnvelope } from '@authrim/ar-lib-field-mapping';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import {
  parseXml,
  getAttribute,
  getTextContent,
  findDirectChildElement,
  findDirectChildElements,
} from '../common/xml-utils';
import {
  decodePostBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../common/message-limits';
import { SAML_NAMESPACES, STATUS_CODES, DEFAULTS } from '../common/constants';
import { verifyXmlSignature, hasSignature } from '../common/signature';
import { getIdPConfigByEntityId } from '../admin/providers';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize, SAMLRelayStateTooLargeError } from '../common/relay-state';

const SESSION_COOKIE_NAME = 'authrim_session';
const SESSION_COOKIE_MAX_AGE_SECONDS = 3600;
const SESSION_HANDOFF_TTL_SECONDS = 60;
const SAML_SP_HANDOFF_AUDIENCE = 'saml_sp_cookie_handoff';
const SAML_JIT_EMAIL_LINKING_POLICIES = new Set(['email_linking', 'jit_create_only', 'disabled']);
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

/**
 * Handle ACS request (receive SAML Response from IdP)
 */
export async function handleSPACS(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-SP');
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { issuerUrl, spEntityId } = await getSAMLLocalEntityIds(env, tenantId);
  let auditProviderId = 'unknown';

  try {
    // Parse POST data
    const formData = await parsePostBindingFormDataWithLimit(c.req);
    const samlResponse = formData.get('SAMLResponse') as string;
    const relayState = formData.get('RelayState') as string | null;
    assertSAMLRelayStateSize(relayState);

    if (!samlResponse) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'SAMLResponse' },
      });
    }

    // Decode SAML Response
    const responseXml = decodePostBindingMessage(samlResponse, 'SAML Response');

    // Parse and validate Response
    const { responseId, issuer, assertion, inResponseTo } = parseAndValidateResponse(
      responseXml,
      issuerUrl,
      spEntityId
    );
    auditProviderId = issuer;

    // Get IdP configuration
    const idpConfig = await getIdPConfigByEntityId(env, tenantId, issuer);
    if (!idpConfig) {
      return createErrorResponse(c, AR_ERROR_CODES.SAML_INVALID_RESPONSE);
    }

    try {
      validateSAMLResponseSignature(responseXml, idpConfig, responseId, assertion.id);
    } catch (error) {
      log.error('Signature verification failed', {}, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate InResponseTo (if we sent an AuthnRequest)
    let validatedRequest: SAMLRequestData | null = null;
    if (inResponseTo) {
      validatedRequest = await consumeInResponseTo(env, tenantId, inResponseTo, issuer);
      if (!validatedRequest) {
        log.error('InResponseTo validation failed', { inResponseTo });
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    } else if (await getStrictInResponseToSetting(env)) {
      log.error('SAML Response missing InResponseTo while strict mode is enabled', {});
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const isFirstUse = await checkAndRecordBearerAssertionUse(
      env,
      tenantId,
      issuer,
      assertion.id,
      assertion.subjectConfirmationData.notOnOrAfter
    );
    if (!isFirstUse) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const authnContextClassRef = assertion.authnStatement?.authnContext?.authnContextClassRef;
    const authnContextError = validateAuthnContextPolicy(idpConfig, authnContextClassRef);
    if (authnContextError) {
      log.warn('AuthnContext policy rejected SAML assertion', {
        issuer,
        authnContextClassRef: authnContextClassRef || 'missing',
      });
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Extract user information from assertion through the configured Field Mapping Set.
    const userInfo = await extractUserInfo(env, tenantId, spEntityId, assertion, idpConfig);

    // Resolve the federated identity before applying any future attribute mapping.
    const identityResolution = await findOrCreateUser(env, userInfo, idpConfig, tenantId);
    const userId = identityResolution.userId;

    // Create session
    const sessionId = await createSession(env, userId, tenantId);

    // Publish SAML authentication success event (non-blocking)
    publishEvent(c, {
      type: AUTH_EVENTS.SAML_SUCCEEDED,
      tenantId,
      data: {
        userId,
        method: 'saml',
        clientId: 'saml-sp', // SAML SP acts as the client
        sessionId,
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish auth.saml.succeeded event', {}, err as Error);
    });

    // Publish session created event (non-blocking)
    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId,
      data: {
        sessionId,
        userId,
        ttlSeconds: 3600,
      } satisfies SessionEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish session.user.created event', {}, err as Error);
    });

    // Write audit log for SAML login (non-blocking)
    const ipAddress =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown';
    const userAgent = c.req.header('User-Agent') || 'unknown';

    // Schedule audit log with waitUntil to ensure it completes after response
    const auditPromise = createAuditLog(env, {
      tenantId,
      userId,
      action: 'user.login',
      resource: 'session',
      resourceId: sessionId,
      ipAddress,
      userAgent,
      metadata: JSON.stringify({
        method: 'saml',
        idp_entity_id: issuer,
        authn_context_class_ref: authnContextClassRef,
        federated_identity_resolution: identityResolution.action,
        linked_identity_id: identityResolution.linkedIdentityId,
      }),
      severity: 'info',
    }).catch((err: unknown) => {
      log.error('Failed to create audit log for SAML login', {}, err as Error);
    });
    c.executionCtx?.waitUntil(auditPromise);

    // Determine redirect URL
    let returnUrl = validatedRequest?.relayState || resolveSafeReturnUrl(env, tenantId, relayState);
    if (!returnUrl) {
      const uiConfig = await getUIConfig(env);
      returnUrl = uiConfig?.baseUrl ? `${uiConfig.baseUrl}/` : `${buildIssuerUrl(env, tenantId)}/`;
    }

    const handoffResponse = await createSessionHandoffResponse(
      c,
      tenantId,
      sessionId,
      userId,
      returnUrl
    );
    if (handoffResponse) {
      return handoffResponse;
    }

    // Set session cookie and redirect
    return new Response(null, {
      status: 302,
      headers: {
        Location: returnUrl,
        'Set-Cookie': buildSessionCookie(sessionId),
      },
    });
  } catch (error) {
    log.error('ACS Error', {}, error as Error);

    if (error instanceof SamlProvisioningError) {
      scheduleSAMLIdentityResolutionFailureAudit(c, tenantId, auditProviderId, error);
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field:
            error.reason === 'custom_claim_validation_failed'
              ? 'custom_claims'
              : 'federated_identity',
          reason: error.message,
        },
        extensions: error.missingRequiredFields
          ? {
              missing_required_fields: error.missingRequiredFields.map((field) => ({
                field_key: field.fieldKey,
                label: field.label,
                field_type: field.fieldType,
              })),
            }
          : undefined,
      });
    }

    if (error instanceof SamlAttributeMappingError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: {
          field: 'identity_mapping',
          reason: error.message,
        },
      });
    }

    if (error instanceof SAMLRelayStateTooLargeError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'RelayState', reason: error.message },
      });
    }

    // Publish SAML authentication failure event (non-blocking)
    const failureTenantId = resolveSAMLTenantIdFromContext(c);
    publishEvent(c, {
      type: AUTH_EVENTS.SAML_FAILED,
      tenantId: failureTenantId,
      data: {
        method: 'saml',
        clientId: 'saml-sp',
        errorCode: error instanceof Error ? error.message : 'unknown_error',
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish auth.saml.failed event', {}, err as Error);
    });

    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function scheduleSAMLIdentityResolutionFailureAudit(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  providerId: string,
  error: SamlProvisioningError
): void {
  const auditPromise = createAuditLog(c.env, {
    tenantId,
    userId: 'saml-sp',
    action: 'saml.identity_resolution.failed',
    resource: 'linked_identity',
    resourceId: providerId,
    ipAddress:
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown',
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadata: JSON.stringify({
      protocol: 'saml',
      failure_reason: error.reason,
      ...sanitizeSAMLIdentityResolutionAuditDetails(error.auditDetails),
    }),
    severity: 'warning',
  }).catch((auditError: unknown) => {
    getLogger(c)
      .module('SAML-SP')
      .error(
        'Failed to create SAML identity resolution failure audit',
        { reason: error.reason },
        auditError as Error
      );
  });

  c.executionCtx?.waitUntil(auditPromise);
}

function sanitizeSAMLIdentityResolutionAuditDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!details) {
    return {};
  }

  const allowedKeys = new Set(['linked_identity_id', 'policy']);
  return Object.fromEntries(Object.entries(details).filter(([key]) => allowedKeys.has(key)));
}

async function createSessionHandoffResponse(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  sessionId: string,
  userId: string,
  returnUrl: string
): Promise<Response | null> {
  const env = c.env;
  if (!shouldUseSessionHandoff(env, getRequestUrl(c), returnUrl)) {
    return null;
  }

  const token = createHandoffToken();
  const state = createHandoffToken();
  const clientId = resolveLoginUiClientId(env);
  const returnOrigin = getUrlOrigin(returnUrl);

  try {
    const handoffStore = await getChallengeStoreByChallengeId(env, token, tenantId);
    const metadata: Record<string, unknown> = {
      state,
      aud: SAML_SP_HANDOFF_AUDIENCE,
      created_at: Date.now(),
      source: 'saml_sp',
      return_url: returnUrl,
      origin: returnOrigin,
    };
    if (clientId) {
      metadata.client_id = clientId;
    }

    await handoffStore.storeChallengeRpc({
      id: `handoff:${token}`,
      tenantId,
      type: 'handoff',
      userId,
      challenge: sessionId,
      ttl: SESSION_HANDOFF_TTL_SECONDS,
      metadata,
    });
  } catch (error) {
    getLogger(c)
      .module('SAML-SP')
      .warn('CHALLENGE_STORE is unavailable for session handoff', {}, error as Error);
    return null;
  }

  const callbackUrl = new URL('/callback', returnUrl);
  callbackUrl.searchParams.set('handoff_token', token);
  callbackUrl.searchParams.set('state', state);
  callbackUrl.searchParams.set('return_url', returnUrl);

  return new Response(null, {
    status: 302,
    headers: {
      Location: callbackUrl.toString(),
      ...NO_STORE_HEADERS,
    },
  });
}

function shouldUseSessionHandoff(env: Env, requestUrl: string, returnUrl: string): boolean {
  const requestOrigin = getUrlOrigin(requestUrl);
  const returnOrigin = getUrlOrigin(returnUrl);
  const uiOrigin = getUrlOrigin((env as unknown as Record<string, unknown>).UI_URL);

  return Boolean(
    requestOrigin &&
    returnOrigin &&
    uiOrigin &&
    requestOrigin !== returnOrigin &&
    returnOrigin === uiOrigin
  );
}

function buildSessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}

function createHandoffToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveLoginUiClientId(env: Env): string | undefined {
  const candidates = [
    (env as unknown as Record<string, unknown>).LOGIN_UI_CLIENT_ID,
    (env as unknown as Record<string, unknown>).PUBLIC_LOGIN_UI_CLIENT_ID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function getRequestUrl(c: Context<{ Bindings: Env }>): string {
  return typeof c.req.url === 'string'
    ? c.req.url
    : buildIssuerUrl(c.env, resolveSAMLTenantIdFromContext(c));
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

function resolveSafeReturnUrl(env: Env, tenantId: string, value: string | null): string | null {
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

  const issuerOrigin = getUrlOrigin(buildIssuerUrl(env, tenantId));
  const uiOrigin = getUrlOrigin((env as unknown as Record<string, unknown>).UI_URL);
  const allowedOrigins = new Set(
    [issuerOrigin, uiOrigin].filter((origin): origin is string => Boolean(origin))
  );

  return allowedOrigins.has(url.origin) ? url.toString() : null;
}

interface ParsedResponse {
  responseId: string;
  issuer: string;
  inResponseTo?: string;
  assertion: ParsedSAMLAssertion;
}

interface ParsedSAMLAssertion extends SAMLAssertion {
  subjectConfirmationData: {
    notOnOrAfter: string;
  };
}

/**
 * Parse and validate SAML Response
 */
function parseAndValidateResponse(
  xml: string,
  issuerUrl: string,
  spEntityId: string
): ParsedResponse {
  const doc = parseXml(xml);

  const responseElement = doc.documentElement;
  if (
    !responseElement ||
    responseElement.namespaceURI !== SAML_NAMESPACES.SAML2P ||
    responseElement.localName !== 'Response'
  ) {
    throw new Error('Invalid SAML Response: root element must be Response');
  }

  const responseId = getAttribute(responseElement, 'ID');
  if (!responseId) {
    throw new Error('Invalid SAML Response: missing Response ID');
  }

  // Check Destination
  const destination = getAttribute(responseElement, 'Destination');
  if (destination) {
    const expectedDestination = `${issuerUrl}/saml/sp/acs`;
    if (destination !== expectedDestination) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Destination in SAML Response');
    }
  }

  // Get InResponseTo
  const inResponseTo = getAttribute(responseElement, 'InResponseTo') || undefined;

  // Check Status
  const statusElement = findDirectChildElement(responseElement, SAML_NAMESPACES.SAML2P, 'Status');
  if (!statusElement) {
    throw new Error('Invalid SAML Response: missing Status element');
  }

  const statusCodeElement = findDirectChildElement(
    statusElement,
    SAML_NAMESPACES.SAML2P,
    'StatusCode'
  );
  if (!statusCodeElement) {
    throw new Error('Invalid SAML Response: missing StatusCode element');
  }
  const statusCode = getAttribute(statusCodeElement, 'Value');

  if (statusCode !== STATUS_CODES.SUCCESS) {
    const statusMessage = getTextContent(
      findDirectChildElement(statusElement, SAML_NAMESPACES.SAML2P, 'StatusMessage')
    );
    throw new Error(
      `SAML authentication failed: ${statusCode} - ${statusMessage || 'Unknown error'}`
    );
  }

  // Get Issuer
  const issuerElement = findDirectChildElement(responseElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement);
  if (!issuer) {
    throw new Error('Invalid SAML Response: missing Issuer');
  }

  const assertionElements = findDirectChildElements(
    responseElement,
    SAML_NAMESPACES.SAML2,
    'Assertion'
  );
  const encryptedAssertionElements = findDirectChildElements(
    responseElement,
    SAML_NAMESPACES.SAML2,
    'EncryptedAssertion'
  );
  if (encryptedAssertionElements.length > 0) {
    throw new Error('EncryptedAssertion is not supported by this SAML SP ACS endpoint');
  }
  if (assertionElements.length !== 1) {
    throw new Error('Invalid SAML Response: expected exactly one Assertion');
  }

  // Parse Assertion (pass inResponseTo for SubjectConfirmationData validation)
  const assertion = parseAssertion(assertionElements[0], issuerUrl, spEntityId, inResponseTo);
  if (!assertion.issuer || assertion.issuer !== issuer) {
    throw new Error('Invalid SAML Response: Assertion Issuer does not match Response Issuer');
  }

  return { responseId, issuer, inResponseTo, assertion };
}

/**
 * Parse SAML Assertion
 *
 * @param assertionElement - The Assertion XML element
 * @param env - Environment bindings
 * @param inResponseTo - The InResponseTo attribute from the Response (for SubjectConfirmationData validation)
 */
function parseAssertion(
  assertionElement: Element,
  issuerUrl: string,
  spEntityId: string,
  inResponseTo?: string
): ParsedSAMLAssertion {
  const id = getAttribute(assertionElement, 'ID') || '';
  if (!id) {
    throw new Error('Invalid Assertion: missing ID');
  }
  const issueInstant = getAttribute(assertionElement, 'IssueInstant') || '';

  // Get Issuer
  const issuerElement = findDirectChildElement(assertionElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement) || '';

  // Parse Subject
  const subjectElement = findDirectChildElement(assertionElement, SAML_NAMESPACES.SAML2, 'Subject');
  if (!subjectElement) {
    throw new Error('Invalid Assertion: missing Subject');
  }

  const nameIdElement = findDirectChildElement(subjectElement, SAML_NAMESPACES.SAML2, 'NameID');
  if (!nameIdElement) {
    throw new Error('Invalid Assertion: missing NameID');
  }

  const nameId = getTextContent(nameIdElement) || '';
  const nameIdFormat =
    getAttribute(nameIdElement, 'Format') ||
    'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';

  // Validate SubjectConfirmation (SAML 2.0 Profiles 4.1.4.2)
  const expectedAcsUrl = `${issuerUrl}/saml/sp/acs`;
  const subjectConfirmationData = validateSubjectConfirmation(
    subjectElement,
    expectedAcsUrl,
    inResponseTo
  );

  // Parse Conditions
  const conditionsElement = findDirectChildElement(
    assertionElement,
    SAML_NAMESPACES.SAML2,
    'Conditions'
  );
  let conditions: SAMLAssertion['conditions'];

  if (!conditionsElement) {
    throw new Error('Invalid Assertion: missing Conditions');
  } else {
    const notBefore = getAttribute(conditionsElement, 'NotBefore');
    const notOnOrAfter = getAttribute(conditionsElement, 'NotOnOrAfter');

    // Validate time conditions
    const now = Date.now();
    const clockSkewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;

    if (notBefore) {
      const notBeforeTime = parseSAMLDateTimeMs(notBefore, 'Conditions NotBefore');
      if (now < notBeforeTime - clockSkewMs) {
        throw new Error('Assertion is not yet valid (NotBefore)');
      }
    }

    if (notOnOrAfter) {
      const notOnOrAfterTime = parseSAMLDateTimeMs(notOnOrAfter, 'Conditions NotOnOrAfter');
      if (now > notOnOrAfterTime + clockSkewMs) {
        throw new Error('Assertion has expired (NotOnOrAfter)');
      }
    }

    // Get Audience from direct AudienceRestriction children.
    const audienceRestrictionElements = findDirectChildElements(
      conditionsElement,
      SAML_NAMESPACES.SAML2,
      'AudienceRestriction'
    );
    const audienceElements = audienceRestrictionElements.flatMap((audienceRestriction) =>
      findDirectChildElements(audienceRestriction, SAML_NAMESPACES.SAML2, 'Audience')
    );
    const audiences = audienceElements.map((el) => getTextContent(el) || '').filter(Boolean);

    // Validate audience
    const expectedAudience = spEntityId;
    if (audiences.length === 0 || !audiences.includes(expectedAudience)) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Audience in SAML Assertion');
    }

    // Check OneTimeUse condition (SAML 2.0 Core 2.5.1.5)
    const oneTimeUseElement = findDirectChildElement(
      conditionsElement,
      SAML_NAMESPACES.SAML2,
      'OneTimeUse'
    );
    const oneTimeUse = oneTimeUseElement !== null;

    // Check ProxyRestriction condition (SAML 2.0 Core 2.5.1.6)
    const proxyRestrictionElement = findDirectChildElement(
      conditionsElement,
      SAML_NAMESPACES.SAML2,
      'ProxyRestriction'
    );
    let proxyRestriction: number | undefined;
    if (proxyRestrictionElement) {
      const countStr = getAttribute(proxyRestrictionElement, 'Count');
      if (countStr !== null) {
        proxyRestriction = parseInt(countStr, 10);
      }
    }

    conditions = {
      notBefore: notBefore || undefined,
      notOnOrAfter: notOnOrAfter || undefined,
      audienceRestriction: audiences.length > 0 ? audiences : undefined,
      oneTimeUse: oneTimeUse || undefined,
      proxyRestriction,
    };
  }

  // Parse AuthnStatement
  const authnStatementElement = findDirectChildElement(
    assertionElement,
    SAML_NAMESPACES.SAML2,
    'AuthnStatement'
  );
  let authnStatement: SAMLAssertion['authnStatement'];

  if (authnStatementElement) {
    const authnContextElement = findDirectChildElement(
      authnStatementElement,
      SAML_NAMESPACES.SAML2,
      'AuthnContext'
    );
    const authnContextClassRefElement = authnContextElement
      ? findDirectChildElement(authnContextElement, SAML_NAMESPACES.SAML2, 'AuthnContextClassRef')
      : null;

    authnStatement = {
      authnInstant: getAttribute(authnStatementElement, 'AuthnInstant') || '',
      sessionIndex: getAttribute(authnStatementElement, 'SessionIndex') || undefined,
      sessionNotOnOrAfter: getAttribute(authnStatementElement, 'SessionNotOnOrAfter') || undefined,
      authnContext: {
        authnContextClassRef: getTextContent(authnContextClassRefElement) || '',
      },
    };
  }

  // Parse Attributes
  const attributeStatementElement = findDirectChildElement(
    assertionElement,
    SAML_NAMESPACES.SAML2,
    'AttributeStatement'
  );
  const attributeStatement: SAMLAssertion['attributeStatement'] = [];

  if (attributeStatementElement) {
    const attributeElements = findDirectChildElements(
      attributeStatementElement,
      SAML_NAMESPACES.SAML2,
      'Attribute'
    );

    for (const attrEl of attributeElements) {
      const name = getAttribute(attrEl, 'Name') || '';
      const nameFormat = getAttribute(attrEl, 'NameFormat') || undefined;
      const friendlyName = getAttribute(attrEl, 'FriendlyName') || undefined;

      const valueElements = findDirectChildElements(
        attrEl,
        SAML_NAMESPACES.SAML2,
        'AttributeValue'
      );
      const values = valueElements.map((el) => getTextContent(el) || '').filter(Boolean);

      attributeStatement.push({ name, nameFormat, friendlyName, values });
    }
  }

  return {
    id,
    issueInstant,
    issuer,
    subject: {
      nameId,
      nameIdFormat: nameIdFormat as SAMLAssertion['subject']['nameIdFormat'],
    },
    subjectConfirmationData,
    conditions,
    authnStatement,
    attributeStatement: attributeStatement.length > 0 ? attributeStatement : undefined,
  };
}

// SubjectConfirmation method constants
const SUBJECT_CONFIRMATION_METHODS = {
  BEARER: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
  HOLDER_OF_KEY: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
  SENDER_VOUCHES: 'urn:oasis:names:tc:SAML:2.0:cm:sender-vouches',
} as const;

/**
 * Validate SubjectConfirmation per SAML 2.0 Profiles Section 4.1.4.2
 *
 * For bearer assertions in Web Browser SSO Profile:
 * - SubjectConfirmation MUST be present with Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"
 * - SubjectConfirmationData MUST be present
 * - SubjectConfirmationData/@Recipient MUST match the ACS URL
 * - SubjectConfirmationData/@NotOnOrAfter MUST be present and not expired
 * - SubjectConfirmationData/@InResponseTo MUST match AuthnRequest ID (if present)
 *
 * @param subjectElement - The Subject element from the assertion
 * @param expectedAcsUrl - The expected ACS URL for Recipient validation
 * @param expectedInResponseTo - The expected AuthnRequest ID for InResponseTo validation (optional for IdP-initiated)
 * @throws Error if validation fails
 */
function validateSubjectConfirmation(
  subjectElement: Element,
  expectedAcsUrl: string,
  expectedInResponseTo?: string
): ParsedSAMLAssertion['subjectConfirmationData'] {
  // Find SubjectConfirmation element
  const subjectConfirmationElement = findDirectChildElement(
    subjectElement,
    SAML_NAMESPACES.SAML2,
    'SubjectConfirmation'
  );

  if (!subjectConfirmationElement) {
    throw new Error('Invalid Assertion: missing SubjectConfirmation');
  }

  // Validate Method attribute
  const method = getAttribute(subjectConfirmationElement, 'Method');

  if (!method) {
    throw new Error('Invalid Assertion: SubjectConfirmation missing Method attribute');
  }

  // For browser SSO, only bearer method is acceptable
  if (method !== SUBJECT_CONFIRMATION_METHODS.BEARER) {
    if (method === SUBJECT_CONFIRMATION_METHODS.HOLDER_OF_KEY) {
      throw new Error('SubjectConfirmation method holder-of-key not supported for browser SSO');
    }
    if (method === SUBJECT_CONFIRMATION_METHODS.SENDER_VOUCHES) {
      throw new Error('SubjectConfirmation method sender-vouches not supported for browser SSO');
    }
    throw new Error(`SubjectConfirmation method not supported: ${method}`);
  }

  // For bearer method, SubjectConfirmationData is required
  const subjectConfirmationDataElement = findDirectChildElement(
    subjectConfirmationElement,
    SAML_NAMESPACES.SAML2,
    'SubjectConfirmationData'
  );

  if (!subjectConfirmationDataElement) {
    throw new Error(
      'Invalid Assertion: bearer SubjectConfirmation missing SubjectConfirmationData'
    );
  }

  // Validate Recipient attribute
  const recipient = getAttribute(subjectConfirmationDataElement, 'Recipient');

  if (!recipient) {
    throw new Error('Invalid Assertion: SubjectConfirmationData missing Recipient attribute');
  }

  if (recipient !== expectedAcsUrl) {
    throw new Error(
      `Invalid SubjectConfirmationData Recipient: expected ${expectedAcsUrl}, got ${recipient}`
    );
  }

  // Validate NotOnOrAfter attribute
  const notOnOrAfter = getAttribute(subjectConfirmationDataElement, 'NotOnOrAfter');

  if (!notOnOrAfter) {
    throw new Error('Invalid Assertion: SubjectConfirmationData missing NotOnOrAfter attribute');
  }

  const notOnOrAfterTime = parseSAMLDateTimeMs(
    notOnOrAfter,
    'SubjectConfirmationData NotOnOrAfter'
  );
  const now = Date.now();
  const clockSkewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;

  if (now > notOnOrAfterTime + clockSkewMs) {
    throw new Error('SubjectConfirmationData has expired (NotOnOrAfter)');
  }

  // Validate InResponseTo attribute if present
  // Per SAML 2.0 Profiles 4.1.4.2: If Response is in response to an AuthnRequest,
  // InResponseTo MUST match the AuthnRequest ID
  const subjectConfirmationInResponseTo = getAttribute(
    subjectConfirmationDataElement,
    'InResponseTo'
  );

  if (subjectConfirmationInResponseTo) {
    // SubjectConfirmationData has InResponseTo - validate it matches the expected value
    if (expectedInResponseTo && subjectConfirmationInResponseTo !== expectedInResponseTo) {
      throw new Error(
        `SubjectConfirmationData InResponseTo mismatch: expected ${expectedInResponseTo}, got ${subjectConfirmationInResponseTo}`
      );
    }
    // If no expectedInResponseTo provided (IdP-initiated), any value is a mismatch
    // since there was no AuthnRequest to match against
    if (!expectedInResponseTo) {
      const log = createLogger().module('SAML-SP-ACS');
      log.warn(
        'SubjectConfirmationData contains InResponseTo but this appears to be IdP-initiated SSO',
        { inResponseTo: subjectConfirmationInResponseTo }
      );
      // For compatibility, we log a warning but don't reject
      // Strict mode can be enabled via SAML_STRICT_INRESPONSETO
    }
  }

  return { notOnOrAfter };
}

/**
 * Check and record a bearer assertion ID to prevent replay.
 * Returns true if this is the first use, false if already used
 */
async function checkAndRecordBearerAssertionUse(
  env: Env,
  tenantId: string,
  idpEntityId: string,
  assertionId: string,
  notOnOrAfter?: string
): Promise<boolean> {
  // Use NONCE_STORE KV for tracking used assertions
  const kvStore = env.NONCE_STORE;
  const key = buildOneTimeUseAssertionReplayKey(tenantId, idpEntityId, assertionId);

  // Check if assertion ID has been used
  const existingEntry = await kvStore.get(key);
  if (existingEntry) {
    const log = createLogger().module('SAML-SP-ACS');
    log.warn('Bearer assertion already used', { assertionId });
    return false;
  }

  // Calculate TTL based on SubjectConfirmationData NotOnOrAfter.
  let expirationTtl = 300; // Default 5 minutes
  if (notOnOrAfter) {
    const notOnOrAfterTime = parseSAMLDateTimeMs(
      notOnOrAfter,
      'SubjectConfirmationData NotOnOrAfter'
    );
    const now = Date.now();
    const clockSkewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
    // Keep the record until after the assertion would have expired anyway
    expirationTtl = Math.max(
      60, // Minimum 1 minute
      Math.ceil((notOnOrAfterTime + clockSkewMs - now) / 1000)
    );
  }

  // Record the assertion ID with TTL
  await kvStore.put(key, Date.now().toString(), { expirationTtl });

  return true;
}

function buildOneTimeUseAssertionReplayKey(
  tenantId: string,
  idpEntityId: string,
  assertionId: string
): string {
  // Assertion IDs are issuer-controlled, so replay markers must be scoped by tenant and IdP.
  return [
    'saml:assertion',
    'tenant',
    encodeURIComponent(tenantId),
    'idp',
    encodeURIComponent(idpEntityId),
    'id',
    encodeURIComponent(assertionId),
  ].join(':');
}

/**
 * Get strict InResponseTo setting from KV → ENV → default
 * When enabled, InResponseTo MUST match a stored AuthnRequest ID
 */
async function getStrictInResponseToSetting(env: Env): Promise<boolean> {
  try {
    // Check KV first (if available)
    if (env.AUTHRIM_CONFIG) {
      const kvValue = await env.AUTHRIM_CONFIG.get('SAML_STRICT_INRESPONSETO');
      if (kvValue !== null) {
        return kvValue.toLowerCase() === 'true';
      }
    }
  } catch {
    // KV not available, continue to ENV
  }

  // Check environment variable
  const envValue = (env as unknown as Record<string, unknown>).SAML_STRICT_INRESPONSETO;
  if (typeof envValue === 'string') {
    return envValue.toLowerCase() === 'true';
  }

  // Return default (false for backward compatibility)
  return DEFAULTS.STRICT_INRESPONSETO;
}

/**
 * Consume InResponseTo against stored request
 */
async function consumeInResponseTo(
  env: Env,
  tenantId: string,
  inResponseTo: string,
  issuer: string
): Promise<SAMLRequestData | null> {
  try {
    const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(
      buildSAMLRequestStoreInstanceName(tenantId, 'sp', issuer)
    );
    const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

    const response = await samlRequestStore.fetch(
      `https://saml-request-store/consume/${inResponseTo}`,
      {
        method: 'POST',
      }
    );

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as SAMLRequestData;
  } catch {
    return null;
  }
}

function validateSAMLResponseSignature(
  xml: string,
  idpConfig: SAMLIdPConfig,
  responseId: string,
  assertionId: string
): void {
  if (!idpConfig.certificate) {
    throw new Error('IdP certificate is required to verify SAML Response signatures');
  }

  if (!hasSignature(xml)) {
    throw new Error('Signed SAML Response or Assertion is required for configured IdP');
  }

  verifyXmlSignature(xml, {
    certificateOrKey: idpConfig.certificate,
    strictXswProtection: true,
  });

  const signedReferences = getSignatureReferenceUris(xml);
  if (!signedReferences.has(`#${responseId}`) && !signedReferences.has(`#${assertionId}`)) {
    throw new Error('SAML signature does not cover the processed Response or Assertion');
  }
}

function getSignatureReferenceUris(xml: string): Set<string> {
  const doc = parseXml(xml);
  const signatures = doc.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'Signature');
  const uris = new Set<string>();
  for (let i = 0; i < signatures.length; i++) {
    const references = signatures[i].getElementsByTagNameNS(SAML_NAMESPACES.DS, 'Reference');
    for (let j = 0; j < references.length; j++) {
      const uri = getAttribute(references[j], 'URI');
      if (uri) {
        uris.add(uri);
      }
    }
  }
  return uris;
}

function parseSAMLDateTimeMs(value: string, label: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`Invalid SAML dateTime: ${label}`);
  }
  return time;
}

function validateAuthnContextPolicy(
  idpConfig: SAMLIdPConfig,
  authnContextClassRef: string | undefined
): Error | null {
  const policy = idpConfig.authnContextPolicy;
  if (!policy || policy.mode === 'observe') {
    return null;
  }

  if (policy.mode !== 'require_any') {
    return null;
  }

  const allowedClassRefs = (policy.allowedClassRefs || [])
    .map((value: string) => value.trim())
    .filter(Boolean);
  if (allowedClassRefs.length === 0) {
    return null;
  }

  if (!authnContextClassRef || !allowedClassRefs.includes(authnContextClassRef)) {
    return new Error('AuthnContextClassRef is not allowed by provider policy');
  }

  return null;
}

interface UserInfo {
  email?: string;
  name?: string;
  nameId: string;
  nameIdFormat: string;
  attributes: Record<string, string[]>;
  customClaims: Record<string, unknown>;
}

type SAMLIdentityResolutionAction = 'existing_link' | 'email_link' | 'jit_create';

interface SAMLIdentityResolution {
  userId: string;
  action: SAMLIdentityResolutionAction;
  linkedIdentityId?: string;
}

interface SAMLLinkedIdentityRow {
  id: string;
  user_id: string;
  provider_user_id?: string;
}

type SAMLIdentityResolutionFailureReason =
  | 'linked_identity_inactive_user'
  | 'linked_identity_email_conflict'
  | 'email_linking_disabled'
  | 'email_match_inactive_user'
  | 'email_match_unverified_local_email'
  | 'email_match_provider_subject_conflict'
  | 'jit_disabled'
  | 'jit_policy_invalid'
  | 'missing_email'
  | 'pii_database_unavailable'
  | 'custom_claim_validation_failed'
  | 'account_provisioning_pending'
  | 'account_route_inconsistent'
  | 'linked_identity_subject_conflict';

class SamlProvisioningError extends Error {
  constructor(
    message: string,
    public readonly reason: SAMLIdentityResolutionFailureReason,
    public readonly missingRequiredFields?: Array<{
      fieldKey: string;
      label: string;
      fieldType: string;
    }>,
    public readonly auditDetails?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SamlProvisioningError';
  }
}

class SamlAttributeMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SamlAttributeMappingError';
  }
}

/**
 * Extract user information from assertion using the configured Field Mapping Set.
 */
async function extractUserInfo(
  env: Env,
  tenantId: string,
  spEntityId: string,
  assertion: SAMLAssertion,
  idpConfig: SAMLIdPConfig
): Promise<UserInfo> {
  const userInfo: UserInfo = {
    nameId: assertion.subject.nameId,
    nameIdFormat: assertion.subject.nameIdFormat,
    attributes: {},
    customClaims: {},
  };

  // Build attributes map
  if (assertion.attributeStatement) {
    for (const attr of assertion.attributeStatement) {
      userInfo.attributes[attr.name] = attr.values;
      if (attr.friendlyName) {
        userInfo.attributes[attr.friendlyName] = attr.values;
      }
    }
  }

  const configured = idpConfig.identityMapping;
  if (!configured?.fieldMappingSetId) {
    throw new SamlAttributeMappingError('SAML IdP Field Mapping Set is required');
  }

  const adapter = requireAdminDatabaseAdapter(env, 'saml-sp-identity-mapping');
  const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
    tenantId,
    protocol: 'saml',
    role: 'sp',
    fieldMappingSetId: configured.fieldMappingSetId,
    fieldMappingVersionId: configured.fieldMappingVersionId,
    localEntityId: spEntityId,
    partnerEntityId: idpConfig.entityId,
  });
  if (!binding) {
    throw new SamlAttributeMappingError('SAML IdP Field Mapping Set is not active');
  }

  const runtimeResult = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues: buildSAMLInboundSourceValues(assertion),
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
    runtimeContext: {
      tenantId,
      localEntityId: spEntityId,
      partnerEntityId: idpConfig.entityId,
      protocol: 'saml',
      role: 'sp',
    },
  });
  if (runtimeResult.status === 'failed') {
    throw new SamlAttributeMappingError(
      `SAML IdP Field Mapping Set failed: ${runtimeResult.reasons.map((item) => item.code).join(', ')}`
    );
  }

  applySAMLInboundMappedValues(userInfo, runtimeResult.values);

  return userInfo;
}

function buildSAMLInboundSourceValues(assertion: SAMLAssertion): SourceValueEnvelope[] {
  const values: SourceValueEnvelope[] = [
    {
      value: assertion.subject.nameId,
      sourceRef: { side: 'source', namespace: 'saml.subject', path: 'nameId' },
      metadata: { sourceType: 'saml' },
    },
    {
      value: assertion.subject.nameIdFormat,
      sourceRef: { side: 'source', namespace: 'saml.subject', path: 'nameIdFormat' },
      metadata: { sourceType: 'saml' },
    },
  ];

  for (const attribute of assertion.attributeStatement ?? []) {
    const value = attribute.values.length === 1 ? attribute.values[0] : attribute.values;
    values.push({
      value,
      sourceRef: { side: 'source', namespace: 'saml.attribute', path: attribute.name },
      metadata: {
        sourceType: 'saml',
        samlAttributeName: attribute.name,
        samlNameFormat: attribute.nameFormat,
      },
    });
    if (attribute.friendlyName) {
      values.push({
        value,
        sourceRef: { side: 'source', namespace: 'saml.attribute', path: attribute.friendlyName },
        metadata: {
          sourceType: 'saml',
          samlAttributeName: attribute.name,
          samlNameFormat: attribute.nameFormat,
        },
      });
    }
  }

  return values;
}

function applySAMLInboundMappedValues(userInfo: UserInfo, values: SourceValueEnvelope[]): void {
  for (const mappedValue of values) {
    const value = firstMappedScalar(mappedValue.value);
    if (value === undefined) continue;
    const namespace = mappedValue.sourceRef.namespace;
    const path = mappedValue.sourceRef.path;

    if (path === 'email') {
      userInfo.email = value;
      continue;
    }
    if (path === 'name') {
      userInfo.name = value;
      continue;
    }
    if (
      namespace === 'authrim.custom_claims' ||
      namespace === 'custom_claims' ||
      namespace === 'authrim.custom_fields' ||
      namespace === 'custom_fields'
    ) {
      userInfo.customClaims[path] = value;
      continue;
    }
    if (path.startsWith('custom_claims.') || path.startsWith('custom_fields.')) {
      userInfo.customClaims[path.slice(path.indexOf('.') + 1)] = value;
    }
  }
}

function firstMappedScalar(value: unknown): string | undefined {
  const firstValue = Array.isArray(value) ? value[0] : value;
  if (firstValue === undefined || firstValue === null) return undefined;
  if (typeof firstValue === 'string') return firstValue;
  if (typeof firstValue === 'number' || typeof firstValue === 'boolean') {
    return String(firstValue);
  }
  return undefined;
}

/**
 * Find existing user or create new one
 */
async function findOrCreateUser(
  env: Env,
  userInfo: UserInfo,
  idpConfig: SAMLIdPConfig,
  tenantId: string
): Promise<SAMLIdentityResolution> {
  const providerId = idpConfig.entityId;
  const providerUserKey = buildSAMLProviderUserKey(userInfo);
  const normalizedEmail = normalizeEmail(userInfo.email);
  const jitEmailLinkingPolicy = resolveJitEmailLinkingPolicy(idpConfig);
  let account = null;
  try {
    account = await resolveAccountDataContextByIdentifier(env, {
      tenantId,
      indexKind: 'external_subject',
      identifier: { issuer: providerId, subject: providerUserKey },
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === 'account_data_route_not_found')) throw error;
  }
  if (!account && normalizedEmail) {
    try {
      account = await resolveAccountDataContextByIdentifier(env, {
        tenantId,
        indexKind: 'email_exact',
        identifier: normalizedEmail,
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === 'account_data_route_not_found'))
        throw error;
    }
  }
  if (!account) {
    if (jitEmailLinkingPolicy === 'disabled') {
      throw new SamlProvisioningError(
        'SAML JIT provisioning is disabled for this IdP',
        'jit_disabled'
      );
    }
    return provisionSamlJitAccount(env, {
      tenantId,
      providerId,
      providerUserKey,
      normalizedEmail: normalizedEmail ?? null,
      userInfo,
      allowSyntheticEmailFallback: idpConfig.allowSyntheticEmailFallback === true,
    });
  }
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(account.coreDb, 'saml-acs-core');
  const piiAdapter = ensureDatabaseAdapter(account.piiDb, 'saml-acs-pii');
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter,
    piiAdapter,
    tenantId,
  });
  const linkedIdentityAdapter = piiAdapter;

  const existingLink = await findSAMLLinkedIdentity(
    linkedIdentityAdapter,
    tenantId,
    providerId,
    providerUserKey
  );
  if (existingLink) {
    const activeUser = await runtimeUsers.findById(existingLink.user_id);
    if (!activeUser) {
      throw new SamlProvisioningError(
        'SAML linked identity points to an inactive user',
        'linked_identity_inactive_user',
        undefined,
        { linked_identity_id: existingLink.id }
      );
    }

    if (normalizedEmail && piiAdapter) {
      const emailUser = await runtimeUsers.findByEmail(normalizedEmail);
      if (emailUser && emailUser.id !== activeUser.id) {
        throw new SamlProvisioningError(
          'SAML linked identity email conflicts with another local user',
          'linked_identity_email_conflict',
          undefined,
          { linked_identity_id: existingLink.id }
        );
      }
    }

    await touchSAMLLinkedIdentity(
      linkedIdentityAdapter,
      tenantId,
      existingLink.id,
      Boolean(piiAdapter)
    );
    return {
      userId: activeUser.id,
      action: 'existing_link',
      linkedIdentityId: existingLink.id,
    };
  }

  // Try to find user by email (PII/Non-PII DB separation)
  if (normalizedEmail && piiAdapter) {
    const existingUserPII = await runtimeUsers.findByEmail(normalizedEmail);

    if (existingUserPII) {
      if (jitEmailLinkingPolicy !== 'email_linking') {
        throw new SamlProvisioningError(
          'SAML email matched an existing user but email linking is disabled for this IdP',
          'email_linking_disabled',
          undefined,
          { policy: jitEmailLinkingPolicy }
        );
      }

      const activeUser = await runtimeUsers.findById(existingUserPII.id);
      if (!activeUser) {
        throw new SamlProvisioningError(
          'SAML email matched an inactive user',
          'email_match_inactive_user'
        );
      }
      if (!isTruthyDatabaseFlag(activeUser.email_verified)) {
        throw new SamlProvisioningError(
          'SAML email matched a local user with unverified email',
          'email_match_unverified_local_email'
        );
      }

      const existingUserProviderLink = await findUserSAMLLinkedIdentityForProvider(
        linkedIdentityAdapter,
        tenantId,
        activeUser.id,
        providerId
      );
      if (
        existingUserProviderLink &&
        existingUserProviderLink.provider_user_id !== providerUserKey
      ) {
        throw new SamlProvisioningError(
          'SAML email matched a user already linked to a different subject for this IdP',
          'email_match_provider_subject_conflict',
          undefined,
          { linked_identity_id: existingUserProviderLink.id }
        );
      }
      if (existingUserProviderLink) {
        await touchSAMLLinkedIdentity(
          linkedIdentityAdapter,
          tenantId,
          existingUserProviderLink.id,
          Boolean(piiAdapter)
        );
        return {
          userId: activeUser.id,
          action: 'email_link',
          linkedIdentityId: existingUserProviderLink.id,
        };
      }

      const linkedIdentityId = await createSAMLLinkedIdentity({
        adapter: linkedIdentityAdapter,
        tenantId,
        userId: activeUser.id,
        providerId,
        providerUserKey,
        userInfo: { ...userInfo, email: normalizedEmail },
        piiShape: Boolean(piiAdapter),
      });
      await publishSamlExternalRoute(env, {
        tenantId,
        accountId: account.accountId,
        userId: activeUser.id,
        linkedIdentityId,
        providerId,
        providerUserKey,
      });

      return {
        userId: activeUser.id,
        action: 'email_link',
        linkedIdentityId,
      };
    }
  }

  if (jitEmailLinkingPolicy === 'disabled') {
    throw new SamlProvisioningError(
      'SAML JIT provisioning is disabled for this IdP',
      'jit_disabled'
    );
  }

  throw new SamlProvisioningError(
    'SAML account route did not resolve to a usable linked identity',
    'account_route_inconsistent'
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function publishSamlExternalRoute(
  env: Env,
  input: {
    tenantId: string;
    accountId: string;
    userId: string;
    linkedIdentityId: string;
    providerId: string;
    providerUserKey: string;
  }
): Promise<void> {
  const provisioner = env.SAML_ACCOUNT_PROVISIONER;
  if (!provisioner) throw new Error('saml_account_provisioner_unavailable');
  const digest = await sha256Hex(
    JSON.stringify({
      tenantId: input.tenantId,
      accountId: input.accountId,
      linkedIdentityId: input.linkedIdentityId,
      providerId: input.providerId,
      providerUserKey: input.providerUserKey,
    })
  );
  const operationId = `saml-route-${digest.slice(0, 32)}`;
  const result = await provisioner.publishExternalIdpRoute({
    schemaVersion: 1,
    operationId,
    idempotencyKey: `saml-route:${digest}`,
    tenantId: input.tenantId,
    accountId: input.accountId,
    userId: input.userId,
    linkedIdentityId: input.linkedIdentityId,
    providerId: input.providerId,
    providerUserId: input.providerUserKey,
  });
  if (
    result.operationId !== operationId ||
    result.accountId !== input.accountId ||
    (result.status !== 201 && result.status !== 202)
  ) {
    throw new Error('saml_external_route_publication_invalid');
  }
}

async function provisionSamlJitAccount(
  env: Env,
  input: {
    tenantId: string;
    providerId: string;
    providerUserKey: string;
    normalizedEmail: string | null;
    userInfo: UserInfo;
    allowSyntheticEmailFallback: boolean;
  }
): Promise<SAMLIdentityResolution> {
  const provisioner = env.SAML_ACCOUNT_PROVISIONER;
  if (!provisioner) throw new Error('saml_account_provisioner_unavailable');
  if (!input.normalizedEmail && !input.allowSyntheticEmailFallback) {
    throw new SamlProvisioningError(
      'SAML JIT provisioning requires an email unless synthetic email fallback is explicitly enabled',
      'missing_email'
    );
  }
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(env, input.tenantId);
  const customClaimValidation = await validateCustomClaimWrite({
    db: customClaimSources.schemaDb,
    dbPii: null,
    piiStorageAvailable: true,
    schemaDb: customClaimSources.schemaDb,
    tenantId: input.tenantId,
    submitted: input.userInfo.customClaims,
    requireCompleteRecord: true,
  });
  if (!customClaimValidation.ok) {
    throw new SamlProvisioningError(
      customClaimValidation.error,
      'custom_claim_validation_failed',
      customClaimValidation.missingRequiredFields
    );
  }
  const candidateUserId = crypto.randomUUID();
  const subjectDigest = await sha256Hex(
    `${input.tenantId}\u0000${input.providerId}\u0000${input.providerUserKey}`
  );
  const email =
    input.normalizedEmail ?? (await buildSyntheticSAMLEmail(`${subjectDigest.slice(0, 32)}`));
  const runtimeUser: AuthAccountProvisioningInput['runtimeUser'] = {
    active: true,
    emailVerified: true,
    userType: 'end_user',
    displayName: input.userInfo.name ?? null,
    sourceRef: 'auth:saml',
    piiFields: { email: true, name: Boolean(input.userInfo.name) },
    sensitiveValues: { email, name: input.userInfo.name ?? null },
  };
  const stableRequest = JSON.stringify({
    tenantId: input.tenantId,
    providerId: input.providerId,
    providerUserKey: input.providerUserKey,
    email,
    runtimeUser,
  });
  const requestDigest = await sha256Hex(stableRequest);
  const provisioned = await provisioner.provisionAuthAccount({
    schemaVersion: 1,
    operationId: `saml-account-${crypto.randomUUID()}`,
    idempotencyKey: `saml-account:${requestDigest}`,
    tenantId: input.tenantId,
    candidateUserId,
    flow: 'saml',
    email,
    externalSubject: { issuer: input.providerId, subject: input.providerUserKey },
    runtimeUser,
  });
  if (provisioned.status === 202) {
    throw new SamlProvisioningError(
      'SAML account provisioning is still pending',
      'account_provisioning_pending'
    );
  }
  const account = await resolveAccountDataContextByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: 'external_subject',
    identifier: { issuer: input.providerId, subject: input.providerUserKey },
    expectedAccountId: provisioned.accountId,
  });
  if (account.legacyUserId !== provisioned.userId) {
    throw new Error('saml_account_provisioning_route_mismatch');
  }
  await persistCustomClaimWrite({
    db: account.coreDb,
    dbPii: account.piiDb,
    tenantId: input.tenantId,
    userId: account.legacyUserId,
    validation: customClaimValidation,
  });
  await syncUserLifecycleState({
    db: account.coreDb,
    dbPii: account.piiDb,
    schemaDb: customClaimSources.schemaDb,
    stateDb: ensureDatabaseAdapter(account.coreDb, 'saml-jit-lifecycle'),
    tenantId: input.tenantId,
    userId: account.legacyUserId,
    accountAuthenticationEnv: env,
  });
  const linkedIdentityId = await createSAMLLinkedIdentity({
    adapter: ensureDatabaseAdapter(account.piiDb, 'saml-jit-linked-identity'),
    tenantId: input.tenantId,
    userId: account.legacyUserId,
    providerId: input.providerId,
    providerUserKey: input.providerUserKey,
    userInfo: { ...input.userInfo, email },
    piiShape: true,
  });
  await publishSamlExternalRoute(env, {
    tenantId: input.tenantId,
    accountId: account.accountId,
    userId: account.legacyUserId,
    linkedIdentityId,
    providerId: input.providerId,
    providerUserKey: input.providerUserKey,
  });
  return { userId: account.legacyUserId, action: 'jit_create', linkedIdentityId };
}

function buildSAMLProviderUserKey(userInfo: UserInfo): string {
  return `saml:${encodeURIComponent(userInfo.nameIdFormat)}:${encodeURIComponent(userInfo.nameId)}`;
}

async function buildSyntheticSAMLEmail(providerUserKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(providerUserKey));
  const localPart = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `saml-${localPart}@saml.local`;
}

function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

function resolveJitEmailLinkingPolicy(
  idpConfig: SAMLIdPConfig
): 'email_linking' | 'jit_create_only' | 'disabled' {
  const policy = idpConfig.jitEmailLinkingPolicy ?? 'email_linking';
  if (SAML_JIT_EMAIL_LINKING_POLICIES.has(policy)) {
    return policy;
  }
  throw new SamlProvisioningError(
    'SAML IdP has an invalid JIT email linking policy',
    'jit_policy_invalid',
    undefined,
    { policy: 'invalid' }
  );
}

function isTruthyDatabaseFlag(value: number | string | boolean | null | undefined): boolean {
  return value === true || value === 1 || value === '1';
}

async function findSAMLLinkedIdentity(
  adapter: DatabaseAdapter,
  tenantId: string,
  providerId: string,
  providerUserKey: string
): Promise<SAMLLinkedIdentityRow | null> {
  return adapter.queryOne<SAMLLinkedIdentityRow>(
    `SELECT id, user_id, provider_user_id FROM linked_identities
     WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?`,
    [tenantId, providerId, providerUserKey]
  );
}

async function findUserSAMLLinkedIdentityForProvider(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  providerId: string
): Promise<SAMLLinkedIdentityRow | null> {
  return adapter.queryOne<SAMLLinkedIdentityRow>(
    `SELECT id, user_id, provider_user_id FROM linked_identities
     WHERE tenant_id = ? AND user_id = ? AND provider_id = ?`,
    [tenantId, userId, providerId]
  );
}

async function touchSAMLLinkedIdentity(
  adapter: DatabaseAdapter,
  tenantId: string,
  linkedIdentityId: string,
  piiShape: boolean
): Promise<void> {
  const now = Date.now();
  if (piiShape) {
    await adapter.execute(
      'UPDATE linked_identities SET last_used_at = ? WHERE tenant_id = ? AND id = ?',
      [now, tenantId, linkedIdentityId]
    );
    return;
  }

  await adapter.execute(
    'UPDATE linked_identities SET last_login_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
    [now, now, tenantId, linkedIdentityId]
  );
}

async function createSAMLLinkedIdentity(params: {
  adapter: DatabaseAdapter;
  tenantId: string;
  userId: string;
  providerId: string;
  providerUserKey: string;
  userInfo: UserInfo;
  piiShape: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const rawAttributes = JSON.stringify({
    source: 'saml_sp_acs',
    nameId: params.userInfo.nameId,
    nameIdFormat: params.userInfo.nameIdFormat,
    attributes: params.userInfo.attributes,
    customClaims: params.userInfo.customClaims,
  });

  try {
    if (params.piiShape) {
      await params.adapter.execute(
        `INSERT INTO linked_identities (
          id, tenant_id, user_id, provider_id, provider_user_id,
          provider_email, provider_name, raw_attributes, linked_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          params.tenantId,
          params.userId,
          params.providerId,
          params.providerUserKey,
          normalizeEmail(params.userInfo.email) ?? null,
          params.userInfo.name ?? null,
          rawAttributes,
          now,
          now,
        ]
      );
      return id;
    }

    await params.adapter.execute(
      `INSERT INTO linked_identities (
        id, tenant_id, user_id, provider_id, provider_user_id,
        provider_email, email_verified, access_token_encrypted, refresh_token_encrypted,
        token_expires_at, raw_claims, profile_data, linked_at, last_login_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
      [
        id,
        params.tenantId,
        params.userId,
        params.providerId,
        params.providerUserKey,
        normalizeEmail(params.userInfo.email) ?? null,
        rawAttributes,
        now,
        now,
        now,
      ]
    );
    return id;
  } catch (error) {
    const existing = await findSAMLLinkedIdentity(
      params.adapter,
      params.tenantId,
      params.providerId,
      params.providerUserKey
    );
    if (existing?.user_id === params.userId) {
      return existing.id;
    }
    if (existing) {
      throw new SamlProvisioningError(
        'SAML linked identity subject conflicts with another user',
        'linked_identity_subject_conflict'
      );
    }
    throw error;
  }
}

/**
 * Create session for user (sharded)
 */
async function createSession(env: Env, userId: string, tenantId: string): Promise<string> {
  const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(env, tenantId);

  const response = await sessionStore.fetch('https://session-store/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      userId,
      ttl: 3600, // 1 hour
      tenantId,
      data: {
        amr: ['saml'],
        acr: 'urn:mace:incommon:iap:bronze',
      },
    }),
  });

  if (!response.ok) {
    throw new Error('Session creation failed');
  }

  return sessionId;
}

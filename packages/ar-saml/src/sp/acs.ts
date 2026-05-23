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
  resolveUserStoreRuntimeSourcesFromEnv,
  getChallengeStoreByChallengeId,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Audit Log
  createAuditLog,
} from '@authrim/ar-lib-core';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import { parseXml, getAttribute, getTextContent } from '../common/xml-utils';
import {
  decodePostBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../common/message-limits';
import { SAML_NAMESPACES, STATUS_CODES, DEFAULTS } from '../common/constants';
import { verifyXmlSignature, hasSignature } from '../common/signature';
import { getIdPConfigByEntityId } from '../admin/providers';
import { getSAMLLocalEntityIds } from '../common/entity-id';

const SESSION_COOKIE_NAME = 'authrim_session';
const SESSION_COOKIE_MAX_AGE_SECONDS = 3600;
const SESSION_HANDOFF_TTL_SECONDS = 60;
const SAML_SP_HANDOFF_AUDIENCE = 'saml_sp_cookie_handoff';
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

type SAMLIdPConfigWithAuthnContextPolicy = SAMLIdPConfig & {
  authnContextPolicy?: {
    mode: 'observe' | 'require_any';
    allowedClassRefs?: string[];
  };
};

/**
 * Handle ACS request (receive SAML Response from IdP)
 */
export async function handleSPACS(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-SP');
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { issuerUrl, spEntityId } = await getSAMLLocalEntityIds(env, tenantId);

  try {
    // Parse POST data
    const formData = await parsePostBindingFormDataWithLimit(c.req);
    const samlResponse = formData.get('SAMLResponse') as string;
    const relayState = formData.get('RelayState') as string | null;

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

    // Extract user information from assertion
    const userInfo = extractUserInfo(assertion, idpConfig);

    // Find or create user
    const userId = await findOrCreateUser(env, userInfo, issuer, tenantId);

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
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'custom_claims', reason: error.message },
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
  if (assertionElements.length !== 1) {
    throw new Error('Invalid SAML Response: expected exactly one Assertion');
  }

  // Parse Assertion (pass inResponseTo for SubjectConfirmationData validation)
  const assertion = parseAssertion(assertionElements[0], issuerUrl, spEntityId, inResponseTo);

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

function findDirectChildElement(
  parent: Element,
  namespace: string,
  localName: string
): Element | null {
  return findDirectChildElements(parent, namespace, localName)[0] ?? null;
}

function findDirectChildElements(parent: Element, namespace: string, localName: string): Element[] {
  const results: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (
      child.nodeType === 1 &&
      (child as Element).namespaceURI === namespace &&
      (child as Element).localName === localName
    ) {
      results.push(child as Element);
    }
  }
  return results;
}

function validateAuthnContextPolicy(
  idpConfig: SAMLIdPConfig,
  authnContextClassRef: string | undefined
): Error | null {
  const policy = (idpConfig as SAMLIdPConfigWithAuthnContextPolicy).authnContextPolicy;
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
  attributes: Record<string, string[]>;
  customClaims: Record<string, unknown>;
}

class SamlProvisioningError extends Error {
  constructor(
    message: string,
    public readonly missingRequiredFields?: Array<{
      fieldKey: string;
      label: string;
      fieldType: string;
    }>
  ) {
    super(message);
    this.name = 'SamlProvisioningError';
  }
}

/**
 * Extract user information from assertion using IdP's attribute mapping
 */
function extractUserInfo(assertion: SAMLAssertion, idpConfig: SAMLIdPConfig): UserInfo {
  const userInfo: UserInfo = {
    nameId: assertion.subject.nameId,
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

  // Apply attribute mapping
  for (const [samlAttr, oidcClaim] of Object.entries(idpConfig.attributeMapping)) {
    const values = userInfo.attributes[samlAttr];
    if (values && values.length > 0) {
      if (oidcClaim === 'email') {
        userInfo.email = values[0];
      } else if (oidcClaim === 'name') {
        userInfo.name = values[0];
      } else if (oidcClaim.startsWith('custom_claims.') || oidcClaim.startsWith('custom_fields.')) {
        const fieldKey = oidcClaim.includes('.') ? oidcClaim.slice(oidcClaim.indexOf('.') + 1) : '';
        if (fieldKey) {
          userInfo.customClaims[fieldKey] = values[0];
        }
      }
    }
  }

  // Fallback: use NameID as email if email attribute mapping didn't work
  if (!userInfo.email && assertion.subject.nameIdFormat?.includes('emailAddress')) {
    userInfo.email = assertion.subject.nameId;
  }

  return userInfo;
}

/**
 * Find existing user or create new one
 */
async function findOrCreateUser(
  env: Env,
  userInfo: UserInfo,
  idpEntityId: string,
  tenantId: string
): Promise<string> {
  const userStoreSources = await resolveUserStoreRuntimeSourcesFromEnv(env, tenantId);
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(
    userStoreSources.coreDb,
    'saml-acs-core'
  );
  const piiAdapter: DatabaseAdapter | null = userStoreSources.piiDb
    ? ensureDatabaseAdapter(userStoreSources.piiDb, 'saml-acs-pii')
    : null;
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId);

  // Try to find user by email (PII/Non-PII DB separation)
  if (userInfo.email && piiAdapter) {
    const existingUserPII = await piiAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?',
      [tenantId, userInfo.email.toLowerCase()]
    );

    if (existingUserPII) {
      // Verify user is active in Core DB
      const userCore = await coreAdapter.queryOne<{ id: string }>(
        'SELECT id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
        [existingUserPII.id, tenantId]
      );
      if (userCore) {
        return userCore.id;
      }
    }
  }

  const customClaimValidation = await validateCustomClaimWrite({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    tenantId,
    submitted: userInfo.customClaims,
    requireCompleteRecord: true,
  });

  if (!customClaimValidation.ok) {
    throw new SamlProvisioningError(
      customClaimValidation.error,
      customClaimValidation.missingRequiredFields
    );
  }

  // Create new user (JIT provisioning - PII/Non-PII DB separation)
  const userId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const email = userInfo.email?.toLowerCase() || `${userInfo.nameId}@saml.local`;

  // Step 1: Insert into users_core with pii_status='pending'
  await coreAdapter.execute(
    `INSERT INTO users_core (
      id, tenant_id, email_verified, user_type, pii_partition, pii_status, lifecycle_state, created_at, updated_at
     ) VALUES (?, ?, 1, 'end_user', ?, 'pending', 'provisioning', ?, ?)`,
    [userId, tenantId, tenantId, now, now]
  );

  // Step 2: Insert into users_pii (if DB_PII is configured)
  if (piiAdapter) {
    await piiAdapter.execute(
      `INSERT INTO users_pii (id, tenant_id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, tenantId, email, userInfo.name || null, now, now]
    );

    // Step 3: Update pii_status to 'active'
    await coreAdapter.execute(
      'UPDATE users_core SET pii_status = ? WHERE id = ? AND tenant_id = ?',
      ['active', userId, tenantId]
    );
  }

  try {
    await persistCustomClaimWrite({
      db: customClaimSources.nonPiiDb,
      dbPii: customClaimSources.piiDb,
      tenantId,
      userId,
      validation: customClaimValidation,
    });
  } catch (persistError) {
    if (piiAdapter) {
      await piiAdapter.execute('DELETE FROM users_pii WHERE id = ? AND tenant_id = ?', [
        userId,
        tenantId,
      ]);
    }
    await ensureDatabaseAdapter(
      customClaimSources.nonPiiDb,
      'saml-acs-custom-claim-cleanup'
    ).execute('DELETE FROM user_custom_fields WHERE user_id = ? AND tenant_id = ?', [
      userId,
      tenantId,
    ]);
    await coreAdapter.execute('DELETE FROM users_core WHERE id = ? AND tenant_id = ?', [
      userId,
      tenantId,
    ]);
    throw persistError;
  }

  await syncUserLifecycleState({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    stateDb: coreAdapter,
    tenantId,
    userId,
  });

  return userId;
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

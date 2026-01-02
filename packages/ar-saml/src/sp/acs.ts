/**
 * SAML SP Assertion Consumer Service (ACS) Endpoint
 *
 * Receives and validates SAML Response from IdP, then creates Authrim session.
 * POST /saml/sp/acs
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { SAMLIdPConfig, SAMLAssertion } from '@authrim/ar-lib-core';
import {
  getSessionStoreForNewSession,
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  getTenantIdFromContext,
  buildIssuerUrl,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
} from '@authrim/ar-lib-core';
import {
  parseXml,
  findElement,
  findElements,
  getAttribute,
  getTextContent,
  base64Decode,
} from '../common/xml-utils';
import { SAML_NAMESPACES, STATUS_CODES, DEFAULTS } from '../common/constants';
import { verifyXmlSignature, hasSignature } from '../common/signature';
import { getIdPConfigByEntityId } from '../admin/providers';

/**
 * Handle ACS request (receive SAML Response from IdP)
 */
export async function handleSPACS(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  try {
    // Parse POST data
    const formData = await c.req.formData();
    const samlResponse = formData.get('SAMLResponse') as string;
    const relayState = formData.get('RelayState') as string | null;

    if (!samlResponse) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'SAMLResponse' },
      });
    }

    // Decode SAML Response
    const responseXml = base64Decode(samlResponse);

    // Parse and validate Response
    const { issuer, assertion, inResponseTo } = parseAndValidateResponse(responseXml, env);

    // Get IdP configuration
    const idpConfig = await getIdPConfigByEntityId(env, issuer);
    if (!idpConfig) {
      return createErrorResponse(c, AR_ERROR_CODES.SAML_INVALID_RESPONSE);
    }

    // Verify signature if present
    if (hasSignature(responseXml)) {
      try {
        // Use strictXswProtection to prevent XML Signature Wrapping attacks
        // This ensures no duplicate IDs exist and validates Reference URI points to correct element
        // Note: SAML signatures can be on Response or Assertion - both are valid
        verifyXmlSignature(responseXml, {
          certificateOrKey: idpConfig.certificate,
          strictXswProtection: true,
        });

        // Additional validation: ensure the Assertion we're using is covered by the signature
        // Parse the Response and Assertion IDs
        const doc = parseXml(responseXml);
        const responseElement = findElement(doc, SAML_NAMESPACES.SAML2P, 'Response');
        const responseId = responseElement ? getAttribute(responseElement, 'ID') : null;
        const assertionElement = findElement(doc, SAML_NAMESPACES.SAML2, 'Assertion');
        const assertionId = assertionElement ? getAttribute(assertionElement, 'ID') : null;

        // Check if assertion itself is signed (has its own Signature element)
        const assertionHasSignature = assertionElement
          ? findElement(assertionElement, 'http://www.w3.org/2000/09/xmldsig#', 'Signature') !==
            null
          : false;

        // If assertion is not directly signed, ensure Response is signed (which covers the assertion)
        if (!assertionHasSignature && !responseId) {
          console.warn('Neither Assertion nor Response has verifiable signature coverage');
        }
      } catch (error) {
        console.error('Signature verification failed:', error);
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    } else if (idpConfig.certificate) {
      // IdP is expected to sign, but no signature found
      console.warn('Expected signed response but none found');
      // Depending on security requirements, you might want to reject unsigned responses
    }

    // Validate InResponseTo (if we sent an AuthnRequest)
    if (inResponseTo) {
      const isValidRequest = await validateInResponseTo(env, inResponseTo, issuer);
      if (!isValidRequest) {
        const strictMode = await getStrictInResponseToSetting(env);
        if (strictMode) {
          console.error('InResponseTo validation failed (strict mode):', inResponseTo);
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
        console.warn('InResponseTo validation failed:', inResponseTo);
        // Continue anyway for IdP-initiated SSO compatibility (non-strict mode)
      }
    }

    // Validate OneTimeUse condition (SAML 2.0 Core 2.5.1.5)
    if (assertion.conditions?.oneTimeUse) {
      const isFirstUse = await checkAndRecordOneTimeUse(
        env,
        assertion.id,
        assertion.conditions.notOnOrAfter
      );
      if (!isFirstUse) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    }

    // Extract user information from assertion
    const userInfo = extractUserInfo(assertion, idpConfig);

    // Find or create user
    const userId = await findOrCreateUser(env, userInfo, issuer);

    // Create session
    const sessionId = await createSession(env, userId);

    // Publish SAML authentication success event (non-blocking)
    const tenantId = getTenantIdFromContext(c);
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
      console.error('[Event] Failed to publish auth.saml.succeeded:', err);
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
      console.error('[Event] Failed to publish session.user.created:', err);
    });

    // Determine redirect URL
    let returnUrl = relayState;
    if (!returnUrl) {
      const uiConfig = await getUIConfig(env);
      const tenantId = getTenantIdFromContext(c);
      returnUrl = uiConfig?.baseUrl ? `${uiConfig.baseUrl}/` : `${buildIssuerUrl(env, tenantId)}/`;
    }

    // Set session cookie and redirect
    return new Response(null, {
      status: 302,
      headers: {
        Location: returnUrl,
        'Set-Cookie': `authrim_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
      },
    });
  } catch (error) {
    console.error('ACS Error:', error);

    // Publish SAML authentication failure event (non-blocking)
    const failureTenantId = getTenantIdFromContext(c);
    publishEvent(c, {
      type: AUTH_EVENTS.SAML_FAILED,
      tenantId: failureTenantId,
      data: {
        method: 'saml',
        clientId: 'saml-sp',
        errorCode: error instanceof Error ? error.message : 'unknown_error',
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      console.error('[Event] Failed to publish auth.saml.failed:', err);
    });

    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

interface ParsedResponse {
  issuer: string;
  inResponseTo?: string;
  assertion: SAMLAssertion;
}

/**
 * Parse and validate SAML Response
 */
function parseAndValidateResponse(xml: string, env: Env): ParsedResponse {
  const doc = parseXml(xml);

  // Find Response element
  const responseElement = findElement(doc, SAML_NAMESPACES.SAML2P, 'Response');
  if (!responseElement) {
    throw new Error('Invalid SAML Response: missing Response element');
  }

  // Check Destination
  const destination = getAttribute(responseElement, 'Destination');
  if (destination) {
    const expectedDestination = `${env.ISSUER_URL}/saml/sp/acs`;
    if (destination !== expectedDestination) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Destination in SAML Response');
    }
  }

  // Get InResponseTo
  const inResponseTo = getAttribute(responseElement, 'InResponseTo') || undefined;

  // Check Status
  const statusElement = findElement(responseElement, SAML_NAMESPACES.SAML2P, 'Status');
  if (!statusElement) {
    throw new Error('Invalid SAML Response: missing Status element');
  }

  const statusCodeElement = findElement(statusElement, SAML_NAMESPACES.SAML2P, 'StatusCode');
  const statusCode = getAttribute(statusCodeElement!, 'Value');

  if (statusCode !== STATUS_CODES.SUCCESS) {
    const statusMessage = getTextContent(
      findElement(statusElement, SAML_NAMESPACES.SAML2P, 'StatusMessage')
    );
    throw new Error(
      `SAML authentication failed: ${statusCode} - ${statusMessage || 'Unknown error'}`
    );
  }

  // Get Issuer
  const issuerElement = findElement(responseElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement);
  if (!issuer) {
    throw new Error('Invalid SAML Response: missing Issuer');
  }

  // Find Assertion
  const assertionElement = findElement(responseElement, SAML_NAMESPACES.SAML2, 'Assertion');
  if (!assertionElement) {
    throw new Error('Invalid SAML Response: missing Assertion');
  }

  // Parse Assertion (pass inResponseTo for SubjectConfirmationData validation)
  const assertion = parseAssertion(assertionElement, env, inResponseTo);

  return { issuer, inResponseTo, assertion };
}

/**
 * Parse SAML Assertion
 *
 * @param assertionElement - The Assertion XML element
 * @param env - Environment bindings
 * @param inResponseTo - The InResponseTo attribute from the Response (for SubjectConfirmationData validation)
 */
function parseAssertion(assertionElement: Element, env: Env, inResponseTo?: string): SAMLAssertion {
  const id = getAttribute(assertionElement, 'ID') || '';
  const issueInstant = getAttribute(assertionElement, 'IssueInstant') || '';

  // Get Issuer
  const issuerElement = findElement(assertionElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement) || '';

  // Parse Subject
  const subjectElement = findElement(assertionElement, SAML_NAMESPACES.SAML2, 'Subject');
  if (!subjectElement) {
    throw new Error('Invalid Assertion: missing Subject');
  }

  const nameIdElement = findElement(subjectElement, SAML_NAMESPACES.SAML2, 'NameID');
  if (!nameIdElement) {
    throw new Error('Invalid Assertion: missing NameID');
  }

  const nameId = getTextContent(nameIdElement) || '';
  const nameIdFormat =
    getAttribute(nameIdElement, 'Format') ||
    'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';

  // Validate SubjectConfirmation (SAML 2.0 Profiles 4.1.4.2)
  const expectedAcsUrl = `${env.ISSUER_URL}/saml/sp/acs`;
  validateSubjectConfirmation(subjectElement, expectedAcsUrl, inResponseTo);

  // Parse Conditions
  const conditionsElement = findElement(assertionElement, SAML_NAMESPACES.SAML2, 'Conditions');
  let conditions: SAMLAssertion['conditions'];

  if (conditionsElement) {
    const notBefore = getAttribute(conditionsElement, 'NotBefore');
    const notOnOrAfter = getAttribute(conditionsElement, 'NotOnOrAfter');

    // Validate time conditions
    const now = Date.now();
    const clockSkewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;

    if (notBefore) {
      const notBeforeTime = new Date(notBefore).getTime();
      if (now < notBeforeTime - clockSkewMs) {
        throw new Error('Assertion is not yet valid (NotBefore)');
      }
    }

    if (notOnOrAfter) {
      const notOnOrAfterTime = new Date(notOnOrAfter).getTime();
      if (now > notOnOrAfterTime + clockSkewMs) {
        throw new Error('Assertion has expired (NotOnOrAfter)');
      }
    }

    // Get Audience
    const audienceElements = findElements(conditionsElement, SAML_NAMESPACES.SAML2, 'Audience');
    const audiences = audienceElements.map((el) => getTextContent(el) || '').filter(Boolean);

    // Validate audience
    const expectedAudience = `${env.ISSUER_URL}/saml/sp`;
    if (audiences.length > 0 && !audiences.includes(expectedAudience)) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Audience in SAML Assertion');
    }

    // Check OneTimeUse condition (SAML 2.0 Core 2.5.1.5)
    const oneTimeUseElement = findElement(conditionsElement, SAML_NAMESPACES.SAML2, 'OneTimeUse');
    const oneTimeUse = oneTimeUseElement !== null;

    // Check ProxyRestriction condition (SAML 2.0 Core 2.5.1.6)
    const proxyRestrictionElement = findElement(
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
  const authnStatementElement = findElement(
    assertionElement,
    SAML_NAMESPACES.SAML2,
    'AuthnStatement'
  );
  let authnStatement: SAMLAssertion['authnStatement'];

  if (authnStatementElement) {
    const authnContextElement = findElement(
      authnStatementElement,
      SAML_NAMESPACES.SAML2,
      'AuthnContext'
    );
    const authnContextClassRefElement = findElement(
      authnContextElement!,
      SAML_NAMESPACES.SAML2,
      'AuthnContextClassRef'
    );

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
  const attributeStatementElement = findElement(
    assertionElement,
    SAML_NAMESPACES.SAML2,
    'AttributeStatement'
  );
  const attributeStatement: SAMLAssertion['attributeStatement'] = [];

  if (attributeStatementElement) {
    const attributeElements = findElements(
      attributeStatementElement,
      SAML_NAMESPACES.SAML2,
      'Attribute'
    );

    for (const attrEl of attributeElements) {
      const name = getAttribute(attrEl, 'Name') || '';
      const nameFormat = getAttribute(attrEl, 'NameFormat') || undefined;
      const friendlyName = getAttribute(attrEl, 'FriendlyName') || undefined;

      const valueElements = findElements(attrEl, SAML_NAMESPACES.SAML2, 'AttributeValue');
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
): void {
  // Find SubjectConfirmation element
  const subjectConfirmationElement = findElement(
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
  const subjectConfirmationDataElement = findElement(
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

  const notOnOrAfterTime = new Date(notOnOrAfter).getTime();
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
      console.warn(
        'SubjectConfirmationData contains InResponseTo but this appears to be IdP-initiated SSO:',
        subjectConfirmationInResponseTo
      );
      // For compatibility, we log a warning but don't reject
      // Strict mode can be enabled via SAML_STRICT_INRESPONSETO
    }
  }
}

/**
 * Check and record OneTimeUse assertion (SAML 2.0 Core 2.5.1.5)
 * Returns true if this is the first use, false if already used
 */
async function checkAndRecordOneTimeUse(
  env: Env,
  assertionId: string,
  notOnOrAfter?: string
): Promise<boolean> {
  // Use NONCE_STORE KV for tracking used assertions
  const kvStore = env.NONCE_STORE;
  const key = `saml:assertion:${assertionId}`;

  // Check if assertion ID has been used
  const existingEntry = await kvStore.get(key);
  if (existingEntry) {
    console.warn('OneTimeUse assertion already used:', assertionId);
    return false;
  }

  // Calculate TTL based on NotOnOrAfter (or default 5 minutes)
  let expirationTtl = 300; // Default 5 minutes
  if (notOnOrAfter) {
    const notOnOrAfterTime = new Date(notOnOrAfter).getTime();
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
 * Validate InResponseTo against stored request
 */
async function validateInResponseTo(
  env: Env,
  inResponseTo: string,
  issuer: string
): Promise<boolean> {
  try {
    const samlRequestStoreId = env.SAML_REQUEST_STORE.idFromName(`issuer:${issuer}`);
    const samlRequestStore = env.SAML_REQUEST_STORE.get(samlRequestStoreId);

    const response = await samlRequestStore.fetch(
      new Request(`https://saml-request-store/consume/${inResponseTo}`, {
        method: 'POST',
      })
    );

    return response.ok;
  } catch {
    return false;
  }
}

interface UserInfo {
  email?: string;
  name?: string;
  nameId: string;
  attributes: Record<string, string[]>;
}

/**
 * Extract user information from assertion using IdP's attribute mapping
 */
function extractUserInfo(assertion: SAMLAssertion, idpConfig: SAMLIdPConfig): UserInfo {
  const userInfo: UserInfo = {
    nameId: assertion.subject.nameId,
    attributes: {},
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
  idpEntityId: string
): Promise<string> {
  // Use default tenant for SAML-authenticated users
  const tenantId = 'default';

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const piiAdapter: DatabaseAdapter | null = env.DB_PII ? new D1Adapter({ db: env.DB_PII }) : null;

  // Try to find user by email (PII/Non-PII DB separation)
  if (userInfo.email && piiAdapter) {
    const existingUserPII = await piiAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?',
      [tenantId, userInfo.email.toLowerCase()]
    );

    if (existingUserPII) {
      // Verify user is active in Core DB
      const userCore = await coreAdapter.queryOne<{ id: string }>(
        'SELECT id FROM users_core WHERE id = ? AND is_active = 1',
        [existingUserPII.id]
      );
      if (userCore) {
        return userCore.id;
      }
    }
  }

  // Create new user (JIT provisioning - PII/Non-PII DB separation)
  const userId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const email = userInfo.email?.toLowerCase() || `${userInfo.nameId}@saml.local`;

  // Step 1: Insert into users_core with pii_status='pending'
  await coreAdapter.execute(
    `INSERT INTO users_core (id, tenant_id, email_verified, user_type, pii_partition, pii_status, created_at, updated_at)
     VALUES (?, ?, 1, 'end_user', 'default', 'pending', ?, ?)`,
    [userId, tenantId, now, now]
  );

  // Step 2: Insert into users_pii (if DB_PII is configured)
  if (piiAdapter) {
    await piiAdapter.execute(
      `INSERT INTO users_pii (id, tenant_id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, tenantId, email, userInfo.name || null, now, now]
    );

    // Step 3: Update pii_status to 'active'
    await coreAdapter.execute('UPDATE users_core SET pii_status = ? WHERE id = ?', [
      'active',
      userId,
    ]);
  }

  return userId;
}

/**
 * Create session for user (sharded)
 */
async function createSession(env: Env, userId: string): Promise<string> {
  const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(env);

  const response = await sessionStore.fetch(
    new Request('https://session-store/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userId,
        ttl: 3600, // 1 hour
        data: {
          amr: ['saml'],
          acr: 'urn:mace:incommon:iap:bronze',
        },
      }),
    })
  );

  if (!response.ok) {
    throw new Error('Session creation failed');
  }

  return sessionId;
}

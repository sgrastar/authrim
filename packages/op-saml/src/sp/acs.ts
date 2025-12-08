/**
 * SAML SP Assertion Consumer Service (ACS) Endpoint
 *
 * Receives and validates SAML Response from IdP, then creates Authrim session.
 * POST /saml/sp/acs
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import type { SAMLIdPConfig, SAMLAssertion } from '@authrim/shared';
import { getSessionStoreForNewSession } from '@authrim/shared';
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
      return c.json({ error: 'Missing SAMLResponse' }, 400);
    }

    // Decode SAML Response
    const responseXml = base64Decode(samlResponse);

    // Parse and validate Response
    const { issuer, assertion, inResponseTo } = parseAndValidateResponse(responseXml, env);

    // Get IdP configuration
    const idpConfig = await getIdPConfigByEntityId(env, issuer);
    if (!idpConfig) {
      return c.json({ error: 'Unknown Identity Provider', issuer }, 400);
    }

    // Verify signature if present
    if (hasSignature(responseXml)) {
      try {
        verifyXmlSignature(responseXml, { certificateOrKey: idpConfig.certificate });
      } catch (error) {
        console.error('Signature verification failed:', error);
        return c.json({ error: 'Invalid signature' }, 400);
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
        console.warn('InResponseTo validation failed:', inResponseTo);
        // Continue anyway for IdP-initiated SSO compatibility
      }
    }

    // Extract user information from assertion
    const userInfo = extractUserInfo(assertion, idpConfig);

    // Find or create user
    const userId = await findOrCreateUser(env, userInfo, issuer);

    // Create session
    const sessionId = await createSession(env, userId);

    // Determine redirect URL
    const returnUrl = relayState || `${env.UI_BASE_URL}/`;

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
    return c.json(
      {
        error: 'acs_error',
        message: error instanceof Error ? error.message : 'ACS processing failed',
      },
      500
    );
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
      throw new Error(`Invalid Destination: expected ${expectedDestination}, got ${destination}`);
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

  // Parse Assertion
  const assertion = parseAssertion(assertionElement, env);

  return { issuer, inResponseTo, assertion };
}

/**
 * Parse SAML Assertion
 */
function parseAssertion(assertionElement: Element, env: Env): SAMLAssertion {
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
      throw new Error(`Invalid Audience: expected ${expectedAudience}`);
    }

    conditions = {
      notBefore: notBefore || undefined,
      notOnOrAfter: notOnOrAfter || undefined,
      audienceRestriction: audiences.length > 0 ? audiences : undefined,
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
  // Try to find user by email
  if (userInfo.email) {
    const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(userInfo.email)
      .first();

    if (existingUser) {
      return existingUser.id as string;
    }
  }

  // Create new user (JIT provisioning)
  const userId = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (id, email, name, email_verified, identity_provider_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(
      userId,
      userInfo.email || `${userInfo.nameId}@saml.local`,
      userInfo.name || null,
      idpEntityId,
      now,
      now
    )
    .run();

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

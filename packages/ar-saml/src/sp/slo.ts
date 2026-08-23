/**
 * SAML SP Single Logout (SLO) Endpoint
 *
 * Handles:
 * 1. LogoutRequest from IdP - Terminates SP session and sends LogoutResponse
 * 2. LogoutResponse from IdP - Confirms logout completion (for SP-initiated logout)
 *
 * Supports HTTP-POST and HTTP-Redirect bindings.
 *
 * POST /saml/sp/slo
 * GET  /saml/sp/slo
 */

import type { Context } from 'hono';
import type { Env, SAMLIdPConfig } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  buildIssuerUrl,
  usesNakedDomainIssuer,
  getLogger,
  createLogger,
  createAuthContextFromHono,
  recordHybridUserSessionRevocationEpoch,
} from '@authrim/ar-lib-core';
import {
  parseLogoutResponseXml,
  parseLogoutRequestXml,
  buildLogoutResponse,
  buildLogoutRequest,
  encodeForPostBinding,
  type ParsedLogoutRequest,
  type ParsedLogoutResponse,
} from '../common/slo-messages';
import {
  decodePostBindingMessage,
  inflateRedirectBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../common/message-limits';
import { generateSAMLId, nowAsDateTime } from '../common/xml-utils';
import {
  DIGEST_ALGORITHMS,
  SIGNATURE_ALGORITHMS,
  STATUS_CODES,
  DEFAULTS,
} from '../common/constants';
import {
  signXml,
  verifyRedirectBindingSignature,
  verifyXmlSignatureAndGetReferences,
  hasSignature,
  parseRedirectBindingSignatureInput,
} from '../common/signature';
import { getSAMLSigningMaterial, getSAMLSigningPolicy } from '../common/saml-signing-keys';
import { getIdPConfigByEntityId } from '../admin/providers';
import { findActiveSamlUserByEmail, getSamlUserNameIdById } from '../common/user-store';
import { requireSAMLTenantId, resolveSAMLTenantIdFromContext } from '../common/tenant';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import {
  SAMLIdPLogoutRequestSignatureValidationError,
  validateSAMLIdPLogoutRequestSignature,
} from './logout-request-signature';
import type { SAMLRedirectSignatureInput } from '../idp/authn-request-signature';
import {
  consumeSAMLOutboundLogoutRequest,
  storeSAMLOutboundLogoutRequest,
  SAMLLogoutResponseCorrelationError,
} from '../idp/slo-state';
import { assertSAMLRelayStateSize, SAMLRelayStateTooLargeError } from '../common/relay-state';

class SAMLLogoutMessageValidationError extends Error {
  constructor() {
    super('Invalid SAML logout message');
    this.name = 'SAMLLogoutMessageValidationError';
  }
}

/**
 * Handle SP Single Logout (both POST and GET)
 */
export async function handleSPSLO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;
  const log = getLogger(c).module('SAML-SP');
  const { issuerUrl } = await getSAMLLocalEntityIds(env, resolveSAMLTenantIdFromContext(c));

  try {
    if (method === 'GET') {
      return await handleRedirectBinding(c, env, issuerUrl);
    } else {
      return await handlePostBinding(c, env, issuerUrl);
    }
  } catch (error) {
    log.error('SP SLO Error', { method }, error as Error);
    if (isSAMLLogoutMessageValidationError(error)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Handle HTTP-POST binding
 */
async function handlePostBinding(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string
): Promise<Response> {
  const formData = await parsePostBindingFormDataWithLimit(c.req);
  const samlRequest = formData.get('SAMLRequest') as string | null;
  const samlResponse = formData.get('SAMLResponse') as string | null;
  const relayState = formData.get('RelayState') as string | null;
  assertSAMLRelayStateSize(relayState);

  if (samlRequest) {
    const xml = parseSAMLLogoutMessage(() =>
      decodePostBindingMessage(samlRequest, 'SAML LogoutRequest')
    );
    const logoutRequest = parseSAMLLogoutMessage(() => parseLogoutRequestXml(xml));
    return processLogoutRequest(c, env, issuerUrl, {
      logoutRequest,
      relayState,
      binding: 'post',
      xml,
    });
  } else if (samlResponse) {
    const xml = parseSAMLLogoutMessage(() =>
      decodePostBindingMessage(samlResponse, 'SAML LogoutResponse')
    );
    const logoutResponse = parseSAMLLogoutMessage(() => parseLogoutResponseXml(xml));
    return processLogoutResponse(c, env, {
      logoutResponse,
      relayState,
      binding: 'post',
      xml,
    });
  } else {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'SAMLRequest or SAMLResponse' },
    });
  }
}

/**
 * Handle HTTP-Redirect binding
 */
async function handleRedirectBinding(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string
): Promise<Response> {
  const url = new URL(c.req.url);
  const samlRequest = url.searchParams.get('SAMLRequest');
  const samlResponse = url.searchParams.get('SAMLResponse');
  const relayState = url.searchParams.get('RelayState');
  assertSAMLRelayStateSize(relayState);

  if (samlRequest) {
    const redirectSignature = parseRedirectBindingSignatureInput(url.search, 'SAMLRequest');
    const xml = parseSAMLLogoutMessage(() =>
      inflateRedirectBindingMessage(samlRequest, 'SAML LogoutRequest')
    );
    const logoutRequest = parseSAMLLogoutMessage(() => parseLogoutRequestXml(xml));
    return processLogoutRequest(c, env, issuerUrl, {
      logoutRequest,
      relayState,
      binding: 'redirect',
      xml,
      redirectSignature,
    });
  } else if (samlResponse) {
    const redirectSignature = parseRedirectBindingSignatureInput(url.search, 'SAMLResponse');
    const xml = parseSAMLLogoutMessage(() =>
      inflateRedirectBindingMessage(samlResponse, 'SAML LogoutResponse')
    );
    const logoutResponse = parseSAMLLogoutMessage(() => parseLogoutResponseXml(xml));
    return processLogoutResponse(c, env, {
      logoutResponse,
      relayState,
      binding: 'redirect',
      xml,
      redirectSignature,
    });
  } else {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'SAMLRequest or SAMLResponse' },
    });
  }
}

/**
 * Process LogoutRequest from IdP
 */
interface ParsedIdPLogoutRequestInput {
  logoutRequest: ParsedLogoutRequest;
  relayState: string | null;
  binding: 'post' | 'redirect';
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

async function processLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  input: ParsedIdPLogoutRequestInput
): Promise<Response> {
  const log = getLogger(c).module('SAML-SP');
  let { logoutRequest } = input;
  const { relayState, binding } = input;

  // Get IdP configuration
  const idpConfig = await getIdPConfigByEntityId(
    env,
    resolveSAMLTenantIdFromContext(c),
    logoutRequest.issuer
  );

  if (!idpConfig) {
    log.error('Unknown IdP', { issuer: logoutRequest.issuer });
    return createErrorResponse(c, AR_ERROR_CODES.SAML_INVALID_RESPONSE);
  }

  try {
    const verifiedReferences = await validateSAMLIdPLogoutRequestSignature({
      logoutRequest,
      idpConfig,
      binding,
      xml: input.xml,
      redirectSignature: input.redirectSignature,
    });
    if (binding === 'post' && verifiedReferences) {
      const signedRequest = verifiedReferences.find(
        (reference) => reference.uri === `#${logoutRequest.id}`
      );
      if (!signedRequest) {
        throw new SAMLIdPLogoutRequestSignatureValidationError(
          'idp_logout_request_invalid_signature',
          'Signed LogoutRequest reference is missing'
        );
      }
      const authenticatedRequest = parseLogoutRequestXml(signedRequest.xml);
      if (
        authenticatedRequest.id !== logoutRequest.id ||
        authenticatedRequest.issuer !== logoutRequest.issuer
      ) {
        throw new SAMLIdPLogoutRequestSignatureValidationError(
          'idp_logout_request_invalid_signature',
          'Signed LogoutRequest does not match the routed request'
        );
      }
      logoutRequest = authenticatedRequest;
    }
  } catch (error) {
    if (error instanceof SAMLIdPLogoutRequestSignatureValidationError) {
      log.warn('IdP LogoutRequest signature policy failed', {
        tenantId: resolveSAMLTenantIdFromContext(c),
        idpEntityId: idpConfig.entityId,
        logoutRequestId: logoutRequest.id,
        failureKind: error.failureKind,
      });
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    throw error;
  }

  // Validate LogoutRequest
  validateLogoutRequest(logoutRequest, issuerUrl);

  // Terminate session by NameID
  await terminateSessionByNameId(c, env, logoutRequest.nameId, logoutRequest.sessionIndex);

  // Clear session cookie
  const cookieHeader = 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  // Build and send LogoutResponse to IdP
  return sendLogoutResponse(
    c,
    env,
    issuerUrl,
    idpConfig,
    {
      inResponseTo: logoutRequest.id,
      statusCode: STATUS_CODES.SUCCESS,
      relayState,
      binding,
    },
    cookieHeader
  );
}

/**
 * Process LogoutResponse from IdP (for SP-initiated logout)
 */
async function processLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  input: {
    logoutResponse: ParsedLogoutResponse;
    relayState: string | null;
    binding: 'post' | 'redirect';
    xml: string;
    redirectSignature?: SAMLRedirectSignatureInput;
  }
): Promise<Response> {
  const log = getLogger(c).module('SAML-SP');
  let { logoutResponse } = input;
  let { relayState } = input;

  const tenantId = resolveSAMLTenantIdFromContext(c);

  // Get IdP configuration
  const idpConfig = await getIdPConfigByEntityId(env, tenantId, logoutResponse.issuer);
  if (!idpConfig) {
    log.warn('Unknown IdP LogoutResponse issuer', { issuer: logoutResponse.issuer });
    return createErrorResponse(c, AR_ERROR_CODES.SAML_INVALID_RESPONSE);
  }

  try {
    const certificates = Array.from(
      new Set([idpConfig.certificate, ...(idpConfig.certificates ?? [])].filter(Boolean))
    );
    if (input.binding === 'post') {
      if (!hasSignature(input.xml)) {
        throw new Error('Signed HTTP-POST LogoutResponse is required');
      }
      let lastError: unknown;
      let authenticatedResponse: ParsedLogoutResponse | undefined;
      for (const certificate of certificates) {
        try {
          const references = verifyXmlSignatureAndGetReferences(input.xml, {
            certificateOrKey: certificate,
            expectedId: logoutResponse.id,
            strictXswProtection: true,
            ...(idpConfig.logoutRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
            idpConfig.acceptedLogoutRequestSignatureAlgorithms?.includes(
              SIGNATURE_ALGORITHMS.RSA_SHA1
            )
              ? { allowSha1SignatureAlgorithm: true }
              : {}),
            ...(idpConfig.logoutRequestLegacyAlgorithmPolicy === 'explicit_opt_in' &&
            idpConfig.acceptedLogoutRequestDigestAlgorithms?.includes(DIGEST_ALGORITHMS.SHA1)
              ? { allowSha1DigestAlgorithm: true }
              : {}),
          });
          const signedResponse = references.find(
            (reference) => reference.uri === `#${logoutResponse.id}`
          );
          if (!signedResponse) {
            throw new Error('Signed LogoutResponse reference is missing');
          }
          authenticatedResponse = parseLogoutResponseXml(signedResponse.xml);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (
        !authenticatedResponse ||
        authenticatedResponse.id !== logoutResponse.id ||
        authenticatedResponse.issuer !== logoutResponse.issuer
      ) {
        throw lastError instanceof Error
          ? lastError
          : new Error('Signed LogoutResponse does not match the routed response');
      }
      logoutResponse = authenticatedResponse;
    } else if (input.binding === 'redirect') {
      const redirectSignature = input.redirectSignature;
      if (
        !redirectSignature?.samlMessage ||
        !redirectSignature.signature ||
        !redirectSignature.sigAlg
      ) {
        throw new Error('Signed HTTP-Redirect LogoutResponse is required');
      }
      const acceptedSignatureAlgorithms =
        idpConfig.logoutRequestLegacyAlgorithmPolicy === 'explicit_opt_in'
          ? (idpConfig.acceptedLogoutRequestSignatureAlgorithms ?? [
              SIGNATURE_ALGORITHMS.RSA_SHA256,
            ])
          : [SIGNATURE_ALGORITHMS.RSA_SHA256];
      let verified = false;
      let lastError: unknown;
      for (const certificate of certificates) {
        try {
          verified = await verifyRedirectBindingSignature(
            'SAMLResponse',
            redirectSignature.samlMessage,
            redirectSignature.relayState,
            redirectSignature.signature,
            redirectSignature.sigAlg,
            certificate,
            { acceptedSignatureAlgorithms }
          );
          if (verified) break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!verified) {
        throw lastError instanceof Error
          ? lastError
          : new Error('Invalid HTTP-Redirect LogoutResponse signature');
      }
    }
  } catch (error) {
    log.error('LogoutResponse signature verification failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  try {
    if (!env.STATE_STORE) {
      throw new SAMLLogoutResponseCorrelationError(
        'STATE_STORE is required for SP LogoutResponse correlation',
        {
          idp_entity_id: idpConfig.entityId,
        }
      );
    }
    const outboundLogoutRequest = await consumeSAMLOutboundLogoutRequest(env.STATE_STORE, {
      tenantId,
      spEntityId: idpConfig.entityId,
      inResponseTo: logoutResponse.inResponseTo,
    });
    if (relayState && relayState !== outboundLogoutRequest.requestId) {
      throw new SAMLLogoutResponseCorrelationError(
        'LogoutResponse RelayState does not match outbound LogoutRequest',
        {
          idp_entity_id: idpConfig.entityId,
          relay_state: relayState,
          request_id: outboundLogoutRequest.requestId,
        }
      );
    }
    relayState = outboundLogoutRequest.relayState ?? relayState;
  } catch (error) {
    if (error instanceof SAMLLogoutResponseCorrelationError) {
      log.warn('SP LogoutResponse correlation failed', {
        tenantId,
        idpEntityId: idpConfig.entityId,
        logoutResponseId: logoutResponse.id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    throw error;
  }

  // Check status
  if (logoutResponse.statusCode !== STATUS_CODES.SUCCESS) {
    log.warn('IdP returned logout error', {
      statusCode: logoutResponse.statusCode,
      statusMessage: logoutResponse.statusMessage,
    });
  }

  // Clear session cookie and redirect to logout complete
  let returnUrl = relayState;
  if (!returnUrl) {
    const logoutCompleteRedirect = await buildLogoutCompleteUrlForSP(c, env);
    if (logoutCompleteRedirect.type === 'error') {
      return logoutCompleteRedirect.response;
    }
    returnUrl = logoutCompleteRedirect.url;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: returnUrl,
      'Set-Cookie': 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

/**
 * Validate LogoutRequest from IdP
 */
function validateLogoutRequest(logoutRequest: ParsedLogoutRequest, issuerUrl: string): void {
  // Check request is not expired
  const issueInstantMs = Date.parse(logoutRequest.issueInstant);
  if (!Number.isFinite(issueInstantMs)) {
    throw new SAMLLogoutMessageValidationError();
  }
  const nowMs = Date.now();
  const skewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
  const maxAge = DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000;

  if (issueInstantMs > nowMs + skewMs) {
    throw new SAMLLogoutMessageValidationError();
  }

  if (nowMs - issueInstantMs > maxAge + skewMs) {
    throw new SAMLLogoutMessageValidationError();
  }

  if (logoutRequest.notOnOrAfter) {
    const notOnOrAfterMs = Date.parse(logoutRequest.notOnOrAfter);
    if (!Number.isFinite(notOnOrAfterMs) || nowMs >= notOnOrAfterMs + skewMs) {
      throw new SAMLLogoutMessageValidationError();
    }
  }

  // Validate Destination if present
  if (logoutRequest.destination) {
    const expectedDestination = `${issuerUrl}/saml/sp/slo`;
    if (logoutRequest.destination !== expectedDestination) {
      throw new SAMLLogoutMessageValidationError();
    }
  }
}

function parseSAMLLogoutMessage<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new SAMLLogoutMessageValidationError();
  }
}

function isSAMLLogoutMessageValidationError(error: unknown): boolean {
  return (
    error instanceof SAMLLogoutMessageValidationError ||
    error instanceof SAMLRelayStateTooLargeError
  );
}

/**
 * Terminate session by NameID (sharded)
 *
 * Note: With sharded SessionStore, we can only delete sessions if sessionIndex
 * (which should be the Authrim sessionId) is provided. User-based session deletion
 * would require a userId -> sessionIds index which is not implemented.
 */
async function terminateSessionByNameId(
  c: Context<{ Bindings: Env }>,
  env: Env,
  nameId: string,
  sessionIndex?: string
): Promise<void> {
  const log = getLogger(c).module('SAML-SP');

  try {
    // If sessionIndex is provided and is a valid sharded session ID, delete that specific session
    if (sessionIndex && isShardedSessionId(sessionIndex)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(
          env,
          sessionIndex,
          resolveSAMLTenantIdFromContext(c)
        );
        const response = await sessionStore.fetch(`https://session-store/session/${sessionIndex}`, {
          method: 'DELETE',
        });
        if (response.ok) {
          log.info('Terminated session', { sessionIndex });
          return;
        } else {
          log.debug('Session not found or already deleted', { sessionIndex });
        }
      } catch (error) {
        log.error('Failed to delete session', { sessionIndex }, error as Error);
      }
    } else if (sessionIndex) {
      log.warn('sessionIndex is not in sharded format, cannot delete', { sessionIndex });
    }

    // Without a valid sessionIndex, we cannot delete by userId in sharded SessionStore
    // Log warning for debugging
    // PII/Non-PII DB separation: search email in PII DB
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const user = await findActiveSamlUserByEmail(env, tenantId, nameId);
    if (user) {
      const authCtx = createAuthContextFromHono(c, tenantId);
      await recordHybridUserSessionRevocationEpoch(env, authCtx.coreAdapter, tenantId, user.id);
      log.info('Terminated all user sessions by revocation epoch', {});
    } else {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn('No user found for logout request', {});
    }
  } catch (error) {
    log.error('Error terminating session', {}, error as Error);
  }
}

/**
 * Send LogoutResponse to IdP
 */
async function sendLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  idpConfig: SAMLIdPConfig,
  options: {
    inResponseTo: string;
    statusCode: string;
    statusMessage?: string;
    relayState: string | null;
    binding: 'post' | 'redirect';
  },
  cookieHeader: string
): Promise<Response> {
  const { inResponseTo, statusCode, statusMessage, relayState } = options;

  const destination = idpConfig.sloUrl || idpConfig.ssoUrl;
  const responseId = generateSAMLId();
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const issuer = (await getSAMLLocalEntityIds(env, tenantId)).spEntityId;

  // Build LogoutResponse
  let responseXml = buildLogoutResponse({
    id: responseId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    inResponseTo,
    statusCode,
    statusMessage,
  });

  const log = getLogger(c).module('SAML-SP');

  // Sign the response
  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId,
      role: 'sp',
      counterpartyEntityId: idpConfig.entityId,
      policy: getSAMLSigningPolicy(idpConfig),
    });

    responseXml = signXml(responseXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${responseId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    log.error('Error signing LogoutResponse', {}, error as Error);
    // Continue without signature if signing fails
  }

  // Send via HTTP-POST binding (recommended for responses)
  return sendPostBindingResponse(destination, responseXml, relayState, cookieHeader);
}

/**
 * Send LogoutResponse via HTTP-POST binding
 */
function sendPostBindingResponse(
  destination: string,
  responseXml: string,
  relayState: string | null,
  cookieHeader: string
): Response {
  const encodedResponse = encodeForPostBinding(responseXml);
  const fields = [{ name: 'SAMLResponse', value: encodedResponse }];
  if (relayState) {
    assertSAMLRelayStateSize(relayState);
    fields.push({ name: 'RelayState', value: relayState });
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML Logout',
    actionUrl: destination,
    fields,
    buttonText: 'Continue',
    additionalHeaders: {
      'Set-Cookie': cookieHeader,
    },
  });
}

/**
 * Initiate SP-initiated logout (send LogoutRequest to IdP)
 */
export async function initiateSPLogout(
  env: Env,
  userId: string,
  idpConfig: SAMLIdPConfig,
  sessionIndex?: string,
  returnUrl?: string,
  tenantId?: string
): Promise<{ html: string }> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SP-initiated SLO tenant');
  // Get user info for NameID (PII/Non-PII DB separation)
  const nameId = await getSamlUserNameIdById(env, resolvedTenantId, userId);

  if (!nameId) {
    throw new Error('Logout request could not be processed');
  }
  const issuer = (await getSAMLLocalEntityIds(env, resolvedTenantId)).spEntityId;
  const destination = idpConfig.sloUrl || idpConfig.ssoUrl;
  const requestId = generateSAMLId();

  if (!env.STATE_STORE) {
    throw new Error('STATE_STORE is required for SP-initiated SLO correlation');
  }
  await storeSAMLOutboundLogoutRequest(env.STATE_STORE, {
    tenantId: resolvedTenantId,
    spEntityId: idpConfig.entityId,
    requestId,
    relayState: returnUrl,
    ttlSeconds: DEFAULTS.REQUEST_VALIDITY_SECONDS,
  });

  // Build LogoutRequest
  let logoutRequestXml = buildLogoutRequest({
    id: requestId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    nameId,
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    sessionIndex,
  });

  // Sign the request
  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId: resolvedTenantId,
      role: 'sp',
      counterpartyEntityId: idpConfig.entityId,
      policy: getSAMLSigningPolicy(idpConfig),
    });

    logoutRequestXml = signXml(logoutRequestXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${requestId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    const log = createLogger().module('SAML-SP-SLO');
    log.error('Error signing LogoutRequest', { action: 'sign_logout_request' }, error as Error);
  }

  // Encode for POST binding
  const encodedRequest = encodeForPostBinding(logoutRequestXml);
  const fields = [{ name: 'SAMLRequest', value: encodedRequest }];
  if (returnUrl) {
    fields.push({ name: 'RelayState', value: requestId });
  }

  const response = buildSAMLPostBindingResponse({
    title: 'SAML Logout',
    actionUrl: destination,
    fields,
    buttonText: 'Continue to Logout',
  });

  return { html: await response.text() };
}

/**
 * Build logout complete URL based on UI config (for SP)
 * Supports conformance mode (built-in redirect) and external UI
 */
type LogoutCompleteResultSP =
  | { type: 'redirect'; url: string }
  | { type: 'error'; response: Response };

async function buildLogoutCompleteUrlForSP(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<LogoutCompleteResultSP> {
  const tenantId = resolveSAMLTenantIdFromContext(c);

  // Conformance mode: use built-in path
  if (await shouldUseBuiltinForms(env)) {
    const issuerUrl = buildIssuerUrl(env, tenantId);
    return { type: 'redirect', url: `${issuerUrl}/logout-complete` };
  }

  // Normal mode: use UI config
  const uiConfig = await getUIConfig(env);
  if (!uiConfig?.baseUrl) {
    return { type: 'error', response: c.json(createConfigurationError(), 500) };
  }

  const url = buildUIUrl(
    uiConfig,
    'logoutComplete',
    {},
    usesNakedDomainIssuer(env, tenantId) ? undefined : tenantId
  );
  return { type: 'redirect', url };
}

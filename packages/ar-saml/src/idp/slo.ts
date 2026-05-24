/**
 * SAML IdP Single Logout (SLO) Endpoint
 *
 * Handles both:
 * 1. LogoutRequest from SP - Terminates IdP session and sends LogoutResponse
 * 2. LogoutResponse from SP - Confirms logout completion from SP-initiated flow
 *
 * Supports HTTP-POST and HTTP-Redirect bindings.
 *
 * POST /saml/idp/slo
 * GET  /saml/idp/slo
 */

import type { Context } from 'hono';
import type { Env, SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  usesNakedDomainIssuer,
  buildIssuerUrl,
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';
import {
  parseLogoutRequestXml,
  parseLogoutResponseXml,
  buildLogoutRequest,
  buildLogoutResponse,
  encodeForPostBinding,
  encodeForRedirectBindingQueryValue,
  type ParsedLogoutRequest,
  type ParsedLogoutResponse,
} from '../common/slo-messages';
import {
  decodePostBindingMessage,
  inflateRedirectBindingMessage,
  parsePostBindingFormDataWithLimit,
} from '../common/message-limits';
import { generateSAMLId, nowAsDateTime } from '../common/xml-utils';
import { STATUS_CODES, DEFAULTS, NAMEID_FORMATS } from '../common/constants';
import { signRedirectBinding, signXml } from '../common/signature';
import { getSAMLSigningMaterial, getSAMLSigningPolicy } from '../common/saml-signing-keys';
import { getSPConfig } from '../admin/providers';
import { findActiveSamlUserByEmail, getSamlUserNameIdById } from '../common/user-store';
import { requireSAMLTenantId, resolveSAMLTenantIdFromContext } from '../common/tenant';
import { resolveSAMLSessionIndexToSessionId } from './subject';
import {
  SAMLLogoutRequestSignatureValidationError,
  validateSAMLLogoutRequestSignature,
} from './logout-request-signature';
import {
  SAMLLogoutResponseSignatureValidationError,
  validateSAMLLogoutResponseSignature,
} from './logout-response-signature';
import { scheduleSAMLPolicyFailureAudit, type SAMLPolicyFailureKind } from './audit';
import { buildSAMLPostBindingResponse } from '../common/post-binding-form';
import type { SAMLRedirectSignatureInput } from './authn-request-signature';
import {
  createSAMLIdPLogoutFanoutTransaction,
  deleteSAMLOutboundLogoutRequest,
  getNextPendingSAMLIdPLogoutFanoutTarget,
  getSAMLIdPLogoutFanoutTransaction,
  getSAMLOutboundLogoutRequest,
  isSAMLIdPLogoutFanoutTransactionComplete,
  markSAMLIdPLogoutFanoutTargetCompleted,
  markSAMLIdPLogoutFanoutTargetSent,
  SAMLLogoutResponseCorrelationError,
  storeSAMLOutboundLogoutRequest,
  type SAMLIdPLogoutFanoutTransactionRecord,
  type SAMLOutboundLogoutRequestRecord,
} from './slo-state';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import { assertSAMLRelayStateSize } from '../common/relay-state';

interface ParsedLogoutRequestInput {
  logoutRequest: ParsedLogoutRequest;
  relayState: string | null;
  binding: 'post' | 'redirect';
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

interface ParsedLogoutResponseInput {
  logoutResponse: ParsedLogoutResponse;
  relayState: string | null;
  binding: 'post' | 'redirect';
  xml: string;
  redirectSignature?: SAMLRedirectSignatureInput;
}

export interface IdPLogoutBindingResponseOptions {
  sessionIndex?: string;
  tenantId?: string;
  relayState?: string;
  binding?: 'post' | 'redirect';
}

export interface IdPMultiSPLogoutBindingResponseOptions extends IdPLogoutBindingResponseOptions {
  transactionId?: string;
}

interface BuiltIdPLogoutRequest {
  logoutRequestId: string;
  logoutRequestXml: string;
  destination: string;
  tenantId: string;
}

/**
 * Handle Single Logout request/response (POST binding)
 */
export async function handleIdPSLO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const method = c.req.method;
  const log = getLogger(c).module('SAML-IDP');
  const { issuerUrl } = await getSAMLLocalEntityIds(env, resolveSAMLTenantIdFromContext(c));

  try {
    if (method === 'GET') {
      return handleRedirectBinding(c, env, issuerUrl);
    } else {
      return handlePostBinding(c, env, issuerUrl);
    }
  } catch (error) {
    log.error('IdP SLO Error', { method }, error as Error);
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
    const xml = decodePostBindingMessage(samlRequest, 'SAML LogoutRequest');
    return processLogoutRequest(c, env, issuerUrl, {
      logoutRequest: parseLogoutRequestXml(xml),
      relayState,
      binding: 'post',
      xml,
    });
  } else if (samlResponse) {
    const xml = decodePostBindingMessage(samlResponse, 'SAML LogoutResponse');
    return processLogoutResponse(c, env, issuerUrl, {
      logoutResponse: parseLogoutResponseXml(xml),
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
    const xml = inflateRedirectBindingMessage(samlRequest, 'SAML LogoutRequest');
    return processLogoutRequest(c, env, issuerUrl, {
      logoutRequest: parseLogoutRequestXml(xml),
      relayState,
      binding: 'redirect',
      xml,
      redirectSignature: {
        samlMessage: getRawQueryParam(url.search, 'SAMLRequest') ?? encodeURIComponent(samlRequest),
        relayState: getRawQueryParam(url.search, 'RelayState'),
        signature: url.searchParams.get('Signature') || undefined,
        sigAlg: url.searchParams.get('SigAlg') || undefined,
      },
    });
  } else if (samlResponse) {
    const xml = inflateRedirectBindingMessage(samlResponse, 'SAML LogoutResponse');
    return processLogoutResponse(c, env, issuerUrl, {
      logoutResponse: parseLogoutResponseXml(xml),
      relayState,
      binding: 'redirect',
      xml,
      redirectSignature: {
        samlMessage:
          getRawQueryParam(url.search, 'SAMLResponse') ?? encodeURIComponent(samlResponse),
        relayState: getRawQueryParam(url.search, 'RelayState'),
        signature: url.searchParams.get('Signature') || undefined,
        sigAlg: url.searchParams.get('SigAlg') || undefined,
      },
    });
  } else {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'SAMLRequest or SAMLResponse' },
    });
  }
}

/**
 * Process LogoutRequest from SP
 */
async function processLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  input: ParsedLogoutRequestInput
): Promise<Response> {
  const log = getLogger(c).module('SAML-IDP');
  const { logoutRequest, relayState, binding } = input;
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const { idpEntityId } = await getSAMLLocalEntityIds(env, tenantId);

  // Validate LogoutRequest
  validateLogoutRequest(logoutRequest, issuerUrl);

  // Get SP configuration
  const spConfig = await getSPConfig(env, tenantId, logoutRequest.issuer);
  if (!spConfig) {
    return sendLogoutResponse(c, env, issuerUrl, {
      inResponseTo: logoutRequest.id,
      destination: '', // Unknown SP
      statusCode: STATUS_CODES.REQUEST_DENIED,
      statusMessage: 'Unknown Service Provider',
      relayState,
      binding,
      counterpartyEntityId: logoutRequest.issuer,
    });
  }

  try {
    await validateSAMLLogoutRequestSignature({
      logoutRequest,
      spConfig,
      binding: input.binding,
      xml: input.xml,
      redirectSignature: input.redirectSignature,
    });
  } catch (error) {
    if (error instanceof SAMLLogoutRequestSignatureValidationError) {
      log.warn('SAML LogoutRequest signature policy failed', {
        tenantId: resolveSAMLTenantIdFromContext(c),
        spEntityId: spConfig.entityId,
        logoutRequestId: logoutRequest.id,
        failureKind: error.failureKind,
      });
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId: resolveSAMLTenantIdFromContext(c),
        spEntityId: spConfig.entityId,
        authnRequestId: logoutRequest.id,
        failureKind: error.failureKind,
        policyDetails: error.details,
      });

      return sendLogoutResponse(c, env, issuerUrl, {
        inResponseTo: logoutRequest.id,
        destination: resolveLogoutResponseDestination(spConfig),
        statusCode: STATUS_CODES.REQUESTER,
        statusMessage: 'SAML logout request was rejected by IdP policy',
        relayState,
        binding,
        counterpartyEntityId: spConfig.entityId,
      });
    }

    throw error;
  }

  const nameIdQualifierPolicyFailure = validateLogoutRequestNameIDQualifiers(
    logoutRequest,
    spConfig,
    idpEntityId
  );
  if (nameIdQualifierPolicyFailure) {
    log.warn('SAML LogoutRequest NameID qualifier policy failed', {
      tenantId: resolveSAMLTenantIdFromContext(c),
      spEntityId: spConfig.entityId,
      logoutRequestId: logoutRequest.id,
      failureKind: nameIdQualifierPolicyFailure.failureKind,
    });
    scheduleSAMLPolicyFailureAudit(c, {
      tenantId: resolveSAMLTenantIdFromContext(c),
      spEntityId: spConfig.entityId,
      authnRequestId: logoutRequest.id,
      failureKind: nameIdQualifierPolicyFailure.failureKind,
      policyDetails: nameIdQualifierPolicyFailure.policyDetails,
    });

    return sendLogoutResponse(c, env, issuerUrl, {
      inResponseTo: logoutRequest.id,
      destination: resolveLogoutResponseDestination(spConfig),
      statusCode: STATUS_CODES.REQUESTER,
      statusMessage: nameIdQualifierPolicyFailure.statusMessage,
      relayState,
      binding,
      counterpartyEntityId: spConfig.entityId,
    });
  }

  const logoutRequestPolicyFailure = validateLogoutRequestSessionPolicy(logoutRequest, spConfig);
  if (logoutRequestPolicyFailure) {
    log.warn('SAML LogoutRequest session policy failed', {
      tenantId: resolveSAMLTenantIdFromContext(c),
      spEntityId: spConfig.entityId,
      logoutRequestId: logoutRequest.id,
      failureKind: logoutRequestPolicyFailure.failureKind,
    });
    scheduleSAMLPolicyFailureAudit(c, {
      tenantId: resolveSAMLTenantIdFromContext(c),
      spEntityId: spConfig.entityId,
      authnRequestId: logoutRequest.id,
      failureKind: logoutRequestPolicyFailure.failureKind,
      policyDetails: logoutRequestPolicyFailure.policyDetails,
    });

    return sendLogoutResponse(c, env, issuerUrl, {
      inResponseTo: logoutRequest.id,
      destination: resolveLogoutResponseDestination(spConfig),
      statusCode: STATUS_CODES.REQUESTER,
      statusMessage: logoutRequestPolicyFailure.statusMessage,
      relayState,
      binding,
      counterpartyEntityId: spConfig.entityId,
    });
  }

  // Find and terminate session by NameID
  const sessionTerminated = await terminateSessionByNameId(
    c,
    env,
    logoutRequest.issuer,
    logoutRequest.nameId,
    logoutRequest.sessionIndices ?? (logoutRequest.sessionIndex ? [logoutRequest.sessionIndex] : [])
  );

  if (!sessionTerminated) {
    // PII Protection: Do not log NameID (may contain email/PII)
    log.warn('No session found for logout request', {});
    // Still return success - session may have already been terminated
  }

  // Clear IdP session cookie
  const cookieHeader = 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  // Build and send LogoutResponse
  return sendLogoutResponse(
    c,
    env,
    issuerUrl,
    {
      inResponseTo: logoutRequest.id,
      destination: resolveLogoutResponseDestination(spConfig),
      statusCode: STATUS_CODES.SUCCESS,
      relayState,
      binding,
      counterpartyEntityId: spConfig.entityId,
    },
    cookieHeader
  );
}

/**
 * Process LogoutResponse from SP (for IdP-initiated SLO)
 */
async function processLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  input: ParsedLogoutResponseInput
): Promise<Response> {
  const log = getLogger(c).module('SAML-IDP');
  const { logoutResponse, relayState } = input;
  const tenantId = resolveSAMLTenantIdFromContext(c);
  let outboundLogoutRequest: SAMLOutboundLogoutRequestRecord | undefined;

  const spConfig = await getSPConfig(env, tenantId, logoutResponse.issuer);
  if (!spConfig) {
    throw new Error('Unknown Service Provider in LogoutResponse');
  }

  try {
    validateLogoutResponseDestination(logoutResponse, issuerUrl);
    outboundLogoutRequest = await getSAMLOutboundLogoutRequest(env.STATE_STORE, {
      tenantId,
      spEntityId: spConfig.entityId,
      inResponseTo: logoutResponse.inResponseTo,
    });
    await validateSAMLLogoutResponseSignature({
      logoutResponse,
      spConfig,
      binding: input.binding,
      xml: input.xml,
      redirectSignature: input.redirectSignature,
    });
    await deleteSAMLOutboundLogoutRequest(env.STATE_STORE, {
      tenantId,
      requestId: outboundLogoutRequest.requestId,
    });
  } catch (error) {
    if (error instanceof SAMLLogoutResponseCorrelationError) {
      const failureKind =
        'destination' in error.details
          ? 'logout_response_invalid_destination'
          : 'logout_response_invalid_in_response_to';
      log.warn('SAML LogoutResponse correlation failed', {
        tenantId,
        spEntityId: spConfig.entityId,
        logoutResponseId: logoutResponse.id,
        failureKind,
        details: error.details,
      });
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: logoutResponse.inResponseTo || logoutResponse.id,
        failureKind,
        policyDetails: error.details,
      });
      throw error;
    }

    if (error instanceof SAMLLogoutResponseSignatureValidationError) {
      log.warn('SAML LogoutResponse signature policy failed', {
        tenantId,
        spEntityId: spConfig.entityId,
        logoutResponseId: logoutResponse.id,
        failureKind: error.failureKind,
      });
      scheduleSAMLPolicyFailureAudit(c, {
        tenantId,
        spEntityId: spConfig.entityId,
        authnRequestId: logoutResponse.inResponseTo || logoutResponse.id,
        failureKind: error.failureKind,
        policyDetails: error.details,
      });
      throw error;
    }

    throw error;
  }

  // Validate LogoutResponse
  if (logoutResponse.statusCode !== STATUS_CODES.SUCCESS) {
    log.warn('SP returned logout error', {
      tenantId,
      spEntityId: spConfig.entityId,
      logoutResponseId: logoutResponse.id,
      statusCode: logoutResponse.statusCode,
      statusMessage: logoutResponse.statusMessage,
    });
    scheduleSAMLPolicyFailureAudit(c, {
      tenantId,
      spEntityId: spConfig.entityId,
      authnRequestId: logoutResponse.inResponseTo || logoutResponse.id,
      failureKind: 'logout_response_non_success_status',
      policyDetails: {
        logout_response_id: logoutResponse.id,
        status_code: logoutResponse.statusCode,
        status_message: logoutResponse.statusMessage,
      },
    });
  }

  if (outboundLogoutRequest?.transactionId) {
    await markSAMLIdPLogoutFanoutTargetCompleted(env.STATE_STORE, {
      tenantId,
      transactionId: outboundLogoutRequest.transactionId,
      spEntityId: spConfig.entityId,
      status: logoutResponse.statusCode === STATUS_CODES.SUCCESS ? 'succeeded' : 'failed',
      statusCode: logoutResponse.statusCode,
      statusMessage: logoutResponse.statusMessage,
    });

    const nextResponse = await sendNextIdPMultiSPLogoutRequest(c, env, {
      tenantId,
      transactionId: outboundLogoutRequest.transactionId,
      relayState: relayState ?? undefined,
    });
    if (nextResponse) {
      return nextResponse;
    }
  }

  // Redirect to logout complete page
  const logoutCompleteRedirect = await buildLogoutCompleteUrl(c, env, relayState);
  if (logoutCompleteRedirect.type === 'error') {
    return logoutCompleteRedirect.response;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: logoutCompleteRedirect.url,
      'Set-Cookie': 'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

function validateLogoutResponseDestination(
  logoutResponse: ParsedLogoutResponse,
  issuerUrl: string
): void {
  if (!logoutResponse.destination) {
    return;
  }

  const expectedDestination = `${issuerUrl}/saml/idp/slo`;
  if (logoutResponse.destination !== expectedDestination) {
    throw new SAMLLogoutResponseCorrelationError('Invalid Destination in SAML LogoutResponse', {
      destination: logoutResponse.destination,
      expected_destination: expectedDestination,
    });
  }
}

/**
 * Validate LogoutRequest
 */
function validateLogoutRequest(logoutRequest: ParsedLogoutRequest, issuerUrl: string): void {
  // Check request is not expired
  const issueInstant = new Date(logoutRequest.issueInstant);
  const now = new Date();
  const skewMs = DEFAULTS.CLOCK_SKEW_SECONDS * 1000;
  const maxAge = DEFAULTS.REQUEST_VALIDITY_SECONDS * 1000;

  if (issueInstant.getTime() > now.getTime() + skewMs) {
    throw new Error('LogoutRequest IssueInstant is in the future');
  }

  if (now.getTime() - issueInstant.getTime() > maxAge + skewMs) {
    throw new Error('LogoutRequest has expired');
  }

  // Check NotOnOrAfter if present
  if (logoutRequest.notOnOrAfter) {
    const notOnOrAfter = new Date(logoutRequest.notOnOrAfter);
    if (now.getTime() > notOnOrAfter.getTime() + skewMs) {
      throw new Error('LogoutRequest has expired (NotOnOrAfter)');
    }
  }

  // Validate Destination if present
  if (logoutRequest.destination) {
    const expectedDestination = `${issuerUrl}/saml/idp/slo`;
    if (logoutRequest.destination !== expectedDestination) {
      // SECURITY: Do not expose endpoint URLs in error message
      throw new Error('Invalid Destination in SAML LogoutRequest');
    }
  }
}

function validateLogoutRequestSessionPolicy(
  logoutRequest: ParsedLogoutRequest,
  spConfig: SAMLSPConfig
): {
  failureKind: SAMLPolicyFailureKind;
  statusMessage: string;
  policyDetails: Record<string, unknown>;
} | null {
  const nameIdFormat = logoutRequest.nameIdFormat || NAMEID_FORMATS.UNSPECIFIED;
  if (!isSupportedLogoutRequestNameIDFormat(nameIdFormat)) {
    return {
      failureKind: 'logout_request_invalid_nameid_format',
      statusMessage: 'SAML logout request NameID format is not supported',
      policyDetails: {
        requested_nameid_format: nameIdFormat,
        supported_nameid_formats: SUPPORTED_LOGOUT_REQUEST_NAMEID_FORMATS,
      },
    };
  }

  const hasSessionIndex =
    (logoutRequest.sessionIndices?.length ?? 0) > 0 || Boolean(logoutRequest.sessionIndex);
  if (hasSessionIndex || spConfig.samlProfile === 'legacy') {
    return null;
  }

  const allowsEmailFallback =
    nameIdFormat === NAMEID_FORMATS.EMAIL || nameIdFormat === NAMEID_FORMATS.UNSPECIFIED;
  if (allowsEmailFallback) {
    return null;
  }

  return {
    failureKind: 'logout_request_session_index_required',
    statusMessage: 'SAML logout request requires SessionIndex for this NameID format',
    policyDetails: {
      requested_nameid_format: nameIdFormat,
      session_index_required: true,
    },
  };
}

export function validateLogoutRequestNameIDQualifiers(
  logoutRequest: ParsedLogoutRequest,
  spConfig: SAMLSPConfig,
  idpEntityId: string
): {
  failureKind: SAMLPolicyFailureKind;
  statusMessage: string;
  policyDetails: Record<string, unknown>;
} | null {
  if (logoutRequest.nameIdNameQualifier && logoutRequest.nameIdNameQualifier !== idpEntityId) {
    return {
      failureKind: 'logout_request_invalid_nameid_qualifier',
      statusMessage: 'SAML logout request NameID qualifier is not supported',
      policyDetails: {
        qualifier: 'NameQualifier',
        requested_name_qualifier: logoutRequest.nameIdNameQualifier,
        expected_name_qualifier: idpEntityId,
      },
    };
  }

  if (
    logoutRequest.nameIdSPNameQualifier &&
    logoutRequest.nameIdSPNameQualifier !== spConfig.entityId
  ) {
    return {
      failureKind: 'logout_request_invalid_nameid_qualifier',
      statusMessage: 'SAML logout request SPNameQualifier is not supported',
      policyDetails: {
        qualifier: 'SPNameQualifier',
        requested_sp_name_qualifier: logoutRequest.nameIdSPNameQualifier,
        expected_sp_name_qualifier: spConfig.entityId,
      },
    };
  }

  return null;
}

const SUPPORTED_LOGOUT_REQUEST_NAMEID_FORMATS = [
  NAMEID_FORMATS.EMAIL,
  NAMEID_FORMATS.PERSISTENT,
  NAMEID_FORMATS.TRANSIENT,
  NAMEID_FORMATS.UNSPECIFIED,
];

function isSupportedLogoutRequestNameIDFormat(format: string): boolean {
  return SUPPORTED_LOGOUT_REQUEST_NAMEID_FORMATS.includes(
    format as (typeof SUPPORTED_LOGOUT_REQUEST_NAMEID_FORMATS)[number]
  );
}

/**
 * Terminate session by NameID (sharded)
 *
 * Note: Authrim emits opaque SAML SessionIndex values and resolves them through
 * STATE_STORE. Legacy direct Authrim session IDs are still accepted for
 * compatibility with earlier builds.
 */
async function terminateSessionByNameId(
  c: Context<{ Bindings: Env }>,
  env: Env,
  spEntityId: string,
  nameId: string,
  sessionIndices: string[] = []
): Promise<boolean> {
  const log = getLogger(c).module('SAML-IDP');

  try {
    const tenantId = resolveSAMLTenantIdFromContext(c);
    let terminatedCount = 0;

    for (const sessionIndex of Array.from(new Set(sessionIndices.filter(Boolean)))) {
      const resolvedSessionId = sessionIndex.startsWith('sidx_')
        ? await resolveSAMLSessionIndexToSessionId(env.STATE_STORE, {
            tenantId,
            spEntityId,
            sessionIndex,
          })
        : sessionIndex;

      if (!resolvedSessionId || !isShardedSessionId(resolvedSessionId)) {
        log.warn('sessionIndex could not be resolved to a sharded session', { sessionIndex });
        continue;
      }

      const terminated = await deleteAuthrimSessionById(c, env, tenantId, {
        sessionId: resolvedSessionId,
        sessionIndex,
      });
      if (terminated) {
        terminatedCount++;
      }
    }

    if (terminatedCount > 0) {
      log.info('Terminated sessions from SAML LogoutRequest', {
        requestedSessionIndexCount: sessionIndices.length,
        terminatedCount,
      });
      return true;
    }

    // Without a valid sessionIndex, we cannot delete by userId in sharded SessionStore
    // Log warning for debugging
    // PII/Non-PII DB separation: search email in PII DB
    const user = await findActiveSamlUserByEmail(env, tenantId, nameId);
    if (user) {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn(
        'Cannot delete all sessions for user (sharded SessionStore requires sessionIndex). Ensure the SP includes sessionIndex in LogoutRequest.',
        {}
      );
      // Return true to indicate the logout request was processed (even if we couldn't delete all sessions)
      // The session cookie will still be cleared by the caller
      return true;
    } else {
      // PII Protection: Do not log NameID (may contain email/PII)
      log.warn('No user found for logout request', {});
      return false;
    }
  } catch (error) {
    log.error('Error terminating session', {}, error as Error);
    return false;
  }
}

async function deleteAuthrimSessionById(
  c: Context<{ Bindings: Env }>,
  env: Env,
  tenantId: string,
  options: {
    sessionId: string;
    sessionIndex: string;
  }
): Promise<boolean> {
  const log = getLogger(c).module('SAML-IDP');

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(env, options.sessionId, tenantId);
    const response = await sessionStore.fetch(
      `https://session-store/session/${options.sessionId}`,
      {
        method: 'DELETE',
      }
    );
    if (response.ok) {
      log.info('Terminated session', { sessionIndex: options.sessionIndex });
      return true;
    }

    log.debug('Session not found or already deleted', { sessionIndex: options.sessionIndex });
    return false;
  } catch (error) {
    log.error('Failed to delete session', { sessionIndex: options.sessionIndex }, error as Error);
    return false;
  }
}

/**
 * Send LogoutResponse to SP
 */
async function sendLogoutResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  issuerUrl: string,
  options: {
    inResponseTo: string;
    destination: string;
    statusCode: string;
    statusMessage?: string;
    relayState: string | null;
    binding: 'post' | 'redirect';
    counterpartyEntityId?: string;
  },
  cookieHeader?: string
): Promise<Response> {
  const { inResponseTo, destination, statusCode, statusMessage, relayState, binding } = options;

  // If no destination, redirect to logout complete page
  if (!destination) {
    const logoutCompleteRedirect = await buildLogoutCompleteUrl(c, env, relayState);
    if (logoutCompleteRedirect.type === 'error') {
      return logoutCompleteRedirect.response;
    }

    const headers: Record<string, string> = {
      Location: logoutCompleteRedirect.url,
    };
    if (cookieHeader) {
      headers['Set-Cookie'] = cookieHeader;
    }

    return new Response(null, {
      status: 302,
      headers,
    });
  }

  // Build LogoutResponse
  const responseId = generateSAMLId();
  const tenantId = resolveSAMLTenantIdFromContext(c);
  const issuer = (await getSAMLLocalEntityIds(env, tenantId)).idpEntityId;

  let responseXml = buildLogoutResponse({
    id: responseId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    inResponseTo,
    statusCode,
    statusMessage,
  });

  const log = getLogger(c).module('SAML-IDP');
  const spConfig = options.counterpartyEntityId
    ? await getSPConfig(env, tenantId, options.counterpartyEntityId)
    : null;
  const responseBinding = resolveLogoutResponseBinding(binding, spConfig ?? undefined);

  // Sign the response. POST uses XML Signature; Redirect uses binding-level signature.
  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId,
      role: 'idp',
      counterpartyEntityId: options.counterpartyEntityId,
      policy: getSAMLSigningPolicy(spConfig ?? undefined),
    });

    if (responseBinding === 'redirect') {
      return await sendRedirectBindingResponse(
        destination,
        responseXml,
        relayState,
        privateKeyPem,
        cookieHeader
      );
    }

    responseXml = signXml(responseXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${responseId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    log.error('Error signing LogoutResponse', { binding: responseBinding }, error as Error);
    throw error;
  }

  return sendPostBindingResponse(destination, responseXml, relayState, cookieHeader);
}

function resolveLogoutResponseDestination(spConfig: SAMLSPConfig): string {
  return spConfig.sloResponseUrl || spConfig.sloUrl || spConfig.acsUrl;
}

function resolveLogoutResponseBinding(
  inboundBinding: 'post' | 'redirect',
  spConfig?: SAMLSPConfig
): 'post' | 'redirect' {
  const configured = spConfig?.logoutResponseBinding ?? 'auto';
  if (configured === 'post' || configured === 'redirect') {
    return configured;
  }

  return inboundBinding;
}

/**
 * Send LogoutResponse via HTTP-POST binding
 */
function sendPostBindingResponse(
  destination: string,
  responseXml: string,
  relayState: string | null,
  cookieHeader?: string
): Response {
  const encodedResponse = encodeForPostBinding(responseXml);
  const fields = [{ name: 'SAMLResponse', value: encodedResponse }];
  if (relayState) {
    assertSAMLRelayStateSize(relayState);
    fields.push({ name: 'RelayState', value: relayState });
  }

  const additionalHeaders: Record<string, string> = {};
  if (cookieHeader) {
    additionalHeaders['Set-Cookie'] = cookieHeader;
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML Logout',
    actionUrl: destination,
    fields,
    buttonText: 'Continue',
    additionalHeaders,
  });
}

/**
 * Send LogoutRequest via HTTP-POST binding
 */
function sendPostBindingRequest(
  destination: string,
  requestXml: string,
  relayState: string | null
): Response {
  const encodedRequest = encodeForPostBinding(requestXml);
  const fields = [{ name: 'SAMLRequest', value: encodedRequest }];
  if (relayState) {
    assertSAMLRelayStateSize(relayState);
    fields.push({ name: 'RelayState', value: relayState });
  }

  return buildSAMLPostBindingResponse({
    title: 'SAML Logout',
    actionUrl: destination,
    fields,
    buttonText: 'Continue',
  });
}

/**
 * Send LogoutResponse via HTTP-Redirect binding
 */
async function sendRedirectBindingResponse(
  destination: string,
  responseXml: string,
  relayState: string | null,
  privateKeyPem: string,
  cookieHeader?: string
): Promise<Response> {
  assertSAMLRelayStateSize(relayState);
  const encodedResponse = encodeForRedirectBindingQueryValue(responseXml);
  const signed = await signRedirectBinding(
    'SAMLResponse',
    encodedResponse,
    relayState ?? undefined,
    privateKeyPem
  );

  const headers: Record<string, string> = {
    Location: appendQueryString(destination, signed.signedUrl),
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };

  if (cookieHeader) {
    headers['Set-Cookie'] = cookieHeader;
  }

  return new Response(null, { status: 302, headers });
}

/**
 * Send LogoutRequest via HTTP-Redirect binding
 */
async function sendRedirectBindingRequest(
  destination: string,
  requestXml: string,
  relayState: string | null,
  privateKeyPem: string
): Promise<Response> {
  assertSAMLRelayStateSize(relayState);
  const encodedRequest = encodeForRedirectBindingQueryValue(requestXml);
  const signed = await signRedirectBinding(
    'SAMLRequest',
    encodedRequest,
    relayState ?? undefined,
    privateKeyPem
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: appendQueryString(destination, signed.signedUrl),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

function appendQueryString(destination: string, query: string): string {
  const hashIndex = destination.indexOf('#');
  const base = hashIndex >= 0 ? destination.slice(0, hashIndex) : destination;
  const hash = hashIndex >= 0 ? destination.slice(hashIndex) : '';
  const separator = base.includes('?')
    ? base.endsWith('?') || base.endsWith('&')
      ? ''
      : '&'
    : '?';
  return `${base}${separator}${query}${hash}`;
}

/**
 * Build logout complete URL based on UI config
 * Supports conformance mode (built-in redirect) and external UI
 */
type LogoutCompleteResult =
  | { type: 'redirect'; url: string }
  | { type: 'error'; response: Response };

async function buildLogoutCompleteUrl(
  c: Context<{ Bindings: Env }>,
  env: Env,
  relayState?: string | null
): Promise<LogoutCompleteResult> {
  const tenantId = resolveSAMLTenantIdFromContext(c);

  // Conformance mode: use built-in path
  if (await shouldUseBuiltinForms(env)) {
    const issuerUrl = buildIssuerUrl(env, tenantId);
    const url = new URL('/logout-complete', issuerUrl);
    if (relayState) {
      url.searchParams.set('relay_state', relayState);
    }
    return { type: 'redirect', url: url.toString() };
  }

  // Normal mode: use UI config
  const uiConfig = await getUIConfig(env);
  if (!uiConfig?.baseUrl) {
    return { type: 'error', response: c.json(createConfigurationError(), 500) };
  }

  const queryParams: Record<string, string> = {};
  if (relayState) {
    queryParams.relay_state = relayState;
  }
  const url = buildUIUrl(
    uiConfig,
    'logoutComplete',
    queryParams,
    usesNakedDomainIssuer(env, tenantId) ? undefined : tenantId
  );
  return { type: 'redirect', url };
}

/**
 * Initiate IdP-initiated SLO (send LogoutRequest to SP)
 */
export async function initiateIdPLogout(
  env: Env,
  userId: string,
  spConfig: SAMLSPConfig,
  sessionIndex?: string,
  tenantId?: string
): Promise<{ logoutRequestXml: string; destination: string }> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'IdP-initiated SLO tenant');
  const built = await buildIdPLogoutRequest(env, userId, spConfig, sessionIndex, resolvedTenantId);
  let logoutRequestXml = built.logoutRequestXml;

  // Sign the request as XML. This is the historical core API behavior.
  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId: built.tenantId,
      role: 'idp',
      counterpartyEntityId: spConfig.entityId,
      policy: getSAMLSigningPolicy(spConfig),
    });

    logoutRequestXml = signXml(logoutRequestXml, {
      privateKey: privateKeyPem,
      certificate,
      referenceUri: `#${built.logoutRequestId}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  } catch (error) {
    const log = createLogger().module('SAML-IDP-SLO');
    log.error('Error signing LogoutRequest', { action: 'sign_logout_request' }, error as Error);
    throw error;
  }

  await storeIdPLogoutRequestState(env, built, spConfig);

  return { logoutRequestXml, destination: built.destination };
}

/**
 * Initiate IdP-initiated SLO and return a binding-specific HTTP response.
 */
export async function initiateIdPLogoutBindingResponse(
  env: Env,
  userId: string,
  spConfig: SAMLSPConfig,
  options: IdPLogoutBindingResponseOptions = {}
): Promise<Response> {
  const tenantId = requireSAMLTenantId(options.tenantId, 'IdP-initiated SLO tenant');
  const binding = options.binding ?? resolveIdPInitiatedLogoutBinding(spConfig);
  const built = await buildIdPLogoutRequest(env, userId, spConfig, options.sessionIndex, tenantId);

  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId: built.tenantId,
      role: 'idp',
      counterpartyEntityId: spConfig.entityId,
      policy: getSAMLSigningPolicy(spConfig),
    });

    let response: Response;
    if (binding === 'redirect') {
      response = await sendRedirectBindingRequest(
        built.destination,
        built.logoutRequestXml,
        options.relayState ?? null,
        privateKeyPem
      );
    } else {
      const signedXml = signXml(built.logoutRequestXml, {
        privateKey: privateKeyPem,
        certificate,
        referenceUri: `#${built.logoutRequestId}`,
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });
      response = sendPostBindingRequest(built.destination, signedXml, options.relayState ?? null);
    }

    await storeIdPLogoutRequestState(env, built, spConfig);
    return response;
  } catch (error) {
    const log = createLogger().module('SAML-IDP-SLO');
    log.error('Error sending LogoutRequest', { binding }, error as Error);
    throw error;
  }
}

/**
 * Initiate IdP-initiated SLO for multiple SPs.
 *
 * This is a browser-sequential fanout starter. It stores a tenant-scoped
 * transaction, sends the first LogoutRequest, and processLogoutResponse
 * advances the transaction to the next pending SP.
 */
export async function initiateIdPMultiSPLogoutBindingResponse(
  env: Env,
  userId: string,
  spConfigs: SAMLSPConfig[],
  options: IdPMultiSPLogoutBindingResponseOptions = {}
): Promise<{ transactionId: string; response: Response }> {
  const tenantId = requireSAMLTenantId(options.tenantId, 'IdP-initiated multi-SP SLO tenant');
  const targets = deduplicateLogoutTargets(spConfigs);
  if (targets.length === 0) {
    throw new Error('IdP-initiated multi-SP SLO requires at least one SP target');
  }

  const transaction = await createSAMLIdPLogoutFanoutTransaction(env.STATE_STORE, {
    tenantId,
    userId,
    sessionIndex: options.sessionIndex,
    relayState: options.relayState,
    transactionId: options.transactionId,
    targets: targets.map((spConfig) => spConfig.entityId),
    ttlSeconds: DEFAULTS.REQUEST_VALIDITY_SECONDS,
  });

  const response = await sendIdPLogoutRequestForTransactionTarget(env, {
    tenantId,
    transaction,
    spConfig: targets[0],
    binding: options.binding ?? resolveIdPInitiatedLogoutBinding(targets[0]),
    relayState: options.relayState,
  });

  return { transactionId: transaction.transactionId, response };
}

export function resolveIdPInitiatedLogoutBinding(spConfig: SAMLSPConfig): 'post' | 'redirect' {
  if (spConfig.sloBinding === 'post' || spConfig.sloBinding === 'redirect') {
    return spConfig.sloBinding;
  }

  return spConfig.samlProfile === 'legacy' ? 'post' : 'redirect';
}

async function buildIdPLogoutRequest(
  env: Env,
  userId: string,
  spConfig: SAMLSPConfig,
  sessionIndex: string | undefined,
  tenantId: string
): Promise<BuiltIdPLogoutRequest> {
  // Get user info for NameID (PII/Non-PII DB separation)
  const nameId = await getSamlUserNameIdById(env, tenantId, userId);

  if (!nameId) {
    throw new Error('Logout request could not be processed');
  }
  const issuer = (await getSAMLLocalEntityIds(env, tenantId)).idpEntityId;
  const destination = spConfig.sloUrl || spConfig.acsUrl;

  const logoutRequestId = generateSAMLId();
  const logoutRequestXml = buildLogoutRequest({
    id: logoutRequestId,
    issueInstant: nowAsDateTime(),
    issuer,
    destination,
    nameId,
    nameIdFormat: spConfig.nameIdFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    sessionIndex,
  });

  return { logoutRequestId, logoutRequestXml, destination, tenantId };
}

async function sendNextIdPMultiSPLogoutRequest(
  c: Context<{ Bindings: Env }>,
  env: Env,
  options: {
    tenantId: string;
    transactionId: string;
    relayState?: string;
  }
): Promise<Response | null> {
  const log = getLogger(c).module('SAML-IDP');

  while (true) {
    const transaction = await getSAMLIdPLogoutFanoutTransaction(env.STATE_STORE, {
      tenantId: options.tenantId,
      transactionId: options.transactionId,
    });
    if (!transaction || isSAMLIdPLogoutFanoutTransactionComplete(transaction)) {
      return null;
    }

    const nextTarget = getNextPendingSAMLIdPLogoutFanoutTarget(transaction);
    if (!nextTarget) {
      return null;
    }

    const spConfig = await getSPConfig(env, options.tenantId, nextTarget.spEntityId);
    if (!spConfig) {
      log.warn('Skipping missing SP during IdP-initiated multi-SP SLO', {
        transactionId: options.transactionId,
        spEntityId: nextTarget.spEntityId,
      });
      await markSAMLIdPLogoutFanoutTargetCompleted(env.STATE_STORE, {
        tenantId: options.tenantId,
        transactionId: options.transactionId,
        spEntityId: nextTarget.spEntityId,
        status: 'failed',
        failureReason: 'sp_config_missing',
      });
      continue;
    }

    return sendIdPLogoutRequestForTransactionTarget(env, {
      tenantId: options.tenantId,
      transaction,
      spConfig,
      binding: resolveIdPInitiatedLogoutBinding(spConfig),
      relayState: options.relayState ?? transaction.relayState,
    });
  }
}

async function sendIdPLogoutRequestForTransactionTarget(
  env: Env,
  options: {
    tenantId: string;
    transaction: SAMLIdPLogoutFanoutTransactionRecord;
    spConfig: SAMLSPConfig;
    binding: 'post' | 'redirect';
    relayState?: string;
  }
): Promise<Response> {
  const built = await buildIdPLogoutRequest(
    env,
    options.transaction.userId,
    options.spConfig,
    options.transaction.sessionIndex,
    options.tenantId
  );

  try {
    const { privateKeyPem, certificate } = await getSAMLSigningMaterial(env, {
      tenantId: built.tenantId,
      role: 'idp',
      counterpartyEntityId: options.spConfig.entityId,
      policy: getSAMLSigningPolicy(options.spConfig),
    });

    let response: Response;
    if (options.binding === 'redirect') {
      response = await sendRedirectBindingRequest(
        built.destination,
        built.logoutRequestXml,
        options.relayState ?? null,
        privateKeyPem
      );
    } else {
      const signedXml = signXml(built.logoutRequestXml, {
        privateKey: privateKeyPem,
        certificate,
        referenceUri: `#${built.logoutRequestId}`,
        signatureLocation: 'prepend',
        includeKeyInfo: true,
      });
      response = sendPostBindingRequest(built.destination, signedXml, options.relayState ?? null);
    }

    await storeIdPLogoutRequestState(env, built, options.spConfig, {
      transactionId: options.transaction.transactionId,
    });
    await markSAMLIdPLogoutFanoutTargetSent(env.STATE_STORE, {
      tenantId: options.tenantId,
      transactionId: options.transaction.transactionId,
      spEntityId: options.spConfig.entityId,
      requestId: built.logoutRequestId,
    });
    return response;
  } catch (error) {
    await markSAMLIdPLogoutFanoutTargetCompleted(env.STATE_STORE, {
      tenantId: options.tenantId,
      transactionId: options.transaction.transactionId,
      spEntityId: options.spConfig.entityId,
      status: 'failed',
      failureReason: 'send_failed',
    });
    throw error;
  }
}

function deduplicateLogoutTargets(spConfigs: SAMLSPConfig[]): SAMLSPConfig[] {
  const byEntityId = new Map<string, SAMLSPConfig>();
  for (const spConfig of spConfigs) {
    if (!byEntityId.has(spConfig.entityId)) {
      byEntityId.set(spConfig.entityId, spConfig);
    }
  }
  return Array.from(byEntityId.values());
}

async function storeIdPLogoutRequestState(
  env: Env,
  built: BuiltIdPLogoutRequest,
  spConfig: SAMLSPConfig,
  options: { transactionId?: string } = {}
): Promise<void> {
  await storeSAMLOutboundLogoutRequest(env.STATE_STORE, {
    tenantId: built.tenantId,
    spEntityId: spConfig.entityId,
    requestId: built.logoutRequestId,
    transactionId: options.transactionId,
    ttlSeconds: DEFAULTS.REQUEST_VALIDITY_SECONDS,
  });
}

function getRawQueryParam(search: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const query = search.startsWith('?') ? search.slice(1) : search;
  const match = query.split('&').find((part) => part.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

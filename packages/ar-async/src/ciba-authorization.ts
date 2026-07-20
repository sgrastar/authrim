/**
 * CIBA Backchannel Authentication Handler
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata, ClientMetadata } from '@authrim/ar-lib-core';
import {
  generateAuthReqId,
  generateCIBAUserCode,
  CIBA_CONSTANTS,
  validateCIBARequest,
  validateCIBARequestObject,
  validateCIBAIdTokenHint,
  determineDeliveryMode,
  calculatePollingInterval,
  parseLoginHint,
  getClientCached,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getJwksWithCache,
  publishEvent,
  buildDOInstanceName,
  parseOAuthClientAuthenticationParams,
  authenticateConfidentialOAuthClient,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';
import { resolveAsyncTenantId } from './tenant';

function invalidCIBAClientResponse(c: Context<{ Bindings: Env }>) {
  // CIBA error responses are a public protocol contract and may only contain
  // error, error_description, and error_uri. Do not expose Authrim's internal
  // error identifiers on this endpoint.
  return c.json(
    { error: 'invalid_client', error_description: 'Client authentication failed.' },
    401
  );
}

/**
 * POST /bc-authorize
 * Backchannel Authentication Endpoint (CIBA)
 *
 * Issues auth_req_id for CIBA flow
 */
export async function cibaAuthorizationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CIBA');
  const tenantId = resolveAsyncTenantId(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant context' },
    });
  }
  const requestIssuer = getRequestIssuer(c, tenantId);

  try {
    // Parse request body
    const body = await c.req.parseBody();
    const clientAuth = parseOAuthClientAuthenticationParams({
      clientId: body.client_id as string | undefined,
      clientSecret: body.client_secret as string | undefined,
      clientAssertion: body.client_assertion as string | undefined,
      clientAssertionType: body.client_assertion_type as string | undefined,
      authorizationHeader: c.req.header('Authorization') ?? undefined,
    });
    if (!clientAuth.ok) {
      return invalidCIBAClientResponse(c);
    }

    const client_id = clientAuth.credentials.clientId;

    // Validate client_id
    if (!client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id' },
      });
    }

    // Validate client exists and is authorized for CIBA
    const clientMetadata = await getClientCached(c, c.env, client_id);
    if (!clientMetadata) {
      return invalidCIBAClientResponse(c);
    }

    const clientAuthentication = await authenticateConfidentialOAuthClient(
      clientMetadata as unknown as ClientMetadata,
      `${requestIssuer}/bc-authorize`,
      clientAuth.credentials,
      {
        issuer: requestIssuer,
        // CIBA clients in the ecosystem commonly use the token endpoint URL as the RFC 7523
        // audience for assertions sent to other authenticated AS endpoints.
        additionalAudiences: [`${requestIssuer}/token`],
      }
    );

    if (!clientAuthentication.ok) {
      return invalidCIBAClientResponse(c);
    }

    let parameters: Record<string, unknown> = body as Record<string, unknown>;
    const registeredRequestAlgorithm =
      clientMetadata.backchannel_authentication_request_signing_alg;
    if (registeredRequestAlgorithm) {
      const requestObject = body.request;
      if (typeof requestObject !== 'string') {
        return c.json({ error: 'invalid_request', error_description: 'request is required' }, 400);
      }
      const semanticParameters = [
        'scope',
        'login_hint',
        'login_hint_token',
        'id_token_hint',
        'binding_message',
        'user_code',
        'acr_values',
        'client_notification_token',
        'requested_expiry',
      ];
      if (semanticParameters.some((name) => body[name] !== undefined)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'CIBA parameters must be contained in the signed request object',
          },
          400
        );
      }
      const requestValidation = await validateCIBARequestObject(requestObject, {
        clientId: client_id,
        audience: requestIssuer,
        algorithm: registeredRequestAlgorithm,
        jwks: (clientMetadata.jwks as { keys: import('jose').JWK[] } | undefined) ?? { keys: [] },
      });
      if (!requestValidation.valid || !requestValidation.payload) {
        return c.json(
          { error: 'invalid_request', error_description: 'Invalid signed CIBA request' },
          400
        );
      }
      parameters = requestValidation.payload as Record<string, unknown>;
    } else if (body.request !== undefined) {
      return c.json(
        { error: 'invalid_request', error_description: 'Signed CIBA requests are not registered' },
        400
      );
    }

    const stringParameter = (name: string): string | undefined =>
      typeof parameters[name] === 'string' ? parameters[name] : undefined;
    const scope = stringParameter('scope');
    const login_hint = stringParameter('login_hint');
    const login_hint_token = stringParameter('login_hint_token');
    const id_token_hint = stringParameter('id_token_hint');
    const binding_message = stringParameter('binding_message');
    const user_code = stringParameter('user_code');
    const acr_values = stringParameter('acr_values');
    const client_notification_token = stringParameter('client_notification_token');
    const requestedExpiryValue = parameters.requested_expiry;
    const requested_expiry =
      typeof requestedExpiryValue === 'number'
        ? requestedExpiryValue
        : typeof requestedExpiryValue === 'string' && /^\d+$/u.test(requestedExpiryValue)
          ? Number(requestedExpiryValue)
          : undefined;

    if (requestedExpiryValue !== undefined && requested_expiry === undefined) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'requested_expiry must be a positive integer',
        },
        400
      );
    }

    const validation = validateCIBARequest({
      scope,
      login_hint,
      login_hint_token,
      id_token_hint,
      binding_message,
      user_code,
      requested_expiry,
    });
    if (!validation.valid) {
      return c.json(
        {
          error: validation.error ?? 'invalid_request',
          error_description: validation.error_description,
        },
        400
      );
    }

    // Verify client is authorized to use CIBA grant type
    const grantTypes = clientMetadata.grant_types as string[] | string | undefined;
    if (!grantTypes || !grantTypes.includes('urn:openid:params:grant-type:ciba')) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT);
    }

    // Verify scope includes 'openid'
    if (!scope?.split(/\s+/u).includes('openid')) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_SCOPE);
    }

    // Determine delivery mode based on client configuration
    // CIBA clients can request specific delivery modes via request parameters or client metadata
    const registeredMode = clientMetadata.backchannel_token_delivery_mode ?? 'poll';
    const deliveryMode = determineDeliveryMode(
      registeredMode,
      clientMetadata.backchannel_client_notification_endpoint ?? null,
      client_notification_token ?? null
    );

    // For ping/push modes, client_notification_token is required
    if ((deliveryMode === 'ping' || deliveryMode === 'push') && !client_notification_token) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_notification_token' },
      });
    }

    // Verify client supports requested delivery mode
    if (deliveryMode !== registeredMode) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT);
    }

    // Resolve and validate user identity from login hints
    // Priority: id_token_hint > login_hint_token > login_hint
    let resolvedSubjectId: string | undefined;
    let resolvedLoginHint = login_hint;

    // Validate id_token_hint if provided (JWT signed by this server)
    if (id_token_hint) {
      // Get JWKS for signature verification (this server's keys)
      const { keys: jwksKeys } = await getJwksWithCache(c.env, tenantId);
      const idTokenValidation = await validateCIBAIdTokenHint(id_token_hint, {
        issuerUrl: requestIssuer,
        jwks: { keys: jwksKeys },
      });

      if (!idTokenValidation.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
      }

      resolvedSubjectId = idTokenValidation.subjectId;
      log.debug('Validated id_token_hint', {
        action: 'validate_id_token_hint',
        subjectId: resolvedSubjectId,
      });
    }

    // Validate login_hint_token if provided (JWT from third party)
    if (login_hint_token && !resolvedSubjectId) {
      log.warn('Rejected login_hint_token because third-party signature validation is disabled', {
        action: 'reject_unsigned_login_hint_token',
      });
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }

    // Parse login_hint if provided (fallback)
    if (login_hint && !resolvedSubjectId) {
      const parsed = parseLoginHint(login_hint);
      log.debug('Parsed login_hint', { action: 'parse_login_hint', hintType: parsed.type });
      // In production, use this to look up user in database
      // For now, we store the hint for resolution during approval
    }

    // Generate auth_req_id and optional user_code
    const authReqId = generateAuthReqId();
    const generatedUserCode = user_code || (binding_message ? generateCIBAUserCode() : undefined);

    // Calculate expiration
    const now = Date.now();
    const expiresIn = Math.min(
      Math.max(
        requested_expiry ?? CIBA_CONSTANTS.DEFAULT_EXPIRES_IN,
        CIBA_CONSTANTS.MIN_EXPIRES_IN
      ),
      CIBA_CONSTANTS.MAX_EXPIRES_IN
    );
    // requested_expiry controls the auth_req_id lifetime, not the polling
    // interval. CIBA has no request parameter for choosing the interval.
    const interval = calculatePollingInterval(null);

    // Create CIBA request metadata
    const metadata: CIBARequestMetadata = {
      tenant_id: tenantId,
      auth_req_id: authReqId,
      client_id,
      scope,
      login_hint,
      login_hint_token,
      id_token_hint,
      binding_message,
      user_code: generatedUserCode,
      acr_values,
      requested_expiry,
      status: 'pending',
      delivery_mode: deliveryMode,
      client_notification_token,
      client_notification_endpoint:
        (clientMetadata.backchannel_client_notification_endpoint as string) || undefined,
      created_at: now,
      expires_at: now + expiresIn * 1000,
      poll_count: 0,
      interval,
      token_issued: false,
      // Store resolved subject ID from JWT hint validation
      resolved_subject_id: resolvedSubjectId,
    };

    // Store in CIBARequestStore Durable Object
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName(
      buildDOInstanceName('ciba', tenantId)
    );
    const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

    const storeResponse = await cibaRequestStore.fetch(
      new Request('https://internal/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenantId },
        body: JSON.stringify(metadata),
      })
    );

    if (!storeResponse.ok) {
      const error = await storeResponse.json();
      log.error(
        'CIBARequestStore error',
        { action: 'store_request' },
        new Error(JSON.stringify(error))
      );
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // User notification for CIBA authentication requests
    //
    // Current implementation: Logs the request for manual approval via CIBA UI
    // (/ciba/pending, /ciba/approve endpoints)
    //
    // Future integration options (implement via event hooks):
    // - Email: Send email with approval link using configured SMTP/SendGrid/etc
    // - SMS: Send SMS with approval code using Twilio/etc
    // - Push: Send push notification to mobile app using FCM/APNs
    // - Webhook: POST to configured endpoint for custom notification handling
    //
    // To enable notifications:
    // 1. Add event hook for 'ciba.request.created' event type
    // 2. Configure notification provider in tenant settings
    // 3. Implement notification handler that consumes the event

    log.info('CIBA authentication request created - awaiting user approval', {
      action: 'request_created',
      authReqId,
      clientId: client_id,
      loginHintType: login_hint ? parseLoginHint(login_hint).type : 'none',
      hasBindingMessage: !!binding_message,
      hasUserCode: !!generatedUserCode,
      deliveryMode,
      expiresIn,
    });

    // Publish event for notification hooks (non-blocking)
    // External systems can subscribe to this event to send notifications
    publishEvent(c, {
      type: 'ciba.request.created',
      tenantId,
      data: {
        auth_req_id: authReqId,
        client_id,
        login_hint: login_hint || undefined,
        binding_message: binding_message || undefined,
        user_code: generatedUserCode,
        delivery_mode: deliveryMode,
        expires_at: metadata.expires_at,
      },
    }).catch((err: unknown) => {
      log.warn('Failed to publish ciba.request.created event', {}, err as Error);
    });

    // Build response based on delivery mode
    const response: {
      auth_req_id: string;
      expires_in: number;
      interval?: number;
    } = {
      auth_req_id: authReqId,
      expires_in: expiresIn,
    };

    // Only include interval for poll mode
    if (deliveryMode === 'poll') {
      response.interval = interval;
    }

    return c.json(response, 200);
  } catch (error) {
    log.error('CIBA authorization error', { action: 'authorization' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

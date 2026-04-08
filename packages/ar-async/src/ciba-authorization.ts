/**
 * CIBA Backchannel Authentication Handler
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import {
  generateAuthReqId,
  generateCIBAUserCode,
  CIBA_CONSTANTS,
  validateCIBARequest,
  validateCIBAIdTokenHint,
  validateCIBALoginHintToken,
  determineDeliveryMode,
  calculatePollingInterval,
  parseLoginHint,
  getClientCached,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getDefaultTenantId,
  getTenantIdFromContext,
  getJwksWithCache,
  publishEvent,
  buildDOInstanceName,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';

function resolveTenantId(c: Context<{ Bindings: Env }>): string {
  return typeof (c as { get?: unknown }).get === 'function'
    ? getTenantIdFromContext(c)
    : getDefaultTenantId(c.env);
}

/**
 * POST /bc-authorize
 * Backchannel Authentication Endpoint (CIBA)
 *
 * Issues auth_req_id for CIBA flow
 */
export async function cibaAuthorizationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CIBA');
  const tenantId = resolveTenantId(c);
  const requestIssuer = getRequestIssuer(c);

  try {
    // Parse request body
    const body = await c.req.parseBody();
    const scope = (body.scope as string) || 'openid';
    const client_id = body.client_id as string;
    const login_hint = body.login_hint as string | undefined;
    const login_hint_token = body.login_hint_token as string | undefined;
    const id_token_hint = body.id_token_hint as string | undefined;
    const binding_message = body.binding_message as string | undefined;
    const user_code = body.user_code as string | undefined;
    const acr_values = body.acr_values as string | undefined;
    const client_notification_token = body.client_notification_token as string | undefined;
    const requested_expiry = body.requested_expiry
      ? parseInt(body.requested_expiry as string, 10)
      : undefined;

    // Validate client_id
    if (!client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id' },
      });
    }

    // Validate CIBA request parameters
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
      // CIBA validation errors use AR codes directly
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate client exists and is authorized for CIBA
    const clientMetadata = await getClientCached(c, c.env, client_id);
    if (!clientMetadata) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }

    // Verify client is authorized to use CIBA grant type
    const grantTypes = clientMetadata.grant_types as string[] | undefined;
    if (grantTypes && !grantTypes.includes('urn:openid:params:grant-type:ciba')) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT);
    }

    // Verify scope includes 'openid'
    if (!scope.includes('openid')) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_NOT_ALLOWED_SCOPE);
    }

    // Determine delivery mode based on client configuration
    // CIBA clients can request specific delivery modes via request parameters or client metadata
    const requestedMode = null; // Could be extracted from request if needed
    const deliveryMode = determineDeliveryMode(
      requestedMode,
      (clientMetadata.backchannel_client_notification_endpoint as string | undefined) ?? null,
      client_notification_token ?? null
    );

    // For ping/push modes, client_notification_token is required
    if ((deliveryMode === 'ping' || deliveryMode === 'push') && !client_notification_token) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_notification_token' },
      });
    }

    // Verify client supports requested delivery mode
    const supportedModesStr = (clientMetadata.backchannel_token_delivery_mode as string) || 'poll';
    const supportedModes = supportedModesStr.split(',').map((m) => m.trim());
    if (!supportedModes.includes(deliveryMode)) {
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
      // For login_hint_token, JWKS would come from the third-party issuer
      // Currently we validate without signature verification for third-party tokens
      // In production, implement dynamic JWKS fetching based on the token's issuer
      const loginHintTokenValidation = await validateCIBALoginHintToken(login_hint_token, {
        audience: requestIssuer,
        // Note: Third-party JWKS not yet implemented
        // jwks would need to be fetched from the third-party issuer's jwks_uri
      });

      if (!loginHintTokenValidation.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
      }

      resolvedSubjectId = loginHintTokenValidation.subjectId;
      log.debug('Validated login_hint_token', {
        action: 'validate_login_hint_token',
        subjectId: resolvedSubjectId,
      });
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
    const expiresIn = requested_expiry || CIBA_CONSTANTS.DEFAULT_EXPIRES_IN;
    const interval = calculatePollingInterval(expiresIn);

    // Create CIBA request metadata
    const metadata: CIBARequestMetadata = {
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
        headers: { 'Content-Type': 'application/json' },
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

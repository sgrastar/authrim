/**
 * CIBA Backchannel Authentication Handler
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/shared';
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
  getClient,
} from '@authrim/shared';

/**
 * POST /bc-authorize
 * Backchannel Authentication Endpoint (CIBA)
 *
 * Issues auth_req_id for CIBA flow
 */
export async function cibaAuthorizationHandler(c: Context<{ Bindings: Env }>) {
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_id is required',
        },
        400
      );
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
      return c.json(
        {
          error: validation.error,
          error_description: validation.error_description,
        },
        400
      );
    }

    // Validate client exists and is authorized for CIBA
    const clientMetadata = await getClient(c.env, client_id);
    if (!clientMetadata) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client not found or not registered',
        },
        400
      );
    }

    // Verify client is authorized to use CIBA grant type
    const grantTypes = clientMetadata.grant_types as string[] | undefined;
    if (grantTypes && !grantTypes.includes('urn:openid:params:grant-type:ciba')) {
      return c.json(
        {
          error: 'unauthorized_client',
          error_description: 'Client is not authorized to use CIBA flow',
        },
        400
      );
    }

    // Verify scope includes 'openid'
    if (!scope.includes('openid')) {
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'scope must include openid',
        },
        400
      );
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_notification_token is required for ping/push modes',
        },
        400
      );
    }

    // Verify client supports requested delivery mode
    const supportedModesStr = (clientMetadata.backchannel_token_delivery_mode as string) || 'poll';
    const supportedModes = supportedModesStr.split(',').map((m) => m.trim());
    if (!supportedModes.includes(deliveryMode)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Client does not support ${deliveryMode} delivery mode`,
        },
        400
      );
    }

    // Resolve and validate user identity from login hints
    // Priority: id_token_hint > login_hint_token > login_hint
    let resolvedSubjectId: string | undefined;
    let resolvedLoginHint = login_hint;

    // Validate id_token_hint if provided (JWT signed by this server)
    if (id_token_hint) {
      const idTokenValidation = validateCIBAIdTokenHint(id_token_hint, {
        issuerUrl: c.env.ISSUER_URL,
        // TODO: Add JWKS for signature verification
      });

      if (!idTokenValidation.valid) {
        return c.json(
          {
            error: idTokenValidation.error,
            error_description: idTokenValidation.error_description,
          },
          400
        );
      }

      resolvedSubjectId = idTokenValidation.subjectId;
      console.log('Validated id_token_hint, subject:', resolvedSubjectId);
    }

    // Validate login_hint_token if provided (JWT from third party)
    if (login_hint_token && !resolvedSubjectId) {
      const loginHintTokenValidation = validateCIBALoginHintToken(login_hint_token, {
        audience: c.env.ISSUER_URL,
        // TODO: Add JWKS for signature verification (third-party issuer)
      });

      if (!loginHintTokenValidation.valid) {
        return c.json(
          {
            error: loginHintTokenValidation.error,
            error_description: loginHintTokenValidation.error_description,
          },
          400
        );
      }

      resolvedSubjectId = loginHintTokenValidation.subjectId;
      console.log('Validated login_hint_token, subject:', resolvedSubjectId);
    }

    // Parse login_hint if provided (fallback)
    if (login_hint && !resolvedSubjectId) {
      const parsed = parseLoginHint(login_hint);
      console.log('Parsed login_hint:', parsed);
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
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
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
      console.error('CIBARequestStore error:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to store CIBA request',
        },
        500
      );
    }

    // TODO: Send user notification
    // Based on login_hint type:
    // - Email: Send email with approval link
    // - Phone: Send SMS with approval link
    // - Push: Send push notification to mobile app
    // - For now, log the request for manual approval via UI
    console.log('CIBA authentication request created:', {
      auth_req_id: authReqId,
      client_id,
      login_hint,
      binding_message,
      user_code: generatedUserCode,
      delivery_mode: deliveryMode,
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
    console.error('CIBA authorization error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

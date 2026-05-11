/**
 * CIBA Request Approval API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Approves a CIBA authentication request
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import {
  isMockAuthEnabled,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getDefaultTenantId,
  getTenantIdFromContext,
  buildDOInstanceName,
  parseCIBARequestId,
  getCIBARequestStoreById,
  checkRateLimit,
  getCloudProvider,
  getClientIP,
  RateLimitProfiles,
} from '@authrim/ar-lib-core';
import { sendPingNotification } from '@authrim/ar-lib-core/notifications';

function resolveTenantId(c: Context<{ Bindings: Env }>): string {
  return typeof (c as { get?: unknown }).get === 'function'
    ? getTenantIdFromContext(c)
    : getDefaultTenantId(c.env);
}

/**
 * POST /api/ciba/approve
 * Approve a CIBA authentication request
 *
 * Request:
 *   {
 *     "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
 *     "user_id": "user123",  // Optional: Will be set by session in production
 *     "sub": "user@example.com",  // Optional: Will be set by session in production
 *     "nonce": "nonce123"  // Optional: For ID Token binding
 *   }
 *
 * Response:
 *   {
 *     "success": true,
 *     "message": "Authentication request approved"
 *   }
 */
export async function cibaApproveHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CIBA');
  const tenantId = resolveTenantId(c);
  const internalHeaders = {
    'Content-Type': 'application/json',
    'X-Authrim-Tenant-Id': tenantId,
  };
  try {
    // Get client IP for rate limiting using cloud provider configuration
    const cloudProvider = await getCloudProvider(c.env);
    const clientIp = getClientIP(c, cloudProvider);

    // Check rate limiting for CIBA approval requests (strict profile: 10 requests/minute)
    // This prevents brute-force attacks on auth_req_id
    const rateLimitResult = await checkRateLimit(c.env, `ciba-approve:${clientIp}`, {
      ...RateLimitProfiles.strict,
    });

    if (!rateLimitResult.allowed) {
      log.warn('CIBA approve rate limit exceeded', {
        clientIp: clientIp.substring(0, 10) + '...',
        remaining: rateLimitResult.remaining,
        resetAt: rateLimitResult.resetAt,
      });
      const retryAfter = rateLimitResult.resetAt - Math.floor(Date.now() / 1000);
      c.header('Retry-After', retryAfter.toString());
      c.header('X-RateLimit-Limit', RateLimitProfiles.strict.maxRequests.toString());
      c.header('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
      c.header('X-RateLimit-Reset', rateLimitResult.resetAt.toString());
      return c.json(
        {
          error: 'rate_limit_exceeded',
          error_description: 'Too many approval requests. Please try again later.',
          retry_after: retryAfter,
        },
        429
      );
    }

    // Parse JSON request body
    const body = await c.req.json();
    const authReqId = body.auth_req_id as string;
    const userId = body.user_id as string | undefined;
    const sub = body.sub as string | undefined;
    const nonce = body.nonce as string | undefined;

    // Validate auth_req_id is present
    if (!authReqId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'auth_req_id' },
      });
    }

    // Get CIBA request metadata from CIBARequestStore
    const parsedCibaId = parseCIBARequestId(authReqId);
    const cibaRequestStore = parsedCibaId
      ? getCIBARequestStoreById(c.env, authReqId, tenantId).stub
      : c.env.CIBA_REQUEST_STORE.get(
          c.env.CIBA_REQUEST_STORE.idFromName(buildDOInstanceName('ciba', tenantId))
        );

    // First, verify the request exists and is pending
    const getResponse = await cibaRequestStore.fetch(
      new Request('https://internal/get-by-auth-req-id', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );

    if (!getResponse.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const metadata: CIBARequestMetadata | null = await getResponse.json();

    if (!metadata) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if request is still pending
    if (metadata.status !== 'pending') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Check if we need to use mock credentials
    const needsMockCredentials = !userId || !sub;

    if (needsMockCredentials) {
      // Check if mock auth is enabled (SECURITY: default is disabled)
      const mockAuthEnabled = await isMockAuthEnabled(c.env);

      if (!mockAuthEnabled) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
      }

      // DEVELOPMENT ONLY: Log warning about mock auth usage
      log.warn('Mock authentication is enabled. This should NEVER be used in production!');
    }

    // Use provided credentials or fallback to mock (only if mock auth is enabled)
    const finalUserId = userId || 'user_' + Date.now();
    const finalSub = sub || 'mock-user@example.com';

    // Approve the request
    const approveResponse = await cibaRequestStore.fetch(
      new Request('https://internal/approve', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({
          auth_req_id: authReqId,
          user_id: finalUserId,
          sub: finalSub,
          nonce: nonce || null,
        }),
      })
    );

    if (!approveResponse.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Send ping mode notification if required
    if (metadata.delivery_mode === 'ping' && metadata.client_notification_endpoint) {
      try {
        await sendPingNotification(
          metadata.client_notification_endpoint,
          metadata.client_notification_token!,
          authReqId
        );
      } catch (error) {
        log.error('Failed to send ping notification', {}, error as Error);
        // Continue even if notification fails - client can still poll
      }
    }

    return c.json(
      {
        success: true,
        message: 'Authentication request approved',
      },
      200
    );
  } catch (error) {
    log.error('CIBA approval API error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

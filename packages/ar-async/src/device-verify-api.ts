/**
 * Device Verification API Handler
 * RFC 8628: Device User Authorization (Headless API)
 *
 * JSON API for device verification - used by SvelteKit UI or custom WebSDK implementations
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/ar-lib-core';
import {
  normalizeUserCode,
  validateUserCodeFormat,
  isMockAuthEnabled,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  buildDOKey,
  buildDOInstanceName,
} from '@authrim/ar-lib-core';
import { resolveAsyncTenantId } from './tenant';
import { getAuthenticatedAsyncUser } from './authenticated-session';

/**
 * POST /api/device/verify
 * Headless JSON API for device verification
 *
 * Request:
 *   POST /api/device/verify
 *   Content-Type: application/json
 *
 *   {
 *     "user_code": "WDJB-MJHT",
 *     "approve": true,      // Optional: true to approve, false to deny (default: true)
 *     "user_id": "user_123",  // Optional: Will be set by session in production
 *     "sub": "user@example.com" // Optional: Will be set by session in production
 *   }
 *
 * Response:
 *   Success (200):
 *   {
 *     "success": true,
 *     "message": "Device authorized successfully"
 *   }
 *
 *   Error (400/404):
 *   {
 *     "success": false,
 *     "error": "invalid_code",
 *     "error_description": "Invalid or expired user code"
 *   }
 */
export async function deviceVerifyApiHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DEVICE');
  const tenantId = resolveAsyncTenantId(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant context' },
    });
  }
  const internalHeaders = {
    'Content-Type': 'application/json',
    'X-Authrim-Tenant-Id': tenantId,
  };
  try {
    // Get client IP for rate limiting
    const clientIp =
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';

    // Check rate limiting (if USER_CODE_RATE_LIMITER is available)
    if (c.env.USER_CODE_RATE_LIMITER) {
      const rateLimiterId = c.env.USER_CODE_RATE_LIMITER.idFromName(
        buildDOKey('rate-limit', 'user-code', tenantId)
      );
      const rateLimiter = c.env.USER_CODE_RATE_LIMITER.get(rateLimiterId);

      const checkResponse = await rateLimiter.fetch(
        new Request('https://internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: clientIp }),
        })
      );

      if (checkResponse.ok) {
        const result = (await checkResponse.json()) as { blocked: boolean; retry_after?: number };
        if (result.blocked) {
          return c.json(
            {
              success: false,
              error: 'slow_down',
              error_description: `Too many failed attempts. Please try again in ${result.retry_after || 3600} seconds.`,
            },
            429
          );
        }
      }
    }

    // Parse JSON request body
    const body = await c.req.json();
    let userCode = body.user_code as string;
    const approve = body.approve !== undefined ? body.approve : true;
    const userId = body.user_id as string | undefined;
    const sub = body.sub as string | undefined;

    // Validate user_code is present
    if (!userCode) {
      return c.json(
        {
          success: false,
          error: 'invalid_request',
          error_description: 'user_code is required',
        },
        400
      );
    }

    // Normalize and validate user code format
    userCode = normalizeUserCode(userCode);

    if (!validateUserCodeFormat(userCode)) {
      return c.json(
        {
          success: false,
          error: 'invalid_code',
          error_description: 'Invalid user code format. Expected: XXXX-XXXX',
        },
        400
      );
    }

    // Get device code metadata from DeviceCodeStore
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName(
      buildDOInstanceName('device', tenantId)
    );
    const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

    const getResponse = await deviceCodeStore.fetch(
      new Request('https://internal/get-by-user-code', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ user_code: userCode }),
      })
    );

    if (!getResponse.ok) {
      // Record failed attempt for rate limiting
      if (c.env.USER_CODE_RATE_LIMITER) {
        const rateLimiterId = c.env.USER_CODE_RATE_LIMITER.idFromName(
          buildDOKey('rate-limit', 'user-code', tenantId)
        );
        const rateLimiter = c.env.USER_CODE_RATE_LIMITER.get(rateLimiterId);
        await rateLimiter
          .fetch(
            new Request('https://internal/record-failure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ip: clientIp }),
            })
          )
          .catch(() => {
            /* Ignore rate limiter errors */
          });
      }

      return c.json(
        {
          success: false,
          error: 'invalid_code',
          error_description: 'Invalid or expired user code',
        },
        404
      );
    }

    const metadata: DeviceCodeMetadata | null = await getResponse.json();

    if (!metadata) {
      // Record failed attempt for rate limiting
      if (c.env.USER_CODE_RATE_LIMITER) {
        const rateLimiterId = c.env.USER_CODE_RATE_LIMITER.idFromName(
          buildDOKey('rate-limit', 'user-code', tenantId)
        );
        const rateLimiter = c.env.USER_CODE_RATE_LIMITER.get(rateLimiterId);
        await rateLimiter
          .fetch(
            new Request('https://internal/record-failure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ip: clientIp }),
            })
          )
          .catch(() => {
            /* Ignore rate limiter errors */
          });
      }

      return c.json(
        {
          success: false,
          error: 'invalid_code',
          error_description: 'Invalid or expired user code',
        },
        404
      );
    }

    // Check if code is still pending
    if (metadata.status !== 'pending') {
      return c.json(
        {
          success: false,
          error: 'invalid_code',
          error_description: `This code has already been ${metadata.status}`,
        },
        400
      );
    }

    // Handle approval or denial
    if (approve) {
      const authenticatedUser = await getAuthenticatedAsyncUser(c, tenantId);
      const mockAuthEnabled = await isMockAuthEnabled(c.env);

      if (!authenticatedUser && !mockAuthEnabled) {
        return c.json(
          {
            success: false,
            error: 'authentication_required',
            error_description: 'A valid browser session is required to approve a device code.',
          },
          401
        );
      }

      if ((userId || sub) && !mockAuthEnabled) {
        log.warn('Ignoring caller-supplied device approval subject', {
          action: 'approval_subject_ignored',
        });
      }

      if (!authenticatedUser) {
        log.warn('Mock authentication is enabled. This should NEVER be used in production!');
      }

      const finalUserId = authenticatedUser?.userId || userId || 'user_' + Date.now();
      const finalSub = authenticatedUser?.sub || sub || finalUserId;

      const approveResponse = await deviceCodeStore.fetch(
        new Request('https://internal/approve', {
          method: 'POST',
          headers: internalHeaders,
          body: JSON.stringify({
            user_code: userCode,
            user_id: finalUserId,
            sub: finalSub,
          }),
        })
      );

      if (!approveResponse.ok) {
        const error = (await approveResponse.json()) as { error_description?: string };
        return c.json(
          {
            success: false,
            error: 'server_error',
            error_description: error.error_description || 'Failed to approve device',
          },
          500
        );
      }

      // Reset rate limiting on successful verification
      if (c.env.USER_CODE_RATE_LIMITER) {
        const rateLimiterId = c.env.USER_CODE_RATE_LIMITER.idFromName(
          buildDOKey('rate-limit', 'user-code', tenantId)
        );
        const rateLimiter = c.env.USER_CODE_RATE_LIMITER.get(rateLimiterId);
        await rateLimiter
          .fetch(
            new Request('https://internal/reset', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ip: clientIp }),
            })
          )
          .catch(() => {
            /* Ignore rate limiter errors */
          });
      }

      return c.json(
        {
          success: true,
          message: 'Device authorized successfully',
        },
        200
      );
    } else {
      // User denied the authorization
      const denyResponse = await deviceCodeStore.fetch(
        new Request('https://internal/deny', {
          method: 'POST',
          headers: internalHeaders,
          body: JSON.stringify({ user_code: userCode }),
        })
      );

      if (!denyResponse.ok) {
        const error = (await denyResponse.json()) as { error_description?: string };
        return c.json(
          {
            success: false,
            error: 'server_error',
            error_description: error.error_description || 'Failed to deny device',
          },
          500
        );
      }

      return c.json(
        {
          success: true,
          message: 'Device authorization denied',
        },
        200
      );
    }
  } catch (error) {
    log.error('Device verification API error', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
    return c.json(
      {
        success: false,
        error: 'server_error',
        error_description: 'Internal server error',
      },
      500
    );
  }
}

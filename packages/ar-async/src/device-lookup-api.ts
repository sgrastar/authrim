/**
 * Device Code Lookup API Handler
 * RFC 8628: Device User Authorization (Headless API)
 *
 * Shows the signed-in user which application a user code belongs to and what it asks for, before
 * they decide it with POST /api/devices/verify. RFC 8628 Section 5.4 recommends this so a user can
 * recognise a remote phishing attempt instead of approving an unknown device blind.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  normalizeUserCode,
  validateUserCodeFormat,
  isMockAuthEnabled,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getClient,
  createAuthContextFromHono,
} from '@authrim/ar-lib-core';
import { resolveAsyncTenantId } from './tenant';
import { getAuthenticatedAsyncUser } from './authenticated-session';
import {
  USER_CODE_GUARD_UNAVAILABLE,
  checkUserCodeRateLimit,
  lookUpDeviceCodeByUserCode,
  userCodeBlockedResponse,
} from './user-code-guard';

/**
 * POST /api/devices/lookup
 * Look up a pending device code for the signed-in user
 *
 * Request:
 *   POST /api/devices/lookup
 *   Content-Type: application/json
 *
 *   { "user_code": "WDJB-MJHT" }
 *
 * Response:
 *   Success (200):
 *   {
 *     "client_id": "client_123",
 *     "client_name": "Acme TV",
 *     "client_uri": "https://tv.example.com",   // when registered
 *     "logo_uri": "https://tv.example.com/logo.png", // when registered
 *     "scopes": ["openid", "profile"],
 *     "expires_at": 1234567890000
 *   }
 *
 *   Error (400/401/404/429/503):
 *   {
 *     "success": false,
 *     "error": "invalid_code",
 *     "error_description": "Invalid or expired user code"
 *   }
 *
 * The lookup decides nothing. It needs the same browser session as the decision and counts a
 * missing code against the same per-IP user code rate limit, so guessing codes through it is no
 * easier than through POST /api/devices/verify. Without a working rate limiter or device code
 * store it answers 503 temporarily_unavailable (see user-code-guard.ts).
 */
export async function deviceLookupApiHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DEVICE');
  const tenantId = resolveAsyncTenantId(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant context' },
    });
  }
  try {
    const authenticatedUser = await getAuthenticatedAsyncUser(c, tenantId);
    const mockAuthEnabled = await isMockAuthEnabled(c.env);
    if (!authenticatedUser && !mockAuthEnabled) {
      return c.json(
        {
          success: false,
          error: 'authentication_required',
          error_description: 'A valid browser session is required to look up a device code.',
        },
        401
      );
    }

    const rateLimit = await checkUserCodeRateLimit(c, tenantId, { mockAuthEnabled });
    if (rateLimit.status === 'unavailable') {
      return c.json(USER_CODE_GUARD_UNAVAILABLE, 503);
    }
    if (rateLimit.status === 'blocked') {
      return userCodeBlockedResponse(c, rateLimit.retryAfter);
    }

    const body = (await c.req.json()) as { user_code?: unknown };
    if (typeof body.user_code !== 'string' || !body.user_code) {
      return c.json(
        {
          success: false,
          error: 'invalid_request',
          error_description: 'user_code is required',
        },
        400
      );
    }

    const userCode = normalizeUserCode(body.user_code);
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

    const lookup = await lookUpDeviceCodeByUserCode(c, tenantId, userCode);
    if (lookup.status === 'unavailable') {
      return c.json(USER_CODE_GUARD_UNAVAILABLE, 503);
    }
    if (lookup.status === 'absent') {
      if (!(await rateLimit.recordFailure())) {
        return c.json(USER_CODE_GUARD_UNAVAILABLE, 503);
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

    const { metadata } = lookup;
    if (metadata.status !== 'pending') {
      return c.json(
        {
          success: false,
          error: 'invalid_code',
          error_description: `This code has already been ${metadata.status}`,
          // Lets the signed-in user's browser tell, after a decision whose answer was lost,
          // whether that decision was saved: the state, and whether the signed-in user is the
          // one who approved it. Who else decided a code is never disclosed. A denial records
          // no user, so it is never attributed.
          code_status: metadata.status,
          decided_by_self: Boolean(
            authenticatedUser &&
            metadata.status === 'approved' &&
            ((metadata.user_id !== undefined && metadata.user_id === authenticatedUser.userId) ||
              (metadata.sub !== undefined && metadata.sub === authenticatedUser.sub))
          ),
        },
        400
      );
    }

    const client = await getClient(
      c.env,
      tenantId,
      metadata.client_id,
      createAuthContextFromHono(c, tenantId).coreAdapter
    );

    return c.json(
      {
        client_id: metadata.client_id,
        client_name: client?.client_name || metadata.client_id,
        ...(client?.client_uri ? { client_uri: client.client_uri } : {}),
        ...(client?.logo_uri ? { logo_uri: client.logo_uri } : {}),
        scopes: metadata.scope.split(' ').filter(Boolean),
        expires_at: metadata.expires_at,
      },
      200
    );
  } catch (error) {
    log.error('Device lookup API error', {}, error as Error);
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

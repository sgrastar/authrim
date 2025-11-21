/**
 * Device Verification API Handler
 * RFC 8628: Device User Authorization (Headless API)
 *
 * JSON API for device verification - used by SvelteKit UI or custom WebSDK implementations
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/shared';
import { normalizeUserCode, validateUserCodeFormat } from '@authrim/shared';

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
  try {
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
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName('global');
    const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

    const getResponse = await deviceCodeStore.fetch(
      new Request('https://internal/get-by-user-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      })
    );

    if (!getResponse.ok) {
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
      // TODO: In production, get user_id and sub from session
      // For now, use provided values or mock values
      const finalUserId = userId || 'user_' + Date.now();
      const finalSub = sub || 'mock-user@example.com';

      const approveResponse = await deviceCodeStore.fetch(
        new Request('https://internal/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
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
    console.error('Device verification API error:', error);
    return c.json(
      {
        success: false,
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

/**
 * CIBA Request Approval API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Approves a CIBA authentication request
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/shared';
import { sendPingNotification } from '@authrim/shared/notifications';

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
  try {
    // Get client IP for rate limiting
    const clientIp =
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';

    // TODO: Check rate limiting if needed

    // Parse JSON request body
    const body = await c.req.json();
    const authReqId = body.auth_req_id as string;
    const userId = body.user_id as string | undefined;
    const sub = body.sub as string | undefined;
    const nonce = body.nonce as string | undefined;

    // Validate auth_req_id is present
    if (!authReqId) {
      return c.json(
        {
          success: false,
          error: 'invalid_request',
          error_description: 'auth_req_id is required',
        },
        400
      );
    }

    // Get CIBA request metadata from CIBARequestStore
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
    const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

    // First, verify the request exists and is pending
    const getResponse = await cibaRequestStore.fetch(
      new Request('https://internal/get-by-auth-req-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );

    if (!getResponse.ok) {
      return c.json(
        {
          success: false,
          error: 'not_found',
          error_description: 'CIBA request not found or expired',
        },
        404
      );
    }

    const metadata: CIBARequestMetadata | null = await getResponse.json();

    if (!metadata) {
      return c.json(
        {
          success: false,
          error: 'not_found',
          error_description: 'CIBA request not found or expired',
        },
        404
      );
    }

    // Check if request is still pending
    if (metadata.status !== 'pending') {
      return c.json(
        {
          success: false,
          error: 'invalid_request',
          error_description: `This request has already been ${metadata.status}`,
        },
        400
      );
    }

    // TODO: In production, get user_id and sub from session
    // For now, use provided values or mock values
    const finalUserId = userId || 'user_' + Date.now();
    const finalSub = sub || 'mock-user@example.com';

    // Approve the request
    const approveResponse = await cibaRequestStore.fetch(
      new Request('https://internal/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_req_id: authReqId,
          user_id: finalUserId,
          sub: finalSub,
          nonce: nonce || null,
        }),
      })
    );

    if (!approveResponse.ok) {
      const error = (await approveResponse.json()) as { error_description?: string };
      return c.json(
        {
          success: false,
          error: 'server_error',
          error_description: error.error_description || 'Failed to approve CIBA request',
        },
        500
      );
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
        console.error('Failed to send ping notification:', error);
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
    console.error('CIBA approval API error:', error);
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

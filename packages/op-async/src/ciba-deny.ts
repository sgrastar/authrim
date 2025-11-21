/**
 * CIBA Request Denial API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Denies a CIBA authentication request
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/shared';

/**
 * POST /api/ciba/deny
 * Deny a CIBA authentication request
 *
 * Request:
 *   {
 *     "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
 *     "reason": "User rejected"  // Optional
 *   }
 *
 * Response:
 *   {
 *     "success": true,
 *     "message": "Authentication request denied"
 *   }
 */
export async function cibaDenyHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Parse JSON request body
    const body = await c.req.json();
    const authReqId = body.auth_req_id as string;
    const reason = body.reason as string | undefined;

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

    // Deny the request
    const denyResponse = await cibaRequestStore.fetch(
      new Request('https://internal/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_req_id: authReqId,
          reason: reason || 'User rejected',
        }),
      })
    );

    if (!denyResponse.ok) {
      const error = (await denyResponse.json()) as { error_description?: string };
      return c.json(
        {
          success: false,
          error: 'server_error',
          error_description: error.error_description || 'Failed to deny CIBA request',
        },
        500
      );
    }

    return c.json(
      {
        success: true,
        message: 'Authentication request denied',
      },
      200
    );
  } catch (error) {
    console.error('CIBA denial API error:', error);
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

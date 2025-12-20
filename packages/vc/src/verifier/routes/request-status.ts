/**
 * VP Request Status Route
 *
 * Returns the current status of a VP request.
 * Used for polling to check if the wallet has responded.
 *
 * Uses region-aware sharding for Durable Object routing:
 * - Request ID format: g{gen}:{region}:{shard}:vp_{uuid}
 * - Self-routing: shard info embedded in ID, no external lookup needed
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import { getVPRequestStoreById } from '../../utils/vp-request-sharding';

/**
 * GET /vp/request/:id
 *
 * Returns the current status of a VP request.
 */
export async function vpRequestStatusRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const requestId = c.req.param('id');

    if (!requestId) {
      return c.json({ error: 'invalid_request', error_description: 'Request ID is required' }, 400);
    }

    // Get DO stub using region-aware sharding (self-routing from ID)
    // Request ID format: g{gen}:{region}:{shard}:vp_{uuid}
    const { stub } = getVPRequestStoreById(c.env, requestId);

    const response = await stub.fetch(new Request('https://internal/get'));

    if (!response.ok) {
      return c.json({ error: 'not_found', error_description: 'VP request not found' }, 404);
    }

    const vpRequest = (await response.json()) as {
      id: string;
      status: string;
      createdAt: number;
      expiresAt: number;
      verifiedClaims?: Record<string, unknown>;
      errorCode?: string;
      errorDescription?: string;
    };

    // Check expiration
    if (vpRequest.status === 'pending' && Date.now() > vpRequest.expiresAt) {
      // Update status to expired
      await stub.fetch(
        new Request('https://internal/update-status', {
          method: 'POST',
          body: JSON.stringify({ status: 'expired' }),
        })
      );

      return c.json({
        request_id: requestId,
        status: 'expired',
        expires_at: new Date(vpRequest.expiresAt).toISOString(),
      });
    }

    // Build response based on status
    const result: Record<string, unknown> = {
      request_id: requestId,
      status: vpRequest.status,
      created_at: new Date(vpRequest.createdAt).toISOString(),
      expires_at: new Date(vpRequest.expiresAt).toISOString(),
    };

    // Include verified claims if available
    if (vpRequest.status === 'verified' && vpRequest.verifiedClaims) {
      result.verified_claims = vpRequest.verifiedClaims;
    }

    // Include error if failed
    if (vpRequest.status === 'failed') {
      result.error = vpRequest.errorCode;
      result.error_description = vpRequest.errorDescription;
    }

    return c.json(result);
  } catch (error) {
    console.error('[vpRequestStatus] Error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

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
import { createErrorResponse, AR_ERROR_CODES, getLogger } from '@authrim/ar-lib-core';

/**
 * GET /vp/request/:id
 *
 * Returns the current status of a VP request.
 */
export async function vpRequestStatusRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('VC-VERIFIER');
  try {
    const requestId = c.req.param('id');

    if (!requestId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id' },
      });
    }

    // Get DO stub using region-aware sharding (self-routing from ID)
    // Request ID format: g{gen}:{region}:{shard}:vp_{uuid}
    const { stub } = getVPRequestStoreById(c.env, requestId);

    const response = await stub.fetch(new Request('https://internal/get'));

    if (!response.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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
    log.error('VP request status check failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

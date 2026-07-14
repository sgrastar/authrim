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
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import { sha256Base64url } from '../../utils/crypto';

/**
 * GET /vp/requests/:id
 *
 * Returns the current status of a VP request.
 */
export async function vpRequestStatusRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  try {
    const requestId = c.req.param('id');

    if (!requestId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'id' },
      });
    }
    const authorization = c.req.header('Authorization');
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      return createErrorResponse(c, AR_ERROR_CODES.TOKEN_INVALID);
    }
    const statusTokenHash = await sha256Base64url(authorization.slice(7));

    // Get DO stub using region-aware sharding (self-routing from ID)
    // Request ID format: g{gen}:{region}:{shard}:vp_{uuid}
    const { stub } = getVPRequestStoreById(c.env, requestId, getTenantIdFromContext(c));

    const tenantId = getTenantIdFromContext(c);
    const response = await stub.fetch(
      new Request('https://internal/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: requestId, tenantId, statusTokenHash }),
      })
    );

    if (!response.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const vpRequest = (await response.json()) as {
      id: string;
      status: string;
      createdAt: number;
      expiresAt: number;
      verifiedClaimNames?: string[];
      errorCode?: string;
      errorDescription?: string;
    };

    if (vpRequest.status === 'pending' && Date.now() > vpRequest.expiresAt) {
      vpRequest.status = 'expired';
    }

    // Build response based on status
    const result: Record<string, unknown> = {
      request_id: requestId,
      status: vpRequest.status,
      created_at: new Date(vpRequest.createdAt).toISOString(),
      expires_at: new Date(vpRequest.expiresAt).toISOString(),
    };

    // Claim values are deliberately not persisted; only non-PII names are exposed.
    if (vpRequest.status === 'verified' && vpRequest.verifiedClaimNames) {
      result.verified_claim_names = vpRequest.verifiedClaimNames;
    }

    // Include error if failed
    if (vpRequest.status === 'failed') {
      result.error = vpRequest.errorCode;
      result.error_description = vpRequest.errorDescription;
    }

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(result);
  } catch (error) {
    log.error('VP request status check failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

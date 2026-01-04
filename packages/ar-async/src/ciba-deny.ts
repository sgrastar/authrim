/**
 * CIBA Request Denial API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Denies a CIBA authentication request
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES, getLogger } from '@authrim/ar-lib-core';

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
  const log = getLogger(c).module('CIBA');
  try {
    // Parse JSON request body
    const body = await c.req.json();
    const authReqId = body.auth_req_id as string;
    const reason = body.reason as string | undefined;

    // Validate auth_req_id is present
    if (!authReqId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'auth_req_id' },
      });
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
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    return c.json(
      {
        success: true,
        message: 'Authentication request denied',
      },
      200
    );
  } catch (error) {
    log.error('CIBA denial API error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

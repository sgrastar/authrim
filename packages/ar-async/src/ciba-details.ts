/**
 * CIBA Request Details API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Retrieves details of a specific CIBA authentication request
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES, getLogger, getClient } from '@authrim/ar-lib-core';

/**
 * GET /api/ciba/request/:auth_req_id
 * Get details of a specific CIBA request
 *
 * Response:
 *   {
 *     "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
 *     "client": {
 *       "client_id": "client123",
 *       "client_name": "Banking App",
 *       "logo_uri": "https://...",
 *       "is_trusted": false
 *     },
 *     "scope": "openid profile email",
 *     "binding_message": "Sign in to Banking App",
 *     "user_code": "ABCD-1234",
 *     "created_at": 1234567890,
 *     "expires_at": 1234568190,
 *     "time_remaining": 290,
 *     "status": "pending"
 *   }
 */
export async function cibaDetailsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CIBA');
  try {
    const authReqId = c.req.param('auth_req_id');

    if (!authReqId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'auth_req_id' },
      });
    }

    // Get CIBA request metadata from CIBARequestStore
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
    const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

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

    // Enrich with client metadata from KV cache (with D1 fallback)
    const client = await getClient(c.env, metadata.client_id);

    // Calculate time remaining
    const now = Math.floor(Date.now() / 1000);
    const timeRemaining = Math.max(0, metadata.expires_at - now);

    return c.json({
      auth_req_id: metadata.auth_req_id,
      client: {
        client_id: metadata.client_id,
        client_name: client?.client_name || metadata.client_id,
        logo_uri: client?.logo_uri || null,
        is_trusted: client?.is_trusted || false,
      },
      scope: metadata.scope,
      binding_message: metadata.binding_message || null,
      user_code: metadata.user_code || null,
      created_at: metadata.created_at,
      expires_at: metadata.expires_at,
      time_remaining: timeRemaining,
      status: metadata.status,
    });
  } catch (error) {
    log.error('CIBA request details API error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

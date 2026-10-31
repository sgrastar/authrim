/**
 * CIBA Request Denial API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Denies a CIBA authentication request
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  buildDOInstanceName,
  parseCIBARequestId,
  getCIBARequestStoreById,
  isMockAuthEnabled,
} from '@authrim/ar-lib-core';
import { resolveAsyncTenantId } from './tenant';
import { cibaStoreUnavailable, readCibaRequest, sendCibaDecision } from './ciba-store';
import {
  cibaRequestMatchesAuthenticatedUser,
  getAuthenticatedAsyncUser,
} from './authenticated-session';

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

    const authenticatedUser = await getAuthenticatedAsyncUser(c, tenantId);
    const mockAuthEnabled = await isMockAuthEnabled(c.env);
    if (!authenticatedUser && !mockAuthEnabled) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    // Get CIBA request metadata from CIBARequestStore
    const parsedCibaId = parseCIBARequestId(authReqId);
    const cibaRequestStore = parsedCibaId
      ? getCIBARequestStoreById(c.env, authReqId, tenantId).stub
      : c.env.CIBA_REQUEST_STORE.get(
          c.env.CIBA_REQUEST_STORE.idFromName(buildDOInstanceName('ciba', tenantId))
        );

    // First, verify the request exists and is pending
    const read = await readCibaRequest(cibaRequestStore, internalHeaders, authReqId);
    if (read.kind === 'unavailable') {
      if (read.error) log.error('CIBA request store unavailable', {}, read.error as Error);
      return cibaStoreUnavailable(c, 'The request cannot be read right now. Try again.');
    }
    if (read.kind === 'missing') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const metadata = read.metadata;

    // Check if request is still pending
    if (metadata.status !== 'pending') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (authenticatedUser && !cibaRequestMatchesAuthenticatedUser(metadata, authenticatedUser)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // Deny the request
    const denied = await sendCibaDecision(cibaRequestStore, internalHeaders, 'deny', {
      auth_req_id: authReqId,
      reason: reason || 'User rejected',
    });
    if (!denied.ok) {
      // The store did not confirm the denial; it may or may not have been saved.
      if (denied.error) log.error('CIBA request store failed to deny', {}, denied.error as Error);
      return cibaStoreUnavailable(c, 'The denial could not be confirmed. Check the request.');
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

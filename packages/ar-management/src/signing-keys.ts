/**
 * Signing Keys Admin API Handlers
 *
 * Provides admin endpoints for managing signing keys:
 * - GET /api/admin/signing-keys/status - Get status of all keys
 * - POST /api/admin/signing-keys/rotate - Perform normal key rotation
 * - POST /api/admin/signing-keys/emergency-rotate - Perform emergency rotation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuditLogFromContext,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import type {
  SigningKeysStatusResponse,
  KeyRotationResponse,
  EmergencyRotationRequest,
} from '@authrim/ar-lib-core';

/**
 * Update the cross-worker cache-bust signal for signing keys.
 * Workers check this KV key to decide whether to invalidate their in-memory cache.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantId - Tenant whose signing key was rotated
 */
async function bumpKeyVersion(env: Env, tenantId: string): Promise<void> {
  await env.AUTHRIM_CONFIG?.put(
    `v1:key-version:${tenantId}`,
    Date.now().toString()
  ).catch(() => {});
}

/**
 * Invalidate the per-tenant JWKS KV cache entry.
 */
async function invalidateJwksKvCache(env: Env, tenantId: string): Promise<void> {
  await env.AUTHRIM_CONFIG?.delete(`cache:jwks:${tenantId}`).catch(() => {});
}

/**
 * GET /api/admin/signing-keys/status
 *
 * Get status of all signing keys (active, overlap, revoked)
 * Requires admin authentication (Bearer token or session)
 */
export async function adminSigningKeysStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    // Get key status from per-tenant KeyManager DO
    const keyManagerId = c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    const data = (await keyManager.getStatusRpc()) as SigningKeysStatusResponse;

    // Record audit log (info severity for read operations)
    await createAuditLogFromContext(
      c,
      'signing_keys.status.read',
      'signing_keys',
      data.activeKeyId || 'none',
      { keyCount: data.keys.length },
      'info'
    );

    return c.json(data);
  } catch (error) {
    const log = getLogger(c).module('SIGNING-KEYS');
    log.error('Failed to get signing keys status', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/signing-keys/rotate
 *
 * Perform normal key rotation with 24-hour overlap period
 * Requires admin authentication (Bearer token or session)
 */
export async function adminSigningKeysRotateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    // Perform normal rotation via per-tenant KeyManager DO
    const keyManagerId = c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    const rotationResult = await keyManager.rotateKeysRpc();

    if (!rotationResult || !rotationResult.kid) {
      const log = getLogger(c).module('SIGNING-KEYS');
      log.error('Failed to perform key rotation: no key returned', {});
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const data = { success: true, key: { kid: rotationResult.kid } };

    // Get old active key for audit log
    const oldKeyId = 'previous-key'; // We don't have this info from the response, but it's in overlap now

    // Invalidate JWKS KV cache and bump version signal before returning
    await Promise.allSettled([invalidateJwksKvCache(c.env, tenantId), bumpKeyVersion(c.env, tenantId)]);

    // Record audit log (warning severity for key rotation)
    await createAuditLogFromContext(
      c,
      'signing_keys.rotate.normal',
      'signing_keys',
      data.key.kid,
      { oldKeyId, newKeyId: data.key.kid, overlapPeriod: '24h' },
      'warning'
    );

    const result: KeyRotationResponse = {
      success: true,
      message: 'Normal key rotation completed successfully',
      revokedKeyId: oldKeyId,
      newKeyId: data.key.kid,
      warning: 'Old key will remain valid for 24 hours (overlap period)',
    };

    return c.json(result);
  } catch (error) {
    const log = getLogger(c).module('SIGNING-KEYS');
    log.error('Failed to perform key rotation', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/signing-keys/emergency-rotate
 *
 * Perform emergency key rotation with immediate revocation
 * Use this when a key has been compromised
 * Requires admin authentication (Bearer token or session)
 *
 * Request body:
 * {
 *   "reason": "Key compromise detected - [details]" (minimum 10 characters)
 * }
 */
export async function adminSigningKeysEmergencyRotateHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Parse request body
    const body = (await c.req.json()) as EmergencyRotationRequest;

    // Validate reason (required, minimum 10 characters)
    if (!body.reason || body.reason.length < 10) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'reason' },
      });
    }

    const tenantId = getTenantIdFromContext(c);
    // Execute emergency rotation via per-tenant KeyManager DO
    const keyManagerId = c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    let result: { oldKid: string; newKid: string };
    try {
      result = await keyManager.emergencyRotateKeysRpc(body.reason);
    } catch (error) {
      const log = getLogger(c).module('SIGNING-KEYS');
      log.error('Failed to perform emergency rotation', {}, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Invalidate JWKS KV cache and bump version signal immediately
    const log = getLogger(c).module('SIGNING-KEYS');
    try {
      await Promise.all([
        invalidateJwksKvCache(c.env, tenantId),
        bumpKeyVersion(c.env, tenantId),
      ]);
      log.info('Emergency rotation: JWKS cache and version signal updated', { tenantId });
    } catch (error) {
      log.error('Failed to invalidate JWKS cache after emergency rotation', {}, error as Error);
      // This is critical - log as error but don't fail the operation
    }

    // Record CRITICAL audit log
    await createAuditLogFromContext(
      c,
      'signing_keys.rotate.emergency',
      'signing_keys',
      result.newKid,
      { reason: body.reason, oldKid: result.oldKid, newKid: result.newKid },
      'critical'
    );

    const response_data: KeyRotationResponse = {
      success: true,
      message: 'Emergency key rotation completed successfully',
      revokedKeyId: result.oldKid,
      newKeyId: result.newKid,
      warning: 'Old key has been immediately revoked and removed from JWKS',
    };

    return c.json(response_data);
  } catch (error) {
    const log = getLogger(c).module('SIGNING-KEYS');
    log.error('Failed to perform emergency key rotation', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

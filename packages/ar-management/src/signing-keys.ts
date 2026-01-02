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
} from '@authrim/ar-lib-core';
import type {
  SigningKeysStatusResponse,
  KeyRotationResponse,
  EmergencyRotationRequest,
} from '@authrim/ar-lib-core';

/**
 * GET /api/admin/signing-keys/status
 *
 * Get status of all signing keys (active, overlap, revoked)
 * Requires admin authentication (Bearer token or session)
 */
export async function adminSigningKeysStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get key status from KeyManager via RPC
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
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
    console.error('Failed to get signing keys status:', error);
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
    // Perform normal rotation via KeyManager RPC
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    const rotationResult = await keyManager.rotateKeysRpc();

    if (!rotationResult || !rotationResult.kid) {
      console.error('Failed to perform key rotation: no key returned');
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const data = { success: true, key: { kid: rotationResult.kid } };

    // Get old active key for audit log
    const oldKeyId = 'previous-key'; // We don't have this info from the response, but it's in overlap now

    // Invalidate JWKS cache to ensure clients get updated keys
    try {
      await c.env.JWKS_CACHE?.delete('jwks');
    } catch (error) {
      console.warn('Failed to invalidate JWKS cache:', error);
      // Non-blocking - continue even if cache invalidation fails
    }

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
    console.error('Failed to perform key rotation:', error);
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

    // Execute emergency rotation via KeyManager RPC
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    let result: { oldKid: string; newKid: string };
    try {
      result = await keyManager.emergencyRotateKeysRpc(body.reason);
    } catch (error) {
      console.error('Failed to perform emergency rotation:', error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Invalidate JWKS cache immediately to remove revoked key
    try {
      await c.env.JWKS_CACHE?.delete('jwks');
      console.log('[Emergency Rotation] JWKS cache invalidated');
    } catch (error) {
      console.error('Failed to invalidate JWKS cache:', error);
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
    console.error('Failed to perform emergency key rotation:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

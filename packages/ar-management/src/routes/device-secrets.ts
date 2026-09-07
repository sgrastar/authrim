/**
 * Device Secret Admin API
 *
 * OIDC Native SSO 1.0 (draft-07) Device Secret management.
 * Allows administrators to list and revoke device secrets for users.
 *
 * Endpoints:
 * - GET /api/admin/users/:userId/device-secrets - List user's device secrets
 * - DELETE /api/admin/device-secrets/:id - Revoke a specific device secret
 * - DELETE /api/admin/users/:userId/device-secrets - Revoke all device secrets for a user
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  DeviceSecretRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  createAuthContextFromHono,
  createAuditLogFromContext,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

// Input validation constants
const MAX_REASON_LENGTH = 500;
const REASON_SANITIZE_PATTERN = /[\x00-\x1f\x7f]/gu; // Remove control characters

/**
 * Validate and sanitize the reason field
 * - Limits length to prevent storage abuse
 * - Removes control characters to prevent log injection
 */
function validateReason(
  reason: unknown,
  defaultValue: string
): { valid: true; reason: string } | { valid: false; error: string } {
  if (reason === undefined || reason === null) {
    return { valid: true, reason: defaultValue };
  }

  if (typeof reason !== 'string') {
    return { valid: false, error: 'Reason must be a string' };
  }

  if (reason.length > MAX_REASON_LENGTH) {
    return {
      valid: false,
      error: `Reason must not exceed ${MAX_REASON_LENGTH} characters`,
    };
  }

  // Sanitize: remove control characters (prevent log injection)
  const sanitized = reason.replace(REASON_SANITIZE_PATTERN, '').trim();

  return { valid: true, reason: sanitized || defaultValue };
}

async function parseOptionalReason(
  c: Context<{ Bindings: Env }>,
  defaultValue: string
): Promise<{ valid: true; reason: string } | { valid: false }> {
  const rawBody = await c.req.text();
  if (!rawBody.trim()) {
    return { valid: true, reason: defaultValue };
  }

  try {
    const body = JSON.parse(rawBody) as { reason?: unknown };
    const validation = validateReason(body?.reason, defaultValue);
    return validation.valid ? validation : { valid: false };
  } catch {
    return { valid: false };
  }
}

function parsePaginationValue(
  value: string | undefined,
  defaultValue: number,
  maximum?: number
): number | null {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

/**
 * Device Secret admin response format
 * Note: Never expose the actual secret or hash to admin panel
 */
interface DeviceSecretAdminResponse {
  id: string;
  user_id: string;
  session_id: string;
  device_name?: string;
  device_platform?: string;
  created_at: string;
  expires_at: string;
  last_used_at?: string;
  use_count: number;
  is_active: boolean;
  revoked_at?: string;
  revoke_reason?: string;
}

function getDeviceSecretRepository(c: Context<{ Bindings: Env }>): DeviceSecretRepository {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  return new DeviceSecretRepository(authCtx.coreAdapter, tenantId);
}

/**
 * Transform device secret entity to admin response
 * Excludes sensitive fields (secret_hash)
 */
function toAdminResponse(entity: {
  id: string;
  user_id: string;
  session_id: string;
  device_name?: string;
  device_platform?: string;
  created_at: number;
  expires_at: number;
  last_used_at?: number;
  use_count: number;
  is_active: number;
  revoked_at?: number;
  revoke_reason?: string;
}): DeviceSecretAdminResponse {
  return {
    id: entity.id,
    user_id: entity.user_id,
    session_id: entity.session_id,
    device_name: entity.device_name,
    device_platform: entity.device_platform,
    created_at: new Date(entity.created_at).toISOString(),
    expires_at: new Date(entity.expires_at).toISOString(),
    last_used_at: entity.last_used_at ? new Date(entity.last_used_at).toISOString() : undefined,
    use_count: entity.use_count,
    is_active: entity.is_active === 1,
    revoked_at: entity.revoked_at ? new Date(entity.revoked_at).toISOString() : undefined,
    revoke_reason: entity.revoke_reason,
  };
}

/**
 * GET /api/admin/users/:userId/device-secrets
 *
 * List all device secrets for a specific user.
 * Returns metadata only (never exposes actual secrets).
 *
 * Query parameters:
 * - include_revoked: boolean (default: false) - Include revoked secrets
 * - limit: number (default: 50, max: 100)
 * - offset: number (default: 0)
 */
export async function listUserDeviceSecrets(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DeviceSecretsAPI');
  const userId = c.req.param('userId')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'userId' },
    });
  }

  try {
    const includeRevoked = c.req.query('include_revoked') === 'true';
    const limit = parsePaginationValue(c.req.query('limit'), 50, 100);
    const offset = parsePaginationValue(c.req.query('offset'), 0);
    if (limit === null || limit < 1 || offset === null) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const repo = getDeviceSecretRepository(c);

    // Get all device secrets for user
    const allSecrets = await repo.findByUserId(userId);

    // Filter based on include_revoked
    const filteredSecrets = includeRevoked
      ? allSecrets
      : allSecrets.filter((s) => s.is_active === 1 && !s.revoked_at);

    // Apply pagination
    const paginatedSecrets = filteredSecrets.slice(offset, offset + limit);

    // Count active vs revoked
    const activeCount = allSecrets.filter((s) => s.is_active === 1 && !s.revoked_at).length;
    const revokedCount = allSecrets.filter((s) => s.revoked_at).length;
    const expiredCount = allSecrets.filter(
      (s) => !s.revoked_at && s.expires_at < Date.now()
    ).length;

    return c.json({
      items: paginatedSecrets.map(toAdminResponse),
      pagination: {
        total: filteredSecrets.length,
        limit,
        offset,
        has_more: offset + limit < filteredSecrets.length,
      },
      summary: {
        total: allSecrets.length,
        active: activeCount,
        revoked: revokedCount,
        expired: expiredCount,
      },
    });
  } catch (error) {
    log.error('Error listing device secrets', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/device-secrets/:id
 *
 * Get a specific device secret by ID.
 */
export async function getDeviceSecret(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DeviceSecretsAPI');
  const id = c.req.param('id')!;

  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const repo = getDeviceSecretRepository(c);

    const secret = await repo.findById(id);

    if (!secret) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json(toAdminResponse(secret));
  } catch (error) {
    log.error('Error getting device secret', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/device-secrets/:id
 *
 * Revoke a specific device secret.
 *
 * Request body (optional):
 * - reason: string - Reason for revocation (for audit purposes)
 */
export async function revokeDeviceSecret(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DeviceSecretsAPI');
  const id = c.req.param('id')!;

  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const parsedReason = await parseOptionalReason(c, 'admin_revocation');
    if (!parsedReason.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const reason = parsedReason.reason;

    const repo = getDeviceSecretRepository(c);

    // Check if secret exists
    const existing = await repo.findById(id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (existing.revoked_at) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const success = await repo.revoke(id, reason);

    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    await createAuditLogFromContext(c, 'device_secret.revoke', 'device_secret', id, {
      user_id: existing.user_id,
      reason,
    });

    log.info('Revoked device secret', { id, userId: existing.user_id, reason });

    return c.json({
      success: true,
      id,
      revoked_at: new Date().toISOString(),
      reason,
    });
  } catch (error) {
    log.error('Error revoking device secret', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/users/:userId/device-secrets
 *
 * Revoke all device secrets for a specific user.
 * Useful for emergency account lockdown or user deletion.
 *
 * Request body (optional):
 * - reason: string - Reason for revocation (for audit purposes)
 */
export async function revokeAllUserDeviceSecrets(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('DeviceSecretsAPI');
  const userId = c.req.param('userId')!;

  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'userId' },
    });
  }

  try {
    const parsedReason = await parseOptionalReason(c, 'admin_bulk_revocation');
    if (!parsedReason.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const reason = parsedReason.reason;

    const repo = getDeviceSecretRepository(c);

    const revokedCount = await repo.revokeByUserId(userId, getTenantIdFromContext(c), reason);

    await createAuditLogFromContext(c, 'device_secret.revoke_all', 'user', userId, {
      revoked_count: revokedCount,
      reason,
    });

    log.info('Revoked user device secrets', { userId, revokedCount, reason });

    return c.json({
      success: true,
      user_id: userId,
      revoked_count: revokedCount,
      revoked_at: new Date().toISOString(),
      reason,
    });
  } catch (error) {
    log.error('Error revoking user device secrets', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/device-secrets/cleanup
 *
 * Clean up expired device secrets from the database.
 * This is typically called by a scheduled job, but can be triggered manually.
 */
export async function cleanupExpiredDeviceSecrets(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const log = getLogger(c).module('DeviceSecretsAPI');
  try {
    const repo = getDeviceSecretRepository(c);

    const cleanedCount = await repo.cleanupExpired();

    await createAuditLogFromContext(c, 'device_secret.cleanup', 'device_secret', 'expired', {
      cleaned_count: cleanedCount,
    });

    log.info('Cleaned up expired device secrets', { cleanedCount });

    return c.json({
      success: true,
      cleaned_count: cleanedCount,
      cleaned_at: new Date().toISOString(),
    });
  } catch (error) {
    log.error('Error cleaning up expired device secrets', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

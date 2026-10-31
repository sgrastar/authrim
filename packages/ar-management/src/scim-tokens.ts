/**
 * SCIM Token Management Endpoints
 *
 * Admin API for managing SCIM provisioning tokens
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateScimToken, revokeScimToken, listScimTokens } from '@authrim/ar-lib-scim';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  createAuditLogFromContext,
  getLogger,
  getTenantIdFromContext,
  resolveScimTokenExpiryDays,
  type ScimTokenExpiryDays,
} from '@authrim/ar-lib-core';

/**
 * Validation constraints for SCIM token creation. The lifetime's default and maximum are the
 * tenant's (federation.scim_token_default_expiry and federation.scim_token_max_expiry, one year
 * at most).
 */
const SCIM_TOKEN_VALIDATION = {
  // Token expiry: minimum 1 day
  EXPIRES_IN_DAYS_MIN: 1,
  // Description: maximum 256 characters
  DESCRIPTION_MAX_LENGTH: 256,
  DESCRIPTION_DEFAULT: 'SCIM provisioning token',
};

/**
 * Validates and sanitizes SCIM token creation input
 */
function validateScimTokenInput(
  body: { description?: unknown; expiresInDays?: unknown },
  expiry: ScimTokenExpiryDays
): {
  valid: boolean;
  errors: string[];
  sanitized: { description: string; expiresInDays: number };
} {
  const errors: string[] = [];

  // Validate expiresInDays
  let expiresInDays = expiry.defaultDays;

  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const requested = body.expiresInDays;

    // Check if it's a valid number
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      errors.push('expiresInDays must be a valid number');
    } else if (!Number.isInteger(requested)) {
      errors.push('expiresInDays must be an integer');
    } else if (requested < SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_MIN) {
      errors.push(
        `expiresInDays must be at least ${SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_MIN} day(s)`
      );
    } else if (requested > expiry.maxDays) {
      errors.push(`expiresInDays must not exceed ${expiry.maxDays} days`);
    } else {
      expiresInDays = requested;
    }
  }

  // Validate description
  let description = SCIM_TOKEN_VALIDATION.DESCRIPTION_DEFAULT;

  if (body.description !== undefined && body.description !== null) {
    const desc = body.description;

    // Check if it's a string
    if (typeof desc !== 'string') {
      errors.push('description must be a string');
    } else {
      // Trim and check length
      const trimmed = desc.trim();

      if (trimmed.length === 0) {
        // Use default for empty string
        description = SCIM_TOKEN_VALIDATION.DESCRIPTION_DEFAULT;
      } else if (trimmed.length > SCIM_TOKEN_VALIDATION.DESCRIPTION_MAX_LENGTH) {
        errors.push(
          `description must not exceed ${SCIM_TOKEN_VALIDATION.DESCRIPTION_MAX_LENGTH} characters`
        );
      } else {
        // Sanitize: remove control characters but allow Unicode
        description = trimmed.replace(/[\x00-\x1F\x7F]/gu, '');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: { description, expiresInDays },
  };
}

/**
 * GET /api/admin/scim-tokens - List all SCIM tokens
 */
export async function adminScimTokensListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const tokens = await listScimTokens(c.env, { tenantId });

    return c.json({
      tokens,
      total: tokens.length,
    });
  } catch (error) {
    const log = getLogger(c).module('SCIM-TOKENS');
    log.error('Failed to list SCIM tokens', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/scim-tokens - Generate a new SCIM token
 */
export async function adminScimTokenCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Parse request body with unknown types for validation
    let body: { description?: unknown; expiresInDays?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantId = getTenantIdFromContext(c);

    // The tenant's default and maximum lifetime. Unreadable settings issue nothing (the catch
    // below answers 500): a maximum that an outage lifted would allow a long-lived credential.
    const expiry = await resolveScimTokenExpiryDays(c.env, tenantId);

    // Validate and sanitize input
    const validation = validateScimTokenInput(body, expiry);

    if (!validation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const { description, expiresInDays } = validation.sanitized;

    const { token, tokenHash } = await generateScimToken(c.env, {
      tenantId,
      description,
      expiresInDays,
      enabled: true,
    });

    await createAuditLogFromContext(c, 'scim.token.create', 'scim_token', tokenHash.slice(0, 8), {
      tenantId,
      description,
      expiresInDays,
    });

    // Return the token only once (it won't be shown again)
    return c.json(
      {
        token, // Plain text token (show to user only once)
        tokenHash,
        tenantId,
        description,
        expiresInDays,
        message:
          'Token created successfully. Save this token securely - it will not be shown again.',
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('SCIM-TOKENS');
    log.error('Failed to create SCIM token', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/scim-tokens/:tokenHash - Revoke a SCIM token
 */
export async function adminScimTokenRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tokenHash = c.req.param('tokenHash')!;
    const tenantId = getTenantIdFromContext(c);

    if (!tokenHash) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'tokenHash' },
      });
    }

    const success = await revokeScimToken(c.env, tokenHash, { tenantId });

    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLogFromContext(
      c,
      'scim.token.revoke',
      'scim_token',
      tokenHash.slice(0, 8),
      { tenantId },
      'warning'
    );

    return c.json({
      message: 'Token revoked successfully',
    });
  } catch (error) {
    const log = getLogger(c).module('SCIM-TOKENS');
    log.error('Failed to revoke SCIM token', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * SCIM Token Management Endpoints
 *
 * Admin API for managing SCIM provisioning tokens
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateScimToken, revokeScimToken, listScimTokens } from '@authrim/ar-lib-scim';
import { createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';

/**
 * Validation constraints for SCIM token creation
 */
const SCIM_TOKEN_VALIDATION = {
  // Token expiry: minimum 1 day, maximum 10 years (3650 days)
  EXPIRES_IN_DAYS_MIN: 1,
  EXPIRES_IN_DAYS_MAX: 3650,
  EXPIRES_IN_DAYS_DEFAULT: 365,
  // Description: maximum 256 characters
  DESCRIPTION_MAX_LENGTH: 256,
  DESCRIPTION_DEFAULT: 'SCIM provisioning token',
};

/**
 * Validates and sanitizes SCIM token creation input
 */
function validateScimTokenInput(body: { description?: unknown; expiresInDays?: unknown }): {
  valid: boolean;
  errors: string[];
  sanitized: { description: string; expiresInDays: number };
} {
  const errors: string[] = [];

  // Validate expiresInDays
  let expiresInDays = SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_DEFAULT;

  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const expiry = body.expiresInDays;

    // Check if it's a valid number
    if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
      errors.push('expiresInDays must be a valid number');
    } else if (!Number.isInteger(expiry)) {
      errors.push('expiresInDays must be an integer');
    } else if (expiry < SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_MIN) {
      errors.push(
        `expiresInDays must be at least ${SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_MIN} day(s)`
      );
    } else if (expiry > SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_MAX) {
      errors.push(
        `expiresInDays must not exceed ${SCIM_TOKEN_VALIDATION.EXPIRES_IN_DAYS_MAX} days (10 years)`
      );
    } else {
      expiresInDays = expiry;
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
        description = trimmed.replace(/[\x00-\x1F\x7F]/g, '');
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
    const tokens = await listScimTokens(c.env);

    return c.json({
      tokens,
      total: tokens.length,
    });
  } catch (error) {
    console.error('List SCIM tokens error:', error);
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

    // Validate and sanitize input
    const validation = validateScimTokenInput(body);

    if (!validation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const { description, expiresInDays } = validation.sanitized;

    const { token, tokenHash } = await generateScimToken(c.env, {
      description,
      expiresInDays,
      enabled: true,
    });

    // Return the token only once (it won't be shown again)
    return c.json(
      {
        token, // Plain text token (show to user only once)
        tokenHash,
        description,
        expiresInDays,
        message:
          'Token created successfully. Save this token securely - it will not be shown again.',
      },
      201
    );
  } catch (error) {
    console.error('Create SCIM token error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/scim-tokens/:tokenHash - Revoke a SCIM token
 */
export async function adminScimTokenRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tokenHash = c.req.param('tokenHash');

    if (!tokenHash) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'tokenHash' },
      });
    }

    const success = await revokeScimToken(c.env, tokenHash);

    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({
      message: 'Token revoked successfully',
    });
  } catch (error) {
    console.error('Revoke SCIM token error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

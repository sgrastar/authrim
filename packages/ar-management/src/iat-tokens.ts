/**
 * Initial Access Token Management Endpoints
 *
 * Admin API for managing Initial Access Tokens (IAT) for Dynamic Client Registration.
 * Follows the same pattern as SCIM tokens for consistency.
 *
 * Security: Tokens are stored with SHA-256 hash as the key (prefix: iat:)
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  hashInitialAccessToken,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  scheduleAuditLogFromContext,
} from '@authrim/ar-lib-core';

/**
 * Validation constraints for IAT creation
 */
const IAT_VALIDATION = {
  EXPIRES_IN_DAYS_MIN: 1,
  EXPIRES_IN_DAYS_MAX: 365,
  EXPIRES_IN_DAYS_DEFAULT: 30,
  DESCRIPTION_MAX_LENGTH: 256,
  DESCRIPTION_DEFAULT: 'Initial Access Token for Dynamic Client Registration',
};

/**
 * Token metadata stored in KV
 */
interface IATMetadata {
  description: string;
  createdAt: string;
  expiresAt: string | null;
  single_use: boolean;
  type: 'iat';
}

/**
 * Validates and sanitizes IAT creation input
 */
function validateIATInput(body: {
  description?: unknown;
  expiresInDays?: unknown;
  single_use?: unknown;
}): {
  valid: boolean;
  errors: string[];
  sanitized: { description: string; expiresInDays: number; single_use: boolean };
} {
  const errors: string[] = [];

  // Validate expiresInDays
  let expiresInDays = IAT_VALIDATION.EXPIRES_IN_DAYS_DEFAULT;

  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const expiry = body.expiresInDays;

    if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
      errors.push('expiresInDays must be a valid number');
    } else if (!Number.isInteger(expiry)) {
      errors.push('expiresInDays must be an integer');
    } else if (expiry < IAT_VALIDATION.EXPIRES_IN_DAYS_MIN) {
      errors.push(`expiresInDays must be at least ${IAT_VALIDATION.EXPIRES_IN_DAYS_MIN} day(s)`);
    } else if (expiry > IAT_VALIDATION.EXPIRES_IN_DAYS_MAX) {
      errors.push(`expiresInDays must not exceed ${IAT_VALIDATION.EXPIRES_IN_DAYS_MAX} days`);
    } else {
      expiresInDays = expiry;
    }
  }

  // Validate description
  let description = IAT_VALIDATION.DESCRIPTION_DEFAULT;

  if (body.description !== undefined && body.description !== null) {
    const desc = body.description;

    if (typeof desc !== 'string') {
      errors.push('description must be a string');
    } else {
      const trimmed = desc.trim();

      if (trimmed.length === 0) {
        description = IAT_VALIDATION.DESCRIPTION_DEFAULT;
      } else if (trimmed.length > IAT_VALIDATION.DESCRIPTION_MAX_LENGTH) {
        errors.push(
          `description must not exceed ${IAT_VALIDATION.DESCRIPTION_MAX_LENGTH} characters`
        );
      } else {
        description = trimmed.replace(/[\x00-\x1F\x7F]/gu, '');
      }
    }
  }

  // Validate single_use
  let single_use = false;
  if (body.single_use !== undefined && body.single_use !== null) {
    if (typeof body.single_use !== 'boolean') {
      errors.push('single_use must be a boolean');
    } else {
      single_use = body.single_use;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: { description, expiresInDays, single_use },
  };
}

/**
 * Generate a cryptographically secure token
 */
function generateToken(): string {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  return Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * GET /api/admin/iat-tokens - List all Initial Access Tokens
 */
export async function adminIATListHandler(c: Context<{ Bindings: Env }>) {
  try {
    if (!c.env.INITIAL_ACCESS_TOKENS) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const tokens: Array<{
      tokenHash: string;
      description: string;
      createdAt: string;
      expiresAt: string | null;
      single_use: boolean;
    }> = [];

    const list = await c.env.INITIAL_ACCESS_TOKENS.list({ prefix: 'iat:' });

    for (const key of list.keys) {
      const value = await c.env.INITIAL_ACCESS_TOKENS.get(key.name);
      if (value) {
        const tokenData = JSON.parse(value) as IATMetadata;
        tokens.push({
          tokenHash: key.name.replace('iat:', ''),
          description: tokenData.description,
          createdAt: tokenData.createdAt,
          expiresAt: tokenData.expiresAt,
          single_use: tokenData.single_use,
        });
      }
    }

    return c.json({
      tokens,
      total: tokens.length,
    });
  } catch (error) {
    const log = getLogger(c).module('IAT-TOKENS');
    log.error('Failed to list IAT tokens', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/iat-tokens - Generate a new Initial Access Token
 */
export async function adminIATCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    if (!c.env.INITIAL_ACCESS_TOKENS) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    let body: { description?: unknown; expiresInDays?: unknown; single_use?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const validation = validateIATInput(body);

    if (!validation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const { description, expiresInDays, single_use } = validation.sanitized;

    // Generate token and hash
    const token = generateToken();
    const tokenHash = await hashInitialAccessToken(token);

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const tokenData: IATMetadata = {
      description,
      createdAt: new Date().toISOString(),
      expiresAt,
      single_use,
      type: 'iat',
    };

    // Store with hash as key
    await c.env.INITIAL_ACCESS_TOKENS.put(`iat:${tokenHash}`, JSON.stringify(tokenData), {
      expirationTtl: expiresInDays * 24 * 60 * 60,
    });

    // Write audit log (non-blocking) - uses waitUntil for reliable completion
    scheduleAuditLogFromContext(c, 'iat.token.create', 'iat_token', tokenHash.slice(0, 8), {
      description,
      expiresInDays,
      single_use,
    });

    return c.json(
      {
        token, // Plain text token (show to user only once)
        tokenHash,
        description,
        expiresInDays,
        single_use,
        message:
          'Token created successfully. Save this token securely - it will not be shown again.',
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('IAT-TOKENS');
    log.error('Failed to create IAT token', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/iat-tokens/:tokenHash - Revoke an Initial Access Token
 */
export async function adminIATRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    if (!c.env.INITIAL_ACCESS_TOKENS) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const tokenHash = c.req.param('tokenHash');

    if (!tokenHash) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'tokenHash' },
      });
    }

    // Check if token exists
    const existing = await c.env.INITIAL_ACCESS_TOKENS.get(`iat:${tokenHash}`);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await c.env.INITIAL_ACCESS_TOKENS.delete(`iat:${tokenHash}`);

    // Write audit log (non-blocking) - uses waitUntil for reliable completion
    scheduleAuditLogFromContext(
      c,
      'iat.token.revoke',
      'iat_token',
      tokenHash.slice(0, 8),
      {},
      'warning'
    );

    return c.json({
      message: 'Token revoked successfully',
    });
  } catch (error) {
    const log = getLogger(c).module('IAT-TOKENS');
    log.error('Failed to revoke IAT token', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

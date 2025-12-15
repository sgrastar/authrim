/**
 * Initial Access Token Management Endpoints
 *
 * Admin API for managing Initial Access Tokens (IAT) for Dynamic Client Registration.
 * Follows the same pattern as SCIM tokens for consistency.
 *
 * Security: Tokens are stored with SHA-256 hash as the key (prefix: iat:)
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared/types/env';
import { hashInitialAccessToken } from '@authrim/shared';

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
        description = trimmed.replace(/[\x00-\x1F\x7F]/g, '');
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
      return c.json(
        {
          error: 'kv_not_configured',
          message: 'INITIAL_ACCESS_TOKENS KV namespace is not configured',
        },
        500
      );
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
    console.error('List IAT tokens error:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to list Initial Access Tokens',
      },
      500
    );
  }
}

/**
 * POST /api/admin/iat-tokens - Generate a new Initial Access Token
 */
export async function adminIATCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    if (!c.env.INITIAL_ACCESS_TOKENS) {
      return c.json(
        {
          error: 'kv_not_configured',
          message: 'INITIAL_ACCESS_TOKENS KV namespace is not configured',
        },
        500
      );
    }

    let body: { description?: unknown; expiresInDays?: unknown; single_use?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          message: 'Invalid JSON in request body',
        },
        400
      );
    }

    const validation = validateIATInput(body);

    if (!validation.valid) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'Validation failed',
          details: validation.errors,
        },
        400
      );
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
    console.error('Create IAT token error:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to create Initial Access Token',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/iat-tokens/:tokenHash - Revoke an Initial Access Token
 */
export async function adminIATRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    if (!c.env.INITIAL_ACCESS_TOKENS) {
      return c.json(
        {
          error: 'kv_not_configured',
          message: 'INITIAL_ACCESS_TOKENS KV namespace is not configured',
        },
        500
      );
    }

    const tokenHash = c.req.param('tokenHash');

    if (!tokenHash) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'Token hash is required',
        },
        400
      );
    }

    // Check if token exists
    const existing = await c.env.INITIAL_ACCESS_TOKENS.get(`iat:${tokenHash}`);
    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          message: 'Token not found',
        },
        404
      );
    }

    await c.env.INITIAL_ACCESS_TOKENS.delete(`iat:${tokenHash}`);

    return c.json({
      message: 'Token revoked successfully',
    });
  } catch (error) {
    console.error('Revoke IAT token error:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to revoke Initial Access Token',
      },
      500
    );
  }
}

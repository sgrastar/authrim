/**
 * SCIM Token Management Endpoints
 *
 * Admin API for managing SCIM provisioning tokens
 */

import type { Context } from 'hono';
import type { Env } from '../../shared/src/types/env';
import {
  generateScimToken,
  revokeScimToken,
  listScimTokens,
} from '../../shared/src/middleware/scim-auth';

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
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to list SCIM tokens',
      },
      500
    );
  }
}

/**
 * POST /api/admin/scim-tokens - Generate a new SCIM token
 */
export async function adminScimTokenCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      description?: string;
      expiresInDays?: number;
    }>();

    const { token, tokenHash } = await generateScimToken(c.env, {
      description: body.description || 'SCIM provisioning token',
      expiresInDays: body.expiresInDays || 365, // Default: 1 year
      enabled: true,
    });

    // Return the token only once (it won't be shown again)
    return c.json({
      token, // Plain text token (show to user only once)
      tokenHash,
      description: body.description || 'SCIM provisioning token',
      expiresInDays: body.expiresInDays || 365,
      message: 'Token created successfully. Save this token securely - it will not be shown again.',
    }, 201);
  } catch (error) {
    console.error('Create SCIM token error:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to create SCIM token',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/scim-tokens/:tokenHash - Revoke a SCIM token
 */
export async function adminScimTokenRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
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

    const success = await revokeScimToken(c.env, tokenHash);

    if (!success) {
      return c.json(
        {
          error: 'not_found',
          message: 'Token not found',
        },
        404
      );
    }

    return c.json({
      message: 'Token revoked successfully',
    });
  } catch (error) {
    console.error('Revoke SCIM token error:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to revoke SCIM token',
      },
      500
    );
  }
}

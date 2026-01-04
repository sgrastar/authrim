/**
 * Logout Failures Admin API
 *
 * GET  /api/admin/settings/logout/failures           - List all failed logout notifications
 * GET  /api/admin/settings/logout/failures/:clientId - Get failure details for a client
 * DELETE /api/admin/settings/logout/failures/:clientId - Clear failure record for a client
 * DELETE /api/admin/settings/logout/failures         - Clear all failure records
 *
 * Phase A-6: Backchannel Logout failure visibility
 *
 * Design Note (from review):
 * - Admin UI should show recent logout failures per client
 * - Helps operators identify RPs with misconfigured backchannel_logout_uri
 * - Records are stored in KV with 7-day TTL by default
 */

import type { Context } from 'hono';
import { LogoutKVHelpers, getLogger, type Env } from '@authrim/ar-lib-core';

/**
 * GET /api/admin/settings/logout/failures
 * List all clients with failure records
 *
 * Query parameters:
 * - limit: Max number of results (default: 100, max: 1000)
 */
export async function listLogoutFailures(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutFailuresAPI');
  // Get KV namespace
  const kv = c.env.SETTINGS || c.env.STATE_STORE;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS or STATE_STORE KV namespace is not configured',
      },
      500
    );
  }

  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(1, parseInt(limitParam || '100', 10) || 100), 1000);

  try {
    // Get list of client IDs with failures
    const clientIds = await LogoutKVHelpers.listFailures(kv, limit);

    // Get failure details for each client
    const failures = await Promise.all(
      clientIds.map(async (clientId) => {
        const failure = await LogoutKVHelpers.getFailure(kv, clientId);
        return {
          clientId,
          ...failure,
        };
      })
    );

    // Sort by timestamp (most recent first)
    failures.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return c.json({
      total: failures.length,
      limit,
      failures,
    });
  } catch (error) {
    log.error('Error listing failures', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list logout failures',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/logout/failures/:clientId
 * Get failure details for a specific client
 */
export async function getLogoutFailure(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutFailuresAPI');
  const clientId = c.req.param('clientId');

  if (!clientId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'clientId parameter is required',
      },
      400
    );
  }

  // Get KV namespace
  const kv = c.env.SETTINGS || c.env.STATE_STORE;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS or STATE_STORE KV namespace is not configured',
      },
      500
    );
  }

  try {
    const failure = await LogoutKVHelpers.getFailure(kv, clientId);

    if (!failure) {
      return c.json(
        {
          error: 'not_found',
          error_description: `No failure record found for client: ${clientId}`,
        },
        404
      );
    }

    return c.json({
      clientId,
      ...failure,
    });
  } catch (error) {
    log.error('Error getting failure', { clientId }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get logout failure',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/logout/failures/:clientId
 * Clear failure record for a specific client
 */
export async function clearLogoutFailure(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutFailuresAPI');
  const clientId = c.req.param('clientId');

  if (!clientId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'clientId parameter is required',
      },
      400
    );
  }

  // Get KV namespace
  const kv = c.env.SETTINGS || c.env.STATE_STORE;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS or STATE_STORE KV namespace is not configured',
      },
      500
    );
  }

  try {
    await LogoutKVHelpers.clearFailure(kv, clientId);

    return c.json({
      success: true,
      clientId,
      note: 'Failure record cleared.',
    });
  } catch (error) {
    log.error('Error clearing failure', { clientId }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to clear logout failure',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/logout/failures
 * Clear all failure records
 *
 * Note: This uses KV list operation which may have limitations
 * for very large numbers of records.
 */
export async function clearAllLogoutFailures(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutFailuresAPI');
  // Get KV namespace
  const kv = c.env.SETTINGS || c.env.STATE_STORE;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS or STATE_STORE KV namespace is not configured',
      },
      500
    );
  }

  try {
    // Get all client IDs with failures
    const clientIds = await LogoutKVHelpers.listFailures(kv, 1000);

    // Clear each one
    await Promise.all(clientIds.map((clientId) => LogoutKVHelpers.clearFailure(kv, clientId)));

    return c.json({
      success: true,
      cleared: clientIds.length,
      note: 'All failure records cleared.',
    });
  } catch (error) {
    log.error('Error clearing all failures', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to clear all logout failures',
      },
      500
    );
  }
}

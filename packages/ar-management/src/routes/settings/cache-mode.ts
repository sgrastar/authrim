/**
 * Cache Mode Settings API
 *
 * Manages cache mode configuration for KV caching optimization.
 * Supports two modes:
 * - maintenance: Short TTL (30s) for development and client setting changes
 * - fixed: Long TTL for production use
 *
 * Hierarchical configuration:
 * - Platform-level: Default for all clients (v1:cache-mode:platform)
 * - Client-level: Override for specific clients (v1:cache-mode:client:{clientId})
 *
 * @see P0 KV Cache Optimization Plan
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  type CacheMode,
  FIXED_MODE_TTL,
  MAINTENANCE_MODE_TTL,
  DEFAULT_CACHE_MODE,
  getPlatformCacheMode,
  setPlatformCacheMode,
  getClientCacheMode,
  setClientCacheMode,
  getCacheMode,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface PlatformCacheModeResponse {
  mode: CacheMode | null;
  effective: CacheMode;
  ttl_config: {
    clientMetadata: number;
    redirectUris: number;
    grantTypes: number;
    scopes: number;
    jwks: number;
    clientSecret: number;
    tenant: number;
    policy: number;
  };
}

interface ClientCacheModeResponse {
  client_id: string;
  mode: CacheMode | null;
  effective: CacheMode;
  uses_platform_default: boolean;
}

// =============================================================================
// Platform Cache Mode Endpoints
// =============================================================================

/**
 * GET /api/admin/settings/cache-mode
 * Get platform-level cache mode configuration
 */
export async function getPlatformCacheModeHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const platformMode = await getPlatformCacheMode(c.env);
    const effectiveMode = await getCacheMode(c.env);

    const ttlConfig = effectiveMode === 'maintenance' ? MAINTENANCE_MODE_TTL : FIXED_MODE_TTL;

    const response: PlatformCacheModeResponse = {
      mode: platformMode,
      effective: effectiveMode,
      ttl_config: ttlConfig,
    };

    return c.json(response);
  } catch (error) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get cache mode configuration',
      },
      500
    );
  }
}

/**
 * POST /api/admin/settings/cache-mode
 * Set platform-level cache mode
 *
 * Body: { mode: 'maintenance' | 'fixed' }
 */
export async function setPlatformCacheModeHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const body = await c.req.json<{ mode?: string }>();

    if (!body.mode || (body.mode !== 'maintenance' && body.mode !== 'fixed')) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: "Invalid mode. Must be 'maintenance' or 'fixed'.",
        },
        400
      );
    }

    await setPlatformCacheMode(c.env, body.mode as CacheMode);

    const ttlConfig = body.mode === 'maintenance' ? MAINTENANCE_MODE_TTL : FIXED_MODE_TTL;

    return c.json({
      success: true,
      mode: body.mode,
      ttl_config: ttlConfig,
      message: `Platform cache mode set to '${body.mode}'`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not available')) {
      return c.json(
        {
          error: 'service_unavailable',
          error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        },
        503
      );
    }

    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to set cache mode configuration',
      },
      500
    );
  }
}

// =============================================================================
// Client-Specific Cache Mode Endpoints
// =============================================================================

/**
 * GET /api/admin/clients/:clientId/cache-mode
 * Get client-specific cache mode configuration
 */
export async function getClientCacheModeHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const clientId = c.req.param('clientId');

    if (!clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Client ID is required',
        },
        400
      );
    }

    const clientMode = await getClientCacheMode(c.env, clientId);
    const effectiveMode = await getCacheMode(c.env, clientId);

    const response: ClientCacheModeResponse = {
      client_id: clientId,
      mode: clientMode,
      effective: effectiveMode,
      uses_platform_default: clientMode === null,
    };

    return c.json(response);
  } catch (error) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get client cache mode configuration',
      },
      500
    );
  }
}

/**
 * POST /api/admin/clients/:clientId/cache-mode
 * Set client-specific cache mode
 *
 * Body: { mode: 'maintenance' | 'fixed' | null }
 *
 * Setting mode to null removes the client-specific override,
 * causing the client to use the platform default.
 */
export async function setClientCacheModeHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const clientId = c.req.param('clientId');

    if (!clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Client ID is required',
        },
        400
      );
    }

    const body = await c.req.json<{ mode?: string | null }>();

    // Allow null to remove client-specific override
    if (body.mode !== null && body.mode !== 'maintenance' && body.mode !== 'fixed') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: "Invalid mode. Must be 'maintenance', 'fixed', or null.",
        },
        400
      );
    }

    await setClientCacheMode(c.env, clientId, body.mode as CacheMode | null);

    const effectiveMode = await getCacheMode(c.env, clientId);

    return c.json({
      success: true,
      client_id: clientId,
      mode: body.mode,
      effective: effectiveMode,
      uses_platform_default: body.mode === null,
      message:
        body.mode === null
          ? `Client '${clientId}' now uses platform default cache mode`
          : `Client '${clientId}' cache mode set to '${body.mode}'`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not available')) {
      return c.json(
        {
          error: 'service_unavailable',
          error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        },
        503
      );
    }

    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to set client cache mode configuration',
      },
      500
    );
  }
}

// =============================================================================
// Cache Mode Info Endpoint
// =============================================================================

/**
 * GET /api/admin/settings/cache-mode/info
 * Get information about cache mode configuration options
 */
export async function getCacheModeInfoHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json({
    modes: {
      maintenance: {
        description: 'Short TTL (30s) for development and client setting changes',
        ttl_config: MAINTENANCE_MODE_TTL,
        use_cases: [
          'Client metadata changes during development',
          'Testing redirect URI changes',
          'Debugging authentication issues',
          'Initial setup and configuration',
        ],
      },
      fixed: {
        description: 'Long TTL for production use',
        ttl_config: FIXED_MODE_TTL,
        use_cases: [
          'Stable production environment',
          'High-traffic scenarios requiring performance',
          'After completing client configuration changes',
        ],
      },
    },
    default_mode: DEFAULT_CACHE_MODE,
    hierarchy: {
      description: 'Cache mode is determined in the following order',
      order: [
        '1. Client-specific mode (v1:cache-mode:client:{clientId})',
        '2. Platform-level mode (v1:cache-mode:platform)',
        '3. Default mode (fixed)',
      ],
    },
    kv_key_version: 'v1',
    note: 'Use maintenance mode during active development, then switch to fixed mode for production.',
  });
}

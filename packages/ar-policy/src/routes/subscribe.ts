/**
 * WebSocket Subscription Routes
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Provides WebSocket endpoint for real-time permission change notifications.
 *
 * Endpoint:
 * - GET /api/check/subscribe - WebSocket upgrade for permission change subscriptions
 *
 * Authentication:
 * - API Key: Authorization: Bearer chk_xxx (in query param for WebSocket)
 * - Access Token: Authorization: Bearer <JWT> (in query param for WebSocket)
 *
 * Note: WebSocket connections cannot send custom headers during upgrade,
 * so we accept the token as a query parameter.
 */

import { Hono } from 'hono';
import type { KVNamespace, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { Env as SharedEnv } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  type CheckAuthContext,
} from '../middleware/check-auth';

// =============================================================================
// Types
// =============================================================================

interface Env extends SharedEnv {
  /** Internal API secret for service-to-service auth */
  POLICY_API_SECRET: string;
  /** KV namespace for Check API caching */
  CHECK_CACHE_KV?: KVNamespace;
  /** PermissionChangeHub Durable Object binding */
  PERMISSION_CHANGE_HUB?: DurableObjectNamespace;
  /** Default tenant ID */
  DEFAULT_TENANT_ID?: string;
  /** Feature flag: Enable Check API */
  ENABLE_CHECK_API?: string;
  /** Feature flag: Enable WebSocket Push */
  CHECK_API_WEBSOCKET_ENABLED?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if Check API feature is enabled
 */
function isCheckApiEnabled(env: Env): boolean {
  return env.ENABLE_CHECK_API === 'true';
}

/**
 * Check if WebSocket Push feature is enabled
 */
function isWebSocketEnabled(env: Env): boolean {
  return env.CHECK_API_WEBSOCKET_ENABLED === 'true';
}

// =============================================================================
// Routes
// =============================================================================

const subscribeRoutes = new Hono<{ Bindings: Env }>();

/**
 * WebSocket subscription endpoint
 * GET /api/check/subscribe
 *
 * Query parameters:
 * - token: Bearer token (API Key or Access Token)
 * - tenant_id: Optional tenant ID override
 *
 * Example:
 * wss://example.com/api/check/subscribe?token=chk_xxxx&tenant_id=default
 */
subscribeRoutes.get('/subscribe', async (c) => {
  // Check if Check API is enabled
  if (!isCheckApiEnabled(c.env)) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  // Check if WebSocket Push is enabled
  if (!isWebSocketEnabled(c.env)) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  // Check if PermissionChangeHub DO is available
  if (!c.env.PERMISSION_CHANGE_HUB) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Check for WebSocket upgrade request
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Get token from query parameter (WebSocket can't send custom headers during upgrade)
  const token = c.req.query('token');
  if (!token) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Authenticate using the token
  const authContext: CheckAuthContext = {
    db: c.env.DB,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    defaultTenantId: c.env.DEFAULT_TENANT_ID,
  };

  const auth = await authenticateCheckApiRequest(`Bearer ${token}`, authContext);

  if (!auth.authenticated) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if subscribe operation is allowed
  if (!isOperationAllowed(auth, 'subscribe')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  // Get tenant ID from auth context or query param
  const tenantId =
    c.req.query('tenant_id') || auth.tenantId || c.env.DEFAULT_TENANT_ID || 'default';

  try {
    // Get the PermissionChangeHub DO for this tenant
    const hubId = c.env.PERMISSION_CHANGE_HUB.idFromName(tenantId);
    const hub = c.env.PERMISSION_CHANGE_HUB.get(hubId);

    // Ensure the hub is set up with the tenant ID
    await hub.fetch('https://internal/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    });

    // Forward the WebSocket upgrade request to the DO
    // The DO will handle the WebSocket connection
    const url = new URL(c.req.url);
    url.pathname = '/websocket';

    return hub.fetch(
      new Request(url.toString(), {
        headers: c.req.raw.headers,
      })
    );
  } catch (error) {
    console.error('[Subscribe] WebSocket upgrade error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Get subscription hub stats
 * GET /api/check/subscribe/stats
 */
subscribeRoutes.get('/subscribe/stats', async (c) => {
  // Check if Check API is enabled
  if (!isCheckApiEnabled(c.env)) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  // Authentication
  const auth = await authenticateCheckApiRequest(c.req.header('Authorization'), {
    db: c.env.DB,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    defaultTenantId: c.env.DEFAULT_TENANT_ID,
  });

  if (!auth.authenticated) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if PermissionChangeHub DO is available
  if (!c.env.PERMISSION_CHANGE_HUB) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const tenantId =
    c.req.query('tenant_id') || auth.tenantId || c.env.DEFAULT_TENANT_ID || 'default';

  try {
    const hubId = c.env.PERMISSION_CHANGE_HUB.idFromName(tenantId);
    const hub = c.env.PERMISSION_CHANGE_HUB.get(hubId);

    const response = await hub.fetch('https://internal/stats', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Hub returned ${response.status}`);
    }

    const stats = (await response.json()) as Record<string, unknown>;
    return c.json({
      tenant_id: tenantId,
      websocket_enabled: isWebSocketEnabled(c.env),
      ...stats,
    });
  } catch (error) {
    console.error('[Subscribe] Stats error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export { subscribeRoutes };

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
 * Credentials: the `Authorization: Bearer` header of the upgrade request (server-side WebSocket
 * clients can send it). The `token` query parameter is a deprecated fallback: it ends up in URLs
 * and logs (the policy worker's request log redacts it, and the public Router refuses it), so it
 * is read only when the header is absent. An end-user access token is verified only from the
 * header (check-access-token.ts), and the subscribe operation is not granted to access tokens:
 * subscriptions, and their stats, are for server credentials.
 *
 * The Check API switch is the platform's `feature.enable_check_api` (Settings API, else env), as
 * for the check routes.
 */

import { Hono } from 'hono';
import type { KVNamespace, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { Env as SharedEnv } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES, getLogger, createLogger } from '@authrim/ar-lib-core';
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  resolveAuthorizedCheckTenantId,
  type CheckAuthContext,
} from '../middleware/check-auth';
import { createCheckAccessTokenVerifier } from '../middleware/check-access-token';
import { getPolicyCoreAdapter } from '../rebac-storage-adapter';
import { isCheckApiEnabled } from './check-settings';
import { checkAuthenticationFailure } from './check-auth-response';

const deprecationLog = createLogger().module('SUBSCRIBE');

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
  ENABLE_CHECK_API_WEBSOCKET?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if WebSocket Push feature is enabled
 */
function isWebSocketEnabled(env: Env): boolean {
  return env.ENABLE_CHECK_API_WEBSOCKET === 'true';
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
  if (!(await isCheckApiEnabled(c.env))) {
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

  // The Authorization header; the `token` query parameter only as a deprecated fallback.
  const authorization = c.req.header('Authorization');
  const queryToken = authorization ? undefined : c.req.query('token');
  if (!authorization && !queryToken) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }
  if (queryToken) {
    deprecationLog.warn('Deprecated: subscription credential in the token query parameter');
  }

  // Authenticate using the token
  const coreAdapter = getPolicyCoreAdapter(c);
  const authContext: CheckAuthContext = {
    db: coreAdapter,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    accessTokenVerifier: createCheckAccessTokenVerifier(c),
  };

  const auth = await authenticateCheckApiRequest(
    authorization ?? `Bearer ${queryToken}`,
    authContext
  );

  if (!auth.authenticated) {
    return checkAuthenticationFailure(c, auth);
  }

  // Check if subscribe operation is allowed
  if (!isOperationAllowed(auth, 'subscribe')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  const tenantId = resolveAuthorizedCheckTenantId(auth, c.req.query('tenant_id'));
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = getLogger(c as any).module('SUBSCRIBE');
    log.error('WebSocket upgrade error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Get subscription hub stats
 * GET /api/check/subscribe/stats
 */
subscribeRoutes.get('/subscribe/stats', async (c) => {
  // Check if Check API is enabled
  if (!(await isCheckApiEnabled(c.env))) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  // Authentication
  const coreAdapter = getPolicyCoreAdapter(c);
  const auth = await authenticateCheckApiRequest(c.req.header('Authorization'), {
    db: coreAdapter,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    accessTokenVerifier: createCheckAccessTokenVerifier(c),
  });

  if (!auth.authenticated) {
    return checkAuthenticationFailure(c, auth);
  }

  // The stats are part of the subscription feature: same operation grant.
  if (!isOperationAllowed(auth, 'subscribe')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  // Check if PermissionChangeHub DO is available
  if (!c.env.PERMISSION_CHANGE_HUB) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const tenantId = resolveAuthorizedCheckTenantId(auth, c.req.query('tenant_id'));
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const hubId = c.env.PERMISSION_CHANGE_HUB.idFromName(tenantId);
    const hub = c.env.PERMISSION_CHANGE_HUB.get(hubId);

    const response = await hub.fetch('https://internal/stats', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Hub returned ${response.status}`);
    }

    const stats = await response.json<Record<string, unknown>>();
    return c.json({
      tenant_id: tenantId,
      websocket_enabled: isWebSocketEnabled(c.env),
      ...stats,
    });
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = getLogger(c as any).module('SUBSCRIBE');
    log.error('Stats error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export { subscribeRoutes };

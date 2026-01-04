/**
 * External IdP Worker
 * Handles authentication with external identity providers (Google, GitHub, etc.)
 *
 * Endpoints:
 * - GET  /api/external/providers                     - List available providers
 * - GET  /api/external/:provider/start              - Start external IdP login
 * - GET  /api/external/:provider/callback           - Handle OAuth callback
 * - POST /api/external/:provider/backchannel-logout - Handle backchannel logout (OIDC Back-Channel Logout 1.0)
 * - GET  /api/external/link                         - List linked identities (requires session)
 * - POST /api/external/link                         - Start linking flow (requires session)
 * - DELETE /api/external/link/:id                   - Unlink identity (requires session)
 *
 * Admin API:
 * - GET    /api/admin/external-providers     - List all providers
 * - POST   /api/admin/external-providers     - Create provider
 * - GET    /api/admin/external-providers/:id - Get provider details
 * - PUT    /api/admin/external-providers/:id - Update provider
 * - DELETE /api/admin/external-providers/:id - Delete provider
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  isAllowedOrigin,
  parseAllowedOrigins,
  versionCheckMiddleware,
  requestContextMiddleware,
  pluginContextMiddleware,
  createErrorResponse,
  AR_ERROR_CODES,
  // Health Check
  createHealthCheckHandlers,
  // Logger
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';

// Import handlers
import { handleListProviders } from './handlers/list';
import { handleExternalStart } from './handlers/start';
import { handleExternalCallback } from './handlers/callback';
import { handleBackchannelLogout } from './handlers/backchannel-logout';
import {
  handleLinkIdentity,
  handleUnlinkIdentity,
  handleListLinkedIdentities,
} from './handlers/link';

// Import admin handlers
import {
  handleAdminListProviders,
  handleAdminCreateProvider,
  handleAdminGetProvider,
  handleAdminUpdateProvider,
  handleAdminDeleteProvider,
} from './admin/providers';

// Import maintenance utilities
import { cleanupExpiredStates } from './utils/state';
import { refreshExpiringTokens } from './services/token-refresh';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', versionCheckMiddleware('ar-bridge'));
app.use('*', requestContextMiddleware());
app.use('*', pluginContextMiddleware());

// Enhanced security headers
app.use('*', async (c, next) => {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
    strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
  })(c, next);
});

// CORS configuration with origin validation
app.use('*', async (c, next) => {
  const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
  const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

  const corsMiddleware = cors({
    origin: (origin) => {
      if (!origin) {
        return c.env.ISSUER_URL;
      }
      if (isAllowedOrigin(origin, allowedOrigins)) {
        return origin;
      }
      return '';
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
    credentials: true,
  });

  return corsMiddleware(c, next);
});

// Rate limiting for auth endpoints
app.use(
  '/api/external/*',
  rateLimitMiddleware({
    ...RateLimitProfiles.moderate,
    endpoints: ['/api/external/*'],
  })
);

// Health check endpoints
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ar-bridge',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes
const healthHandlers = createHealthCheckHandlers({
  serviceName: 'ar-bridge',
  version: '0.1.0',
  checkDatabase: true,
  checkKV: true,
});
app.get('/health/live', healthHandlers.liveness);
app.get('/health/ready', healthHandlers.readiness);

// =============================================================================
// Public Endpoints (both /api/external and /auth/external paths for compatibility)
// =============================================================================

// List available providers for login UI
app.get('/api/external/providers', handleListProviders);
app.get('/auth/external/providers', handleListProviders);

// Start external IdP login flow
app.get('/api/external/:provider/start', handleExternalStart);
app.get('/auth/external/:provider/start', handleExternalStart);

// Handle OAuth callback from external IdP
// GET: Standard OAuth callback (most providers)
// POST: Apple Sign In with response_mode=form_post (required for name/email scope)
app.get('/api/external/:provider/callback', handleExternalCallback);
app.post('/api/external/:provider/callback', handleExternalCallback);
app.get('/auth/external/:provider/callback', handleExternalCallback);
app.post('/auth/external/:provider/callback', handleExternalCallback);

// Handle backchannel logout from external IdP (OpenID Connect Back-Channel Logout 1.0)
app.post('/api/external/:provider/backchannel-logout', handleBackchannelLogout);
app.post('/auth/external/:provider/backchannel-logout', handleBackchannelLogout);

// =============================================================================
// Authenticated Endpoints (require session)
// =============================================================================

// List linked identities for current user
app.get('/api/external/links', handleListLinkedIdentities);
app.get('/auth/external/links', handleListLinkedIdentities);

// Start linking flow for existing account
app.post('/api/external/links', handleLinkIdentity);
app.post('/auth/external/links', handleLinkIdentity);

// Unlink identity from account
app.delete('/api/external/links/:id', handleUnlinkIdentity);
app.delete('/auth/external/links/:id', handleUnlinkIdentity);

// =============================================================================
// Admin API
// =============================================================================

// List all providers (admin)
app.get('/api/admin/external-providers', handleAdminListProviders);

// Create new provider
app.post('/api/admin/external-providers', handleAdminCreateProvider);

// Get provider details
app.get('/api/admin/external-providers/:id', handleAdminGetProvider);

// Update provider
app.put('/api/admin/external-providers/:id', handleAdminUpdateProvider);

// Delete provider
app.delete('/api/admin/external-providers/:id', handleAdminDeleteProvider);

// =============================================================================
// Error Handlers
// =============================================================================

// 404 handler
app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// Error handler
app.onError((err, c) => {
  const log = getLogger(c).module('EXTERNAL-IDP');
  log.error('External IdP Worker Error', { err: err.message }, err as Error);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

// =============================================================================
// Scheduled Handler
// =============================================================================

/**
 * Scheduled handler for maintenance tasks
 * Configure in wrangler.toml:
 *   [triggers]
 *   crons = ["0 * * * *"]  # Run every hour
 */
async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const log = createLogger().module('EXTERNAL-IDP');
  log.info('Running scheduled maintenance tasks...');

  try {
    // 1. Clean up expired and consumed auth states
    const statesDeleted = await cleanupExpiredStates(env);
    log.info('Cleaned up expired/consumed auth states', { statesDeleted });

    // 2. Refresh tokens that are about to expire
    const tokensRefreshed = await refreshExpiringTokens(env);
    log.info('Refreshed expiring tokens', { tokensRefreshed });
  } catch (error) {
    log.error('Scheduled maintenance failed', {}, error as Error);
    // Don't throw - we don't want to fail the entire scheduled run
  }
}

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled,
};

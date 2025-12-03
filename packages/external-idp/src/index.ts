/**
 * External IdP Worker
 * Handles authentication with external identity providers (Google, GitHub, etc.)
 *
 * Endpoints:
 * - GET  /auth/external/providers          - List available providers
 * - GET  /auth/external/:provider/start    - Start external IdP login
 * - GET  /auth/external/:provider/callback - Handle OAuth callback
 * - POST /auth/external/link               - Start linking flow (requires session)
 * - DELETE /auth/external/link/:id         - Unlink identity
 *
 * Admin API:
 * - GET    /external-idp/admin/providers     - List all providers
 * - POST   /external-idp/admin/providers     - Create provider
 * - GET    /external-idp/admin/providers/:id - Get provider details
 * - PUT    /external-idp/admin/providers/:id - Update provider
 * - DELETE /external-idp/admin/providers/:id - Delete provider
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/shared';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  isAllowedOrigin,
  parseAllowedOrigins,
  versionCheckMiddleware,
  requestContextMiddleware,
} from '@authrim/shared';

// Import handlers
import { handleListProviders } from './handlers/list';
import { handleExternalStart } from './handlers/start';
import { handleExternalCallback } from './handlers/callback';
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

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', versionCheckMiddleware('external-idp'));
app.use('*', requestContextMiddleware());

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
  '/auth/external/*',
  rateLimitMiddleware({
    ...RateLimitProfiles.moderate,
    endpoints: ['/auth/external/*'],
  })
);

// Health check endpoint
app.get('/external-idp/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'external-idp',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Public Endpoints
// =============================================================================

// List available providers for login UI
app.get('/auth/external/providers', handleListProviders);

// Start external IdP login flow
app.get('/auth/external/:provider/start', handleExternalStart);

// Handle OAuth callback from external IdP
app.get('/auth/external/:provider/callback', handleExternalCallback);

// =============================================================================
// Authenticated Endpoints (require session)
// =============================================================================

// List linked identities for current user
app.get('/auth/external/link', handleListLinkedIdentities);

// Start linking flow for existing account
app.post('/auth/external/link', handleLinkIdentity);

// Unlink identity from account
app.delete('/auth/external/link/:id', handleUnlinkIdentity);

// =============================================================================
// Admin API
// =============================================================================

// List all providers (admin)
app.get('/external-idp/admin/providers', handleAdminListProviders);

// Create new provider
app.post('/external-idp/admin/providers', handleAdminCreateProvider);

// Get provider details
app.get('/external-idp/admin/providers/:id', handleAdminGetProvider);

// Update provider
app.put('/external-idp/admin/providers/:id', handleAdminUpdateProvider);

// Delete provider
app.delete('/external-idp/admin/providers/:id', handleAdminDeleteProvider);

// =============================================================================
// Error Handlers
// =============================================================================

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('External IdP Worker Error:', err);
  return c.json({ error: 'internal_server_error', message: 'An unexpected error occurred' }, 500);
});

// Export for Cloudflare Workers
export default app;

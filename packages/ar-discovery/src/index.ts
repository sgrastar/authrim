import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/ar-lib-core';
import {
  requestContextMiddleware,
  pluginContextMiddleware,
  // Health Check
  createHealthCheckHandlers,
  getLogger,
} from '@authrim/ar-lib-core';

// Import handlers
import { discoveryHandler } from './discovery';
import { jwksHandler } from './jwks';
import { webfingerHandler } from './webfinger';
import {
  adminAgentAuthorizationServerMetadataHandler,
  agentProtectedResourceMetadataHandler,
} from './agent-access-metadata';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
  })
);
app.use('*', requestContextMiddleware());
app.use('*', pluginContextMiddleware());

// Enhanced security headers
app.use(
  '*',
  secureHeaders({
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
  })
);

// Health check endpoints
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-discovery',
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes
const healthHandlers = createHealthCheckHandlers({
  serviceName: 'op-discovery',
  version: '0.1.0',
  checkKV: true,
  checkKeyManager: true,
});
app.get('/health/live', healthHandlers.liveness);
app.get('/health/ready', healthHandlers.readiness);

// OpenID Connect Discovery endpoint
app.get('/.well-known/openid-configuration', discoveryHandler);

// RFC 8414: OAuth 2.0 Authorization Server Metadata
// Returns the same metadata as openid-configuration for OAuth 2.0 clients
app.get('/.well-known/oauth-authorization-server', discoveryHandler);

// RFC 8414 metadata for the dedicated Admin Agent issuer.
app.get(
  '/.well-known/oauth-authorization-server/oauth/admin-agent',
  adminAgentAuthorizationServerMetadataHandler
);

// RFC 9728 path-form metadata for the protected MCP resource at /mcp.
app.get('/.well-known/oauth-protected-resource/mcp', agentProtectedResourceMetadataHandler);

// OpenID Connect Discovery via WebFinger
app.get('/.well-known/webfinger', webfingerHandler);

// JWKS endpoint (JSON Web Key Set)
app.get('/.well-known/jwks.json', jwksHandler);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  const log = getLogger(c).module('DISCOVERY');
  log.error('Unhandled error in discovery service', { error: err.message }, err as Error);
  return c.json({ error: 'server_error', error_description: 'An unexpected error occurred' }, 500);
});

// Export for Cloudflare Workers
export default app;
export { RuntimeSmokeEntrypoint } from '@authrim/ar-lib-core';

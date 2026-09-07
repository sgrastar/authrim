import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  getRateLimitProfileAsync,
  requestContextMiddleware,
  pluginContextMiddleware,
  // Health Check
  createHealthCheckHandlers,
  getLogger,
  createTenantPlacementWriteFenceResponse,
} from '@authrim/ar-lib-core';

// Import handlers
import { userinfoHandler } from './userinfo';
import { fapiResourceHandler } from './fapi-resource';
import { createProtectedCustomerProfileRouter } from './protected-customer-profile';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
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

// CORS configuration
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'DPoP',
      'Idempotency-Key',
      'Authrim-Step-Up-Receipt',
    ],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
  })
);

// Rate limiting for userinfo endpoint
// Configurable via KV (rate_limit_moderate_max_requests, rate_limit_moderate_window_seconds)
// or RATE_LIMIT_PROFILE env var for profile selection
// Set ENABLE_RATE_LIMIT=false to bypass rate limiting (for benchmarks)
app.use('/userinfo', async (c, next) => {
  // Skip rate limiting if explicitly disabled (for load testing)
  if (c.env.ENABLE_RATE_LIMIT === 'false') {
    return next();
  }
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/userinfo'],
  })(c, next);
});

app.use('/api/protected/customer-profiles/*', async (c, next) => {
  if (c.env.ENABLE_RATE_LIMIT === 'false') {
    return next();
  }
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/protected/customer-profiles'],
  })(c, next);
});

// Health check endpoints
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-userinfo',
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes
const healthHandlers = createHealthCheckHandlers({
  serviceName: 'op-userinfo',
  version: '0.1.0',
  checkDatabase: true,
  checkKV: true,
});
app.get('/health/live', healthHandlers.liveness);
app.get('/health/ready', healthHandlers.readiness);

// UserInfo endpoint
app.get('/userinfo', userinfoHandler);
app.post('/userinfo', userinfoHandler);
app.get('/api/protected/fapi-resource', fapiResourceHandler);
app.route('/api/protected/customer-profiles', createProtectedCustomerProfileRouter());

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, err);
  if (writeFenceResponse) return writeFenceResponse;
  const log = getLogger(c).module('USERINFO');
  log.error('Unhandled error in UserInfo service', { error: err.message }, err as Error);
  return c.json({ error: 'server_error', error_description: 'An unexpected error occurred' }, 500);
});

// Export for Cloudflare Workers
export default app;
export { RuntimeSmokeEntrypoint } from '@authrim/ar-lib-core';

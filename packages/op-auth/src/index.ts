import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@enrai/shared';
import { rateLimitMiddleware, RateLimitProfiles } from '@enrai/shared';

// Import handlers
import { authorizeHandler } from './authorize';
import { parHandler } from './par';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());

// Enhanced security headers
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
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
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: [],
    },
  })
);

// CORS configuration
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
    credentials: true,
  })
);

// Rate limiting for sensitive endpoints
app.use(
  '/authorize',
  rateLimitMiddleware({
    ...RateLimitProfiles.moderate,
    endpoints: ['/authorize'],
  })
);

app.use(
  '/as/par',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/as/par'],
  })
);

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-auth',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Authorization endpoint
// OIDC Core 3.1.2.1: MUST support both GET and POST methods
app.get('/authorize', authorizeHandler);
app.post('/authorize', authorizeHandler);

// PAR (Pushed Authorization Request) endpoint - RFC 9126
app.post('/as/par', parHandler);

// PAR endpoint should reject non-POST methods
app.get('/as/par', (c) => {
  return c.json(
    {
      error: 'invalid_request',
      error_description: 'PAR endpoint only accepts POST requests',
    },
    405
  );
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: 'internal_server_error', message: 'An unexpected error occurred' }, 500);
});

// Export for Cloudflare Workers
export default app;

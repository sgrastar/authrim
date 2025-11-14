import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';

/**
 * Environment bindings for the Router Worker
 * Service Bindings to other workers
 */
interface Env {
  // Service Bindings to specialized workers
  OP_DISCOVERY: Fetcher;
  OP_AUTH: Fetcher;
  OP_TOKEN: Fetcher;
  OP_USERINFO: Fetcher;
  OP_MANAGEMENT: Fetcher;
}

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
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
    credentials: true,
  })
);

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'enrai-router',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Discovery endpoints - Route to OP_DISCOVERY worker
 * - /.well-known/openid-configuration
 * - /.well-known/jwks.json
 */
app.get('/.well-known/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_DISCOVERY.fetch(request);
});

/**
 * Authorization endpoints - Route to OP_AUTH worker
 * - /authorize (GET/POST)
 * - /as/par (POST)
 */
app.get('/authorize', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/authorize', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/as/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Token endpoint - Route to OP_TOKEN worker
 * - /token (POST)
 */
app.post('/token', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_TOKEN.fetch(request);
});

/**
 * UserInfo endpoint - Route to OP_USERINFO worker
 * - /userinfo (GET/POST)
 */
app.get('/userinfo', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_USERINFO.fetch(request);
});

app.post('/userinfo', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_USERINFO.fetch(request);
});

/**
 * Authentication endpoints - Route to OP_AUTH worker
 * - /api/auth/passkey/* - WebAuthn/Passkey authentication
 * - /api/auth/magic-link/* - Magic link authentication
 * - /api/auth/consent - OAuth consent screen
 * - /api/auth/session/* - ITP-compliant session management (deprecated, use /api/sessions/*)
 */
app.all('/api/auth/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Session endpoints - Route to OP_AUTH worker
 * - /api/sessions/status - Check session validity
 * - /api/sessions/refresh - Extend session expiration
 * - /api/sessions/issue - Issue session token
 * - /api/sessions/verify - Verify session token
 */
app.all('/api/sessions/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Logout endpoints - Route to OP_AUTH worker
 * - /logout - Front-channel logout
 * - /logout/backchannel - Back-channel logout (RFC 8725)
 */
app.get('/logout', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/logout/backchannel', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Management endpoints - Route to OP_MANAGEMENT worker
 * - /register (POST) - Dynamic Client Registration (OIDC standard)
 * - /introspect (POST) - Token Introspection (OAuth 2.0 standard)
 * - /revoke (POST) - Token Revocation (OAuth 2.0 standard)
 * - /api/admin/* - Admin API (users, clients, stats)
 * - /api/avatars/* - Avatar images
 */
app.post('/register', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.post('/introspect', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.post('/revoke', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.all('/api/admin/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.get('/api/avatars/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: 'not_found',
      message: 'The requested resource was not found',
      hint: 'This is the Enrai Router Worker. Ensure the requested path matches a valid OpenID Connect endpoint.',
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  console.error('Router Error:', err);
  return c.json(
    {
      error: 'internal_server_error',
      message: 'An unexpected error occurred in the router',
    },
    500
  );
});

// Export for Cloudflare Workers
export default app;

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
  OP_ASYNC: Fetcher;
  OP_SAML: Fetcher;
  EXTERNAL_IDP: Fetcher; // External IdP (social login, enterprise IdP)
  // CORS configuration (optional)
  // Comma-separated list of allowed origins, e.g., "https://app.example.com,https://admin.example.com"
  // If not set, defaults to '*' with credentials disabled for security
  ALLOWED_ORIGINS?: string;
}

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());

// Enhanced security headers
// Skip for /authorize endpoint to allow form_post response mode with nonce-based CSP
// Skip for /session/check to allow iframe embedding (OIDC Session Management)
app.use('*', async (c, next) => {
  // Skip secure headers for /authorize endpoint (handled by op-auth worker with nonce-based CSP)
  // Skip for /session/check endpoint (OIDC Session Management iframe needs custom headers)
  if (
    c.req.path === '/authorize' ||
    c.req.path.startsWith('/authorize/') ||
    c.req.path === '/session/check'
  ) {
    return next();
  }

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

/**
 * CORS configuration with dynamic origin validation
 *
 * Security considerations:
 * - Per CORS spec, when credentials: true, origin cannot be '*'
 * - If ALLOWED_ORIGINS is set, validates against whitelist with credentials enabled
 * - If not set, uses '*' with credentials disabled (safe default for public APIs)
 */
app.use('*', async (c, next) => {
  const allowedOriginsEnv = c.env.ALLOWED_ORIGINS;

  // Parse allowed origins from environment (comma-separated)
  const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((o) => o.trim())
    : null;

  // Determine if credentials should be allowed
  // Only allow credentials when specific origins are configured
  const allowCredentials = !!allowedOrigins;

  // Origin validation function
  const validateOrigin = (origin: string): string | undefined | null => {
    if (!allowedOrigins) {
      // No whitelist configured: allow all origins but without credentials
      return origin;
    }
    // Check against whitelist
    if (allowedOrigins.includes(origin)) {
      return origin;
    }
    // Origin not in whitelist
    return null;
  };

  return cors({
    origin: validateOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'DPoP', 'If-Match', 'If-None-Match'],
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'ETag',
      'Location',
    ],
    maxAge: 86400,
    credentials: allowCredentials,
  })(c, next);
});

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'authrim-router',
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
 * - /authorize/confirm (GET/POST) - Re-authentication confirmation
 * - /as/par (POST)
 */
app.all('/authorize/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

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
 * - /api/auth/email-code/* - Email code (OTP) authentication
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
 * OIDC Session Management 1.0 - Check Session Iframe
 * - /session/check - Iframe for RPs to monitor session state
 */
app.get('/session/check', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Logout endpoints - Route to OP_AUTH worker
 * - /logout - Front-channel logout
 * - /logout/backchannel - Back-channel logout (RFC 8725)
 * - /logged-out - Post-logout landing page (success)
 * - /logout-error - Post-logout landing page (validation error)
 */
app.get('/logout', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/logout/backchannel', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/logged-out', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/logout-error', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Device Flow endpoints - Route to OP_ASYNC worker
 * - /device_authorization (POST) - RFC 8628: Device Authorization Grant
 * - /device (GET/POST) - User verification page (minimal HTML for OIDC conformance)
 * - /api/device/* - Headless JSON APIs for SvelteKit UI and WebSDK
 */
app.post('/device_authorization', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.get('/device', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.post('/device', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.all('/api/device/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

/**
 * CIBA (Client Initiated Backchannel Authentication) endpoints - Route to OP_ASYNC worker
 * - /bc-authorize (POST) - OIDC CIBA: Backchannel Authentication Request
 * - /api/ciba/* - Headless JSON APIs for CIBA approval UI
 */
app.post('/bc-authorize', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.all('/api/ciba/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

/**
 * Management endpoints - Route to OP_MANAGEMENT worker
 * - /register (POST) - Dynamic Client Registration (OIDC standard)
 * - /introspect (POST) - Token Introspection (OAuth 2.0 standard)
 * - /revoke (POST) - Token Revocation (OAuth 2.0 standard)
 * - /api/admin/* - Admin API (users, clients, stats)
 * - /api/avatars/* - Avatar images
 * - /scim/v2/* - SCIM 2.0 User Provisioning (RFC 7643, 7644)
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

// SCIM 2.0 endpoints - RFC 7643, 7644
app.all('/scim/v2/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

/**
 * SAML 2.0 endpoints - Route to OP_SAML worker
 * - /saml/idp/* - IdP endpoints (metadata, SSO, SLO, IdP-initiated)
 * - /saml/sp/* - SP endpoints (metadata, ACS, login, SLO)
 * - /saml/admin/* - Admin API for SAML provider management
 */
app.all('/saml/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_SAML.fetch(request);
});

/**
 * External IdP endpoints - Route to EXTERNAL_IDP worker
 * - /auth/external/providers - List available external IdP providers
 * - /auth/external/:provider/start - Start external IdP login
 * - /auth/external/:provider/callback - Handle OAuth callback
 * - /auth/external/link - Link/unlink external identities
 * - /external-idp/admin/* - Admin API for external IdP management
 */
app.all('/auth/external/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.EXTERNAL_IDP.fetch(request);
});

app.all('/external-idp/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.EXTERNAL_IDP.fetch(request);
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: 'not_found',
      message: 'The requested resource was not found',
      hint: 'This is the Authrim Router Worker. Ensure the requested path matches a valid OpenID Connect endpoint.',
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

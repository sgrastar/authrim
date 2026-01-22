import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import { createLogger } from '@authrim/ar-lib-core';

// Module-level logger for router (no Hono context available in error handler)
const log = createLogger().module('ROUTER');

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

  // UI Proxy configuration (optional)
  // When enabled, routes UI paths through the router for same-domain deployment
  /** Login UI Pages URL (e.g., https://dev-ar-login-ui.pages.dev) */
  AR_LOGIN_UI_URL?: string;
  /** Admin UI Pages URL (e.g., https://dev-ar-admin-ui.pages.dev) */
  AR_ADMIN_UI_URL?: string;
  /** Enable Login UI proxy (true/false) */
  ENABLE_LOGIN_UI_PROXY?: string;
  /** Enable Admin UI proxy (true/false) */
  ENABLE_ADMIN_UI_PROXY?: string;
}

// Login UI paths that should be proxied when ENABLE_LOGIN_UI_PROXY is true
const LOGIN_UI_PATHS = [
  '/login',
  '/signup',
  '/consent',
  '/device',
  '/ciba',
  '/reauth',
  '/verify-email-code',
  '/error',
];

/**
 * Proxy request to Cloudflare Pages
 * Maintains all headers, query params, and body
 */
async function proxyToPages(request: Request, baseUrl: string, path: string): Promise<Response> {
  const targetUrl = new URL(path, baseUrl);
  targetUrl.search = new URL(request.url).search;

  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  return fetch(proxyRequest);
}

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());

// Enhanced security headers
// Skip for /authorize endpoint to allow form_post response mode with nonce-based CSP
// Skip for /session/check to allow iframe embedding (OIDC Session Management)
// Skip for /logout to allow frontchannel logout iframes (OIDC Front-Channel Logout 1.0)
app.use('*', async (c, next) => {
  // Skip secure headers for /authorize and /flow endpoints (handled by op-auth worker with nonce-based CSP)
  // Skip for /session/check endpoint (OIDC Session Management iframe needs custom headers)
  // Skip for /logout endpoint (OIDC Front-Channel Logout needs to embed iframes)
  // Skip for /admin-init-setup (needs unpkg.com CDN for WebAuthn library)
  // Skip for UI proxy paths (SvelteKit uses inline styles/scripts and CDN fonts)
  const path = c.req.path;
  if (
    path === '/authorize' ||
    path.startsWith('/authorize/') ||
    path.startsWith('/flow/') ||
    path === '/session/check' ||
    path === '/logout' ||
    path.startsWith('/admin-init-setup') ||
    // UI proxy paths - Pages handles its own headers
    path.startsWith('/admin') ||
    path.startsWith('/login') ||
    path.startsWith('/signup') ||
    path.startsWith('/consent') ||
    path.startsWith('/device') ||
    path.startsWith('/ciba') ||
    path.startsWith('/reauth') ||
    path.startsWith('/verify-email-code') ||
    path.startsWith('/error') ||
    path.startsWith('/_app') || // SvelteKit static assets
    path === '/' // Root path for Login UI (external auth callbacks)
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

// Health check endpoints
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'authrim-router',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes (router has no DB/KV, just routes to other services)
app.get('/health/live', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/ready', (c) => {
  return c.json({
    status: 'ready',
    checks: {},
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
 * - /flow/login (GET/POST) - Login flow
 * - /flow/confirm (GET/POST) - Re-authentication confirmation
 * - /par (POST) - Pushed Authorization Request
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

// Login/Confirm flow endpoints
app.all('/flow/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

// PAR endpoint (RFC 9126)
app.post('/par', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/par', async (c) => {
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
 * Direct Authentication API v1 - Route to OP_AUTH worker
 * BetterAuth-style API for custom login pages
 * - /api/v1/auth/direct/passkey/login/start - Start passkey login
 * - /api/v1/auth/direct/passkey/login/finish - Finish passkey login
 * - /api/v1/auth/direct/passkey/signup/start - Start passkey signup
 * - /api/v1/auth/direct/passkey/signup/finish - Finish passkey signup
 * - /api/v1/auth/direct/passkey/register/start - Start passkey registration (requires auth)
 * - /api/v1/auth/direct/passkey/register/finish - Finish passkey registration (requires auth)
 * - /api/v1/auth/direct/email-code/send - Send email verification code
 * - /api/v1/auth/direct/email-code/verify - Verify email code
 * - /api/v1/auth/direct/token - Exchange auth_code for session/tokens
 */
app.all('/api/v1/auth/direct/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
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

// Batch Token Revocation endpoint (RFC 7009 extension)
app.post('/revoke/batch', async (c) => {
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
 * Internal API endpoints - Route to OP_MANAGEMENT worker
 * - /api/internal/version/:workerName - Register deployed code version
 * - /api/internal/version-manager/status - Get all registered versions
 *
 * Used by deploy scripts to register new code versions for PoP version forcing.
 * This ensures all Cloudflare PoPs serve the latest deployed Worker bundle.
 */
app.all('/api/internal/*', async (c) => {
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

/**
 * Internal endpoints - Route to OP_AUTH worker
 * - /_internal/warmup - Pre-heat Durable Objects (admin only)
 */
app.all('/_internal/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Initial Admin Setup endpoints - Route to OP_AUTH worker
 * - /admin-init-setup - Initial admin setup page (one-time use, expires in 1 hour)
 * - /api/admin-init-setup/* - Setup API endpoints
 */
app.get('/admin-init-setup', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.all('/api/admin-init-setup/*', async (c) => {
  const request = new Request(c.req.url, c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * UI Proxy endpoints - Proxy to Cloudflare Pages
 * When enabled, serves UI from the same domain as the API
 *
 * Admin UI Proxy (ENABLE_ADMIN_UI_PROXY=true):
 * - /admin/* - Admin dashboard pages
 *
 * Login UI Proxy (ENABLE_LOGIN_UI_PROXY=true):
 * - /login, /signup, /consent, /device, /ciba, /reauth, /verify-email-code, /error
 */

// Admin UI proxy - /admin/*
app.all('/admin/*', async (c) => {
  if (c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL) {
    const path = c.req.path;
    return proxyToPages(c.req.raw, c.env.AR_ADMIN_UI_URL, path);
  }
  // If proxy not enabled, return 404
  return c.json(
    {
      error: 'not_found',
      message: 'Admin UI proxy is not enabled',
      hint: 'Set ENABLE_ADMIN_UI_PROXY=true and AR_ADMIN_UI_URL to enable the admin UI proxy.',
    },
    404
  );
});

// Admin UI proxy - exact /admin path (redirect to /admin/)
app.get('/admin', async (c) => {
  if (c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL) {
    return proxyToPages(c.req.raw, c.env.AR_ADMIN_UI_URL, '/admin');
  }
  return c.json(
    {
      error: 'not_found',
      message: 'Admin UI proxy is not enabled',
    },
    404
  );
});

// Login UI proxy routes
for (const uiPath of LOGIN_UI_PATHS) {
  // Handle exact path
  app.all(uiPath, async (c) => {
    if (c.env.ENABLE_LOGIN_UI_PROXY === 'true' && c.env.AR_LOGIN_UI_URL) {
      return proxyToPages(c.req.raw, c.env.AR_LOGIN_UI_URL, c.req.path);
    }
    return c.json(
      {
        error: 'not_found',
        message: 'Login UI proxy is not enabled',
        hint: 'Set ENABLE_LOGIN_UI_PROXY=true and AR_LOGIN_UI_URL to enable the login UI proxy.',
      },
      404
    );
  });

  // Handle paths with trailing content (e.g., /login/*, /signup/*)
  app.all(`${uiPath}/*`, async (c) => {
    if (c.env.ENABLE_LOGIN_UI_PROXY === 'true' && c.env.AR_LOGIN_UI_URL) {
      return proxyToPages(c.req.raw, c.env.AR_LOGIN_UI_URL, c.req.path);
    }
    return c.json(
      {
        error: 'not_found',
        message: 'Login UI proxy is not enabled',
      },
      404
    );
  });
}

// Static assets proxy for UI (when either proxy is enabled)
// This handles /_app/* paths for SvelteKit static assets
app.all('/_app/*', async (c) => {
  // Determine which UI to serve static assets from based on Referer
  // Each UI has different chunk names, so we need to route to the correct one
  const referer = c.req.header('Referer');
  let isAdminRequest = false;

  try {
    if (referer) {
      const refererUrl = new URL(referer);
      isAdminRequest = refererUrl.pathname.startsWith('/admin');
    }
  } catch {
    // Invalid referer URL, will try both UIs
  }

  // Try primary UI first (based on referer), then fallback to the other
  const adminEnabled = c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL;
  const loginEnabled = c.env.ENABLE_LOGIN_UI_PROXY === 'true' && c.env.AR_LOGIN_UI_URL;

  // Determine order to try UIs
  const uisToTry: Array<{ url: string; name: string }> = [];
  if (isAdminRequest && adminEnabled) {
    uisToTry.push({ url: c.env.AR_ADMIN_UI_URL!, name: 'admin' });
    if (loginEnabled) uisToTry.push({ url: c.env.AR_LOGIN_UI_URL!, name: 'login' });
  } else if (loginEnabled) {
    uisToTry.push({ url: c.env.AR_LOGIN_UI_URL!, name: 'login' });
    if (adminEnabled) uisToTry.push({ url: c.env.AR_ADMIN_UI_URL!, name: 'admin' });
  } else if (adminEnabled) {
    uisToTry.push({ url: c.env.AR_ADMIN_UI_URL!, name: 'admin' });
  }

  // Try each UI in order, return first successful response
  for (const ui of uisToTry) {
    const response = await proxyToPages(c.req.raw.clone(), ui.url, c.req.path);
    if (response.ok) {
      return response;
    }
  }

  return c.json({ error: 'not_found', message: 'Static asset not found in any UI' }, 404);
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
  log.error('Router error occurred', { path: c.req.path, method: c.req.method }, err);
  return c.json(
    {
      error: 'server_error',
      error_description: 'An unexpected error occurred in the router',
    },
    500
  );
});

// Root path proxy for Login UI (handles external auth callbacks like /?external_auth=success)
// This must be registered after all API routes to avoid conflicts
app.get('/', async (c) => {
  if (c.env.ENABLE_LOGIN_UI_PROXY === 'true' && c.env.AR_LOGIN_UI_URL) {
    return proxyToPages(c.req.raw, c.env.AR_LOGIN_UI_URL, '/');
  }
  // Return basic API info when Login UI proxy is not enabled
  return c.json({
    name: 'Authrim OIDC Provider',
    version: '1.0.0',
    endpoints: {
      discovery: '/.well-known/openid-configuration',
      authorize: '/authorize',
      token: '/token',
      userinfo: '/userinfo',
    },
  });
});

// Export for Cloudflare Workers
export default app;

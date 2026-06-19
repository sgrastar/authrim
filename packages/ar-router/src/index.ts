import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import {
  createLogger,
  isAllowedOrigin,
  parseAllowedOrigins,
  csrfProtectionMiddleware,
  validateHostHeader,
  getDefaultTenantId,
} from '@authrim/ar-lib-core';

// Module-level logger for router (no Hono context available in error handler)
const log = createLogger().module('ROUTER');

/**
 * Environment bindings for the Router Worker
 * Service Bindings to other workers
 */
interface Env {
  // Service Bindings to specialized workers
  OP_DISCOVERY: Fetcher;
  OP_VC?: Fetcher;
  OP_AUTH: Fetcher;
  OP_TOKEN: Fetcher;
  OP_USERINFO: Fetcher;
  OP_MANAGEMENT: Fetcher;
  OP_ASYNC?: Fetcher;
  OP_SAML?: Fetcher;
  EXTERNAL_IDP: Fetcher; // External IdP (social login, enterprise IdP)
  // KV Namespace for configuration (optional)
  // Used for dynamic configuration from Admin UI without redeployment
  AUTHRIM_CONFIG?: KVNamespace;
  // CORS configuration (optional, fallback if KV not set)
  // Comma-separated list of allowed origins, e.g., "https://app.example.com,https://admin.example.com"
  // If not set, defaults to '*' with credentials disabled for security
  ALLOWED_ORIGINS?: string;
  // Multi-tenant configuration (optional)
  BASE_DOMAIN?: string;
  PRIMARY_TENANT_ID?: string;
  DEFAULT_TENANT_ID?: string;

  // UI Proxy configuration (optional)
  // When enabled, routes UI paths through the router for same-domain deployment
  /** Login UI Worker URL (e.g., https://login.example.com) */
  AR_LOGIN_UI_URL?: string;
  /** Admin UI Worker URL (e.g., https://admin.example.com) */
  AR_ADMIN_UI_URL?: string;
  /** Public Admin UI URL (e.g., https://admin.example.com) */
  ADMIN_UI_URL?: string;
  /** Public Login UI URL (e.g., https://login.example.com) */
  LOGIN_UI_URL?: string;
  /** Login UI Worker service binding */
  LOGIN_UI_WORKER?: Fetcher;
  /** Admin UI Worker service binding */
  ADMIN_UI_WORKER?: Fetcher;
  /** Enable Login UI proxy (true/false) */
  ENABLE_LOGIN_UI_PROXY?: string;
  /** Enable Admin UI proxy (true/false) */
  ENABLE_ADMIN_UI_PROXY?: string;
}

// Login UI paths that should be proxied when ENABLE_LOGIN_UI_PROXY is true
const LOGIN_UI_PATHS = [
  '/discover',
  '/invite',
  '/login',
  '/signup',
  '/consent',
  '/device',
  '/ciba',
  '/reauth',
  '/verify-email-code',
  '/error',
  '/api/set-language',
  '/callback',
];

const BEARER_TOKEN_TRANSPORT_UNSUPPORTED = 'bearer_token_transport_unsupported';

const BEARER_TOKEN_CANONICAL_PATHS = [
  '/authorize',
  '/token',
  '/userinfo',
  '/introspect',
  '/revoke',
  '/register',
  '/clients',
  '/par',
  '/device_authorization',
  '/bc-authorize',
  '/auth/step-up',
  '/me',
  '/api/admin',
  '/api/auth',
  '/api/ciba',
  '/api/device',
  '/api/internal',
  '/api/v1/auth/direct',
  '/api/sessions',
  '/api/protected',
  '/vci',
  '/vp',
  '/scim/v2',
];

function isBearerTokenCanonicalPath(path: string): boolean {
  return BEARER_TOKEN_CANONICAL_PATHS.some(
    (canonicalPath) => path === canonicalPath || path.startsWith(`${canonicalPath}/`)
  );
}

function matchesPathGroup(path: string, basePath: string): boolean {
  return path === basePath || path.startsWith(`${basePath}/`);
}

function isGakuNinShibbolethSAML2IdPPath(path: string): boolean {
  return (
    path === '/idp/profile/SAML2/POST/SSO' ||
    path === '/idp/profile/SAML2/Redirect/SSO' ||
    path === '/idp/profile/SAML2/POST/SLO' ||
    path === '/idp/profile/SAML2/Redirect/SLO'
  );
}

function bearerTokenTransportError(): Response {
  return Response.json(
    {
      error: 'invalid_request',
      error_description:
        'Bearer tokens must be sent in the Authorization header for this endpoint.',
      error_details: {
        code: BEARER_TOKEN_TRANSPORT_UNSUPPORTED,
      },
    },
    {
      status: 400,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}

function createServiceBindingRequest(request: Request): Request {
  const forwarded = new Request(request.url, request);
  const headers = new Headers(forwarded.headers);
  const originalHost = new URL(request.url).host;

  headers.set('X-Authrim-Forwarded-Host', originalHost);
  headers.set('X-Forwarded-Host', originalHost);

  return new Request(forwarded, { headers });
}

async function requestHasFormBearerToken(request: Request): Promise<boolean> {
  const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (
    !contentType.includes('application/x-www-form-urlencoded') &&
    !contentType.includes('multipart/form-data')
  ) {
    return false;
  }

  try {
    const formData = await request.clone().formData();
    return formData.has('access_token');
  } catch {
    return false;
  }
}

function getConfiguredUrlHostname(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Proxy request to a UI Worker.
 * Maintains all headers, query params, and body.
 * Rewrites Origin/Referer headers to match the UI Worker target so that
 * SvelteKit CSRF protection (which compares Origin vs event.url.origin)
 * does not reject proxied state-changing requests.
 */
async function proxyToUiWorker(
  request: Request,
  baseUrl: string,
  path: string,
  serviceBinding?: Fetcher
): Promise<Response> {
  const targetUrl = new URL(path, baseUrl);
  targetUrl.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.set('X-Authrim-Original-Host', new URL(request.url).host);
  const targetOrigin = targetUrl.origin;

  // Rewrite Origin/Referer so SvelteKit CSRF check passes
  if (headers.has('origin')) {
    headers.set('origin', targetOrigin);
  }
  if (headers.has('referer')) {
    try {
      const referer = new URL(headers.get('referer')!);
      referer.host = targetUrl.host;
      referer.protocol = targetUrl.protocol;
      headers.set('referer', referer.toString());
    } catch {
      // Keep original if malformed
    }
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;

  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    ...(hasBody ? { duplex: 'half' as const } : {}),
    redirect: 'manual',
  });

  return serviceBinding ? serviceBinding.fetch(proxyRequest) : fetch(proxyRequest);
}

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function requestUsesHttp(c: Context<{ Bindings: Env }>): boolean {
  const requestUrl = new URL(c.req.url);
  if (requestUrl.protocol === 'http:') {
    return true;
  }

  return (c.req.header('x-forwarded-proto') ?? '').toLowerCase() === 'http';
}

async function redirectExternalHttpToHttps(c: Context<{ Bindings: Env }>, next: Next) {
  const requestUrl = new URL(c.req.url);
  if (!requestUsesHttp(c) || isLoopbackHost(requestUrl.hostname)) {
    return next();
  }

  requestUrl.protocol = 'https:';
  return c.redirect(requestUrl.toString(), 308);
}

function notFoundResponse(): Response {
  return Response.json(
    {
      error: 'not_found',
      message: 'The requested resource was not found',
    },
    { status: 404 }
  );
}

// Middleware
app.use('*', redirectExternalHttpToHttps);
app.use('*', logger());

// Enhanced security headers
// Skip for /authorize endpoint to allow form_post response mode with nonce-based CSP
// Skip for /session/check to allow iframe embedding (OIDC Session Management)
// Skip for /logout to allow frontchannel logout iframes (OIDC Front-Channel Logout 1.0)
app.use('*', async (c, next) => {
  // Skip secure headers for /authorize and /flow endpoints (handled by op-auth worker with nonce-based CSP)
  // Skip for /session/check endpoint (OIDC Session Management iframe needs custom headers)
  // Skip for /logout endpoint (OIDC Front-Channel Logout needs to embed iframes)
  // Skip for /logged-out and /logout-error (ar-auth returns inline-styled HTML pages)
  // Skip for /admin-init-setup (needs unpkg.com CDN for WebAuthn library)
  // Skip for /api/ciba/test (development test page with inline scripts/styles)
  // Skip for UI proxy paths (SvelteKit uses inline styles/scripts and CDN fonts)
  const path = c.req.path;
  if (
    path === '/authorize' ||
    path.startsWith('/authorize/') ||
    path.startsWith('/flow/') ||
    path === '/session/check' ||
    path === '/logout' ||
    path === '/logged-out' ||
    path === '/logout-error' ||
    path.startsWith('/admin-init-setup') ||
    path === '/api/ciba/test' ||
    path.startsWith('/saml/') ||
    isGakuNinShibbolethSAML2IdPPath(path) ||
    // UI proxy paths - UI Workers handle their own headers
    path.startsWith('/setup') ||
    path.startsWith('/admin') ||
    path.startsWith('/discover') ||
    path.startsWith('/invite') ||
    path.startsWith('/login') ||
    path.startsWith('/signup') ||
    path.startsWith('/consent') ||
    path.startsWith('/device') ||
    path.startsWith('/ciba') ||
    path.startsWith('/reauth') ||
    path.startsWith('/verify-email-code') ||
    path.startsWith('/error') ||
    path.startsWith('/api/set-language') ||
    path.startsWith('/callback') ||
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
 * Configuration priority:
 * 1. KV (tenant.allowed_origins) - Dynamic configuration from Admin UI
 * 2. Environment variable (ALLOWED_ORIGINS) - Deploy-time fallback
 * 3. Default (empty) - Allow all without credentials
 *
 * Security considerations:
 * - Per CORS spec, when credentials: true, origin cannot be '*'
 * - If ALLOWED_ORIGINS is set, validates against whitelist with credentials enabled
 * - If not set, uses '*' with credentials disabled (safe default for public APIs)
 * - Supports wildcards (e.g., https://*.example.com)
 */
app.use('*', async (c, next) => {
  let allowedOriginsStr: string | null = null;

  // 1. Try to get from KV (tenant-aware settings)
  if (c.env.AUTHRIM_CONFIG) {
    try {
      // Resolve tenant from Host header for multi-tenant CORS settings
      const hostResult = validateHostHeader(c.req.header('Host'), c.env);
      const tenantId =
        hostResult.valid && hostResult.tenantId ? hostResult.tenantId : getDefaultTenantId(c.env);

      const kvData = await c.env.AUTHRIM_CONFIG.get(`settings:tenant:${tenantId}:tenant`);
      if (kvData) {
        const parsed = JSON.parse(kvData) as Record<string, unknown>;
        const kvValue = parsed['tenant.allowed_origins'];
        if (typeof kvValue === 'string' && kvValue.length > 0) {
          allowedOriginsStr = kvValue;
        }
      }
    } catch {
      // KV read error - continue with env fallback
      // fail-safe: don't block requests due to KV issues
    }
  }

  // 2. Fallback to environment variable
  if (!allowedOriginsStr && c.env.ALLOWED_ORIGINS) {
    allowedOriginsStr = c.env.ALLOWED_ORIGINS;
  }

  // 3. Parse allowed origins (supports wildcards)
  const allowedOrigins = allowedOriginsStr ? parseAllowedOrigins(allowedOriginsStr) : null;

  // Determine if credentials should be allowed
  // Only allow credentials when specific origins are configured
  const allowCredentials = !!allowedOrigins && allowedOrigins.length > 0;

  // Origin validation function (supports wildcards)
  const validateOrigin = (origin: string): string | undefined | null => {
    if (!allowedOrigins || allowedOrigins.length === 0) {
      // No whitelist configured: allow all origins but without credentials
      return origin;
    }
    // Check against whitelist with wildcard support
    if (isAllowedOrigin(origin, allowedOrigins)) {
      return origin;
    }
    // Origin not in whitelist
    return null;
  };

  return cors({
    origin: validateOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'DPoP',
      'If-Match',
      'If-None-Match',
      'X-Tenant-Id',
      'X-Diagnostic-Session-Id',
      'Idempotency-Key',
      'Authrim-Step-Up-Receipt',
    ],
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

app.use('*', async (c, next) => {
  if (!isBearerTokenCanonicalPath(c.req.path)) {
    return next();
  }

  // Canonical Authrim endpoints only accept bearer tokens via Authorization headers.
  // Query/form token transport is deferred to explicit outbound legacy adapters, not inbound APIs.
  const url = new URL(c.req.url);
  if (url.searchParams.has('access_token')) {
    return bearerTokenTransportError();
  }

  if (await requestHasFormBearerToken(c.req.raw)) {
    return bearerTokenTransportError();
  }

  return next();
});

// CSRF protection (defense-in-depth at the router level)
// Validates Origin/Referer on state-changing requests before forwarding to workers.
// Each worker also has its own CSRF protection for additional security.
// Excluded paths: server-to-server OAuth protocol endpoints that use client credentials,
// not cookies, and may be called from server environments without Origin headers.
app.use(
  '*',
  csrfProtectionMiddleware({
    excludePaths: [
      '/authorize', // OAuth authorization endpoint (form_post from login UI or RP redirects)
      '/token', // OAuth token endpoint (client_secret auth)
      '/par', // Pushed Authorization Request (client auth)
      '/introspect', // Token introspection (client auth)
      '/revoke', // Token revocation (client auth)
      '/register', // Dynamic Client Registration (initial access token)
      '/clients', // RFC 7592 client configuration endpoints (registration_access_token)
      '/userinfo', // UserInfo endpoint (Bearer token auth, not cookies)
      '/logout/backchannel', // Back-channel logout (RP server-to-server)
      '/device_authorization', // Device flow (client auth)
      '/device', // Device verification page (form submission, CSRF handled by device code)
      '/bc-authorize', // CIBA (client auth)
      '/api/auth/discovery', // Public discovery + discovery-grant endpoints used by Login UI server-side fetches
      '/auth/step-up', // Step-up orchestration (Bearer/receipt/idempotency-key based)
      '/me', // Self-service API (Bearer token auth, not cookie CSRF)
      '/api/admin-init-setup', // Initial admin setup has its own CSRF token + origin validation
      '/vci', // OpenID4VCI endpoints (bearer/proof-based, not cookie CSRF)
      '/vp', // OpenID4VP endpoints (protocol callbacks)
      '/did', // DID resolution endpoints (read-only protocol API)
      '/scim/v2', // SCIM provisioning (Bearer token)
      '/api/internal', // Internal API (Bearer token)
      '/saml', // SAML endpoints (XML-based protocol, not browser fetch)
      '/api/admin/saml', // SAML admin APIs are served by the SAML worker
      '/.well-known', // Discovery endpoints (read-only, GET only)
      '/jwks.json', // JWKS endpoint (read-only)
    ],
  })
);

// Health check endpoints
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'authrim-router',
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
 * VC well-known endpoints - Route to OP_VC worker when enabled
 */
app.get('/.well-known/openid-credential-issuer', async (c) => {
  if (!c.env.OP_VC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_VC.fetch(request);
});

app.get('/.well-known/openid-credential-verifier', async (c) => {
  if (!c.env.OP_VC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_VC.fetch(request);
});

app.get('/.well-known/did.json', async (c) => {
  if (!c.env.OP_VC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_VC.fetch(request);
});

/**
 * Discovery endpoints - Route to OP_DISCOVERY worker
 * - /.well-known/openid-configuration
 * - /.well-known/oauth-authorization-server
 * - /.well-known/jwks.json
 * - /.well-known/webfinger
 */
app.get('/.well-known/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
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
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/authorize', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/authorize', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

// Login/Confirm flow endpoints
app.all('/flow/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

// PAR endpoint (RFC 9126)
app.post('/par', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/par', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Token endpoint - Route to OP_TOKEN worker
 * - /token (POST)
 */
app.post('/token', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_TOKEN.fetch(request);
});

/**
 * UserInfo endpoint - Route to OP_USERINFO worker
 * - /userinfo (GET/POST)
 */
app.get('/userinfo', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_USERINFO.fetch(request);
});

app.post('/userinfo', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_USERINFO.fetch(request);
});

app.all('/api/protected/customer-profiles/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
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
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/api/v1/registration-fields', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Diagnostic Logs API v1 - Route to OP_MANAGEMENT worker
 * - /api/v1/diagnostic-logs/ingest
 */
app.all('/api/v1/diagnostic-logs/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

/**
 * Authentication methods endpoint - Route to OP_MANAGEMENT worker
 * Must be registered BEFORE /api/auth/* to take priority.
 * - /api/auth/authentication-methods - Public endpoint for available authentication methods + UI config
 */
app.get('/api/auth/authentication-methods', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});
app.all('/api/auth/discovery', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});
app.all('/api/auth/discovery/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

/**
 * Authentication endpoints - Route to OP_AUTH worker
 * - /api/auth/passkey/* - WebAuthn/Passkey authentication
 * - /api/auth/email-code/* - Email code (OTP) authentication
 * - /api/auth/consent - OAuth consent screen
 * - /api/auth/session/* - ITP-compliant session management (deprecated, use /api/sessions/*)
 */
app.all('/api/auth/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/auth/login-challenge', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/auth/consent', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/auth/consent', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
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
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * OIDC Session Management 1.0 - Check Session Iframe
 * - /session/check - Iframe for RPs to monitor session state
 */
app.get('/session/check', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
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
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.post('/logout/backchannel', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/logged-out', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.get('/logout-error', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Device Flow endpoints - Route to OP_ASYNC worker
 * - /device_authorization (POST) - RFC 8628: Device Authorization Grant
 * - /device (GET/POST) - User verification page (minimal HTML for OIDC conformance)
 * - /api/device/* - Headless JSON APIs for SvelteKit UI and WebSDK
 */
app.post('/device_authorization', async (c) => {
  if (!c.env.OP_ASYNC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.get('/device', async (c) => {
  if (!c.env.OP_ASYNC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.post('/device', async (c) => {
  if (!c.env.OP_ASYNC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.all('/api/device/*', async (c) => {
  if (!c.env.OP_ASYNC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

/**
 * CIBA (Client Initiated Backchannel Authentication) endpoints - Route to OP_ASYNC worker
 * - /bc-authorize (POST) - OIDC CIBA: Backchannel Authentication Request
 * - /api/ciba/* - Headless JSON APIs for CIBA approval UI
 */
app.post('/bc-authorize', async (c) => {
  if (!c.env.OP_ASYNC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

app.all('/api/ciba/*', async (c) => {
  if (!c.env.OP_ASYNC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_ASYNC.fetch(request);
});

/**
 * Management endpoints - Route to OP_MANAGEMENT worker
 * - /register (POST) - Dynamic Client Registration (OIDC standard)
 * - /clients/:client_id (GET/PUT/DELETE) - Client Configuration Management (RFC 7592)
 * - /introspect (POST) - Token Introspection (OAuth 2.0 standard)
 * - /revoke (POST) - Token Revocation (OAuth 2.0 standard)
 * - /api/admin/* - Admin API (users, clients, stats)
 * - /api/avatars/* - Avatar images
 * - /scim/v2/* - SCIM 2.0 User Provisioning (RFC 7643, 7644)
 */
app.post('/register', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.get('/clients/:client_id', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.put('/clients/:client_id', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.delete('/clients/:client_id', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.post('/introspect', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.post('/revoke', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

// Batch Token Revocation endpoint (RFC 7009 extension)
app.post('/revoke/batch', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

/**
 * Admin API routing - conditionally route to OP_AUTH or OP_MANAGEMENT
 *
 * /api/admin/auth/* - Route to OP_AUTH worker (admin passkey login endpoints)
 * /api/admin/setup-token/* - Route to OP_AUTH worker (admin setup token endpoints)
 * /api/admin/* - Route to OP_MANAGEMENT worker (admin management endpoints)
 *
 * Note: Using conditional routing instead of separate route registrations
 * because Hono's wildcard pattern matching doesn't guarantee more specific
 * patterns are matched first when using app.all().
 */
app.all('/api/admin/*', async (c) => {
  const path = c.req.path;
  const request = createServiceBindingRequest(c.req.raw);

  // Route admin auth endpoints to OP_AUTH
  if (path.startsWith('/api/admin/auth/')) {
    return c.env.OP_AUTH.fetch(request);
  }

  // Route admin setup token endpoints to OP_AUTH
  if (path.startsWith('/api/admin/setup-token/')) {
    return c.env.OP_AUTH.fetch(request);
  }

  // Route SAML admin endpoints to OP_SAML.
  if (
    matchesPathGroup(path, '/api/admin/saml-providers') ||
    matchesPathGroup(path, '/api/admin/saml-settings') ||
    matchesPathGroup(path, '/api/admin/saml-attribute-presets') ||
    matchesPathGroup(path, '/api/admin/saml-metadata')
  ) {
    if (!c.env.OP_SAML) {
      return notFoundResponse();
    }
    return c.env.OP_SAML.fetch(request);
  }

  // Route all other admin endpoints to OP_MANAGEMENT
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.all('/api/approval-artifacts/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.all('/api/approval-receipts/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.all('/auth/step-up/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.all('/me/devices', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.all('/me/devices/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

app.get('/api/avatars/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

// SCIM 2.0 endpoints - RFC 7643, 7644
app.all('/scim/v2/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
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
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_MANAGEMENT.fetch(request);
});

/**
 * SAML 2.0 endpoints - Route to OP_SAML worker
 * - /saml/idp/* - IdP endpoints (metadata, SSO, SLO, IdP-initiated)
 * - /saml/sp/* - SP endpoints (metadata, ACS, login, SLO)
 * - /saml/admin/* - Admin API for SAML provider management
 * - /idp/profile/SAML2/* - GakuNin/Shibboleth SAML2 IdP compatibility aliases
 */
app.all('/saml/*', async (c) => {
  if (!c.env.OP_SAML) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_SAML.fetch(request);
});

app.all('/idp/profile/SAML2/*', async (c) => {
  if (!isGakuNinShibbolethSAML2IdPPath(c.req.path)) {
    return notFoundResponse();
  }
  if (!c.env.OP_SAML) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_SAML.fetch(request);
});

/**
 * VC / DID endpoints - Route to OP_VC worker when enabled
 */
app.all('/vci/*', async (c) => {
  if (!c.env.OP_VC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_VC.fetch(request);
});

app.all('/vp/*', async (c) => {
  if (!c.env.OP_VC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_VC.fetch(request);
});

app.all('/did/*', async (c) => {
  if (!c.env.OP_VC) {
    return notFoundResponse();
  }
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_VC.fetch(request);
});

/**
 * External IdP endpoints - Route to EXTERNAL_IDP worker
 * - /auth/external/providers - List available external IdP providers
 * - /auth/external/:provider/start - Start external IdP login
 * - /auth/external/:provider/callback - Handle OAuth callback
 * - /auth/external/link - Link/unlink external identities
 * - /api/external/* - Backward-compatible external IdP path
 * - /external-idp/admin/* - Admin API for external IdP management
 */
app.all('/auth/external/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.EXTERNAL_IDP.fetch(request);
});

app.all('/api/external/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.EXTERNAL_IDP.fetch(request);
});

app.all('/handoff/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.EXTERNAL_IDP.fetch(request);
});

app.all('/external-idp/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.EXTERNAL_IDP.fetch(request);
});

/**
 * Internal endpoints - Route to OP_AUTH worker
 * - /_internal/warmup - Pre-heat Durable Objects (admin only)
 */
app.all('/_internal/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * Initial Admin Setup endpoints - Route to OP_AUTH worker
 * - /admin-init-setup - Initial admin setup page (one-time use, expires in 1 hour)
 * - /api/admin-init-setup/* - Setup API endpoints
 */
app.get('/admin-init-setup', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

app.all('/api/admin-init-setup/*', async (c) => {
  const request = createServiceBindingRequest(c.req.raw);
  return c.env.OP_AUTH.fetch(request);
});

/**
 * UI Proxy endpoints - proxy to UI Workers
 * When enabled, serves UI from the same domain as the API
 *
 * Admin UI Proxy (ENABLE_ADMIN_UI_PROXY=true):
 * - /admin/* - Admin dashboard pages
 *
 * Login UI Proxy (ENABLE_LOGIN_UI_PROXY=true):
 * - /discover, /invite, /login, /signup, /consent, /device, /ciba, /reauth, /verify-email-code, /error
 */

// Admin UI proxy - /admin/*
app.all('/admin/*', async (c) => {
  if (c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL) {
    const path = c.req.path;
    return proxyToUiWorker(c.req.raw, c.env.AR_ADMIN_UI_URL, path, c.env.ADMIN_UI_WORKER);
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

// Admin UI proxy - /setup/* (initial admin setup completion flow)
// After passkey registration, ar-auth redirects to /setup/complete
app.all('/setup/*', async (c) => {
  if (c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL) {
    return proxyToUiWorker(c.req.raw, c.env.AR_ADMIN_UI_URL, c.req.path, c.env.ADMIN_UI_WORKER);
  }
  return c.json({ error: 'not_found', message: 'Admin UI proxy is not enabled' }, 404);
});

// Admin UI proxy - exact /admin path (redirect to /admin/)
app.get('/admin', async (c) => {
  if (c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL) {
    return proxyToUiWorker(c.req.raw, c.env.AR_ADMIN_UI_URL, '/admin', c.env.ADMIN_UI_WORKER);
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
      return proxyToUiWorker(c.req.raw, c.env.AR_LOGIN_UI_URL, c.req.path, c.env.LOGIN_UI_WORKER);
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
      return proxyToUiWorker(c.req.raw, c.env.AR_LOGIN_UI_URL, c.req.path, c.env.LOGIN_UI_WORKER);
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
// This handles /geo/* paths for WorldMap GeoJSON data (Admin UI only)
app.get('/geo/*', async (c) => {
  if (c.env.ENABLE_ADMIN_UI_PROXY === 'true' && c.env.AR_ADMIN_UI_URL) {
    return proxyToUiWorker(c.req.raw, c.env.AR_ADMIN_UI_URL, c.req.path, c.env.ADMIN_UI_WORKER);
  }
  return c.json({ error: 'not_found', message: 'Admin UI proxy is not enabled' }, 404);
});

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
    const serviceBinding = ui.name === 'admin' ? c.env.ADMIN_UI_WORKER : c.env.LOGIN_UI_WORKER;
    const response = await proxyToUiWorker(c.req.raw.clone(), ui.url, c.req.path, serviceBinding);
    if (response.ok) {
      return response;
    }
  }

  return c.json({ error: 'not_found', message: 'Static asset not found in any UI' }, 404);
});

// Root Admin UI custom domains are covered by the wildcard host route without a path suffix.
app.get('/', async (c) => {
  const requestHost = new URL(c.req.url).hostname.toLowerCase();
  const loginUiHost = getConfiguredUrlHostname(c.env.LOGIN_UI_URL);
  const adminUiHost =
    getConfiguredUrlHostname(c.env.ADMIN_UI_URL) ||
    (c.env.BASE_DOMAIN ? `admin.${c.env.BASE_DOMAIN.toLowerCase()}` : null);
  const loginEnabled = c.env.ENABLE_LOGIN_UI_PROXY === 'true' && !!c.env.AR_LOGIN_UI_URL;
  const requestIsLoginUiHost = loginEnabled && loginUiHost !== null && requestHost === loginUiHost;
  if (
    adminUiHost &&
    requestHost === adminUiHost &&
    !requestIsLoginUiHost &&
    c.env.ENABLE_ADMIN_UI_PROXY === 'true' &&
    c.env.AR_ADMIN_UI_URL
  ) {
    return proxyToUiWorker(c.req.raw, c.env.AR_ADMIN_UI_URL, '/', c.env.ADMIN_UI_WORKER);
  }

  if (loginEnabled) {
    return proxyToUiWorker(c.req.raw, c.env.AR_LOGIN_UI_URL!, '/', c.env.LOGIN_UI_WORKER);
  }

  // Return basic API info when Login UI proxy is not enabled.
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

// Export for Cloudflare Workers
export default app;

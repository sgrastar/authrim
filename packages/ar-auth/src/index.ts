import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  getRateLimitProfileAsync,
  isAllowedOrigin,
  parseAllowedOrigins,
  requestContextMiddleware,
  createErrorResponse,
  AR_ERROR_CODES,
  // UI Configuration
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  // Plugin Context (Phase 9 - Plugin Architecture)
  pluginContextMiddleware,
  createPluginLoader,
  // Logger
  getLogger,
} from '@authrim/ar-lib-core';
import { resendEmailPlugin } from '@authrim/ar-lib-plugin';

// Import handlers
import { authorizeHandler, authorizeConfirmHandler, authorizeLoginHandler } from './authorize';
import { parHandler } from './par';
import {
  passkeyRegisterOptionsHandler,
  passkeyRegisterVerifyHandler,
  passkeyLoginOptionsHandler,
  passkeyLoginVerifyHandler,
} from './passkey';
import { emailCodeSendHandler, emailCodeVerifyHandler } from './email-code';
import { consentGetHandler, consentPostHandler } from './consent';
import { loginChallengeGetHandler } from './login-challenge';
import {
  issueSessionTokenHandler,
  verifySessionTokenHandler,
  sessionStatusHandler,
  refreshSessionHandler,
  checkSessionIframeHandler,
} from './session-management';
import { frontChannelLogoutHandler, backChannelLogoutHandler } from './logout';
import { warmupHandler } from './warmup';
import { configHandler } from './config';
import { didAuthChallengeHandler, didAuthVerifyHandler } from './did-auth';
import {
  didRegisterChallengeHandler,
  didRegisterVerifyHandler,
  didListHandler,
  didUnlinkHandler,
} from './did-link';
import { anonLoginChallengeHandler, anonLoginVerifyHandler } from './anon-login';
import { upgradeHandler, upgradeCompleteHandler, upgradeStatusHandler } from './upgrade';
import { setupApp } from './setup';
import { adminSetupApiApp } from './admin-setup-api';
import { flowApi } from './flow-engine';
import {
  directPasskeyLoginStartHandler,
  directPasskeyLoginFinishHandler,
  directPasskeySignupStartHandler,
  directPasskeySignupFinishHandler,
  directPasskeyRegisterStartHandler,
  directPasskeyRegisterFinishHandler,
  directEmailCodeSendHandler,
  directEmailCodeVerifyHandler,
  directTokenHandler,
  directSessionHandler,
  directLogoutHandler,
} from './direct-auth';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', requestContextMiddleware());

// Plugin Context - provides access to notifiers, idp handlers, authenticators
// Plugins are loaded lazily on first request and cached per Worker lifecycle
// Configuration resolved: KV → env → configSchema defaults
const loadPlugins = createPluginLoader([{ plugin: resendEmailPlugin }]);
app.use('*', pluginContextMiddleware({ loadPlugins }));

// Enhanced security headers
// Skip for /session/check endpoint (OIDC Session Management iframe needs custom headers)
// Skip for /logout endpoint (OIDC Front-Channel Logout needs to embed iframes to call RPs)
// Skip for /setup endpoint (Initial admin setup needs external CDN for WebAuthn library)
app.use('*', async (c, next) => {
  // Skip secure headers for /session/check - it returns custom headers for iframe embedding
  // Skip secure headers for /logout - frontchannel logout embeds iframes to notify RPs
  // Skip secure headers for /admin-init-setup - needs unpkg.com CDN for WebAuthn library
  if (
    c.req.path === '/session/check' ||
    c.req.path === '/logout' ||
    c.req.path.startsWith('/admin-init-setup')
  ) {
    return next();
  }

  return secureHeaders({
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
  })(c, next);
});

// CORS configuration with origin validation
// Priority: KV (tenant.allowed_origins) > env (ALLOWED_ORIGINS) > ISSUER_URL
app.use('*', async (c, next) => {
  // Try to get allowed origins from KV (Settings Manager format)
  let allowedOriginsValue: string | undefined;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const kvData = await c.env.AUTHRIM_CONFIG.get('settings:tenant:default:tenant');
      if (kvData) {
        const settings = JSON.parse(kvData) as Record<string, unknown>;
        if (typeof settings['tenant.allowed_origins'] === 'string') {
          allowedOriginsValue = settings['tenant.allowed_origins'];
        }
      }
    } catch {
      // KV read failed, fall through to env
    }
  }

  // Fallback to environment variable, then ISSUER_URL
  const allowedOriginsEnv = allowedOriginsValue || c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
  const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

  const corsMiddleware = cors({
    origin: (origin) => {
      // Allow requests without Origin header (same-origin or non-browser)
      if (!origin) {
        return c.env.ISSUER_URL;
      }

      // Validate against allowlist
      if (isAllowedOrigin(origin, allowedOrigins)) {
        return origin;
      }

      // Reject unauthorized origins
      return '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
    credentials: true,
  });

  return corsMiddleware(c, next);
});

// Rate limiting for sensitive endpoints
// Configurable via KV (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
// or RATE_LIMIT_PROFILE env var for profile selection
app.use('/authorize', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/authorize'],
  })(c, next);
});

app.use('/par', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/par'],
  })(c, next);
});

// Rate limiting for anonymous login endpoints (architecture-decisions.md §17)
// Strict profile: prevent brute-force attacks on device authentication
app.use('/api/auth/anon-login/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/anon-login/challenge', '/api/auth/anon-login/verify'],
  })(c, next);
});

// Rate limiting for upgrade endpoints (architecture-decisions.md §17)
// Moderate profile: balance security and usability for account upgrade
app.use('/api/auth/upgrade', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/upgrade'],
  })(c, next);
});
app.use('/api/auth/upgrade/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/upgrade/complete', '/api/auth/upgrade/status'],
  })(c, next);
});

// Health check endpoint (accessible via /api/auth/health due to route pattern)
app.get('/api/auth/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ar-auth',
    version: '0.1.0',
    codeVersion: c.env.CODE_VERSION_UUID?.substring(0, 8) || 'not-set',
    deployTime: c.env.DEPLOY_TIME_UTC || 'not-set',
    timestamp: new Date().toISOString(),
  });
});

// DO Warmup endpoint - Pre-heat Durable Objects to eliminate cold start latency
// Call before load testing or after deployment to warm all DO shards
app.get('/_internal/warmup', warmupHandler);

// Config endpoint - Debug shard configuration (KV, ENV, defaults)
// Useful for diagnosing configuration mismatches
app.get('/_internal/config', configHandler);

// Authorization endpoint
// OIDC Core 3.1.2.1: MUST support both GET and POST methods
app.get('/authorize', authorizeHandler);
app.post('/authorize', authorizeHandler);

// Authorization confirmation endpoint (for max_age re-authentication)
app.get('/flow/confirm', authorizeConfirmHandler);
app.post('/flow/confirm', authorizeConfirmHandler);

// Authorization login endpoint (for session-less authentication)
app.get('/flow/login', authorizeLoginHandler);
app.post('/flow/login', authorizeLoginHandler);

// PAR (Pushed Authorization Request) endpoint - RFC 9126
app.post('/par', parHandler);

// PAR endpoint should reject non-POST methods
app.get('/par', (c) => {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_METHOD_NOT_ALLOWED);
});

// Passkey/WebAuthn endpoints
app.post('/api/auth/passkeys/register/options', passkeyRegisterOptionsHandler);
app.post('/api/auth/passkeys/register/verify', passkeyRegisterVerifyHandler);
app.post('/api/auth/passkeys/login/options', passkeyLoginOptionsHandler);
app.post('/api/auth/passkeys/login/verify', passkeyLoginVerifyHandler);

// Email Code (OTP) endpoints
app.post('/api/auth/email-codes/send', emailCodeSendHandler);
app.post('/api/auth/email-codes/verify', emailCodeVerifyHandler);

// DID Authentication endpoints (Phase 9)
// Challenge-response pattern for DID-based authentication
app.post('/api/auth/dids/challenge', didAuthChallengeHandler);
app.post('/api/auth/dids/verify', didAuthVerifyHandler);

// DID Link Management endpoints (Phase 9)
// Register new DID to existing account (requires authenticated session)
app.post('/api/auth/dids/register/challenge', didRegisterChallengeHandler);
app.post('/api/auth/dids/register/verify', didRegisterVerifyHandler);
// List linked DIDs (GET /api/auth/dids = list)
app.get('/api/auth/dids', didListHandler);
// Unlink a DID (DELETE /api/auth/dids/:did)
app.delete('/api/auth/dids/:did', didUnlinkHandler);

// Anonymous Login endpoints (architecture-decisions.md §17)
// Device-based anonymous authentication with upgrade capability
app.post('/api/auth/anon-login/challenge', anonLoginChallengeHandler);
app.post('/api/auth/anon-login/verify', anonLoginVerifyHandler);

// Anonymous User Upgrade endpoints (architecture-decisions.md §17)
// Upgrade anonymous users to full accounts
app.post('/api/auth/upgrade', upgradeHandler);
app.post('/api/auth/upgrade/complete', upgradeCompleteHandler);
app.get('/api/auth/upgrade/status', upgradeStatusHandler);

// OAuth Consent endpoints (API)
app.get('/api/auth/consents', consentGetHandler);
app.post('/api/auth/consents', consentPostHandler);

// OAuth Consent endpoints (Builtin Forms - for OIDC conformance testing)
// These routes are used when shouldUseBuiltinForms() returns true
app.get('/auth/consent', consentGetHandler);
app.post('/auth/consent', consentPostHandler);

// Login Challenge endpoints (for OIDC Dynamic OP conformance - logo_uri, policy_uri, tos_uri display)
app.get('/api/auth/login-challenges', loginChallengeGetHandler);

// Session Management endpoints (RESTful naming)
app.post('/api/sessions', issueSessionTokenHandler); // Issue new session token
app.post('/api/sessions/verify', verifySessionTokenHandler); // Verify session token
app.get('/api/sessions/status', sessionStatusHandler); // Check session status
app.post('/api/sessions/refresh', refreshSessionHandler); // Refresh session expiration

// OIDC Session Management 1.0 - Check Session Iframe
app.get('/session/check', checkSessionIframeHandler); // Check session iframe for RPs

// Logout endpoints
app.get('/logout', frontChannelLogoutHandler);
app.post('/logout/backchannel', backChannelLogoutHandler);

// Logged out page - displayed after successful logout when no valid post_logout_redirect_uri
// Conformance mode: show built-in HTML
// UI configured: redirect to external UI's logged-out page
// Neither: return configuration error
app.get('/logged-out', async (c) => {
  // Check conformance mode and UI configuration
  if (await shouldUseBuiltinForms(c.env)) {
    // Conformance mode: show built-in HTML
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logged Out - Authrim</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem 3rem;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      text-align: center;
      max-width: 400px;
    }
    .icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      color: #333;
      margin-bottom: 0.5rem;
      font-size: 1.5rem;
    }
    p {
      color: #666;
      margin-bottom: 1.5rem;
    }
    .footer {
      margin-top: 2rem;
      color: #999;
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✓</div>
    <h1>You have been logged out</h1>
    <p>Your session has been successfully terminated.</p>
    <p>You may close this window or navigate to your application.</p>
    <div class="footer">Powered by Authrim</div>
  </div>
</body>
</html>`;
    return c.html(html);
  }

  // Check UI configuration
  const uiConfig = await getUIConfig(c.env);
  if (uiConfig?.baseUrl) {
    const url = buildUIUrl(uiConfig, 'loggedOut');
    return c.redirect(url, 302);
  }

  // No UI configured and conformance mode disabled
  return c.json(createConfigurationError(), 500);
});

// ===== Direct Authentication API v1 =====
// BetterAuth-style API for custom login pages
// Uses Authorization Code + PKCE pattern for security

// Rate limiting for Direct Auth endpoints
// Strict profile for send endpoints (prevent abuse)
app.use('/api/v1/auth/direct/email-code/send', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/v1/auth/direct/email-code/send'],
  })(c, next);
});

// Moderate profile for other Direct Auth endpoints
app.use('/api/v1/auth/direct/*', async (c, next) => {
  // Skip if already handled by strict profile
  if (c.req.path === '/api/v1/auth/direct/email-code/send') {
    return next();
  }
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/v1/auth/direct'],
  })(c, next);
});

// Passkey Login endpoints
app.post('/api/v1/auth/direct/passkey/login/start', directPasskeyLoginStartHandler);
app.post('/api/v1/auth/direct/passkey/login/finish', directPasskeyLoginFinishHandler);

// Passkey Signup endpoints
app.post('/api/v1/auth/direct/passkey/signup/start', directPasskeySignupStartHandler);
app.post('/api/v1/auth/direct/passkey/signup/finish', directPasskeySignupFinishHandler);

// Passkey Register endpoints (authenticated user adds additional passkey)
app.post('/api/v1/auth/direct/passkey/register/start', directPasskeyRegisterStartHandler);
app.post('/api/v1/auth/direct/passkey/register/finish', directPasskeyRegisterFinishHandler);

// Email Code endpoints
app.post('/api/v1/auth/direct/email-code/send', directEmailCodeSendHandler);
app.post('/api/v1/auth/direct/email-code/verify', directEmailCodeVerifyHandler);

// Token Exchange endpoint
app.post('/api/v1/auth/direct/token', directTokenHandler);

// Session endpoint
app.get('/api/v1/auth/direct/session', directSessionHandler);

// Logout endpoint
app.post('/api/v1/auth/direct/logout', directLogoutHandler);

// Flow Engine API
// Track C: Flow-based authentication with UIContract
app.route('/api/flow', flowApi);

// Initial Admin Setup routes
// Mounted at /setup and /api/setup/*
// Permanently disabled after first admin account is created
app.route('/', setupApp);

// Admin UI Setup API routes
// Used by Admin UI for passkey registration after initial setup
// Endpoints: /api/admin/setup-token/*
app.route('/', adminSetupApiApp);

// Logout error page - displayed when logout validation fails
// Per OIDC RP-Initiated Logout spec, OP SHOULD display an error page when:
// - post_logout_redirect_uri is not registered
// - id_token_hint is invalid or missing (when required)
// Conformance mode: show built-in HTML
// UI configured: redirect to external UI's logout-error page
// Neither: return configuration error
app.get('/logout-error', async (c) => {
  const error = c.req.query('error') || 'unknown_error';

  // Error messages for different validation failures
  const errorMessages: Record<string, { title: string; description: string }> = {
    unregistered_post_logout_redirect_uri: {
      title: 'Invalid Redirect URI',
      description:
        'The post_logout_redirect_uri provided is not registered for this client. The logout request cannot be completed with the specified redirect URI.',
    },
    invalid_id_token_hint: {
      title: 'Invalid ID Token',
      description:
        'The id_token_hint provided is invalid or has been tampered with. Please ensure you are using a valid ID token issued by this authorization server.',
    },
    id_token_hint_required: {
      title: 'ID Token Required',
      description:
        'An id_token_hint is required when specifying a post_logout_redirect_uri. Please include a valid ID token in your logout request.',
    },
    invalid_client: {
      title: 'Invalid Client',
      description:
        'The client specified in the ID token could not be found. The logout request cannot be processed.',
    },
    unknown_error: {
      title: 'Logout Error',
      description:
        'An error occurred while processing your logout request. Your session may have been terminated, but we could not redirect you to the requested location.',
    },
  };

  const errorInfo = errorMessages[error] || errorMessages['unknown_error'];

  // Check conformance mode
  if (await shouldUseBuiltinForms(c.env)) {
    // Conformance mode: show built-in HTML
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logout Error - Authrim</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
    }
    .container {
      background: white;
      padding: 2rem 3rem;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      text-align: center;
      max-width: 500px;
    }
    .icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      color: #c0392b;
      margin-bottom: 0.5rem;
      font-size: 1.5rem;
    }
    p {
      color: #666;
      margin-bottom: 1rem;
      line-height: 1.6;
    }
    .error-code {
      background: #f8f9fa;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      font-family: monospace;
      color: #666;
      font-size: 0.9rem;
      margin-top: 1rem;
    }
    .footer {
      margin-top: 2rem;
      color: #999;
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠</div>
    <h1>${errorInfo.title}</h1>
    <p>${errorInfo.description}</p>
    <div class="error-code">Error: ${error}</div>
    <div class="footer">Powered by Authrim</div>
  </div>
</body>
</html>`;
    return c.html(html);
  }

  // Check UI configuration
  const uiConfig = await getUIConfig(c.env);
  if (uiConfig?.baseUrl) {
    const url = buildUIUrl(uiConfig, 'error', { error });
    return c.redirect(url, 302);
  }

  // No UI configured and conformance mode disabled
  return c.json(createConfigurationError(), 500);
});

// 404 handler
app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// Error handler
app.onError((err, c) => {
  const log = getLogger(c).module('AR-AUTH');
  log.error('Unhandled error', { action: 'error_handler' }, err);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

// Export for Cloudflare Workers
export default app;

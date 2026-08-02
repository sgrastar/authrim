import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  getRateLimitProfileAsync,
  isAllowedOrigin,
  parseAllowedOrigins,
  requestContextMiddleware,
  diagnosticLoggingMiddleware,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  AR_ERROR_CODES,
  // UI Configuration
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  // Plugin Context (Phase 9 - Plugin Architecture)
  // CSRF Protection
  csrfProtectionMiddleware,
  // Logger
  getLogger,
  // Tenant-aware utilities
  getTenantIdFromContext,
  getTenantSettings,
  adminAuthMiddleware,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';

// Import handlers
import { authorizeHandler, authorizeConfirmHandler, authorizeLoginHandler } from './authorize';
import { parHandler } from './par';
import { adminAgentAuthorizeHandler, adminAgentParHandler } from './admin-agent-oauth';
import {
  adminAgentLoginHandoffConsumeHandler,
  createAdminAgentLoginHandoff,
} from './admin-agent-login-handoff';
import {
  passkeyRegisterOptionsHandler,
  passkeyRegisterVerifyHandler,
  passkeyLoginOptionsHandler,
  passkeyLoginVerifyHandler,
} from './passkey';
import { emailCodeSendHandler, emailCodeVerifyHandler } from './email-code';
import { accountProvisioningStatusHandler } from './account-provisioning';
import {
  totpLoginStartHandler,
  totpLoginVerifyHandler,
  totpSignupActivateHandler,
  totpSignupOptionsHandler,
} from './totp';
import {
  directoryPasswordLoginHandler,
  directoryMigrationEmailCodeSendHandler,
  directoryMigrationEmailCodeVerifyHandler,
  directoryMigrationPasskeyOptionsHandler,
  directoryMigrationPasskeyVerifyHandler,
} from './directory-password-login';
import { directoryConnectorHeartbeatHandler } from './directory-connector-heartbeat';
import { directoryRelayConnectHandler } from './directory-relay-route';
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
import { adminInvitationEnrollmentApp } from './admin-invitation-enrollment';
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
  directSessionCreateHandler,
  directTokenHandler,
  directSessionHandler,
  directLogoutHandler,
} from './direct-auth';
import { validateInvitationHandler, useInvitationHandler } from './invitation-handlers';
import { registrationFieldsHandler } from './registration-fields';
import {
  loginRuntimeEmailVerificationChallengeHandler,
  loginRuntimeInteractionStartHandler,
  loginRuntimeInteractionSubmitHandler,
} from './login-runtime-flow';
import { AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY } from './request-diagnostics';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;
const PHASE0C_DIAGNOSTIC_SESSION = /^phase0c-(?:mail|totp)-[0-9]{14}-[a-f0-9]{6}$/u;
const AUTH_REQUEST_DIAGNOSTIC_PATHS = [
  '/authorize',
  '/api/auth/email-codes/verify',
  '/api/auth/totp/login/start',
  '/api/auth/totp/login/verify',
  '/api/v1/login/interactions/start',
] as const;

interface MiddlewareDiagnosticSpan {
  name: string;
  durationMs: number;
}

interface MiddlewareDiagnosticState {
  sessionId: string;
  startedAt: number;
  lastMarkAt: number;
  spans: MiddlewareDiagnosticSpan[];
}

function sanitizeDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function diagnosticFlagEnabled(env: Env): boolean {
  const value = env.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export function isAuthRequestDiagnosticTimingEnabled(env: Env, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return (
    diagnosticFlagEnabled(env) ||
    (env.AUTHRIM_ENVIRONMENT_NAME === 'test' && PHASE0C_DIAGNOSTIC_SESSION.test(sessionId))
  );
}

function roundDiagnosticDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function getMiddlewareDiagnosticState(
  c: Context<{ Bindings: Env }>
): MiddlewareDiagnosticState | null {
  return (
    ((c as unknown as { get(key: string): unknown }).get(AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY) as
      | MiddlewareDiagnosticState
      | undefined) ?? null
  );
}

function setMiddlewareDiagnosticState(
  c: Context<{ Bindings: Env }>,
  state: MiddlewareDiagnosticState
): void {
  (c as unknown as { set(key: string, value: unknown): void }).set(
    AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY,
    state
  );
}

function appendMiddlewareDiagnosticServerTiming(
  c: Context<{ Bindings: Env }>,
  spans: MiddlewareDiagnosticSpan[]
): void {
  if (spans.length === 0) return;
  const value = spans.map((span) => `${span.name};dur=${span.durationMs.toFixed(1)}`).join(', ');
  const existing = c.res.headers.get('Server-Timing');
  c.res.headers.set('Server-Timing', existing ? `${existing}, ${value}` : value);
}

function recordMiddlewareDiagnosticSpan(c: Context<{ Bindings: Env }>, name: string): void {
  const state = getMiddlewareDiagnosticState(c);
  if (!state) return;
  const now = performance.now();
  state.spans.push({
    name,
    durationMs: roundDiagnosticDurationMs(now - state.lastMarkAt),
  });
  state.lastMarkAt = now;
}

async function timeMiddlewareDiagnosticOperation<T>(
  c: Context<{ Bindings: Env }>,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const state = getMiddlewareDiagnosticState(c);
  if (!state) {
    return operation();
  }
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const now = performance.now();
    state.spans.push({
      name,
      durationMs: roundDiagnosticDurationMs(now - startedAt),
    });
    state.lastMarkAt = now;
  }
}

function authRequestDiagnosticStartMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const sessionId = sanitizeDiagnosticSessionId(c.req.header(DIAGNOSTIC_SESSION_ID_HEADER));
    if (!sessionId || !isAuthRequestDiagnosticTimingEnabled(c.env, sessionId)) {
      return next();
    }

    const startedAt = performance.now();
    setMiddlewareDiagnosticState(c, {
      sessionId,
      startedAt,
      lastMarkAt: startedAt,
      spans: [],
    });

    try {
      await next();
    } finally {
      const state = getMiddlewareDiagnosticState(c);
      if (!state) return;
      recordMiddlewareDiagnosticSpan(c, 'auth_handler_downstream');
      state.spans.push({
        name: 'auth_total',
        durationMs: roundDiagnosticDurationMs(performance.now() - state.startedAt),
      });
      appendMiddlewareDiagnosticServerTiming(c, state.spans);
      c.res.headers.set('X-Authrim-Diagnostic-Session-Id', state.sessionId);
      getLogger(c)
        .module('AUTH-REQUEST-TIMING')
        .info('Auth request middleware diagnostics', {
          diagnosticSessionId: state.sessionId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          timingMs: Object.fromEntries(state.spans.map((span) => [span.name, span.durationMs])),
        });
    }
  };
}

function authRequestDiagnosticCheckpoint(name: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    recordMiddlewareDiagnosticSpan(c, name);
    await next();
  };
}

const AUTH_REQUEST_BODY_MAX_BYTES = 100 * 1024;

// Middleware
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticStartMiddleware());
}
app.use('*', redirectExternalHttpToHttps);
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticCheckpoint('auth_redirect_https'));
}
app.use('*', requestContextMiddleware());
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticCheckpoint('auth_request_context'));
}
app.use('*', (c, next) =>
  bodyLimit({
    maxSize: AUTH_REQUEST_BODY_MAX_BYTES,
    onError: (ctx) =>
      ctx.json(
        {
          error: 'payload_too_large',
          error_description: 'Request body exceeds maximum allowed size',
        },
        413
      ),
  })(c, next)
);
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticCheckpoint('auth_body_limit'));
}
app.use(
  '*',
  diagnosticLoggingMiddleware({
    excludePatterns: [/^\/api\/health/, /^\/health\//, /^\/admin-init-setup/],
  })
);
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticCheckpoint('auth_diagnostic_logging'));
}

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
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticCheckpoint('auth_secure_headers'));
}

// CORS configuration with origin validation
// Priority: env (ALLOWED_ORIGINS) > KV (tenant.allowed_origins) > ISSUER_URL
app.use('*', async (c, next) => {
  // Try to get allowed origins from KV (Settings Manager format)
  let allowedOriginsValue: string | undefined;

  const tenantSettings = await getTenantSettings(
    c.env.AUTHRIM_CONFIG,
    getTenantIdFromContext(c),
    'tenant'
  );
  if (tenantSettings && typeof tenantSettings['tenant.allowed_origins'] === 'string') {
    allowedOriginsValue = tenantSettings['tenant.allowed_origins'];
  }

  // Environment allowlist is an operator-enforced ceiling; KV can only configure origins
  // when no env allowlist is set.
  const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || allowedOriginsValue || c.env.ISSUER_URL;
  const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

  const corsMiddleware = cors({
    origin: (origin) => {
      // Allow requests without Origin header (same-origin or non-browser)
      if (!origin) {
        return getRequestIssuer(c);
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
for (const path of AUTH_REQUEST_DIAGNOSTIC_PATHS) {
  app.use(path, authRequestDiagnosticCheckpoint('auth_cors'));
}

// Rate limiting for sensitive endpoints
// Configurable via KV (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
// or RATE_LIMIT_PROFILE env var for profile selection
app.use('/authorize', async (c, next) => {
  const profile = await timeMiddlewareDiagnosticOperation(c, 'auth_rate_limit_profile', () =>
    getRateLimitProfileAsync(c.env, 'moderate')
  );
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/authorize'],
  })(c, next);
});
app.use('/authorize', authRequestDiagnosticCheckpoint('auth_rate_limit'));

app.use('/par', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/par'],
  })(c, next);
});

app.use('/oauth/admin-agent/par', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/oauth/admin-agent/par'],
  })(c, next);
});

app.use('/oauth/admin-agent/authorize', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/oauth/admin-agent/authorize'],
  })(c, next);
});

app.use('/oauth/admin-agent/login-handoff/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/oauth/admin-agent/login-handoff/consume'],
  })(c, next);
});

app.use(
  '/oauth/admin-agent/authorize',
  adminAuthMiddleware({
    plane: 'tenant',
    sessionOnly: true,
    unauthenticatedRedirect: async (c) => {
      if (c.req.method !== 'GET') return undefined;
      return createAdminAgentLoginHandoff(c);
    },
  })
);
app.use('/oauth/admin-agent/authorize', csrfProtectionMiddleware());

// Rate limiting for anonymous login endpoints (architecture-decisions.md §17)
// Strict profile: prevent brute-force attacks on device authentication
app.use('/api/auth/anon-login/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/anon-login/challenge', '/api/auth/anon-login/verify'],
  })(c, next);
});

// Rate limiting for directory password login. This endpoint reaches an external connector
// and verifies reusable credentials, so keep it stricter than ordinary session reads.
app.use('/api/auth/directory-password/login', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/directory-password/login'],
  })(c, next);
});
app.use('/api/auth/directory-password/migration/passkey/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/directory-password/migration/passkey'],
  })(c, next);
});
app.use('/api/auth/directory-relay/connect/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/directory-relay/connect'],
  })(c, next);
});
app.use('/api/admin/invitations/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/invitations'],
    keyScope: 'global',
    requireAtomic: true,
  })(c, next);
});
app.use('/api/auth/directory-connectors/heartbeat/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/directory-connectors/heartbeat'],
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

// CSRF protection for browser-facing API endpoints
// Validates Origin/Referer on state-changing requests (POST/PUT/PATCH/DELETE)
// Skips Bearer token requests (server-to-server calls are not vulnerable to CSRF)
//
// Note: /authorize and /flow/* are NOT CSRF-protected here because:
// - /authorize POST can receive form_post responses from RPs (cross-origin HTML form auto-submit)
// - /authorize has its own CSRF protection via the state parameter (RFC 6749 §10.12)
// - /flow/* endpoints handle login form submissions from the Login UI
//
// Note: /par, /logout/backchannel are server-to-server endpoints (use client auth, not cookies)
app.use(
  '/api/auth/*',
  csrfProtectionMiddleware({
    excludePaths: ['/api/auth/directory-connectors/heartbeat'],
  })
);
app.use('/api/auth/email-codes/verify', authRequestDiagnosticCheckpoint('auth_csrf'));
app.use('/api/sessions/*', csrfProtectionMiddleware());
app.use('/api/v1/auth/direct/*', csrfProtectionMiddleware());
app.use('/api/v1/login/interactions/*', csrfProtectionMiddleware());
app.use('/api/v1/login/interactions/start', authRequestDiagnosticCheckpoint('auth_csrf'));
app.use('/auth/consent', csrfProtectionMiddleware());
app.use('/api/flow/*', csrfProtectionMiddleware());

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

// Dedicated Admin Agent authorization journey. It never shares PAR state with end-user OAuth.
app.post('/oauth/admin-agent/par', adminAgentParHandler);
app.get('/oauth/admin-agent/authorize', adminAgentAuthorizeHandler);
app.post('/oauth/admin-agent/authorize', adminAgentAuthorizeHandler);
app.get('/oauth/admin-agent/login-handoff/consume', adminAgentLoginHandoffConsumeHandler);

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

// TOTP endpoints
app.post('/api/auth/totp/login/start', totpLoginStartHandler);
app.post('/api/auth/totp/login/verify', totpLoginVerifyHandler);
app.post('/api/auth/totp/signup/options', totpSignupOptionsHandler);
app.post('/api/auth/totp/signup/activate', totpSignupActivateHandler);

// Directory Password endpoint
app.post('/api/auth/directory-password/login', directoryPasswordLoginHandler);
app.post(
  '/api/auth/directory-password/migration/passkey/options',
  directoryMigrationPasskeyOptionsHandler
);
app.post(
  '/api/auth/directory-password/migration/passkey/verify',
  directoryMigrationPasskeyVerifyHandler
);
app.post(
  '/api/auth/directory-password/migration/email-code/send',
  directoryMigrationEmailCodeSendHandler
);
app.post(
  '/api/auth/directory-password/migration/email-code/verify',
  directoryMigrationEmailCodeVerifyHandler
);
app.post(
  '/api/auth/directory-connectors/heartbeat/:tenantId/:connectorId',
  directoryConnectorHeartbeatHandler
);
app.get('/api/auth/directory-relay/connect/:tenantId/:connectorId', directoryRelayConnectHandler);

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
app.get('/auth/login-challenge', loginChallengeGetHandler);

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

app.use('/api/v1/login/interactions/start', async (c, next) => {
  const profile = await timeMiddlewareDiagnosticOperation(c, 'auth_rate_limit_profile', () =>
    getRateLimitProfileAsync(c.env, 'loginStart', c.executionCtx)
  );
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/v1/login/interactions/start'],
    endpointClass: 'loginStart',
  })(c, next);
});
app.use('/api/v1/login/interactions/*', async (c, next) => {
  if (c.req.path === '/api/v1/login/interactions/start') {
    return next();
  }
  const profile = await getRateLimitProfileAsync(c.env, 'moderate', c.executionCtx);
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/v1/login/interactions'],
    endpointClass: 'loginInteraction',
  })(c, next);
});
app.use('/api/v1/login/interactions/start', authRequestDiagnosticCheckpoint('auth_rate_limit'));

app.post('/api/v1/login/interactions/start', loginRuntimeInteractionStartHandler);
app.post(
  '/api/v1/login/interactions/:interaction_id/email-verification/challenge',
  loginRuntimeEmailVerificationChallengeHandler
);
app.post('/api/v1/login/interactions/:interaction_id/submit', loginRuntimeInteractionSubmitHandler);

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
app.post('/api/v1/auth/account-provisioning/status', accountProvisioningStatusHandler);

// Token Exchange endpoint
app.post('/api/v1/auth/direct/token', directTokenHandler);

// Session endpoint
app.post('/api/v1/auth/direct/session', directSessionCreateHandler);
app.get('/api/v1/auth/direct/session', directSessionHandler);

// Logout endpoint
app.post('/api/v1/auth/direct/logout', directLogoutHandler);

// Invitation API (public)
// - GET  /api/v1/invitations/validate?token=xxx  - Validate token
// - POST /api/v1/invitations/use                 - Mark token used
app.get('/api/v1/invitations/validate', validateInvitationHandler);
app.post('/api/v1/invitations/use', useInvitationHandler);

// Registration fields (public)
// - GET /api/v1/registration-fields  - Fields visible on signup form
app.get('/api/v1/registration-fields', registrationFieldsHandler);

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
app.route('/', adminInvitationEnrollmentApp);

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
    <h1>${escapeHtml(errorInfo.title)}</h1>
    <p>${escapeHtml(errorInfo.description)}</p>
    <div class="error-code">Error: ${escapeHtml(error)}</div>
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
  const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, err);
  if (writeFenceResponse) return writeFenceResponse;
  const log = getLogger(c).module('AR-AUTH');
  log.error('Unhandled error', { action: 'error_handler' }, err);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

// Export for Cloudflare Workers
export default app;
export { DirectoryConnectorRelay } from './directory-connector-relay';
export { RuntimeSmokeEntrypoint } from '@authrim/ar-lib-core';

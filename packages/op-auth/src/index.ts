import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@enrai/shared';
import { rateLimitMiddleware, RateLimitProfiles, isAllowedOrigin, parseAllowedOrigins } from '@enrai/shared';

// Import handlers
import { authorizeHandler, authorizeConfirmHandler, authorizeLoginHandler } from './authorize';
import { parHandler } from './par';
import {
  passkeyRegisterOptionsHandler,
  passkeyRegisterVerifyHandler,
  passkeyLoginOptionsHandler,
  passkeyLoginVerifyHandler,
} from './passkey';
import { magicLinkSendHandler, magicLinkVerifyHandler } from './magic-link';
import { consentGetHandler, consentPostHandler } from './consent';
import {
  issueSessionTokenHandler,
  verifySessionTokenHandler,
  sessionStatusHandler,
  refreshSessionHandler,
} from './session-management';
import { frontChannelLogoutHandler, backChannelLogoutHandler } from './logout';

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

// CORS configuration with origin validation
app.use('*', async (c, next) => {
  const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
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
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
    credentials: true,
  });

  return corsMiddleware(c, next);
});

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
app.get('/api/health', (c) => {
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

// Authorization confirmation endpoint (for max_age re-authentication)
app.get('/authorize/confirm', authorizeConfirmHandler);
app.post('/authorize/confirm', authorizeConfirmHandler);

// Authorization login endpoint (for session-less authentication)
app.get('/authorize/login', authorizeLoginHandler);
app.post('/authorize/login', authorizeLoginHandler);

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

// Passkey/WebAuthn endpoints
app.post('/api/auth/passkey/register/options', passkeyRegisterOptionsHandler);
app.post('/api/auth/passkey/register/verify', passkeyRegisterVerifyHandler);
app.post('/api/auth/passkey/login/options', passkeyLoginOptionsHandler);
app.post('/api/auth/passkey/login/verify', passkeyLoginVerifyHandler);

// Magic Link endpoints
app.post('/api/auth/magic-link/send', magicLinkSendHandler);
app.get('/api/auth/magic-link/verify', magicLinkVerifyHandler);

// OAuth Consent endpoints
app.get('/api/auth/consent', consentGetHandler);
app.post('/api/auth/consent', consentPostHandler);

// Session Management endpoints (RESTful naming)
app.post('/api/sessions/issue', issueSessionTokenHandler);      // Issue new session token
app.post('/api/sessions/verify', verifySessionTokenHandler);    // Verify session token
app.get('/api/sessions/status', sessionStatusHandler);          // Check session status
app.post('/api/sessions/refresh', refreshSessionHandler);       // Refresh session expiration

// Logout endpoints
app.get('/logout', frontChannelLogoutHandler);
app.post('/logout/backchannel', backChannelLogoutHandler);

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

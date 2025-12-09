import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/shared';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  isAllowedOrigin,
  parseAllowedOrigins,
  versionCheckMiddleware,
  requestContextMiddleware,
} from '@authrim/shared';

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

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', versionCheckMiddleware('op-auth'));
app.use('*', requestContextMiddleware());

// Enhanced security headers
// Skip for /session/check endpoint (OIDC Session Management iframe needs custom headers)
app.use('*', async (c, next) => {
  // Skip secure headers for /session/check - it returns custom headers for iframe embedding
  if (c.req.path === '/session/check') {
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

// Health check endpoint (accessible via /api/auth/health due to route pattern)
app.get('/api/auth/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-auth',
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

// Email Code (OTP) endpoints
app.post('/api/auth/email-code/send', emailCodeSendHandler);
app.post('/api/auth/email-code/verify', emailCodeVerifyHandler);

// OAuth Consent endpoints
// /api/auth/consent - API style path
app.get('/api/auth/consent', consentGetHandler);
app.post('/api/auth/consent', consentPostHandler);
// /auth/consent - Fallback path (used when UI_URL is not configured)
app.get('/auth/consent', consentGetHandler);
app.post('/auth/consent', consentPostHandler);

// Login Challenge endpoints (for OIDC Dynamic OP conformance - logo_uri, policy_uri, tos_uri display)
app.get('/api/auth/login-challenge', loginChallengeGetHandler);
app.get('/auth/login-challenge', loginChallengeGetHandler);

// Session Management endpoints (RESTful naming)
app.post('/api/sessions/issue', issueSessionTokenHandler); // Issue new session token
app.post('/api/sessions/verify', verifySessionTokenHandler); // Verify session token
app.get('/api/sessions/status', sessionStatusHandler); // Check session status
app.post('/api/sessions/refresh', refreshSessionHandler); // Refresh session expiration

// OIDC Session Management 1.0 - Check Session Iframe
app.get('/session/check', checkSessionIframeHandler); // Check session iframe for RPs

// Logout endpoints
app.get('/logout', frontChannelLogoutHandler);
app.post('/logout/backchannel', backChannelLogoutHandler);

// Logged out page - displayed after successful logout when no valid post_logout_redirect_uri
// If UI_URL is configured, redirect to UI's logged-out page
// Otherwise, show built-in HTML (for conformance testing)
app.get('/logged-out', (c) => {
  // Check if UI_URL is configured - if so, redirect to UI
  const uiUrl = c.env.UI_URL;
  if (uiUrl) {
    return c.redirect(`${uiUrl}/logged-out`, 302);
  }

  // Fallback: show built-in HTML (for conformance testing without UI)
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
});

// Logout error page - displayed when logout validation fails
// Per OIDC RP-Initiated Logout spec, OP SHOULD display an error page when:
// - post_logout_redirect_uri is not registered
// - id_token_hint is invalid or missing (when required)
app.get('/logout-error', (c) => {
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

  // Check if UI_URL is configured - if so, redirect to UI
  const uiUrl = c.env.UI_URL;
  if (uiUrl) {
    return c.redirect(`${uiUrl}/logout-error?error=${encodeURIComponent(error)}`, 302);
  }

  // Fallback: show built-in HTML (for conformance testing without UI)
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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from './types/env';
import { rateLimitMiddleware, RateLimitProfiles } from './middleware/rate-limit';

// Import handlers
import { discoveryHandler } from './handlers/discovery';
import { jwksHandler } from './handlers/jwks';
import { authorizeHandler } from './handlers/authorize';
import { tokenHandler } from './handlers/token';
import { userinfoHandler } from './handlers/userinfo';
import { registerHandler } from './handlers/register';
import { parHandler } from './handlers/par';

/**
 * Validates required environment variables at startup
 * @throws Error if validation fails
 */
function validateEnvironment(env: Env): void {
  const errors: string[] = [];

  // Validate ISSUER_URL
  if (!env.ISSUER_URL) {
    errors.push('ISSUER_URL must be set');
  } else if (!env.ISSUER_URL.startsWith('http://') && !env.ISSUER_URL.startsWith('https://')) {
    errors.push('ISSUER_URL must start with http:// or https://');
  }

  // Validate expiry settings
  const expiryFields = [
    { name: 'TOKEN_EXPIRY', value: env.TOKEN_EXPIRY },
    { name: 'CODE_EXPIRY', value: env.CODE_EXPIRY },
    { name: 'STATE_EXPIRY', value: env.STATE_EXPIRY },
    { name: 'NONCE_EXPIRY', value: env.NONCE_EXPIRY },
  ];

  for (const field of expiryFields) {
    if (!field.value) {
      errors.push(`${field.name} must be set`);
    } else {
      const parsed = parseInt(field.value, 10);
      if (isNaN(parsed) || parsed <= 0) {
        errors.push(`${field.name} must be a positive integer (got: ${field.value})`);
      }
    }
  }

  // Validate KV Namespaces
  const kvNamespaces = [
    { name: 'AUTH_CODES', value: env.AUTH_CODES },
    { name: 'STATE_STORE', value: env.STATE_STORE },
    { name: 'NONCE_STORE', value: env.NONCE_STORE },
    { name: 'CLIENTS', value: env.CLIENTS },
  ];

  for (const ns of kvNamespaces) {
    if (!ns.value) {
      errors.push(`KV Namespace ${ns.name} must be bound`);
    }
  }

  // Throw aggregated errors
  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Environment validation middleware (runs on first request)
let environmentValidated = false;
app.use('*', async (c, next) => {
  if (!environmentValidated) {
    try {
      validateEnvironment(c.env);
      environmentValidated = true;
    } catch (error) {
      console.error('Environment validation failed:', error);
      return c.json(
        {
          error: 'configuration_error',
          message: error instanceof Error ? error.message : 'Invalid environment configuration',
        },
        500
      );
    }
  }
  return await next();
});

// Middleware
app.use('*', logger());

// Enhanced security headers
app.use('*', secureHeaders({
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
}));

// CORS configuration (enabled for OIDC endpoints)
app.use('*', cors({
  origin: '*', // In production, configure specific allowed origins
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400, // 24 hours
  credentials: true,
}));

// Rate limiting for sensitive endpoints
app.use('/token', rateLimitMiddleware({
  ...RateLimitProfiles.strict,
  endpoints: ['/token'],
}));

app.use('/register', rateLimitMiddleware({
  ...RateLimitProfiles.strict,
  endpoints: ['/register'],
}));

app.use('/authorize', rateLimitMiddleware({
  ...RateLimitProfiles.moderate,
  endpoints: ['/authorize'],
}));

// Lenient rate limiting for public discovery endpoints
app.use('/.well-known/*', rateLimitMiddleware({
  ...RateLimitProfiles.lenient,
  endpoints: ['/.well-known'],
}));

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// OpenID Connect Discovery endpoint
app.get('/.well-known/openid-configuration', discoveryHandler);

// JWKS endpoint (JSON Web Key Set)
app.get('/.well-known/jwks.json', jwksHandler);

// Authorization endpoint
// OIDC Core 3.1.2.1: MUST support both GET and POST methods
app.get('/authorize', authorizeHandler);
app.post('/authorize', authorizeHandler);

// Token endpoint
app.post('/token', tokenHandler);

// UserInfo endpoint
app.get('/userinfo', userinfoHandler);
app.post('/userinfo', userinfoHandler);

// Dynamic Client Registration endpoint
app.post('/register', registerHandler);

// PAR (Pushed Authorization Request) endpoint - RFC 9126
app.post('/as/par', rateLimitMiddleware({
  ...RateLimitProfiles.strict,
  endpoints: ['/as/par'],
}), parHandler);

// PAR endpoint should reject non-POST methods
app.get('/as/par', (c) => {
  return c.json({
    error: 'invalid_request',
    error_description: 'PAR endpoint only accepts POST requests',
  }, 405);
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

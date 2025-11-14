import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@enrai/shared';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  initialAccessTokenMiddleware,
} from '@enrai/shared';

// Import handlers
import { registerHandler } from './register';
import { introspectHandler } from './introspect';
import { revokeHandler } from './revoke';
import {
  serveAvatarHandler,
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
  adminClientsListHandler,
  adminClientGetHandler,
  adminUserAvatarUploadHandler,
  adminUserAvatarDeleteHandler,
  adminSessionsListHandler,
  adminSessionGetHandler,
  adminSessionRevokeHandler,
  adminUserRevokeAllSessionsHandler,
} from './admin';

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

// Rate limiting and Initial Access Token for registration endpoint
app.use(
  '/register',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/register'],
  })
);

// Initial Access Token validation for Dynamic Client Registration (RFC 7591)
// Can be disabled by setting OPEN_REGISTRATION=true in environment variables
app.use('/register', initialAccessTokenMiddleware());

app.use(
  '/introspect',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/introspect'],
  })
);

app.use(
  '/revoke',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/revoke'],
  })
);

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-management',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Dynamic Client Registration endpoint - RFC 7591
app.post('/register', registerHandler);

// Token Introspection endpoint - RFC 7662
app.post('/introspect', introspectHandler);

// Token Revocation endpoint - RFC 7009
app.post('/revoke', revokeHandler);

// Avatar serving endpoint
app.get('/api/avatars/:filename', serveAvatarHandler);

// Admin API endpoints
app.get('/api/admin/stats', adminStatsHandler);
app.get('/api/admin/users', adminUsersListHandler);
app.get('/api/admin/users/:id', adminUserGetHandler);
app.post('/api/admin/users', adminUserCreateHandler);
app.put('/api/admin/users/:id', adminUserUpdateHandler);
app.delete('/api/admin/users/:id', adminUserDeleteHandler);
app.post('/api/admin/users/:id/avatar', adminUserAvatarUploadHandler);
app.delete('/api/admin/users/:id/avatar', adminUserAvatarDeleteHandler);
app.get('/api/admin/clients', adminClientsListHandler);
app.get('/api/admin/clients/:id', adminClientGetHandler);

// Admin Session Management endpoints (RESTful naming)
app.get('/api/admin/sessions', adminSessionsListHandler);
app.get('/api/admin/sessions/:id', adminSessionGetHandler);
app.delete('/api/admin/sessions/:id', adminSessionRevokeHandler);        // RESTful: DELETE instead of POST
app.delete('/api/admin/users/:id/sessions', adminUserRevokeAllSessionsHandler);  // RESTful: /sessions instead of /revoke-all-sessions

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

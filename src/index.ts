import { Hono } from 'hono';
// import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from './types/env';

// Import handlers
import { discoveryHandler } from './handlers/discovery';
import { jwksHandler } from './handlers/jwks';
import { authorizeHandler } from './handlers/authorize';
import { tokenHandler } from './handlers/token';
import { userinfoHandler } from './handlers/userinfo';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', secureHeaders());

// CORS is disabled by default for security
// app.use('*', cors());

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
app.get('/authorize', authorizeHandler);

// Token endpoint
app.post('/token', tokenHandler);

// UserInfo endpoint
app.get('/userinfo', userinfoHandler);
app.post('/userinfo', userinfoHandler);

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

/**
 * Authrim SAML 2.0 Worker
 *
 * Implements SAML 2.0 Identity Provider (IdP) and Service Provider (SP) functionality.
 *
 * IdP Endpoints:
 * - GET  /saml/idp/metadata - IdP metadata
 * - GET  /saml/idp/sso      - SSO (HTTP-Redirect Binding)
 * - POST /saml/idp/sso      - SSO (HTTP-POST Binding)
 * - GET  /saml/idp/init     - IdP-initiated SSO
 * - POST /saml/idp/slo      - Single Logout
 *
 * SP Endpoints:
 * - GET  /saml/sp/metadata  - SP metadata
 * - GET  /saml/sp/login     - Initiate login (SP-initiated)
 * - POST /saml/sp/acs       - Assertion Consumer Service
 * - POST /saml/sp/slo       - Single Logout
 *
 * Admin Endpoints:
 * - GET    /saml/admin/providers     - List SAML providers
 * - POST   /saml/admin/providers     - Create SAML provider
 * - GET    /saml/admin/providers/:id - Get SAML provider
 * - PUT    /saml/admin/providers/:id - Update SAML provider
 * - DELETE /saml/admin/providers/:id - Delete SAML provider
 * - POST   /saml/admin/providers/:id/import-metadata - Import metadata
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@authrim/shared';

// Import handlers (to be implemented)
import { handleIdPMetadata } from './idp/metadata';
import { handleIdPSSO } from './idp/sso';
import { handleIdPInitiated } from './idp/idp-initiated';
import { handleIdPSLO } from './idp/slo';
import { handleSPMetadata } from './sp/metadata';
import { handleSPLogin } from './sp/login';
import { handleSPACS } from './sp/acs';
import { handleSPSLO } from './sp/slo';
import {
  handleListProviders,
  handleCreateProvider,
  handleGetProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleImportMetadata,
} from './admin/providers';

// Create Hono app with Cloudflare Workers bindings
const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
    credentials: true,
  })
);

// Health check
app.get('/saml/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'authrim-op-saml',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// IdP Endpoints
// ============================================================================

/**
 * IdP Metadata
 * Returns SAML 2.0 IdP metadata XML document
 */
app.get('/saml/idp/metadata', handleIdPMetadata);

/**
 * SSO Endpoint (HTTP-Redirect Binding)
 * Receives SAML AuthnRequest via URL parameters
 */
app.get('/saml/idp/sso', handleIdPSSO);

/**
 * SSO Endpoint (HTTP-POST Binding)
 * Receives SAML AuthnRequest via POST body
 */
app.post('/saml/idp/sso', handleIdPSSO);

/**
 * IdP-Initiated SSO
 * Generates SAML Response without AuthnRequest
 */
app.get('/saml/idp/init', handleIdPInitiated);

/**
 * Single Logout (IdP) - POST Binding
 */
app.post('/saml/idp/slo', handleIdPSLO);

/**
 * Single Logout (IdP) - Redirect Binding
 */
app.get('/saml/idp/slo', handleIdPSLO);

// ============================================================================
// SP Endpoints
// ============================================================================

/**
 * SP Metadata
 * Returns SAML 2.0 SP metadata XML document
 */
app.get('/saml/sp/metadata', handleSPMetadata);

/**
 * SP Login Initiation
 * Starts SP-initiated SSO flow
 */
app.get('/saml/sp/login', handleSPLogin);

/**
 * Assertion Consumer Service (ACS)
 * Receives and validates SAML Response from IdP
 */
app.post('/saml/sp/acs', handleSPACS);

/**
 * Single Logout (SP) - POST Binding
 */
app.post('/saml/sp/slo', handleSPSLO);

/**
 * Single Logout (SP) - Redirect Binding
 */
app.get('/saml/sp/slo', handleSPSLO);

// ============================================================================
// Admin Endpoints
// ============================================================================

/**
 * List SAML Providers
 */
app.get('/saml/admin/providers', handleListProviders);

/**
 * Create SAML Provider
 */
app.post('/saml/admin/providers', handleCreateProvider);

/**
 * Get SAML Provider
 */
app.get('/saml/admin/providers/:id', handleGetProvider);

/**
 * Update SAML Provider
 */
app.put('/saml/admin/providers/:id', handleUpdateProvider);

/**
 * Delete SAML Provider
 */
app.delete('/saml/admin/providers/:id', handleDeleteProvider);

/**
 * Import Metadata
 */
app.post('/saml/admin/providers/:id/import-metadata', handleImportMetadata);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: 'not_found',
      message: 'The requested SAML endpoint was not found',
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  console.error('SAML Worker Error:', err);
  return c.json(
    {
      error: 'internal_server_error',
      message: 'An unexpected error occurred in the SAML worker',
    },
    500
  );
});

export default app;

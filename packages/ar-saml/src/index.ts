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
 * - GET    /api/admin/saml-providers     - List SAML providers
 * - POST   /api/admin/saml-providers     - Create SAML provider
 * - GET    /api/admin/saml-providers/:id - Get SAML provider
 * - PUT    /api/admin/saml-providers/:id - Update SAML provider
 * - DELETE /api/admin/saml-providers/:id - Delete SAML provider
 * - GET    /api/admin/saml-attribute-presets - List SAML attribute presets
 * - POST   /api/admin/saml-attribute-presets - Create custom SAML attribute preset
 * - DELETE /api/admin/saml-attribute-presets/:id - Delete custom SAML attribute preset
 * - POST   /api/admin/saml-metadata/preview - Fetch and parse metadata before registration
 * - POST   /api/admin/saml-providers/:id/import-metadata - Import metadata
 * - POST   /api/admin/saml-providers/:id/refresh-metadata - Refresh metadata URL
 * - POST   /api/admin/saml-providers/:id/signing-rollover/publish-next - Publish next signing certificate
 * - POST   /api/admin/saml-providers/:id/signing-rollover/promote-next - Promote next signing certificate
 * - POST   /api/admin/saml-providers/:id/signing-rollover/retire-backup - Retire backup signing certificate
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminAuthMiddleware,
  requestContextMiddleware,
  pluginContextMiddleware,
  diagnosticLoggingMiddleware,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';

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
  handleGetSAMLSettings,
  handleUpdateSAMLSettings,
  handleListAttributePresets,
  handleCreateAttributePreset,
  handleDeleteAttributePreset,
  handlePreviewMetadata,
  handleImportMetadata,
  handleRefreshMetadata,
  handleListFederationTrustProfiles,
  handleCreateFederationTrustProfile,
  handleUpdateFederationTrustProfile,
  handleDeleteFederationTrustProfile,
  handlePreviewFederationTrustCertificate,
  handleListAggregatePreviewEntities,
  handleStartAggregateBatchCreate,
  handleGetAggregateBatchStatus,
  handlePublishSigningNext,
  handlePromoteSigningNext,
  handleRetireSigningBackup,
} from './admin/providers';
import { handleScheduled } from './scheduled';

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
  })
);

app.use('*', requestContextMiddleware());
app.use(
  '*',
  diagnosticLoggingMiddleware({
    excludePatterns: [/^\/saml\/health/, /^\/api\/health/, /^\/health\//],
  })
);
app.use('*', pluginContextMiddleware());

// Health check
app.get('/saml/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ar-saml',
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
app.get('/saml/metadata', handleSPMetadata);
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

app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));

app.get('/api/admin/saml-settings', handleGetSAMLSettings);
app.put('/api/admin/saml-settings', handleUpdateSAMLSettings);

/**
 * List SAML Providers
 */
app.get('/api/admin/saml-providers', handleListProviders);

/**
 * Create SAML Provider
 */
app.post('/api/admin/saml-providers', handleCreateProvider);

/**
 * Get SAML Provider
 */
app.get('/api/admin/saml-providers/:id', handleGetProvider);

/**
 * Update SAML Provider
 */
app.put('/api/admin/saml-providers/:id', handleUpdateProvider);

/**
 * Delete SAML Provider
 */
app.delete('/api/admin/saml-providers/:id', handleDeleteProvider);

/**
 * List SAML Attribute Presets
 */
app.get('/api/admin/saml-attribute-presets', handleListAttributePresets);

/**
 * Create custom SAML Attribute Preset
 */
app.post('/api/admin/saml-attribute-presets', handleCreateAttributePreset);

/**
 * Delete custom SAML Attribute Preset
 */
app.delete('/api/admin/saml-attribute-presets/:id', handleDeleteAttributePreset);

/**
 * Preview Metadata
 */
app.post('/api/admin/saml-metadata/preview', handlePreviewMetadata);

app.get(
  '/api/admin/saml-metadata/previews/:previewId/entities',
  handleListAggregatePreviewEntities
);
app.post(
  '/api/admin/saml-metadata/previews/:previewId/batch-create',
  handleStartAggregateBatchCreate
);
app.get('/api/admin/saml-metadata/batches/:batchId', handleGetAggregateBatchStatus);
app.post('/api/admin/saml-metadata/certificate-preview', handlePreviewFederationTrustCertificate);

app.get('/api/admin/saml-federation-trust-profiles', handleListFederationTrustProfiles);
app.post('/api/admin/saml-federation-trust-profiles', handleCreateFederationTrustProfile);
app.put('/api/admin/saml-federation-trust-profiles/:id', handleUpdateFederationTrustProfile);
app.delete('/api/admin/saml-federation-trust-profiles/:id', handleDeleteFederationTrustProfile);

/**
 * Import Metadata
 */
app.post('/api/admin/saml-providers/:id/import-metadata', handleImportMetadata);

/**
 * Refresh Metadata
 */
app.post('/api/admin/saml-providers/:id/refresh-metadata', handleRefreshMetadata);

/**
 * Signing Rollover Operations
 */
app.post('/api/admin/saml-providers/:id/signing-rollover/publish-next', handlePublishSigningNext);
app.post('/api/admin/saml-providers/:id/signing-rollover/promote-next', handlePromoteSigningNext);
app.post('/api/admin/saml-providers/:id/signing-rollover/retire-backup', handleRetireSigningBackup);

// 404 handler
app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// Error handler
app.onError((err, c) => {
  const log = getLogger(c).module('SAML');
  log.error('SAML Worker Error', {}, err);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

export { app, handleScheduled };

export default {
  fetch(request: Request, env?: Env, ctx?: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, ctx));
  },
  scheduled: handleScheduled,
};

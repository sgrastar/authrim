/**
 * VC Worker
 *
 * Unified OpenID4VP/VCI/DID implementation for Authrim.
 *
 * - OpenID4VP Verifier: Accept VCs from digital wallets as attribute proofs
 * - OpenID4VCI Issuer: Issue VCs to users' wallets
 * - DID Resolver: Resolve did:web and did:key identifiers
 *
 * Design Principles:
 * - VCs are attribute proofs, NOT login methods
 * - Raw VCs are NOT stored (data minimization)
 * - Disclosed claims are normalized to user attributes
 * - HAIP compliance for high assurance use cases
 *
 * @see https://openid.net/specs/openid-4-verifiable-presentations-1_0.html
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { versionCheckMiddleware, requestContextMiddleware } from '@authrim/shared';
import type { Env } from './types';

// Verifier routes
import { verifierMetadataRoute } from './verifier/routes/metadata';
import { vpAuthorizeRoute } from './verifier/routes/authorize';
import { vpResponseRoute } from './verifier/routes/response';
import { vpRequestStatusRoute } from './verifier/routes/request-status';

// Issuer routes
import { issuerMetadataRoute } from './issuer/routes/metadata';
import { credentialOfferRoute } from './issuer/routes/offer';
import { credentialRoute } from './issuer/routes/credential';
import { deferredCredentialRoute } from './issuer/routes/deferred';
import { statusListRoute, statusListJsonRoute } from './issuer/routes/status-list';
import { vciTokenRoute } from './issuer/routes/token';

// DID routes
import { didDocumentRoute } from './did/routes/document';
import { didResolveRoute } from './did/routes/resolve';

// =============================================================================
// App Setup
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', versionCheckMiddleware('vc'));
app.use('*', requestContextMiddleware());
app.use('*', cors());

// =============================================================================
// Health Check
// =============================================================================

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'vc',
    components: ['verifier', 'issuer', 'did'],
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// OpenID4VP Verifier Endpoints
// =============================================================================

// Verifier metadata
app.get('/.well-known/openid-credential-verifier', verifierMetadataRoute);

// VP Authorization Request (initiates VP flow)
app.post('/vp/authorize', vpAuthorizeRoute);

// VP Response (receives vp_token via direct_post)
app.post('/vp/response', vpResponseRoute);

// Request status (for polling)
app.get('/vp/request/:id', vpRequestStatusRoute);

// =============================================================================
// OpenID4VCI Issuer Endpoints
// =============================================================================

// Issuer metadata
app.get('/.well-known/openid-credential-issuer', issuerMetadataRoute);

// Token endpoint (pre-authorized_code grant)
app.post('/vci/token', vciTokenRoute);

// Credential offer
app.get('/vci/offer/:id', credentialOfferRoute);

// Credential issuance
app.post('/vci/credential', credentialRoute);

// Deferred credential
app.post('/vci/deferred', deferredCredentialRoute);

// Status list credential (for revocation/suspension checks)
app.get('/vci/status/:listId', statusListRoute);
app.get('/vci/status/:listId/json', statusListJsonRoute);

// =============================================================================
// DID Endpoints
// =============================================================================

// Authrim's DID document
app.get('/.well-known/did.json', didDocumentRoute);

// DID resolution proxy
app.get('/did/resolve/:did', didResolveRoute);

// =============================================================================
// Error Handling
// =============================================================================

app.onError((err, c) => {
  console.error('[vc] Error:', err);

  return c.json(
    {
      error: 'server_error',
      error_description: err instanceof Error ? err.message : 'Internal server error',
    },
    500
  );
});

app.notFound((c) => {
  return c.json(
    {
      error: 'not_found',
      error_description: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});

// =============================================================================
// Durable Object Exports
// =============================================================================

export { VPRequestStore } from './verifier/durable-objects/VPRequestStore';
export { CredentialOfferStore } from './issuer/durable-objects/CredentialOfferStore';
// Re-export KeyManager from shared for EC key management
export { KeyManager } from '@authrim/shared';

// =============================================================================
// Worker Export
// =============================================================================

export default app;

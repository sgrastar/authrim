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
 * - VCs are attribute proofs, NOT authentication methods
 * - Raw VCs are NOT stored (data minimization)
 * - Disclosed claims are normalized to user attributes
 * - HAIP compliance for high assurance use cases
 *
 * @see https://openid.net/specs/openid-4-verifiable-presentations-1_0.html
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  requestContextMiddleware,
  pluginContextMiddleware,
  diagnosticLoggingMiddleware,
  rateLimitMiddleware,
  getRateLimitProfileAsync,
  createErrorResponse,
  AR_ERROR_CODES,
  // Health Check
  createHealthCheckHandlers,
  getLogger,
  createActiveAccessTokenProtectedResourceMiddleware,
} from '@authrim/ar-lib-core';
import type { Env } from './types';

// Verifier routes
import { verifierMetadataRoute } from './verifier/routes/metadata';
import { vpAuthorizeRoute } from './verifier/routes/authorize';
import { vpResponseRoute } from './verifier/routes/response';
import { vpRequestStatusRoute } from './verifier/routes/request-status';
import { vpRequestObjectRoute } from './verifier/routes/request-object';
import {
  initiateAttributeVerification,
  attributeVerifyResponse,
  getAttributes,
} from './verifier/routes/attribute-verify';

// Issuer routes
import { issuerMetadataRoute } from './issuer/routes/metadata';
import { credentialOfferRoute } from './issuer/routes/offer';
import { credentialRoute } from './issuer/routes/credential';
import { deferredCredentialRoute } from './issuer/routes/deferred';
import { statusListRoute, statusListJsonRoute } from './issuer/routes/status-list';
import { vciTokenRoute } from './issuer/routes/token';
import { vciNonceRoute } from './issuer/routes/nonce';

// DID routes
import { didDocumentRoute } from './did/routes/document';
import { didResolveRoute } from './did/routes/resolve';

// =============================================================================
// App Setup
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', requestContextMiddleware());
app.use(
  '*',
  diagnosticLoggingMiddleware({
    excludePatterns: [/^\/api\/health/, /^\/health\//],
  })
);
app.use('*', pluginContextMiddleware());
app.use('*', cors());

async function applyRateLimit(
  c: Parameters<ReturnType<typeof rateLimitMiddleware>>[0],
  next: () => Promise<void>,
  profileName: 'strict' | 'moderate' | 'lenient',
  endpoints: string[]
): Promise<Response | void> {
  const profile = await getRateLimitProfileAsync(c.env, profileName);
  return rateLimitMiddleware({ ...profile, endpoints })(c, next);
}

app.use('/vci/token', (c, next) => applyRateLimit(c as never, next, 'strict', ['/vci/token']));
app.use('/vci/credential', (c, next) =>
  applyRateLimit(c as never, next, 'strict', ['/vci/credential'])
);
app.use('/vp/response', (c, next) => applyRateLimit(c as never, next, 'strict', ['/vp/response']));
app.use('/vp/attribute-response', (c, next) =>
  applyRateLimit(c as never, next, 'strict', ['/vp/attribute-response'])
);
app.use('/vp/initiate', (c, next) => applyRateLimit(c as never, next, 'strict', ['/vp/initiate']));
app.use('/vp/attributes', (c, next) =>
  applyRateLimit(c as never, next, 'moderate', ['/vp/attributes'])
);
const attributeProtectedResource = createActiveAccessTokenProtectedResourceMiddleware({
  audience: (c) => c.env.VC_ATTRIBUTE_ELEVATION_AUDIENCE ?? 'svc://op-vc/attribute-elevation',
  requiredScopes: ['vc.attribute'],
});
app.use('/vp/initiate', attributeProtectedResource as never);
app.use('/vp/attribute-response', attributeProtectedResource as never);
app.use('/vp/attributes', attributeProtectedResource as never);
app.use('/vci/nonce', (c, next) => applyRateLimit(c as never, next, 'moderate', ['/vci/nonce']));
app.use('/vp/authorize', (c, next) =>
  applyRateLimit(c as never, next, 'moderate', ['/vp/authorize'])
);
app.use('/vp/requests/*', (c, next) =>
  applyRateLimit(c as never, next, 'moderate', ['/vp/requests/'])
);
app.use('/vp/request/*', (c, next) =>
  applyRateLimit(c as never, next, 'lenient', ['/vp/request/'])
);
app.use('/vci/deferred', (c, next) =>
  applyRateLimit(c as never, next, 'moderate', ['/vci/deferred'])
);
app.use('/vci/status-lists/*', (c, next) =>
  applyRateLimit(c as never, next, 'moderate', ['/vci/status-lists/'])
);
app.use('/.well-known/*', (c, next) =>
  applyRateLimit(c as never, next, 'lenient', ['/.well-known/'])
);
app.use('/vci/offers/*', (c, next) =>
  applyRateLimit(c as never, next, 'lenient', ['/vci/offers/'])
);
app.use('/did/*', (c, next) => applyRateLimit(c as never, next, 'lenient', ['/did/']));

// =============================================================================
// Health Check
// =============================================================================

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ar-vc',
    components: ['verifier', 'issuer', 'did'],
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes
const healthHandlers = createHealthCheckHandlers({
  serviceName: 'ar-vc',
  version: '0.1.0',
  checkDatabase: true,
  checkKV: true,
});
app.get('/health/live', healthHandlers.liveness);
app.get('/health/ready', healthHandlers.readiness);

// =============================================================================
// OpenID4VP Verifier Endpoints
// =============================================================================

// Verifier metadata
app.get('/.well-known/openid-credential-verifier', verifierMetadataRoute);

// VP Authorization Request (initiates VP flow)
app.post('/vp/authorize', vpAuthorizeRoute);

// VP Response (receives vp_token via direct_post)
app.post('/vp/response', vpResponseRoute);

// Wallet-facing authorization request referenced by request_uri
app.get('/vp/request/:id', vpRequestObjectRoute);

// Request status (for polling)
app.get('/vp/requests/:id', vpRequestStatusRoute);

// Authenticated attribute elevation. All three routes use the shared token
// introspector; the response rechecks the active subject before persistence.
app.post('/vp/initiate', initiateAttributeVerification);
app.post('/vp/attribute-response', attributeVerifyResponse);
app.get('/vp/attributes', getAttributes);

// =============================================================================
// OpenID4VCI Issuer Endpoints
// =============================================================================

// Issuer metadata
app.get('/.well-known/openid-credential-issuer', issuerMetadataRoute);

// Token endpoint (pre-authorized_code grant)
app.post('/vci/token', vciTokenRoute);

// Independent proof nonce endpoint (OpenID4VCI 1.0 Final)
app.post('/vci/nonce', vciNonceRoute);

// Credential offer
app.get('/vci/offers/:id', credentialOfferRoute);

// Credential issuance
app.post('/vci/credential', credentialRoute);

// Deferred credential
app.post('/vci/deferred', deferredCredentialRoute);

// Status list credential (for revocation/suspension checks)
app.get('/vci/status-lists/:listId', statusListRoute);
app.get('/vci/status-lists/:listId/json', statusListJsonRoute);

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
  const log = getLogger(c).module('VC');
  log.error('Unhandled error in VC worker', {}, err as Error);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// =============================================================================
// Durable Object Exports
// =============================================================================

export { VPRequestStore, VPRequestStoreV2 } from './verifier/durable-objects/VPRequestStore';
export {
  CredentialOfferStore,
  CredentialOfferStoreV2,
} from './issuer/durable-objects/CredentialOfferStore';
export { VCIssuerEntrypoint } from './entrypoints/VCIssuerEntrypoint';
// Re-export KeyManager from shared for EC key management
export { KeyManager } from '@authrim/ar-lib-core';

// =============================================================================
// Worker Export
// =============================================================================

export default app;

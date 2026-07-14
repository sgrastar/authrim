/**
 * VP Authorization Route
 *
 * Initiates a VP (Verifiable Presentation) request.
 * Creates a VP request and returns the authorization URL for the wallet.
 *
 * Uses region-aware sharding for Durable Object placement:
 * - ID format: g{gen}:{region}:{shard}:vp_{uuid}
 * - Colocates requests from same client for caching
 * - locationHint for optimal regional placement
 */

import type { Context } from 'hono';
import type { Env, VPRequestState } from '../../types';
import { generateSecureNonce, sha256Base64url } from '../../utils/crypto';
import { getVPRequestStoreForNewRequest } from '../../utils/vp-request-sharding';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
  resolveAuthCorePersistenceAdapterFromEnv,
  ClientRepository,
} from '@authrim/ar-lib-core';
import { getRequestIssuerUrl } from '../../request-identifiers';

/** Supported client_id_scheme values per OID4VP */
type ClientIdScheme = 'pre-registered';

const SUPPORTED_CLIENT_ID_SCHEMES: ClientIdScheme[] = ['pre-registered'];

interface VPAuthorizeRequest {
  /** Tenant ID. If present, it must match the request context tenant. */
  tenant_id?: string;

  /** Client ID (RP identifier) */
  client_id: string;

  /** Client ID scheme (OID4VP) */
  client_id_scheme?: ClientIdScheme;

  /** Inline presentation definition */
  presentation_definition?: object;

  /** DCQL query (alternative to presentation_definition) */
  dcql_query?: object;

  /** Deprecated inputs are rejected; Authrim generates both values. */
  response_uri?: string;
  state?: string;

  /** User ID (for attribute linking) */
  user_id?: string;
}

/**
 * Validate client_id matches the declared client_id_scheme
 *
 * @param clientId - Client ID
 * @param scheme - Client ID scheme
 * @returns Error message if validation fails, null if valid
 */
function validateClientIdScheme(clientId: string, scheme?: ClientIdScheme): string | null {
  // If no scheme specified, default to 'pre-registered'
  const effectiveScheme = scheme || 'pre-registered';

  switch (effectiveScheme) {
    case 'pre-registered':
      // Pre-registered: no specific format, but should not be a DID or URL
      // This is a soft validation - pre-registered clients can have any format
      break;

    default:
      return `Unsupported client_id_scheme: ${scheme}`;
  }

  return null;
}

/**
 * POST /vp/authorize
 *
 * Creates a VP authorization request and returns the request URI.
 * The wallet fetches this URI to get the presentation definition.
 */
export async function vpAuthorizeRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-VERIFIER');
  try {
    const body = await c.req.json<VPAuthorizeRequest>();
    const tenantId = getTenantIdFromContext(c);

    if (body.tenant_id && body.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (!body.client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id' },
      });
    }

    // Validate client_id_scheme if provided
    if (body.client_id_scheme && !SUPPORTED_CLIENT_ID_SCHEMES.includes(body.client_id_scheme)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate client_id matches the declared scheme
    const clientIdSchemeError = validateClientIdScheme(body.client_id, body.client_id_scheme);
    if (clientIdSchemeError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    if (!body.client_id_scheme || body.client_id_scheme === 'pre-registered') {
      const adapter = await resolveAuthCorePersistenceAdapterFromEnv(c.env, 'vc-vp-authorize', {
        tenantId,
      });
      const client = await new ClientRepository(adapter, tenantId).findByClientId(body.client_id);
      if (!client) {
        return createErrorResponse(c, AR_ERROR_CODES.CLIENT_INVALID);
      }
    }

    if (!body.presentation_definition && !body.dcql_query) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'presentation_definition' },
      });
    }
    if (body.response_uri || body.state) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Generate UUID and nonce
    const uuid = crypto.randomUUID();
    const nonce = await generateSecureNonce();
    const statusToken = await generateSecureNonce(32);

    // Calculate expiry
    const expirySeconds = parseInt(c.env.VP_REQUEST_EXPIRY_SECONDS || '300', 10);
    const now = Date.now();
    const expiresAt = now + expirySeconds * 1000;

    // Build response URI
    const baseUrl = getRequestIssuerUrl(c);
    const responseUri = `${baseUrl}/vp/response`;

    // Get region-sharded DO stub and request ID
    const { stub, requestId } = await getVPRequestStoreForNewRequest(
      c.env,
      tenantId,
      body.client_id,
      uuid
    );

    // Create VP request state
    const vpRequest: VPRequestState = {
      id: requestId,
      tenantId,
      clientId: body.client_id,
      nonce,
      state: requestId,
      statusTokenHash: await sha256Base64url(statusToken),
      presentationDefinition:
        body.presentation_definition as VPRequestState['presentationDefinition'],
      dcqlQuery: body.dcql_query as VPRequestState['dcqlQuery'],
      responseUri,
      responseMode: 'direct_post',
      status: 'pending',
      createdAt: now,
      expiresAt,
    };

    // Store in Durable Object
    const storeResponse = await stub.fetch(
      new Request('https://internal/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vpRequest),
      })
    );
    if (!storeResponse.ok) throw new Error('vp_request_create_failed');

    // Build authorization request URL
    // This is the URL the wallet will use to initiate the flow
    const authorizationRequest = {
      response_type: 'vp_token',
      client_id: body.client_id,
      client_id_scheme: body.client_id_scheme || 'pre-registered',
      response_mode: 'direct_post',
      response_uri: responseUri,
      nonce,
      state: requestId,
      presentation_definition: body.presentation_definition,
      dcql_query: body.dcql_query,
    };

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      request_id: requestId,
      status_token: statusToken,
      request_uri: `${baseUrl}/vp/request/${requestId}`,
      nonce,
      expires_in: expirySeconds,
      authorization_request: authorizationRequest,
    });
  } catch (error) {
    log.error('VP authorization failed', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

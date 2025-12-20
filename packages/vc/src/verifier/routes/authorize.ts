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
import { generateSecureNonce } from '../../utils/crypto';
import { getVPRequestStoreForNewRequest } from '../../utils/vp-request-sharding';

/** Supported client_id_scheme values per OID4VP */
type ClientIdScheme = 'pre-registered' | 'did' | 'redirect_uri';

const SUPPORTED_CLIENT_ID_SCHEMES: ClientIdScheme[] = ['pre-registered', 'did', 'redirect_uri'];

interface VPAuthorizeRequest {
  /** Tenant ID */
  tenant_id: string;

  /** Client ID (RP identifier) */
  client_id: string;

  /** Client ID scheme (OID4VP) */
  client_id_scheme?: ClientIdScheme;

  /** Presentation definition ID (from database) */
  presentation_definition_id?: string;

  /** Inline presentation definition */
  presentation_definition?: object;

  /** DCQL query (alternative to presentation_definition) */
  dcql_query?: object;

  /** Response URI for direct_post */
  response_uri?: string;

  /** State parameter (echoed back) */
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
    case 'did': {
      // DID scheme: client_id must be a valid DID
      if (!clientId.startsWith('did:')) {
        return 'client_id must be a DID when client_id_scheme is "did"';
      }
      // Basic DID format validation
      const didParts = clientId.split(':');
      if (didParts.length < 3) {
        return 'Invalid DID format for client_id';
      }
      break;
    }

    case 'redirect_uri':
      // Redirect URI scheme: client_id must be a valid HTTPS URL
      try {
        const url = new URL(clientId);
        if (url.protocol !== 'https:') {
          return 'client_id must be an HTTPS URL when client_id_scheme is "redirect_uri"';
        }
      } catch {
        return 'client_id must be a valid URL when client_id_scheme is "redirect_uri"';
      }
      break;

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
  try {
    const body = await c.req.json<VPAuthorizeRequest>();

    // Validate required fields
    if (!body.tenant_id) {
      return c.json({ error: 'invalid_request', error_description: 'tenant_id is required' }, 400);
    }

    if (!body.client_id) {
      return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
    }

    // Validate client_id_scheme if provided
    if (body.client_id_scheme && !SUPPORTED_CLIENT_ID_SCHEMES.includes(body.client_id_scheme)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Unsupported client_id_scheme: ${body.client_id_scheme}. Supported: ${SUPPORTED_CLIENT_ID_SCHEMES.join(', ')}`,
        },
        400
      );
    }

    // Validate client_id matches the declared scheme
    const clientIdSchemeError = validateClientIdScheme(body.client_id, body.client_id_scheme);
    if (clientIdSchemeError) {
      return c.json({ error: 'invalid_request', error_description: clientIdSchemeError }, 400);
    }

    if (!body.presentation_definition_id && !body.presentation_definition && !body.dcql_query) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'presentation_definition_id, presentation_definition, or dcql_query is required',
        },
        400
      );
    }

    // Generate UUID and nonce
    const uuid = crypto.randomUUID();
    const nonce = await generateSecureNonce();

    // Calculate expiry
    const expirySeconds = parseInt(c.env.VP_REQUEST_EXPIRY_SECONDS || '300', 10);
    const now = Date.now();
    const expiresAt = now + expirySeconds * 1000;

    // Build response URI
    const baseUrl = new URL(c.req.url).origin;
    const responseUri = body.response_uri || `${baseUrl}/vp/response`;

    // Get region-sharded DO stub and request ID
    const { stub, requestId } = await getVPRequestStoreForNewRequest(
      c.env,
      body.tenant_id,
      body.client_id,
      uuid
    );

    // Create VP request state
    const vpRequest: VPRequestState = {
      id: requestId,
      tenantId: body.tenant_id,
      clientId: body.client_id,
      nonce,
      state: body.state,
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
    await stub.fetch(
      new Request('https://internal/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vpRequest),
      })
    );

    // Build authorization request URL
    // This is the URL the wallet will use to initiate the flow
    const authorizationRequest = {
      response_type: 'vp_token',
      client_id: body.client_id,
      client_id_scheme: body.client_id_scheme || 'pre-registered',
      response_mode: 'direct_post',
      response_uri: responseUri,
      nonce,
      state: body.state,
      presentation_definition: body.presentation_definition,
      dcql_query: body.dcql_query,
    };

    return c.json({
      request_id: requestId,
      request_uri: `${baseUrl}/vp/request/${requestId}`,
      nonce,
      expires_in: expirySeconds,
      authorization_request: authorizationRequest,
    });
  } catch (error) {
    console.error('[vpAuthorize] Error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

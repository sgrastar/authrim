/**
 * Dynamic Client Registration Handler
 *
 * Implements OpenID Connect Dynamic Client Registration 1.0
 * https://openid.net/specs/openid-connect-registration-1_0.html
 *
 * This endpoint allows clients to dynamically register with the OpenID Provider
 * without requiring pre-registration or manual configuration.
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';
import type {
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  ClientMetadata,
  OAuthErrorResponse,
} from '../types/oidc';

/**
 * Validate client registration request
 */
function validateRegistrationRequest(
  body: unknown
): { valid: true; data: ClientRegistrationRequest } | { valid: false; error: OAuthErrorResponse } {
  if (!body || typeof body !== 'object') {
    return {
      valid: false,
      error: {
        error: 'invalid_request',
        error_description: 'Request body must be a JSON object',
      },
    };
  }

  const data = body as Partial<ClientRegistrationRequest>;

  // Validate redirect_uris (required)
  if (!data.redirect_uris || !Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0) {
    return {
      valid: false,
      error: {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris is required and must be a non-empty array',
      },
    };
  }

  // Validate each redirect URI
  for (const uri of data.redirect_uris) {
    if (typeof uri !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_redirect_uri',
          error_description: 'All redirect_uris must be strings',
        },
      };
    }

    try {
      const parsed = new URL(uri);

      // OIDC requires HTTPS for production (allow http://localhost for development)
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
      ) {
        return {
          valid: false,
          error: {
            error: 'invalid_redirect_uri',
            error_description: 'redirect_uris must use HTTPS (except http://localhost for development)',
          },
        };
      }

      // Fragment identifier not allowed in redirect_uri
      if (parsed.hash) {
        return {
          valid: false,
          error: {
            error: 'invalid_redirect_uri',
            error_description: 'redirect_uris must not contain fragment identifiers',
          },
        };
      }
    } catch {
      return {
        valid: false,
        error: {
          error: 'invalid_redirect_uri',
          error_description: `Invalid URI: ${uri}`,
        },
      };
    }
  }

  // Validate optional URI fields
  const uriFields = ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri', 'jwks_uri'];
  for (const field of uriFields) {
    const value = data[field as keyof ClientRegistrationRequest];
    if (value !== undefined) {
      if (typeof value !== 'string') {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: `${field} must be a string`,
          },
        };
      }

      try {
        new URL(value);
      } catch {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: `${field} must be a valid URI`,
          },
        };
      }
    }
  }

  // Validate contacts (must be array of strings)
  if (data.contacts !== undefined) {
    if (!Array.isArray(data.contacts)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'contacts must be an array',
        },
      };
    }

    for (const contact of data.contacts) {
      if (typeof contact !== 'string') {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'All contacts must be strings',
          },
        };
      }
    }
  }

  // Validate token_endpoint_auth_method
  if (data.token_endpoint_auth_method !== undefined) {
    const validMethods = ['client_secret_basic', 'client_secret_post', 'none'];
    if (!validMethods.includes(data.token_endpoint_auth_method)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `token_endpoint_auth_method must be one of: ${validMethods.join(', ')}`,
        },
      };
    }
  }

  // Validate application_type
  if (data.application_type !== undefined) {
    const validTypes = ['web', 'native'];
    if (!validTypes.includes(data.application_type)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `application_type must be one of: ${validTypes.join(', ')}`,
        },
      };
    }
  }

  // Validate grant_types
  if (data.grant_types !== undefined) {
    if (!Array.isArray(data.grant_types)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'grant_types must be an array',
        },
      };
    }

    const validGrantTypes = ['authorization_code', 'refresh_token', 'implicit'];
    for (const grantType of data.grant_types) {
      if (!validGrantTypes.includes(grantType)) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: `Unsupported grant_type: ${grantType}`,
          },
        };
      }
    }
  }

  // Validate response_types
  if (data.response_types !== undefined) {
    if (!Array.isArray(data.response_types)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'response_types must be an array',
        },
      };
    }

    const validResponseTypes = ['code', 'id_token', 'token'];
    for (const responseType of data.response_types) {
      if (!validResponseTypes.includes(responseType)) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: `Unsupported response_type: ${responseType}`,
          },
        };
      }
    }
  }

  return {
    valid: true,
    data: data as ClientRegistrationRequest,
  };
}

/**
 * Generate a cryptographically secure client ID
 */
function generateClientId(): string {
  return `client_${crypto.randomUUID()}`;
}

/**
 * Generate a cryptographically secure client secret
 */
function generateClientSecret(): string {
  // Generate 32 bytes of random data and encode as base64url
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);

  // Convert to base64url
  const base64 = btoa(String.fromCharCode(...array));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Store client metadata in KV
 */
async function storeClient(
  env: Env,
  clientId: string,
  metadata: ClientMetadata
): Promise<void> {
  await env.CLIENTS.put(clientId, JSON.stringify(metadata));
}

/**
 * Dynamic Client Registration Handler
 *
 * POST /register
 */
export async function registerHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    // Parse request body
    const body = await c.req.json().catch(() => null);

    // Validate registration request
    const validation = validateRegistrationRequest(body);
    if (!validation.valid) {
      return c.json(validation.error, 400);
    }

    const request = validation.data;

    // Generate client credentials
    const clientId = generateClientId();
    const clientSecret = generateClientSecret();
    const issuedAt = Math.floor(Date.now() / 1000);

    // Set defaults for optional fields
    const tokenEndpointAuthMethod = request.token_endpoint_auth_method || 'client_secret_basic';
    const grantTypes = request.grant_types || ['authorization_code'];
    const responseTypes = request.response_types || ['code'];
    const applicationType = request.application_type || 'web';

    // Build response
    const response: ClientRegistrationResponse = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: 0, // 0 means never expires
      redirect_uris: request.redirect_uris,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      grant_types: grantTypes,
      response_types: responseTypes,
      application_type: applicationType,
    };

    // Include optional fields if provided
    if (request.client_name) response.client_name = request.client_name;
    if (request.client_uri) response.client_uri = request.client_uri;
    if (request.logo_uri) response.logo_uri = request.logo_uri;
    if (request.contacts) response.contacts = request.contacts;
    if (request.tos_uri) response.tos_uri = request.tos_uri;
    if (request.policy_uri) response.policy_uri = request.policy_uri;
    if (request.jwks_uri) response.jwks_uri = request.jwks_uri;
    if (request.software_id) response.software_id = request.software_id;
    if (request.software_version) response.software_version = request.software_version;
    if (request.scope) response.scope = request.scope;

    // Store client metadata
    const metadata: ClientMetadata = {
      ...response,
      created_at: issuedAt,
      updated_at: issuedAt,
    };

    await storeClient(c.env, clientId, metadata);

    console.log(`Client registered: ${clientId}`);

    return c.json(response, 201, {
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
    });
  } catch (error) {
    console.error('Registration error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'An unexpected error occurred during registration',
      },
      500
    );
  }
}

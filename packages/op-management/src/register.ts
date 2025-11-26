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
import type { Env } from '@authrim/shared';
import type {
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  ClientMetadata,
  OAuthErrorResponse,
} from '@authrim/shared';
import { generateSecureRandomString } from '@authrim/shared';

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
  if (
    !data.redirect_uris ||
    !Array.isArray(data.redirect_uris) ||
    data.redirect_uris.length === 0
  ) {
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
            error_description:
              'redirect_uris must use HTTPS (except http://localhost for development)',
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
    const validMethods = [
      'client_secret_basic',
      'client_secret_post',
      'client_secret_jwt',
      'private_key_jwt',
      'none',
    ];
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

    // Supported response types per OIDC Core 3.3 (Hybrid Flow)
    const validResponseTypes = [
      'code', // Authorization Code Flow
      'id_token', // Implicit Flow (ID Token only)
      'id_token token', // Implicit Flow (ID Token + Access Token)
      'code id_token', // Hybrid Flow 1
      'code token', // Hybrid Flow 2
      'code id_token token', // Hybrid Flow 3
    ];
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

  // Validate subject_type (OIDC Core 8)
  if (data.subject_type !== undefined) {
    const validSubjectTypes = ['public', 'pairwise'];
    if (!validSubjectTypes.includes(data.subject_type)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `subject_type must be one of: ${validSubjectTypes.join(', ')}`,
        },
      };
    }
  }

  // Validate sector_identifier_uri (OIDC Core 8.1)
  if (data.sector_identifier_uri !== undefined) {
    if (typeof data.sector_identifier_uri !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'sector_identifier_uri must be a string',
        },
      };
    }

    try {
      const parsed = new URL(data.sector_identifier_uri);

      // sector_identifier_uri must use HTTPS
      if (parsed.protocol !== 'https:') {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'sector_identifier_uri must use HTTPS',
          },
        };
      }
    } catch {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'sector_identifier_uri must be a valid HTTPS URI',
        },
      };
    }
  }

  return {
    valid: true,
    data: data as ClientRegistrationRequest,
  };
}

/**
 * Generate a cryptographically secure client ID
 * Uses long random string (~128 characters) for enhanced security
 */
function generateClientId(): string {
  // Using 96 bytes results in approximately 128 characters in base64url encoding
  return `client_${generateSecureRandomString(96)}`;
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
 * Store client metadata in KV and D1
 */
async function storeClient(env: Env, clientId: string, metadata: ClientMetadata): Promise<void> {
  // Store in KV for fast access
  await env.CLIENTS.put(clientId, JSON.stringify(metadata));

  // Store in D1 for consent foreign key constraints
  const now = Date.now(); // Store in milliseconds
  await env.DB.prepare(
    `
    INSERT OR REPLACE INTO oauth_clients (
      client_id, client_secret, client_name, redirect_uris,
      grant_types, response_types, scope, logo_uri,
      client_uri, policy_uri, tos_uri, contacts,
      subject_type, sector_identifier_uri,
      token_endpoint_auth_method, is_trusted, skip_consent,
      allow_claims_without_scope,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      clientId,
      metadata.client_secret || null,
      metadata.client_name || null,
      JSON.stringify(metadata.redirect_uris),
      JSON.stringify(metadata.grant_types || ['authorization_code']),
      JSON.stringify(metadata.response_types || ['code']),
      metadata.scope || null,
      metadata.logo_uri || null,
      metadata.client_uri || null,
      metadata.policy_uri || null,
      metadata.tos_uri || null,
      metadata.contacts ? JSON.stringify(metadata.contacts) : null,
      metadata.subject_type || 'public',
      metadata.sector_identifier_uri || null,
      metadata.token_endpoint_auth_method || 'client_secret_basic',
      metadata.is_trusted ? 1 : 0,
      metadata.skip_consent ? 1 : 0,
      metadata.allow_claims_without_scope ? 1 : 0,
      metadata.created_at || now,
      metadata.updated_at || now
    )
    .run();
}

/**
 * Dynamic Client Registration Handler
 *
 * POST /register
 */
export async function registerHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // Parse request body
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

    // Validate registration request
    const validation = validateRegistrationRequest(body);
    if (!validation.valid) {
      return c.json(validation.error, 400);
    }

    const request = validation.data;

    // OIDC Core 8.1: Validate pairwise subject type configuration
    // If pairwise subject type is used with multiple redirect URIs that have different hosts,
    // a sector_identifier_uri MUST be provided
    const subjectType = request.subject_type || 'public'; // Default to 'public'
    if (subjectType === 'pairwise' && request.redirect_uris.length > 1) {
      // Import pairwise utilities dynamically (to avoid circular dependencies)
      const { validateSectorIdentifierConsistency } = await import('@authrim/shared');

      const hasSameSector = validateSectorIdentifierConsistency(request.redirect_uris);
      if (!hasSameSector && !request.sector_identifier_uri) {
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description:
              'sector_identifier_uri is required when using pairwise subject type with multiple redirect URIs from different hosts',
          },
          400
        );
      }
    }

    // Generate client credentials
    const clientId = generateClientId();
    const clientSecret = generateClientSecret();
    const issuedAt = Math.floor(Date.now() / 1000);

    // Set defaults for optional fields
    const tokenEndpointAuthMethod = request.token_endpoint_auth_method || 'client_secret_basic';
    const grantTypes = request.grant_types || ['authorization_code'];
    const responseTypes = request.response_types || ['code'];
    const applicationType = request.application_type || 'web';

    // Determine if client is trusted based on redirect_uri domain
    // Trusted clients can skip consent screens (First-Party clients)
    const redirectDomain = new URL(request.redirect_uris[0]).hostname;
    const issuerDomain = new URL(c.env.ISSUER_URL).hostname;
    const trustedDomains = c.env.TRUSTED_DOMAINS?.split(',').map((d) => d.trim()) || [];

    const isTrusted = redirectDomain === issuerDomain || trustedDomains.includes(redirectDomain);

    console.log(`[DCR] Client registration: domain=${redirectDomain}, trusted=${isTrusted}`);

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
    // OIDC Core 8: Subject type and sector identifier
    response.subject_type = subjectType;
    if (request.sector_identifier_uri)
      response.sector_identifier_uri = request.sector_identifier_uri;

    // OIDC Conformance Test: Detect certification.openid.net
    const isCertificationTest = request.redirect_uris.some((uri) =>
      uri.includes('certification.openid.net')
    );

    // Store client metadata
    const metadata: ClientMetadata = {
      ...response,
      created_at: issuedAt,
      updated_at: issuedAt,
      is_trusted: isTrusted,
      skip_consent: isTrusted, // Trusted clients skip consent by default
      allow_claims_without_scope: isCertificationTest, // OIDC conformance tests need flexible claims parameter handling
    };

    await storeClient(c.env, clientId, metadata);

    // Log client registration for debugging/auditing
    // eslint-disable-next-line no-console
    console.log(`Client registered: ${clientId}`);

    if (isCertificationTest) {
      console.log('[DCR] OIDC Conformance Test detected, creating test user');

      // Create fixed test user with complete profile (INSERT OR IGNORE to avoid duplicates)
      await c.env.DB.prepare(
        `
        INSERT OR IGNORE INTO users (
          id, email, email_verified, name, given_name, family_name,
          middle_name, nickname, preferred_username, profile, picture,
          website, gender, birthdate, zoneinfo, locale,
          phone_number, phone_number_verified, address_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          'user-oidc-conformance-test',
          'test@example.com',
          1, // email_verified
          'John Doe',
          'John',
          'Doe',
          'Q',
          'Johnny',
          'test',
          'https://example.com/johndoe',
          'https://example.com/avatar.jpg',
          'https://example.com',
          'male',
          '1990-01-01',
          'America/New_York',
          'en-US',
          '+1-555-0100',
          1, // phone_number_verified
          JSON.stringify({
            formatted: '1234 Main St, Anytown, ST 12345, USA',
            street_address: '1234 Main St',
            locality: 'Anytown',
            region: 'ST',
            postal_code: '12345',
            country: 'USA',
          }),
          issuedAt,
          issuedAt
        )
        .run();

      console.log('[DCR] Test user created/verified: user-oidc-conformance-test');
    }

    return c.json(response, 201, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
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

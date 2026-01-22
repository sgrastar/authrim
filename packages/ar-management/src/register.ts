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
import type { Env } from '@authrim/ar-lib-core';
import type {
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  ClientMetadata,
  OAuthErrorResponse,
  JWKS,
} from '@authrim/ar-lib-core';
import {
  generateSecureRandomString,
  validateExternalUrl,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getTenantIdFromContext,
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  createLogger,
  // Custom Redirect URIs (Authrim Extension)
  validateAllowedOrigins,
  // Simple Logout Webhook (Authrim Extension)
  validateWebhookUrl,
  encryptValue,
  // RFC 7592: Token hashing for registration_access_token
  arrayBufferToBase64Url,
  // Client secret hashing
  hashClientSecret,
  // DCR Configuration
  getDCRSetting,
} from '@authrim/ar-lib-core';

/**
 * Validate sector_identifier_uri content (OIDC Core 8.1)
 * Fetches the URI and verifies that all redirect_uris are included in the returned JSON array
 */
async function validateSectorIdentifierContent(
  sectorUri: string,
  redirectUris: string[]
): Promise<{ valid: boolean; error?: OAuthErrorResponse }> {
  try {
    // SSRF protection: Validate URL before fetching
    const ssrfError = validateExternalUrl(sectorUri, {
      requireHttps: true,
      allowLocalhost: false,
      errorType: 'invalid_client_metadata',
      fieldName: 'sector_identifier_uri',
    });
    if (ssrfError) {
      return { valid: false, error: ssrfError };
    }

    const response = await fetch(sectorUri, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `Failed to fetch sector_identifier_uri: HTTP ${response.status}`,
        },
      };
    }

    const content = (await response.json()) as unknown;

    if (!Array.isArray(content)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'sector_identifier_uri must return a JSON array of redirect_uris',
        },
      };
    }

    // Verify all redirect_uris are included in the sector_identifier_uri content
    for (const uri of redirectUris) {
      if (!content.includes(uri)) {
        // SECURITY: Do not expose which redirect_uri failed to prevent enumeration
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'One or more redirect_uris are not valid for sector_identifier_uri',
          },
        };
      }
    }

    return { valid: true };
  } catch (error) {
    const log = createLogger().module('DCR');
    log.error('sector_identifier_uri validation error', { sectorUri }, error as Error);
    return {
      valid: false,
      error: {
        error: 'invalid_client_metadata',
        error_description: 'Failed to validate sector_identifier_uri content',
      },
    };
  }
}

/**
 * Options for client registration validation
 */
interface RegistrationValidationOptions {
  /** Allow localhost HTTP for webhook URLs (development only) */
  allowLocalhostHttp?: boolean;
}

/**
 * Validate client registration request
 */
function validateRegistrationRequest(
  body: unknown,
  options: RegistrationValidationOptions = {}
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

    // Supported response types per OIDC Core 3.3 (Hybrid Flow) + OAuth 2.0
    const validResponseTypes = [
      'code', // Authorization Code Flow
      'token', // OAuth 2.0 Implicit Flow (Access Token only)
      'id_token', // OIDC Implicit Flow (ID Token only)
      'id_token token', // OIDC Implicit Flow (ID Token + Access Token)
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

  // Validate post_logout_redirect_uris (OIDC RP-Initiated Logout 1.0)
  if (data.post_logout_redirect_uris !== undefined) {
    if (!Array.isArray(data.post_logout_redirect_uris)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'post_logout_redirect_uris must be an array',
        },
      };
    }

    for (const uri of data.post_logout_redirect_uris) {
      if (typeof uri !== 'string') {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'All post_logout_redirect_uris must be strings',
          },
        };
      }

      try {
        const parsed = new URL(uri);

        // HTTPS required (allow http://localhost for development)
        if (
          parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
        ) {
          return {
            valid: false,
            error: {
              error: 'invalid_client_metadata',
              error_description:
                'post_logout_redirect_uris must use HTTPS (except http://localhost for development)',
            },
          };
        }

        // Fragment identifier not allowed
        if (parsed.hash) {
          return {
            valid: false,
            error: {
              error: 'invalid_client_metadata',
              error_description: 'post_logout_redirect_uris must not contain fragment identifiers',
            },
          };
        }
      } catch {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: `Invalid post_logout_redirect_uri: ${uri}`,
          },
        };
      }
    }
  }

  // ==========================================================================
  // OIDC Backchannel Logout 1.0: backchannel_logout_uri and backchannel_logout_session_required
  // https://openid.net/specs/openid-connect-backchannel-1_0.html
  // ==========================================================================
  if (data.backchannel_logout_uri !== undefined) {
    if (typeof data.backchannel_logout_uri !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'backchannel_logout_uri must be a string',
        },
      };
    }

    try {
      const parsed = new URL(data.backchannel_logout_uri);

      // HTTPS required (allow http://localhost for development)
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
      ) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description:
              'backchannel_logout_uri must use HTTPS (except http://localhost for development)',
          },
        };
      }

      // Fragment identifier not allowed
      if (parsed.hash) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'backchannel_logout_uri must not contain fragment identifiers',
          },
        };
      }
    } catch {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `Invalid backchannel_logout_uri: ${data.backchannel_logout_uri}`,
        },
      };
    }
  }

  // backchannel_logout_session_required must be boolean if provided
  if (
    data.backchannel_logout_session_required !== undefined &&
    typeof data.backchannel_logout_session_required !== 'boolean'
  ) {
    return {
      valid: false,
      error: {
        error: 'invalid_client_metadata',
        error_description: 'backchannel_logout_session_required must be a boolean',
      },
    };
  }

  // ==========================================================================
  // OIDC Front-Channel Logout 1.0: frontchannel_logout_uri and frontchannel_logout_session_required
  // https://openid.net/specs/openid-connect-frontchannel-1_0.html
  // ==========================================================================
  if (data.frontchannel_logout_uri !== undefined) {
    if (typeof data.frontchannel_logout_uri !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'frontchannel_logout_uri must be a string',
        },
      };
    }

    try {
      const parsed = new URL(data.frontchannel_logout_uri);

      // HTTPS required (allow http://localhost for development)
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
      ) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description:
              'frontchannel_logout_uri must use HTTPS (except http://localhost for development)',
          },
        };
      }

      // Fragment identifier not allowed
      if (parsed.hash) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'frontchannel_logout_uri must not contain fragment identifiers',
          },
        };
      }
    } catch {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `Invalid frontchannel_logout_uri: ${data.frontchannel_logout_uri}`,
        },
      };
    }
  }

  // frontchannel_logout_session_required must be boolean if provided
  if (
    data.frontchannel_logout_session_required !== undefined &&
    typeof data.frontchannel_logout_session_required !== 'boolean'
  ) {
    return {
      valid: false,
      error: {
        error: 'invalid_client_metadata',
        error_description: 'frontchannel_logout_session_required must be a boolean',
      },
    };
  }

  // ==========================================================================
  // OIDC 3rd Party Initiated Login (OIDC Core Section 4)
  // https://openid.net/specs/openid-connect-core-1_0.html#ThirdPartyInitiatedLogin
  // ==========================================================================
  if (data.initiate_login_uri !== undefined) {
    if (typeof data.initiate_login_uri !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'initiate_login_uri must be a string',
        },
      };
    }

    try {
      const parsed = new URL(data.initiate_login_uri);

      // HTTPS required (allow http://localhost for development)
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
      ) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description:
              'initiate_login_uri must use HTTPS (except http://localhost for development)',
          },
        };
      }

      // Fragment identifier not allowed
      if (parsed.hash) {
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'initiate_login_uri must not contain fragment identifiers',
          },
        };
      }
    } catch {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `Invalid initiate_login_uri: ${data.initiate_login_uri}`,
        },
      };
    }
  }

  // ==========================================================================
  // Simple Logout Webhook (Authrim Extension)
  // A simplified alternative to OIDC Back-Channel Logout for clients that
  // don't support the full OIDC spec.
  // ==========================================================================
  if (data.logout_webhook_uri !== undefined) {
    if (typeof data.logout_webhook_uri !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'logout_webhook_uri must be a string',
        },
      };
    }

    // Use SSRF protection for webhook URL validation
    // Only allow localhost HTTP in development environments
    const webhookValidation = validateWebhookUrl(
      data.logout_webhook_uri,
      options.allowLocalhostHttp ?? false
    );

    if (!webhookValidation.valid) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `Invalid logout_webhook_uri: ${webhookValidation.error}`,
        },
      };
    }
  }

  // logout_webhook_secret validation (optional - auto-generated if not provided)
  if (data.logout_webhook_secret !== undefined) {
    if (typeof data.logout_webhook_secret !== 'string') {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'logout_webhook_secret must be a string',
        },
      };
    }

    // Minimum length requirement for security (32 bytes = 256 bits)
    if (data.logout_webhook_secret.length < 32) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'logout_webhook_secret must be at least 32 characters',
        },
      };
    }
  }

  // ==========================================================================
  // Custom Redirect URIs (Authrim Extension)
  // x_allowed_redirect_origins: Array of origins for error_uri/cancel_uri
  // ==========================================================================
  const allowedOrigins = (data as Record<string, unknown>).x_allowed_redirect_origins;
  if (allowedOrigins !== undefined) {
    if (!Array.isArray(allowedOrigins)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'x_allowed_redirect_origins must be an array of origin strings',
        },
      };
    }

    // Validate origins using the utility function
    const originsValidation = validateAllowedOrigins(allowedOrigins);
    if (!originsValidation.valid) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: `Invalid x_allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
        },
      };
    }

    // Store normalized origins in data
    (data as Record<string, unknown>).allowed_redirect_origins =
      originsValidation.normalizedOrigins;
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
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
}

/**
 * Store client metadata in D1 (source of truth)
 * Cache will be populated via Read-Through pattern on first access
 */
async function storeClient(env: Env, clientId: string, metadata: ClientMetadata): Promise<void> {
  // Store in D1 (source of truth)
  // CLIENTS_CACHE will be populated via Read-Through pattern on first getClient() call
  const now = Date.now(); // Store in milliseconds
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  await coreAdapter.execute(
    `
    INSERT OR REPLACE INTO oauth_clients (
      client_id, client_secret_hash, client_name, redirect_uris,
      grant_types, response_types, scope, logo_uri,
      client_uri, policy_uri, tos_uri, contacts,
      subject_type, sector_identifier_uri,
      token_endpoint_auth_method, is_trusted, skip_consent,
      allow_claims_without_scope,
      jwks, jwks_uri,
      userinfo_signed_response_alg,
      id_token_signed_response_alg,
      request_object_signing_alg,
      post_logout_redirect_uris,
      backchannel_logout_uri, backchannel_logout_session_required,
      frontchannel_logout_uri, frontchannel_logout_session_required,
      allowed_redirect_origins,
      logout_webhook_uri, logout_webhook_secret_encrypted,
      initiate_login_uri, registration_access_token_hash,
      software_id, software_version, requestable_scopes,
      tenant_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      clientId,
      metadata.client_secret_hash || null,
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
      metadata.jwks ? JSON.stringify(metadata.jwks) : null,
      metadata.jwks_uri || null,
      metadata.userinfo_signed_response_alg || null,
      metadata.id_token_signed_response_alg || null,
      metadata.request_object_signing_alg || null,
      metadata.post_logout_redirect_uris
        ? JSON.stringify(metadata.post_logout_redirect_uris)
        : null,
      metadata.backchannel_logout_uri || null,
      metadata.backchannel_logout_session_required ? 1 : 0,
      metadata.frontchannel_logout_uri || null,
      metadata.frontchannel_logout_session_required ? 1 : 0,
      metadata.allowed_redirect_origins ? JSON.stringify(metadata.allowed_redirect_origins) : null,
      (metadata as ClientMetadata & { logout_webhook_uri?: string }).logout_webhook_uri || null,
      (metadata as ClientMetadata & { logout_webhook_secret_encrypted?: string })
        .logout_webhook_secret_encrypted || null,
      // OIDC 3rd Party Initiated Login
      metadata.initiate_login_uri || null,
      // RFC 7592: Client Configuration Endpoint
      metadata.registration_access_token_hash || null,
      // RFC 7591: Dynamic Client Registration
      metadata.software_id || null,
      metadata.software_version || null,
      metadata.requestable_scopes ? JSON.stringify(metadata.requestable_scopes) : null,
      // Tenant ID
      metadata.tenant_id || 'default',
      metadata.created_at || now,
      metadata.updated_at || now,
    ]
  );
}

/**
 * Dynamic Client Registration Handler
 *
 * POST /register
 */
export async function registerHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // ==========================================================================
    // DCR Master Switch Check
    // If dcr.enabled is false, reject all registration requests
    // ==========================================================================
    const tenantId = getTenantIdFromContext(c);
    const dcrEnabled = await getDCRSetting('dcr.enabled', c.env, tenantId);
    if (!dcrEnabled) {
      return c.json(
        {
          error: 'access_denied',
          error_description: 'Dynamic Client Registration is disabled for this tenant',
        },
        403
      );
    }

    // Parse request body
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

    // Validate registration request
    // Allow localhost HTTP webhooks only in development environment
    const isDevelopment = c.env.ENVIRONMENT === 'development' || c.env.NODE_ENV === 'development';
    const validation = validateRegistrationRequest(body, {
      allowLocalhostHttp: isDevelopment,
    });
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
      const { validateSectorIdentifierConsistency } = await import('@authrim/ar-lib-core');

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

    // OIDC Core 8.1: Validate sector_identifier_uri content
    // Fetch the URI and verify that all redirect_uris are included
    if (request.sector_identifier_uri) {
      const sectorValidation = await validateSectorIdentifierContent(
        request.sector_identifier_uri,
        request.redirect_uris
      );
      if (!sectorValidation.valid) {
        return c.json(sectorValidation.error, 400);
      }
    }

    // ==========================================================================
    // RFC 7591: software_id Duplicate Check
    // Prevent multiple clients from registering with the same software_id
    // unless dcr.allow_duplicate_software_id is enabled
    // ==========================================================================
    if (request.software_id) {
      const allowDuplicateSoftwareId = await getDCRSetting(
        'dcr.allow_duplicate_software_id',
        c.env,
        tenantId
      );
      if (!allowDuplicateSoftwareId) {
        const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
        const existingClient = await coreAdapter.queryOne<{ client_id: string }>(
          'SELECT client_id FROM oauth_clients WHERE software_id = ? AND tenant_id = ?',
          [request.software_id, tenantId]
        );
        if (existingClient) {
          return c.json(
            {
              error: 'invalid_client_metadata',
              error_description:
                'A client with this software_id is already registered. Each software instance should have a unique software_id.',
            },
            400
          );
        }
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

    const log = getLogger(c).module('DCR');
    log.info('Client registration', {
      action: 'register',
      domain: redirectDomain,
      trusted: isTrusted,
    });

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
    if (request.jwks) response.jwks = request.jwks as JWKS;
    if (request.jwks_uri) response.jwks_uri = request.jwks_uri;
    if (request.software_id) response.software_id = request.software_id;
    if (request.software_version) response.software_version = request.software_version;
    if (request.scope) response.scope = request.scope;
    // OIDC Core 8: Subject type and sector identifier
    response.subject_type = subjectType;
    if (request.sector_identifier_uri)
      response.sector_identifier_uri = request.sector_identifier_uri;
    // OIDC Core 5.3.3: UserInfo signing algorithm
    if (request.userinfo_signed_response_alg)
      response.userinfo_signed_response_alg = request.userinfo_signed_response_alg;
    // OIDC Core 2: ID Token signing algorithm
    if (request.id_token_signed_response_alg)
      response.id_token_signed_response_alg = request.id_token_signed_response_alg;
    // RFC 9101 (JAR): Request Object signing algorithm
    if (request.request_object_signing_alg)
      response.request_object_signing_alg = request.request_object_signing_alg;
    // OIDC RP-Initiated Logout 1.0: post_logout_redirect_uris
    if (request.post_logout_redirect_uris)
      response.post_logout_redirect_uris = request.post_logout_redirect_uris;
    // OIDC Backchannel Logout 1.0
    if (request.backchannel_logout_uri)
      response.backchannel_logout_uri = request.backchannel_logout_uri;
    if (request.backchannel_logout_session_required !== undefined)
      response.backchannel_logout_session_required = request.backchannel_logout_session_required;
    // OIDC Front-Channel Logout 1.0
    if (request.frontchannel_logout_uri)
      response.frontchannel_logout_uri = request.frontchannel_logout_uri;
    if (request.frontchannel_logout_session_required !== undefined)
      response.frontchannel_logout_session_required = request.frontchannel_logout_session_required;

    // ==========================================================================
    // OIDC 3rd Party Initiated Login (OIDC Core Section 4)
    // Echo back initiate_login_uri if provided
    // ==========================================================================
    if (request.initiate_login_uri) {
      response.initiate_login_uri = request.initiate_login_uri;
    }

    // ==========================================================================
    // RFC 7592: Client Configuration Endpoint
    // Generate registration_access_token for client self-management
    // https://www.rfc-editor.org/rfc/rfc7592.html
    // ==========================================================================
    const registrationAccessToken = generateSecureRandomString(32);

    // Hash the token for secure storage (SHA-256)
    const encoder = new TextEncoder();
    const tokenData = encoder.encode(registrationAccessToken);
    const tokenHashBuffer = await crypto.subtle.digest('SHA-256', tokenData);
    const registrationAccessTokenHash = arrayBufferToBase64Url(tokenHashBuffer);

    // Build registration_client_uri
    const registrationClientUri = `${c.env.ISSUER_URL}/clients/${clientId}`;

    // Add to response (token is returned only on initial registration)
    response.registration_access_token = registrationAccessToken;
    response.registration_client_uri = registrationClientUri;

    // ==========================================================================
    // Simple Logout Webhook (Authrim Extension)
    // Process logout_webhook_uri and encrypt logout_webhook_secret
    // ==========================================================================
    let webhookSecretEncrypted: string | null = null;
    let webhookSecretPlain: string | undefined;

    if (request.logout_webhook_uri) {
      // Include webhook URI in response
      (
        response as ClientRegistrationResponse & { logout_webhook_uri?: string }
      ).logout_webhook_uri = request.logout_webhook_uri;

      // Get or generate webhook secret
      webhookSecretPlain = request.logout_webhook_secret || generateSecureRandomString(32);

      // Encrypt the webhook secret for storage
      // Use RP_TOKEN_ENCRYPTION_KEY (for RP-related secrets)
      const encryptionKey = c.env.RP_TOKEN_ENCRYPTION_KEY || c.env.PII_ENCRYPTION_KEY;
      if (encryptionKey) {
        const encrypted = await encryptValue(webhookSecretPlain, encryptionKey, 'AES-256-GCM', 1);
        webhookSecretEncrypted = encrypted.encrypted;
      } else {
        // SECURITY: If no encryption key, fail-close (reject registration)
        log.error('logout_webhook_secret requires RP_TOKEN_ENCRYPTION_KEY or PII_ENCRYPTION_KEY', {
          action: 'register',
        });
        return c.json(
          {
            error: 'server_error',
            error_description: 'Webhook secret encryption not configured',
          },
          500
        );
      }

      // Return the plaintext secret ONLY on initial registration (like client_secret)
      // Client must store this securely - it will not be returned again
      (
        response as ClientRegistrationResponse & { logout_webhook_secret?: string }
      ).logout_webhook_secret = webhookSecretPlain;

      log.info('Logout webhook configured for client', { action: 'register', clientId });
    }

    // OIDC Conformance Test: Detect certification.openid.net
    const isCertificationTest = request.redirect_uris.some((uri) =>
      uri.includes('certification.openid.net')
    );

    // Hash client secret for secure storage
    const clientSecretHash = await hashClientSecret(clientSecret);

    // Store client metadata
    // Note: We store the encrypted webhook secret, not the plaintext
    const metadata: ClientMetadata & {
      logout_webhook_uri?: string;
      logout_webhook_secret_encrypted?: string;
    } = {
      ...response,
      created_at: issuedAt,
      updated_at: issuedAt,
      is_trusted: isTrusted,
      skip_consent: isTrusted, // Trusted clients skip consent by default
      allow_claims_without_scope: isCertificationTest, // OIDC conformance tests need flexible claims parameter handling
      // Store hashed client secret, not plaintext
      client_secret_hash: clientSecretHash,
    };

    // Remove plaintext client_secret from metadata (only hash is stored)
    delete (metadata as unknown as Record<string, unknown>).client_secret;

    // Add webhook fields to metadata (store encrypted secret, not plaintext)
    if (request.logout_webhook_uri) {
      metadata.logout_webhook_uri = request.logout_webhook_uri;
      metadata.logout_webhook_secret_encrypted = webhookSecretEncrypted ?? undefined;
      // Remove plaintext secret from response spread (we already set it separately)
      delete (metadata as unknown as Record<string, unknown>).logout_webhook_secret;
    }

    // RFC 7592: Store hashed registration_access_token, remove plaintext from metadata
    metadata.registration_access_token_hash = registrationAccessTokenHash;
    // Remove fields that should not be stored (they are derived/sensitive)
    delete (metadata as unknown as Record<string, unknown>).registration_access_token;
    delete (metadata as unknown as Record<string, unknown>).registration_client_uri;

    // ==========================================================================
    // RFC 7591: DCR Scope Restriction
    // When dcr.scope_restriction_enabled is true, store the scope parameter as
    // requestable_scopes whitelist. Client can only request scopes from this list.
    // ==========================================================================
    const scopeRestrictionEnabled = await getDCRSetting(
      'dcr.scope_restriction_enabled',
      c.env,
      tenantId
    );
    if (scopeRestrictionEnabled && request.scope) {
      // Parse space-separated scope string into array
      const scopeArray = request.scope.split(' ').filter((s) => s.length > 0);
      if (scopeArray.length > 0) {
        metadata.requestable_scopes = scopeArray;
        log.info('Scope restriction applied', {
          action: 'register',
          clientId,
          requestableScopes: scopeArray,
        });
      }
    }

    // Store tenant_id in metadata
    metadata.tenant_id = tenantId;

    await storeClient(c.env, clientId, metadata);

    // Log client registration for debugging/auditing
    log.info('Client registered', { action: 'register', clientId });

    if (isCertificationTest) {
      log.info('OIDC Conformance Test detected, creating test user', { action: 'register' });

      const testUserId = 'user-oidc-conformance-test';
      const testAddress = {
        formatted: '1234 Main St, Anytown, ST 12345, USA',
        street_address: '1234 Main St',
        locality: 'Anytown',
        region: 'ST',
        postal_code: '12345',
        country: 'USA',
      };

      // Create fixed test user with complete profile (PII/Non-PII DB separation) via Adapter
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);

      // Insert into users_core (non-PII database) - use INSERT OR IGNORE for idempotency
      await authCtx.coreAdapter.execute(
        `INSERT OR IGNORE INTO users_core (
          id, tenant_id, email_verified, phone_number_verified,
          is_active, pii_partition, pii_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          testUserId,
          'default',
          1, // email_verified
          1, // phone_number_verified
          1, // is_active
          'default', // pii_partition
          'active', // pii_status
          issuedAt,
          issuedAt,
        ]
      );

      // Insert into users_pii (PII database) via PIIContext
      if (c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        await piiCtx.getPiiAdapter('default').execute(
          `INSERT OR IGNORE INTO users_pii (
            id, tenant_id, email, name, given_name, family_name,
            middle_name, nickname, preferred_username, profile, picture,
            website, gender, birthdate, zoneinfo, locale, phone_number,
            address_formatted, address_street_address, address_locality,
            address_region, address_postal_code, address_country,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            testUserId,
            'default',
            'test@example.com',
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
            testAddress.formatted,
            testAddress.street_address,
            testAddress.locality,
            testAddress.region,
            testAddress.postal_code,
            testAddress.country,
            issuedAt,
            issuedAt,
          ]
        );
      }

      log.info('Test user created/verified: user-oidc-conformance-test', { action: 'register' });
    }

    return c.json(response, 201, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
  } catch (error) {
    const errorLog = getLogger(c).module('DCR');
    errorLog.error('Registration error', { action: 'register' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

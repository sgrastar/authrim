/**
 * PAR (Pushed Authorization Request) Endpoint Handler
 * RFC 9126 - OAuth 2.0 Pushed Authorization Requests
 *
 * This endpoint allows clients to push authorization request parameters
 * directly to the authorization server, receiving a request_uri in return.
 * This enhances security by:
 * - Preventing request parameter tampering
 * - Reducing URL length limitations
 * - Providing better privacy for request parameters
 *
 * Security Features:
 * - Client authentication (RFC 9126 Section 2.1)
 * - DPoP binding (RFC 9449)
 * - FAPI 2.0 compliance
 * - JAR support (RFC 9101)
 */

import type { Context } from 'hono';
import type { Env, ClientMetadata } from '@authrim/shared';
import { OIDCError } from '@authrim/shared';
import { ERROR_CODES, HTTP_STATUS } from '@authrim/shared';
import {
  validateClientId,
  validateRedirectUri,
  validateScope,
  isRedirectUriRegistered,
  createOAuthConfigManager,
  validateClientAssertion,
  validateDPoPProof,
  timingSafeEqual,
  getTokenFormat,
  parseToken,
  isInternalUrl,
} from '@authrim/shared';
import { getClient, getPARRequestStoreForNewRequest } from '@authrim/shared';
import { jwtVerify, compactDecrypt, importJWK, createRemoteJWKSet } from 'jose';

/**
 * PAR request parameters interface
 */
interface PARRequestParams {
  client_id: string;
  response_type: string;
  redirect_uri: string;
  scope: string;
  state?: string | undefined;
  nonce?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  response_mode?: string | undefined;
  prompt?: string | undefined;
  display?: string | undefined;
  max_age?: string | undefined;
  ui_locales?: string | undefined;
  id_token_hint?: string | undefined;
  login_hint?: string | undefined;
  acr_values?: string | undefined;
  claims?: string | undefined;
}

/**
 * Validate PAR request parameters
 */
function validatePARParams(formData: Record<string, unknown>): PARRequestParams {
  const client_id = formData.client_id;
  const response_type = formData.response_type;
  const redirect_uri = formData.redirect_uri;
  const scope = formData.scope;

  // Validate required parameters
  if (!client_id || typeof client_id !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'client_id is required');
  }
  if (!response_type || typeof response_type !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'response_type is required');
  }
  if (!redirect_uri || typeof redirect_uri !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'redirect_uri is required');
  }
  if (!scope || typeof scope !== 'string') {
    throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'scope is required');
  }

  return {
    client_id,
    response_type,
    redirect_uri,
    scope,
    state: typeof formData.state === 'string' ? formData.state : undefined,
    nonce: typeof formData.nonce === 'string' ? formData.nonce : undefined,
    code_challenge:
      typeof formData.code_challenge === 'string' ? formData.code_challenge : undefined,
    code_challenge_method:
      typeof formData.code_challenge_method === 'string'
        ? formData.code_challenge_method
        : undefined,
    response_mode: typeof formData.response_mode === 'string' ? formData.response_mode : undefined,
    prompt: typeof formData.prompt === 'string' ? formData.prompt : undefined,
    display: typeof formData.display === 'string' ? formData.display : undefined,
    max_age: typeof formData.max_age === 'string' ? formData.max_age : undefined,
    ui_locales: typeof formData.ui_locales === 'string' ? formData.ui_locales : undefined,
    id_token_hint: typeof formData.id_token_hint === 'string' ? formData.id_token_hint : undefined,
    login_hint: typeof formData.login_hint === 'string' ? formData.login_hint : undefined,
    acr_values: typeof formData.acr_values === 'string' ? formData.acr_values : undefined,
    claims: typeof formData.claims === 'string' ? formData.claims : undefined,
  };
}

/**
 * PAR endpoint handler
 * POST /as/par
 */
export async function parHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // RFC 9126: PAR endpoint MUST only accept POST requests
    if (c.req.method !== 'POST') {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        'PAR endpoint only accepts POST requests',
        HTTP_STATUS.METHOD_NOT_ALLOWED
      );
    }

    // Parse request body (application/x-www-form-urlencoded)
    const contentType = c.req.header('content-type');
    if (!contentType?.includes('application/x-www-form-urlencoded')) {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        'Content-Type must be application/x-www-form-urlencoded'
      );
    }

    const formData = await c.req.parseBody();

    // Extract client authentication parameters
    const client_secret = formData.client_secret as string | undefined;
    const client_assertion = formData.client_assertion as string | undefined;
    const client_assertion_type = formData.client_assertion_type as string | undefined;

    // Validate request parameters
    const params = validatePARParams(formData as Record<string, unknown>);

    // Validate client_id
    const clientValidation = validateClientId(params.client_id);
    if (!clientValidation.valid) {
      throw new OIDCError(
        ERROR_CODES.INVALID_CLIENT,
        clientValidation.error || 'Invalid client_id'
      );
    }

    // Verify client exists (uses Read-Through Cache: CLIENTS_CACHE → D1)
    const clientData = await getClient(c.env, params.client_id);
    if (!clientData) {
      throw new OIDCError(ERROR_CODES.INVALID_CLIENT, 'Client not found');
    }

    // Cast to ClientMetadata for type safety
    const clientMetadata = clientData as unknown as ClientMetadata;

    // =========================================================================
    // Load FAPI 2.0 / OIDC configuration from SETTINGS KV
    // =========================================================================
    let fapiConfig: {
      enabled?: boolean;
      requirePrivateKeyJwt?: boolean;
      maxRequestUriExpiry?: number;
    } = {};
    let oidcConfig: {
      parExpiry?: number;
      allowNoneAlgorithm?: boolean;
    } = {};

    try {
      const settingsJson = await c.env.SETTINGS?.get('system_settings');
      if (settingsJson) {
        const settings = JSON.parse(settingsJson);
        fapiConfig = settings.fapi || {};
        oidcConfig = settings.oidc || {};
      }
    } catch (error) {
      console.error('Failed to load settings from KV:', error);
      // Continue with default values
    }

    // =========================================================================
    // P0: Client Authentication (RFC 9126 Section 2.1)
    // The authorization server MUST authenticate the client.
    // =========================================================================
    if (
      client_assertion &&
      client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    ) {
      // private_key_jwt or client_secret_jwt authentication
      const assertionValidation = await validateClientAssertion(
        client_assertion,
        `${c.env.ISSUER_URL}/as/par`, // PAR endpoint URL
        clientMetadata
      );

      if (!assertionValidation.valid) {
        return c.json(
          {
            error: assertionValidation.error || 'invalid_client',
            error_description:
              assertionValidation.error_description || 'Client assertion validation failed',
          },
          401
        );
      }
    } else if (clientMetadata.client_secret) {
      // client_secret_basic or client_secret_post authentication
      // SV-015: Use timing-safe comparison to prevent timing attacks
      if (!client_secret || !timingSafeEqual(clientMetadata.client_secret, client_secret)) {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Client authentication failed',
          },
          401
        );
      }
    }
    // Public clients (no client_secret and no client_assertion) are allowed for non-FAPI mode

    // =========================================================================
    // P3: FAPI 2.0 Specific Requirements
    // =========================================================================
    if (fapiConfig.enabled) {
      // FAPI 2.0: Require private_key_jwt authentication
      if (fapiConfig.requirePrivateKeyJwt !== false) {
        if (
          !client_assertion ||
          client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        ) {
          return c.json(
            {
              error: 'invalid_client',
              error_description: 'FAPI 2.0 requires private_key_jwt authentication for PAR',
            },
            401
          );
        }
      }

      // FAPI 2.0: Require PKCE with S256
      if (!params.code_challenge || params.code_challenge_method !== 'S256') {
        throw new OIDCError(ERROR_CODES.INVALID_REQUEST, 'FAPI 2.0 requires PKCE with S256 method');
      }
    }

    // =========================================================================
    // P4: JAR Support (RFC 9101 - JWT-Secured Authorization Request)
    // If 'request' parameter is present, parse JWT request object
    // =========================================================================
    const requestParam = formData.request as string | undefined;

    if (requestParam) {
      try {
        let requestObjectClaims: Record<string, unknown> | undefined;
        let requestProcessed = false;

        // Check if request is JWE (encrypted) or JWT (signed)
        let tokenFormat = getTokenFormat(requestParam);

        if (tokenFormat === 'unknown') {
          return c.json(
            {
              error: 'invalid_request_object',
              error_description: 'Invalid request object format',
            },
            400
          );
        }

        let jwtRequest = requestParam;

        // Handle JWE-encrypted request objects (nested JWT: JWE containing JWS)
        if (tokenFormat === 'jwe') {
          try {
            // Get private key for decryption from KeyManager
            const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
            const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
            const keyData = await keyManager.getActiveKeyWithPrivateRpc();

            if (!keyData?.privatePEM) {
              return c.json(
                {
                  error: 'server_error',
                  error_description: 'Decryption key not available',
                },
                500
              );
            }

            const { importPKCS8 } = await import('jose');
            const privateKey = await importPKCS8(keyData.privatePEM, 'RSA-OAEP');

            const { plaintext } = await compactDecrypt(requestParam, privateKey);
            jwtRequest = new TextDecoder().decode(plaintext);

            // Check inner format
            tokenFormat = getTokenFormat(jwtRequest);
            if (tokenFormat === 'jwe') {
              // Try to parse as plain JSON (unsecured request object inside JWE)
              requestObjectClaims = JSON.parse(jwtRequest) as Record<string, unknown>;
              requestProcessed = true;
            }
          } catch (decryptError) {
            console.error('[PAR] Failed to decrypt JWE request object:', decryptError);
            return c.json(
              {
                error: 'invalid_request_object',
                error_description: 'Failed to decrypt request object',
              },
              400
            );
          }
        }

        // Process JWT/JWS if not already processed
        if (!requestProcessed) {
          const parsed = parseToken(jwtRequest);
          const header = parsed?.header as { alg?: string } | undefined;
          const alg = header?.alg;

          // Handle unsigned request objects (alg=none)
          if (alg === 'none') {
            // SECURITY: Block alg=none in production
            const environment = c.env.ENVIRONMENT || c.env.NODE_ENV || 'production';
            const isProduction = environment === 'production';

            if (isProduction) {
              console.error(
                '[PAR][SECURITY CRITICAL] Blocked unsigned request object (alg=none) in production'
              );
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description:
                    'Unsigned request objects (alg=none) are not permitted in production',
                },
                400
              );
            }

            // Non-production: Check SETTINGS KV for allowNoneAlgorithm (same pattern as authorize.ts)
            const allowNoneAlgorithm = oidcConfig.allowNoneAlgorithm ?? false;

            if (!allowNoneAlgorithm) {
              console.error(
                '[PAR][SECURITY] Rejected unsigned request object (alg=none) - not allowed in settings'
              );
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description:
                    'Unsigned request objects (alg=none) are not allowed in this environment',
                },
                400
              );
            }

            console.log(
              '[PAR][SECURITY] Using unsigned request object (alg=none) - dev/testing only'
            );
            requestObjectClaims = parseToken(jwtRequest) as Record<string, unknown>;
          } else {
            // Signed request object - verify using client's public key
            // Get client's public key from JWKS or jwks_uri
            let cryptoKey: CryptoKey | undefined;
            let jwksKeyGetter: ReturnType<typeof createRemoteJWKSet> | undefined;

            if (clientMetadata.jwks) {
              // Use embedded JWKS
              const jwks =
                typeof clientMetadata.jwks === 'string'
                  ? JSON.parse(clientMetadata.jwks)
                  : clientMetadata.jwks;
              const key = jwks.keys?.[0];
              if (key) {
                const imported = await importJWK(key, alg);
                if (imported instanceof Uint8Array) {
                  return c.json(
                    {
                      error: 'invalid_request_object',
                      error_description: 'Invalid key format in client JWKS',
                    },
                    400
                  );
                }
                cryptoKey = imported as CryptoKey;
              }
            } else if (clientMetadata.jwks_uri) {
              // Fetch from jwks_uri
              const jwksUri = new URL(clientMetadata.jwks_uri);

              // SSRF protection: Block internal addresses
              if (isInternalUrl(jwksUri)) {
                return c.json(
                  {
                    error: 'invalid_request_object',
                    error_description: 'jwks_uri cannot point to internal addresses',
                  },
                  400
                );
              }

              jwksKeyGetter = createRemoteJWKSet(jwksUri);
            }

            if (!cryptoKey && !jwksKeyGetter) {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description:
                    'Cannot verify request object: client has no public key (jwks or jwks_uri)',
                },
                400
              );
            }

            try {
              // jwtVerify has two overloads: one for CryptoKey, one for getKey function
              // We need to call them separately to satisfy TypeScript
              const verifyOptions = {
                issuer: params.client_id, // RFC 9101: iss MUST be client_id
                audience: c.env.ISSUER_URL, // RFC 9101: aud MUST be OP issuer
              };

              let payload: Record<string, unknown>;
              if (cryptoKey) {
                const result = await jwtVerify(jwtRequest, cryptoKey, verifyOptions);
                payload = result.payload as Record<string, unknown>;
              } else {
                const result = await jwtVerify(jwtRequest, jwksKeyGetter!, verifyOptions);
                payload = result.payload as Record<string, unknown>;
              }
              requestObjectClaims = payload;
            } catch (verifyError) {
              console.error('[PAR] JWT verification failed:', verifyError);
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'Request object signature verification failed',
                },
                400
              );
            }
          }
        }

        // Merge request object claims into params (request object takes precedence)
        if (requestObjectClaims) {
          // RFC 9101: Certain parameters in the request object override query/form params
          if (requestObjectClaims.response_type)
            params.response_type = requestObjectClaims.response_type as string;
          if (requestObjectClaims.redirect_uri)
            params.redirect_uri = requestObjectClaims.redirect_uri as string;
          if (requestObjectClaims.scope) params.scope = requestObjectClaims.scope as string;
          if (requestObjectClaims.state) params.state = requestObjectClaims.state as string;
          if (requestObjectClaims.nonce) params.nonce = requestObjectClaims.nonce as string;
          if (requestObjectClaims.code_challenge)
            params.code_challenge = requestObjectClaims.code_challenge as string;
          if (requestObjectClaims.code_challenge_method)
            params.code_challenge_method = requestObjectClaims.code_challenge_method as string;
          if (requestObjectClaims.response_mode)
            params.response_mode = requestObjectClaims.response_mode as string;
          if (requestObjectClaims.prompt) params.prompt = requestObjectClaims.prompt as string;
          if (requestObjectClaims.display) params.display = requestObjectClaims.display as string;
          if (requestObjectClaims.max_age)
            params.max_age = String(requestObjectClaims.max_age) as string;
          if (requestObjectClaims.ui_locales)
            params.ui_locales = requestObjectClaims.ui_locales as string;
          if (requestObjectClaims.id_token_hint)
            params.id_token_hint = requestObjectClaims.id_token_hint as string;
          if (requestObjectClaims.login_hint)
            params.login_hint = requestObjectClaims.login_hint as string;
          if (requestObjectClaims.acr_values)
            params.acr_values = requestObjectClaims.acr_values as string;
          if (requestObjectClaims.claims)
            params.claims =
              typeof requestObjectClaims.claims === 'string'
                ? requestObjectClaims.claims
                : JSON.stringify(requestObjectClaims.claims);

          // client_id in request object must match client_id from request
          if (requestObjectClaims.client_id && requestObjectClaims.client_id !== params.client_id) {
            return c.json(
              {
                error: 'invalid_request',
                error_description:
                  'client_id mismatch between request parameter and request object',
              },
              400
            );
          }

          console.log('[PAR] Request object processed successfully');
        }
      } catch (error) {
        console.error('[PAR] Failed to process request object:', error);
        return c.json(
          {
            error: 'invalid_request_object',
            error_description: 'Failed to parse or verify request object',
          },
          400
        );
      }
    }

    // =========================================================================
    // Standard Validations
    // =========================================================================

    // Validate redirect_uri against registered URIs
    const redirectValidation = validateRedirectUri(params.redirect_uri);
    if (!redirectValidation.valid) {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        redirectValidation.error || 'Invalid redirect_uri'
      );
    }

    // RFC 6749 Section 3.1.2.3: Use URL normalization for secure comparison
    // to prevent Open Redirect attacks via URL manipulation
    if (!isRedirectUriRegistered(params.redirect_uri, clientData.redirect_uris as string[])) {
      throw new OIDCError(
        ERROR_CODES.INVALID_REQUEST,
        'redirect_uri not registered for this client'
      );
    }

    // Validate scope
    const scopeValidation = validateScope(params.scope);
    if (!scopeValidation.valid) {
      throw new OIDCError(ERROR_CODES.INVALID_SCOPE, scopeValidation.error || 'Invalid scope');
    }

    // Validate response_type
    const supportedResponseTypes = ['code', 'code id_token', 'code token', 'code id_token token'];
    if (!supportedResponseTypes.includes(params.response_type)) {
      throw new OIDCError(
        ERROR_CODES.UNSUPPORTED_RESPONSE_TYPE,
        `Unsupported response_type. Supported types: ${supportedResponseTypes.join(', ')}`
      );
    }

    // PKCE validation
    if (params.code_challenge) {
      if (!params.code_challenge_method) {
        throw new OIDCError(
          ERROR_CODES.INVALID_REQUEST,
          'code_challenge_method is required when code_challenge is present'
        );
      }
      // RFC 7636: code_challenge MUST be 43-128 characters
      if (params.code_challenge.length < 43 || params.code_challenge.length > 128) {
        throw new OIDCError(
          ERROR_CODES.INVALID_REQUEST,
          'code_challenge must be between 43 and 128 characters'
        );
      }
    }

    // =========================================================================
    // P2: DPoP Handling (RFC 9449)
    // If DPoP header present, validate proof and store dpop_jkt for binding
    // =========================================================================
    let dpopJkt: string | undefined;
    const dpopHeader = c.req.header('DPoP');

    if (dpopHeader) {
      const parEndpointUrl = `${c.env.ISSUER_URL}/as/par`;
      const dpopValidation = await validateDPoPProof(
        dpopHeader,
        'POST',
        parEndpointUrl,
        undefined, // No access token at PAR stage
        c.env.DPOP_JTI_STORE,
        params.client_id
      );

      if (!dpopValidation.valid) {
        return c.json(
          {
            error: dpopValidation.error || 'invalid_dpop_proof',
            error_description: dpopValidation.error_description || 'DPoP proof validation failed',
          },
          400
        );
      }

      // Store dpop_jkt for authorization code binding
      dpopJkt = dpopValidation.jkt;
      console.log('[PAR] DPoP proof validated, jkt:', dpopJkt?.substring(0, 16) + '...');
    }

    // =========================================================================
    // P1: Use ConfigManager for expiration (KV → env → default)
    // =========================================================================
    const configManager = createOAuthConfigManager(c.env);

    // Priority: FAPI max limit → KV config → OIDC config → default
    let requestUriExpiry: number;
    if (fapiConfig.enabled && fapiConfig.maxRequestUriExpiry) {
      // FAPI 2.0: request_uri expires in ≤ 60 seconds (configurable)
      requestUriExpiry = Math.min(fapiConfig.maxRequestUriExpiry, 60);
    } else if (oidcConfig.parExpiry) {
      requestUriExpiry = oidcConfig.parExpiry;
    } else {
      // Default: 600 seconds (10 minutes) per RFC 9126
      requestUriExpiry = 600;
    }

    // Build request data with optional dpop_jkt
    const requestData = {
      client_id: params.client_id,
      response_type: params.response_type,
      redirect_uri: params.redirect_uri,
      scope: params.scope,
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      response_mode: params.response_mode,
      prompt: params.prompt,
      display: params.display,
      max_age: params.max_age ? parseInt(params.max_age, 10) : undefined,
      ui_locales: params.ui_locales,
      id_token_hint: params.id_token_hint,
      login_hint: params.login_hint,
      acr_values: params.acr_values,
      claims: params.claims,
      // P2: Store DPoP key thumbprint for binding
      dpop_jkt: dpopJkt,
    };

    // Store in PARRequestStore DO with region-aware sharding (issue #11: single-use guarantee)
    if (!c.env.PAR_REQUEST_STORE) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'PAR request storage unavailable',
        },
        500
      );
    }

    // Use region-aware sharding based on client_id
    // This generates a region-sharded request URI: urn:ietf:params:oauth:request_uri:g{gen}:{region}:{shard}:par_{uuid}
    const uuid = crypto.randomUUID();
    const { stub, requestUri } = await getPARRequestStoreForNewRequest(
      c.env,
      'default', // tenantId - will support multi-tenant in future
      params.client_id,
      uuid
    );

    try {
      await stub.storeRequestRpc({
        requestUri,
        data: requestData,
        ttl: requestUriExpiry,
      });
    } catch (error) {
      console.error('PAR store error:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to store PAR request',
        },
        500
      );
    }

    // RFC 9126: Return request_uri and expires_in
    return c.json(
      {
        request_uri: requestUri,
        expires_in: requestUriExpiry,
      },
      201
    );
  } catch (error: unknown) {
    console.error('PAR error:', error);

    if (error instanceof OIDCError) {
      return c.json(
        {
          error: error.error,
          error_description: error.error_description,
        },
        error.statusCode as 200 | 201 | 400 | 401 | 404 | 405 | 500
      );
    }

    return c.json(
      {
        error: ERROR_CODES.SERVER_ERROR,
        error_description: 'An unexpected error occurred',
      },
      HTTP_STATUS.INTERNAL_SERVER_ERROR as 200 | 201 | 400 | 401 | 404 | 405 | 500
    );
  }
}

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  validateResponseType,
  validateClientId,
  validateRedirectUri,
  validateScope,
  validateState,
  validateNonce,
  getClient,
  getAuthCodeShardIndex,
  createShardedAuthCode,
  buildAuthCodeShardInstanceName,
  getShardCount,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isShardedSessionId,
  parseShardedSessionId,
} from '@authrim/shared';
import {
  generateSecureRandomString,
  parseToken,
  verifyToken,
  createAccessToken,
  createIDToken,
  calculateCHash,
  calculateAtHash,
  getTokenFormat,
  encryptJWT,
  extractDPoPProof,
  validateDPoPProof,
  calculateSessionState,
  extractOrigin,
} from '@authrim/shared';
import { SignJWT, importJWK, importPKCS8, compactDecrypt, type CryptoKey } from 'jose';

// ===== Key Caching for Performance Optimization =====
// Cache signing key to avoid expensive RSA key import (5-7ms) on every request
let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
let cachedKeyTimestamp = 0;
const KEY_CACHE_TTL = 60000; // 60 seconds

/**
 * Authorization Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 *
 * Handles authorization requests and returns authorization codes
 * Per OIDC Core 3.1.2.1: MUST support both GET and POST methods
 * RFC 9126: Supports request_uri parameter for PAR
 */
export async function authorizeHandler(c: Context<{ Bindings: Env }>) {
  // Parse parameters from either GET (query string) or POST (form body)
  // OIDC Core 3.1.2.1: Authorization Servers MUST support the use of the HTTP GET and POST methods
  let response_type: string | undefined;
  let client_id: string | undefined;
  let redirect_uri: string | undefined;
  let scope: string | undefined;
  let state: string | undefined;
  let nonce: string | undefined;
  let code_challenge: string | undefined;
  let code_challenge_method: string | undefined;
  let claims: string | undefined;
  let request_uri: string | undefined;
  let response_mode: string | undefined;
  let request: string | undefined; // RFC 9101: Request Object (JAR)
  let prompt: string | undefined;
  let max_age: string | undefined;
  let id_token_hint: string | undefined;
  let acr_values: string | undefined;
  let display: string | undefined;
  let ui_locales: string | undefined;
  let login_hint: string | undefined;
  let _confirmed: string | undefined;
  let _auth_time: string | undefined;
  let _session_user_id: string | undefined;
  // Phase 2-B RBAC extensions
  let org_id: string | undefined; // Target organization ID
  let acting_as: string | undefined; // Acting on behalf of user ID
  let _consent_confirmed: string | undefined; // Internal: consent was confirmed

  if (c.req.method === 'POST') {
    // Parse POST body (application/x-www-form-urlencoded)
    try {
      const body = await c.req.parseBody();
      request_uri = typeof body.request_uri === 'string' ? body.request_uri : undefined;
      request = typeof body.request === 'string' ? body.request : undefined;
      response_type = typeof body.response_type === 'string' ? body.response_type : undefined;
      client_id = typeof body.client_id === 'string' ? body.client_id : undefined;
      redirect_uri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
      scope = typeof body.scope === 'string' ? body.scope : undefined;
      state = typeof body.state === 'string' ? body.state : undefined;
      nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
      code_challenge = typeof body.code_challenge === 'string' ? body.code_challenge : undefined;
      code_challenge_method =
        typeof body.code_challenge_method === 'string' ? body.code_challenge_method : undefined;
      claims = typeof body.claims === 'string' ? body.claims : undefined;
      response_mode = typeof body.response_mode === 'string' ? body.response_mode : undefined;
      prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
      max_age = typeof body.max_age === 'string' ? body.max_age : undefined;
      id_token_hint = typeof body.id_token_hint === 'string' ? body.id_token_hint : undefined;
      acr_values = typeof body.acr_values === 'string' ? body.acr_values : undefined;
      display = typeof body.display === 'string' ? body.display : undefined;
      ui_locales = typeof body.ui_locales === 'string' ? body.ui_locales : undefined;
      login_hint = typeof body.login_hint === 'string' ? body.login_hint : undefined;
      _confirmed = typeof body._confirmed === 'string' ? body._confirmed : undefined;
      _auth_time = typeof body._auth_time === 'string' ? body._auth_time : undefined;
      _session_user_id =
        typeof body._session_user_id === 'string' ? body._session_user_id : undefined;
      // Phase 2-B RBAC extensions
      org_id = typeof body.org_id === 'string' ? body.org_id : undefined;
      acting_as = typeof body.acting_as === 'string' ? body.acting_as : undefined;
      _consent_confirmed =
        typeof body._consent_confirmed === 'string' ? body._consent_confirmed : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    // Parse GET query parameters
    request_uri = c.req.query('request_uri');
    request = c.req.query('request');
    response_type = c.req.query('response_type');
    client_id = c.req.query('client_id');
    redirect_uri = c.req.query('redirect_uri');
    scope = c.req.query('scope');
    state = c.req.query('state');
    nonce = c.req.query('nonce');
    code_challenge = c.req.query('code_challenge');
    code_challenge_method = c.req.query('code_challenge_method');
    claims = c.req.query('claims');
    response_mode = c.req.query('response_mode');
    prompt = c.req.query('prompt');
    max_age = c.req.query('max_age');
    id_token_hint = c.req.query('id_token_hint');
    acr_values = c.req.query('acr_values');
    display = c.req.query('display');
    ui_locales = c.req.query('ui_locales');
    login_hint = c.req.query('login_hint');
    _confirmed = c.req.query('_confirmed');
    _auth_time = c.req.query('_auth_time');
    _session_user_id = c.req.query('_session_user_id');
    // Phase 2-B RBAC extensions
    org_id = c.req.query('org_id');
    acting_as = c.req.query('acting_as');
    _consent_confirmed = c.req.query('_consent_confirmed');
  }

  // RFC 9126: If request_uri is present, fetch parameters from PAR storage
  // OIDC Core 6.2: Also support HTTPS request_uri (Request Object by Reference)
  if (request_uri) {
    // Check if this is a PAR request_uri (URN) or HTTPS request_uri
    const isPAR = request_uri.startsWith('urn:ietf:params:oauth:request_uri:');
    const isHTTPS = request_uri.startsWith('https://');

    if (!isPAR && !isHTTPS) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'request_uri must be either urn:ietf:params:oauth:request_uri: or https://',
        },
        400
      );
    }

    // Handle HTTPS request_uri (Request Object by Reference)
    // SECURITY: This feature is disabled by default to prevent SSRF attacks
    // Enable via SETTINGS KV (oidc.httpsRequestUri.enabled) or ENABLE_HTTPS_REQUEST_URI env var
    if (isHTTPS) {
      // Load HTTPS request_uri configuration from SETTINGS KV
      // Priority: SETTINGS KV > Environment variable > Default (disabled)
      let httpsRequestUriConfig: {
        enabled: boolean;
        allowedDomains: string[];
        timeoutMs: number;
        maxSizeBytes: number;
      } = {
        enabled: false,
        allowedDomains: [],
        timeoutMs: 5000,
        maxSizeBytes: 102400,
      };

      try {
        const settingsJson = await c.env.SETTINGS?.get('system_settings');
        if (settingsJson) {
          const settings = JSON.parse(settingsJson);
          const kvConfig = settings.oidc?.httpsRequestUri;
          if (kvConfig) {
            httpsRequestUriConfig = {
              enabled: kvConfig.enabled ?? false,
              allowedDomains: kvConfig.allowedDomains ?? [],
              timeoutMs: kvConfig.timeoutMs ?? 5000,
              maxSizeBytes: kvConfig.maxSizeBytes ?? 102400,
            };
          }
        }
      } catch (error) {
        console.error('Failed to load HTTPS request_uri settings from KV:', error);
      }

      // Fall back to environment variables if not configured in KV
      if (!httpsRequestUriConfig.enabled) {
        httpsRequestUriConfig.enabled = c.env.ENABLE_HTTPS_REQUEST_URI === 'true';
      }
      if (httpsRequestUriConfig.allowedDomains.length === 0) {
        const allowedDomainsStr = c.env.HTTPS_REQUEST_URI_ALLOWED_DOMAINS || '';
        httpsRequestUriConfig.allowedDomains = allowedDomainsStr
          ? allowedDomainsStr.split(',').map((d) => d.trim().toLowerCase())
          : [];
      }
      if (c.env.HTTPS_REQUEST_URI_TIMEOUT_MS) {
        httpsRequestUriConfig.timeoutMs = parseInt(c.env.HTTPS_REQUEST_URI_TIMEOUT_MS, 10);
      }
      if (c.env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES) {
        httpsRequestUriConfig.maxSizeBytes = parseInt(c.env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES, 10);
      }

      if (!httpsRequestUriConfig.enabled) {
        return c.json(
          {
            error: 'request_uri_not_supported',
            error_description:
              'HTTPS request_uri is disabled. Use PAR (RFC 9126) with urn:ietf:params:oauth:request_uri: format instead.',
          },
          400
        );
      }

      // Security controls for HTTPS request_uri
      const allowedDomains = httpsRequestUriConfig.allowedDomains;
      const timeoutMs = httpsRequestUriConfig.timeoutMs;
      const maxSizeBytes = httpsRequestUriConfig.maxSizeBytes;

      // Validate URL and extract domain
      let requestUrl: URL;
      try {
        requestUrl = new URL(request_uri);
      } catch {
        return c.json(
          {
            error: 'invalid_request_uri',
            error_description: 'Invalid URL format for request_uri',
          },
          400
        );
      }

      // Validate domain against allowlist (if configured)
      if (allowedDomains.length > 0) {
        const requestDomain = requestUrl.hostname.toLowerCase();
        const isDomainAllowed = allowedDomains.some(
          (allowed) => requestDomain === allowed || requestDomain.endsWith('.' + allowed)
        );

        if (!isDomainAllowed) {
          console.warn(
            `SSRF prevention: Rejected request_uri domain ${requestDomain}. Allowed: ${allowedDomains.join(', ')}`
          );
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: 'request_uri domain is not in the allowed list',
            },
            400
          );
        }
      }

      // Prevent SSRF to localhost/internal IPs
      const hostname = requestUrl.hostname.toLowerCase();
      const blockedPatterns = [
        'localhost',
        '127.',
        '10.',
        '172.16.',
        '172.17.',
        '172.18.',
        '172.19.',
        '172.20.',
        '172.21.',
        '172.22.',
        '172.23.',
        '172.24.',
        '172.25.',
        '172.26.',
        '172.27.',
        '172.28.',
        '172.29.',
        '172.30.',
        '172.31.',
        '192.168.',
        '169.254.',
        '0.',
        '::1',
        'fe80::',
        'fc00::',
        'fd00::',
      ];

      const isBlocked =
        blockedPatterns.some((pattern) => hostname === pattern || hostname.startsWith(pattern)) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal');

      if (isBlocked) {
        console.warn(`SSRF prevention: Blocked request_uri to internal address ${hostname}`);
        return c.json(
          {
            error: 'invalid_request_uri',
            error_description: 'request_uri cannot point to internal addresses',
          },
          400
        );
      }

      try {
        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Fetch the Request Object from the URL with security controls
        const requestObjectResponse = await fetch(request_uri, {
          method: 'GET',
          headers: {
            Accept: 'application/oauth-authz-req+jwt, application/jwt',
          },
          signal: controller.signal,
          redirect: 'error', // Prevent redirect-based SSRF
        });

        clearTimeout(timeoutId);

        if (!requestObjectResponse.ok) {
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: 'Failed to fetch request object from request_uri',
            },
            400
          );
        }

        // Check Content-Length header first
        const contentLength = requestObjectResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: `Response too large: ${contentLength} bytes exceeds limit of ${maxSizeBytes} bytes`,
            },
            400
          );
        }

        // Read response with size limit
        const reader = requestObjectResponse.body?.getReader();
        if (!reader) {
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: 'Failed to read response body',
            },
            400
          );
        }

        const chunks: Uint8Array[] = [];
        let totalSize = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalSize += value.length;
          if (totalSize > maxSizeBytes) {
            reader.cancel();
            return c.json(
              {
                error: 'invalid_request_uri',
                error_description: `Response too large: exceeds limit of ${maxSizeBytes} bytes`,
              },
              400
            );
          }
          chunks.push(value);
        }

        // Combine chunks into a single buffer and decode
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const requestObject = new TextDecoder().decode(combined);

        // Use the fetched Request Object as if it was the 'request' parameter
        request = requestObject;
        // Continue to request parameter processing below
        request_uri = undefined; // Clear request_uri to avoid PAR processing
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isTimeout = errorMessage.includes('abort') || errorMessage.includes('timeout');
        console.error('Failed to fetch request_uri:', error);
        return c.json(
          {
            error: 'invalid_request_uri',
            error_description: isTimeout
              ? `Request timed out after ${timeoutMs}ms`
              : 'Failed to fetch request object from request_uri',
          },
          400
        );
      }
    }

    // Handle PAR request_uri (URN format)
    if (isPAR) {
      // Retrieve request parameters atomically (issue #11: single-use guarantee)
      // Try DO first, fall back to KV
      let parsedData: {
        client_id: string;
        response_type: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        claims?: string;
        response_mode?: string;
      } | null = null;

      if (!c.env.PAR_REQUEST_STORE || !client_id) {
        return c.json(
          {
            error: 'server_error',
            error_description: 'PAR request storage unavailable',
          },
          500
        );
      }

      // Use PARRequestStore DO for atomic consume
      const id = c.env.PAR_REQUEST_STORE.idFromName(client_id);
      const stub = c.env.PAR_REQUEST_STORE.get(id);

      const response = await stub.fetch('http://internal/request/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestUri: request_uri,
          client_id: client_id,
        }),
      });

      if (response.ok) {
        parsedData = (await response.json()) as typeof parsedData;
      }

      if (!parsedData) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid or expired request_uri',
          },
          400
        );
      }

      // Type assertion to help TypeScript understand parsedData is non-null after null check
      const parData: {
        client_id: string;
        response_type: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        claims?: string;
        response_mode?: string;
      } = parsedData;

      try {
        // RFC 9126: When using request_uri, client_id from query MUST match client_id from PAR
        if (client_id && client_id !== parData.client_id) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'client_id mismatch',
            },
            400
          );
        }

        // Load parameters from PAR request
        response_type = parData.response_type;
        client_id = parData.client_id;
        redirect_uri = parData.redirect_uri;
        scope = parData.scope;
        state = parData.state;
        nonce = parData.nonce;
        code_challenge = parData.code_challenge;
        code_challenge_method = parData.code_challenge_method;
        claims = parData.claims;
        response_mode = parData.response_mode;
      } catch {
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to process request_uri',
          },
          500
        );
      }
    }
  }

  // RFC 9101 (JAR): If request parameter is present, parse JWT request object
  if (request) {
    try {
      let requestObjectClaims: Record<string, unknown> | undefined;

      // Check if request is JWE (encrypted) or JWT (signed)
      let tokenFormat = getTokenFormat(request);

      if (tokenFormat === 'unknown') {
        return c.json(
          {
            error: 'invalid_request_object',
            error_description: 'Request object must be a valid JWT or JWE',
          },
          400
        );
      }

      // Step 1: Decrypt JWE if needed (RFC 9101 Section 6.1)
      let jwtRequest = request;
      if (tokenFormat === 'jwe') {
        // JWE: Decrypt using server's private key
        const privateKeyPem = c.env.PRIVATE_KEY_PEM;
        if (!privateKeyPem) {
          return c.json(
            {
              error: 'server_error',
              error_description: 'Server private key not configured',
            },
            500
          );
        }

        const privateKey = await importPKCS8(privateKeyPem, 'RS256');

        try {
          // Decrypt JWE to get inner JWT/payload
          const { plaintext } = await compactDecrypt(request, privateKey);
          const decoder = new TextDecoder();
          const decrypted = decoder.decode(plaintext);

          // Check if decrypted content is a JWT (needs verification) or direct JSON payload
          if (decrypted.startsWith('{')) {
            // Direct JSON payload
            requestObjectClaims = JSON.parse(decrypted) as Record<string, unknown>;
          } else {
            // Nested JWT - need to verify signature
            jwtRequest = decrypted;
            tokenFormat = getTokenFormat(jwtRequest);
            // Continue to JWT verification below
          }
        } catch (decryptError) {
          console.error('Failed to decrypt JWE request object:', decryptError);
          return c.json(
            {
              error: 'invalid_request_object',
              error_description: 'Failed to decrypt request object',
            },
            400
          );
        }
      }

      // Step 2: Verify JWT signature (if not already decrypted to payload)
      if (tokenFormat === 'jwt') {
        // Parse JWT header to check algorithm
        const parts = jwtRequest.split('.');
        const base64url = parts[0];
        const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        const header = JSON.parse(atob(base64));
        const alg = header.alg;

        if (alg === 'none') {
          // Check if 'none' algorithm is allowed (read from KV settings)
          const settingsJson = await c.env.SETTINGS?.get('system_settings');
          const settings = settingsJson ? JSON.parse(settingsJson) : {};
          const allowNoneAlgorithm = settings.oidc?.allowNoneAlgorithm ?? false;

          if (!allowNoneAlgorithm) {
            console.warn(
              '[SECURITY] Rejected unsigned request object (alg=none) - not allowed in current configuration'
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

          // Unsigned request object - just parse without verification
          // Note: This should only be allowed in development/testing
          console.warn(
            '[SECURITY] Using unsigned request object (alg=none) - should only be used in development'
          );
          requestObjectClaims = parseToken(jwtRequest) as Record<string, unknown>;
        } else {
          // Signed request object - verify using client's public key
          // Get client metadata to retrieve jwks or jwks_uri
          if (!client_id) {
            return c.json(
              {
                error: 'invalid_request',
                error_description: 'client_id is required when using signed request objects',
              },
              400
            );
          }

          const clientResult = await getClient(c.env, client_id);
          if (!clientResult) {
            return c.json(
              {
                error: 'invalid_client',
                error_description: 'Client not found',
              },
              401
            );
          }

          let publicKey: CryptoKey;

          // Try to get public key from client's jwks
          if (
            clientResult.jwks &&
            typeof clientResult.jwks === 'object' &&
            clientResult.jwks !== null &&
            'keys' in clientResult.jwks &&
            Array.isArray(clientResult.jwks.keys)
          ) {
            // Find a suitable key for signature verification
            const signingKey = (clientResult.jwks.keys as any[]).find((key: any) => {
              return key.use === 'sig' || !key.use; // Accept keys with use=sig or no use specified
            });

            if (!signingKey) {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'No suitable signing key found in client jwks',
                },
                400
              );
            }

            publicKey = (await importJWK(signingKey, alg)) as CryptoKey;
          } else if (clientResult.jwks_uri && typeof clientResult.jwks_uri === 'string') {
            // Fetch JWKS from jwks_uri
            try {
              const jwksResponse = await fetch(clientResult.jwks_uri);
              if (!jwksResponse.ok) {
                return c.json(
                  {
                    error: 'invalid_request_object',
                    error_description: 'Failed to fetch client jwks_uri',
                  },
                  400
                );
              }

              const jwks = (await jwksResponse.json()) as { keys: any[] };
              const signingKey = jwks.keys.find((key: any) => {
                return key.use === 'sig' || !key.use;
              });

              if (!signingKey) {
                return c.json(
                  {
                    error: 'invalid_request_object',
                    error_description: 'No suitable signing key found in client jwks_uri',
                  },
                  400
                );
              }

              publicKey = (await importJWK(signingKey, alg)) as CryptoKey;
            } catch (fetchError) {
              console.error('Failed to fetch jwks_uri:', fetchError);
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'Failed to fetch client jwks_uri',
                },
                400
              );
            }
          } else {
            // Fallback: Use server's public key (for backward compatibility)
            // This should be removed in production
            const publicJwkJson = c.env.PUBLIC_JWK_JSON;
            if (!publicJwkJson) {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'No client public key available for verification',
                },
                400
              );
            }

            let publicJwk;
            try {
              publicJwk = JSON.parse(publicJwkJson);
            } catch {
              return c.json(
                {
                  error: 'server_error',
                  error_description: 'Server configuration error',
                },
                500
              );
            }

            publicKey = (await importJWK(publicJwk, alg)) as CryptoKey;
          }

          // Verify the signature
          const verified = await verifyToken(jwtRequest, publicKey, c.env.ISSUER_URL, client_id);
          requestObjectClaims = verified as Record<string, unknown>;
        }
      }

      // Override parameters with those from request object
      // Per OIDC Core 6.1: request object parameters take precedence
      if (requestObjectClaims) {
        // OIDC Core 6.1: redirect_uri is REQUIRED in the request object
        if (!requestObjectClaims.redirect_uri) {
          return c.json(
            {
              error: 'invalid_request_object',
              error_description: 'redirect_uri is required in request object',
            },
            400
          );
        }

        // If redirect_uri was also provided as a query parameter, it must match
        const queryRedirectUri = redirect_uri;
        const requestObjectRedirectUri = requestObjectClaims.redirect_uri as string;

        if (queryRedirectUri && queryRedirectUri !== requestObjectRedirectUri) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'redirect_uri mismatch between query parameter and request object',
            },
            400
          );
        }

        if (requestObjectClaims.response_type)
          response_type = requestObjectClaims.response_type as string;
        if (requestObjectClaims.client_id) client_id = requestObjectClaims.client_id as string;
        redirect_uri = requestObjectRedirectUri;
        if (requestObjectClaims.scope) scope = requestObjectClaims.scope as string;
        if (requestObjectClaims.state) state = requestObjectClaims.state as string;
        if (requestObjectClaims.nonce) nonce = requestObjectClaims.nonce as string;
        if (requestObjectClaims.code_challenge)
          code_challenge = requestObjectClaims.code_challenge as string;
        if (requestObjectClaims.code_challenge_method)
          code_challenge_method = requestObjectClaims.code_challenge_method as string;
        if (requestObjectClaims.claims) claims = requestObjectClaims.claims as string;
        if (requestObjectClaims.response_mode)
          response_mode = requestObjectClaims.response_mode as string;
        if (requestObjectClaims.prompt) prompt = requestObjectClaims.prompt as string;
        if (requestObjectClaims.max_age) max_age = requestObjectClaims.max_age as string;
        if (requestObjectClaims.id_token_hint)
          id_token_hint = requestObjectClaims.id_token_hint as string;
        if (requestObjectClaims.acr_values) acr_values = requestObjectClaims.acr_values as string;
        if (requestObjectClaims.display) display = requestObjectClaims.display as string;
        if (requestObjectClaims.ui_locales) ui_locales = requestObjectClaims.ui_locales as string;
        if (requestObjectClaims.login_hint) login_hint = requestObjectClaims.login_hint as string;
      }
    } catch (error) {
      console.error('Failed to parse request object:', error);
      return c.json(
        {
          error: 'invalid_request_object',
          error_description: 'Failed to parse or verify request object',
        },
        400
      );
    }
  }

  // Validate response_type
  // RFC 6749 Section 4.1.2.1:
  // - invalid_request: missing required parameter (response_type is absent)
  // - unsupported_response_type: response_type value is not supported
  if (!response_type) {
    // response_type is missing - use invalid_request per RFC 6749
    const uiUrl = c.env.UI_URL;
    if (uiUrl) {
      const errorParams = new URLSearchParams({
        error: 'invalid_request',
        error_description: 'response_type is required',
      });
      return c.redirect(`${uiUrl}/error?${errorParams.toString()}`, 302);
    }
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'response_type is required',
      },
      400
    );
  }

  const responseTypeValidation = validateResponseType(response_type);
  if (!responseTypeValidation.valid) {
    // response_type is present but unsupported - use unsupported_response_type
    const uiUrl = c.env.UI_URL;
    if (uiUrl) {
      const errorParams = new URLSearchParams({
        error: 'unsupported_response_type',
        error_description: responseTypeValidation.error || 'Unsupported response_type',
      });
      return c.redirect(`${uiUrl}/error?${errorParams.toString()}`, 302);
    }
    return c.json(
      {
        error: 'unsupported_response_type',
        error_description: responseTypeValidation.error,
      },
      400
    );
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Type narrowing: client_id is guaranteed to be a string at this point
  const validClientId: string = client_id as string;

  // Fetch client metadata to validate redirect_uri
  const clientMetadata = await getClient(c.env, validClientId);
  if (!clientMetadata) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      400
    );
  }

  // Load FAPI 2.0 configuration from SETTINGS KV
  let fapiConfig: any = {};
  let oidcConfig: any = {};
  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      fapiConfig = settings.fapi || {};
      oidcConfig = settings.oidc || {};
    }
  } catch (error) {
    console.error('Failed to load FAPI settings from KV:', error);
    // Continue with default values (FAPI disabled)
  }

  // FAPI 2.0 Security Profile validation
  if (fapiConfig.enabled) {
    // FAPI 2.0 SHALL reject authorization requests sent without PAR
    const requirePar = oidcConfig.requirePar !== false; // Default to true in FAPI mode
    const usedPAR = request_uri && request_uri.startsWith('urn:ietf:params:oauth:request_uri:');

    if (requirePar && !usedPAR) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PAR is required in FAPI 2.0 mode. Use /as/par endpoint first.',
        },
        400
      );
    }

    // FAPI 2.0 SHALL only support confidential clients (unless explicitly allowed)
    const allowPublicClients = fapiConfig.allowPublicClients !== false;
    const isPublicClient = !clientMetadata.client_secret;

    if (!allowPublicClients && isPublicClient) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Public clients are not allowed in FAPI 2.0 mode',
        },
        400
      );
    }

    // FAPI 2.0 SHALL require PKCE with S256
    if (!code_challenge || code_challenge_method !== 'S256') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PKCE with S256 is required in FAPI 2.0 mode',
        },
        400
      );
    }
  }

  // OAuth 2.0 Section 3.1.2.3: Handle redirect_uri based on registration
  // Must be done BEFORE format validation to support default redirect_uri
  const registeredRedirectUrisForDefault = clientMetadata.redirect_uris as string[] | undefined;
  if (
    !redirect_uri &&
    registeredRedirectUrisForDefault &&
    Array.isArray(registeredRedirectUrisForDefault)
  ) {
    if (registeredRedirectUrisForDefault.length === 1) {
      // Only one registered - use as default (redirect_uri parameter is optional)
      redirect_uri = registeredRedirectUrisForDefault[0];
      console.log(`[Auth] Using default redirect_uri: ${redirect_uri}`);
    } else if (registeredRedirectUrisForDefault.length > 1) {
      // Multiple registered - redirect_uri is required
      return c.html(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Missing Redirect URI</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 500px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Missing Redirect URI</h1>
    <p>The redirect_uri parameter is required when the client has multiple registered redirect URIs.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> redirect_uri is required when multiple redirect URIs are registered
    </div>
    <p>Please include the redirect_uri parameter in your authorization request.</p>
  </div>
</body>
</html>`,
        400
      );
    }
  }

  // Validate redirect_uri format (allow http for development)
  const allowHttp = c.env.ALLOW_HTTP_REDIRECT === 'true';
  const redirectUriValidation = validateRedirectUri(redirect_uri, allowHttp);
  if (!redirectUriValidation.valid) {
    // Invalid redirect_uri format - cannot redirect, must show error page
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Redirect URI</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 500px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Invalid Redirect URI</h1>
    <p>The redirect URI provided in the authorization request is invalid.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> ${redirectUriValidation.error}
    </div>
    <p>Please contact the application developer to resolve this issue.</p>
  </div>
</body>
</html>`,
      400
    );
  }

  // Check if redirect_uri is registered for this client
  // Per OAuth 2.0 Section 3.1.2.3: redirect_uri MUST match one of the registered redirect URIs
  const registeredRedirectUris = clientMetadata.redirect_uris as string[] | undefined;
  if (
    !registeredRedirectUris ||
    !Array.isArray(registeredRedirectUris) ||
    registeredRedirectUris.length === 0
  ) {
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Client Configuration Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 500px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Client Configuration Error</h1>
    <p>The client application has not registered any redirect URIs.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_client<br>
      <strong>Description:</strong> Client has no registered redirect URIs
    </div>
    <p>Please contact the application developer to resolve this issue.</p>
  </div>
</body>
</html>`,
      400
    );
  }

  // Check if the provided redirect_uri matches one of the registered URIs
  // Note: redirect_uri default handling is done earlier (before format validation)
  const redirectUriMatches = registeredRedirectUris.includes(redirect_uri as string);
  if (!redirectUriMatches) {
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unregistered Redirect URI</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 500px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Unregistered Redirect URI</h1>
    <p>The redirect URI provided in the authorization request is not registered for this client application.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> redirect_uri is not registered for this client<br>
      <strong>Provided URI:</strong> ${redirect_uri || '(none)'}
    </div>
    <p>Please contact the application developer to register the redirect URI or use a registered redirect URI.</p>
  </div>
</body>
</html>`,
      400
    );
  }

  // From here on, we have a valid and registered redirect_uri, so errors should be returned via redirect
  // Type narrowing: redirect_uri is guaranteed to be a string at this point
  const validRedirectUri: string = redirect_uri as string;

  const sendError = (
    error: string,
    description?: string,
    overrideState: string | undefined = state
  ) =>
    redirectWithError(c, validRedirectUri, error, description, overrideState, {
      responseMode: response_mode,
      responseType: response_type,
      clientId: validClientId,
    });

  // Validate scope
  const scopeValidation = validateScope(scope);
  if (!scopeValidation.valid) {
    return sendError('invalid_scope', scopeValidation.error);
  }

  // Validate state (optional)
  const stateValidation = validateState(state);
  if (!stateValidation.valid) {
    return sendError('invalid_request', stateValidation.error);
  }

  // Validate nonce (optional for code flow, required for implicit/hybrid flows)
  const nonceValidation = validateNonce(nonce);
  if (!nonceValidation.valid) {
    return sendError('invalid_request', nonceValidation.error);
  }

  // Per OIDC Core 3.2.2.1 and 3.3.2.11: nonce is REQUIRED when id_token is returned directly
  // from the authorization endpoint (Implicit and Hybrid flows with id_token)
  // - code: nonce optional (id_token returned from token endpoint)
  // - code token: nonce optional (id_token returned from token endpoint)
  // - id_token: nonce REQUIRED (id_token returned directly)
  // - id_token token: nonce REQUIRED (id_token returned directly)
  // - code id_token: nonce REQUIRED (id_token returned directly)
  // - code id_token token: nonce REQUIRED (id_token returned directly)
  const nonceCheckResponseTypes = response_type!.split(/\s+/);
  const nonceCheckIncludesIdToken = nonceCheckResponseTypes.includes('id_token');
  const requiresNonce = nonceCheckIncludesIdToken;
  if (requiresNonce && !nonce) {
    return sendError('invalid_request', 'nonce is required when response_type contains id_token');
  }

  // Validate response_mode (optional)
  // Supported modes: query, fragment, form_post, and their JWT variants (JARM)
  if (response_mode) {
    const supportedResponseModes = [
      'query',
      'fragment',
      'form_post',
      'query.jwt',
      'fragment.jwt',
      'form_post.jwt',
      'jwt', // Generic JWT mode (defaults to fragment for implicit/hybrid, query for code)
    ];
    if (!supportedResponseModes.includes(response_mode)) {
      return sendError(
        'invalid_request',
        `Unsupported response_mode. Supported modes: ${supportedResponseModes.join(', ')}`
      );
    }

    // Extract base mode and JWT flag
    const baseMode = response_mode.replace('.jwt', '');
    const isJARM = response_mode.includes('.jwt') || response_mode === 'jwt';

    // Validate response_mode compatibility with response_type
    // Per OIDC Core 3.3.2.5: For response_type=code only, fragment is not allowed
    // For hybrid flows (code + token/id_token), fragment is required by default
    if (response_type === 'code' && baseMode === 'fragment') {
      return sendError(
        'invalid_request',
        'response_mode=fragment is not compatible with response_type=code'
      );
    }
  }

  // Validate claims parameter (optional, per OIDC Core 5.5)
  if (claims) {
    try {
      const parsedClaims: unknown = JSON.parse(claims);

      // Validate claims structure
      if (
        typeof parsedClaims !== 'object' ||
        parsedClaims === null ||
        Array.isArray(parsedClaims)
      ) {
        return sendError('invalid_request', 'claims parameter must be a JSON object');
      }

      // Validate that claims object contains valid sections (userinfo and/or id_token)
      const validSections = ['userinfo', 'id_token'];
      const claimsSections = Object.keys(parsedClaims as Record<string, unknown>);

      if (claimsSections.length === 0) {
        return sendError(
          'invalid_request',
          'claims parameter must contain at least one of: userinfo, id_token'
        );
      }

      for (const section of claimsSections) {
        if (!validSections.includes(section)) {
          return sendError(
            'invalid_request',
            `Invalid claims section: ${section}. Must be one of: ${validSections.join(', ')}`
          );
        }

        // Validate section contains an object
        const claimsObj = parsedClaims as Record<string, unknown>;
        if (typeof claimsObj[section] !== 'object' || claimsObj[section] === null) {
          return sendError('invalid_request', `claims.${section} must be an object`);
        }
      }
    } catch {
      return sendError('invalid_request', 'claims parameter must be valid JSON');
    }
  }

  // Validate PKCE parameters if provided
  if (code_challenge) {
    if (!code_challenge_method) {
      return sendError(
        'invalid_request',
        'code_challenge_method is required when code_challenge is provided'
      );
    }

    // Only support S256 for security (plain is deprecated)
    if (code_challenge_method !== 'S256') {
      return sendError(
        'invalid_request',
        'Unsupported code_challenge_method. Only S256 is supported'
      );
    }

    // Validate code_challenge format (base64url, 43-128 characters)
    const base64urlPattern = /^[A-Za-z0-9_-]{43,128}$/;
    if (!base64urlPattern.test(code_challenge)) {
      return sendError('invalid_request', 'Invalid code_challenge format');
    }
  }

  // Process authentication-related parameters (OIDC Core 3.1.2.1)
  let sessionUserId: string | undefined;
  let authTime: number | undefined;
  let sessionAcr: string | undefined;

  // Check for existing session (cookie)
  // This is required for prompt=none to work correctly
  const sessionId = c.req.header('Cookie')?.match(/authrim_session=([^;]+)/)?.[1];
  // Only process sharded session IDs (new format: {shardIndex}_session_{uuid})
  // Legacy sessions without shard prefix are treated as invalid (user must re-login)
  if (sessionId && c.env.SESSION_STORE && isShardedSessionId(sessionId)) {
    try {
      const sessionStore = await getSessionStoreBySessionId(c.env, sessionId);

      const sessionResponse = await sessionStore.fetch(
        new Request(`https://session-store/session/${encodeURIComponent(sessionId)}`, {
          method: 'GET',
        })
      );

      if (sessionResponse.ok) {
        const session = (await sessionResponse.json()) as {
          id: string;
          userId: string;
          createdAt: number;
          expiresAt: number;
          data?: {
            authTime?: number;
            [key: string]: unknown;
          };
        };

        // Check if session is not expired
        if (session.expiresAt > Date.now()) {
          sessionUserId = session.userId;
          // Don't set authTime from session if this is a confirmed re-authentication
          // (it will be set later based on prompt parameter)
          if (_confirmed !== 'true') {
            // OIDC Conformance: Use authTime from session data if available
            // This ensures consistency between initial login and prompt=none requests
            // Fallback to createdAt for backward compatibility with existing sessions
            if (session.data?.authTime && typeof session.data.authTime === 'number') {
              authTime = session.data.authTime;
              console.log('[AUTH] Setting authTime from session data:', authTime);
            } else {
              authTime = Math.floor(session.createdAt / 1000);
              console.log('[AUTH] Setting authTime from session createdAt (legacy):', authTime);
            }
          } else {
            console.log('[AUTH] Skipping session authTime (_confirmed=true)');
          }
        }
      }
    } catch (error) {
      console.error('Failed to retrieve session:', error);
      // Continue without session
    }
  }

  // If this is a re-authentication confirmation callback, restore original auth_time and sessionUserId
  // EXCEPT when prompt=login or max_age re-authentication (which require a new auth_time)
  if (_confirmed === 'true') {
    console.log(
      '[AUTH] Confirmation callback - prompt:',
      prompt,
      'max_age:',
      max_age,
      '_auth_time:',
      _auth_time
    );

    // prompt=login or max_age re-authentication requires a new auth_time (user just re-authenticated)
    if (prompt?.includes('login') || max_age) {
      authTime = Math.floor(Date.now() / 1000);
      console.log(
        '[AUTH] Re-authentication confirmed (prompt=login or max_age), setting new authTime:',
        authTime
      );
    } else if (_auth_time) {
      // For other scenarios, restore original auth_time
      authTime = parseInt(_auth_time, 10);
      console.log('[AUTH] Restoring original authTime:', authTime);
    }

    if (_session_user_id) {
      sessionUserId = _session_user_id;
    }
  }

  // Handle id_token_hint parameter (fallback if no session cookie)
  if (id_token_hint && !sessionUserId) {
    try {
      // Decode JWT header to get kid (Key ID)
      const parts = id_token_hint.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }
      const headerBase64url = parts[0];
      const headerBase64 = headerBase64url.replace(/-/g, '+').replace(/_/g, '/');
      const headerJson = JSON.parse(atob(headerBase64)) as { kid?: string; alg?: string };
      const kid = headerJson.kid;

      // Fetch JWKS from KeyManager DO
      let publicKey: CryptoKey | null = null;

      if (c.env.KEY_MANAGER) {
        try {
          const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
          const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
          const jwksResponse = await keyManager.fetch('http://internal/jwks', { method: 'GET' });

          if (jwksResponse.ok) {
            const jwks = (await jwksResponse.json()) as {
              keys: Array<{ kid?: string; [key: string]: unknown }>;
            };
            // Find key by kid
            const jwk = kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0];
            if (jwk) {
              publicKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
            }
          }
        } catch (kmError) {
          console.warn(
            'Failed to fetch key from KeyManager, falling back to PUBLIC_JWK_JSON:',
            kmError
          );
        }
      }

      // Fallback to PUBLIC_JWK_JSON if KeyManager unavailable
      if (!publicKey) {
        const publicJwkJson = c.env.PUBLIC_JWK_JSON;
        if (publicJwkJson) {
          const publicJwk = JSON.parse(publicJwkJson);
          // Check if kid matches (if available)
          if (!kid || publicJwk.kid === kid) {
            publicKey = (await importJWK(publicJwk, 'RS256')) as CryptoKey;
          }
        }
      }

      if (publicKey) {
        const verified = await verifyToken(
          id_token_hint,
          publicKey,
          c.env.ISSUER_URL,
          client_id || ''
        );
        const idTokenPayload = verified.payload as Record<string, unknown>;

        // Extract user identifier and auth_time from ID token
        sessionUserId = idTokenPayload.sub as string;
        authTime = idTokenPayload.auth_time as number;
        sessionAcr = idTokenPayload.acr as string;
        console.log(
          'id_token_hint verified successfully, sub:',
          sessionUserId,
          'auth_time:',
          authTime
        );
      } else {
        console.error('No matching public key found for id_token_hint verification');
      }
    } catch (error) {
      console.error('Failed to verify id_token_hint:', error);
      console.error('Error details:', error instanceof Error ? error.message : 'Unknown error');
      // Invalid id_token_hint - treat as if no session exists
    }
  }

  // Handle prompt parameter (OIDC Core 3.1.2.1)
  if (prompt) {
    const promptValues = prompt.split(' ');

    // Check for invalid prompt combinations
    if (promptValues.includes('none') && promptValues.length > 1) {
      return sendError(
        'invalid_request',
        'prompt=none cannot be combined with other prompt values'
      );
    }

    if (promptValues.includes('none')) {
      // prompt=none: MUST NOT display any authentication or consent UI
      // If not authenticated, return login_required error
      if (!sessionUserId) {
        return sendError('login_required', 'User authentication is required');
      }

      // Check max_age if provided
      if (max_age && authTime) {
        const maxAgeSeconds = parseInt(max_age, 10);
        const currentTime = Math.floor(Date.now() / 1000);
        const timeSinceAuth = currentTime - authTime;

        if (timeSinceAuth > maxAgeSeconds) {
          return sendError(
            'login_required',
            'Re-authentication is required due to max_age constraint'
          );
        }
      }
    }

    if (promptValues.includes('login') && _confirmed !== 'true') {
      // prompt=login: Force re-authentication even if user has valid session
      // Clear session context to force login (unless user has already confirmed)
      sessionUserId = undefined;
      authTime = undefined;
    }

    // Note: prompt=consent and prompt=select_account are handled by consent UI
    // They don't affect the authorization endpoint logic directly
  }

  // Handle max_age parameter (OIDC Core 3.1.2.1)
  // Skip this check if user has already confirmed re-authentication
  let requiresReauthentication = false;
  if (max_age && !prompt?.includes('none') && _confirmed !== 'true') {
    const maxAgeSeconds = parseInt(max_age, 10);

    if (authTime) {
      const currentTime = Math.floor(Date.now() / 1000);
      const timeSinceAuth = currentTime - authTime;

      if (timeSinceAuth > maxAgeSeconds) {
        // Re-authentication required - show confirmation screen
        requiresReauthentication = true;
        // Note: Do NOT clear auth_time here - it will be preserved through the confirmation flow
      }
    }
  }

  // If re-authentication is required, show confirmation screen (unless already confirmed)
  if (
    (requiresReauthentication || (prompt?.includes('login') && sessionUserId)) &&
    _confirmed !== 'true'
  ) {
    // Store authorization request parameters in ChallengeStore
    const challengeId = crypto.randomUUID();
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: challengeId,
          type: 'reauth',
          userId: sessionUserId || 'anonymous',
          challenge: challengeId,
          ttl: 600, // 10 minutes
          metadata: {
            response_type,
            client_id,
            redirect_uri,
            scope,
            state,
            nonce,
            code_challenge,
            code_challenge_method,
            claims,
            response_mode,
            max_age,
            prompt,
            id_token_hint,
            acr_values,
            display,
            ui_locales,
            login_hint,
            sessionUserId,
            authTime, // Preserve original auth_time
          },
        }),
      })
    );

    // Redirect to UI re-authentication screen (if UI_URL is configured)
    // Otherwise, redirect to local /authorize/confirm GET endpoint which will show the UI
    const uiUrl = c.env.UI_URL;
    if (uiUrl) {
      return c.redirect(`${uiUrl}/reauth?challenge_id=${encodeURIComponent(challengeId)}`, 302);
    } else {
      // Fallback: redirect to local confirm endpoint with GET
      return c.redirect(`/authorize/confirm?challenge_id=${encodeURIComponent(challengeId)}`, 302);
    }
  }

  // If no session exists and prompt is not 'none', redirect to login screen
  if (!sessionUserId && !prompt?.includes('none')) {
    // Store authorization request parameters in ChallengeStore
    const challengeId = crypto.randomUUID();
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: challengeId,
          type: 'login',
          userId: 'anonymous',
          challenge: challengeId,
          ttl: 600, // 10 minutes
          metadata: {
            response_type,
            client_id,
            redirect_uri,
            scope,
            state,
            nonce,
            code_challenge,
            code_challenge_method,
            claims,
            response_mode,
            max_age,
            prompt,
            id_token_hint,
            acr_values,
            display,
            ui_locales,
            login_hint,
            // Client metadata for login page display (OIDC Dynamic OP requirement)
            client_name: clientMetadata?.client_name || client_id,
            logo_uri: clientMetadata?.logo_uri,
            policy_uri: clientMetadata?.policy_uri,
            tos_uri: clientMetadata?.tos_uri,
            client_uri: clientMetadata?.client_uri,
          },
        }),
      })
    );

    // Redirect to UI login screen (if UI_URL is configured)
    // Otherwise, redirect to local /authorize/login GET endpoint which will show the UI
    const uiUrl = c.env.UI_URL;
    if (uiUrl) {
      return c.redirect(`${uiUrl}/login?challenge_id=${encodeURIComponent(challengeId)}`, 302);
    } else {
      // Fallback: redirect to local login endpoint with GET
      return c.redirect(`/authorize/login?challenge_id=${encodeURIComponent(challengeId)}`, 302);
    }
  }

  // Determine user identifier (sub)
  // Use session user if available, otherwise not allowed (should have been redirected to login)
  if (!sessionUserId) {
    // This should only happen with prompt=none (which should have failed earlier with login_required)
    return sendError('login_required', 'User authentication is required');
  }

  const sub = sessionUserId;

  // Check if consent is required (unless already confirmed)
  // Note: _consent_confirmed is already parsed at the top of this function
  if (_consent_confirmed !== 'true') {
    // Get client metadata to check if it's a trusted client
    const clientMetadata = await getClient(c.env, validClientId);

    // Check if this is a trusted client that can skip consent
    const isTrustedClient =
      clientMetadata && clientMetadata.is_trusted && clientMetadata.skip_consent;

    // Trusted clients skip consent (unless prompt=consent is explicitly specified)
    if (isTrustedClient && !prompt?.includes('consent')) {
      // Check if consent already exists
      const existingConsent = await c.env.DB.prepare(
        'SELECT id FROM oauth_client_consents WHERE user_id = ? AND client_id = ?'
      )
        .bind(sub, validClientId)
        .first();

      if (!existingConsent) {
        // Auto-grant consent for trusted client
        const consentId = crypto.randomUUID();
        const now = Date.now();

        await c.env.DB.prepare(
          `
          INSERT INTO oauth_client_consents
          (id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `
        )
          .bind(consentId, sub, validClientId, scope, now, null)
          .run();

        console.log(
          `[CONSENT] Auto-granted for trusted client: client_id=${validClientId}, user_id=${sub}`
        );
      }

      // Skip consent screen
      // Continue to authorization code generation
    } else {
      // Third-Party Client or prompt=consent: Check consent requirements
      let consentRequired = false;
      try {
        const existingConsent = await c.env.DB.prepare(
          'SELECT scope, granted_at, expires_at FROM oauth_client_consents WHERE user_id = ? AND client_id = ?'
        )
          .bind(sub, validClientId)
          .first();

        if (!existingConsent) {
          // No consent record exists
          consentRequired = true;
        } else {
          // Check if consent has expired
          const expiresAt = existingConsent.expires_at as number | null;
          if (expiresAt && expiresAt < Date.now()) {
            consentRequired = true;
          } else {
            // Check if requested scopes are covered by existing consent
            const grantedScopes = (existingConsent.scope as string).split(' ');
            const requestedScopes = (scope as string).split(' ');
            const hasAllScopes = requestedScopes.every((s) => grantedScopes.includes(s));

            if (!hasAllScopes) {
              // Requested scopes exceed granted scopes
              consentRequired = true;
            }
          }
        }

        // Force consent if prompt=consent
        if (prompt?.includes('consent')) {
          consentRequired = true;
        }
      } catch (error) {
        console.error('Failed to check consent:', error);
        // On error, assume consent is required for safety
        consentRequired = true;
      }

      if (consentRequired) {
        // prompt=none requires consent but can't show UI
        if (prompt?.includes('none')) {
          return sendError('consent_required', 'User consent is required');
        }

        // Store authorization request parameters in ChallengeStore for consent flow
        const challengeId = crypto.randomUUID();
        const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
        const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

        await challengeStore.fetch(
          new Request('https://challenge-store/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: challengeId,
              type: 'consent',
              userId: sub,
              challenge: challengeId,
              ttl: 600, // 10 minutes
              metadata: {
                response_type,
                client_id,
                redirect_uri,
                scope,
                state,
                nonce,
                code_challenge,
                code_challenge_method,
                claims,
                response_mode,
                max_age,
                prompt,
                id_token_hint,
                acr_values,
                display,
                ui_locales,
                login_hint,
                sessionUserId: sub,
                authTime, // Preserve auth_time
                // Phase 2-B RBAC extensions
                org_id,
                acting_as,
              },
            }),
          })
        );

        // Redirect to UI consent screen (if UI_URL is configured)
        const uiUrl = c.env.UI_URL;
        if (uiUrl) {
          return c.redirect(
            `${uiUrl}/consent?challenge_id=${encodeURIComponent(challengeId)}`,
            302
          );
        } else {
          // Fallback: redirect to local consent endpoint
          return c.redirect(`/auth/consent?challenge_id=${encodeURIComponent(challengeId)}`, 302);
        }
      }
    } // End of Third-Party Client consent check
  }

  // Record authentication time
  const currentAuthTime = authTime || Math.floor(Date.now() / 1000);
  console.log(
    '[AUTH] Final authTime for code:',
    authTime,
    '-> currentAuthTime:',
    currentAuthTime,
    'prompt:',
    prompt
  );

  // Handle acr_values parameter (Authentication Context Class Reference)
  let selectedAcr = sessionAcr;
  if (acr_values && !selectedAcr) {
    // Select first ACR value from the list
    // In production, this should match against supported ACR values
    const acrList = acr_values.split(' ');
    selectedAcr = acrList[0];
  }

  // Type narrowing: scope is guaranteed to be a string at this point
  const validScope: string = scope as string;

  // Type narrowing: response_type is guaranteed to be defined (validated earlier)
  const validResponseType: string = response_type!;

  // Parse response_type to determine what to return
  // Per OIDC Core 3.3: Hybrid Flow supports combinations of code, id_token, and token
  const responseTypes = validResponseType.split(' ');
  const includesCode = responseTypes.includes('code');
  const includesIdToken = responseTypes.includes('id_token');
  const includesToken = responseTypes.includes('token');

  // Extract and validate DPoP proof (if present) for authorization code binding
  let dpopJkt: string | undefined;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (dpopProof) {
    // Validate DPoP proof
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined, // No access token yet
      c.env.DPOP_JTI_STORE,
      validClientId
    );

    if (dpopValidation.valid && dpopValidation.jkt) {
      dpopJkt = dpopValidation.jkt; // Store JWK thumbprint for code binding
      console.log('[DPoP] Authorization code will be bound to DPoP key:', dpopJkt);
    } else {
      console.warn(
        '[DPoP] Invalid DPoP proof provided, continuing without binding:',
        dpopValidation.error_description
      );
      // Note: We don't fail the request if DPoP is invalid, just don't bind the code
      // This allows flexibility for clients that may have optional DPoP support
    }
  }

  // Generate authorization code if needed (for code flow and hybrid flows)
  let code: string | undefined;
  if (includesCode) {
    const randomCode = generateSecureRandomString(96); // ~128 base64url chars

    // Determine shard count from KV (dynamic) > environment > default
    // This ensures both op-auth and op-token use the same shard count
    const shardCount = await getShardCount(c.env);

    // Session→AuthCode Sticky Routing: Use session's shard index for AuthCode
    // This collocates Session and AuthCode on the same DO shard for locality,
    // reducing cross-POD latency by ~700-1500ms per request
    let authCodeStoreId: DurableObjectId;
    if (shardCount > 0) {
      // Prefer session-based shard routing for locality
      const parsedSession = sessionId ? parseShardedSessionId(sessionId) : null;
      const shardIndex = parsedSession
        ? parsedSession.shardIndex % shardCount // Session Sticky: same shard as session
        : getAuthCodeShardIndex(sub, validClientId, shardCount); // Fallback: hash-based
      code = createShardedAuthCode(shardIndex, randomCode);
      const instanceName = buildAuthCodeShardInstanceName(shardIndex);
      authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(instanceName);
    } else {
      // Sharding disabled - use legacy 'global' instance
      code = randomCode;
      authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName('global');
    }

    // Store authorization code using AuthorizationCodeStore Durable Object
    try {
      const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);

      const storeResponse = await authCodeStore.fetch(
        new Request('https://auth-code-store/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            clientId: validClientId,
            redirectUri: validRedirectUri,
            userId: sub,
            scope: validScope,
            codeChallenge: code_challenge,
            codeChallengeMethod: code_challenge_method,
            nonce,
            state,
            claims,
            authTime: currentAuthTime,
            acr: selectedAcr,
            dpopJkt, // Bind authorization code to DPoP key (RFC 9449)
            sid: sessionId, // OIDC Session Management: Session ID for RP-Initiated Logout
          }),
        })
      );

      if (!storeResponse.ok) {
        const errorData = await storeResponse.json();
        console.error('Failed to store authorization code:', errorData);
        return sendError('server_error', 'Failed to process authorization request');
      }
    } catch (error) {
      console.error('AuthCodeStore DO error:', error);
      return sendError('server_error', 'Failed to process authorization request');
    }
  }

  // Generate access token if needed (for implicit and hybrid flows)
  let accessToken: string | undefined;
  let accessTokenJti: string | undefined;
  if (includesToken) {
    try {
      // Get issuer from environment
      const issuer = c.env.ISSUER_URL;

      const { privateKey, kid: signingKeyId } = await getSigningKeyFromKeyManager(c.env);
      const tokenResult = await createAccessToken(
        {
          iss: issuer,
          sub,
          aud: issuer, // Access token audience should be issuer (resource server), not client_id
          scope: validScope,
          client_id: validClientId,
          claims,
        },
        privateKey,
        signingKeyId,
        3600 // 1 hour
      );

      accessToken = tokenResult.token;
      accessTokenJti = tokenResult.jti;

      console.log(
        `[HYBRID/IMPLICIT] Generated access_token for sub=${sub}, client_id=${validClientId}`
      );
    } catch (error) {
      console.error('Failed to generate access token:', error);
      return sendError('server_error', 'Failed to generate access token');
    }
  }

  // Generate ID token if needed (for implicit and hybrid flows)
  let idToken: string | undefined;
  if (includesIdToken) {
    try {
      // Get issuer from environment
      const issuer = c.env.ISSUER_URL;

      const { privateKey, kid: signingKeyId } = await getSigningKeyFromKeyManager(c.env);

      // Calculate c_hash if code is present (for hybrid flows)
      // Per OIDC Core 3.3.2.11
      let cHash: string | undefined;
      if (code) {
        cHash = await calculateCHash(code, 'SHA-256');
      }

      // Calculate at_hash if access token is present
      // Per OIDC Core 3.2.2.9 and 3.3.2.11
      let atHash: string | undefined;
      if (accessToken) {
        atHash = await calculateAtHash(accessToken, 'SHA-256');
      }

      // Create ID token with appropriate claims
      // Build base claims for ID token
      // Note: sid (session ID) is required for RP-Initiated Logout per OIDC Session Management 1.0
      const idTokenClaims: Record<string, unknown> = {
        iss: issuer,
        sub,
        aud: validClientId,
        auth_time: currentAuthTime,
        nonce, // Include nonce (required for implicit/hybrid flows)
        c_hash: cHash,
        at_hash: atHash,
        ...(sessionId && { sid: sessionId }), // OIDC Session Management: Session ID for RP-Initiated Logout
      };

      // Add acr claim if acr_values was requested (OIDC Core 2: SHOULD return acr)
      if (selectedAcr) {
        idTokenClaims.acr = selectedAcr;
      }

      // OIDC Core 5.4: For response_type=id_token (no access token), scope-based claims
      // must be included in the ID token since UserInfo endpoint is not accessible
      // Also include essential claims from claims parameter
      const isIdTokenOnly = includesIdToken && !includesToken && !includesCode;
      const scopes = validScope.split(' ');

      // Parse claims parameter for id_token essential claims
      let idTokenEssentialClaims: Record<string, { essential?: boolean; value?: unknown }> = {};
      if (claims) {
        try {
          const parsedClaims = JSON.parse(claims) as Record<string, unknown>;
          if (parsedClaims.id_token && typeof parsedClaims.id_token === 'object') {
            idTokenEssentialClaims = parsedClaims.id_token as Record<
              string,
              { essential?: boolean; value?: unknown }
            >;
          }
        } catch {
          // Ignore parsing errors, claims was already validated earlier
        }
      }

      // Check if we need to add scope-based or essential claims
      const hasEssentialClaims = Object.entries(idTokenEssentialClaims).some(
        ([, v]) => v?.essential === true
      );

      if (isIdTokenOnly || hasEssentialClaims) {
        // Fetch user data from database
        const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(sub).first();

        if (user) {
          // Parse address JSON if present
          let address = null;
          if (user.address_json) {
            try {
              address = JSON.parse(user.address_json as string);
            } catch {
              // Ignore address parsing errors
            }
          }

          // Map user data to OIDC claims
          const userData: Record<string, unknown> = {
            name: user.name || undefined,
            family_name: user.family_name || undefined,
            given_name: user.given_name || undefined,
            middle_name: user.middle_name || undefined,
            nickname: user.nickname || undefined,
            preferred_username: user.preferred_username || undefined,
            profile: user.profile || undefined,
            picture: user.picture || undefined,
            website: user.website || undefined,
            gender: user.gender || undefined,
            birthdate: user.birthdate || undefined,
            zoneinfo: user.zoneinfo || undefined,
            locale: user.locale || undefined,
            updated_at: user.updated_at
              ? (user.updated_at as number) >= 1e12
                ? Math.floor((user.updated_at as number) / 1000)
                : (user.updated_at as number)
              : Math.floor(Date.now() / 1000),
            email: user.email || undefined,
            email_verified: user.email_verified === 1,
            phone_number: user.phone_number || undefined,
            phone_number_verified: user.phone_number_verified === 1,
            address: address || undefined,
          };

          // Profile scope claims
          const profileClaims = [
            'name',
            'family_name',
            'given_name',
            'middle_name',
            'nickname',
            'preferred_username',
            'profile',
            'picture',
            'website',
            'gender',
            'birthdate',
            'zoneinfo',
            'locale',
            'updated_at',
          ];

          // Add scope-based claims for response_type=id_token
          if (isIdTokenOnly) {
            if (scopes.includes('profile')) {
              for (const claim of profileClaims) {
                if (userData[claim] !== undefined) {
                  idTokenClaims[claim] = userData[claim];
                }
              }
            }
            if (scopes.includes('email')) {
              if (userData.email !== undefined) idTokenClaims.email = userData.email;
              if (userData.email_verified !== undefined)
                idTokenClaims.email_verified = userData.email_verified;
            }
            if (scopes.includes('phone')) {
              if (userData.phone_number !== undefined)
                idTokenClaims.phone_number = userData.phone_number;
              if (userData.phone_number_verified !== undefined)
                idTokenClaims.phone_number_verified = userData.phone_number_verified;
            }
            if (scopes.includes('address') && userData.address !== undefined) {
              idTokenClaims.address = userData.address;
            }
          }

          // Add essential claims from claims parameter
          for (const [claimName, claimSpec] of Object.entries(idTokenEssentialClaims)) {
            if (claimSpec?.essential === true && userData[claimName] !== undefined) {
              idTokenClaims[claimName] = userData[claimName];
            }
          }
        }
      }

      idToken = await createIDToken(
        idTokenClaims as Parameters<typeof createIDToken>[0],
        privateKey,
        signingKeyId,
        3600 // 1 hour
      );

      console.log(
        `[HYBRID/IMPLICIT] Generated id_token for sub=${sub}, client_id=${validClientId}, c_hash=${cHash}, at_hash=${atHash}`
      );
    } catch (error) {
      console.error('Failed to generate ID token:', error);
      return sendError('server_error', 'Failed to generate ID token');
    }
  }

  // Determine response mode
  // Per OIDC Core 3.3.2.5: Default response_mode for hybrid flows is 'fragment'
  // For response_type=code only, default is 'query'
  let effectiveResponseMode = response_mode;
  if (!effectiveResponseMode) {
    if (includesIdToken || includesToken) {
      // Implicit or hybrid flow: default to fragment
      effectiveResponseMode = 'fragment';
    } else {
      // Pure code flow: default to query
      effectiveResponseMode = 'query';
    }
  }

  // Build response parameters
  const responseParams: Record<string, string> = {};
  if (code) responseParams.code = code;
  if (accessToken) responseParams.access_token = accessToken;
  if (accessToken) responseParams.token_type = 'Bearer';
  if (accessToken) responseParams.expires_in = '3600';
  if (idToken) responseParams.id_token = idToken;
  if (state) responseParams.state = state;
  // RFC 9207: Add iss parameter to prevent mix-up attacks
  responseParams.iss = c.env.ISSUER_URL;

  // OIDC Session Management 1.0: Add session_state parameter
  // https://openid.net/specs/openid-connect-session-1_0.html#CreatingUpdatingSessions
  if (sessionId && validRedirectUri) {
    try {
      const rpOrigin = extractOrigin(validRedirectUri);
      if (rpOrigin) {
        const sessionState = await calculateSessionState(validClientId, rpOrigin, sessionId);
        responseParams.session_state = sessionState;
      }
    } catch (error) {
      console.error('Failed to calculate session_state:', error);
      // Continue without session_state - it's optional
    }
  }

  // Check if JARM (JWT-secured Authorization Response Mode) is requested
  const isJARM = effectiveResponseMode.includes('.jwt') || effectiveResponseMode === 'jwt';

  if (isJARM) {
    // JARM: Create JWT-secured response
    // Determine base mode for JWT response
    let baseMode = effectiveResponseMode.replace('.jwt', '');
    if (effectiveResponseMode === 'jwt') {
      // Generic 'jwt' mode: use default based on flow
      baseMode = includesIdToken || includesToken ? 'fragment' : 'query';
    }

    return await createJARMResponse(c, validRedirectUri, responseParams, baseMode, validClientId);
  }

  // Handle response based on response_mode (traditional non-JWT modes)
  if (effectiveResponseMode === 'form_post') {
    // OAuth 2.0 Form Post Response Mode
    return createFormPostResponse(c, validRedirectUri, responseParams);
  } else if (effectiveResponseMode === 'fragment') {
    // Fragment encoding (for implicit and hybrid flows)
    return createFragmentResponse(c, validRedirectUri, responseParams);
  } else {
    // Query mode (for code-only flow)
    return createQueryResponse(c, validRedirectUri, responseParams);
  }
}

/**
 * Get signing key from KeyManager with caching
 * Performance optimization: Caches the imported CryptoKey to avoid expensive
 * RSA key import operation (5-7ms) on every request. Cache TTL is 60 seconds.
 */
async function getSigningKeyFromKeyManager(
  env: Env
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();

  // Check cache first (cache hit = avoid KeyManager DO call + RSA import)
  if (cachedSigningKey && now - cachedKeyTimestamp < KEY_CACHE_TTL) {
    return cachedSigningKey;
  }

  // Cache miss: fetch from KeyManager
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  if (!env.KEY_MANAGER_SECRET) {
    throw new Error('KEY_MANAGER_SECRET not configured');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  const authHeaders = {
    Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
  };

  const activeResponse = await keyManager.fetch('http://key-manager/internal/active-with-private', {
    method: 'GET',
    headers: authHeaders,
  });

  let keyData: { kid: string; privatePEM: string };

  if (activeResponse.ok) {
    const responseData = (await activeResponse.json()) as { kid: string; privatePEM: string };
    console.log('[getSigningKeyFromKeyManager] Active key response:', {
      hasKid: !!responseData.kid,
      hasPrivatePEM: !!responseData.privatePEM,
      pemLength: responseData.privatePEM?.length,
      pemStart: responseData.privatePEM?.substring(0, 50),
      keys: Object.keys(responseData),
    });
    keyData = responseData;
  } else {
    console.log('[getSigningKeyFromKeyManager] No active key, rotating...');
    const rotateResponse = await keyManager.fetch('http://key-manager/internal/rotate', {
      method: 'POST',
      headers: authHeaders,
    });

    if (!rotateResponse.ok) {
      const errorText = await rotateResponse.text();
      throw new Error(`Failed to rotate signing key: ${rotateResponse.status} ${errorText}`);
    }

    const rotateData = (await rotateResponse.json()) as {
      success: boolean;
      key: { kid: string; privatePEM: string };
    };
    console.log('[getSigningKeyFromKeyManager] Rotated key:', {
      hasKid: !!rotateData.key?.kid,
      hasPrivatePEM: !!rotateData.key?.privatePEM,
      pemLength: rotateData.key?.privatePEM?.length,
      pemStart: rotateData.key?.privatePEM?.substring(0, 50),
      keys: Object.keys(rotateData.key || {}),
    });
    keyData = rotateData.key;
  }

  // Validate keyData before using it
  if (!keyData) {
    throw new Error('Failed to retrieve signing key: keyData is undefined');
  }

  if (!keyData.kid) {
    throw new Error('Failed to retrieve signing key: kid is missing');
  }

  if (!keyData.privatePEM) {
    throw new Error('Failed to retrieve signing key: privatePEM is missing');
  }

  if (typeof keyData.privatePEM !== 'string' || keyData.privatePEM.length === 0) {
    throw new Error(
      `Failed to retrieve signing key: privatePEM is invalid (type: ${typeof keyData.privatePEM}, length: ${keyData.privatePEM?.length})`
    );
  }

  console.log('[getSigningKeyFromKeyManager] About to import PKCS8:', {
    kid: keyData.kid,
    pemLength: keyData.privatePEM.length,
    pemStart: keyData.privatePEM.substring(0, 50),
  });

  // Import private key (expensive operation: 5-7ms)
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // Update cache
  cachedSigningKey = { privateKey, kid: keyData.kid };
  cachedKeyTimestamp = now;

  return { privateKey, kid: keyData.kid };
}

/**
 * Helper function to redirect with OAuth error parameters
 * https://tools.ietf.org/html/rfc6749#section-4.1.2.1
 */
interface ErrorRedirectOptions {
  responseMode?: string;
  responseType?: string | null;
  clientId?: string;
}

async function redirectWithError(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  error: string,
  errorDescription?: string,
  state?: string,
  options?: ErrorRedirectOptions
): Promise<Response> {
  const params: Record<string, string> = { error };
  if (errorDescription) {
    params.error_description = errorDescription;
  }
  if (state) {
    params.state = state;
  }

  const parsedResponseType = options?.responseType?.split(' ') ?? [];
  const isImplicitOrHybrid = parsedResponseType.some((t) => t === 'id_token' || t === 'token');

  let responseMode = options?.responseMode;
  let baseMode = responseMode;
  let isJARM = false;

  if (!responseMode || responseMode === '') {
    baseMode = isImplicitOrHybrid ? 'fragment' : 'query';
    responseMode = baseMode;
  } else if (responseMode === 'jwt') {
    baseMode = isImplicitOrHybrid ? 'fragment' : 'query';
    isJARM = true;
  } else if (responseMode.endsWith('.jwt')) {
    baseMode = responseMode.replace('.jwt', '');
    isJARM = true;
  } else {
    baseMode = responseMode;
  }

  if (isJARM) {
    if (options?.clientId) {
      return await createJARMResponse(
        c,
        redirectUri,
        params,
        baseMode || 'query',
        options.clientId
      );
    }
    console.warn(
      'JARM error response requested but client_id unavailable; falling back to base mode'
    );
  }

  switch (baseMode) {
    case 'form_post':
      return createFormPostResponse(c, redirectUri, params);
    case 'fragment':
      return createFragmentResponse(c, redirectUri, params);
    case 'query':
    default:
      return createQueryResponse(c, redirectUri, params);
  }
}

/**
 * Create Form Post Response
 * OAuth 2.0 Form Post Response Mode
 * https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html
 *
 * Returns an HTML page with an auto-submitting form that POSTs the
 * authorization response parameters to the client's redirect_uri
 */
/**
 * Create a query-encoded redirect response
 * Used for response_type=code (pure authorization code flow)
 */
function createQueryResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return c.redirect(url.toString(), 302);
}

/**
 * Create a fragment-encoded redirect response
 * Used for implicit and hybrid flows per OIDC Core 3.3.2.5
 */
function createFragmentResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>
): Response {
  const url = new URL(redirectUri);
  // Build fragment from parameters
  const fragmentParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    fragmentParams.set(key, value);
  }
  url.hash = fragmentParams.toString();
  return c.redirect(url.toString(), 302);
}

/**
 * Create a form_post response
 * Used when response_mode=form_post per OAuth 2.0 Form Post Response Mode
 */
function createFormPostResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>
): Response {
  // Generate nonce for CSP (Content Security Policy)
  const nonce = crypto.randomUUID();

  // Build form inputs from all parameters
  const inputs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    inputs.push(`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`);
  }

  // Generate HTML page with auto-submitting form
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization</title>
  <style nonce="${nonce}">
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      text-align: center;
      color: white;
    }
    .spinner {
      width: 50px;
      height: 50px;
      margin: 0 auto 20px;
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .message {
      font-size: 18px;
      margin-bottom: 10px;
    }
    .note {
      font-size: 14px;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p class="message">Redirecting to application...</p>
    <p class="note">Please wait</p>
  </div>
  <form id="auth-form" method="post" action="${escapeHtml(redirectUri)}">
    ${inputs.join('\n    ')}
  </form>
  <script nonce="${nonce}">
    // Auto-submit form immediately
    document.getElementById('auth-form').submit();
  </script>
</body>
</html>`;

  // Set CSP header with nonce to allow inline script and style
  return c.html(html, 200, {
    'Content-Security-Policy': `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}';`,
  });
}

/**
 * Create JARM (JWT-Secured Authorization Response Mode) response
 * https://openid.net/specs/oauth-v2-jarm.html
 *
 * @param c - Hono context
 * @param redirectUri - Client redirect URI
 * @param params - Authorization response parameters
 * @param baseMode - Base response mode (query, fragment, or form_post)
 * @param clientId - Client identifier
 * @returns Response with JWT-secured authorization response
 */
async function createJARMResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>,
  baseMode: string,
  clientId: string
): Promise<Response> {
  try {
    // Get client metadata to check for encryption requirements
    const client = await getClient(c.env, clientId);
    if (!client) {
      throw new Error('Client not found');
    }

    // Build JWT payload from response parameters
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: c.env.ISSUER_URL, // Issuer
      aud: clientId, // Audience (client_id)
      exp: now + 600, // Expires in 10 minutes
      iat: now, // Issued at
      ...params, // Include all response parameters
    };

    // Get server's signing key
    const privateKeyPem = c.env.PRIVATE_KEY_PEM;
    if (!privateKeyPem) {
      throw new Error('Server private key not configured');
    }

    const privateKey = await importPKCS8(privateKeyPem, 'RS256');

    // Get key ID from KV or use default
    let kid = 'default';
    try {
      if (c.env.KV) {
        const signingKey = (await c.env.KV.get('keys:signing', 'json')) as { kid: string } | null;
        if (signingKey?.kid) {
          kid = signingKey.kid;
        }
      }
    } catch (error) {
      console.warn('Failed to get signing key ID, using default:', error);
    }

    // Sign the JWT
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .sign(privateKey);

    let responseToken = jwt;

    // Check if client requested encryption
    if (
      client.authorization_encrypted_response_alg &&
      client.authorization_encrypted_response_enc
    ) {
      // Encrypt the JWT using client's public key
      let clientPublicKeyJWK: any;

      if (
        client.jwks &&
        typeof client.jwks === 'object' &&
        client.jwks !== null &&
        'keys' in client.jwks &&
        Array.isArray(client.jwks.keys)
      ) {
        // Find encryption key
        const encKey = (client.jwks.keys as any[]).find((key: any) => {
          return key.use === 'enc' || !key.use;
        });

        if (!encKey) {
          throw new Error('No suitable encryption key found in client jwks');
        }

        clientPublicKeyJWK = encKey;
      } else if (client.jwks_uri && typeof client.jwks_uri === 'string') {
        // Fetch JWKS from jwks_uri
        const jwksResponse = await fetch(client.jwks_uri);
        if (!jwksResponse.ok) {
          throw new Error('Failed to fetch client jwks_uri');
        }

        const jwks = (await jwksResponse.json()) as { keys: any[] };
        const encKey = jwks.keys.find((key: any) => {
          return key.use === 'enc' || !key.use;
        });

        if (!encKey) {
          throw new Error('No suitable encryption key found in client jwks_uri');
        }

        clientPublicKeyJWK = encKey;
      } else {
        throw new Error('Client requested encryption but no public key available');
      }

      // Encrypt the signed JWT (using jwe.ts encryptJWT)
      responseToken = await encryptJWT(
        jwt, // The signed JWT string
        clientPublicKeyJWK, // JWK format
        {
          alg: client.authorization_encrypted_response_alg as any,
          enc: client.authorization_encrypted_response_enc as any,
          cty: 'JWT',
        }
      );
    }

    // Build response with single 'response' parameter containing the JWT
    const jarmParams: Record<string, string> = {
      response: responseToken,
    };

    // Send response using base mode
    if (baseMode === 'form_post') {
      return createFormPostResponse(c, redirectUri, jarmParams);
    } else if (baseMode === 'fragment') {
      return createFragmentResponse(c, redirectUri, jarmParams);
    } else {
      return createQueryResponse(c, redirectUri, jarmParams);
    }
  } catch (error) {
    console.error('Failed to create JARM response:', error);
    // Fall back to error redirect
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create JWT-secured authorization response',
      },
      500
    );
  }
}

/**
 * Escape HTML special characters to prevent XSS
 * Essential for safely embedding user-provided values in HTML
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Handle login screen
 * GET/POST /authorize/login
 *
 * Shows a simple login form (username + password) for testing.
 * In production, this would redirect to UI_URL/login or show a proper login UI.
 */
export async function authorizeLoginHandler(c: Context<{ Bindings: Env }>) {
  // Parse challenge_id from request
  let challenge_id: string | undefined;

  if (c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      challenge_id = typeof body.challenge_id === 'string' ? body.challenge_id : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    challenge_id = c.req.query('challenge_id');
  }

  if (!challenge_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing challenge_id parameter',
      },
      400
    );
  }

  // GET request: Show login form (stub implementation with username/password fields)
  if (c.req.method === 'GET') {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Required</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 400px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #333;
    }
    p {
      margin: 0 0 1.5rem 0;
      color: #666;
      line-height: 1.5;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    input {
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
    }
    button {
      padding: 0.75rem;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Login Required</h1>
    <p>Please enter your credentials to continue.</p>
    <form method="POST" action="/authorize/login">
      <input type="hidden" name="challenge_id" value="${challenge_id}">
      <input type="text" name="username" placeholder="Username" required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`);
  }

  // POST request: Process login (stub - accepts any credentials)
  const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
  const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

  const consumeResponse = await challengeStore.fetch(
    new Request('https://challenge-store/challenge/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: challenge_id,
        type: 'login',
        challenge: challenge_id,
      }),
    })
  );

  if (!consumeResponse.ok) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid or expired challenge',
      },
      400
    );
  }

  const challengeData = (await consumeResponse.json()) as {
    userId: string;
    metadata?: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      nonce?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      claims?: string;
      response_mode?: string;
      [key: string]: unknown;
    };
  };

  const metadata = challengeData.metadata || {};

  // Determine if this is an OIDC Conformance Test client
  const client_id = metadata.client_id as string | undefined;
  let isCertificationTest = false;

  if (client_id) {
    const clientMetadata = await getClient(c.env, client_id);
    if (clientMetadata?.redirect_uris && Array.isArray(clientMetadata.redirect_uris)) {
      isCertificationTest = (clientMetadata.redirect_uris as string[]).some((uri: string) =>
        uri.includes('certification.openid.net')
      );
    }
  }

  // Create a new user and session (stub - in production, verify credentials first)
  let userId: string;

  if (isCertificationTest) {
    // Use fixed test user for OIDC Conformance Tests
    userId = 'user-oidc-conformance-test';
    console.log('[LOGIN] Using OIDC Conformance Test user');

    // Verify test user exists (should have been created during DCR)
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!existingUser) {
      console.warn('[LOGIN] Test user not found, creating it now');
      // Create test user if it doesn't exist (fallback)
      const now = Math.floor(Date.now() / 1000);
      await c.env.DB.prepare(
        `
        INSERT INTO users (
          id, email, email_verified, name, given_name, family_name,
          middle_name, nickname, preferred_username, profile, picture,
          website, gender, birthdate, zoneinfo, locale,
          phone_number, phone_number_verified, address_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          userId,
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
          now,
          now
        )
        .run()
        .catch((error: unknown) => {
          console.error('Failed to create test user:', error);
        });
    }
  } else {
    // Normal client: create new random user
    userId = 'user-' + crypto.randomUUID();

    // Create user in database
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        `${userId}@example.com`, // Placeholder email
        0, // email not verified
        now,
        now
      )
      .run()
      .catch((error: unknown) => {
        console.error('Failed to create user:', error);
      });
  }

  // Create session using sharded SessionStore
  const { stub: sessionStore, sessionId: newSessionId } = await getSessionStoreForNewSession(c.env);

  // Calculate auth_time BEFORE creating session to ensure consistency
  // This value will be used for both the session and the redirect parameter
  const loginAuthTime = Math.floor(Date.now() / 1000);

  const sessionResponse = await sessionStore.fetch(
    new Request('https://session-store/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: newSessionId, // Required: Sharded session ID
        userId,
        ttl: 3600, // 1 hour session
        data: {
          clientId: metadata.client_id,
          authTime: loginAuthTime, // Store auth_time for OIDC conformance (prompt=none consistency)
        },
      }),
    })
  );

  if (sessionResponse.ok) {
    // Set session cookie with the pre-generated sharded session ID
    c.header(
      'Set-Cookie',
      `authrim_session=${newSessionId}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=3600`
    );
  }

  // Build query string for internal redirect to /authorize
  const params = new URLSearchParams();
  if (metadata.response_type) params.set('response_type', metadata.response_type as string);
  if (metadata.client_id) params.set('client_id', metadata.client_id as string);
  if (metadata.redirect_uri) params.set('redirect_uri', metadata.redirect_uri as string);
  if (metadata.scope) params.set('scope', metadata.scope as string);
  if (metadata.state) params.set('state', metadata.state as string);
  if (metadata.nonce) params.set('nonce', metadata.nonce as string);
  if (metadata.code_challenge) params.set('code_challenge', metadata.code_challenge as string);
  if (metadata.code_challenge_method)
    params.set('code_challenge_method', metadata.code_challenge_method as string);
  if (metadata.claims) params.set('claims', metadata.claims as string);
  if (metadata.response_mode) params.set('response_mode', metadata.response_mode as string);
  if (metadata.max_age) params.set('max_age', metadata.max_age as string);
  if (metadata.prompt) params.set('prompt', metadata.prompt as string);
  if (metadata.acr_values) params.set('acr_values', metadata.acr_values as string);

  // Add a flag to indicate login is complete
  params.set('_confirmed', 'true');

  // Pass auth_time to ensure consistency between initial login and prompt=none requests
  // This is critical for OIDC conformance: auth_time in ID tokens must be identical
  // when the user is authenticated once and then prompt=none is used
  // Use the same loginAuthTime that was stored in the session
  params.set('_auth_time', loginAuthTime.toString());
  console.log('[LOGIN] Setting auth_time for authorization redirect:', loginAuthTime);

  // Redirect to /authorize with original parameters
  const redirectUrl = `/authorize?${params.toString()}`;
  return c.redirect(redirectUrl, 302);
}

/**
 * Handle re-authentication confirmation
 * POST /authorize/confirm
 */
export async function authorizeConfirmHandler(c: Context<{ Bindings: Env }>) {
  // Parse challenge_id from request
  let challenge_id: string | undefined;

  if (c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      challenge_id = typeof body.challenge_id === 'string' ? body.challenge_id : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    challenge_id = c.req.query('challenge_id');
  }

  if (!challenge_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing challenge_id parameter',
      },
      400
    );
  }

  // GET request: Show re-authentication confirmation form with username/password
  if (c.req.method === 'GET') {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Re-authentication Required</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 400px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #333;
    }
    p {
      margin: 0 0 1.5rem 0;
      color: #666;
      line-height: 1.5;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    input {
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Re-authentication Required</h1>
    <p>For security reasons, please re-enter your credentials.</p>
    <form method="POST" action="/authorize/confirm">
      <input type="hidden" name="challenge_id" value="${challenge_id}">
      <input type="text" name="username" placeholder="Username" required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Confirm</button>
    </form>
  </div>
</body>
</html>`);
  }

  // POST request: Process confirmation and redirect to /authorize
  const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
  const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

  const consumeResponse = await challengeStore.fetch(
    new Request('https://challenge-store/challenge/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: challenge_id,
        type: 'reauth',
        challenge: challenge_id,
      }),
    })
  );

  if (!consumeResponse.ok) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid or expired challenge',
      },
      400
    );
  }

  const challengeData = (await consumeResponse.json()) as {
    userId: string;
    metadata?: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      nonce?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      claims?: string;
      response_mode?: string;
      sessionUserId?: string;
      [key: string]: unknown;
    };
  };

  const metadata = challengeData.metadata || {};

  // Build query string for internal redirect to /authorize
  const params = new URLSearchParams();
  if (metadata.response_type) params.set('response_type', metadata.response_type as string);
  if (metadata.client_id) params.set('client_id', metadata.client_id as string);
  if (metadata.redirect_uri) params.set('redirect_uri', metadata.redirect_uri as string);
  if (metadata.scope) params.set('scope', metadata.scope as string);
  if (metadata.state) params.set('state', metadata.state as string);
  if (metadata.nonce) params.set('nonce', metadata.nonce as string);
  if (metadata.code_challenge) params.set('code_challenge', metadata.code_challenge as string);
  if (metadata.code_challenge_method)
    params.set('code_challenge_method', metadata.code_challenge_method as string);
  if (metadata.claims) params.set('claims', metadata.claims as string);
  if (metadata.response_mode) params.set('response_mode', metadata.response_mode as string);
  if (metadata.max_age) params.set('max_age', metadata.max_age as string);
  if (metadata.prompt) {
    params.set('prompt', metadata.prompt as string);
    console.log('[AUTH] Passing prompt to confirmation redirect:', metadata.prompt);
  }
  if (metadata.acr_values) params.set('acr_values', metadata.acr_values as string);

  // Add a flag to indicate this is a re-authentication confirmation
  params.set('_confirmed', 'true');

  // Preserve original auth_time and sessionUserId for consistency
  if (metadata.authTime) {
    params.set('_auth_time', metadata.authTime.toString());
    console.log('[AUTH] Passing auth_time to confirmation redirect:', metadata.authTime);
  }
  if (metadata.sessionUserId) params.set('_session_user_id', metadata.sessionUserId as string);

  // Redirect to /authorize with original parameters
  const redirectUrl = `/authorize?${params.toString()}`;
  return c.redirect(redirectUrl, 302);
}

import type { Context } from 'hono';
import type { Env, ClientMetadata } from '@authrim/ar-lib-core';
import type { IntrospectionResponse } from '@authrim/ar-lib-core';
import {
  validateClientId,
  getRefreshToken,
  isTokenRevoked,
  parseToken,
  verifyToken,
  createAuthContextFromHono,
  getTenantIdFromContext,
  validateClientAssertion,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  // Event System
  publishEvent,
  TOKEN_EVENTS,
  type TokenEventData,
  // Shared utilities
  parseBasicAuth,
  getKeyByKid,
  verifyClientSecretHash,
  // Database adapter for user status check
  D1Adapter,
} from '@authrim/ar-lib-core';
import { importJWK, decodeProtectedHeader, type CryptoKey } from 'jose';
import { getIntrospectionValidationSettings } from './routes/settings/introspection-validation';
import { getIntrospectionCacheConfig } from './routes/settings/introspection-cache';

// Introspection Response Cache
// Key format: introspect_cache:{sha256(jti)}
// Only active=true responses are cached; revocation always checked fresh
const INTROSPECT_CACHE_KEY_PREFIX = 'introspect_cache:';

/**
 * Generate cache key for introspection response
 * Uses SHA-256 hash of JTI to prevent key enumeration attacks
 */
async function getIntrospectCacheKey(jti: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(jti);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${INTROSPECT_CACHE_KEY_PREFIX}${hashHex}`;
}

/**
 * Token Introspection Endpoint Handler
 * https://tools.ietf.org/html/rfc7662
 *
 * Allows authorized clients to query the authorization server about the state of a token
 */
export async function introspectHandler(c: Context<{ Bindings: Env }>) {
  // Verify Content-Type is application/x-www-form-urlencoded
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Parse form data
  let formData: Record<string, string>;
  try {
    const body = await c.req.parseBody();
    formData = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  const token = formData.token;
  const token_type_hint = formData.token_type_hint as 'access_token' | 'refresh_token' | undefined;

  // Extract client credentials from either form data or Authorization header
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // P0: Extract client_assertion for private_key_jwt authentication (RFC 7523)
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  // Check for HTTP Basic authentication (client_secret_basic)
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error !== 'missing_header' && basicAuth.error !== 'invalid_scheme') {
    // Basic auth was attempted but malformed
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Validate token parameter
  if (!token) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'token' },
    });
  }

  // Validate client_id (client authentication required for introspection)
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // RFC 7662 Section 2.1: The authorization server first validates the client credentials
  // Fetch client to verify client_secret via Repository
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const clientRecord = await authCtx.repositories.client.findByClientId(client_id);

  if (!clientRecord) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Cast to ClientMetadata for type safety
  const clientMetadata = clientRecord as unknown as ClientMetadata;

  // =========================================================================
  // Client Authentication (supports multiple methods)
  // Priority: private_key_jwt > client_secret_basic/post
  // RFC 7662: Client authentication is REQUIRED for introspection
  // =========================================================================

  // P0: private_key_jwt authentication (RFC 7523)
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${c.env.ISSUER_URL}/introspect`, // Introspection endpoint URL
      clientMetadata
    );

    if (!assertionValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
    // Authentication successful via private_key_jwt
  }
  // client_secret_basic or client_secret_post authentication
  else if (client_secret) {
    // Verify client_secret using timing-safe hash comparison to prevent timing attacks
    if (
      !clientMetadata.client_secret_hash ||
      !(await verifyClientSecretHash(client_secret, clientMetadata.client_secret_hash))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
    // Authentication successful via client_secret
  }
  // No valid authentication method provided
  else {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Parse token to extract claims (without verification yet)
  let tokenPayload;
  try {
    tokenPayload = parseToken(token);
  } catch {
    // If token format is invalid, return inactive response (per RFC 7662)
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  const jti = tokenPayload.jti as string;
  const sub = tokenPayload.sub as string;
  // RFC 7519: aud can be a string or array of strings
  const audRaw = tokenPayload.aud;
  const audArray = Array.isArray(audRaw) ? audRaw : audRaw ? [audRaw] : [];
  const aud = audArray[0] as string; // Primary audience for response
  const scope = tokenPayload.scope as string;
  const iss = tokenPayload.iss as string;
  const exp = tokenPayload.exp as number;
  const iat = tokenPayload.iat as number;
  // RFC 7519: nbf (not before) claim - token SHOULD NOT be valid before this time
  const nbf = tokenPayload.nbf as number | undefined;
  const tokenClientId = tokenPayload.client_id as string;
  // V2: Extract version for refresh token validation
  const rtv = typeof tokenPayload.rtv === 'number' ? tokenPayload.rtv : 1;
  // RFC 8693: Actor claim for delegation (Token Exchange)
  const act = tokenPayload.act as IntrospectionResponse['act'];
  // RFC 8693: Resource server URI (Token Exchange)
  const resource = tokenPayload.resource as string | undefined;
  // P1: RFC 9449: DPoP confirmation claim (cnf.jkt)
  const cnf = tokenPayload.cnf as { jkt: string } | undefined;
  // P2: RFC 7662 recommends including username for human-readable identifier
  // Use preferred_username from token if available, otherwise use sub
  const username = (tokenPayload.preferred_username as string) || sub;
  // RFC 9396: Rich Authorization Requests
  const authorizationDetails = tokenPayload.authorization_details as
    | IntrospectionResponse['authorization_details']
    | undefined;

  // ========== Introspection Response Cache Check ==========
  // Cache lookup is performed early to skip expensive operations (JWKS, signature verification)
  // Security: Even on cache hit, revocation status is always checked fresh
  const cacheConfig = await getIntrospectionCacheConfig(c.env);
  let cacheKey: string | null = null;

  if (cacheConfig.enabled && jti && c.env.AUTHRIM_CONFIG) {
    cacheKey = await getIntrospectCacheKey(jti);

    try {
      const cachedResponse = await c.env.AUTHRIM_CONFIG.get<IntrospectionResponse>(cacheKey, {
        type: 'json',
      });

      if (cachedResponse && cachedResponse.active === true) {
        // Cache hit! But still verify revocation status for security
        // This ensures revoked tokens are immediately detected
        const now = Math.floor(Date.now() / 1000);

        // Check expiration (token may have expired since cached)
        if (cachedResponse.exp && cachedResponse.exp < now) {
          // Token expired, delete from cache and return inactive
          c.env.AUTHRIM_CONFIG.delete(cacheKey).catch(() => {});
          return c.json<IntrospectionResponse>({ active: false });
        }

        // Check revocation (always fresh check for security)
        if (token_type_hint === 'refresh_token') {
          if (sub) {
            const refreshTokenData = await getRefreshToken(c.env, sub, rtv, tokenClientId, jti);
            if (!refreshTokenData) {
              c.env.AUTHRIM_CONFIG.delete(cacheKey).catch(() => {});
              return c.json<IntrospectionResponse>({ active: false });
            }
          }
        } else {
          const revoked = await isTokenRevoked(c.env, jti);
          if (revoked) {
            c.env.AUTHRIM_CONFIG.delete(cacheKey).catch(() => {});
            return c.json<IntrospectionResponse>({ active: false });
          }
        }

        // Token is still valid, return cached response
        return c.json(cachedResponse);
      }
    } catch {
      // Cache read failed, continue with full validation
    }
  }
  // ========== Introspection Response Cache Check END ==========

  // Load public key for verification
  // Strategy: Try to match kid from token header with JWKS first, fall back to PUBLIC_JWK_JSON
  let publicKey: CryptoKey | undefined;
  let tokenKid: string | undefined;

  // Extract kid from token header
  try {
    const header = decodeProtectedHeader(token);
    tokenKid = header.kid;
  } catch {
    // If we can't decode the header, continue without kid matching
  }

  // Get matching key with hierarchical caching (memory → KV → DO → env)
  const log = getLogger(c).module('INTROSPECT');
  const matchingKey = await getKeyByKid(c.env, tokenKid);
  if (matchingKey) {
    try {
      publicKey = (await importJWK(matchingKey, 'RS256')) as CryptoKey;
    } catch (err) {
      log.error('Failed to import public key', { action: 'introspect' }, err as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  } else {
    log.error('No matching key found for token verification', { action: 'introspect' });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify token signature
  try {
    // Determine expected audience based on token content
    // For access tokens, aud should be the issuer URL
    // For refresh tokens, aud should be the client_id
    // Use the actual aud from the token to determine verification strategy
    const expectedAud = aud;
    // RFC 7662: Use server's configured ISSUER_URL for issuer validation
    // This prevents accepting tokens from other issuers even if signed with the same key
    const expectedIssuer = c.env.ISSUER_URL;
    if (!expectedIssuer) {
      log.error('ISSUER_URL not configured', { action: 'introspect' });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    await verifyToken(token, publicKey, expectedIssuer, { audience: expectedAud });
  } catch (error) {
    log.error('Token verification failed', { action: 'introspect' }, error as Error);
    // Token signature verification failed, return inactive
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // ========== Strict Validation Mode (KV-controlled) ==========
  // RFC 7662 does not require aud/client_id validation, but strictValidation
  // enables additional security checks for Token Introspection Control Plane Test
  const { settings: validationSettings } = await getIntrospectionValidationSettings(c.env);

  if (validationSettings.strictValidation) {
    // 1. Audience validation (RFC 7519: aud can be array)
    const expectedAudience = validationSettings.expectedAudience || c.env.ISSUER_URL || '';
    if (expectedAudience && !audArray.includes(expectedAudience)) {
      // Token audience does not match expected audience
      return c.json<IntrospectionResponse>({
        active: false,
      });
    }

    // 2. Client ID existence validation via Repository
    // Optimization: Skip D1 query if tokenClientId matches the already-authenticated client_id
    // (client_id was already verified in the client authentication step above)
    if (tokenClientId && tokenClientId !== client_id) {
      const clientExists = await authCtx.repositories.client.findByClientId(tokenClientId);

      if (!clientExists) {
        // Client ID in token does not exist in database
        return c.json<IntrospectionResponse>({
          active: false,
        });
      }
    }
  }
  // ========== Strict Validation Mode END ==========

  // Check token timing constraints
  const now = Math.floor(Date.now() / 1000);

  // RFC 7519: Check nbf (not before) - token is not valid before this time
  if (nbf && nbf > now) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // Check if token is expired
  if (exp && exp < now) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // ========== Token Revocation/Existence Check ==========
  // Logic depends on token_type_hint:
  // - 'access_token': Check access token revocation store only
  // - 'refresh_token': Check refresh token existence in DO only
  // - undefined: Default to access token behavior (most common use case)
  //
  // Note: Without a hint, we cannot reliably determine token type.
  // RFC 7662 Section 2.1 recommends clients provide token_type_hint for optimal handling.
  // Defaulting to access token revocation check is the safest approach.

  if (jti) {
    if (token_type_hint === 'refresh_token') {
      // Explicitly refresh token - check existence in DO
      if (sub) {
        const refreshTokenData = await getRefreshToken(c.env, sub, rtv, tokenClientId, jti);
        if (!refreshTokenData) {
          return c.json<IntrospectionResponse>({
            active: false,
          });
        }
      }
    } else {
      // Access token (explicit or default) - check revocation store
      const revoked = await isTokenRevoked(c.env, jti);
      if (revoked) {
        return c.json<IntrospectionResponse>({
          active: false,
        });
      }
    }
  }
  // ========== Token Revocation/Existence Check END ==========

  // ========== User Status Check (suspended/locked users) ==========
  // RFC 7009: Tokens for suspended/locked users should be inactive
  // This ensures access tokens are immediately invalidated when a user is suspended
  // Note: Using users_core for PII-separated architecture
  if (sub) {
    try {
      const adapter = new D1Adapter({ db: c.env.DB });
      const user = await adapter.queryOne<{ status: string }>(
        'SELECT status FROM users_core WHERE id = ? AND tenant_id = ?',
        [sub, tenantId]
      );
      // Return inactive if user is suspended or locked
      if (user && (user.status === 'suspended' || user.status === 'locked')) {
        return c.json<IntrospectionResponse>({
          active: false,
        });
      }
    } catch {
      // Non-blocking: If status check fails, continue with token validation
      // This ensures introspection doesn't fail if DB is temporarily unavailable
    }
  }
  // ========== User Status Check END ==========

  // Token is active, return introspection response
  // P1: Determine token_type based on cnf claim presence (RFC 9449)
  const tokenType: 'Bearer' | 'DPoP' = cnf ? 'DPoP' : 'Bearer';

  const response: IntrospectionResponse = {
    active: true,
    scope,
    client_id: tokenClientId,
    // P2: RFC 7662 recommends including username
    username,
    // P1: RFC 9449 - DPoP-bound tokens have token_type "DPoP"
    token_type: tokenType,
    exp,
    iat,
    // RFC 7519: Include nbf if present
    ...(nbf !== undefined && { nbf }),
    sub,
    aud,
    iss,
    jti,
    // P1: RFC 9449 - Include cnf claim for DPoP-bound tokens
    ...(cnf && { cnf }),
    // RFC 8693: Include actor claim if present (for Token Exchange delegated tokens)
    ...(act && { act }),
    // RFC 8693: Include resource if present (for Token Exchange with resource parameter)
    ...(resource && { resource }),
    // RFC 9396: Include authorization_details if present (RAR)
    ...(authorizationDetails && { authorization_details: authorizationDetails }),
  };

  // ========== Cache active=true Response ==========
  // Store validated response in cache for future requests
  // Cache TTL is configured via Admin API or environment variables
  if (cacheConfig.enabled && cacheKey && c.env.AUTHRIM_CONFIG) {
    // Fire-and-forget cache write (non-blocking)
    c.env.AUTHRIM_CONFIG.put(cacheKey, JSON.stringify(response), {
      expirationTtl: cacheConfig.ttlSeconds,
    }).catch(() => {
      // Ignore cache write errors - not critical
    });
  }
  // ========== Cache active=true Response END ==========

  // Publish introspection event (non-blocking)
  // Only for active tokens - inactive responses don't need events
  publishEvent(c, {
    type: TOKEN_EVENTS.ACCESS_INTROSPECTED,
    tenantId,
    data: {
      jti,
      clientId: client_id, // Requesting client (not token's client_id)
      userId: sub || undefined,
      scopes: scope ? scope.split(' ') : undefined,
    } satisfies TokenEventData,
  }).catch((err: unknown) => {
    log.error(
      'Failed to publish token.access.introspected event',
      { action: 'publish_event' },
      err as Error
    );
  });

  return c.json(response);
}

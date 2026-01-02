import type { Context } from 'hono';
import type { Env, ClientMetadata } from '@authrim/ar-lib-core';
import {
  validateClientId,
  timingSafeEqual,
  deleteRefreshToken,
  getRefreshToken,
  revokeToken,
  parseToken,
  verifyToken,
  createAuthContextFromHono,
  getTenantIdFromContext,
  validateClientAssertion,
  createOAuthConfigManager,
  createErrorResponse,
  AR_ERROR_CODES,
  // Event System
  publishEvent,
  TOKEN_EVENTS,
  type TokenEventData,
  type BatchRevokeEventData,
  // Shared utilities
  parseBasicAuth,
  getKeyByKid,
} from '@authrim/ar-lib-core';
import { importJWK, decodeProtectedHeader, type CryptoKey } from 'jose';

/**
 * Token Revocation Endpoint Handler
 * https://tools.ietf.org/html/rfc7009
 *
 * Allows clients to notify the authorization server that a token is no longer needed
 */
export async function revokeHandler(c: Context<{ Bindings: Env }>) {
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

  // Validate client_id (client authentication required for revocation)
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // RFC 7009 Section 2.1: The authorization server first validates the client credentials
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
  // Priority: private_key_jwt > client_secret_basic/post > public client
  // =========================================================================
  let clientAuthenticated = false;

  // P0: private_key_jwt authentication (RFC 7523)
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${c.env.ISSUER_URL}/revoke`, // Revocation endpoint URL
      clientMetadata
    );

    if (!assertionValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
    clientAuthenticated = true;
  }
  // client_secret_basic or client_secret_post authentication
  else if (clientMetadata.client_secret && client_secret) {
    // Verify client_secret using timing-safe comparison to prevent timing attacks
    if (timingSafeEqual(clientMetadata.client_secret, client_secret)) {
      clientAuthenticated = true;
    } else {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
  }
  // P2: Public client - no client_secret required
  // RFC 7009: Public clients can revoke their own tokens
  else if (!clientMetadata.client_secret) {
    // Public client - will verify token ownership later
    clientAuthenticated = true;
  }
  // Confidential client without proper authentication
  else {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Track if this is a public client for token ownership verification
  const isPublicClient = !clientMetadata.client_secret;

  // Parse token to extract claims (without verification yet)
  let tokenPayload;
  try {
    tokenPayload = parseToken(token);
  } catch (error) {
    // Per RFC 7009 Section 2.2: The authorization server responds with HTTP status code 200
    // if the token has been revoked successfully or if the client submitted an invalid token.
    // This is to prevent token scanning attacks.
    console.warn('Failed to parse token for revocation:', error);
    return c.body(null, 200);
  }

  const jti = tokenPayload.jti as string;
  const tokenClientId = tokenPayload.client_id as string;
  // V2: Extract userId and version for refresh token operations
  const userId = tokenPayload.sub as string;
  const version = typeof tokenPayload.rtv === 'number' ? tokenPayload.rtv : 1;
  // Extract audience for signature verification
  const aud = tokenPayload.aud as string;

  if (!jti) {
    // No JTI, cannot revoke - return success to prevent information disclosure
    return c.body(null, 200);
  }

  // ========== Signature Verification (Security Enhancement) ==========
  // Verify token signature to prevent forged token attacks
  // Without this, an attacker with valid client credentials could forge tokens
  // with arbitrary JTIs and revoke other clients' tokens

  // Load public key for verification
  let publicKey: CryptoKey | undefined;
  let tokenKid: string | undefined;

  // Extract kid from token header
  try {
    const header = decodeProtectedHeader(token);
    tokenKid = header.kid;
  } catch {
    // If we can't decode the header, token is invalid
    console.warn('Failed to decode token header for revocation');
    return c.body(null, 200);
  }

  // Get matching key from KeyManager DO (with hierarchical caching: memory → KV → DO → env)
  const matchingKey = await getKeyByKid(c.env, tokenKid);
  if (matchingKey) {
    try {
      publicKey = (await importJWK(matchingKey, 'RS256')) as CryptoKey;
    } catch (err) {
      console.error('Failed to import public key for revocation:', err);
      return c.body(null, 200);
    }
  } else {
    console.error('No matching key found for revocation');
    return c.body(null, 200);
  }

  // Verify token signature
  try {
    const expectedIssuer = c.env.ISSUER_URL;
    if (!expectedIssuer) {
      console.error('ISSUER_URL not configured for revocation');
      return c.body(null, 200);
    }
    // Use aud from token for audience verification
    await verifyToken(token, publicKey, expectedIssuer, { audience: aud });
  } catch (error) {
    // Token signature verification failed - could be forged token
    console.warn('Token signature verification failed for revocation:', error);
    return c.body(null, 200);
  }
  // ========== Signature Verification END ==========

  // Verify that the token belongs to the requesting client
  // This prevents clients from revoking each other's tokens
  if (tokenClientId !== client_id) {
    console.warn(`Client ${client_id} attempted to revoke token belonging to ${tokenClientId}`);
    // Per RFC 7009: Return success even if client doesn't own the token
    return c.body(null, 200);
  }

  // =========================================================================
  // Token Revocation with Cascade Support (RFC 7009 Section 2.1)
  // When revoking refresh_token, SHOULD revoke related access tokens
  // =========================================================================
  // P4: Use ConfigManager for TOKEN_EXPIRY (KV → env → default)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getNumber('TOKEN_EXPIRY');

  // P1: Helper function for cascade revocation
  const performCascadeRevocation = async (refreshTokenJti: string, familyId?: string) => {
    // RFC 7009: When revoking refresh_token, SHOULD revoke related access tokens
    // Strategy: Revoke the refresh token JTI in access token revocation store as well
    // This ensures any access token with the same JTI pattern is invalidated
    try {
      // Also add the refresh token to the access token revocation list
      // This handles cases where access tokens might share JTI prefix with refresh tokens
      await revokeToken(c.env, refreshTokenJti, expiresIn);

      // Log cascade revocation for audit
      console.log(
        `[REVOKE] Cascade revocation triggered: refresh_token=${refreshTokenJti}, ` +
          `client=${tokenClientId}, user=${userId || 'unknown'}, family=${familyId || 'unknown'}`
      );
    } catch (error) {
      // Don't fail the main revocation if cascade fails
      console.error('[REVOKE] Cascade revocation failed:', error);
    }
  };

  // Determine token type and revoke accordingly
  let revokedTokenType: 'access_token' | 'refresh_token' = 'access_token';

  if (token_type_hint === 'refresh_token') {
    // Revoke refresh token
    await deleteRefreshToken(c.env, jti, tokenClientId);
    // P1: Cascade - also revoke related access tokens
    await performCascadeRevocation(jti);
    revokedTokenType = 'refresh_token';
  } else if (token_type_hint === 'access_token') {
    // Revoke access token
    await revokeToken(c.env, jti, expiresIn);
    revokedTokenType = 'access_token';
  } else {
    // No hint provided, try both types
    // First, check if it's a refresh token (V2 API)
    const refreshTokenData = userId
      ? await getRefreshToken(c.env, userId, version, tokenClientId, jti)
      : null;
    if (refreshTokenData) {
      // It's a refresh token
      await deleteRefreshToken(c.env, jti, tokenClientId);
      // P1: Cascade - also revoke related access tokens
      const familyId = refreshTokenData.familyId;
      await performCascadeRevocation(jti, familyId);
      revokedTokenType = 'refresh_token';
    } else {
      // Assume it's an access token
      await revokeToken(c.env, jti, expiresIn);
      revokedTokenType = 'access_token';
    }
  }

  // Publish token revocation event (non-blocking)
  const eventType =
    revokedTokenType === 'refresh_token'
      ? TOKEN_EVENTS.REFRESH_REVOKED
      : TOKEN_EVENTS.ACCESS_REVOKED;
  publishEvent(c, {
    type: eventType,
    tenantId,
    data: {
      jti,
      clientId: client_id,
      userId: userId || undefined,
      grantType: 'revocation', // RFC 7009 revocation
    } satisfies TokenEventData,
  }).catch((err: unknown) => {
    console.error(`[Event] Failed to publish ${eventType}:`, err);
  });

  // Audit log for security monitoring
  console.log(
    `[REVOKE] Token revoked: jti=${jti}, type=${token_type_hint || 'auto'}, ` +
      `client=${client_id}, user=${userId || 'unknown'}, isPublicClient=${isPublicClient}`
  );

  // Per RFC 7009 Section 2.2: The authorization server responds with HTTP status code 200
  // The content of the response body is ignored by the client
  return c.body(null, 200);
}

// =============================================================================
// Batch Revocation Types
// =============================================================================

interface BatchRevokeTokenItem {
  token: string;
  token_type_hint?: 'access_token' | 'refresh_token';
}

interface BatchRevokeRequest {
  tokens: BatchRevokeTokenItem[];
}

interface BatchRevokeResultItem {
  token_hint: string;
  status: 'revoked' | 'invalid';
}

interface BatchRevokeResponse {
  results: BatchRevokeResultItem[];
  summary: {
    total: number;
    revoked: number;
    invalid: number;
  };
}

// Default maximum tokens per batch request (KV configurable)
const DEFAULT_BATCH_REVOKE_MAX_TOKENS = 100;

/**
 * Batch Token Revocation Handler
 *
 * Extension of RFC 7009 for batch operations.
 * Allows revoking multiple tokens in a single request.
 *
 * Security:
 * - Client authentication required (same as single revoke)
 * - Only tokens owned by the authenticated client can be revoked
 * - Invalid/forged tokens return "invalid" status (no information disclosure)
 */
export async function batchRevokeHandler(c: Context<{ Bindings: Env }>) {
  // Verify Content-Type is application/json
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/json')) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Parse JSON body
  let body: BatchRevokeRequest;
  try {
    body = (await c.req.json()) as BatchRevokeRequest;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Validate tokens array
  if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tokens' },
    });
  }

  // Get max tokens limit from KV (with fallback to default)
  // KV key: batch_revoke_max_tokens
  let maxTokens = DEFAULT_BATCH_REVOKE_MAX_TOKENS;
  try {
    const kvValue = await c.env.KV?.get('batch_revoke_max_tokens');
    if (kvValue) {
      const parsed = parseInt(kvValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        maxTokens = parsed;
      }
    }
  } catch {
    // Use default if KV fails
  }

  if (body.tokens.length > maxTokens) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Validate each token item
  for (let i = 0; i < body.tokens.length; i++) {
    const item = body.tokens[i];
    if (!item.token || typeof item.token !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    if (
      item.token_type_hint &&
      item.token_type_hint !== 'access_token' &&
      item.token_type_hint !== 'refresh_token'
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
  }

  // =========================================================================
  // Client Authentication (same as single revoke)
  // =========================================================================

  // Extract client credentials from Authorization header
  let client_id: string | undefined;
  let client_secret: string | undefined;

  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    client_id = basicAuth.credentials.username;
    client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    // Support Bearer token for admin API access (not RFC 7009 standard)
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Validate client_id
  if (!client_id) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Fetch and verify client
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const clientRecord = await authCtx.repositories.client.findByClientId(client_id);

  if (!clientRecord) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  const clientMetadata = clientRecord as unknown as ClientMetadata;

  // Verify client_secret for confidential clients
  if (clientMetadata.client_secret) {
    if (!client_secret || !timingSafeEqual(clientMetadata.client_secret, client_secret)) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
  }

  // =========================================================================
  // Batch Revocation Processing
  // =========================================================================

  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getNumber('TOKEN_EXPIRY');

  // Process all tokens in parallel
  const results = await Promise.allSettled(
    body.tokens.map(async (item): Promise<BatchRevokeResultItem> => {
      const tokenHint =
        item.token.length > 16
          ? `${item.token.substring(0, 8)}...${item.token.substring(item.token.length - 4)}`
          : '***';

      try {
        // Parse token to extract claims
        const tokenPayload = parseToken(item.token);
        const jti = tokenPayload.jti as string;
        const tokenClientId = tokenPayload.client_id as string;
        const userId = tokenPayload.sub as string;
        const version = typeof tokenPayload.rtv === 'number' ? tokenPayload.rtv : 1;
        const aud = tokenPayload.aud as string;

        if (!jti) {
          return { token_hint: tokenHint, status: 'invalid' };
        }

        // Verify token belongs to requesting client
        if (tokenClientId !== client_id) {
          // Cannot revoke other client's tokens
          return { token_hint: tokenHint, status: 'invalid' };
        }

        // Get public key for signature verification
        let publicKey: CryptoKey | undefined;
        let tokenKid: string | undefined;

        try {
          const header = decodeProtectedHeader(item.token);
          tokenKid = header.kid;
        } catch {
          return { token_hint: tokenHint, status: 'invalid' };
        }

        // Get matching key with hierarchical caching (memory → KV → DO → env)
        const matchingKey = await getKeyByKid(c.env, tokenKid);
        if (matchingKey) {
          try {
            publicKey = (await importJWK(matchingKey, 'RS256')) as CryptoKey;
          } catch {
            return { token_hint: tokenHint, status: 'invalid' };
          }
        }

        if (!publicKey) {
          return { token_hint: tokenHint, status: 'invalid' };
        }

        // Verify token signature
        try {
          const expectedIssuer = c.env.ISSUER_URL;
          if (!expectedIssuer) {
            return { token_hint: tokenHint, status: 'invalid' };
          }
          await verifyToken(item.token, publicKey, expectedIssuer, { audience: aud });
        } catch {
          return { token_hint: tokenHint, status: 'invalid' };
        }

        // Revoke the token
        if (item.token_type_hint === 'refresh_token') {
          await deleteRefreshToken(c.env, jti, tokenClientId);
          await revokeToken(c.env, jti, expiresIn); // Cascade
        } else if (item.token_type_hint === 'access_token') {
          await revokeToken(c.env, jti, expiresIn);
        } else {
          // No hint - check if refresh token first
          const refreshTokenData = userId
            ? await getRefreshToken(c.env, userId, version, tokenClientId, jti)
            : null;
          if (refreshTokenData) {
            await deleteRefreshToken(c.env, jti, tokenClientId);
            await revokeToken(c.env, jti, expiresIn); // Cascade
          } else {
            await revokeToken(c.env, jti, expiresIn);
          }
        }

        return { token_hint: tokenHint, status: 'revoked' };
      } catch (error) {
        console.warn(`[BATCH_REVOKE] Failed to process token: ${error}`);
        return { token_hint: tokenHint, status: 'invalid' };
      }
    })
  );

  // Aggregate results
  const aggregatedResults: BatchRevokeResultItem[] = results.map((result) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Promise.allSettled rejected - treat as invalid
    return { token_hint: '***', status: 'invalid' as const };
  });

  const revokedCount = aggregatedResults.filter((r) => r.status === 'revoked').length;
  const invalidCount = aggregatedResults.filter((r) => r.status === 'invalid').length;

  const response: BatchRevokeResponse = {
    results: aggregatedResults,
    summary: {
      total: body.tokens.length,
      revoked: revokedCount,
      invalid: invalidCount,
    },
  };

  // Publish batch revocation event
  publishEvent(c, {
    type: TOKEN_EVENTS.BATCH_REVOKED,
    tenantId,
    data: {
      clientId: client_id,
      total: body.tokens.length,
      revoked: revokedCount,
      invalid: invalidCount,
    } satisfies BatchRevokeEventData,
  }).catch((err: unknown) => {
    console.error(`[Event] Failed to publish ${TOKEN_EVENTS.BATCH_REVOKED}:`, err);
  });

  // Audit log
  console.log(
    `[BATCH_REVOKE] Batch revocation completed: client=${client_id}, ` +
      `total=${body.tokens.length}, revoked=${revokedCount}, invalid=${invalidCount}`
  );

  return c.json(response, 200);
}

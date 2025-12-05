import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  validateGrantType,
  validateAuthCode,
  validateClientId,
  validateRedirectUri,
  parseShardedAuthCode,
  buildAuthCodeShardInstanceName,
  remapShardIndex,
  getShardCount,
  // Refresh Token Sharding
  getRefreshTokenShardConfig,
  getRefreshTokenShardIndex,
  createRefreshTokenJti,
  parseRefreshTokenJti,
  buildRefreshTokenRotatorInstanceName,
  generateRefreshTokenRandomPart,
} from '@authrim/shared';
import {
  revokeToken,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  getClient,
  getCachedUser,
} from '@authrim/shared';
import {
  createIDToken,
  createAccessToken,
  calculateAtHash,
  createRefreshToken,
  parseToken,
  verifyToken,
  createSDJWTIDTokenFromClaims,
} from '@authrim/shared';
import {
  encryptJWT,
  isIDTokenEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  validateJWTBearerAssertion,
  validateClientAssertion,
  parseTrustedIssuers,
  getIDTokenRBACClaims,
  getAccessTokenRBACClaims,
  evaluatePermissionsForScope,
  isPolicyEmbeddingEnabled,
  type JWEAlgorithm,
  type JWEEncryption,
  type IDTokenClaims,
} from '@authrim/shared';
import { importPKCS8, importJWK, type CryptoKey } from 'jose';
import { extractDPoPProof, validateDPoPProof } from '@authrim/shared';

// ===== Key Caching for Performance Optimization =====
// Cache signing key to avoid expensive RSA key import (5-7ms) and DO hop on every request
// Security considerations:
// - Private key remains in Worker memory (same security boundary as DO)
// - TTL limits exposure window if key is rotated
// - kid is cached to detect rotation (new kid = cache invalidation)
// Note: 10 minutes is still very conservative compared to industry standards
// (Auth0/Okta cache in-memory until process restart, which can be hours)
let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
let cachedKeyTimestamp = 0;
const KEY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes - industry standard safe TTL

// ===== JWKS (Public Key) Caching for Refresh Token Verification =====
// Cache JWKS to avoid KeyManager DO hop and expensive RSA key import on every refresh token request
//
// ARCHITECTURE OPTIMIZATION (issue #DO-bottleneck):
// - Priority 1: Use PUBLIC_JWK_JSON env variable if available (DO access = 0)
// - Priority 2: Fall back to KeyManager DO if env not set
//
// Security considerations:
// - Public keys only (no security risk if exposed)
// - Short TTL ensures timely rotation detection
// - kid mismatch triggers IMMEDIATE re-fetch (supports emergency rotation with overlap=0)
// - Normal rotation (overlap 5-10 min) keeps old keys in JWKS during overlap period
interface CachedJWKS {
  keys: Map<string, CryptoKey>; // kid → CryptoKey
  fetchedAt: number;
  source: 'env' | 'do'; // Track where keys came from
}
let cachedJWKS: CachedJWKS | null = null;
const JWKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes - aligned with signing key cache

/**
 * Get verification key from JWKS with caching
 *
 * ARCHITECTURE OPTIMIZATION (DO Bottleneck Fix):
 * 1. Priority 1: Use PUBLIC_JWK_JSON env variable (zero DO access)
 * 2. Priority 2: Fall back to KeyManager DO only if env not configured
 *
 * Performance optimization: Caches imported CryptoKeys to avoid:
 * 1. KeyManager DO hop on every refresh token request (when using DO fallback)
 * 2. Expensive RSA key import (importJWK takes 5-7ms)
 *
 * Security considerations:
 * - Public keys only (no security risk if exposed)
 * - TTL aligned with signing key cache (5 minutes)
 * - kid mismatch triggers IMMEDIATE re-fetch (supports emergency rotation with overlap=0)
 * - Normal rotation (overlap 5-10 min) keeps old keys in JWKS during overlap period
 *
 * Emergency Rotation Support:
 * - When kid mismatch detected, cache is invalidated immediately
 * - If using env-based JWKS, rotation requires redeployment or env update
 * - If using DO-based JWKS, rotation is automatic via KeyManager
 *
 * @param env - Environment bindings
 * @param kid - Key ID from JWT header (optional, uses first key if not specified)
 * @returns CryptoKey for verification
 */
async function getVerificationKeyFromJWKS(env: Env, kid?: string): Promise<CryptoKey> {
  const now = Date.now();

  // Check if cache is valid and contains the requested kid
  if (cachedJWKS && now - cachedJWKS.fetchedAt < JWKS_CACHE_TTL) {
    // If kid specified, look for it in cache
    if (kid) {
      const cachedKey = cachedJWKS.keys.get(kid);
      if (cachedKey) {
        return cachedKey;
      }
      // kid not in cache - EMERGENCY ROTATION detected!
      // Immediately invalidate cache and re-fetch
      console.warn(
        `[JWKS] kid=${kid} not found in cache (source=${cachedJWKS.source}), forcing re-fetch (possible emergency rotation)`
      );
      cachedJWKS = null; // Force cache invalidation
    } else {
      // No kid specified, return first cached key
      const firstKey = cachedJWKS.keys.values().next().value;
      if (firstKey) {
        return firstKey;
      }
    }
  }

  // ===== PRIORITY 1: Use PUBLIC_JWK_JSON environment variable (DO access = 0) =====
  // This eliminates the KeyManager DO bottleneck for verification
  if (env.PUBLIC_JWK_JSON) {
    try {
      const publicJwk = JSON.parse(env.PUBLIC_JWK_JSON) as { kid?: string; [key: string]: unknown };
      const keyKid = publicJwk.kid || 'default';
      const importedKey = (await importJWK(publicJwk, 'RS256')) as CryptoKey;

      // Build single-key cache from env
      const envKeys = new Map<string, CryptoKey>();
      envKeys.set(keyKid, importedKey);

      cachedJWKS = {
        keys: envKeys,
        fetchedAt: now,
        source: 'env',
      };

      // If kid is specified and doesn't match env key, we have a problem
      // This means rotation happened but env wasn't updated
      if (kid && kid !== keyKid) {
        console.warn(
          `[JWKS] CRITICAL: Token kid=${kid} does not match env PUBLIC_JWK_JSON kid=${keyKid}. ` +
            `Env needs update or falling back to DO.`
        );
        // Fall through to DO fallback below
      } else {
        console.log(`[JWKS] Using PUBLIC_JWK_JSON (DO access=0), kid=${keyKid}`);
        return importedKey;
      }
    } catch (err) {
      console.error('[JWKS] Failed to parse PUBLIC_JWK_JSON, falling back to KeyManager DO:', err);
      // Fall through to DO fallback
    }
  }

  // ===== PRIORITY 2: Fall back to KeyManager DO =====
  // Only used when PUBLIC_JWK_JSON is not configured or doesn't match kid
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available and PUBLIC_JWK_JSON not configured');
  }

  console.log(`[JWKS] Fetching from KeyManager DO (kid=${kid || 'any'})`);

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  const jwksResponse = await keyManager.fetch('http://key-manager/jwks', { method: 'GET' });

  if (!jwksResponse.ok) {
    throw new Error(`Failed to fetch JWKS from KeyManager: ${jwksResponse.status}`);
  }

  const jwks = (await jwksResponse.json()) as {
    keys: Array<{ kid?: string; [key: string]: unknown }>;
  };

  // Import all keys and build cache
  const newKeys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys) {
    const keyKid = jwk.kid || 'default';
    try {
      const importedKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
      newKeys.set(keyKid, importedKey);
    } catch (err) {
      console.error(`[JWKS] Failed to import key kid=${keyKid}:`, err);
    }
  }

  if (newKeys.size === 0) {
    throw new Error('No valid keys in JWKS');
  }

  // Update cache
  cachedJWKS = {
    keys: newKeys,
    fetchedAt: now,
    source: 'do',
  };

  // Return requested key or first key
  if (kid) {
    const requestedKey = newKeys.get(kid);
    if (requestedKey) {
      return requestedKey;
    }
    // After fetching from DO, kid still not found = token signed with revoked key
    throw new Error(`Key not found for kid=${kid} (key may have been revoked)`);
  }

  // Return first key
  return newKeys.values().next().value as CryptoKey;
}

/**
 * Response from AuthCodeStore Durable Object
 */
interface AuthCodeStoreResponse {
  userId: string;
  scope: string;
  redirectUri: string;
  nonce?: string;
  state?: string;
  createdAt?: number;
  claims?: string; // JSON string of claims parameter
  authTime?: number;
  acr?: string;
  cHash?: string; // OIDC c_hash for hybrid flows
  dpopJkt?: string; // DPoP JWK thumbprint (RFC 9449)
  // Present when replay attack is detected (RFC 6749 Section 4.1.2)
  replayAttack?: {
    accessTokenJti?: string;
    refreshTokenJti?: string;
  };
}

/**
 * Get signing key from KeyManager with caching
 * If no active key exists, generates a new one
 *
 * Performance optimization:
 * 1. Caches the imported CryptoKey to avoid expensive RSA key import (5-7ms)
 * 2. Uses kid mismatch trigger: Only fetches from DO when:
 *    - No cache exists (cold start)
 *    - TTL expired (safety refresh)
 *    - kid mismatch (key rotation detected from incoming token)
 *
 * This dramatically reduces DO access under high load where many isolates
 * start simultaneously - each isolate only needs ONE initial DO call,
 * then serves from cache until TTL expires or key rotates.
 *
 * @param env - Environment bindings
 * @param expectedKid - Optional kid from incoming token. If provided and matches cache, skip TTL check.
 */
async function getSigningKeyFromKeyManager(
  env: Env,
  expectedKid?: string
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();

  // Check cache with kid mismatch logic
  if (cachedSigningKey) {
    const ttlValid = now - cachedKeyTimestamp < KEY_CACHE_TTL;

    // Case 1: expectedKid provided and matches cache → return immediately (skip TTL check)
    // This is the "kid mismatch trigger" pattern - if the incoming token's kid matches
    // our cached key, we know the cache is still valid for signing responses
    if (expectedKid && cachedSigningKey.kid === expectedKid) {
      return cachedSigningKey;
    }

    // Case 2: No expectedKid but TTL valid → return from cache
    if (!expectedKid && ttlValid) {
      return cachedSigningKey;
    }

    // Case 3: expectedKid provided but doesn't match → need to fetch new key (key rotation)
    // Case 4: TTL expired → need to refresh cache
    // Both cases fall through to fetch from DO
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

  // Authentication header for KeyManager
  const authHeaders = {
    Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
  };

  // Try to get active key (using internal endpoint that returns privatePEM)
  const activeResponse = await keyManager.fetch('http://dummy/internal/active-with-private', {
    method: 'GET',
    headers: authHeaders,
  });

  let keyData: { kid: string; privatePEM: string };

  if (activeResponse.ok) {
    keyData = (await activeResponse.json()) as { kid: string; privatePEM: string };
  } else {
    // No active key, generate and activate one
    console.log('[KeyManager] No active signing key found, generating new key');
    const rotateResponse = await keyManager.fetch('http://dummy/internal/rotate', {
      method: 'POST',
      headers: authHeaders,
    });

    if (!rotateResponse.ok) {
      console.error('[KeyManager] Failed to rotate key:', rotateResponse.status);
      throw new Error('Failed to generate signing key');
    }

    const rotateData = (await rotateResponse.json()) as {
      success: boolean;
      key: { kid: string; privatePEM: string };
    };
    keyData = rotateData.key;
    console.log('[KeyManager] Generated new signing key:', { kid: keyData.kid });
  }

  // Import private key (expensive operation: 5-7ms)
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // Update cache with new key
  cachedSigningKey = { privateKey, kid: keyData.kid };
  cachedKeyTimestamp = now;
  console.log('[KeyManager] Signing key cached:', { kid: keyData.kid, ttlMs: KEY_CACHE_TTL });

  return { privateKey, kid: keyData.kid };
}

/**
 * Token Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#TokenEndpoint
 *
 * Exchanges authorization codes for ID tokens and access tokens
 * Also supports refresh token flow (RFC 6749 Section 6)
 */
export async function tokenHandler(c: Context<{ Bindings: Env }>) {
  // Verify Content-Type is application/x-www-form-urlencoded
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400
    );
  }

  // Parse form data
  let formData: Record<string, string>;
  try {
    const body = await c.req.parseBody();
    formData = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
    );
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Failed to parse request body',
      },
      400
    );
  }

  const grant_type = formData.grant_type;

  // Route to appropriate handler based on grant_type
  if (grant_type === 'refresh_token') {
    return await handleRefreshTokenGrant(c, formData);
  } else if (grant_type === 'authorization_code') {
    return await handleAuthorizationCodeGrant(c, formData);
  } else if (grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
    return await handleJWTBearerGrant(c, formData);
  } else if (grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
    return await handleDeviceCodeGrant(c, formData);
  } else if (grant_type === 'urn:openid:params:grant-type:ciba') {
    return await handleCIBAGrant(c, formData);
  }

  // If grant_type is not supported
  return c.json(
    {
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grant_type}' is not supported`,
    },
    400
  );
}

/**
 * Handle Authorization Code Grant
 * https://openid.net/specs/openid-connect-core-1_0.html#TokenEndpoint
 */
async function handleAuthorizationCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const grant_type = formData.grant_type;
  const code = formData.code;
  const redirect_uri = formData.redirect_uri;
  const code_verifier = formData.code_verifier;

  // Extract client credentials from either form data or Authorization header
  // Supports client_secret_post, client_secret_basic, client_secret_jwt, and private_key_jwt
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication (private_key_jwt or client_secret_jwt)
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // Extract client_id from JWT assertion (from 'sub' or 'iss' claim)
    try {
      const assertionPayload = parseToken(client_assertion);

      // Per RFC 7523, the 'sub' claim should contain the client_id
      // If not present, fall back to 'iss' which also commonly contains the client_id
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      } else if (!client_id && assertionPayload.iss) {
        client_id = assertionPayload.iss as string;
      }

      // JWT assertion will be validated later against the client's registered public key
      // For now, we just extract the client_id to proceed with the flow
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_assertion JWT format',
        },
        401
      );
    }
  }

  // Check for HTTP Basic authentication (client_secret_basic)
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = atob(base64Credentials);
      const [basicClientId, basicClientSecret] = credentials.split(':', 2);

      // Use Basic auth credentials if form data doesn't provide them
      if (!client_id && basicClientId) {
        client_id = basicClientId;
      }
      if (!client_secret && basicClientSecret) {
        client_secret = basicClientSecret;
      }
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid Authorization header format',
        },
        401
      );
    }
  }

  // Validate grant_type
  const grantTypeValidation = validateGrantType(grant_type);
  if (!grantTypeValidation.valid) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: grantTypeValidation.error,
      },
      400
    );
  }

  // Validate authorization code
  const codeValidation = validateAuthCode(code);
  if (!codeValidation.valid) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: codeValidation.error,
      },
      400
    );
  }

  // Type narrowing: code is guaranteed to be a string at this point
  const validCode: string = code;

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Validate redirect_uri
  const allowHttp = c.env.ALLOW_HTTP_REDIRECT === 'true';
  const redirectUriValidation = validateRedirectUri(redirect_uri, allowHttp);
  if (!redirectUriValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: redirectUriValidation.error,
      },
      400
    );
  }

  // Fetch client metadata early (needed for FAPI/DPoP checks)
  const clientMetadata = await getClient(c.env, client_id);
  if (!clientMetadata) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      401
    );
  }

  // DPoP requirement (FAPI 2.0 / sender-constrained tokens)
  let requireDpop = false;
  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      const fapi = settings.fapi || {};
      // If FAPI is enabled, default to requiring DPoP unless explicitly disabled
      requireDpop = Boolean(fapi.requireDpop || (fapi.enabled && fapi.requireDpop !== false));
    }
  } catch (error) {
    console.error('Failed to load FAPI settings for DPoP:', error);
  }

  const clientRequiresDpop = Boolean((clientMetadata as any).dpop_bound_access_tokens);
  const dpopProof = extractDPoPProof(c.req.raw.headers);

  if ((requireDpop || clientRequiresDpop) && !dpopProof) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'DPoP proof is required for this request',
      },
      400
    );
  }

  // Validate DPoP proof early to get jkt for authorization code binding verification
  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined, // No access token yet
      c.env.DPOP_JTI_STORE,
      client_id
    );

    if (!dpopValidation.valid) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: dpopValidation.error || 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'Invalid DPoP proof',
        },
        400
      );
    }

    dpopJkt = dpopValidation.jkt;
  }

  // Consume authorization code using AuthorizationCodeStore Durable Object
  // This replaces KV-based getAuthCode() with strong consistency guarantees
  // Parse shard index from code to route to the correct DO instance
  const shardInfo = parseShardedAuthCode(validCode);
  let authCodeStoreId: DurableObjectId;

  if (shardInfo) {
    // Get current shard count (KV優先、キャッシュあり)
    const currentShardCount = await getShardCount(c.env);

    // Remap shard index for scale-down compatibility
    const actualShardIndex = remapShardIndex(shardInfo.shardIndex, currentShardCount);

    // Log remapping for monitoring (only when remapped)
    if (actualShardIndex !== shardInfo.shardIndex) {
      console.log(
        `[AuthCode] Remapped shard ${shardInfo.shardIndex} → ${actualShardIndex} ` +
          `(current shards: ${currentShardCount})`
      );
    }

    const instanceName = buildAuthCodeShardInstanceName(actualShardIndex);
    authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(instanceName);
  } else {
    // Legacy format (no shard prefix) - use 'global' instance
    authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName('global');
  }
  const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);

  let authCodeData;
  try {
    const consumeResponse = await authCodeStore.fetch(
      new Request('https://auth-code-store/code/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: validCode,
          clientId: client_id,
          codeVerifier: code_verifier,
        }),
      })
    );

    if (!consumeResponse.ok) {
      const errorData = (await consumeResponse.json()) as {
        error: string;
        error_description: string;
      };

      return c.json(
        {
          error: errorData.error || 'invalid_grant',
          error_description:
            errorData.error_description || 'Authorization code is invalid or expired',
        },
        400
      );
    }

    // AuthCodeStore DO returns: { userId, scope, redirectUri, nonce?, state?, replayAttack? }
    const consumedData = (await consumeResponse.json()) as AuthCodeStoreResponse;

    // RFC 6749 Section 4.1.2: Handle replay attack detection
    // If authorization code was already used, revoke previously issued tokens
    if (consumedData.replayAttack) {
      console.warn(
        '[Security] Authorization code replay attack detected, revoking previously issued tokens'
      );

      const { accessTokenJti, refreshTokenJti } = consumedData.replayAttack;

      // Revoke the access token that was issued when the code was first used
      if (accessTokenJti) {
        try {
          await revokeToken(c.env, accessTokenJti, 3600, 'Authorization code replay attack');
          console.log(`[Security] Revoked access token: ${accessTokenJti.substring(0, 8)}...`);
        } catch (revokeError) {
          console.error('[Security] Failed to revoke access token:', revokeError);
        }
      }

      // Revoke the refresh token that was issued when the code was first used
      if (refreshTokenJti) {
        try {
          await revokeToken(
            c.env,
            refreshTokenJti,
            86400 * 30, // 30 days
            'Authorization code replay attack'
          );
          console.log(`[Security] Revoked refresh token: ${refreshTokenJti.substring(0, 8)}...`);
        } catch (revokeError) {
          console.error('[Security] Failed to revoke refresh token:', revokeError);
        }
      }

      // Return error to the attacker
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Authorization code already used',
        },
        400
      );
    }

    // Map AuthCodeStore DO response to expected format
    authCodeData = {
      sub: consumedData.userId, // Map userId to sub for JWT claims
      scope: consumedData.scope,
      redirect_uri: consumedData.redirectUri, // Keep for compatibility
      nonce: consumedData.nonce,
      state: consumedData.state,
      auth_time: consumedData.authTime || Math.floor(Date.now() / 1000), // OIDC Core: Time when End-User authentication occurred
      acr: consumedData.acr, // OIDC Core: Authentication Context Class Reference
      claims: consumedData.claims,
      dpopJkt: consumedData.dpopJkt, // DPoP JWK thumbprint for binding verification
    };
  } catch (error) {
    console.error('AuthCodeStore DO error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to validate authorization code',
      },
      500
    );
  }

  // Verify redirect_uri matches (additional safety check)
  if (authCodeData.redirect_uri !== redirect_uri) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match the one used in authorization request',
      },
      400
    );
  }

  // DPoP Authorization Code Binding verification (RFC 9449)
  // If the authorization code was bound to a DPoP key, verify the same key is used
  if (authCodeData.dpopJkt) {
    // Authorization code is bound to a DPoP key, DPoP proof is required
    if (!dpopProof) {
      console.warn('[DPoP] Authorization code bound to DPoP key but no DPoP proof provided');
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'DPoP proof required (authorization code is bound to DPoP key)',
        },
        400
      );
    }

    // Verify the DPoP proof's jkt matches the stored jkt
    if (dpopJkt !== authCodeData.dpopJkt) {
      console.warn(
        '[DPoP] DPoP key mismatch. Expected:',
        authCodeData.dpopJkt,
        'Received:',
        dpopJkt
      );
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'DPoP key mismatch (authorization code is bound to different key)',
        },
        400
      );
    }

    console.log('[DPoP] Authorization code binding verified successfully');
  }

  // Client authentication verification
  // Supports: client_secret_basic, client_secret_post, client_secret_jwt, private_key_jwt
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // private_key_jwt or client_secret_jwt authentication
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${c.env.ISSUER_URL}/token`,
      clientMetadata as unknown as import('@authrim/shared').ClientMetadata
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
    if (!client_secret || client_secret !== clientMetadata.client_secret) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        },
        401
      );
    }
  }
  // Public clients (no client_secret and no client_assertion) are allowed

  // Load private key for signing tokens from KeyManager
  // NOTE: Key loading moved BEFORE code deletion to avoid losing code on key loading failure
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key from KeyManager:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // DPoP support (RFC 9449)
  // dpopJkt was already validated earlier for authorization code binding verification
  const tokenType: 'Bearer' | 'DPoP' = dpopProof ? 'DPoP' : 'Bearer';

  // Note: For Authorization Code Flow (response_type=code), scope-based claims
  // (profile, email, etc.) should be returned from the UserInfo endpoint, NOT in the ID token.
  // Only response_type=id_token (Implicit Flow) should include these claims in the ID token.
  // See OpenID Connect Core 5.4: "The Claims requested by the profile, email, address, and
  // phone scope values are returned from the UserInfo Endpoint"

  // Phase 1 RBAC: Fetch RBAC claims for tokens
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(c.env.DB, authCodeData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ACCESS_TOKEN_CLAIMS,
      }),
      getIDTokenRBACClaims(c.env.DB, authCodeData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ID_TOKEN_CLAIMS,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    console.warn('Failed to fetch RBAC claims:', rbacError);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && authCodeData.scope) {
      policyEmbeddingPermissions = await evaluatePermissionsForScope(
        c.env.DB,
        authCodeData.sub,
        authCodeData.scope,
        { cache: c.env.REBAC_CACHE }
      );
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    console.warn('Failed to evaluate policy permissions:', policyError);
  }

  // Generate Access Token FIRST (needed for at_hash in ID token)
  const accessTokenClaims: {
    iss: string;
    sub: string;
    aud: string;
    scope: string;
    client_id: string;
    claims?: string;
    cnf?: { jkt: string };
    // Phase 1 RBAC claims
    authrim_roles?: string[];
    authrim_org_id?: string;
    authrim_org_type?: string;
    // Phase 2 Policy Embedding
    authrim_permissions?: string[];
  } = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: c.env.ISSUER_URL, // For MVP, access token audience is the issuer
    scope: authCodeData.scope,
    client_id: client_id,
    // Phase 1 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }

  // Add claims parameter if it was requested during authorization
  if (authCodeData.claims) {
    accessTokenClaims.claims = authCodeData.claims;
  }

  // Add DPoP confirmation (cnf) claim if DPoP is used
  if (dpopJkt) {
    accessTokenClaims.cnf = { jkt: dpopJkt };
  }

  let accessToken: string;
  let tokenJti: string;
  try {
    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
    tokenJti = result.jti;
  } catch (error) {
    console.error('Failed to create access token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Calculate at_hash for ID Token
  // https://openid.net/specs/openid-connect-core-1_0.html#CodeIDToken
  let atHash: string;
  try {
    atHash = await calculateAtHash(accessToken);
  } catch (error) {
    console.error('Failed to calculate at_hash:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to calculate token hash',
      },
      500
    );
  }

  // Generate ID Token with at_hash and auth_time
  // Phase 1 RBAC: Include RBAC claims in ID Token
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: client_id,
    nonce: authCodeData.nonce,
    at_hash: atHash, // OIDC spec requirement for code flow
    auth_time: authCodeData.auth_time, // OIDC Core Section 2: Time when End-User authentication occurred
    ...(authCodeData.acr && { acr: authCodeData.acr }),
    // Phase 1 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
  };

  let idToken: string;
  try {
    // Check if client requests SD-JWT ID Token (RFC 9901)
    const useSDJWT =
      (clientMetadata as any).id_token_signed_response_type === 'sd-jwt' &&
      c.env.ENABLE_SD_JWT === 'true';

    if (useSDJWT) {
      // Create SD-JWT ID Token with selective disclosure
      const selectiveClaims = (clientMetadata as any).sd_jwt_selective_claims || [
        'email',
        'phone_number',
        'address',
        'birthdate',
      ];
      idToken = await createSDJWTIDTokenFromClaims(
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        privateKey,
        keyId,
        expiresIn,
        selectiveClaims
      );
      console.log('[SD-JWT] Created SD-JWT ID Token for client:', client_id);
    } else {
      // For Authorization Code Flow, ID token should only contain standard claims
      // Scope-based claims (profile, email) are returned from UserInfo endpoint
      idToken = await createIDToken(
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        privateKey,
        keyId,
        expiresIn
      );
    }

    // JWE: Check if client requires ID token encryption (RFC 7516)
    // Note: SD-JWT can also be encrypted (nested: SD-JWT inside JWE)
    // Note: clientMetadata was already fetched during client authentication above
    if (isIDTokenEncryptionRequired(clientMetadata)) {
      const alg = clientMetadata.id_token_encrypted_response_alg as string;
      const enc = clientMetadata.id_token_encrypted_response_enc as string;

      // Validate encryption algorithms
      try {
        validateJWEOptions(alg, enc);
      } catch (validationError) {
        console.error('Invalid JWE options:', validationError);
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: `Client encryption configuration is invalid: ${validationError instanceof Error ? validationError.message : 'Unknown error'}`,
          },
          400
        );
      }

      // Get client's public key for encryption
      const publicKey = await getClientPublicKey(clientMetadata);
      if (!publicKey) {
        console.error('Client requires encryption but no public key available');
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description:
              'Client requires ID token encryption but no public key (jwks or jwks_uri) is configured',
          },
          400
        );
      }

      // Encrypt the signed ID token (nested JWT: JWS inside JWE)
      try {
        idToken = await encryptJWT(idToken, publicKey, {
          alg: alg as JWEAlgorithm,
          enc: enc as JWEEncryption,
          cty: 'JWT', // Content type is JWT (the signed ID token)
          kid: publicKey.kid,
        });
      } catch (encryptError) {
        console.error('Failed to encrypt ID token:', encryptError);
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to encrypt ID token',
          },
          500
        );
      }
    }
  } catch (error) {
    console.error('Failed to create ID token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Generate Refresh Token
  // https://tools.ietf.org/html/rfc6749#section-6
  let refreshToken: string;
  let refreshTokenJti: string;
  const refreshTokenExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);

  try {
    const refreshTokenClaims = {
      iss: c.env.ISSUER_URL,
      sub: authCodeData.sub,
      aud: client_id,
      scope: authCodeData.scope,
      client_id: client_id,
    };

    // V2/V3: Register with RefreshTokenRotator first to get version
    // V3: Uses sharded DO instances for horizontal scaling
    let rtv: number = 1; // Default version for new family

    if (c.env.REFRESH_TOKEN_ROTATOR) {
      // V3: Get shard configuration and calculate shard index
      const shardConfig = await getRefreshTokenShardConfig(c.env, client_id);
      const shardIndex = await getRefreshTokenShardIndex(
        authCodeData.sub,
        client_id,
        shardConfig.currentShardCount
      );

      // V3: Generate sharded JTI with generation and shard info
      const randomPart = generateRefreshTokenRandomPart();
      refreshTokenJti = createRefreshTokenJti(
        shardConfig.currentGeneration,
        shardIndex,
        randomPart
      );

      // V3: Route to sharded DO instance
      const instanceName = buildRefreshTokenRotatorInstanceName(
        client_id,
        shardConfig.currentGeneration,
        shardIndex
      );
      const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
      const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

      const familyResponse = await rotator.fetch('http://rotator/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: refreshTokenJti,
          userId: authCodeData.sub,
          clientId: client_id,
          scope: authCodeData.scope,
          ttl: refreshTokenExpiresIn,
          // V3: Include shard metadata (for debugging/audit)
          generation: shardConfig.currentGeneration,
          shardIndex: shardIndex,
        }),
      });

      if (!familyResponse.ok) {
        const errorText = await familyResponse.text();
        console.error('Failed to register refresh token family:', errorText);
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to register refresh token',
          },
          500
        );
      }

      const familyResult = (await familyResponse.json()) as { version: number; jti: string };
      rtv = familyResult.version;

      // V3: Record in D1 for user-wide revocation support
      // (non-blocking, fire-and-forget for performance)
      void recordTokenFamilyInD1(
        c.env,
        refreshTokenJti,
        authCodeData.sub,
        client_id,
        shardConfig.currentGeneration,
        refreshTokenExpiresIn
      );
    } else {
      refreshTokenJti = `rt_${crypto.randomUUID()}`;
    }

    // Create JWT with rtv (Refresh Token Version) claim
    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiresIn,
      refreshTokenJti,
      rtv // V2: Include version for theft detection
    );
    refreshToken = result.token;
    // V2: Family is already registered via RefreshTokenRotator DO above
    // No need to call storeRefreshToken() - it was a V1 artifact
  } catch (error) {
    console.error('Failed to create refresh token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create refresh token',
      },
      500
    );
  }

  // Authorization code has been consumed and marked as used by AuthCodeStore DO
  // Per RFC 6749 Section 4.1.2: Authorization codes are single-use
  // The DO guarantees atomic consumption and replay attack detection
  //
  // Note: Token JTI registration for replay attack revocation has been removed
  // as a DO hop optimization. The consume() call now handles code invalidation
  // atomically, which is the primary security guarantee. Token revocation on
  // replay is a secondary feature that adds latency for rare attack scenarios.

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: authCodeData.scope, // OAuth 2.0 spec: include scope for clarity
  });
}

/**
 * Handle Refresh Token Grant
 * https://tools.ietf.org/html/rfc6749#section-6
 */
async function handleRefreshTokenGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const refreshTokenValue = formData.refresh_token;
  const scope = formData.scope; // Optional: requested scope (must be subset of original)

  // Extract client credentials from either form data or Authorization header
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication (private_key_jwt or client_secret_jwt)
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // Extract client_id from JWT assertion
    try {
      const assertionPayload = parseToken(client_assertion);
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      } else if (!client_id && assertionPayload.iss) {
        client_id = assertionPayload.iss as string;
      }
    } catch {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_assertion JWT format',
        },
        401
      );
    }
  }

  // Check for HTTP Basic authentication (client_secret_basic)
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = atob(base64Credentials);
      const [basicClientId, basicClientSecret] = credentials.split(':', 2);

      if (!client_id && basicClientId) {
        client_id = basicClientId;
      }
      if (!client_secret && basicClientSecret) {
        client_secret = basicClientSecret;
      }
    } catch {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid Authorization header format',
        },
        401
      );
    }
  }

  // Validate refresh_token parameter
  if (!refreshTokenValue) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      },
      400
    );
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_client',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Fetch client metadata to verify client authentication
  const clientMetadata = await getClient(c.env, client_id);
  if (!clientMetadata) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      400
    );
  }

  // Client authentication verification
  // Supports: client_secret_basic, client_secret_post, client_secret_jwt, private_key_jwt
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // private_key_jwt or client_secret_jwt authentication
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${c.env.ISSUER_URL}/token`,
      clientMetadata as unknown as import('@authrim/shared').ClientMetadata
    );

    if (!assertionValidation.valid) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
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
    if (!client_secret || client_secret !== clientMetadata.client_secret) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        },
        401
      );
    }
  }
  // Public clients (no client_secret and no client_assertion) are allowed

  // Parse refresh token to get JTI (without verification yet)
  let refreshTokenPayload;
  try {
    refreshTokenPayload = parseToken(refreshTokenValue);
  } catch {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Invalid refresh token format',
      },
      400
    );
  }

  const jti = refreshTokenPayload.jti as string;
  if (!jti) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token missing JTI',
      },
      400
    );
  }

  // V2: Extract userId (sub) and version (rtv) from JWT for validation
  const userId = refreshTokenPayload.sub as string;
  const version = typeof refreshTokenPayload.rtv === 'number' ? refreshTokenPayload.rtv : 1;

  if (!userId) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token missing subject',
      },
      400
    );
  }

  // Retrieve refresh token metadata from RefreshTokenRotator DO (V2)
  const refreshTokenData = await getRefreshToken(c.env, userId, version, client_id, jti);
  if (!refreshTokenData) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token is invalid or expired',
      },
      400
    );
  }

  // Verify client_id matches
  if (refreshTokenData.client_id !== client_id) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token was issued to a different client',
      },
      400
    );
  }

  // Load public key for verification using cached JWKS
  // Extract kid from JWT header for key lookup
  let publicKey: CryptoKey;
  let refreshTokenKid: string | undefined;
  try {
    const parts = refreshTokenValue.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const headerBase64url = parts[0];
    const headerBase64 = headerBase64url.replace(/-/g, '+').replace(/_/g, '/');
    const headerJson = JSON.parse(atob(headerBase64)) as { kid?: string; alg?: string };
    refreshTokenKid = headerJson.kid;

    // Use cached JWKS for performance (avoids KeyManager DO hop + RSA import on every request)
    publicKey = await getVerificationKeyFromJWKS(c.env, refreshTokenKid);
  } catch (err) {
    console.error('Failed to load verification key:', err);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load verification key',
      },
      500
    );
  }

  // Verify refresh token signature
  try {
    await verifyToken(refreshTokenValue, publicKey, c.env.ISSUER_URL, client_id);
  } catch (error) {
    console.error('Refresh token verification failed:', error);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token signature verification failed',
      },
      400
    );
  }

  // If scope is requested, validate it's a subset of the original scope
  let grantedScope = refreshTokenData.scope;
  if (scope) {
    const requestedScopes = scope.split(' ');
    const originalScopes = refreshTokenData.scope.split(' ');

    // Check if all requested scopes are in the original scope
    const isSubset = requestedScopes.every((s) => originalScopes.includes(s));
    if (!isSubset) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'Requested scope exceeds original scope',
        },
        400
      );
    }
    grantedScope = scope;
  }

  // Load private key for signing new tokens from KeyManager
  // Pass the incoming token's kid as expectedKid for cache optimization:
  // If the cache has a key with matching kid, it can skip TTL check (kid mismatch trigger)
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, refreshTokenKid);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key from KeyManager:', error);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // Phase 2 RBAC: Fetch fresh RBAC claims for token refresh
  // User's roles/organization may have changed since the original token was issued
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(c.env.DB, refreshTokenData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ACCESS_TOKEN_CLAIMS,
      }),
      getIDTokenRBACClaims(c.env.DB, refreshTokenData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ID_TOKEN_CLAIMS,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    console.warn('Failed to fetch RBAC claims for refresh token:', rbacError);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && grantedScope) {
      policyEmbeddingPermissions = await evaluatePermissionsForScope(
        c.env.DB,
        refreshTokenData.sub,
        grantedScope,
        { cache: c.env.REBAC_CACHE }
      );
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    console.warn('Failed to evaluate policy permissions for refresh token:', policyError);
  }

  // DPoP support (RFC 9449)
  // Extract and validate DPoP proof if present
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  let dpopJkt: string | undefined;
  let tokenType: 'Bearer' | 'DPoP' = 'Bearer';

  if (dpopProof) {
    // Validate DPoP proof (issue #12: DPoP JTI replay protection via DO)
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined, // No access token yet (this is token refresh)
      c.env.DPOP_JTI_STORE, // DPoPJTIStore DO for atomic JTI replay protection
      client_id // Bind JTI to client_id for additional security
    );

    if (!dpopValidation.valid) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: dpopValidation.error || 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'DPoP proof validation failed',
        },
        400
      );
    }

    // DPoP proof is valid, bind access token to the public key
    dpopJkt = dpopValidation.jkt;
    tokenType = 'DPoP';
  }

  // Generate new Access Token
  let accessToken: string;
  try {
    const accessTokenClaims: {
      iss: string;
      sub: string;
      aud: string;
      scope: string;
      client_id: string;
      cnf?: { jkt: string };
      authrim_permissions?: string[];
      [key: string]: unknown;
    } = {
      iss: c.env.ISSUER_URL,
      sub: refreshTokenData.sub,
      aud: c.env.ISSUER_URL,
      scope: grantedScope,
      client_id: client_id,
      // Phase 2 RBAC: Add RBAC claims to access token
      ...accessTokenRBACClaims,
    };

    // Phase 2 Policy Embedding: Add evaluated permissions
    if (policyEmbeddingPermissions.length > 0) {
      accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
    }

    // Add DPoP confirmation (cnf) claim if DPoP is used
    if (dpopJkt) {
      accessTokenClaims.cnf = { jkt: dpopJkt };
    }

    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
  } catch (err) {
    console.error('Failed to create access token:', err);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Generate new ID Token (optional for refresh flow, but included for consistency)
  let idToken: string;
  try {
    const atHash = await calculateAtHash(accessToken);
    const idTokenClaims = {
      iss: c.env.ISSUER_URL,
      sub: refreshTokenData.sub,
      aud: client_id,
      at_hash: atHash,
      // Phase 2 RBAC: Add RBAC claims to ID token
      ...idTokenRBACClaims,
    };

    // Check if client requests SD-JWT ID Token (RFC 9901)
    const useSDJWT =
      (clientMetadata as any).id_token_signed_response_type === 'sd-jwt' &&
      c.env.ENABLE_SD_JWT === 'true';

    if (useSDJWT) {
      const selectiveClaims = (clientMetadata as any).sd_jwt_selective_claims || [
        'email',
        'phone_number',
        'address',
        'birthdate',
      ];
      idToken = await createSDJWTIDTokenFromClaims(
        idTokenClaims,
        privateKey,
        keyId,
        expiresIn,
        selectiveClaims
      );
    } else {
      idToken = await createIDToken(idTokenClaims, privateKey, keyId, expiresIn);
    }
  } catch (error) {
    console.error('Failed to create ID token:', error);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Check if Token Rotation is enabled (default: true for security)
  // Set REFRESH_TOKEN_ROTATION_ENABLED=false to disable (for load testing only!)
  const rotationEnabled = c.env.REFRESH_TOKEN_ROTATION_ENABLED !== 'false';

  let newRefreshToken: string;
  const refreshTokenExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);

  if (rotationEnabled) {
    // V2: Implement refresh token rotation with version-based theft detection
    if (!c.env.REFRESH_TOKEN_ROTATOR) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'server_error',
          error_description: 'Refresh token rotation unavailable',
        },
        500
      );
    }

    // V3: Parse JTI to extract generation and shard info for routing
    const parsedJti = parseRefreshTokenJti(jti);
    const instanceName = buildRefreshTokenRotatorInstanceName(
      client_id,
      parsedJti.generation,
      parsedJti.shardIndex
    );
    const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
    const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

    // V2: Get incoming version from JWT (default to 1 for legacy tokens without rtv)
    const incomingVersion =
      typeof refreshTokenPayload.rtv === 'number' ? refreshTokenPayload.rtv : 1;

    let newRefreshTokenJti: string;
    let newVersion: number;

    try {
      // V2: Call RefreshTokenRotator DO with version-based rotation
      const rotateResponse = await rotator.fetch('http://rotator/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion,
          incomingJti: jti,
          userId: refreshTokenData.sub,
          clientId: client_id,
          requestedScope: scope || undefined, // Pass requested scope for validation
        }),
      });

      if (!rotateResponse.ok) {
        const error = (await rotateResponse.json()) as {
          error?: string;
          error_description?: string;
          action?: string;
        };
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');

        // Log theft detection for security monitoring
        if (error.action === 'family_revoked') {
          console.error('SECURITY: Token theft detected and family revoked', {
            clientId: client_id,
            userId: refreshTokenData.sub,
            incomingVersion,
          });
        }

        return c.json(
          {
            error: error.error || 'invalid_grant',
            error_description: error.error_description || 'Token rotation failed',
          },
          400
        );
      }

      const rotateResult = (await rotateResponse.json()) as {
        newVersion: number;
        newJti: string;
        expiresIn: number;
        allowedScope: string;
      };

      // V3: Wrap the new JTI with generation/shard info from the original token
      // Rotation keeps the token on the same shard (same user+client = same shard)
      if (!parsedJti.isLegacy) {
        // New format: wrap with generation/shard prefix
        newRefreshTokenJti = createRefreshTokenJti(
          parsedJti.generation,
          parsedJti.shardIndex!,
          rotateResult.newJti
        );
      } else {
        // Legacy format: keep as-is for backward compatibility
        newRefreshTokenJti = rotateResult.newJti;
      }
      newVersion = rotateResult.newVersion;

      // Create JWT with new version (rtv claim)
      const refreshTokenClaims = {
        iss: c.env.ISSUER_URL,
        sub: refreshTokenData.sub,
        aud: client_id,
        scope: grantedScope,
        client_id: client_id,
      };

      // V2: Include rtv (Refresh Token Version) for theft detection
      const result = await createRefreshToken(
        refreshTokenClaims,
        privateKey,
        keyId,
        refreshTokenExpiresIn,
        newRefreshTokenJti,
        newVersion // V2: Include version in JWT
      );
      newRefreshToken = result.token;
    } catch (error) {
      console.error('Failed to rotate refresh token:', error);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to rotate refresh token',
        },
        500
      );
    }
  } else {
    // Token Rotation disabled - return the same refresh token
    // WARNING: This is less secure and should only be used for testing!
    newRefreshToken = refreshTokenValue;
    console.log('[TOKEN] Refresh token rotation disabled - returning same token');
  }

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: newRefreshToken,
    scope: grantedScope,
  });
}

/**
 * Verify PKCE code_verifier against code_challenge
 * https://tools.ietf.org/html/rfc7636#section-4.6
 *
 * @param codeVerifier - Code verifier from token request
 * @param codeChallenge - Code challenge from authorization request
 * @returns Promise<boolean> - True if verification succeeds
 */
async function verifyPKCE(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  // Validate code_verifier format (43-128 characters, unreserved characters per RFC 7636)
  // RFC 7636 Section 4.1: code_verifier = 43*128unreserved
  // unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
  const codeVerifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
  if (!codeVerifierPattern.test(codeVerifier)) {
    return false;
  }

  // Hash code_verifier with SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to base64url
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const base64 = btoa(String.fromCharCode(...hashArray));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Compare with code_challenge
  return base64url === codeChallenge;
}

/**
 * Handle JWT Bearer Grant (RFC 7523)
 * https://datatracker.ietf.org/doc/html/rfc7523
 *
 * Service-to-service authentication using JWT assertions
 */
async function handleJWTBearerGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const assertion = formData.assertion;
  const scope = formData.scope;

  // Validate assertion parameter
  if (!assertion) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameter: assertion',
      },
      400
    );
  }

  // Parse trusted issuers from environment
  const trustedIssuers = parseTrustedIssuers(c.env.TRUSTED_JWT_ISSUERS);

  if (trustedIssuers.size === 0) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'JWT Bearer grant is not configured (no trusted issuers)',
      },
      500
    );
  }

  // Validate JWT assertion
  const validation = await validateJWTBearerAssertion(assertion, c.env.ISSUER_URL, trustedIssuers);

  if (!validation.valid || !validation.claims) {
    return c.json(
      {
        error: validation.error || 'invalid_grant',
        error_description: validation.error_description || 'JWT assertion validation failed',
      },
      400
    );
  }

  const claims = validation.claims;

  // Determine scope: use requested scope or scope from assertion
  let grantedScope = scope || claims.scope || 'openid';

  // Validate scope against allowed scopes for the issuer
  const trustedIssuer = trustedIssuers.get(claims.iss);
  if (trustedIssuer?.allowed_scopes) {
    const requestedScopes = grantedScope.split(' ');
    const hasDisallowedScope = requestedScopes.some(
      (s) => !trustedIssuer.allowed_scopes?.includes(s)
    );

    if (hasDisallowedScope) {
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'Requested scope is not allowed for this issuer',
        },
        400
      );
    }
  }

  // Load private key for signing tokens from KeyManager
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key from KeyManager:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // Generate Access Token
  // For JWT Bearer flow, the subject (sub) comes from the assertion
  const accessTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: claims.sub, // Subject from JWT assertion
    aud: c.env.ISSUER_URL,
    scope: grantedScope,
    client_id: claims.iss, // Issuer acts as client_id for service accounts
  };

  let accessToken: string;
  try {
    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
  } catch (error) {
    console.error('Failed to create access token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // JWT Bearer flow typically does NOT issue ID tokens or refresh tokens
  // It's for service-to-service authentication, not user authentication
  // Only access token is returned

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: grantedScope,
  });
}

/**
 * Handle Device Code Grant
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.4
 */
async function handleDeviceCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const deviceCode = formData.device_code;
  const client_id = formData.client_id;

  // Validate required parameters
  if (!deviceCode) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'device_code is required',
      },
      400
    );
  }

  if (!client_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'client_id is required',
      },
      400
    );
  }

  // Get device code metadata from DeviceCodeStore
  const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName('global');
  const deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);

  // Update poll time (for rate limiting)
  try {
    await deviceCodeStore.fetch(
      new Request('https://internal/update-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })
    );
  } catch (error) {
    console.error('Failed to update poll time:', error);
  }

  // Get device code metadata
  const getResponse = await deviceCodeStore.fetch(
    new Request('https://internal/get-by-device-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    })
  );

  const metadata = (await getResponse.json()) as {
    device_code: string;
    user_code: string;
    client_id: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    sub?: string;
    user_id?: string;
    last_poll_at?: number;
    poll_count?: number;
    created_at: number;
    expires_at: number;
  };

  if (!metadata || !metadata.device_code) {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'Device code has expired or is invalid',
      },
      400
    );
  }

  // Check if device code is for the correct client
  if (metadata.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code does not belong to this client',
      },
      400
    );
  }

  // Check status and return appropriate response
  if (metadata.status === 'pending') {
    // User has not yet approved - check if polling too fast
    const { isDeviceFlowPollingTooFast, DEVICE_FLOW_CONSTANTS } = await import('@authrim/shared');

    if (isDeviceFlowPollingTooFast(metadata, DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL)) {
      return c.json(
        {
          error: 'slow_down',
          error_description: 'You are polling too frequently. Please slow down.',
        },
        400
      );
    }

    return c.json(
      {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the device',
      },
      400
    );
  }

  if (metadata.status === 'denied') {
    // Delete the device code (it's been denied)
    await deviceCodeStore.fetch(
      new Request('https://internal/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })
    );

    return c.json(
      {
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      },
      403
    );
  }

  if (metadata.status === 'expired') {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'Device code has expired',
      },
      400
    );
  }

  // Status is 'approved' - issue tokens
  if (metadata.status !== 'approved' || !metadata.sub) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code is not approved',
      },
      400
    );
  }

  // Delete the device code (one-time use)
  await deviceCodeStore.fetch(
    new Request('https://internal/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    })
  );

  // Get private key for signing tokens
  let privateKey: CryptoKey;
  let keyId: string;
  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    console.error('Failed to get signing key:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing keys',
      },
      500
    );
  }

  const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);

  // Phase 2 RBAC: Fetch RBAC claims for device flow tokens
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(c.env.DB, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ACCESS_TOKEN_CLAIMS,
      }),
      getIDTokenRBACClaims(c.env.DB, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ID_TOKEN_CLAIMS,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    console.warn('Failed to fetch RBAC claims for device flow:', rbacError);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && metadata.scope && metadata.sub) {
      policyEmbeddingPermissions = await evaluatePermissionsForScope(
        c.env.DB,
        metadata.sub,
        metadata.scope,
        { cache: c.env.REBAC_CACHE }
      );
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    console.warn('Failed to evaluate policy permissions for device flow:', policyError);
  }

  // Generate ID Token
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub,
    aud: client_id,
    nonce: undefined, // Device flow doesn't use nonce
    auth_time: Math.floor(Date.now() / 1000),
    // Phase 2 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
  };

  let idToken: string;
  try {
    idToken = await createIDToken(
      idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
      privateKey,
      keyId,
      expiresIn
    );
  } catch (error) {
    console.error('Failed to create ID token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Generate Access Token
  const accessTokenClaims: {
    iss: string;
    sub: string | undefined;
    aud: string;
    scope: string | undefined;
    client_id: string;
    authrim_permissions?: string[];
    [key: string]: unknown;
  } = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub,
    aud: c.env.ISSUER_URL,
    scope: metadata.scope,
    client_id,
    // Phase 2 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }

  let accessToken: string;
  try {
    const result = await createAccessToken(accessTokenClaims, privateKey, keyId, expiresIn);
    accessToken = result.token;
  } catch (error) {
    console.error('Failed to create access token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Generate Refresh Token
  const refreshTokenExpiry = parseInt(c.env.REFRESH_TOKEN_EXPIRY, 10);
  let refreshToken: string;
  let refreshJti: string;
  try {
    const refreshTokenClaims = {
      sub: metadata.sub!,
      scope: metadata.scope,
      client_id,
    };
    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiry
    );
    refreshToken = result.token;
    refreshJti = result.jti;

    await storeRefreshToken(c.env, refreshJti, {
      jti: refreshJti,
      client_id,
      sub: metadata.sub!,
      scope: metadata.scope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + refreshTokenExpiry,
    });
  } catch (error) {
    console.error('Failed to create refresh token:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create refresh token',
      },
      500
    );
  }

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: metadata.scope,
  });
}

/**
 * Handle CIBA Grant
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html#token_endpoint
 */
async function handleCIBAGrant(c: Context<{ Bindings: Env }>, formData: Record<string, string>) {
  const authReqId = formData.auth_req_id;
  const client_id = formData.client_id;

  // Validate required parameters
  if (!authReqId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'auth_req_id is required',
      },
      400
    );
  }

  if (!client_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'client_id is required',
      },
      400
    );
  }

  // Get CIBA request metadata from CIBARequestStore
  const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
  const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

  // Update poll time (for rate limiting in poll mode)
  try {
    await cibaRequestStore.fetch(
      new Request('https://internal/update-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );
  } catch (error) {
    console.error('Failed to update poll time:', error);
  }

  // Get CIBA request metadata
  const getResponse = await cibaRequestStore.fetch(
    new Request('https://internal/get-by-auth-req-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  const metadata = (await getResponse.json()) as {
    auth_req_id: string;
    client_id: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    delivery_mode: 'poll' | 'ping' | 'push';
    interval: number;
    sub?: string;
    user_id?: string;
    nonce?: string;
    last_poll_at?: number;
    poll_count?: number;
    created_at: number;
    expires_at: number;
    token_issued?: boolean;
  };

  if (!metadata || !metadata.auth_req_id) {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'CIBA request has expired or is invalid',
      },
      400
    );
  }

  // Check if auth_req_id is for the correct client
  if (metadata.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'auth_req_id does not belong to this client',
      },
      400
    );
  }

  // Check if tokens have already been issued (one-time use)
  if (metadata.token_issued) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Tokens have already been issued for this auth_req_id',
      },
      400
    );
  }

  // Check status and return appropriate response
  if (metadata.status === 'pending') {
    // User has not yet approved - check if polling too fast (poll mode only)
    if (metadata.delivery_mode === 'poll') {
      const { isPollingTooFast } = await import('@authrim/shared');

      if (isPollingTooFast(metadata)) {
        return c.json(
          {
            error: 'slow_down',
            error_description: 'You are polling too frequently. Please slow down.',
          },
          400
        );
      }
    }

    return c.json(
      {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the authentication request',
      },
      400
    );
  }

  if (metadata.status === 'denied') {
    // Delete the CIBA request (it's been denied)
    await cibaRequestStore.fetch(
      new Request('https://internal/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );

    return c.json(
      {
        error: 'access_denied',
        error_description: 'User denied the authentication request',
      },
      403
    );
  }

  if (metadata.status === 'expired') {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'CIBA request has expired',
      },
      400
    );
  }

  // Status is 'approved' - issue tokens
  if (metadata.status !== 'approved' || !metadata.sub) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'CIBA request is not approved',
      },
      400
    );
  }

  // Mark tokens as issued (one-time use enforcement)
  const markIssuedResponse = await cibaRequestStore.fetch(
    new Request('https://internal/mark-token-issued', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  if (!markIssuedResponse.ok) {
    const error = (await markIssuedResponse.json()) as any;
    console.error('Failed to mark tokens as issued:', error);
    // If tokens were already issued, return error
    if (error.error_description?.includes('already issued')) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Tokens have already been issued for this auth_req_id',
        },
        400
      );
    }
  }

  // Get user data for token claims (using cache for performance)
  // Note: metadata.sub is guaranteed to exist due to the check at line 2340
  const user = await getCachedUser(c.env, metadata.sub);

  if (!user) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'User not found',
      },
      500
    );
  }

  // Get client metadata for encryption settings
  const clientMetadata = await getClient(c.env, metadata.client_id);

  if (!clientMetadata) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      400
    );
  }

  // Get signing key from KeyManager
  const { privateKey, kid } = await getSigningKeyFromKeyManager(c.env);

  // Extract DPoP proof if present
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  let dpopJkt: string | undefined;

  // Validate DPoP proof if provided
  if (dpopProof) {
    const { validateDPoPProof: validateDPoP } = await import('@authrim/shared');
    const dpopValidation = await validateDPoP(dpopProof, 'POST', c.env.ISSUER_URL + '/token');

    if (dpopValidation.valid && dpopValidation.jkt) {
      dpopJkt = dpopValidation.jkt;
    }
  }

  // Token expiration times
  const expiresIn = parseInt(c.env.TOKEN_EXPIRY || '3600', 10);
  const refreshExpiresIn = parseInt(c.env.REFRESH_TOKEN_EXPIRY || '2592000', 10);

  // Phase 2 RBAC: Fetch RBAC claims for CIBA flow tokens
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(c.env.DB, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ACCESS_TOKEN_CLAIMS,
      }),
      getIDTokenRBACClaims(c.env.DB, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: c.env.RBAC_ID_TOKEN_CLAIMS,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    console.warn('Failed to fetch RBAC claims for CIBA flow:', rbacError);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && metadata.scope && metadata.sub) {
      policyEmbeddingPermissions = await evaluatePermissionsForScope(
        c.env.DB,
        metadata.sub,
        metadata.scope,
        { cache: c.env.REBAC_CACHE }
      );
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    console.warn('Failed to evaluate policy permissions for CIBA flow:', policyError);
  }

  // Create Access Token FIRST (needed for at_hash in ID token)
  const accessTokenClaims: {
    iss: string;
    sub: string;
    aud: string;
    scope: string | undefined;
    client_id: string;
    cnf?: { jkt: string };
    authrim_permissions?: string[];
    [key: string]: unknown;
  } = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub!,
    aud: c.env.ISSUER_URL,
    scope: metadata.scope,
    client_id: metadata.client_id,
    ...(dpopJkt && { cnf: { jkt: dpopJkt } }),
    // Phase 2 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }

  const { token: accessToken, jti: tokenJti } = await createAccessToken(
    accessTokenClaims,
    privateKey,
    kid,
    expiresIn
  );

  // Calculate at_hash for ID token
  const atHash = await calculateAtHash(accessToken);

  // Create ID token with at_hash
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub!,
    aud: metadata.client_id,
    ...(metadata.nonce && { nonce: metadata.nonce }),
    at_hash: atHash,
    // Phase 2 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
  };

  let idToken = await createIDToken(idTokenClaims, privateKey, kid, expiresIn);

  // Encrypt ID token if required
  if (isIDTokenEncryptionRequired(clientMetadata)) {
    const clientPublicKey = await getClientPublicKey(clientMetadata);

    if (!clientPublicKey) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Client encryption key not available',
        },
        500
      );
    }

    const alg = clientMetadata.id_token_encrypted_response_alg as JWEAlgorithm;
    const enc = clientMetadata.id_token_encrypted_response_enc as JWEEncryption;

    if (!validateJWEOptions(alg, enc)) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Invalid JWE algorithm or encryption method',
        },
        500
      );
    }

    idToken = await encryptJWT(idToken, clientPublicKey, { alg, enc });
  }

  // Create Refresh Token
  const refreshTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub!,
    aud: c.env.ISSUER_URL,
    client_id: metadata.client_id,
    scope: metadata.scope,
  };

  const { token: refreshToken, jti: refreshTokenJti } = await createRefreshToken(
    refreshTokenClaims,
    privateKey,
    kid,
    refreshExpiresIn
  );

  // Store refresh token in KV
  await storeRefreshToken(c.env, refreshTokenJti, {
    client_id: metadata.client_id,
    sub: metadata.sub!,
    scope: metadata.scope,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + refreshExpiresIn,
    jti: refreshTokenJti,
  });

  // Delete the CIBA request after successful token issuance
  await cibaRequestStore.fetch(
    new Request('https://internal/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: metadata.scope,
  });
}

/**
 * Record token family in D1 for user-wide revocation support (V3 Sharding)
 *
 * This is a non-blocking operation that records the token family in D1's
 * user_token_families table. This enables efficient user-wide token revocation
 * by allowing the admin API to query all token families for a user.
 *
 * Note: This is fire-and-forget for performance. Failure does not affect
 * token issuance, but may impact user-wide revocation functionality.
 */
async function recordTokenFamilyInD1(
  env: Env,
  jti: string,
  userId: string,
  clientId: string,
  generation: number,
  ttlSeconds: number
): Promise<void> {
  if (!env.DB) {
    return;
  }

  try {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    await env.DB.prepare(
      `INSERT INTO user_token_families (jti, tenant_id, user_id, client_id, generation, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (jti) DO NOTHING`
    )
      .bind(jti, 'default', userId, clientId, generation, expiresAt)
      .run();
  } catch (error) {
    // Log but don't fail - this is a non-critical operation
    console.error('Failed to record token family in D1:', error);
  }
}

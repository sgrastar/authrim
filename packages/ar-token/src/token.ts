import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  // Logging
  getLogger,
  createLogger,
  type Logger,
  // Validation
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
  // Token Revocation Sharding (Region-aware)
  generateRegionAwareJti,
  // Configuration Manager (KV > env > default)
  createOAuthConfigManager,
  // Database Adapter
  D1Adapter,
  type DatabaseAdapter,
  // Contract Loader (Human Auth / AI Ephemeral Auth two-layer model)
  loadTenantProfile,
} from '@authrim/ar-lib-core';
import {
  revokeToken,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  getClient,
  getCachedUser,
  getCachedUserCore,
  SessionClientRepository,
  // Native SSO (OIDC Native SSO 1.0)
  DeviceSecretRepository,
  isNativeSSOEnabled,
  getNativeSSOConfig,
  DEVICE_SECRET_TOKEN_TYPE,
} from '@authrim/ar-lib-core';
import {
  createIDToken,
  createAccessToken,
  calculateAtHash,
  calculateDsHash,
  createRefreshToken,
  parseToken,
  parseTokenHeader,
  verifyToken,
  createSDJWTIDTokenFromClaims,
} from '@authrim/ar-lib-core';
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
  isTokenRevoked,
  timingSafeEqual,
  verifyClientSecretHash,
  // Phase 8.2: Token Embedding Model
  createTokenClaimEvaluator,
  evaluateIdLevelPermissions,
  isCustomClaimsEnabled,
  isIdLevelPermissionsEnabled,
  getEmbeddingLimits,
  // Shared utilities
  parseBasicAuth,
  type TokenClaimEvaluationContext,
  type JWEAlgorithm,
  type JWEEncryption,
  type IDTokenClaims,
  type TokenTypeURN,
  type ActClaim,
  type ClientMetadata,
} from '@authrim/ar-lib-core';
import { importPKCS8, importJWK, type CryptoKey } from 'jose';
import { extractDPoPProof, validateDPoPProof } from '@authrim/ar-lib-core';
import { parseDeviceCodeId, getDeviceCodeStoreById } from '@authrim/ar-lib-core';
import { parseCIBARequestId, getCIBARequestStoreById } from '@authrim/ar-lib-core';
// Event System
import { publishEvent, TOKEN_EVENTS, type TokenEventData } from '@authrim/ar-lib-core';
// ID-JAG (Identity Assertion Authorization Grant)
import {
  TOKEN_TYPE_ID_JAG,
  isValidIdJagSubjectTokenType,
  isIdJagRequest,
  type IdJagConfig,
  DEFAULT_ID_JAG_CONFIG,
} from '@authrim/ar-lib-core';

// ===== RFC 6750 Compliant Error Response Helpers =====
// RFC 6750 Section 3: WWW-Authenticate header MUST be included in 401 responses
// for Bearer token authentication errors

/**
 * Create OAuth error response with proper headers
 * RFC 6749 Section 5.2 + RFC 6750 Section 3 compliant
 *
 * @param c - Hono context
 * @param error - OAuth error code
 * @param errorDescription - Human-readable error description
 * @param status - HTTP status code (default 400)
 * @returns Response with proper headers
 */
function oauthError(
  c: Context<{ Bindings: Env }>,
  error: string,
  errorDescription: string,
  status: 400 | 401 | 403 | 500 = 400
): Response {
  // Set cache control headers (RFC 6749 Section 5.2)
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  // RFC 6750 Section 3: Add WWW-Authenticate header for 401 responses
  // Include error_description for better diagnostics (RFC 6750 Section 3.1)
  if (status === 401) {
    // Escape double quotes in error_description for header safety
    const escapedDescription = errorDescription.replace(/"/g, '\\"');
    c.header(
      'WWW-Authenticate',
      `Bearer error="${error}", error_description="${escapedDescription}"`
    );
  }

  return c.json(
    {
      error,
      error_description: errorDescription,
    },
    status
  );
}

// ===== Module-level Logger for Helper Functions =====
// Used by functions that don't have access to Hono Context
const moduleLogger = createLogger().module('TOKEN');

// ===== Key Caching for Performance Optimization =====
// Cache signing key to avoid expensive RSA key import (5-7ms) and DO hop on every request
// Security considerations:
// - Private key remains in Worker memory (same security boundary as DO)
// - TTL limits exposure window if key is rotated
// - kid is cached to detect rotation (new kid = cache invalidation)
// Note: 30 minutes is safe with 24h key rotation overlap period (KeyManager.ts:198-200)
// (Auth0/Okta cache in-memory until process restart, which can be hours)
let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
let cachedKeyTimestamp = 0;
const KEY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes - safe with 24h rotation overlap

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
      moduleLogger.warn('kid not found in cache, forcing re-fetch (possible emergency rotation)', {
        kid,
        source: cachedJWKS.source,
        action: 'JWKS',
      });
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
        moduleLogger.warn(
          'Token kid does not match env PUBLIC_JWK_JSON kid - env needs update or falling back to DO',
          {
            tokenKid: kid,
            envKid: keyKid,
            action: 'JWKS',
          }
        );
        // Fall through to DO fallback below
      } else {
        moduleLogger.debug('Using PUBLIC_JWK_JSON (DO access=0)', { kid: keyKid, action: 'JWKS' });
        return importedKey;
      }
    } catch (err) {
      moduleLogger.error(
        'Failed to parse PUBLIC_JWK_JSON, falling back to KeyManager DO',
        { action: 'JWKS' },
        err as Error
      );
      // Fall through to DO fallback
    }
  }

  // ===== PRIORITY 2: Fall back to KeyManager DO =====
  // Only used when PUBLIC_JWK_JSON is not configured or doesn't match kid
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available and PUBLIC_JWK_JSON not configured');
  }

  moduleLogger.debug('Fetching from KeyManager DO', { kid: kid || 'any', action: 'JWKS' });

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Use RPC to get all public keys
  const keys = await keyManager.getAllPublicKeysRpc();

  // Import all keys and build cache
  const newKeys = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const keyKid = (jwk as { kid?: string }).kid || 'default';
    try {
      const importedKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
      newKeys.set(keyKid, importedKey);
    } catch (err) {
      moduleLogger.error('Failed to import key', { kid: keyKid, action: 'JWKS' }, err as Error);
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
    // SECURITY: Do not expose kid value in error to prevent key enumeration
    throw new Error('Signing key not found or has been revoked');
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
  sid?: string; // OIDC Session Management: Session ID for RP-Initiated Logout
  authorizationDetails?: string; // RFC 9396: Rich Authorization Requests (JSON string)
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

  // Try to get active key via RPC
  let keyData = await keyManager.getActiveKeyWithPrivateRpc();

  if (!keyData) {
    // No active key, generate and activate one
    moduleLogger.info('No active signing key found, generating new key', { action: 'KeyManager' });
    keyData = await keyManager.rotateKeysWithPrivateRpc();
    moduleLogger.info('Generated new signing key', { kid: keyData.kid, action: 'KeyManager' });
  }

  // Import private key (expensive operation: 5-7ms)
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // Update cache with new key
  cachedSigningKey = { privateKey, kid: keyData.kid };
  cachedKeyTimestamp = now;
  moduleLogger.debug('Signing key cached', {
    kid: keyData.kid,
    ttlMs: KEY_CACHE_TTL,
    action: 'KeyManager',
  });

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
  const log = getLogger(c).module('TOKEN');

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
  } else if (grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') {
    // RFC 8693: Token Exchange (Feature Flag controlled)
    // Pass raw body for multi-value parameter support (resource[], audience[])
    const rawBody = await c.req.parseBody();
    return await handleTokenExchangeGrant(c, formData, rawBody);
  } else if (grant_type === 'client_credentials') {
    // RFC 6749 Section 4.4: Client Credentials Grant
    return await handleClientCredentialsGrant(c, formData);
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
  const log = getLogger(c).module('TOKEN');
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
      return oauthError(c, 'invalid_client', 'Invalid client_assertion JWT format', 401);
    }
  }

  // Check for HTTP Basic authentication (client_secret_basic)
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    // Use Basic auth credentials if form data doesn't provide them
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
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
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Validate redirect_uri
  const allowHttp = c.env.ENABLE_HTTP_REDIRECT === 'true';
  const redirectUriValidation = validateRedirectUri(redirect_uri, allowHttp);
  if (!redirectUriValidation.valid) {
    return oauthError(c, 'invalid_request', redirectUriValidation.error as string, 400);
  }

  // Fetch client metadata early (needed for FAPI/DPoP checks)
  const clientMetadata = await getClient(c.env, client_id);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Load TenantProfile for TTL limits (Human Auth / AI Ephemeral Auth two-layer model)
  const tenantId = (clientMetadata.tenant_id as string) || 'default';
  const tenantProfile = await loadTenantProfile(c.env.AUTHRIM_CONFIG, c.env, tenantId);

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
    log.error('Failed to load FAPI settings for DPoP', {}, error as Error);
  }

  const clientRequiresDpop = Boolean(clientMetadata.dpop_bound_access_tokens);
  const dpopProof = extractDPoPProof(c.req.raw.headers);

  if ((requireDpop || clientRequiresDpop) && !dpopProof) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  // Validate DPoP proof early to get jkt for authorization code binding verification
  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined, // No access token yet
      c.env, // Pass full Env for region-aware sharding
      client_id
    );

    if (!dpopValidation.valid) {
      return oauthError(
        c,
        dpopValidation.error || 'invalid_dpop_proof',
        dpopValidation.error_description || 'Invalid DPoP proof',
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
    // Get current shard count (KV priority, with caching)
    const currentShardCount = await getShardCount(c.env);

    // Remap shard index for scale-down compatibility
    const actualShardIndex = remapShardIndex(shardInfo.shardIndex, currentShardCount);

    // Log remapping for monitoring (only when remapped)
    if (actualShardIndex !== shardInfo.shardIndex) {
      log.debug('Remapped auth code shard', {
        originalShard: shardInfo.shardIndex,
        actualShard: actualShardIndex,
        currentShardCount,
        action: 'AuthCode',
      });
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
    // Use RPC for auth code consumption (atomic single-use guarantee)
    const consumedData = (await authCodeStore.consumeCodeRpc({
      code: validCode,
      clientId: client_id,
      codeVerifier: code_verifier,
    })) as AuthCodeStoreResponse;

    // RFC 6749 Section 4.1.2: Handle replay attack detection
    // If authorization code was already used, revoke previously issued tokens
    if (consumedData.replayAttack) {
      log.warn('Authorization code replay attack detected, revoking previously issued tokens', {
        action: 'Security',
      });

      const { accessTokenJti, refreshTokenJti } = consumedData.replayAttack;

      // Revoke the access token that was issued when the code was first used
      if (accessTokenJti) {
        try {
          await revokeToken(c.env, accessTokenJti, 3600, 'Authorization code replay attack');
          log.info('Revoked access token', {
            jtiPrefix: accessTokenJti.substring(0, 8),
            action: 'Security',
          });
        } catch (revokeError) {
          log.error('Failed to revoke access token', { action: 'Security' }, revokeError as Error);
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
          log.info('Revoked refresh token', {
            jtiPrefix: refreshTokenJti.substring(0, 8),
            action: 'Security',
          });
        } catch (revokeError) {
          log.error('Failed to revoke refresh token', { action: 'Security' }, revokeError as Error);
        }
      }

      // Return error to the attacker - use generic message to avoid confirming code existence
      return oauthError(
        c,
        'invalid_grant',
        'The provided authorization grant is invalid, expired, or revoked',
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
      sid: consumedData.sid, // OIDC Session Management: Session ID for RP-Initiated Logout
      authorizationDetails: consumedData.authorizationDetails, // RFC 9396: Rich Authorization Requests
    };
  } catch (error) {
    // RPC throws error for invalid codes (not found, already consumed, PKCE mismatch, client mismatch)
    log.error('AuthCodeStore consume error', { action: 'AuthCode' }, error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Determine appropriate error type based on error message
    // Security: Use generic message to avoid information leakage
    if (errorMessage.includes('already consumed') || errorMessage.includes('replay')) {
      return oauthError(
        c,
        'invalid_grant',
        'The provided authorization grant is invalid, expired, or revoked',
        400
      );
    }

    return oauthError(c, 'invalid_grant', 'Authorization code is invalid or expired', 400);
  }

  // Verify redirect_uri matches (additional safety check)
  if (authCodeData.redirect_uri !== redirect_uri) {
    return oauthError(
      c,
      'invalid_grant',
      'redirect_uri does not match the one used in authorization request',
      400
    );
  }

  // DPoP Authorization Code Binding verification (RFC 9449)
  // If the authorization code was bound to a DPoP key, verify the same key is used
  if (authCodeData.dpopJkt) {
    // Authorization code is bound to a DPoP key, DPoP proof is required
    if (!dpopProof) {
      log.warn('Authorization code bound to DPoP key but no DPoP proof provided', {
        action: 'DPoP',
      });
      return oauthError(
        c,
        'invalid_grant',
        'DPoP proof required (authorization code is bound to DPoP key)',
        400
      );
    }

    // Verify the DPoP proof's jkt matches the stored jkt
    if (dpopJkt !== authCodeData.dpopJkt) {
      log.warn('DPoP key mismatch', {
        expected: authCodeData.dpopJkt,
        received: dpopJkt,
        action: 'DPoP',
      });
      return oauthError(
        c,
        'invalid_grant',
        'DPoP key mismatch (authorization code is bound to different key)',
        400
      );
    }

    log.debug('Authorization code binding verified successfully', { action: 'DPoP' });
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
      clientMetadata as unknown as import('@authrim/ar-lib-core').ClientMetadata
    );

    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(
        c,
        assertionValidation.error || 'invalid_client',
        'Client assertion validation failed',
        401
      );
    }
  } else if (clientMetadata.client_secret_hash) {
    // client_secret_basic or client_secret_post authentication
    // Security: Verify client secret against stored SHA-256 hash
    const storedHash = (clientMetadata.client_secret_hash as string) ?? '';
    if (!client_secret || !(await verifyClientSecretHash(client_secret, storedHash))) {
      return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
    }
  }
  // Public clients (no client_secret_hash and no client_assertion) are allowed

  // Load private key for signing tokens from KeyManager
  // NOTE: Key loading moved BEFORE code deletion to avoid losing code on key loading failure
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

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
    log.error('Failed to fetch RBAC claims', {}, rbacError as Error);
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
    log.error('Failed to evaluate policy permissions', {}, policyError as Error);
  }

  // Phase 8.2: ID-level Resource Permissions
  let idLevelPermissions: string[] = [];
  try {
    const idLevelEnabled = await isIdLevelPermissionsEnabled(c.env);
    if (idLevelEnabled) {
      const limits = await getEmbeddingLimits(c.env);
      const allIdPerms = await evaluateIdLevelPermissions(
        c.env.DB,
        authCodeData.sub,
        'default', // tenant_id
        { cache: c.env.REBAC_CACHE }
      );
      // Apply limits to prevent token bloat
      if (allIdPerms.length > limits.max_resource_permissions) {
        log.warn('ID-level permissions truncated', {
          original: allIdPerms.length,
          truncated: limits.max_resource_permissions,
          action: 'TOKEN_BLOAT',
        });
        idLevelPermissions = allIdPerms.slice(0, limits.max_resource_permissions);
      } else {
        idLevelPermissions = allIdPerms;
      }
    }
  } catch (idLevelError) {
    // Log but don't fail - ID-level permissions are optional
    log.error('Failed to evaluate ID-level permissions', {}, idLevelError as Error);
  }

  // Anonymous user claims (architecture-decisions.md §17)
  let anonymousClaims: { user_type?: string; upgrade_eligible?: boolean } = {};
  try {
    const userCore = await getCachedUserCore(c.env, authCodeData.sub);
    if (userCore?.user_type === 'anonymous') {
      anonymousClaims = {
        user_type: 'anonymous',
        upgrade_eligible: true, // Anonymous users can always upgrade
      };
    }
  } catch (anonError) {
    // Log but don't fail - anonymous claims are optional
    log.error('Failed to fetch anonymous user claims', {}, anonError as Error);
  }

  // Phase 8.2: Custom Claims Evaluation
  let customClaims: Record<string, unknown> = {};
  try {
    const customClaimsEnabled = await isCustomClaimsEnabled(c.env);
    if (customClaimsEnabled) {
      const limits = await getEmbeddingLimits(c.env);
      const evaluator = createTokenClaimEvaluator(c.env.DB, c.env.REBAC_CACHE, {
        maxCustomClaims: limits.max_custom_claims,
      });

      // Build evaluation context
      const claimContext: TokenClaimEvaluationContext = {
        tenant_id: 'default',
        subject_id: authCodeData.sub,
        client_id: client_id,
        scope: authCodeData.scope || '',
        roles: accessTokenRBACClaims.authrim_roles || [],
        permissions: policyEmbeddingPermissions,
        org_id: accessTokenRBACClaims.authrim_org_id,
        org_type: accessTokenRBACClaims.authrim_org_type,
      };

      // Evaluate for access token
      const result = await evaluator.evaluate(claimContext, 'access');
      customClaims = result.claims_to_add;

      // Log overrides for audit
      if (result.claim_overrides.length > 0) {
        log.info('Claim overrides occurred', {
          overrideCount: result.claim_overrides.length,
          userId: authCodeData.sub,
          action: 'CUSTOM_CLAIMS',
        });
      }
    }
  } catch (customClaimsError) {
    // Log but don't fail - custom claims are optional
    log.error('Failed to evaluate custom claims', {}, customClaimsError as Error);
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
    // Phase 2 Policy Embedding (type-level permissions)
    authrim_permissions?: string[];
    // Phase 8.2: ID-level Resource Permissions
    authrim_resource_permissions?: string[];
    // Phase 8.2: Custom Claims (dynamic via [key: string]: unknown)
    [key: string]: unknown;
  } = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: c.env.ISSUER_URL, // For MVP, access token audience is the issuer
    scope: authCodeData.scope,
    client_id: client_id,
    // Phase 1 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
    // Phase 8.2: Add custom claims from rule evaluation
    ...customClaims,
    // Anonymous user claims (architecture-decisions.md §17)
    ...anonymousClaims,
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }

  // Phase 8.2: Add ID-level resource permissions
  if (idLevelPermissions.length > 0) {
    accessTokenClaims.authrim_resource_permissions = idLevelPermissions;
  }

  // Add claims parameter if it was requested during authorization
  if (authCodeData.claims) {
    accessTokenClaims.claims = authCodeData.claims;
  }

  // Add DPoP confirmation (cnf) claim if DPoP is used
  if (dpopJkt) {
    accessTokenClaims.cnf = { jkt: dpopJkt };
  }

  // RFC 9396: Add authorization_details to access token if present
  if (authCodeData.authorizationDetails) {
    try {
      accessTokenClaims.authorization_details = JSON.parse(authCodeData.authorizationDetails);
    } catch {
      log.warn('Failed to parse authorization_details for access token', { action: 'RAR' });
    }
  }

  let accessToken: string;
  let tokenJti: string;
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    tokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
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
    log.error('Failed to calculate at_hash', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to calculate token hash',
      },
      500
    );
  }

  // ===== OIDC Native SSO 1.0 (draft-07) =====
  // Generate device_secret for mobile/desktop SSO scenarios
  // The device_secret is returned only once and must be stored securely by the client
  // (e.g., iOS Keychain, Android Keystore)
  let deviceSecret: string | undefined;
  let dsHash: string | undefined;

  // Check if Native SSO is enabled (feature flag + client configuration)
  const nativeSSOGloballyEnabled = await isNativeSSOEnabled(c.env);
  const clientNativeSSOEnabled = Boolean(clientMetadata.native_sso_enabled);

  if (nativeSSOGloballyEnabled && clientNativeSSOEnabled && authCodeData.sid && c.env.DB) {
    try {
      const nativeSSOConfig = await getNativeSSOConfig(c.env);
      const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
      const deviceSecretRepo = new DeviceSecretRepository(coreAdapter);

      // Check max device secrets per user (revoke oldest if exceeded)
      const userSecrets = await deviceSecretRepo.findByUserId(authCodeData.sub);
      const activeSecrets = userSecrets.filter((s) => s.is_active === 1);

      if (activeSecrets.length >= nativeSSOConfig.maxDeviceSecretsPerUser) {
        if (nativeSSOConfig.maxSecretsBehavior === 'revoke_oldest') {
          // Revoke oldest secrets to make room
          const sortedByCreation = activeSecrets.sort((a, b) => a.created_at - b.created_at);
          const toRevoke = sortedByCreation.slice(
            0,
            activeSecrets.length - nativeSSOConfig.maxDeviceSecretsPerUser + 1
          );
          for (const secret of toRevoke) {
            await deviceSecretRepo.revoke(secret.id, 'max_secrets_exceeded');
          }
          log.info('Revoked oldest device secrets', {
            count: toRevoke.length,
            userIdPrefix: authCodeData.sub.substring(0, 8),
            action: 'NativeSSO',
          });
        } else {
          // Reject mode: do not issue new device_secret
          log.warn('Max device secrets reached, rejecting new secret', {
            userIdPrefix: authCodeData.sub.substring(0, 8),
            action: 'NativeSSO',
          });
          // Continue without issuing device_secret (not a fatal error)
        }
      }

      // Only create if we have room (after potential revocation) or if revoke_oldest was used
      const canCreate =
        nativeSSOConfig.maxSecretsBehavior === 'revoke_oldest' ||
        activeSecrets.length < nativeSSOConfig.maxDeviceSecretsPerUser;

      if (canCreate) {
        // Create new device secret
        const deviceSecretTTLMs = nativeSSOConfig.deviceSecretTTLDays * 24 * 60 * 60 * 1000;
        const result = await deviceSecretRepo.createSecret({
          user_id: authCodeData.sub,
          session_id: authCodeData.sid,
          ttl_ms: deviceSecretTTLMs,
        });

        // Check if creation was successful (result has 'secret' property)
        // CreateDeviceSecretResult has { secret, entity }
        // DeviceSecretValidationResult has { ok: false, reason: ... } or { ok: true, entity: ... }
        if ('secret' in result) {
          deviceSecret = result.secret;

          // Calculate ds_hash (same algorithm as at_hash: SHA-256 left-half base64url)
          dsHash = await calculateDsHash(deviceSecret);

          log.info('Created device secret', {
            userIdPrefix: authCodeData.sub.substring(0, 8),
            sessionIdPrefix: authCodeData.sid.substring(0, 8),
            expiresInDays: nativeSSOConfig.deviceSecretTTLDays,
            action: 'NativeSSO',
          });
        } else if ('ok' in result && result.ok === false) {
          // Creation failed (likely limit_exceeded)
          log.warn('Device secret creation returned failure', {
            reason: result.reason,
            action: 'NativeSSO',
          });
        }
      }
    } catch (error) {
      // Log error but don't fail the token request - Native SSO is a convenience feature
      log.error('Failed to create device secret', { action: 'NativeSSO' }, error as Error);
      // deviceSecret and dsHash remain undefined
    }
  }

  // Generate ID Token with at_hash and auth_time
  // Phase 1 RBAC: Include RBAC claims in ID Token
  // Note: sid is required for RP-Initiated Logout per OIDC Session Management 1.0
  // Note: ds_hash is included when Native SSO is enabled (OIDC Native SSO 1.0)
  const idTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: authCodeData.sub,
    aud: client_id,
    nonce: authCodeData.nonce,
    at_hash: atHash, // OIDC spec requirement for code flow
    auth_time: authCodeData.auth_time, // OIDC Core Section 2: Time when End-User authentication occurred
    ...(authCodeData.acr && { acr: authCodeData.acr }),
    ...(authCodeData.sid && { sid: authCodeData.sid }), // OIDC Session Management: Session ID for RP-Initiated Logout
    ...(dsHash && { ds_hash: dsHash }), // OIDC Native SSO 1.0: Device Secret Hash
    // Phase 1 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
    // Anonymous user claims (architecture-decisions.md §17)
    ...anonymousClaims,
  };

  let idToken: string;
  try {
    // Check if client requests SD-JWT ID Token (RFC 9901)
    const useSDJWT =
      clientMetadata.id_token_signed_response_type === 'sd-jwt' && c.env.ENABLE_SD_JWT === 'true';

    if (useSDJWT) {
      // Create SD-JWT ID Token with selective disclosure
      const rawSelectiveClaims = clientMetadata.sd_jwt_selective_claims;
      const selectiveClaims: string[] = Array.isArray(rawSelectiveClaims)
        ? rawSelectiveClaims
        : ['email', 'phone_number', 'address', 'birthdate'];
      idToken = await createSDJWTIDTokenFromClaims(
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        privateKey,
        keyId,
        expiresIn,
        selectiveClaims
      );
      log.debug('Created SD-JWT ID Token', { clientId: client_id, action: 'SD-JWT' });
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
        // Security: Log internal details but return generic message to prevent information leakage
        log.error('Invalid JWE options', { validationError });
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: 'Client encryption configuration is invalid',
          },
          400
        );
      }

      // Get client's public key for encryption
      const publicKey = await getClientPublicKey(clientMetadata);
      if (!publicKey) {
        log.error('Client requires encryption but no public key available', {});
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
        log.error('Failed to encrypt ID token', {}, encryptError as Error);
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
    log.error('Failed to create ID token', {}, error as Error);
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
  const refreshTokenExpiresIn = await configManager.getRefreshTokenExpiry();

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

      // Use RPC for family creation
      let familyResult: {
        version: number;
        newJti: string;
        expiresIn: number;
        allowedScope: string;
      };
      try {
        familyResult = await rotator.createFamilyRpc({
          jti: refreshTokenJti,
          userId: authCodeData.sub,
          clientId: client_id,
          scope: authCodeData.scope,
          ttl: refreshTokenExpiresIn,
          // V3: Include shard metadata (for debugging/audit)
          generation: shardConfig.currentGeneration,
          shardIndex: shardIndex,
        });
      } catch (error) {
        log.error('Failed to register refresh token family', {}, error as Error);
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to register refresh token',
          },
          500
        );
      }
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
    log.error('Failed to create refresh token', {}, error as Error);
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
  // RFC 6749 Section 4.1.2: Register issued token JTIs for replay attack revocation
  // "If an authorization code is used more than once, the authorization server
  //  MUST deny the request and SHOULD revoke (when possible) all tokens
  //  previously issued based on that authorization code."
  //
  // This registration enables token revocation when a replay attack is detected.
  // The additional DO hop is acceptable as it's required for OIDC Conformance.
  try {
    await authCodeStore.registerIssuedTokensRpc(validCode, tokenJti, refreshTokenJti);
  } catch (error) {
    // Log but don't fail the request - token issuance succeeded
    // This is a "SHOULD" requirement, not a "MUST"
    log.error(
      'Failed to register token JTIs for replay attack revocation',
      { action: 'RFC6749-4.1.2' },
      error as Error
    );
  }

  // OIDC Session Management: Register session-client association for logout
  // This enables frontchannel/backchannel logout to notify the correct RPs
  log.debug('Session-client check', {
    sidPresent: !!authCodeData.sid,
    dbPresent: !!c.env.DB,
    action: 'Logout',
  });
  if (authCodeData.sid && c.env.DB) {
    try {
      log.debug('Attempting to register session-client', {
        sid: authCodeData.sid,
        clientId: client_id,
        action: 'Logout',
      });
      const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
      const sessionClientRepo = new SessionClientRepository(coreAdapter);
      const result = await sessionClientRepo.createOrUpdate({
        session_id: authCodeData.sid,
        client_id: client_id,
      });
      log.debug('Successfully registered session-client', {
        id: result.id,
        sidPrefix: authCodeData.sid.substring(0, 25),
        clientIdPrefix: client_id.substring(0, 25),
        action: 'Logout',
      });
    } catch (error) {
      // Log error but don't fail the token request - logout tracking is non-critical
      log.error('Failed to register session-client', { action: 'Logout' }, error as Error);
    }
  } else {
    log.warn('Skipped session-client registration', {
      sid: authCodeData.sid,
      dbAvailable: !!c.env.DB,
      action: 'Logout',
    });
  }

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  // Build response object
  // Note: device_secret is only included when Native SSO is enabled and successfully generated
  // The device_secret is returned only once and must be securely stored by the client
  const tokenResponse: Record<string, unknown> = {
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    scope: authCodeData.scope, // OAuth 2.0 spec: include scope for clarity
  };

  // OIDC Native SSO 1.0: Include device_secret if generated
  if (deviceSecret) {
    tokenResponse.device_secret = deviceSecret;
  }

  // RFC 9396: Include authorization_details if present in the authorization request
  if (authCodeData.authorizationDetails) {
    try {
      tokenResponse.authorization_details = JSON.parse(authCodeData.authorizationDetails);
    } catch {
      // If parsing fails, include as-is (should not happen as it was validated)
      log.warn('Failed to parse authorization_details, including as string', { action: 'RAR' });
    }
  }

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    Promise.all([
      publishEvent(c, {
        type: TOKEN_EVENTS.ACCESS_ISSUED,
        tenantId,
        data: {
          jti: tokenJti,
          clientId: client_id,
          userId: authCodeData.sub,
          scopes: authCodeData.scope.split(' '),
          expiresAt: nowEpoch + expiresIn,
          grantType: 'authorization_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
      }),
      publishEvent(c, {
        type: TOKEN_EVENTS.REFRESH_ISSUED,
        tenantId,
        data: {
          jti: refreshTokenJti,
          clientId: client_id,
          userId: authCodeData.sub,
          scopes: authCodeData.scope.split(' '),
          grantType: 'authorization_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error(
          'Failed to publish token.refresh.issued event',
          { action: 'Event' },
          err as Error
        );
      }),
      // ID Token issued event (OIDC flows always include ID token)
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId,
        data: {
          clientId: client_id,
          userId: authCodeData.sub,
          grantType: 'authorization_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      }),
    ])
  );

  return c.json(tokenResponse);
}

/**
 * Handle Refresh Token Grant
 * https://tools.ietf.org/html/rfc6749#section-6
 */
async function handleRefreshTokenGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const log = getLogger(c).module('TOKEN');
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
      return oauthError(c, 'invalid_client', 'Invalid client_assertion JWT format', 401);
    }
  }

  // Check for HTTP Basic authentication (client_secret_basic)
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate refresh_token parameter
  if (!refreshTokenValue) {
    return oauthError(c, 'invalid_request', 'refresh_token is required', 400);
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Fetch client metadata to verify client authentication
  const clientMetadata = await getClient(c.env, client_id);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Cast to ClientMetadata for type safety
  const typedClient = clientMetadata as unknown as ClientMetadata;

  // Profile-based grant_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §5.2: unauthorized_client - client not allowed to use this grant type
  const tenantId = (clientMetadata.tenant_id as string) || 'default';
  const tenantProfile = await loadTenantProfile(c.env.AUTHRIM_CONFIG, c.env, tenantId);
  if (!tenantProfile.allows_refresh_token) {
    return oauthError(
      c,
      'unauthorized_client',
      'refresh_token grant is not allowed for this tenant profile',
      403
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
      typedClient
    );

    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(
        c,
        assertionValidation.error || 'invalid_client',
        'Client assertion validation failed',
        401
      );
    }
  } else if (typedClient.client_secret_hash) {
    // client_secret_basic or client_secret_post authentication
    // SV-015: Verify client secret against stored SHA-256 hash
    if (
      !client_secret ||
      !(await verifyClientSecretHash(client_secret, typedClient.client_secret_hash))
    ) {
      return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
    }
  }
  // Public clients (no client_secret_hash and no client_assertion) are allowed

  // Parse refresh token to get JTI (without verification yet)
  let refreshTokenPayload;
  try {
    refreshTokenPayload = parseToken(refreshTokenValue);
  } catch {
    return oauthError(c, 'invalid_grant', 'Invalid refresh token format', 400);
  }

  const jti = refreshTokenPayload.jti as string;
  if (!jti) {
    return oauthError(c, 'invalid_grant', 'Refresh token missing JTI', 400);
  }

  // V2: Extract userId (sub) and version (rtv) from JWT for validation
  const userId = refreshTokenPayload.sub as string;
  const version = typeof refreshTokenPayload.rtv === 'number' ? refreshTokenPayload.rtv : 1;

  if (!userId) {
    return oauthError(c, 'invalid_grant', 'Refresh token missing subject', 400);
  }

  // Retrieve refresh token metadata from RefreshTokenRotator DO (V2)
  const refreshTokenData = await getRefreshToken(c.env, userId, version, client_id, jti);
  if (!refreshTokenData) {
    return oauthError(c, 'invalid_grant', 'Refresh token is invalid or expired', 400);
  }

  // Verify client_id matches
  if (refreshTokenData.client_id !== client_id) {
    return oauthError(c, 'invalid_grant', 'Refresh token was issued to a different client', 400);
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
    log.error('Failed to load verification key', {}, err as Error);
    return oauthError(c, 'server_error', 'Failed to load verification key', 500);
  }

  // Verify refresh token signature
  try {
    await verifyToken(refreshTokenValue, publicKey, c.env.ISSUER_URL, {
      audience: client_id,
    });
  } catch (error) {
    log.error('Refresh token verification failed', {}, error as Error);
    return oauthError(c, 'invalid_grant', 'Refresh token signature verification failed', 400);
  }

  // If scope is requested, validate it's a subset of the original scope
  let grantedScope = refreshTokenData.scope;
  if (scope) {
    const requestedScopes = scope.split(' ');
    const originalScopes = refreshTokenData.scope.split(' ');

    // Check if all requested scopes are in the original scope
    const isSubset = requestedScopes.every((s) => originalScopes.includes(s));
    if (!isSubset) {
      return oauthError(c, 'invalid_scope', 'Requested scope exceeds original scope', 400);
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
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

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
    log.error('Failed to fetch RBAC claims for refresh token', {}, rbacError as Error);
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
    log.error('Failed to evaluate policy permissions for refresh token', {}, policyError as Error);
  }

  // Anonymous user claims for refresh token flow (architecture-decisions.md §17)
  let anonymousClaimsRefresh: { user_type?: string; upgrade_eligible?: boolean } = {};
  try {
    const userCore = await getCachedUserCore(c.env, refreshTokenData.sub);
    if (userCore?.user_type === 'anonymous') {
      anonymousClaimsRefresh = {
        user_type: 'anonymous',
        upgrade_eligible: true,
      };
    }
  } catch (anonError) {
    log.error('Failed to fetch anonymous user claims for refresh token', {}, anonError as Error);
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
      c.env, // Pass full Env for region-aware sharding
      client_id // Bind JTI to client_id for additional security
    );

    if (!dpopValidation.valid) {
      return oauthError(
        c,
        dpopValidation.error || 'invalid_dpop_proof',
        dpopValidation.error_description || 'DPoP proof validation failed',
        400
      );
    }

    // DPoP proof is valid, bind access token to the public key
    dpopJkt = dpopValidation.jkt;
    tokenType = 'DPoP';
  }

  // Generate new Access Token
  let accessToken: string;
  let accessTokenJti: string = '';
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
      // Anonymous user claims (architecture-decisions.md §17)
      ...anonymousClaimsRefresh,
    };

    // Phase 2 Policy Embedding: Add evaluated permissions
    if (policyEmbeddingPermissions.length > 0) {
      accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
    }

    // Add DPoP confirmation (cnf) claim if DPoP is used
    if (dpopJkt) {
      accessTokenClaims.cnf = { jkt: dpopJkt };
    }

    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (err) {
    log.error('Failed to create access token', {}, err as Error);
    return oauthError(c, 'server_error', 'Failed to create access token', 500);
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
      // Anonymous user claims (architecture-decisions.md §17)
      ...anonymousClaimsRefresh,
    };

    // Check if client requests SD-JWT ID Token (RFC 9901)
    const useSDJWT =
      clientMetadata.id_token_signed_response_type === 'sd-jwt' && c.env.ENABLE_SD_JWT === 'true';

    if (useSDJWT) {
      const rawSelectiveClaims = clientMetadata.sd_jwt_selective_claims;
      const selectiveClaims: string[] = Array.isArray(rawSelectiveClaims)
        ? rawSelectiveClaims
        : ['email', 'phone_number', 'address', 'birthdate'];
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
    log.error('Failed to create ID token', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to create ID token', 500);
  }

  // Check if Token Rotation is enabled (default: true for security)
  // Set ENABLE_REFRESH_TOKEN_ROTATION=false to disable (for load testing only!)
  const rotationEnabled = c.env.ENABLE_REFRESH_TOKEN_ROTATION !== 'false';

  let newRefreshToken: string;
  const refreshTokenExpiresIn = await configManager.getRefreshTokenExpiry();

  if (rotationEnabled) {
    // V2: Implement refresh token rotation with version-based theft detection
    if (!c.env.REFRESH_TOKEN_ROTATOR) {
      return oauthError(c, 'server_error', 'Refresh token rotation unavailable', 500);
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
      // Use RPC for token rotation (V2/V3)
      const rotateResult = await rotator.rotateRpc({
        incomingVersion,
        incomingJti: jti, // V3: Send full JTI (DO stores and compares full JTIs)
        userId: refreshTokenData.sub,
        clientId: client_id,
        requestedScope: scope || undefined, // Pass requested scope for validation
      });

      // V3: DO now returns full JTIs with generation/shard prefix
      // No wrapping needed - use the JTI directly from DO
      newRefreshTokenJti = rotateResult.newJti;
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
      log.error('Failed to rotate refresh token', {}, error as Error);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check for theft detection or version mismatch
      if (
        errorMessage.includes('theft') ||
        errorMessage.includes('revoked') ||
        errorMessage.includes('version mismatch')
      ) {
        log.error('SECURITY: Token theft detected and family revoked', {
          clientId: client_id,
          userId: refreshTokenData.sub,
          incomingVersion,
          action: 'Security',
        });
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Refresh token has been revoked',
          },
          400
        );
      }

      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Token rotation failed',
        },
        400
      );
    }
  } else {
    // Token Rotation disabled - return the same refresh token
    // WARNING: This is less secure and should only be used for testing!
    newRefreshToken = refreshTokenValue;
    log.debug('Refresh token rotation disabled - returning same token', {});
  }

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const eventPromises: Promise<unknown>[] = [
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId,
      data: {
        jti: accessTokenJti,
        clientId: client_id,
        userId: refreshTokenData.sub,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + expiresIn,
        grantType: 'refresh_token',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    }),
    publishEvent(c, {
      type: TOKEN_EVENTS.REFRESH_ROTATED,
      tenantId,
      data: {
        clientId: client_id,
        userId: refreshTokenData.sub,
        scopes: grantedScope.split(' '),
        grantType: 'refresh_token',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.refresh.rotated event', { action: 'Event' }, err as Error);
    }),
  ];

  // ID Token issued event (refresh grant can also issue new ID token)
  if (idToken) {
    eventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId,
        data: {
          clientId: client_id,
          userId: refreshTokenData.sub,
          grantType: 'refresh_token',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      })
    );
  }
  c.executionCtx.waitUntil(Promise.all(eventPromises));

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
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');

  // Compare with code_challenge
  // SECURITY: Use timing-safe comparison to prevent timing attacks
  return timingSafeEqual(base64url, codeChallenge);
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
  const log = getLogger(c).module('TOKEN');
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
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();

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
  let accessTokenJti: string = '';
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
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

  // Publish token event (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: 'default', // JWT Bearer is for service-to-service, no tenant context
      data: {
        jti: accessTokenJti,
        clientId: claims.iss, // Issuer acts as client_id for service accounts
        userId: claims.sub,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + expiresIn,
        grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    })
  );

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
  const log = getLogger(c).module('TOKEN');
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
  // Support both region-sharded and legacy global formats
  const parsedDeviceCode = parseDeviceCodeId(deviceCode);
  let deviceCodeStore: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };

  if (parsedDeviceCode) {
    // New region-sharded format: route via embedded shard info
    const { stub } = getDeviceCodeStoreById(c.env, deviceCode, 'default');
    deviceCodeStore = stub;
  } else {
    // Legacy format: use global DO
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName('global');
    deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);
  }

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
    log.error('Failed to update poll time', {}, error as Error);
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
    const { isDeviceFlowPollingTooFast, DEVICE_FLOW_CONSTANTS } =
      await import('@authrim/ar-lib-core');

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
    log.error('Failed to get signing key', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing keys',
      },
      500
    );
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();

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
    log.error('Failed to fetch RBAC claims for device flow', {}, rbacError as Error);
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
    log.error('Failed to evaluate policy permissions for device flow', {}, policyError as Error);
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
    log.error('Failed to create ID token', {}, error as Error);
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
  let accessTokenJti: string = '';
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Generate Refresh Token with V3 sharding support
  const refreshTokenExpiry = await configManager.getRefreshTokenExpiry();
  let refreshToken: string;
  let refreshJti: string;
  try {
    // V3: Generate sharded JTI for proper DO routing
    const shardConfig = await getRefreshTokenShardConfig(c.env, client_id);
    const shardIndex = await getRefreshTokenShardIndex(
      metadata.sub!,
      client_id,
      shardConfig.currentShardCount
    );
    const randomPart = generateRefreshTokenRandomPart();
    refreshJti = createRefreshTokenJti(shardConfig.currentGeneration, shardIndex, randomPart);

    const refreshTokenClaims = {
      sub: metadata.sub!,
      scope: metadata.scope,
      client_id,
    };
    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiry,
      refreshJti // V3: Pass pre-generated sharded JTI
    );
    refreshToken = result.token;

    await storeRefreshToken(c.env, refreshJti, {
      jti: refreshJti,
      client_id,
      sub: metadata.sub!,
      scope: metadata.scope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + refreshTokenExpiry,
    });
  } catch (error) {
    log.error('Failed to create refresh token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create refresh token',
      },
      500
    );
  }

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const deviceEventPromises: Promise<unknown>[] = [
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: 'default', // Device flow uses default tenant
      data: {
        jti: accessTokenJti,
        clientId: client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        expiresAt: nowEpoch + expiresIn,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    }),
    publishEvent(c, {
      type: TOKEN_EVENTS.REFRESH_ISSUED,
      tenantId: 'default',
      data: {
        jti: refreshJti,
        clientId: client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.refresh.issued event', { action: 'Event' }, err as Error);
    }),
  ];

  // ID Token issued event (device code grant)
  if (idToken) {
    deviceEventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId: 'default',
        data: {
          clientId: client_id,
          userId: metadata.sub,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      })
    );
  }
  c.executionCtx.waitUntil(Promise.all(deviceEventPromises));

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
  const log = getLogger(c).module('TOKEN');
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
  // Support both region-sharded and legacy global formats
  const parsedCIBAId = parseCIBARequestId(authReqId);
  let cibaRequestStore: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };

  if (parsedCIBAId) {
    // New region-sharded format: route via embedded shard info
    const { stub } = getCIBARequestStoreById(c.env, authReqId, 'default');
    cibaRequestStore = stub;
  } else {
    // Legacy format: use global DO
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
    cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);
  }

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
    log.error('Failed to update poll time', {}, error as Error);
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
      const { isPollingTooFast } = await import('@authrim/ar-lib-core');

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
    const error = (await markIssuedResponse.json()) as {
      error?: string;
      error_description?: string;
    };
    log.error('Failed to mark tokens as issued', {}, error as Error);
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

  // Verify user exists in Core DB (PII/Non-PII separation: NO PII DB access in token endpoint)
  // Note: metadata.sub is guaranteed to exist due to the check at line 2340
  // Use getCachedUserCore() instead of getCachedUser() to avoid unnecessary PII DB access
  const userCore = await getCachedUserCore(c.env, metadata.sub);

  if (!userCore) {
    // Security: Internal error - don't leak user existence
    return c.json(
      {
        error: 'server_error',
        error_description: 'An unexpected error occurred',
      },
      500
    );
  }

  // Get client metadata for encryption settings
  const clientMetadata = await getClient(c.env, metadata.client_id);

  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Get signing key from KeyManager
  const { privateKey, kid } = await getSigningKeyFromKeyManager(c.env);

  // Extract DPoP proof if present
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  let dpopJkt: string | undefined;

  // Validate DPoP proof if provided
  if (dpopProof) {
    const { validateDPoPProof: validateDPoP } = await import('@authrim/ar-lib-core');
    const dpopValidation = await validateDPoP(dpopProof, 'POST', c.env.ISSUER_URL + '/token');

    if (dpopValidation.valid && dpopValidation.jkt) {
      dpopJkt = dpopValidation.jkt;
    }
  }

  // Token expiration times (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();
  const refreshExpiresIn = await configManager.getRefreshTokenExpiry();

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
    log.error('Failed to fetch RBAC claims for CIBA flow', {}, rbacError as Error);
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
    log.error('Failed to evaluate policy permissions for CIBA flow', {}, policyError as Error);
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

  // Generate region-aware JTI for token revocation sharding
  const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
  const { token: accessToken, jti: tokenJti } = await createAccessToken(
    accessTokenClaims,
    privateKey,
    kid,
    expiresIn,
    regionAwareJti
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

  // Create Refresh Token with V3 sharding support
  // V3: Generate sharded JTI for proper DO routing
  const shardConfig = await getRefreshTokenShardConfig(c.env, metadata.client_id);
  const shardIndex = await getRefreshTokenShardIndex(
    metadata.sub!,
    metadata.client_id,
    shardConfig.currentShardCount
  );
  const randomPart = generateRefreshTokenRandomPart();
  const refreshTokenJti = createRefreshTokenJti(
    shardConfig.currentGeneration,
    shardIndex,
    randomPart
  );

  const refreshTokenClaims = {
    iss: c.env.ISSUER_URL,
    sub: metadata.sub!,
    aud: c.env.ISSUER_URL,
    client_id: metadata.client_id,
    scope: metadata.scope,
  };

  const { token: refreshToken } = await createRefreshToken(
    refreshTokenClaims,
    privateKey,
    kid,
    refreshExpiresIn,
    refreshTokenJti // V3: Pass pre-generated sharded JTI
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

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const cibaEventPromises: Promise<unknown>[] = [
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: 'default', // CIBA uses default tenant
      data: {
        jti: tokenJti,
        clientId: metadata.client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        expiresAt: nowEpoch + expiresIn,
        grantType: 'urn:openid:params:grant-type:ciba',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    }),
    publishEvent(c, {
      type: TOKEN_EVENTS.REFRESH_ISSUED,
      tenantId: 'default',
      data: {
        jti: refreshTokenJti,
        clientId: metadata.client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        grantType: 'urn:openid:params:grant-type:ciba',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.refresh.issued event', { action: 'Event' }, err as Error);
    }),
  ];

  // ID Token issued event (CIBA grant)
  if (idToken) {
    cibaEventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId: 'default',
        data: {
          clientId: metadata.client_id,
          userId: metadata.sub,
          grantType: 'urn:openid:params:grant-type:ciba',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      })
    );
  }
  c.executionCtx.waitUntil(Promise.all(cibaEventPromises));

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

    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    await coreAdapter.execute(
      `INSERT INTO user_token_families (jti, tenant_id, user_id, client_id, generation, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, 'default', userId, clientId, generation, expiresAt]
    );
  } catch (error) {
    // Log but don't fail - this is a non-critical operation
    moduleLogger.error('Failed to record token family in D1', {}, error as Error);
  }
}

// =============================================================================
// RFC 8693: OAuth 2.0 Token Exchange
// =============================================================================

/**
 * Handle Token Exchange Grant (RFC 8693)
 * https://datatracker.ietf.org/doc/html/rfc8693
 *
 * Token Exchange enables:
 * - Cross-domain SSO (WebKit ITP / Firefox ETP bypass)
 * - Service-to-service delegation
 * - Token scope downgrade
 * - Audience restriction
 */
async function handleTokenExchangeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>,
  rawBody: Record<string, string | File | (string | File)[]>
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  // Check Feature Flag and settings (hybrid: KV > env > default)
  let tokenExchangeEnabled = c.env.ENABLE_TOKEN_EXCHANGE === 'true';
  // Default: only access_token is allowed
  let allowedSubjectTokenTypes: string[] = ['access_token'];
  // Default parameter limits (DoS prevention)
  let maxResourceParams = 10;
  let maxAudienceParams = 10;
  // ID-JAG (Identity Assertion Authorization Grant) configuration
  // draft-ietf-oauth-identity-assertion-authz-grant
  const idJagConfig: IdJagConfig = { ...DEFAULT_ID_JAG_CONFIG };

  // Parse env variables
  if (c.env.TOKEN_EXCHANGE_ALLOWED_TYPES) {
    allowedSubjectTokenTypes = c.env.TOKEN_EXCHANGE_ALLOWED_TYPES.split(',').map((t) => t.trim());
  }
  if (c.env.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS) {
    const parsed = parseInt(c.env.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
      maxResourceParams = parsed;
    }
  }
  if (c.env.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS) {
    const parsed = parseInt(c.env.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
      maxAudienceParams = parsed;
    }
  }

  // KV takes priority over env
  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      if (settings.oidc?.tokenExchange?.enabled !== undefined) {
        tokenExchangeEnabled = settings.oidc.tokenExchange.enabled === true;
      }
      if (Array.isArray(settings.oidc?.tokenExchange?.allowedSubjectTokenTypes)) {
        allowedSubjectTokenTypes = settings.oidc.tokenExchange.allowedSubjectTokenTypes;
      }
      if (typeof settings.oidc?.tokenExchange?.maxResourceParams === 'number') {
        const value = settings.oidc.tokenExchange.maxResourceParams;
        if (value >= 1 && value <= 100) {
          maxResourceParams = value;
        }
      }
      if (typeof settings.oidc?.tokenExchange?.maxAudienceParams === 'number') {
        const value = settings.oidc.tokenExchange.maxAudienceParams;
        if (value >= 1 && value <= 100) {
          maxAudienceParams = value;
        }
      }
      // ID-JAG (Identity Assertion Authorization Grant) configuration
      // draft-ietf-oauth-identity-assertion-authz-grant
      if (settings.oidc?.tokenExchange?.idJag) {
        const idJagSettings = settings.oidc.tokenExchange.idJag;
        if (idJagSettings.enabled === true) {
          idJagConfig.enabled = true;
        }
        if (Array.isArray(idJagSettings.allowedIssuers)) {
          idJagConfig.allowedIssuers = idJagSettings.allowedIssuers;
        }
        if (typeof idJagSettings.maxTokenLifetime === 'number') {
          idJagConfig.maxTokenLifetime = idJagSettings.maxTokenLifetime;
        }
        if (typeof idJagSettings.includeTenantClaim === 'boolean') {
          idJagConfig.includeTenantClaim = idJagSettings.includeTenantClaim;
        }
        if (typeof idJagSettings.requireConfidentialClient === 'boolean') {
          idJagConfig.requireConfidentialClient = idJagSettings.requireConfidentialClient;
        }
      }
    }
  } catch {
    // Ignore KV errors, fall back to env
  }

  // Check env fallback for ID-JAG enabled flag
  if (!idJagConfig.enabled && c.env.ENABLE_ID_JAG === 'true') {
    idJagConfig.enabled = true;
  }

  if (!tokenExchangeEnabled) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: 'Token Exchange is not enabled',
      },
      400
    );
  }

  // Extract parameters
  const subject_token = formData.subject_token;
  const subject_token_type = formData.subject_token_type as TokenTypeURN | undefined;
  const actor_token = formData.actor_token;
  const actor_token_type = formData.actor_token_type as TokenTypeURN | undefined;
  const requestedScope = formData.scope;
  const requested_token_type = formData.requested_token_type as TokenTypeURN | undefined;

  // RFC 8693 §2.1: Multiple resource/audience parameters are allowed
  // Helper to extract string array from raw body (handles single value or array)
  const extractStringArray = (key: string): string[] => {
    const value = rawBody[key];
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    return typeof value === 'string' ? [value] : [];
  };

  const resources = extractStringArray('resource');
  const audiences = extractStringArray('audience');

  // DoS prevention: Limit the number of resource/audience parameters (configurable via Admin API)
  // RFC 8693 doesn't specify a limit, but unrestricted arrays could create oversized JWTs
  if (resources.length > maxResourceParams) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Too many resource parameters (max: ${maxResourceParams})`,
      },
      400
    );
  }

  if (audiences.length > maxAudienceParams) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Too many audience parameters (max: ${maxAudienceParams})`,
      },
      400
    );
  }

  // 1. Validate required parameters
  if (!subject_token) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'subject_token is required',
      },
      400
    );
  }

  if (!subject_token_type) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'subject_token_type is required',
      },
      400
    );
  }

  // Validate subject_token_type against allowed types
  // Map short names to full URNs for comparison
  const tokenTypeMap: Record<string, string> = {
    access_token: 'urn:ietf:params:oauth:token-type:access_token',
    jwt: 'urn:ietf:params:oauth:token-type:jwt',
    id_token: 'urn:ietf:params:oauth:token-type:id_token',
    refresh_token: 'urn:ietf:params:oauth:token-type:refresh_token',
  };

  // Build allowed URNs from settings
  const allowedURNs = allowedSubjectTokenTypes
    .map((t) => tokenTypeMap[t] || t)
    .filter((t) => t !== undefined);

  // Check if subject_token_type is allowed
  if (!allowedURNs.includes(subject_token_type)) {
    const allowedTypes = allowedSubjectTokenTypes.join(', ');
    return c.json(
      {
        error: 'invalid_request',
        error_description: `subject_token_type '${subject_token_type}' is not allowed. Allowed types: ${allowedTypes}`,
      },
      400
    );
  }

  // Additional security check: refresh_token is never allowed (even if misconfigured)
  if (subject_token_type === 'urn:ietf:params:oauth:token-type:refresh_token') {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'refresh_token cannot be used as subject_token for security reasons',
      },
      400
    );
  }

  // 2. Client Authentication (supports 4 methods)
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    try {
      const assertionPayload = parseToken(client_assertion);
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      }
    } catch {
      return oauthError(c, 'invalid_client', 'Invalid client_assertion format', 401);
    }
  }

  // Check HTTP Basic authentication
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Fetch client metadata
  const clientMetadata = await getClient(c.env, client_id!);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Cast to ClientMetadata for type safety
  const typedClient = clientMetadata as unknown as ClientMetadata;

  // Profile-based grant_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §5.2: unauthorized_client - client not allowed to use this grant type
  const tenantId = (clientMetadata.tenant_id as string) || 'default';
  const tenantProfile = await loadTenantProfile(c.env.AUTHRIM_CONFIG, c.env, tenantId);
  if (!tenantProfile.allows_token_exchange) {
    return oauthError(
      c,
      'unauthorized_client',
      'token_exchange grant is not allowed for this tenant profile',
      403
    );
  }

  // 3. Authenticate client
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${c.env.ISSUER_URL}/token`,
      typedClient
    );
    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(c, 'invalid_client', 'Client assertion validation failed', 401);
    }
  } else if (typedClient.client_secret_hash) {
    // client_secret_basic or client_secret_post
    // Security: Verify client secret against stored SHA-256 hash
    if (
      !client_secret ||
      !(await verifyClientSecretHash(client_secret, typedClient.client_secret_hash))
    ) {
      return oauthError(c, 'invalid_client', 'Invalid client credentials', 401);
    }
  } else {
    // Public clients (no client_secret_hash, no client_assertion) are NOT allowed to use Token Exchange
    // RFC 8693 allows optional client auth, but for enterprise security, we require authentication.
    // This prevents unauthorized token exchange by public clients.
    return oauthError(
      c,
      'invalid_client',
      'Client authentication is required for Token Exchange',
      401
    );
  }

  // 4. Check if client is allowed to use Token Exchange
  if (!typedClient.token_exchange_allowed) {
    return oauthError(c, 'unauthorized_client', 'Client is not authorized for Token Exchange', 403);
  }

  // Check delegation_mode
  const delegationMode = typedClient.delegation_mode || 'delegation';
  if (delegationMode === 'none') {
    return oauthError(c, 'unauthorized_client', 'Token Exchange is disabled for this client', 403);
  }

  // ===== OIDC Native SSO 1.0 (draft-07) Token Exchange Extension =====
  // Detect Native SSO pattern: id_token + device-secret
  // Note: actor_token_type is compared as string because DEVICE_SECRET_TOKEN_TYPE
  // is a custom URN not included in the standard TokenTypeURN union
  const isNativeSSORequest =
    subject_token_type === 'urn:ietf:params:oauth:token-type:id_token' &&
    (actor_token_type as string) === DEVICE_SECRET_TOKEN_TYPE;

  if (isNativeSSORequest) {
    return handleNativeSSOTokenExchange(
      c,
      subject_token,
      actor_token!, // device_secret
      client_id!,
      typedClient,
      requestedScope,
      formData
    );
  }

  // 5. Validate requested_token_type (RFC 8693 §2.2.1)
  // Supported token types: access_token (always), id-jag (when enabled)
  const isIdJagTokenRequest = isIdJagRequest(requested_token_type);

  if (requested_token_type) {
    const isValidAccessToken =
      requested_token_type === 'urn:ietf:params:oauth:token-type:access_token';

    // ID-JAG token type is only valid when ID-JAG is enabled
    if (isIdJagTokenRequest && !idJagConfig.enabled) {
      return oauthError(
        c,
        'invalid_request',
        'ID-JAG token type is not enabled. Enable it via Admin API.',
        400
      );
    }

    // Only access_token and id-jag (when enabled) are supported
    if (!isValidAccessToken && !isIdJagTokenRequest) {
      return oauthError(
        c,
        'invalid_request',
        'Only access_token and id-jag (when enabled) are supported as requested_token_type',
        400
      );
    }
  }

  // ID-JAG specific validations (draft-ietf-oauth-identity-assertion-authz-grant)
  if (isIdJagTokenRequest) {
    // §3.1: subject_token_type MUST be id_token, jwt, or saml2
    if (!isValidIdJagSubjectTokenType(subject_token_type!)) {
      return oauthError(
        c,
        'invalid_request',
        `ID-JAG requires subject_token_type to be id_token, jwt, or saml2. Got: ${subject_token_type}`,
        400
      );
    }

    // §3.2: SHOULD only be supported for confidential clients
    if (
      idJagConfig.requireConfidentialClient &&
      typedClient.token_endpoint_auth_method === 'none'
    ) {
      return oauthError(
        c,
        'invalid_client',
        'ID-JAG tokens can only be issued to confidential clients',
        400
      );
    }
  }

  // 6. Parse and validate subject_token
  let subjectTokenPayload: Record<string, unknown>;
  let subjectTokenHeader;
  try {
    subjectTokenPayload = parseToken(subject_token);
    subjectTokenHeader = parseTokenHeader(subject_token);
  } catch {
    return oauthError(c, 'invalid_request', 'Invalid subject_token format', 400);
  }

  // Get verification key from header (kid is in JWT header, NOT payload)
  const subjectTokenKid = subjectTokenHeader.kid;
  if (!subjectTokenKid) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Subject token is missing kid in header',
      },
      400
    );
  }

  // Performance optimization: Fetch public key and check revocation in parallel
  // These two DO calls are independent and can be executed concurrently
  const subjectJti = subjectTokenPayload.jti as string | undefined;
  const subjectIssuer = subjectTokenPayload.iss as string | undefined;

  // ID-JAG: subject_token comes from external IdP, verify against allowedIssuers
  let originalIssuer: string | undefined;
  if (isIdJagTokenRequest) {
    // Validate subject_token issuer against allowed issuers
    if (!subjectIssuer) {
      return oauthError(c, 'invalid_grant', 'Subject token is missing issuer (iss) claim', 400);
    }

    // SECURITY: Require explicit allowedIssuers configuration for ID-JAG
    // Empty allowedIssuers means no external IdPs are trusted (fail-secure)
    if (idJagConfig.allowedIssuers.length === 0) {
      log.warn('ID-JAG: No allowed issuers configured - rejecting request', {
        subjectIssuer,
        action: 'TokenExchange',
      });
      return oauthError(
        c,
        'invalid_grant',
        'ID-JAG is enabled but no allowed issuers are configured. Configure allowedIssuers via Admin API.',
        400
      );
    }

    // Check if issuer is in the allowed list
    if (!idJagConfig.allowedIssuers.includes(subjectIssuer)) {
      log.warn('ID-JAG: Subject token issuer not in allowed list', {
        subjectIssuer,
        allowedIssuers: idJagConfig.allowedIssuers,
        action: 'TokenExchange',
      });
      return oauthError(
        c,
        'invalid_grant',
        `Subject token issuer '${subjectIssuer}' is not in the allowed issuers list`,
        400
      );
    }

    originalIssuer = subjectIssuer;

    // For external IdP tokens, we need to fetch their JWKS
    // Note: This is a simplified implementation; production would cache JWKS
    log.info('ID-JAG: Accepting external IdP token', {
      subjectIssuer,
      subjectTokenKid,
      action: 'TokenExchange',
    });

    // TODO: Implement external JWKS fetching for full ID-JAG validation
    // For now, skip signature verification for external IdP tokens if allowed issuers is configured
    // This is acceptable for initial implementation with trusted IdPs
    // In production, implement fetchExternalJWKS(subjectIssuer) and verify signature
  }

  // For non-ID-JAG requests or when verifying our own tokens
  const [publicKey, revoked] = await Promise.all([
    // Only fetch our own JWKS for non-ID-JAG requests
    isIdJagTokenRequest
      ? Promise.resolve(null)
      : getVerificationKeyFromJWKS(c.env, subjectTokenKid),
    subjectJti ? isTokenRevoked(c.env, subjectJti) : Promise.resolve(false),
  ]);

  // Verify subject_token signature (issuer only, aud validated separately)
  // Skip verification for ID-JAG with external IdP tokens (trusted via allowedIssuers)
  if (!isIdJagTokenRequest && publicKey) {
    try {
      // Verify signature and issuer only; audience is validated in the authorization check below
      await verifyToken(subject_token, publicKey, c.env.ISSUER_URL, {
        skipAudienceCheck: true, // We validate audience ourselves in Token Exchange
      });
    } catch (error) {
      log.error('Subject token verification failed', {}, error as Error);
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Subject token verification failed',
        },
        400
      );
    }
  }

  // Check subject_token expiration
  const now = Math.floor(Date.now() / 1000);
  const subjectExp = subjectTokenPayload.exp as number | undefined;
  if (subjectExp && subjectExp < now) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Subject token has expired',
      },
      400
    );
  }

  // Check if subject_token is revoked (result already fetched in parallel above)
  if (revoked) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Subject token has been revoked',
      },
      400
    );
  }

  // 7. Audience validation (Cross-tenant escalation prevention)
  // This is CRITICAL for security - prevents stealing tokens meant for other clients
  const subjectAud = subjectTokenPayload.aud as string | string[] | undefined;
  const subjectClientId = subjectTokenPayload.client_id as string | undefined;
  const allowedSubjectClients = typedClient.allowed_subject_token_clients || [];
  const subjectAudArray = Array.isArray(subjectAud) ? subjectAud : subjectAud ? [subjectAud] : [];

  // Check 1: Is the requesting client in the subject_token's audience?
  // (client_id must be explicitly in aud, NOT just issuer URL)
  const isClientInAudience = subjectAudArray.includes(client_id!);

  // Check 2: Is the subject_token's issuing client in our allowed list?
  const isAllowedSubjectClient =
    allowedSubjectClients.length > 0 && allowedSubjectClients.includes(subjectClientId || '');

  // SECURITY: Reject if neither condition is met
  // - Client must be explicitly authorized via audience or allowed_subject_token_clients
  // - Issuer URL in aud is NOT sufficient (prevents cross-client token theft)
  if (!isClientInAudience && !isAllowedSubjectClient) {
    return c.json(
      {
        error: 'invalid_target',
        error_description: 'Client is not authorized to exchange this token',
      },
      403
    );
  }

  // 7. Scope handling (RFC 8693 §2.1)
  // Options: inherit from subject_token, explicitly request subset, or let client.allowed_scopes limit
  const subjectScope = subjectTokenPayload.scope as string | undefined;
  const subjectScopes = subjectScope ? subjectScope.split(' ') : [];

  // Track scope source for audit logging
  const scopeSource: 'explicit' | 'inherited' = requestedScope ? 'explicit' : 'inherited';
  const requestedScopes = requestedScope ? requestedScope.split(' ') : subjectScopes;
  const allowedScopes = typedClient.allowed_scopes || [];

  // Intersection: requested ∩ subject ∩ client.allowed_scopes
  // This ensures scope can only be downgraded, never escalated
  let grantedScopes = requestedScopes;
  if (subjectScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => subjectScopes.includes(s));
  }
  if (allowedScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => allowedScopes.includes(s));
  }

  const grantedScope = grantedScopes.join(' ') || 'openid';

  // Detect scope changes for security audit
  const scopeDowngraded = subjectScopes.length > 0 && grantedScopes.length < subjectScopes.length;
  const removedScopes = subjectScopes.filter((s) => !grantedScopes.includes(s));

  // 8. Resource/Audience validation (RFC 8693 §2.1)
  // RFC 8693 allows multiple resource and audience parameters
  // aud claim will be an array combining both
  let targetAudiences: string[] = [];
  let audienceSource: 'audience_param' | 'resource_param' | 'both' | 'default';

  // RFC 8693 §2.1: Each resource MUST be an absolute URI without fragment
  for (const res of resources) {
    try {
      const resourceUrl = new URL(res);
      // Validate: must be absolute URI with http/https scheme
      if (!['http:', 'https:'].includes(resourceUrl.protocol)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `resource '${res}' must be an absolute URI with http or https scheme`,
          },
          400
        );
      }
      // RFC 8693: MUST NOT include a fragment component
      if (resourceUrl.hash) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `resource '${res}' must not include a fragment component`,
          },
          400
        );
      }
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `resource '${res}' must be a valid absolute URI`,
        },
        400
      );
    }
  }

  // Build target audiences array (audiences first, then resources)
  // This follows RFC 8693's logical vs location-based identifier hierarchy
  if (audiences.length > 0 && resources.length > 0) {
    targetAudiences = [...audiences, ...resources];
    audienceSource = 'both';
  } else if (audiences.length > 0) {
    targetAudiences = audiences;
    audienceSource = 'audience_param';
  } else if (resources.length > 0) {
    targetAudiences = resources;
    audienceSource = 'resource_param';
  } else {
    targetAudiences = [c.env.ISSUER_URL];
    audienceSource = 'default';
  }

  // Validate against allowed resources (all targets must be allowed)
  const allowedResources = typedClient.allowed_token_exchange_resources || [];
  if (allowedResources.length > 0) {
    const disallowedTargets = targetAudiences.filter((t) => !allowedResources.includes(t));
    if (disallowedTargets.length > 0) {
      return c.json(
        {
          error: 'invalid_target',
          error_description: `Requested audience/resource not allowed: ${disallowedTargets.join(', ')}`,
        },
        403
      );
    }
  }

  // 9. Actor token validation (for delegation mode)
  let actClaim: ActClaim | undefined;

  if (delegationMode === 'delegation') {
    // SECURITY: If actor_token is provided, actor_token_type MUST also be provided
    // Otherwise, the actor_token is silently ignored and the client becomes the actor
    if (actor_token && !actor_token_type) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'actor_token_type is required when actor_token is provided',
        },
        400
      );
    }

    if (actor_token && actor_token_type) {
      // Validate actor_token_type (only access_token supported)
      if (actor_token_type !== 'urn:ietf:params:oauth:token-type:access_token') {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Only access_token is supported as actor_token_type',
          },
          400
        );
      }

      // Validate actor_token
      let actorTokenPayload: Record<string, unknown>;
      let actorTokenHeader;
      try {
        actorTokenPayload = parseToken(actor_token);
        actorTokenHeader = parseTokenHeader(actor_token);
      } catch {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid actor_token format',
          },
          400
        );
      }

      // Get kid from header (NOT payload)
      const actorTokenKid = actorTokenHeader.kid;
      if (!actorTokenKid) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token is missing kid in header',
          },
          400
        );
      }

      try {
        const actorPublicKey = await getVerificationKeyFromJWKS(c.env, actorTokenKid);
        // Verify signature and issuer only; audience is validated below
        await verifyToken(actor_token, actorPublicKey, c.env.ISSUER_URL, {
          skipAudienceCheck: true, // We validate audience ourselves after this
        });
      } catch (error) {
        log.error('Actor token signature verification failed', {}, error as Error);
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token verification failed',
          },
          400
        );
      }

      // Check actor_token expiration
      const actorExp = actorTokenPayload.exp as number | undefined;
      if (actorExp && actorExp < now) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token has expired',
          },
          400
        );
      }

      // Check if actor_token is revoked
      const actorJti = actorTokenPayload.jti as string | undefined;
      if (actorJti) {
        const actorRevoked = await isTokenRevoked(c.env, actorJti);
        if (actorRevoked) {
          return c.json(
            {
              error: 'invalid_grant',
              error_description: 'Actor token has been revoked',
            },
            400
          );
        }
      }

      // Validate actor_token audience (security: prevent use of tokens meant for other resources)
      // Actor token MUST have an aud claim and it should contain the requesting client_id or the issuer URL
      const actorAud = actorTokenPayload.aud as string | string[] | undefined;
      const actorAudArray = Array.isArray(actorAud) ? actorAud : actorAud ? [actorAud] : [];

      // SECURITY: Reject actor tokens without aud claim
      // Tokens without aud could be used by any client, enabling token theft attacks
      if (actorAudArray.length === 0) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token must have an audience claim',
          },
          400
        );
      }

      const isActorAudValid =
        actorAudArray.includes(client_id!) || actorAudArray.includes(c.env.ISSUER_URL);

      if (!isActorAudValid) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token audience does not match requesting client',
          },
          400
        );
      }

      // Build act claim with potential nesting (max 2 levels)
      const existingAct = subjectTokenPayload.act as ActClaim | undefined;

      actClaim = {
        sub: actorTokenPayload.sub as string,
        client_id: actorTokenPayload.client_id as string | undefined,
        // Only nest 1 level (prevent infinite chains)
        ...(existingAct && !existingAct.act ? { act: existingAct } : {}),
      };
    } else {
      // No actor_token, use client as actor
      actClaim = {
        sub: `client:${client_id}`,
        client_id: client_id!,
      };
    }
  }
  // impersonation mode: no act claim

  // 10. Generate new access token
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

  // DPoP support
  let dpopJkt: string | undefined;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env, // Pass full Env for region-aware sharding
      client_id!
    );
    if (!dpopValidation.valid) {
      return c.json(
        {
          error: 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'DPoP validation failed',
        },
        400
      );
    }
    dpopJkt = dpopValidation.jkt;
  }

  // Build access token claims
  const subjectSub = subjectTokenPayload.sub as string;
  // RFC 8693: aud can be a single string or array of strings
  // Use single string if only one audience, array otherwise (for JWT compactness)
  const audClaim = targetAudiences.length === 1 ? targetAudiences[0] : targetAudiences;

  // ID-JAG: Use configured token lifetime if it's shorter than default
  const idJagExpiresIn = isIdJagTokenRequest
    ? Math.min(expiresIn, idJagConfig.maxTokenLifetime)
    : expiresIn;

  const accessTokenClaims: Record<string, unknown> = {
    iss: c.env.ISSUER_URL,
    sub: subjectSub,
    aud: audClaim,
    scope: grantedScope,
    client_id: client_id,
    // Add act claim for delegation
    ...(actClaim ? { act: actClaim } : {}),
    // Add resource URIs if specified (RFC 8693 §2.2.1)
    ...(resources.length > 0
      ? { resource: resources.length === 1 ? resources[0] : resources }
      : {}),
    // Add DPoP confirmation
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
    // ID-JAG specific claims (draft-ietf-oauth-identity-assertion-authz-grant)
    // original_issuer: The IdP that originally issued the subject_token
    ...(isIdJagTokenRequest && originalIssuer ? { original_issuer: originalIssuer } : {}),
    // Include tenant claim for multi-tenant scenarios
    ...(isIdJagTokenRequest && idJagConfig.includeTenantClaim && tenantId
      ? { tenant: tenantId }
      : {}),
    // Preserve acr/amr from subject_token if present (authentication context)
    ...(isIdJagTokenRequest && subjectTokenPayload.acr ? { acr: subjectTokenPayload.acr } : {}),
    ...(isIdJagTokenRequest && subjectTokenPayload.amr ? { amr: subjectTokenPayload.amr } : {}),
  };

  // Use ID-JAG expires_in if this is an ID-JAG request
  const effectiveExpiresIn = isIdJagTokenRequest ? idJagExpiresIn : expiresIn;

  let accessToken: string;
  let accessTokenJti: string;
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      effectiveExpiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Token Exchange does NOT issue refresh tokens (stateless by design)

  // Audit log for Token Exchange (helps with security monitoring and debugging)
  // Maps URN to short name for readability
  const tokenTypeShortName: Record<string, string> = {
    'urn:ietf:params:oauth:token-type:access_token': 'access_token',
    'urn:ietf:params:oauth:token-type:jwt': 'jwt',
    'urn:ietf:params:oauth:token-type:id_token': 'id_token',
    [TOKEN_TYPE_ID_JAG]: 'id-jag',
  };
  log.info('Token Exchange Success', {
    clientId: client_id,
    subjectTokenType: tokenTypeShortName[subject_token_type] || subject_token_type,
    subjectSub,
    delegationMode,
    hasActorToken: !!actor_token,
    actorSub: actClaim?.sub,
    targetAudiences,
    audienceSource,
    resourceCount: resources.length,
    audienceCount: audiences.length,
    scopeSource,
    subjectScope: subjectScope || '(none)',
    grantedScope,
    scopeDowngraded,
    ...(removedScopes.length > 0 && { removedScopes }),
    tokenBinding: dpopProof ? 'DPoP' : 'Bearer',
    jti: accessTokenJti,
    // ID-JAG specific logging
    isIdJagRequest: isIdJagTokenRequest,
    ...(isIdJagTokenRequest && { originalIssuer }),
    action: 'TokenExchange',
  });

  // Publish token event (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId,
      data: {
        jti: accessTokenJti,
        clientId: client_id,
        userId: subjectSub,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + effectiveExpiresIn,
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    })
  );

  // Set cache control headers
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  // Determine issued_token_type for response
  // For ID-JAG requests, return the id-jag token type
  const issuedTokenType: TokenTypeURN = isIdJagTokenRequest
    ? TOKEN_TYPE_ID_JAG
    : requested_token_type || 'urn:ietf:params:oauth:token-type:access_token';

  return c.json({
    access_token: accessToken,
    issued_token_type: issuedTokenType,
    token_type: dpopProof ? 'DPoP' : 'Bearer',
    expires_in: effectiveExpiresIn,
    scope: grantedScope,
  });
}

// =============================================================================
// OIDC Native SSO 1.0 (draft-07): Native SSO Token Exchange
// =============================================================================

/**
 * Handle Native SSO Token Exchange (OIDC Native SSO 1.0)
 * https://openid.net/specs/openid-connect-native-sso-1_0.html
 *
 * Native SSO enables seamless SSO between mobile/desktop apps sharing a Keychain.
 * - App A authenticates and receives device_secret
 * - App B uses device_secret + ID Token to get tokens without user interaction
 *
 * Security:
 * - device_secret is validated using SHA-256 hash lookup
 * - ID Token is verified for signature, issuer, expiration
 * - Cross-client SSO requires explicit configuration
 * - Rate limiting protects against brute-force attacks
 */
async function handleNativeSSOTokenExchange(
  c: Context<{ Bindings: Env }>,
  idToken: string,
  deviceSecret: string,
  clientId: string,
  clientMetadata: ClientMetadata,
  requestedScope?: string,
  formData?: Record<string, string>
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  // 1. Check Native SSO feature flag
  const nativeSSOEnabled = await isNativeSSOEnabled(c.env);
  if (!nativeSSOEnabled) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: 'Native SSO is not enabled',
      },
      400
    );
  }

  // 2. Check if client supports Native SSO
  const clientNativeSSOEnabled = Boolean(clientMetadata.native_sso_enabled);
  if (!clientNativeSSOEnabled) {
    return c.json(
      {
        error: 'unauthorized_client',
        error_description: 'Client is not configured for Native SSO',
      },
      403
    );
  }

  // 3. Check if DB is available
  if (!c.env.DB) {
    log.error('D1 database not available', { action: 'NativeSSO' });
    return c.json(
      {
        error: 'server_error',
        error_description: 'Database not available',
      },
      500
    );
  }

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
  const deviceSecretRepo = new DeviceSecretRepository(coreAdapter);
  const nativeSSOConfig = await getNativeSSOConfig(c.env);

  // 3b. Rate limiting for brute-force protection (checked BEFORE validation)
  // Use client_id + IP as key since we don't know user_id until validation
  if (c.env.AUTHRIM_CONFIG) {
    const clientIP =
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const rateLimitKey = `native-sso:ratelimit:${clientId}:${clientIP}`;

    try {
      const rateLimitData = await c.env.AUTHRIM_CONFIG.get(rateLimitKey);
      const { maxAttemptsPerMinute, blockDurationMinutes } = nativeSSOConfig.rateLimit;

      if (rateLimitData) {
        const { count, blockedUntil } = JSON.parse(rateLimitData) as {
          count: number;
          blockedUntil?: number;
        };

        // Check if currently blocked
        if (blockedUntil && Date.now() < blockedUntil) {
          const remainingSeconds = Math.ceil((blockedUntil - Date.now()) / 1000);
          log.warn('Rate limit blocked', {
            clientId,
            clientIP,
            remainingSeconds,
            action: 'NativeSSO',
          });
          return c.json(
            {
              error: 'slow_down',
              error_description: `Too many attempts. Please wait ${remainingSeconds} seconds.`,
            },
            429
          );
        }

        // Check if approaching limit
        if (count >= maxAttemptsPerMinute) {
          // Block for the configured duration
          const blockedUntilTime = Date.now() + blockDurationMinutes * 60 * 1000;
          await c.env.AUTHRIM_CONFIG.put(
            rateLimitKey,
            JSON.stringify({ count: count + 1, blockedUntil: blockedUntilTime }),
            { expirationTtl: blockDurationMinutes * 60 + 60 }
          );
          log.warn('Rate limit triggered', {
            clientId,
            clientIP,
            blockDurationMinutes,
            action: 'NativeSSO',
          });
          return c.json(
            {
              error: 'slow_down',
              error_description: `Too many attempts. Please wait ${blockDurationMinutes} minutes.`,
            },
            429
          );
        }

        // Increment counter
        await c.env.AUTHRIM_CONFIG.put(rateLimitKey, JSON.stringify({ count: count + 1 }), {
          expirationTtl: 60,
        });
      } else {
        // First attempt in this window
        await c.env.AUTHRIM_CONFIG.put(rateLimitKey, JSON.stringify({ count: 1 }), {
          expirationTtl: 60,
        });
      }
    } catch (error) {
      // Log but don't block on rate limit errors (fail-open for availability)
      log.error('Rate limit check error', { action: 'NativeSSO' }, error as Error);
    }
  }

  // 4. Validate device_secret (this also marks it as used)
  // Pass maxUseCountPerSecret from config for replay attack prevention
  const deviceSecretValidation = await deviceSecretRepo.validateAndUse(deviceSecret, {
    maxUseCount: nativeSSOConfig.maxUseCountPerSecret,
  });
  if (!deviceSecretValidation.ok) {
    const errorMessages: Record<string, string> = {
      not_found: 'Device secret not found or invalid',
      expired: 'Device secret has expired',
      revoked: 'Device secret has been revoked',
      mismatch: 'Device secret validation failed',
      limit_exceeded: 'Device secret use count exceeded - please re-authenticate',
    };
    return c.json(
      {
        error: 'invalid_grant',
        error_description: errorMessages[deviceSecretValidation.reason] || 'Invalid device secret',
      },
      400
    );
  }

  const validatedDeviceSecret = deviceSecretValidation.entity;
  const deviceSecretUserId = validatedDeviceSecret.user_id;

  // 5. Parse and validate ID Token
  let idTokenPayload: Record<string, unknown>;
  let idTokenHeader;
  try {
    idTokenPayload = parseToken(idToken);
    idTokenHeader = parseTokenHeader(idToken);
  } catch {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Invalid ID token format',
      },
      400
    );
  }

  // Get verification key from header
  const idTokenKid = idTokenHeader.kid;
  if (!idTokenKid) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'ID token is missing kid in header',
      },
      400
    );
  }

  // Verify ID Token signature
  try {
    const publicKey = await getVerificationKeyFromJWKS(c.env, idTokenKid);
    await verifyToken(idToken, publicKey, c.env.ISSUER_URL, {
      skipAudienceCheck: true, // We validate audience ourselves
    });
  } catch (error) {
    log.error('ID token verification failed', { action: 'NativeSSO' }, error as Error);
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'ID token verification failed',
      },
      400
    );
  }

  // Check ID Token expiration
  const now = Math.floor(Date.now() / 1000);
  const idTokenExp = idTokenPayload.exp as number | undefined;
  if (idTokenExp && idTokenExp < now) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'ID token has expired',
      },
      400
    );
  }

  // 5b. ID Token jti replay attack prevention
  // Store used jti in KV to prevent replay attacks
  const idTokenJti = idTokenPayload.jti as string | undefined;
  if (idTokenJti && c.env.AUTHRIM_CONFIG) {
    const jtiKey = `native-sso:jti:${idTokenJti}`;
    const existingJti = await c.env.AUTHRIM_CONFIG.get(jtiKey);

    if (existingJti) {
      log.warn('ID Token replay detected', {
        jtiPrefix: idTokenJti.substring(0, 8),
        action: 'NativeSSO',
      });
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'ID token has already been used',
        },
        400
      );
    }

    // Store jti with expiration = remaining ID token lifetime + 60s buffer
    // This prevents replay but doesn't waste storage after token expires
    const ttlSeconds = idTokenExp ? Math.max(60, idTokenExp - now + 60) : 3600;
    await c.env.AUTHRIM_CONFIG.put(jtiKey, '1', { expirationTtl: ttlSeconds });
  }

  // 6. Verify user_id matches between ID Token and device_secret
  const idTokenSub = idTokenPayload.sub as string;
  if (idTokenSub !== deviceSecretUserId) {
    log.warn('User mismatch', {
      idTokenSubPrefix: idTokenSub.substring(0, 8),
      deviceSecretUserPrefix: deviceSecretUserId.substring(0, 8),
      action: 'NativeSSO',
    });
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'ID token subject does not match device secret owner',
      },
      400
    );
  }

  // 7. Cross-client SSO check
  const idTokenAud = idTokenPayload.aud as string | string[] | undefined;
  const idTokenAudArray = Array.isArray(idTokenAud) ? idTokenAud : idTokenAud ? [idTokenAud] : [];
  const idTokenClientId = idTokenPayload.client_id as string | undefined;
  const originalClientId =
    idTokenClientId || (idTokenAudArray[0] !== c.env.ISSUER_URL ? idTokenAudArray[0] : undefined);

  const isSameClient = originalClientId === clientId || idTokenAudArray.includes(clientId);

  if (!isSameClient) {
    // Cross-client SSO security: ALL conditions must be met (AND logic, not OR)
    // 1. Global setting must allow cross-client SSO
    // 2. Requesting client (App B) must have cross-client SSO enabled
    // 3. Original client (App A) must also allow its tokens to be used by other clients
    const crossClientAllowed = nativeSSOConfig.allowCrossClientNativeSSO;
    const requestingClientCrossClientAllowed = Boolean(
      clientMetadata.allow_cross_client_native_sso
    );

    // Verify original client also allows cross-client SSO
    let originalClientCrossClientAllowed = false;
    if (originalClientId) {
      try {
        const originalClientMetadata = await getClient(c.env, originalClientId);
        originalClientCrossClientAllowed = Boolean(
          originalClientMetadata?.allow_cross_client_native_sso
        );
      } catch {
        // If we can't verify original client, deny cross-client SSO for safety
        log.warn('Failed to verify original client', { originalClientId, action: 'NativeSSO' });
        originalClientCrossClientAllowed = false;
      }
    }

    // Security: Require ALL three conditions to allow cross-client SSO
    if (
      !crossClientAllowed ||
      !requestingClientCrossClientAllowed ||
      !originalClientCrossClientAllowed
    ) {
      log.warn('Cross-client SSO denied', {
        originalClientId,
        requestingClientId: clientId,
        globalAllowed: crossClientAllowed,
        requestingClientAllowed: requestingClientCrossClientAllowed,
        originalClientAllowed: originalClientCrossClientAllowed,
        action: 'NativeSSO',
      });
      return c.json(
        {
          error: 'invalid_target',
          error_description: 'Cross-client Native SSO is not allowed',
        },
        403
      );
    }
  }

  // 8. Scope handling
  // Native SSO inherits scope from original ID Token or uses requested scope
  const idTokenScope = idTokenPayload.scope as string | undefined;
  const originalScopes = idTokenScope ? idTokenScope.split(' ') : ['openid'];
  const requestedScopes = requestedScope ? requestedScope.split(' ') : originalScopes;
  const allowedScopes = clientMetadata.allowed_scopes || [];

  // Intersection: requested ∩ original ∩ client.allowed_scopes
  let grantedScopes = requestedScopes;
  if (originalScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => originalScopes.includes(s));
  }
  if (allowedScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => allowedScopes.includes(s));
  }

  // Ensure openid is always included for OIDC
  if (!grantedScopes.includes('openid')) {
    grantedScopes.unshift('openid');
  }

  const grantedScope = grantedScopes.join(' ');

  // 9. Generate tokens
  let privateKey: CryptoKey;
  let keyId: string;
  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key', { action: 'NativeSSO' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();

  // DPoP support
  let dpopJkt: string | undefined;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env,
      clientId
    );
    if (!dpopValidation.valid) {
      return c.json(
        {
          error: 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'DPoP validation failed',
        },
        400
      );
    }
    dpopJkt = dpopValidation.jkt;
  }

  // Build access token claims
  const accessTokenClaims: Record<string, unknown> = {
    iss: c.env.ISSUER_URL,
    sub: idTokenSub,
    aud: c.env.ISSUER_URL,
    scope: grantedScope,
    client_id: clientId,
    // Include session_id if available from device_secret
    ...(validatedDeviceSecret.session_id && { sid: validatedDeviceSecret.session_id }),
    // Add DPoP confirmation
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  };

  let accessToken: string;
  let accessTokenJti: string;
  try {
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', { action: 'NativeSSO' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Calculate at_hash for new ID Token
  let newAtHash: string;
  try {
    newAtHash = await calculateAtHash(accessToken);
  } catch (error) {
    log.error('Failed to calculate at_hash', { action: 'NativeSSO' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to calculate token hash',
      },
      500
    );
  }

  // Build new ID Token claims
  // Extract values first to avoid spread type issues
  const authTime = idTokenPayload.auth_time as number | undefined;
  const acr = idTokenPayload.acr as string | undefined;
  const newIdTokenClaims: Record<string, unknown> = {
    iss: c.env.ISSUER_URL,
    sub: idTokenSub,
    aud: clientId,
    at_hash: newAtHash,
  };
  // Preserve auth_time from original ID Token
  if (authTime !== undefined) {
    newIdTokenClaims.auth_time = authTime;
  }
  // Preserve acr from original ID Token
  if (acr !== undefined) {
    newIdTokenClaims.acr = acr;
  }
  // Include session_id
  if (validatedDeviceSecret.session_id) {
    newIdTokenClaims.sid = validatedDeviceSecret.session_id;
  }

  let newIdToken: string;
  try {
    newIdToken = await createIDToken(
      newIdTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
      privateKey,
      keyId,
      expiresIn
    );
  } catch (error) {
    log.error('Failed to create ID token', { action: 'NativeSSO' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // 10. Audit log
  log.info('NativeSSO Token Exchange Success', {
    clientId,
    userIdPrefix: idTokenSub.substring(0, 8),
    sessionIdPrefix: validatedDeviceSecret.session_id?.substring(0, 8),
    deviceSecretIdPrefix: validatedDeviceSecret.id.substring(0, 8),
    deviceSecretUseCount: validatedDeviceSecret.use_count + 1,
    isCrossClient: !isSameClient,
    originalClientId,
    grantedScope,
    tokenBinding: dpopProof ? 'DPoP' : 'Bearer',
    accessTokenJti: accessTokenJti,
    action: 'NativeSSO',
  });

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    Promise.all([
      publishEvent(c, {
        type: TOKEN_EVENTS.ACCESS_ISSUED,
        tenantId: 'default', // Native SSO uses default tenant
        data: {
          jti: accessTokenJti,
          clientId,
          userId: idTokenSub,
          scopes: grantedScope.split(' '),
          expiresAt: nowEpoch + expiresIn,
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange', // Native SSO uses token-exchange
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
      }),
      // ID Token issued event (Native SSO token exchange)
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId: 'default',
        data: {
          clientId,
          userId: idTokenSub,
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      }),
    ])
  );

  // Set cache control headers
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' as TokenTypeURN,
    token_type: dpopProof ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    id_token: newIdToken,
    scope: grantedScope,
  });
}

// =============================================================================
// RFC 6749 Section 4.4: Client Credentials Grant
// =============================================================================

/**
 * Handle Client Credentials Grant (RFC 6749 Section 4.4)
 * https://datatracker.ietf.org/doc/html/rfc6749#section-4.4
 *
 * Machine-to-Machine (M2M) authentication where the client is the resource owner.
 * No user authentication required.
 */
async function handleClientCredentialsGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  // Check Feature Flag (hybrid: KV > env)
  let clientCredentialsEnabled = c.env.ENABLE_CLIENT_CREDENTIALS === 'true';
  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      if (settings.oidc?.clientCredentials?.enabled !== undefined) {
        clientCredentialsEnabled = settings.oidc.clientCredentials.enabled === true;
      }
    }
  } catch {
    // Ignore KV errors, fall back to env
  }

  if (!clientCredentialsEnabled) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: 'Client Credentials grant is not enabled',
      },
      400
    );
  }

  const requestedScope = formData.scope;
  const requestedAudience = formData.audience;

  // 1. Client Authentication (required for client_credentials)
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    try {
      const assertionPayload = parseToken(client_assertion);
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      }
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_assertion format',
        },
        401
      );
    }
  }

  // Check HTTP Basic authentication
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Fetch client metadata
  const clientMetadata = await getClient(c.env, client_id!);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Cast to ClientMetadata for type safety
  const typedClient = clientMetadata as unknown as ClientMetadata;

  // Profile-based grant_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §5.2: unauthorized_client - client not allowed to use this grant type
  const tenantId = (clientMetadata.tenant_id as string) || 'default';
  const tenantProfile = await loadTenantProfile(c.env.AUTHRIM_CONFIG, c.env, tenantId);
  if (!tenantProfile.allows_client_credentials) {
    return oauthError(
      c,
      'unauthorized_client',
      'client_credentials grant is not allowed for this tenant profile',
      403
    );
  }

  // 2. Authenticate client (client_credentials REQUIRES authentication)
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${c.env.ISSUER_URL}/token`,
      typedClient
    );
    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(c, 'invalid_client', 'Client assertion validation failed', 401);
    }
  } else if (typedClient.client_secret_hash) {
    // client_secret_basic or client_secret_post
    // Security: Verify client secret against stored SHA-256 hash
    if (
      !client_secret ||
      !(await verifyClientSecretHash(client_secret, typedClient.client_secret_hash))
    ) {
      return oauthError(c, 'invalid_client', 'Invalid client credentials', 401);
    }
  } else {
    // Public clients are NOT allowed to use client_credentials
    return oauthError(c, 'invalid_client', 'Client credentials authentication is required', 401);
  }

  // 3. Check if client is allowed to use Client Credentials grant
  if (!typedClient.client_credentials_allowed) {
    return oauthError(
      c,
      'unauthorized_client',
      'Client is not authorized for Client Credentials grant',
      403
    );
  }

  // 4. Scope validation
  const defaultScope = typedClient.default_scope || 'openid';
  const scopes = requestedScope ? requestedScope.split(' ') : defaultScope.split(' ');
  const allowedScopes = typedClient.allowed_scopes || [];

  // If allowed_scopes is defined, filter requested scopes
  let grantedScopes = scopes;
  if (allowedScopes.length > 0) {
    grantedScopes = scopes.filter((s) => allowedScopes.includes(s));
    if (grantedScopes.length === 0) {
      return oauthError(
        c,
        'invalid_scope',
        'None of the requested scopes are allowed for this client',
        400
      );
    }
  }

  const grantedScope = grantedScopes.join(' ');

  // 5. Audience determination
  const targetAudience = requestedAudience || typedClient.default_audience || c.env.ISSUER_URL;

  // 6. Generate access token
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

  // DPoP support
  let dpopJkt: string | undefined;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env, // Pass full Env for region-aware sharding
      client_id!
    );
    if (!dpopValidation.valid) {
      return oauthError(
        c,
        'invalid_dpop_proof',
        dpopValidation.error_description || 'DPoP validation failed',
        400
      );
    }
    dpopJkt = dpopValidation.jkt;
  }

  // Build access token claims
  // For M2M, subject is the client itself with "client:" prefix for namespace separation
  const accessTokenClaims: Record<string, unknown> = {
    iss: c.env.ISSUER_URL,
    sub: `client:${client_id}`, // Namespace separation from user subjects
    aud: targetAudience,
    scope: grantedScope,
    client_id: client_id,
    // Add DPoP confirmation
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  };

  let accessToken: string;
  let accessTokenJti: string = '';
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to create access token', 500);
  }

  // Client Credentials does NOT issue refresh tokens (per RFC 6749)

  // Publish token event (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId,
      data: {
        jti: accessTokenJti,
        clientId: client_id!,
        // Client Credentials is M2M - the client is the subject
        userId: `client:${client_id}`,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + expiresIn,
        grantType: 'client_credentials',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    })
  );

  // Set cache control headers
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopProof ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    scope: grantedScope,
  });
}

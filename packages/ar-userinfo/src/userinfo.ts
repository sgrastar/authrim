import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  introspectTokenFromContext,
  getClientCached,
  getCachedUser,
  createAuthContextFromHono,
  createPIIContextFromHono,
  encryptJWT,
  isUserInfoEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  createOAuthConfigManager,
  buildRequestIssuerUrl,
  getLogger,
  getTenantIdFromContext,
  type JWEAlgorithm,
  type JWEEncryption,
  loadFeatureConfig,
  createCustomClaimSchemaResolver,
  parseClaimsRequest,
  evaluateClaimsForTarget,
  buildStandardUserClaims,
} from '@authrim/ar-lib-core';
import { SignJWT } from 'jose';

// ===== Key Caching for Performance Optimization =====
// Per-tenant Map cache for signing keys (avoids expensive RSA key import on every request)
const signingKeyCache = new Map<
  string,
  {
    privateKey: CryptoKey;
    kid: string;
    timestamp: number;
    version: string;
  }
>();
const KEY_CACHE_TTL = 60000; // 60 seconds

/**
 * Get signing key from KeyManager with per-tenant caching.
 * Checks KV version signal to detect cross-worker emergency rotations.
 */
async function getSigningKeyFromKeyManager(
  env: Env,
  tenantId: string
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();
  const cached = signingKeyCache.get(tenantId);

  // Check cache — if within TTL, verify KV version to detect emergency rotation
  if (cached && now - cached.timestamp < KEY_CACHE_TTL) {
    const currentVersion =
      (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';
    if (currentVersion === cached.version) {
      return { privateKey: cached.privateKey, kid: cached.kid };
    }
    // Version mismatch: emergency rotation detected — fall through to refresh
  }

  // Cache miss or version mismatch: fetch from per-tenant KeyManager DO
  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const keyData = await keyManager.getActiveKeyWithPrivateRpc();

  if (!keyData || !keyData.privatePEM) {
    throw new Error('Private key not available from KeyManager');
  }

  // Import private key (expensive operation: 5-7ms)
  const { importPKCS8 } = await import('jose');
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // Fetch current version for cache coherence
  const version =
    (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';

  signingKeyCache.set(tenantId, { privateKey, kid: keyData.kid, timestamp: now, version });
  return { privateKey, kid: keyData.kid };
}

/**
 * UserInfo Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#UserInfo
 *
 * Returns claims about the authenticated user
 */
export async function userinfoHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('USERINFO');
  const tenantId = getTenantIdFromContext(c);
  const requestIssuer = buildRequestIssuerUrl(c.req.raw, c.env, tenantId);

  // Perform comprehensive token validation (including DPoP if present)
  const introspection = await introspectTokenFromContext(c);

  if (!introspection.valid) {
    // Token validation failed - return error
    // Type narrowing: when valid is false, error is guaranteed to be present
    if (!introspection.error) {
      return c.json({ error: 'server_error', error_description: 'Unknown error' }, 500);
    }
    const error = introspection.error;
    c.header('WWW-Authenticate', error.wwwAuthenticate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(
      {
        error: error.error,
        error_description: error.error_description,
      },
      error.statusCode as any
    );
  }

  // Token is valid - extract claims
  // Type narrowing: when valid is true, claims is guaranteed to be present
  if (!introspection.claims) {
    return c.json({ error: 'server_error', error_description: 'Missing claims' }, 500);
  }
  const tokenClaims = introspection.claims;
  const sub = tokenClaims.sub as string;
  const scope = (tokenClaims.scope as string) || '';
  const claimsParam = (tokenClaims.claims as string) || undefined;
  const scopes = scope.split(' ');

  // OIDC Core 5.3.1: Check if openid scope is required
  // Configurable via KV (USERINFO_REQUIRE_OPENID_SCOPE) for OAuth 2.0 compatibility
  const configManager = createOAuthConfigManager(c.env);
  const requireOpenidScope = await configManager.isUserInfoRequireOpenidScope();

  if (requireOpenidScope && !scopes.includes('openid')) {
    c.header('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="openid"');
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(
      {
        error: 'insufficient_scope',
        error_description: 'Access token must have openid scope for UserInfo endpoint',
      },
      403
    );
  }

  if (!sub) {
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'Token does not contain subject claim',
      },
      401
    );
  }

  const parsedClaims = parseClaimsRequest(claimsParam);
  const claimsRequest = parsedClaims.ok ? parsedClaims.request : undefined;

  // Fetch user data from KV cache (falls back to D1 on cache miss)
  // This dramatically reduces D1 calls under high load
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const user = await getCachedUser(c.env, sub, {
    coreDb: piiCtx.coreAdapter,
    piiDb: piiCtx.defaultPiiAdapter,
  });

  if (!user) {
    // Security: Generic message to prevent user enumeration
    // The subject from the token was valid but user data is missing
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'The access token is invalid',
      },
      401
    );
  }

  const userData = {
    ...buildStandardUserClaims(user),
    sub,
  };

  // Get client metadata to check claims parameter settings (request-level cached)
  // Extract client_id from token claims
  const client_id = tokenClaims.client_id as string;
  const clientMetadata = client_id ? await getClientCached(c, c.env, client_id) : null;

  const claimEvaluation = evaluateClaimsForTarget({
    target: 'userinfo',
    claimsRequest,
    initialClaims: { sub },
    availableClaims: userData,
    grantedScopes: scopes,
    clientPolicy: clientMetadata,
    includeScopeClaims: true,
    requestIntegrityProtected: tokenClaims.claims_request_protected === true,
  });
  if (!claimEvaluation.ok) {
    return c.json(
      {
        error: claimEvaluation.error,
        error_description: claimEvaluation.error_description,
      },
      400
    );
  }

  const userClaims: Record<string, unknown> = claimEvaluation.claims;

  // Custom Claim Schema: add custom claims from schema resolver
  try {
    const ccFeatureConfig = await loadFeatureConfig(c.env.AUTHRIM_CONFIG || null);
    if (ccFeatureConfig.enabled) {
      const authCtx = createAuthContextFromHono(c);
      const piiCtx = createPIIContextFromHono(c, getTenantIdFromContext(c));
      const ccResolver = createCustomClaimSchemaResolver(
        authCtx.coreAdapter,
        piiCtx.defaultPiiAdapter,
        c.env.AUTHRIM_CONFIG || null,
        ccFeatureConfig
      );
      const ccResult = await ccResolver.resolveClaimsForTarget(
        getTenantIdFromContext(c),
        sub,
        scopes,
        'userinfo'
      );
      for (const [key, value] of Object.entries(ccResult.claims)) {
        if (!(key in userClaims)) userClaims[key] = value; // Prevent overwriting standard claims
      }
    }
  } catch (ccError) {
    log.error('Failed to resolve custom claims for userinfo', {}, ccError as Error);
  }

  // JWE: Check if client requires UserInfo encryption (RFC 7516)
  if (!client_id || !clientMetadata) {
    // If no client_id in token or metadata not found, return unencrypted response
    // OIDC Security: Set cache control headers to prevent caching of user data
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(userClaims);
  }

  // Check if client requires UserInfo encryption
  if (isUserInfoEncryptionRequired(clientMetadata)) {
    const alg = clientMetadata.userinfo_encrypted_response_alg as string;
    const enc = clientMetadata.userinfo_encrypted_response_enc as string;

    // Validate encryption algorithms
    try {
      validateJWEOptions(alg, enc);
    } catch (validationError) {
      // Log full error details for debugging but don't expose to client
      log.error(
        'Invalid JWE options for UserInfo',
        { alg, enc, client_id },
        validationError as Error
      );
      // SECURITY: Do not expose validation error details in response
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
      log.error('Client requires UserInfo encryption but no public key available', { client_id });
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description:
            'Client requires UserInfo encryption but no public key (jwks or jwks_uri) is configured',
        },
        400
      );
    }

    // For UserInfo encryption, we need to sign the claims first (JWT), then encrypt (JWE)
    // This creates a nested JWT: JWS inside JWE
    try {
      // Get signing key from KeyManager (with caching)
      const { privateKey, kid } = await getSigningKeyFromKeyManager(
        c.env,
        getTenantIdFromContext(c)
      );

      // Sign UserInfo claims as JWT
      const signedUserInfo = await new SignJWT(userClaims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
        .setIssuedAt()
        .setIssuer(requestIssuer)
        .setAudience(client_id)
        .sign(privateKey);

      // Encrypt the signed JWT
      const encryptedUserInfo = await encryptJWT(signedUserInfo, publicKey, {
        alg: alg as JWEAlgorithm,
        enc: enc as JWEEncryption,
        cty: 'JWT', // Content type is JWT
        kid: publicKey.kid,
      });

      // Return encrypted UserInfo as JWT (not JSON)
      // OIDC Core 5.3.4: The response MUST be a JWT
      c.header('Content-Type', 'application/jwt');
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.body(encryptedUserInfo);
    } catch (encryptError) {
      log.error('Failed to encrypt UserInfo response', { client_id }, encryptError as Error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to encrypt UserInfo response',
        },
        500
      );
    }
  }

  // OIDC Core 5.3.3: Check if UserInfo signing is required (signed but not encrypted)
  const userinfoSignedResponseAlg = clientMetadata?.userinfo_signed_response_alg as
    | string
    | undefined;

  if (userinfoSignedResponseAlg && userinfoSignedResponseAlg !== 'none') {
    try {
      // Get signing key from KeyManager (with caching)
      const { privateKey, kid } = await getSigningKeyFromKeyManager(
        c.env,
        getTenantIdFromContext(c)
      );

      // Sign UserInfo claims as JWT
      const signedUserInfo = await new SignJWT(userClaims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
        .setIssuedAt()
        .setIssuer(requestIssuer)
        .setAudience(client_id)
        .sign(privateKey);

      // Return signed UserInfo as JWT
      c.header('Content-Type', 'application/jwt');
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.body(signedUserInfo);
    } catch (signError) {
      log.error('Failed to sign UserInfo response', { client_id }, signError as Error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to sign UserInfo response',
        },
        500
      );
    }
  }

  // No signing or encryption required, return JSON response
  // OIDC Security: Set cache control headers to prevent caching of user data
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(userClaims);
}

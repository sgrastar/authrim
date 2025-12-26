/**
 * KV Storage Utilities
 *
 * Provides helper functions for storing and retrieving data from Cloudflare KV namespaces.
 * Used for managing state parameters and nonce values.
 *
 * Note: Authorization codes and revoked tokens have been migrated to Durable Objects:
 * - Authorization codes → AuthorizationCodeStore DO
 * - Revoked tokens → TokenRevocationStore DO
 */

import type { Env } from '../types/env';
import type { RefreshTokenData } from '../types/oidc';
import { buildKVKey, buildDOInstanceName } from './tenant-context';
import { createOAuthConfigManager } from './oauth-config';
import { getRevocationStoreByJti } from './token-revocation-sharding';
import { D1Adapter } from '../db/adapters/d1-adapter';
import type { DatabaseAdapter } from '../db/adapter';

// ===== User Cache =====
// Read-Through Cache for user metadata with invalidation hook support
// TTL: Configurable via KV > env > default (3600 seconds = 1 hour)

/**
 * Cached user data structure
 * Includes all OIDC standard claims for profile, email, phone, and address scopes
 */
export interface CachedUser {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  family_name: string | null;
  given_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  picture: string | null;
  locale: string | null;
  phone_number: string | null;
  phone_number_verified: boolean;
  address: string | null; // JSON string of address object
  birthdate: string | null;
  gender: string | null;
  profile: string | null;
  website: string | null;
  zoneinfo: string | null;
  updated_at: number;
}

/**
 * Get user from cache or D1 (Read-Through Cache pattern)
 *
 * Architecture:
 * - Primary source: D1 database (users table)
 * - Cache: USER_CACHE KV (1 hour TTL)
 * - Invalidation: invalidateUserCache() called on user update
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID to retrieve
 * @returns Promise<CachedUser | null>
 */
export async function getCachedUser(env: Env, userId: string): Promise<CachedUser | null> {
  // If USER_CACHE is not configured, fall back to D1 directly
  if (!env.USER_CACHE) {
    return await getUserFromD1(env, userId);
  }

  const cacheKey = buildKVKey('user', userId);

  // Step 1: Try USER_CACHE (Read-Through Cache)
  const cached = await env.USER_CACHE.get(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached) as CachedUser;
    } catch (error) {
      // Cache is corrupted - delete it and fetch from D1
      // PII Protection: Don't log full error (may contain cached data)
      console.error('Failed to parse cached user data');
      await env.USER_CACHE.delete(cacheKey).catch(() => {
        console.warn('Failed to delete corrupted user cache');
      });
    }
  }

  // Step 2: Cache miss - fetch from D1
  const user = await getUserFromD1(env, userId);

  if (!user) {
    return null;
  }

  // Step 3: Populate USER_CACHE (TTL from KV > env > default)
  try {
    const configManager = createOAuthConfigManager(env);
    const userCacheTTL = await configManager.getUserCacheTTL();
    await env.USER_CACHE.put(cacheKey, JSON.stringify(user), {
      expirationTtl: userCacheTTL,
    });
  } catch (error) {
    // Cache write failure should not block the response
    // PII Protection: Don't log userId (can be used for tracking)
    console.warn('Failed to cache user data');
  }

  return user;
}

/**
 * Fetch user directly from D1 database
 * PII/Non-PII DB separation: fetches from Core DB and PII DB in parallel and merges
 */
async function getUserFromD1(env: Env, userId: string): Promise<CachedUser | null> {
  // Query Core DB for existence and non-PII fields
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const coreResult = await coreAdapter.queryOne<{
    id: string;
    email_verified: number;
    phone_number_verified: number;
    updated_at: number;
  }>(
    'SELECT id, email_verified, phone_number_verified, updated_at FROM users_core WHERE id = ? AND is_active = 1',
    [userId]
  );

  if (!coreResult) {
    return null;
  }

  // Query PII DB for PII fields (if available)
  let piiResult: {
    email: string | null;
    name: string | null;
    family_name: string | null;
    given_name: string | null;
    middle_name: string | null;
    nickname: string | null;
    preferred_username: string | null;
    picture: string | null;
    locale: string | null;
    phone_number: string | null;
    address_formatted: string | null;
    address_street_address: string | null;
    address_locality: string | null;
    address_region: string | null;
    address_postal_code: string | null;
    address_country: string | null;
    birthdate: string | null;
    gender: string | null;
    profile: string | null;
    website: string | null;
    zoneinfo: string | null;
  } | null = null;

  if (env.DB_PII) {
    const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
    piiResult = await piiAdapter.queryOne<{
      email: string | null;
      name: string | null;
      family_name: string | null;
      given_name: string | null;
      middle_name: string | null;
      nickname: string | null;
      preferred_username: string | null;
      picture: string | null;
      locale: string | null;
      phone_number: string | null;
      address_formatted: string | null;
      address_street_address: string | null;
      address_locality: string | null;
      address_region: string | null;
      address_postal_code: string | null;
      address_country: string | null;
      birthdate: string | null;
      gender: string | null;
      profile: string | null;
      website: string | null;
      zoneinfo: string | null;
    }>(
      `SELECT email, name, family_name, given_name, middle_name, nickname,
              preferred_username, picture, locale, phone_number,
              address_formatted, address_street_address, address_locality,
              address_region, address_postal_code, address_country,
              birthdate, gender, profile, website, zoneinfo
       FROM users_pii WHERE id = ?`,
      [userId]
    );
  }

  // Build address JSON from PII fields
  const addressJson = piiResult
    ? JSON.stringify({
        formatted: piiResult.address_formatted,
        street_address: piiResult.address_street_address,
        locality: piiResult.address_locality,
        region: piiResult.address_region,
        postal_code: piiResult.address_postal_code,
        country: piiResult.address_country,
      })
    : null;

  // If no email from PII DB, use a placeholder (user may need PII DB configuration)
  const email = piiResult?.email ?? `${coreResult.id}@unknown`;

  return {
    id: coreResult.id,
    email,
    email_verified: coreResult.email_verified === 1,
    name: piiResult?.name ?? null,
    family_name: piiResult?.family_name ?? null,
    given_name: piiResult?.given_name ?? null,
    middle_name: piiResult?.middle_name ?? null,
    nickname: piiResult?.nickname ?? null,
    preferred_username: piiResult?.preferred_username ?? null,
    picture: piiResult?.picture ?? null,
    locale: piiResult?.locale ?? null,
    phone_number: piiResult?.phone_number ?? null,
    phone_number_verified: coreResult.phone_number_verified === 1,
    address: addressJson,
    birthdate: piiResult?.birthdate ?? null,
    gender: piiResult?.gender ?? null,
    profile: piiResult?.profile ?? null,
    website: piiResult?.website ?? null,
    zoneinfo: piiResult?.zoneinfo ?? null,
    updated_at: coreResult.updated_at,
  };
}

/**
 * Invalidate user cache entry
 * Call this when user data is updated (PATCH /users/{id}, password reset, etc.)
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID to invalidate
 */
export async function invalidateUserCache(env: Env, userId: string): Promise<void> {
  if (!env.USER_CACHE) {
    return;
  }

  const cacheKey = buildKVKey('user', userId);

  try {
    await env.USER_CACHE.delete(cacheKey);
  } catch (error) {
    // Log but don't throw - cache invalidation failure is not critical
    // PII Protection: Don't log userId
    console.warn('Failed to invalidate user cache');
  }
}

/**
 * Minimal user core data structure (non-PII only)
 * Used for existence checks in auth flows that must NOT access PII DB
 *
 * Note: This is intentionally a minimal subset of CachedUserCore (from repositories/cache)
 * to support lightweight existence checks without loading full user data.
 */
export interface UserCoreExistence {
  id: string;
  email_verified: boolean;
  phone_number_verified: boolean;
  updated_at: number;
}

/**
 * Get user core data from Core DB only (NO PII DB access)
 *
 * IMPORTANT: Use this function in auth flows (/authorize, /token) where
 * PII DB access is prohibited by PII/Non-PII separation architecture.
 *
 * This function:
 * - Only queries Core DB (users_core table)
 * - Never accesses PII DB (users_pii table)
 * - Returns only non-PII fields (id, email_verified, phone_number_verified, updated_at)
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID to retrieve
 * @returns Promise<UserCoreExistence | null>
 */
export async function getCachedUserCore(
  env: Env,
  userId: string
): Promise<UserCoreExistence | null> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const coreResult = await coreAdapter.queryOne<{
    id: string;
    email_verified: number;
    phone_number_verified: number;
    updated_at: number;
  }>(
    'SELECT id, email_verified, phone_number_verified, updated_at FROM users_core WHERE id = ? AND is_active = 1',
    [userId]
  );

  if (!coreResult) {
    return null;
  }

  return {
    id: coreResult.id,
    email_verified: coreResult.email_verified === 1,
    phone_number_verified: coreResult.phone_number_verified === 1,
    updated_at: coreResult.updated_at,
  };
}

// ===== Consent Cache =====
// Read-Through Cache for consent status with invalidation hook support
// TTL: Configurable via KV > env > default (86400 seconds = 24 hours)

/**
 * Cached consent data structure
 */
export interface CachedConsent {
  scope: string;
  granted_at: number;
  expires_at: number | null;
}

/**
 * Get consent status from cache or D1 (Read-Through Cache pattern)
 *
 * Architecture:
 * - Primary source: D1 database (oauth_client_consents table)
 * - Cache: CONSENT_CACHE KV (24 hour TTL)
 * - Invalidation: invalidateConsentCache() called on consent revocation
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID
 * @param clientId - Client ID
 * @returns Promise<CachedConsent | null>
 */
export async function getCachedConsent(
  env: Env,
  userId: string,
  clientId: string
): Promise<CachedConsent | null> {
  // If CONSENT_CACHE is not configured, fall back to D1 directly
  if (!env.CONSENT_CACHE) {
    return await getConsentFromD1(env, userId, clientId);
  }

  const cacheKey = buildKVKey('consent', `${userId}:${clientId}`);

  // Step 1: Try CONSENT_CACHE (Read-Through Cache)
  const cached = await env.CONSENT_CACHE.get(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached) as CachedConsent;
    } catch (error) {
      // Cache is corrupted - delete it and fetch from D1
      // PII Protection: Don't log full error (may contain cached data)
      console.error('Failed to parse cached consent data');
      await env.CONSENT_CACHE.delete(cacheKey).catch(() => {
        console.warn('Failed to delete corrupted consent cache');
      });
    }
  }

  // Step 2: Cache miss - fetch from D1
  const consent = await getConsentFromD1(env, userId, clientId);

  if (!consent) {
    return null;
  }

  // Step 3: Populate CONSENT_CACHE (TTL from KV > env > default)
  try {
    const configManager = createOAuthConfigManager(env);
    const consentCacheTTL = await configManager.getConsentCacheTTL();
    await env.CONSENT_CACHE.put(cacheKey, JSON.stringify(consent), {
      expirationTtl: consentCacheTTL,
    });
  } catch (error) {
    // Cache write failure should not block the response
    // PII Protection: Don't log userId/clientId
    console.warn('Failed to cache consent data');
  }

  return consent;
}

/**
 * Fetch consent directly from D1 database
 */
async function getConsentFromD1(
  env: Env,
  userId: string,
  clientId: string
): Promise<CachedConsent | null> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<{
    scope: string;
    granted_at: number;
    expires_at: number | null;
  }>(
    'SELECT scope, granted_at, expires_at FROM oauth_client_consents WHERE user_id = ? AND client_id = ?',
    [userId, clientId]
  );

  if (!result) {
    return null;
  }

  return {
    scope: result.scope,
    granted_at: result.granted_at,
    expires_at: result.expires_at,
  };
}

/**
 * Invalidate consent cache entry
 * Call this when consent is revoked or updated
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID
 * @param clientId - Optional client ID. If not provided, all consents for the user are invalidated
 */
export async function invalidateConsentCache(
  env: Env,
  userId: string,
  clientId?: string
): Promise<void> {
  if (!env.CONSENT_CACHE) {
    return;
  }

  if (clientId) {
    // Invalidate specific consent
    const cacheKey = buildKVKey('consent', `${userId}:${clientId}`);
    try {
      await env.CONSENT_CACHE.delete(cacheKey);
    } catch (error) {
      // PII Protection: Don't log userId/clientId
      console.warn('Failed to invalidate consent cache');
    }
  } else {
    // Note: KV doesn't support prefix deletion efficiently
    // For user-wide consent invalidation, we rely on TTL expiration
    // This is acceptable because consent revocation at user level is rare
    // PII Protection: Don't log userId
    console.warn('Cannot bulk invalidate consent cache. Individual caches will expire naturally.');
  }
}

/**
 * Store state parameter in KV
 *
 * @param env - Cloudflare environment bindings
 * @param state - State parameter value
 * @param clientId - Client ID that initiated the request
 * @returns Promise<void>
 */
export async function storeState(env: Env, state: string, clientId: string): Promise<void> {
  // KV > env > default priority
  const configManager = createOAuthConfigManager(env);
  const ttl = await configManager.getStateExpiry();
  const key = buildKVKey('state', state);

  await env.STATE_STORE.put(key, clientId, {
    expirationTtl: ttl,
  });
}

/**
 * Retrieve and validate state parameter from KV
 *
 * @param env - Cloudflare environment bindings
 * @param state - State parameter to validate
 * @returns Promise<string | null> - Returns client_id if valid, null otherwise
 */
export async function getState(env: Env, state: string): Promise<string | null> {
  const key = buildKVKey('state', state);
  return await env.STATE_STORE.get(key);
}

/**
 * Delete state parameter from KV after validation
 *
 * @param env - Cloudflare environment bindings
 * @param state - State parameter to delete
 * @returns Promise<void>
 */
export async function deleteState(env: Env, state: string): Promise<void> {
  const key = buildKVKey('state', state);
  await env.STATE_STORE.delete(key);
}

/**
 * Store nonce parameter in KV
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter value
 * @param clientId - Client ID that initiated the request
 * @returns Promise<void>
 */
export async function storeNonce(env: Env, nonce: string, clientId: string): Promise<void> {
  // KV > env > default priority
  const configManager = createOAuthConfigManager(env);
  const ttl = await configManager.getNonceExpiry();
  const key = buildKVKey('nonce', nonce);

  await env.NONCE_STORE.put(key, clientId, {
    expirationTtl: ttl,
  });
}

/**
 * Retrieve and validate nonce parameter from KV
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter to validate
 * @returns Promise<string | null> - Returns client_id if valid, null otherwise
 */
export async function getNonce(env: Env, nonce: string): Promise<string | null> {
  const key = buildKVKey('nonce', nonce);
  return await env.NONCE_STORE.get(key);
}

/**
 * Delete nonce parameter from KV after validation
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter to delete
 * @returns Promise<void>
 */
export async function deleteNonce(env: Env, nonce: string): Promise<void> {
  const key = buildKVKey('nonce', nonce);
  await env.NONCE_STORE.delete(key);
}

/**
 * Retrieve client metadata using Read-Through Cache pattern
 *
 * Architecture:
 * - Primary source: D1 database (oauth_clients table)
 * - Cache: CLIENTS_CACHE KV (1 hour TTL)
 * - Pattern: Read-Through (cache miss → fetch from D1 → populate cache)
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to retrieve
 * @returns Promise<Record<string, unknown> | null>
 */
export async function getClient(
  env: Env,
  clientId: string
): Promise<Record<string, unknown> | null> {
  const cacheKey = buildKVKey('client', clientId);

  // Step 1: Try CLIENTS_CACHE (Read-Through Cache)
  const cached = await env.CLIENTS_CACHE.get(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached) as Record<string, unknown>;
    } catch (error) {
      // Cache is corrupted - delete it and fetch from D1
      // PII Protection: Don't log full error (may contain cached data)
      console.error('Failed to parse cached client data');
      await env.CLIENTS_CACHE.delete(cacheKey).catch(() => {
        console.warn('Failed to delete corrupted cache');
      });
    }
  }

  // Step 2: Cache miss - fetch from D1 (source of truth)
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<{
    client_id: string;
    client_secret: string | null;
    client_name: string | null;
    redirect_uris: string;
    grant_types: string;
    response_types: string;
    scope: string | null;
    token_endpoint_auth_method: string | null;
    contacts: string | null;
    logo_uri: string | null;
    client_uri: string | null;
    policy_uri: string | null;
    tos_uri: string | null;
    jwks_uri: string | null;
    jwks: string | null;
    subject_type: string | null;
    sector_identifier_uri: string | null;
    id_token_signed_response_alg: string | null;
    userinfo_signed_response_alg: string | null;
    request_object_signing_alg: string | null;
    is_trusted: number | null;
    skip_consent: number | null;
    allow_claims_without_scope: number | null;
    // RFC 8693: Token Exchange settings
    token_exchange_allowed: number | null;
    allowed_subject_token_clients: string | null;
    allowed_token_exchange_resources: string | null;
    delegation_mode: string | null;
    // RFC 6749 Section 4.4: Client Credentials settings
    client_credentials_allowed: number | null;
    allowed_scopes: string | null;
    default_scope: string | null;
    default_audience: string | null;
    created_at: number;
    updated_at: number;
  }>('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId]);

  if (!result) {
    return null;
  }

  // Step 3: Convert D1 result to client metadata format
  const clientData: Record<string, unknown> = {
    client_id: result.client_id,
    client_secret: result.client_secret,
    client_name: result.client_name,
    redirect_uris: JSON.parse(result.redirect_uris),
    grant_types: JSON.parse(result.grant_types),
    response_types: JSON.parse(result.response_types),
    scope: result.scope,
    token_endpoint_auth_method: result.token_endpoint_auth_method,
    contacts: result.contacts ? JSON.parse(result.contacts) : undefined,
    logo_uri: result.logo_uri,
    client_uri: result.client_uri,
    policy_uri: result.policy_uri,
    tos_uri: result.tos_uri,
    jwks_uri: result.jwks_uri,
    jwks: result.jwks ? JSON.parse(result.jwks) : undefined,
    subject_type: result.subject_type,
    sector_identifier_uri: result.sector_identifier_uri,
    id_token_signed_response_alg: result.id_token_signed_response_alg,
    userinfo_signed_response_alg: result.userinfo_signed_response_alg,
    request_object_signing_alg: result.request_object_signing_alg,
    is_trusted: result.is_trusted === 1,
    skip_consent: result.skip_consent === 1,
    allow_claims_without_scope: result.allow_claims_without_scope === 1,
    // RFC 8693: Token Exchange settings
    token_exchange_allowed: result.token_exchange_allowed === 1,
    allowed_subject_token_clients: result.allowed_subject_token_clients
      ? JSON.parse(result.allowed_subject_token_clients)
      : undefined,
    allowed_token_exchange_resources: result.allowed_token_exchange_resources
      ? JSON.parse(result.allowed_token_exchange_resources)
      : undefined,
    delegation_mode: result.delegation_mode || 'delegation',
    // RFC 6749 Section 4.4: Client Credentials settings
    client_credentials_allowed: result.client_credentials_allowed === 1,
    allowed_scopes: result.allowed_scopes ? JSON.parse(result.allowed_scopes) : undefined,
    default_scope: result.default_scope,
    default_audience: result.default_audience,
    created_at: result.created_at,
    updated_at: result.updated_at,
  };

  // Step 4: Populate CLIENTS_CACHE (1 hour TTL)
  try {
    await env.CLIENTS_CACHE.put(cacheKey, JSON.stringify(clientData), {
      expirationTtl: 3600, // 1 hour
    });
  } catch (error) {
    // Cache write failure should not block the response
    // D1 is the source of truth
    // PII Protection: Don't log clientId
    console.warn('Failed to cache client data');
  }

  return clientData;
}

/**
 * Revoke an access token by adding its JTI to the revocation list
 *
 * Per RFC 6749 Section 4.1.2: When an authorization code is used more than once,
 * the authorization server SHOULD revoke all tokens previously issued based on that code.
 *
 * @param env - Cloudflare environment bindings
 * @param jti - JWT ID of the token to revoke
 * @param expiresIn - Token expiration time in seconds (TTL for revocation list entry)
 * @param reason - Optional revocation reason
 * @returns Promise<void>
 */
export async function revokeToken(
  env: Env,
  jti: string,
  expiresIn: number,
  reason?: string
): Promise<void> {
  if (!env.TOKEN_REVOCATION_STORE) {
    throw new Error('TOKEN_REVOCATION_STORE Durable Object not available');
  }

  // Use sharded Durable Object instance for token revocations
  const { stub } = await getRevocationStoreByJti(env, jti);

  const response = await stub.fetch('http://internal/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jti,
      ttl: expiresIn,
      reason: reason || 'Token revoked',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to revoke token: ${error}`);
  }
}

/**
 * Check if an access token has been revoked
 *
 * @param env - Cloudflare environment bindings
 * @param jti - JWT ID of the token to check
 * @returns Promise<boolean> - True if token is revoked
 */
export async function isTokenRevoked(env: Env, jti: string): Promise<boolean> {
  if (!env.TOKEN_REVOCATION_STORE) {
    console.warn('TOKEN_REVOCATION_STORE binding is not configured; skipping revocation check');
    return false;
  }

  try {
    // Use sharded Durable Object instance for token revocation checks
    const { stub } = await getRevocationStoreByJti(env, jti);

    const response = await stub.fetch(`http://internal/check?jti=${encodeURIComponent(jti)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json<{ revoked: boolean }>();
    return data.revoked;
  } catch (error) {
    // PII Protection: Don't log full error (may contain token details)
    console.error(
      'Failed to check token revocation:',
      error instanceof Error ? error.name : 'Unknown error'
    );
    return false;
  }
}

// RefreshTokenData is now imported from types/oidc

/**
 * Store refresh token using RefreshTokenRotator DO
 * Creates a new token family for the refresh token
 *
 * @param env - Cloudflare environment bindings
 * @param jti - Refresh token JTI (unique identifier) - this is the actual token value
 * @param data - Refresh token metadata
 * @returns Promise<void>
 */
export async function storeRefreshToken(
  env: Env,
  jti: string,
  data: RefreshTokenData
): Promise<void> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  // V3: Parse JTI to extract generation/shard info for proper routing
  const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } = await import(
    './refresh-token-sharding'
  );
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    data.client_id,
    parsedJti.generation,
    parsedJti.shardIndex
  );

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  // KV > env > default priority for refresh token TTL
  const configManager = createOAuthConfigManager(env);
  const refreshTokenTTL = await configManager.getRefreshTokenExpiry();

  // Use RPC for family creation
  await stub.createFamilyRpc({
    jti: jti,
    userId: data.sub,
    clientId: data.client_id,
    scope: data.scope || '',
    ttl: refreshTokenTTL,
    // V3: Include generation and shard for DO to store
    ...(parsedJti.generation > 0 &&
      parsedJti.shardIndex !== null && {
        generation: parsedJti.generation,
        shardIndex: parsedJti.shardIndex,
      }),
  });
}

/**
 * Retrieve refresh token metadata using RefreshTokenRotator DO (V2)
 * Note: This validates the token and returns metadata if valid
 *
 * V2 API uses version-based validation. The token's userId and version (rtv claim)
 * are used to look up the token family in the DO.
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID from the refresh token's sub claim
 * @param version - Token version from the refresh token's rtv claim
 * @param clientId - Client ID (required to locate the correct DO instance)
 * @param jti - JWT ID for verification against stored last_jti
 * @returns Promise<RefreshTokenData | null>
 */
export async function getRefreshToken(
  env: Env,
  userId: string,
  version: number,
  clientId: string,
  jti: string
): Promise<RefreshTokenData | null> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  // V3: Parse JTI to extract generation/shard info for proper routing
  const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } = await import(
    './refresh-token-sharding'
  );
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    clientId,
    parsedJti.generation,
    parsedJti.shardIndex
  );

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  try {
    // V2: Use RPC for version-based validation
    const result = await stub.validateRpc(userId, version, clientId);

    if (!result.valid || !result.family) {
      return null;
    }

    // Convert DO response to RefreshTokenData format
    // familyId is constructed from userId:clientId (matches DO key structure)
    return {
      jti,
      client_id: clientId,
      sub: userId,
      scope: result.family.allowed_scope || '',
      iat: Math.floor(Date.now() / 1000), // V2 doesn't return createdAt
      exp: Math.floor((result.family.expires_at || Date.now()) / 1000),
      familyId: `${userId}:${clientId}`,
    };
  } catch (error) {
    // PII Protection: Don't log full error (may contain token details)
    console.error(
      'Failed to get refresh token:',
      error instanceof Error ? error.name : 'Unknown error'
    );
    return null;
  }
}

/**
 * Delete refresh token using RefreshTokenRotator DO
 * Revokes the entire token family for security
 *
 * @param env - Cloudflare environment bindings
 * @param jti - Refresh token JTI (the actual token value)
 * @param client_id - Client ID (required to locate the correct DO instance)
 * @returns Promise<void>
 */
export async function deleteRefreshToken(env: Env, jti: string, client_id: string): Promise<void> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  // V3: Parse JTI to extract generation/shard info for proper routing
  const { parseRefreshTokenJti, buildRefreshTokenRotatorInstanceName } = await import(
    './refresh-token-sharding'
  );
  const parsedJti = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    client_id,
    parsedJti.generation,
    parsedJti.shardIndex
  );

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  // Use RPC to revoke by JTI (internally finds family and revokes)
  try {
    await stub.revokeByJtiRpc(jti, 'Token revocation requested');
  } catch (error) {
    // Token doesn't exist or already revoked - that's OK for delete operations
    console.log('Token revocation completed (may already be revoked):', error);
  }
}

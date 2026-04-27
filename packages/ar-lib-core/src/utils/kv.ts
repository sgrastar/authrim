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
import type { ClientMetadata, RefreshTokenData } from '../types/oidc';
import { ensureDatabaseAdapter, type DatabaseSource } from '../db';
import { buildKVKey, buildDOInstanceName } from './tenant-context';
import { createOAuthConfigManager } from './oauth-config';
import { getRevocationStoreByJti } from './token-revocation-sharding';
import type { DatabaseAdapter } from '../db/adapter';
import { createLogger } from './logger';
import { getCacheTTL } from './cache-config';
import { getDefaultTenantId } from './issuer';
import {
  storeRefreshToken as storeRefreshTokenCanonical,
  getRefreshToken as getRefreshTokenCanonical,
  deleteRefreshToken as deleteRefreshTokenCanonical,
} from './refresh-token-store';

const log = createLogger().module('KV');

export interface UserCacheSources {
  coreDb: DatabaseSource;
  piiDb?: DatabaseSource | null;
}

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
export async function getCachedUser(
  env: Env,
  userId: string,
  sources: UserCacheSources
): Promise<CachedUser | null> {
  // If USER_CACHE is not configured, fall back to D1 directly
  if (!env.USER_CACHE) {
    return await getUserFromD1(userId, sources);
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
      log.error('Failed to parse cached user data', {}, error as Error);
      await env.USER_CACHE.delete(cacheKey).catch(() => {
        log.warn('Failed to delete corrupted user cache');
      });
    }
  }

  // Step 2: Cache miss - fetch from D1
  const user = await getUserFromD1(userId, sources);

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
    log.warn('Failed to cache user data');
  }

  return user;
}

/**
 * Fetch user directly from D1 database
 * PII/Non-PII DB separation: fetches from Core DB and PII DB in parallel and merges
 */
async function getUserFromD1(userId: string, sources: UserCacheSources): Promise<CachedUser | null> {
  // Query Core DB for existence and non-PII fields
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(sources.coreDb, 'user-cache-core');
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

  if (sources.piiDb) {
    const piiAdapter: DatabaseAdapter = ensureDatabaseAdapter(sources.piiDb, 'user-cache-pii');
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
    log.warn('Failed to invalidate user cache');
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
  /** User type for anonymous user detection (architecture-decisions.md §17) */
  user_type?: string;
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
  userId: string,
  coreDbSource: DatabaseSource
): Promise<UserCoreExistence | null> {
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(coreDbSource, 'user-core-cache');
  const coreResult = await coreAdapter.queryOne<{
    id: string;
    email_verified: number;
    phone_number_verified: number;
    updated_at: number;
    user_type: string | null;
  }>(
    'SELECT id, email_verified, phone_number_verified, updated_at, user_type FROM users_core WHERE id = ? AND is_active = 1',
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
    user_type: coreResult.user_type ?? undefined,
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
  clientId: string,
  tenantId: string,
  coreDbSource: DatabaseSource
): Promise<CachedConsent | null> {
  // If CONSENT_CACHE is not configured, fall back to D1 directly
  if (!env.CONSENT_CACHE) {
    return await getConsentFromDatabase(userId, clientId, tenantId, coreDbSource);
  }

  const cacheKey = buildKVKey('consent', `${tenantId}:${userId}:${clientId}`);

  // Step 1: Try CONSENT_CACHE (Read-Through Cache)
  const cached = await env.CONSENT_CACHE.get(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached) as CachedConsent;
    } catch (error) {
      // Cache is corrupted - delete it and fetch from D1
      // PII Protection: Don't log full error (may contain cached data)
      log.error('Failed to parse cached consent data', {}, error as Error);
      await env.CONSENT_CACHE.delete(cacheKey).catch(() => {
        log.warn('Failed to delete corrupted consent cache');
      });
    }
  }

  // Step 2: Cache miss - fetch from D1
  const consent = await getConsentFromDatabase(userId, clientId, tenantId, coreDbSource);

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
    log.warn('Failed to cache consent data');
  }

  return consent;
}

/**
 * Fetch consent directly from the configured core database.
 */
async function getConsentFromDatabase(
  userId: string,
  clientId: string,
  tenantId: string,
  coreDbSource: DatabaseSource
): Promise<CachedConsent | null> {
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(coreDbSource, 'consent-cache');
  const result = await coreAdapter.queryOne<{
    scope: string;
    granted_at: number;
    expires_at: number | null;
  }>(
    `SELECT scope, granted_at, expires_at
       FROM oauth_client_consents
      WHERE user_id = ? AND client_id = ? AND tenant_id = ?`,
    [userId, clientId, tenantId]
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
  tenantId: string,
  clientId?: string
): Promise<void> {
  if (!env.CONSENT_CACHE) {
    return;
  }

  if (clientId) {
    // Invalidate specific consent
    const cacheKey = buildKVKey('consent', `${tenantId}:${userId}:${clientId}`);
    try {
      await env.CONSENT_CACHE.delete(cacheKey);
    } catch (error) {
      // PII Protection: Don't log userId/clientId
      log.warn('Failed to invalidate consent cache');
    }
  } else {
    // Note: KV doesn't support prefix deletion efficiently
    // For user-wide consent invalidation, we rely on TTL expiration
    // This is acceptable because consent revocation at user level is rare
    // PII Protection: Don't log userId
    log.warn('Cannot bulk invalidate consent cache. Individual caches will expire naturally.');
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
 * Parse client metadata array fields with backward compatibility.
 *
 * Handles:
 * - Normal JSON arrays: '["code"]'
 * - Double-encoded JSON: "\"[\\\"code\\\"]\""
 * - String values: "code" / "openid,profile"
 * - Corrupted char arrays: ["[", "\"", "c", "o", "d", "e", "\"", "]"]
 */
function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  let current: unknown = value;

  // Decode nested JSON string representations (max 3 passes for safety)
  for (let i = 0; i < 3; i++) {
    if (typeof current !== 'string') {
      break;
    }

    const trimmed = current.trim();
    if (!trimmed) {
      return fallback;
    }

    if (
      !(
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
      )
    ) {
      break;
    }

    try {
      current = JSON.parse(trimmed);
    } catch {
      break;
    }
  }

  if (Array.isArray(current)) {
    // Repair malformed char arrays persisted from spread(string) patterns.
    if (current.every((item) => typeof item === 'string' && item.length === 1)) {
      return normalizeStringArray(current.join(''), fallback);
    }

    return current
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof current === 'string') {
    const trimmed = current.trim();
    if (!trimmed) {
      return fallback;
    }

    if (trimmed.includes(',')) {
      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    return [trimmed];
  }

  return fallback;
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  const normalized = normalizeStringArray(value, []);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeClientMetadata(client: ClientMetadata): ClientMetadata {
  return {
    ...client,
    redirect_uris: normalizeStringArray(client.redirect_uris, []),
    grant_types: normalizeStringArray(client.grant_types, ['authorization_code']),
    response_types: normalizeStringArray(client.response_types, ['code']),
    contacts: normalizeOptionalStringArray(client.contacts),
    allowed_subject_token_clients: normalizeOptionalStringArray(
      client.allowed_subject_token_clients
    ),
    allowed_token_exchange_resources: normalizeOptionalStringArray(
      client.allowed_token_exchange_resources
    ),
    allowed_scopes: normalizeOptionalStringArray(client.allowed_scopes),
    post_logout_redirect_uris: normalizeOptionalStringArray(client.post_logout_redirect_uris),
    requestable_scopes: normalizeOptionalStringArray(client.requestable_scopes),
    allowed_redirect_origins: normalizeOptionalStringArray(client.allowed_redirect_origins),
  };
}

/**
 * Retrieve client metadata using Read-Through Cache pattern
 *
 * Architecture:
 * - Primary source: D1 database (oauth_clients table)
 * - Cache: CLIENTS_CACHE KV (TTL based on cache mode)
 * - Pattern: Read-Through (cache miss → fetch from D1 → populate cache)
 *
 * Cache mode:
 * - fixed: 24 hours TTL (production)
 * - maintenance: 30 seconds TTL (development/changes)
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to retrieve
 * @returns Promise<ClientMetadata | null>
 */
export async function getClient(
  env: Env,
  clientId: string,
  coreDbSource: DatabaseSource
): Promise<ClientMetadata | null> {
  const cacheKey = buildKVKey('client', clientId);

  // Get cache TTL based on cache mode (client-specific > platform > default)
  const cacheTtl = await getCacheTTL(env, 'clientMetadata', clientId);

  // Step 1: Try CLIENTS_CACHE (Read-Through Cache with edge memory cache)
  const cached = await env.CLIENTS_CACHE.get(cacheKey, { cacheTtl });

  if (cached) {
    try {
      return normalizeClientMetadata(JSON.parse(cached) as ClientMetadata);
    } catch (error) {
      // Cache is corrupted - delete it and fetch from D1
      // PII Protection: Don't log full error (may contain cached data)
      log.error('Failed to parse cached client data', {}, error as Error);
      await env.CLIENTS_CACHE.delete(cacheKey).catch(() => {
        log.warn('Failed to delete corrupted cache');
      });
    }
  }

  // Step 2: Cache miss - fetch from D1 (source of truth)
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(coreDbSource, 'client-cache');
  const result = await coreAdapter.queryOne<{
    client_id: string;
    client_secret_hash: string | null;
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
    // OIDC 3rd Party Initiated Login (OIDC Core Section 4)
    initiate_login_uri: string | null;
    // RFC 7592: Client Configuration Endpoint
    registration_access_token_hash: string | null;
    // OIDC Logout endpoints
    post_logout_redirect_uris: string | null;
    backchannel_logout_uri: string | null;
    backchannel_logout_session_required: number | null;
    frontchannel_logout_uri: string | null;
    frontchannel_logout_session_required: number | null;
    // RFC 7591: Dynamic Client Registration
    software_id: string | null;
    software_version: string | null;
    requestable_scopes: string | null;
    // CIBA (Client Initiated Backchannel Authentication) settings
    backchannel_token_delivery_mode: string | null;
    backchannel_client_notification_endpoint: string | null;
    backchannel_authentication_request_signing_alg: string | null;
    backchannel_user_code_parameter: number | null;
    // Authrim Extension: Custom Redirect URIs
    allowed_redirect_origins: string | null;
    // PKCE settings
    require_pkce: number | null;
    // Multi-tenant support
    tenant_id: string;
    created_at: number;
    updated_at: number;
  }>('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId]);

  if (!result) {
    return null;
  }

  // Step 3: Convert D1 result to client metadata format
  // Note: ClientMetadata has many optional properties; we construct the subset stored in D1
  const clientData: ClientMetadata = {
    client_id: result.client_id,
    client_secret_hash: result.client_secret_hash ?? undefined,
    client_name: result.client_name ?? undefined,
    redirect_uris: normalizeStringArray(result.redirect_uris, []),
    grant_types: normalizeStringArray(result.grant_types, ['authorization_code']),
    response_types: normalizeStringArray(result.response_types, ['code']),
    scope: result.scope ?? undefined,
    token_endpoint_auth_method: result.token_endpoint_auth_method ?? undefined,
    contacts: normalizeOptionalStringArray(result.contacts),
    logo_uri: result.logo_uri ?? undefined,
    client_uri: result.client_uri ?? undefined,
    policy_uri: result.policy_uri ?? undefined,
    tos_uri: result.tos_uri ?? undefined,
    jwks_uri: result.jwks_uri ?? undefined,
    jwks: result.jwks ? JSON.parse(result.jwks) : undefined,
    subject_type: (result.subject_type as 'public' | 'pairwise' | undefined) ?? undefined,
    sector_identifier_uri: result.sector_identifier_uri ?? undefined,
    id_token_signed_response_alg: result.id_token_signed_response_alg ?? undefined,
    userinfo_signed_response_alg: result.userinfo_signed_response_alg ?? undefined,
    request_object_signing_alg: result.request_object_signing_alg ?? undefined,
    is_trusted: result.is_trusted === 1,
    skip_consent: result.skip_consent === 1,
    allow_claims_without_scope: result.allow_claims_without_scope === 1,
    // RFC 8693: Token Exchange settings
    token_exchange_allowed: result.token_exchange_allowed === 1,
    allowed_subject_token_clients: normalizeOptionalStringArray(
      result.allowed_subject_token_clients
    ),
    allowed_token_exchange_resources: normalizeOptionalStringArray(
      result.allowed_token_exchange_resources
    ),
    delegation_mode:
      (result.delegation_mode as 'none' | 'delegation' | 'impersonation') || 'delegation',
    // RFC 6749 Section 4.4: Client Credentials settings
    client_credentials_allowed: result.client_credentials_allowed === 1,
    allowed_scopes: normalizeOptionalStringArray(result.allowed_scopes),
    default_scope: result.default_scope ?? undefined,
    default_audience: result.default_audience ?? undefined,
    // OIDC 3rd Party Initiated Login (OIDC Core Section 4)
    initiate_login_uri: result.initiate_login_uri ?? undefined,
    // RFC 7592: Client Configuration Endpoint (hash only, not exposed)
    registration_access_token_hash: result.registration_access_token_hash ?? undefined,
    // OIDC Logout endpoints
    post_logout_redirect_uris: normalizeOptionalStringArray(result.post_logout_redirect_uris),
    backchannel_logout_uri: result.backchannel_logout_uri ?? undefined,
    backchannel_logout_session_required: result.backchannel_logout_session_required === 1,
    frontchannel_logout_uri: result.frontchannel_logout_uri ?? undefined,
    frontchannel_logout_session_required: result.frontchannel_logout_session_required === 1,
    // RFC 7591: Dynamic Client Registration
    software_id: result.software_id ?? undefined,
    software_version: result.software_version ?? undefined,
    requestable_scopes: normalizeOptionalStringArray(result.requestable_scopes),
    // CIBA (Client Initiated Backchannel Authentication) settings
    backchannel_token_delivery_mode: result.backchannel_token_delivery_mode ?? undefined,
    backchannel_client_notification_endpoint:
      result.backchannel_client_notification_endpoint ?? undefined,
    backchannel_authentication_request_signing_alg:
      result.backchannel_authentication_request_signing_alg ?? undefined,
    backchannel_user_code_parameter: result.backchannel_user_code_parameter === 1,
    // Authrim Extension: Custom Redirect URIs
    allowed_redirect_origins: normalizeOptionalStringArray(result.allowed_redirect_origins),
    // PKCE settings
    require_pkce: result.require_pkce === 1,
    // Multi-tenant support
    tenant_id: result.tenant_id || getDefaultTenantId(env),
    created_at: result.created_at,
    updated_at: result.updated_at,
  };

  const normalizedClientData = normalizeClientMetadata(clientData);

  // Step 4: Populate CLIENTS_CACHE (TTL based on cache mode)
  try {
    await env.CLIENTS_CACHE.put(cacheKey, JSON.stringify(normalizedClientData), {
      expirationTtl: cacheTtl,
    });
  } catch (error) {
    // Cache write failure should not block the response
    // D1 is the source of truth
    // PII Protection: Don't log clientId
    log.warn('Failed to cache client data');
  }

  return normalizedClientData;
}

/**
 * Write client metadata to KV (Write-Through)
 *
 * Call this after D1 write operations (create/update) to keep KV in sync.
 * This enables efficient reads from KV cache without D1 fallback.
 *
 * @param env - Cloudflare environment bindings
 * @param clientData - Full client metadata to cache
 * @returns Promise<void>
 */
export async function putClient(env: Env, clientData: ClientMetadata): Promise<void> {
  const cacheKey = buildKVKey('client', clientData.client_id);
  const cacheTtl = await getCacheTTL(env, 'clientMetadata', clientData.client_id);

  try {
    await env.CLIENTS_CACHE.put(cacheKey, JSON.stringify(clientData), {
      expirationTtl: cacheTtl,
    });
    log.debug('Client data cached to KV (Write-Through)');
  } catch (error) {
    // Log error but don't throw - D1 is source of truth
    // Next read will repopulate from D1 via Read-Through
    log.warn('Failed to cache client data (Write-Through)');
  }
}

/**
 * Delete client metadata from KV
 *
 * Call this after D1 delete operations to keep KV in sync.
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to delete from cache
 * @returns Promise<void>
 */
export async function deleteClientFromKV(env: Env, clientId: string): Promise<void> {
  const cacheKey = buildKVKey('client', clientId);

  try {
    await env.CLIENTS_CACHE.delete(cacheKey);
    log.debug('Client data deleted from KV');
  } catch (error) {
    // Log error but don't throw - D1 is source of truth
    log.warn('Failed to delete client data from KV');
  }
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
    log.warn('TOKEN_REVOCATION_STORE binding is not configured; skipping revocation check');
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
    log.error('Failed to check token revocation', {}, error as Error);
    return false;
  }
}

// RefreshTokenData is now imported from types/oidc

/**
 * Legacy internal shim for refresh token storage.
 *
 * Canonical public exports live in `utils/refresh-token-store.ts`.
 * Keep this wrapper only to avoid rewriting every internal reference in one step.
 */
async function storeRefreshToken(
  env: Env,
  jti: string,
  data: RefreshTokenData
): Promise<void> {
  return storeRefreshTokenCanonical(env, jti, data);
}

/**
 * Legacy internal shim for refresh token lookup.
 */
async function getRefreshToken(
  env: Env,
  userId: string,
  version: number,
  clientId: string,
  jti: string
): Promise<RefreshTokenData | null> {
  return getRefreshTokenCanonical(env, userId, version, clientId, jti);
}

/**
 * Legacy internal shim for refresh token deletion.
 */
async function deleteRefreshToken(env: Env, jti: string, client_id: string): Promise<void> {
  return deleteRefreshTokenCanonical(env, jti, client_id);
}

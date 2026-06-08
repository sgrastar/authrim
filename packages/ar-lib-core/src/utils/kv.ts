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
import type { DatabaseAdapter, PIIStatus } from '../db/adapter';
import { createLogger } from './logger';
import { createCompatibilityError, OIDCError } from './errors';
import { getCacheTTL } from './cache-config';
import { getDefaultTenantId } from './issuer';
import { readResponseTextWithLimit } from './url-security';
import {
  storeRefreshToken as storeRefreshTokenCanonical,
  getRefreshToken as getRefreshTokenCanonical,
  deleteRefreshToken as deleteRefreshTokenCanonical,
} from './refresh-token-store';
import { CanonicalRuntimeUserStore } from '../repositories/identity';

const log = createLogger().module('KV');
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PII_CACHE_PURPOSE = 'user-pii-cache';
const PII_CACHE_ALGORITHM = 'AES-256-GCM';
const PII_CACHE_DEFAULT_TTL_SECONDS = 5 * 60;
const PII_CACHE_ROOT_KEY_HEX_LENGTH = 64;
const TOKEN_REVOCATION_ERROR_BODY_MAX_BYTES = 64 * 1024;

function requireTenantId(tenantId: string | undefined, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

export interface UserCacheSources {
  coreDb: DatabaseSource;
  piiDb?: DatabaseSource | null;
  cacheScope?: UserCacheScope;
  piiCacheMode?: UserPiiCacheMode;
}

export type UserPiiCacheMode = 'merged' | 'encrypted_short_ttl' | 'no_cross_request_pii';

export interface UserCacheScope {
  storageProfileId: string;
  sourceGeneration?: string | number;
  schemaVersion?: string | number;
}

interface EncryptedCachedUserEnvelope {
  version: 1;
  algorithm: typeof PII_CACHE_ALGORITHM;
  purpose: typeof PII_CACHE_PURPOSE;
  tenantId: string;
  keyVersion: number;
  keyState: 'current';
  iv: string;
  ciphertext: string;
  metadata: {
    storageProfileId?: string;
    sourceGeneration?: string | number;
    schemaVersion?: string | number;
  };
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
  pii_status?: PIIStatus;
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

export function buildUserCacheKey(
  tenantId: string,
  userId: string,
  scope?: UserCacheScope
): string {
  if (!scope) {
    return buildKVKey('user', userId, tenantId);
  }

  const profile = encodeURIComponent(scope.storageProfileId);
  const generation = encodeURIComponent(String(scope.sourceGeneration ?? 'default'));
  const schema = encodeURIComponent(String(scope.schemaVersion ?? '1'));
  return buildKVKey(`user:v2:sp:${profile}:gen:${generation}:schema:${schema}`, userId, tenantId);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getPiiCacheRootKey(env: Env): string | null {
  const key = env.OBJECT_ENCRYPTION_ROOT_KEY?.trim();
  if (!key) return null;
  if (key.length !== PII_CACHE_ROOT_KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error('PII cache encryption root key must be a 64-character hex string');
  }
  return key;
}

function getPiiCacheKeyVersion(env: Env): number {
  return Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
}

function getPiiCacheTtl(env: Env, configuredUserCacheTtl: number): number {
  const configuredPiiTtl =
    Number.parseInt(env.PII_CACHE_TTL || String(PII_CACHE_DEFAULT_TTL_SECONDS), 10) ||
    PII_CACHE_DEFAULT_TTL_SECONDS;
  return Math.max(1, Math.min(configuredUserCacheTtl, configuredPiiTtl));
}

function parseJsonString(value: string | null | undefined): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildPiiCacheAdditionalData(
  tenantId: string,
  userId: string,
  cacheKey: string,
  scope: UserCacheScope | undefined,
  keyVersion: number
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      cache_key: cacheKey,
      purpose: PII_CACHE_PURPOSE,
      key_version: keyVersion,
      storage_profile_id: scope?.storageProfileId ?? null,
      source_generation: scope?.sourceGeneration ?? null,
      schema_version: scope?.schemaVersion ?? null,
    })
  );
}

async function derivePiiCacheKey(
  rootKeyHex: string,
  tenantId: string,
  keyVersion: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', hexToBytes(rootKeyHex), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode('authrim-cache-envelope-root'),
      info: textEncoder.encode(`${PII_CACHE_PURPOSE}:tenant:${tenantId}:v${keyVersion}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptCachedUser(
  env: Env,
  tenantId: string,
  userId: string,
  cacheKey: string,
  user: CachedUser,
  scope: UserCacheScope | undefined
): Promise<EncryptedCachedUserEnvelope | null> {
  const rootKey = getPiiCacheRootKey(env);
  if (!rootKey) return null;
  const keyVersion = getPiiCacheKeyVersion(env);
  const key = await derivePiiCacheKey(rootKey, tenantId, keyVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: buildPiiCacheAdditionalData(tenantId, userId, cacheKey, scope, keyVersion),
      tagLength: 128,
    },
    key,
    textEncoder.encode(JSON.stringify(user))
  );
  return {
    version: 1,
    algorithm: PII_CACHE_ALGORITHM,
    purpose: PII_CACHE_PURPOSE,
    tenantId,
    keyVersion,
    keyState: 'current',
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    metadata: {
      storageProfileId: scope?.storageProfileId,
      sourceGeneration: scope?.sourceGeneration,
      schemaVersion: scope?.schemaVersion,
    },
  };
}

async function decryptCachedUser(
  env: Env,
  tenantId: string,
  userId: string,
  cacheKey: string,
  cached: string,
  scope: UserCacheScope | undefined
): Promise<CachedUser> {
  const envelope = JSON.parse(cached) as EncryptedCachedUserEnvelope;
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== PII_CACHE_ALGORITHM ||
    envelope.purpose !== PII_CACHE_PURPOSE ||
    envelope.tenantId !== tenantId
  ) {
    throw new Error('invalid_encrypted_pii_cache_envelope');
  }
  const rootKey = getPiiCacheRootKey(env);
  if (!rootKey) {
    throw new Error('pii_cache_encryption_key_not_configured');
  }
  const key = await derivePiiCacheKey(rootKey, tenantId, envelope.keyVersion);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(envelope.iv),
      additionalData: buildPiiCacheAdditionalData(
        tenantId,
        userId,
        cacheKey,
        scope,
        envelope.keyVersion
      ),
      tagLength: 128,
    },
    key,
    fromBase64Url(envelope.ciphertext)
  );
  return JSON.parse(textDecoder.decode(plaintext)) as CachedUser;
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
  tenantId: string,
  userId: string,
  sources: UserCacheSources
): Promise<CachedUser | null> {
  const piiCacheMode = sources.piiCacheMode ?? 'encrypted_short_ttl';
  if (piiCacheMode === 'no_cross_request_pii') {
    return await getUserFromD1(tenantId, userId, sources);
  }

  // If USER_CACHE is not configured, fall back to D1 directly
  if (!env.USER_CACHE) {
    return await getUserFromD1(tenantId, userId, sources);
  }

  const cacheKey = buildUserCacheKey(tenantId, userId, sources.cacheScope);

  // Step 1: Try USER_CACHE (Read-Through Cache)
  const cached = await env.USER_CACHE.get(cacheKey);

  if (cached) {
    try {
      return piiCacheMode === 'encrypted_short_ttl'
        ? await decryptCachedUser(env, tenantId, userId, cacheKey, cached, sources.cacheScope)
        : (JSON.parse(cached) as CachedUser);
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
  const user = await getUserFromD1(tenantId, userId, sources);

  if (!user) {
    return null;
  }

  // Step 3: Populate USER_CACHE (TTL from KV > env > default)
  try {
    const configManager = createOAuthConfigManager(env);
    const userCacheTTL = await configManager.getUserCacheTTL();
    if (piiCacheMode === 'encrypted_short_ttl') {
      const encrypted = await encryptCachedUser(
        env,
        tenantId,
        userId,
        cacheKey,
        user,
        sources.cacheScope
      );
      if (encrypted) {
        await env.USER_CACHE.put(cacheKey, JSON.stringify(encrypted), {
          expirationTtl: getPiiCacheTtl(env, userCacheTTL),
        });
      }
    } else {
      await env.USER_CACHE.put(cacheKey, JSON.stringify(user), {
        expirationTtl: userCacheTTL,
      });
    }
  } catch (error) {
    // Cache write failure should not block the response
    // PII Protection: Don't log userId (can be used for tracking)
    log.warn('Failed to cache user data');
  }

  return user;
}

async function getUserFromD1(
  tenantId: string,
  userId: string,
  sources: UserCacheSources
): Promise<CachedUser | null> {
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(sources.coreDb, 'user-cache-core');
  if (!sources.piiDb) {
    throw new Error('PII database is required for canonical runtime user cache');
  }
  const piiAdapter: DatabaseAdapter = ensureDatabaseAdapter(sources.piiDb, 'user-cache-pii');
  const userStore = new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
  const projection = await userStore.findById(userId);
  if (!projection) return null;
  const customAttributes = parseJsonString(projection.custom_attributes_json);
  const customAttributeObject =
    customAttributes && typeof customAttributes === 'object' && !Array.isArray(customAttributes)
      ? (customAttributes as Record<string, unknown>)
      : {};

  return {
    id: projection.id,
    pii_status:
      typeof customAttributeObject.pii_status === 'string'
        ? (customAttributeObject.pii_status as PIIStatus)
        : 'active',
    email: projection.email ?? `${projection.id}@unknown`,
    email_verified: projection.email_verified === 1,
    name: projection.name,
    family_name: projection.family_name,
    given_name: projection.given_name,
    middle_name: projection.middle_name,
    nickname: projection.nickname,
    preferred_username: projection.preferred_username,
    picture: projection.picture,
    locale: projection.locale,
    phone_number: projection.phone_number,
    phone_number_verified: projection.phone_number_verified === 1,
    address: projection.address_json,
    birthdate: projection.birthdate,
    gender: projection.gender,
    profile: projection.profile,
    website: projection.website,
    zoneinfo: projection.zoneinfo,
    updated_at:
      typeof projection.updated_at === 'number'
        ? projection.updated_at
        : Date.parse(projection.updated_at) || Date.now(),
  };
}

/**
 * Invalidate user cache entry
 * Call this when user data is updated (PATCH /users/{id}, password reset, etc.)
 *
 * @param env - Cloudflare environment bindings
 * @param userId - User ID to invalidate
 */
export async function invalidateUserCache(
  env: Env,
  tenantId: string,
  userId: string
): Promise<void> {
  if (!env.USER_CACHE) {
    return;
  }

  const cacheKey = buildKVKey('user', userId, tenantId);

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
  pii_status?: PIIStatus;
  email_verified: boolean;
  phone_number_verified: boolean;
  updated_at: number;
  /** User type for anonymous user detection (architecture-decisions.md §17) */
  user_type?: string;
}

/**
 * Get user core data from Core DB only.
 */
export async function getCachedUserCore(
  _env: Env,
  tenantId: string,
  userId: string,
  coreDbSource: DatabaseSource
): Promise<UserCoreExistence | null> {
  const coreAdapter: DatabaseAdapter = ensureDatabaseAdapter(coreDbSource, 'user-core-cache');
  const account = await coreAdapter.queryOne<{
    id: string;
    account_type: string;
    lifecycle_state: string;
    updated_at: number;
  }>(
    `SELECT id, account_type, lifecycle_state, updated_at
       FROM identity_accounts
      WHERE legacy_user_id = ? AND tenant_id = ? AND lifecycle_state = 'active'
      LIMIT 1`,
    [userId, tenantId]
  );

  if (!account) {
    return null;
  }
  const contactRows = await coreAdapter.query<{
    contact_type: string;
    verification_state: string;
  }>(
    `SELECT contact_type, verification_state
       FROM contact_points
      WHERE account_id = ? AND tenant_id = ? AND lifecycle_state = 'active'
        AND contact_type IN ('email', 'phone')`,
    [account.id, tenantId]
  );
  const emailContact = contactRows.find((row) => row.contact_type === 'email');
  const phoneContact = contactRows.find((row) => row.contact_type === 'phone');
  const userType =
    account.account_type === 'admin'
      ? 'admin'
      : account.account_type === 'service_account'
        ? 'm2m'
        : account.account_type === 'anonymous'
          ? 'anonymous'
          : 'end_user';

  return {
    id: userId,
    pii_status: 'active',
    email_verified: emailContact?.verification_state === 'verified',
    phone_number_verified: phoneContact?.verification_state === 'verified',
    updated_at: account.updated_at,
    user_type: userType,
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

  const cacheKey = buildKVKey('consent', `${userId}:${clientId}`, tenantId);

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
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [tenantId, userId, clientId]
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
    const cacheKey = buildKVKey('consent', `${userId}:${clientId}`, tenantId);
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
 * @param tenantId - Tenant ID
 * @returns Promise<void>
 */
export async function storeState(
  env: Env,
  state: string,
  clientId: string,
  tenantId: string
): Promise<void> {
  // KV > env > default priority
  const configManager = createOAuthConfigManager(env);
  const ttl = await configManager.getStateExpiry();
  const key = buildKVKey('state', state, tenantId);

  await env.STATE_STORE.put(key, clientId, {
    expirationTtl: ttl,
  });
}

/**
 * Retrieve and validate state parameter from KV
 *
 * @param env - Cloudflare environment bindings
 * @param state - State parameter to validate
 * @param tenantId - Tenant ID
 * @returns Promise<string | null> - Returns client_id if valid, null otherwise
 */
export async function getState(env: Env, state: string, tenantId: string): Promise<string | null> {
  const key = buildKVKey('state', state, tenantId);
  return await env.STATE_STORE.get(key);
}

/**
 * Delete state parameter from KV after validation
 *
 * @param env - Cloudflare environment bindings
 * @param state - State parameter to delete
 * @param tenantId - Tenant ID
 * @returns Promise<void>
 */
export async function deleteState(env: Env, state: string, tenantId: string): Promise<void> {
  const key = buildKVKey('state', state, tenantId);
  await env.STATE_STORE.delete(key);
}

/**
 * Store nonce parameter in KV
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter value
 * @param clientId - Client ID that initiated the request
 * @param tenantId - Tenant ID
 * @returns Promise<void>
 */
export async function storeNonce(
  env: Env,
  nonce: string,
  clientId: string,
  tenantId: string
): Promise<void> {
  // KV > env > default priority
  const configManager = createOAuthConfigManager(env);
  const ttl = await configManager.getNonceExpiry();
  const key = buildKVKey('nonce', nonce, tenantId);

  await env.NONCE_STORE.put(key, clientId, {
    expirationTtl: ttl,
  });
}

/**
 * Retrieve and validate nonce parameter from KV
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter to validate
 * @param tenantId - Tenant ID
 * @returns Promise<string | null> - Returns client_id if valid, null otherwise
 */
export async function getNonce(env: Env, nonce: string, tenantId: string): Promise<string | null> {
  const key = buildKVKey('nonce', nonce, tenantId);
  return await env.NONCE_STORE.get(key);
}

/**
 * Delete nonce parameter from KV after validation
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter to delete
 * @param tenantId - Tenant ID
 * @returns Promise<void>
 */
export async function deleteNonce(env: Env, nonce: string, tenantId: string): Promise<void> {
  const key = buildKVKey('nonce', nonce, tenantId);
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
  if (
    Object.prototype.hasOwnProperty.call(client as unknown as Record<string, unknown>, 'app_suite')
  ) {
    throw createCompatibilityError('legacy_app_suite_not_supported');
  }

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
    device_secret_revoke_trust_groups: normalizeOptionalStringArray(
      client.device_secret_revoke_trust_groups
    ),
    device_secret_introspection_trust_groups: normalizeOptionalStringArray(
      client.device_secret_introspection_trust_groups
    ),
    allowed_channels: normalizeOptionalStringArray(client.allowed_channels) as
      | Array<'browser' | 'native' | 'server'>
      | undefined,
  };
}

/**
 * Retrieve client metadata using Read-Through Cache pattern
 *
 * Architecture:
 * - Primary source: D1 database (oauth_clients table)
 * - Primary path is D1. KV can be used only when the configured TTL is positive.
 *
 * Cache mode:
 * - fixed: D1 source of truth for client metadata
 * - maintenance: 30 seconds TTL (development/changes)
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to retrieve
 * @returns Promise<ClientMetadata | null>
 */
export async function getClient(
  env: Env,
  tenantId: string,
  clientId: string,
  coreDbSource: DatabaseSource
): Promise<ClientMetadata | null> {
  const cacheKey = buildKVKey('client', clientId, tenantId);

  // Get cache TTL based on cache mode (client-specific > platform > default)
  const cacheTtl = await getCacheTTL(env, 'clientMetadata', clientId);

  // Step 1: Try CLIENTS_CACHE only when explicitly configured with a positive TTL.
  const cached = cacheTtl > 0 ? await env.CLIENTS_CACHE.get(cacheKey, { cacheTtl }) : null;

  if (cached) {
    try {
      return normalizeClientMetadata(JSON.parse(cached) as ClientMetadata);
    } catch (error) {
      if (error instanceof OIDCError && error.error === 'legacy_app_suite_not_supported') {
        throw error;
      }

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
    claims_parameter_policy: string | null;
    identity_mapping: string | null;
    attribute_release_consent: string | null;
    asc_enabled: number | null;
    asc_protected_request_required: number | null;
    asc_sao_enabled: number | null;
    asc_transformed_claims_enabled: number | null;
    asc_allowed_transformed_claims: string | null;
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
    default_resource: string | null;
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
    application_type: string | null;
    trust_group: string | null;
    trust_group_id: string | null;
    browser_public_client_mode: string | null;
    browser_refresh_token_policy: string | null;
    native_sso_enabled: number | null;
    native_channel_allowed: number | null;
    allowed_channels: string | null;
    device_secret_revoke_enabled: number | null;
    device_secret_revoke_trust_groups: string | null;
    device_secret_introspection_enabled: number | null;
    device_secret_introspection_trust_groups: string | null;
    created_at: number;
    updated_at: number;
  }>('SELECT * FROM oauth_clients WHERE tenant_id = ? AND client_id = ?', [tenantId, clientId]);

  if (!result) {
    return null;
  }

  // Step 3: Convert D1 result to client metadata format
  // Note: ClientMetadata has many optional properties; we construct the subset stored in D1
  const clientData: ClientMetadata = {
    client_id: result.client_id,
    client_secret_hash: result.client_secret_hash ?? undefined,
    client_name: result.client_name ?? undefined,
    application_type: result.application_type ?? undefined,
    trust_group: result.trust_group ?? undefined,
    trust_group_id: result.trust_group_id ?? undefined,
    browser_public_client_mode:
      result.browser_public_client_mode === 'strict' ||
      result.browser_public_client_mode === 'cookie_fallback'
        ? result.browser_public_client_mode
        : undefined,
    browser_refresh_token_policy:
      (result.browser_refresh_token_policy as 'disabled' | 'dpop_bound' | null) ?? 'disabled',
    native_sso_enabled:
      result.native_sso_enabled === null || result.native_sso_enabled === undefined
        ? undefined
        : result.native_sso_enabled === 1,
    native_channel_allowed:
      result.native_channel_allowed === null || result.native_channel_allowed === undefined
        ? undefined
        : result.native_channel_allowed === 1,
    allowed_channels: normalizeOptionalStringArray(result.allowed_channels) as
      | Array<'browser' | 'native' | 'server'>
      | undefined,
    device_secret_revoke_enabled:
      result.device_secret_revoke_enabled === null ||
      result.device_secret_revoke_enabled === undefined
        ? undefined
        : result.device_secret_revoke_enabled === 1,
    device_secret_revoke_trust_groups: normalizeOptionalStringArray(
      result.device_secret_revoke_trust_groups
    ),
    device_secret_introspection_enabled:
      result.device_secret_introspection_enabled === null ||
      result.device_secret_introspection_enabled === undefined
        ? undefined
        : result.device_secret_introspection_enabled === 1,
    device_secret_introspection_trust_groups: normalizeOptionalStringArray(
      result.device_secret_introspection_trust_groups
    ),
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
    claims_parameter_policy: result.claims_parameter_policy
      ? JSON.parse(result.claims_parameter_policy)
      : undefined,
    identity_mapping: result.identity_mapping ? JSON.parse(result.identity_mapping) : undefined,
    attribute_release_consent: result.attribute_release_consent
      ? JSON.parse(result.attribute_release_consent)
      : undefined,
    asc_enabled:
      result.asc_enabled === null || result.asc_enabled === undefined
        ? true
        : result.asc_enabled === 1,
    asc_protected_request_required:
      result.asc_protected_request_required === null ||
      result.asc_protected_request_required === undefined
        ? true
        : result.asc_protected_request_required === 1,
    asc_sao_enabled:
      result.asc_sao_enabled === null || result.asc_sao_enabled === undefined
        ? true
        : result.asc_sao_enabled === 1,
    asc_transformed_claims_enabled:
      result.asc_transformed_claims_enabled === null ||
      result.asc_transformed_claims_enabled === undefined
        ? true
        : result.asc_transformed_claims_enabled === 1,
    asc_allowed_transformed_claims: normalizeOptionalStringArray(
      result.asc_allowed_transformed_claims
    ),
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
    default_resource: result.default_resource ?? undefined,
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
    tenant_id: result.tenant_id || tenantId,
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
  const tenantId = requireTenantId(clientData.tenant_id, 'Client cache write');
  const cacheKey = buildKVKey('client', clientData.client_id, tenantId);
  const cacheTtl = await getCacheTTL(env, 'clientMetadata', clientData.client_id);
  const normalizedClientData = normalizeClientMetadata(clientData);

  if (cacheTtl <= 0) {
    return;
  }

  try {
    await env.CLIENTS_CACHE.put(cacheKey, JSON.stringify(normalizedClientData), {
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
export async function deleteClientFromKV(
  env: Env,
  tenantId: string,
  clientId: string
): Promise<void> {
  const cacheKey = buildKVKey('client', clientId, tenantId);

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
  reason: string | undefined,
  tenantId: string
): Promise<void> {
  if (!env.TOKEN_REVOCATION_STORE) {
    throw new Error('TOKEN_REVOCATION_STORE Durable Object not available');
  }

  // Use sharded Durable Object instance for token revocations
  const { stub } = await getRevocationStoreByJti(env, jti, tenantId);

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
    const error = await readResponseTextWithLimit(response, TOKEN_REVOCATION_ERROR_BODY_MAX_BYTES);
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
export async function isTokenRevoked(env: Env, jti: string, tenantId: string): Promise<boolean> {
  if (!env.TOKEN_REVOCATION_STORE) {
    log.warn('TOKEN_REVOCATION_STORE binding is not configured; skipping revocation check');
    return false;
  }

  try {
    // Use sharded Durable Object instance for token revocation checks
    const { stub, instanceName } = await getRevocationStoreByJti(env, jti, tenantId);

    const response = await stub.fetch(`http://internal/check?jti=${encodeURIComponent(jti)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json<{ revoked: boolean }>();
    if (data.revoked) {
      return true;
    }

    const legacyInstanceName = buildDOInstanceName('token-revocation', tenantId);
    if (legacyInstanceName !== instanceName) {
      const legacyId = env.TOKEN_REVOCATION_STORE.idFromName(legacyInstanceName);
      const legacyStub = env.TOKEN_REVOCATION_STORE.get(legacyId);
      const legacyResponse = await legacyStub.fetch(
        `http://internal/check?jti=${encodeURIComponent(jti)}`,
        {
          method: 'GET',
        }
      );
      if (legacyResponse.ok) {
        const legacyData = await legacyResponse.json<{ revoked: boolean }>();
        return legacyData.revoked;
      }
    }

    return false;
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
  data: RefreshTokenData,
  tenantId: string
): Promise<void> {
  return storeRefreshTokenCanonical(env, jti, data, tenantId);
}

/**
 * Legacy internal shim for refresh token lookup.
 */
async function getRefreshToken(
  env: Env,
  userId: string,
  version: number,
  clientId: string,
  jti: string,
  tenantId: string
): Promise<RefreshTokenData | null> {
  return getRefreshTokenCanonical(env, userId, version, clientId, jti, tenantId);
}

/**
 * Legacy internal shim for refresh token deletion.
 */
async function deleteRefreshToken(
  env: Env,
  jti: string,
  client_id: string,
  tenantId: string
): Promise<void> {
  return deleteRefreshTokenCanonical(env, jti, client_id, tenantId);
}

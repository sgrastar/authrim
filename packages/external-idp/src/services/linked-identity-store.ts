/**
 * Linked Identity Store
 * CRUD operations for linked external identities
 */

import type { Env } from '@authrim/shared';
import { D1Adapter, type DatabaseAdapter } from '@authrim/shared';
import type { LinkedIdentity, TokenResponse } from '../types';
import { encrypt, decrypt, getEncryptionKey } from '../utils/crypto';

/**
 * Get linked identity by ID
 */
export async function getLinkedIdentityById(env: Env, id: string): Promise<LinkedIdentity | null> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<DbLinkedIdentity>(
    `SELECT * FROM linked_identities WHERE id = ?`,
    [id]
  );

  if (!result) return null;
  return mapDbToLinkedIdentity(result);
}

/**
 * Find linked identity by provider and provider user ID
 */
export async function findLinkedIdentity(
  env: Env,
  providerId: string,
  providerUserId: string
): Promise<LinkedIdentity | null> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<DbLinkedIdentity>(
    `SELECT * FROM linked_identities WHERE provider_id = ? AND provider_user_id = ?`,
    [providerId, providerUserId]
  );

  if (!result) return null;
  return mapDbToLinkedIdentity(result);
}

/**
 * Find all linked identities by provider and provider user ID
 * Used for backchannel logout to find all linked identities across tenants
 */
export async function findLinkedIdentitiesByProviderSub(
  env: Env,
  providerId: string,
  providerUserId: string
): Promise<LinkedIdentity[]> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.query<DbLinkedIdentity>(
    `SELECT * FROM linked_identities WHERE provider_id = ? AND provider_user_id = ?`,
    [providerId, providerUserId]
  );

  return result.map(mapDbToLinkedIdentity);
}

/**
 * List linked identities for a user
 */
export async function listLinkedIdentities(env: Env, userId: string): Promise<LinkedIdentity[]> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.query<DbLinkedIdentity>(
    `SELECT * FROM linked_identities WHERE user_id = ? ORDER BY linked_at DESC`,
    [userId]
  );

  return result.map(mapDbToLinkedIdentity);
}

/**
 * Get linked identity for user and provider
 */
export async function getLinkedIdentityForUserAndProvider(
  env: Env,
  userId: string,
  providerId: string
): Promise<LinkedIdentity | null> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<DbLinkedIdentity>(
    `SELECT * FROM linked_identities WHERE user_id = ? AND provider_id = ?`,
    [userId, providerId]
  );

  if (!result) return null;
  return mapDbToLinkedIdentity(result);
}

/**
 * Create linked identity
 */
export async function createLinkedIdentity(
  env: Env,
  params: {
    userId: string;
    providerId: string;
    providerUserId: string;
    providerEmail?: string;
    emailVerified?: boolean;
    tokens: TokenResponse;
    rawClaims?: Record<string, unknown>;
    tenantId?: string;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const tokenExpiresAt = params.tokens.expires_in
    ? now + params.tokens.expires_in * 1000
    : undefined;

  // Encrypt tokens (required)
  const encryptionKey = getEncryptionKey(env);
  const accessTokenEncrypted = await encrypt(params.tokens.access_token, encryptionKey);
  const refreshTokenEncrypted = params.tokens.refresh_token
    ? await encrypt(params.tokens.refresh_token, encryptionKey)
    : null;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  await coreAdapter.execute(
    `INSERT INTO linked_identities (
      id, tenant_id, user_id, provider_id, provider_user_id,
      provider_email, email_verified,
      access_token_encrypted, refresh_token_encrypted, token_expires_at,
      raw_claims, profile_data,
      linked_at, last_login_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId || 'default',
      params.userId,
      params.providerId,
      params.providerUserId,
      params.providerEmail || null,
      params.emailVerified ? 1 : 0,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      tokenExpiresAt || null,
      JSON.stringify(params.rawClaims || {}),
      null, // profile_data - normalize later
      now,
      now,
      now,
    ]
  );

  return id;
}

/**
 * Update linked identity (tokens, last login, etc.)
 */
export async function updateLinkedIdentity(
  env: Env,
  id: string,
  updates: {
    tokens?: TokenResponse;
    lastLoginAt?: number;
    rawClaims?: Record<string, unknown>;
  }
): Promise<boolean> {
  const now = Date.now();
  const tokenExpiresAt = updates.tokens?.expires_in
    ? now + updates.tokens.expires_in * 1000
    : undefined;

  // Build dynamic update query
  const setClauses: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (updates.tokens) {
    // Encrypt tokens (required)
    const encryptionKey = getEncryptionKey(env);

    setClauses.push('access_token_encrypted = ?');
    const accessToken = await encrypt(updates.tokens.access_token, encryptionKey);
    params.push(accessToken);

    if (updates.tokens.refresh_token) {
      setClauses.push('refresh_token_encrypted = ?');
      const refreshToken = await encrypt(updates.tokens.refresh_token, encryptionKey);
      params.push(refreshToken);
    }
    if (tokenExpiresAt) {
      setClauses.push('token_expires_at = ?');
      params.push(tokenExpiresAt);
    }
  }

  if (updates.lastLoginAt) {
    setClauses.push('last_login_at = ?');
    params.push(updates.lastLoginAt);
  }

  if (updates.rawClaims) {
    setClauses.push('raw_claims = ?');
    params.push(JSON.stringify(updates.rawClaims));
  }

  params.push(id);

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.execute(
    `UPDATE linked_identities SET ${setClauses.join(', ')} WHERE id = ?`,
    params
  );

  return result.rowsAffected > 0;
}

/**
 * Delete linked identity
 */
export async function deleteLinkedIdentity(env: Env, id: string): Promise<boolean> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.execute(`DELETE FROM linked_identities WHERE id = ?`, [id]);
  return result.rowsAffected > 0;
}

/**
 * Count linked identities for user (for unlink validation)
 */
export async function countLinkedIdentities(env: Env, userId: string): Promise<number> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM linked_identities WHERE user_id = ?`,
    [userId]
  );

  return result?.count || 0;
}

/**
 * Decrypt tokens from a linked identity
 * Returns decrypted access_token and refresh_token if available
 * Requires RP_TOKEN_ENCRYPTION_KEY to be configured
 */
export async function decryptLinkedIdentityTokens(
  env: Env,
  linkedIdentity: LinkedIdentity
): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  const encryptionKey = getEncryptionKey(env);

  const accessToken = linkedIdentity.accessTokenEncrypted
    ? await decrypt(linkedIdentity.accessTokenEncrypted, encryptionKey)
    : null;

  const refreshToken = linkedIdentity.refreshTokenEncrypted
    ? await decrypt(linkedIdentity.refreshTokenEncrypted, encryptionKey)
    : null;

  return { accessToken, refreshToken };
}

// =============================================================================
// Internal Types and Mappers
// =============================================================================

interface DbLinkedIdentity {
  id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  provider_email: string | null;
  email_verified: number;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: number | null;
  raw_claims: string | null;
  profile_data: string | null;
  linked_at: number;
  last_login_at: number | null;
  updated_at: number;
}

function mapDbToLinkedIdentity(db: DbLinkedIdentity): LinkedIdentity {
  return {
    id: db.id,
    tenantId: db.tenant_id,
    userId: db.user_id,
    providerId: db.provider_id,
    providerUserId: db.provider_user_id,
    providerEmail: db.provider_email || undefined,
    emailVerified: db.email_verified === 1,
    accessTokenEncrypted: db.access_token_encrypted || undefined,
    refreshTokenEncrypted: db.refresh_token_encrypted || undefined,
    tokenExpiresAt: db.token_expires_at || undefined,
    rawClaims: db.raw_claims ? JSON.parse(db.raw_claims) : undefined,
    profileData: db.profile_data ? JSON.parse(db.profile_data) : undefined,
    linkedAt: db.linked_at,
    lastLoginAt: db.last_login_at || undefined,
    updatedAt: db.updated_at,
  };
}

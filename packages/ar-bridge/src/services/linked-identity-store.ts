/**
 * Linked Identity Store
 * CRUD operations for linked external identities
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  ensureDatabaseAdapter,
  type DatabaseAdapter,
  type DatabaseSource,
  resolveAccountDataContextByIdentifier,
} from '@authrim/ar-lib-core';
import type { LinkedIdentity, TokenResponse } from '../types';
import { encrypt, decrypt, getEncryptionKey } from '../utils/crypto';

async function getTenantLinkedIdentityAdapter(
  _env: Env,
  _tenantId: string,
  partition: string,
  piiSource: DatabaseSource
): Promise<DatabaseAdapter> {
  return ensureDatabaseAdapter(piiSource, partition);
}

/**
 * Get linked identity by ID
 */
export async function getLinkedIdentityById(
  env: Env,
  tenantId: string,
  id: string,
  piiSource: DatabaseSource
): Promise<LinkedIdentity | null> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:get-by-id',
    piiSource
  );
  const result = await adapter.queryOne<DbLinkedIdentity>(
    "SELECT * FROM linked_identities WHERE tenant_id = ? AND id = ? AND provisioning_state = 'active'",
    [tenantId, id]
  );

  if (!result) return null;
  return mapDbToLinkedIdentity(result);
}

/**
 * Find linked identity by provider and provider user ID
 */
export async function findLinkedIdentity(
  env: Env,
  tenantId: string,
  providerId: string,
  providerUserId: string,
  piiSource: DatabaseSource
): Promise<LinkedIdentity | null> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:find-by-provider-sub',
    piiSource
  );
  const result = await adapter.queryOne<DbLinkedIdentity>(
    `SELECT * FROM linked_identities
      WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?
        AND provisioning_state = 'active'`,
    [tenantId, providerId, providerUserId]
  );

  if (!result) return null;
  return mapDbToLinkedIdentity(result);
}

export interface PendingLinkedIdentityProvisioning {
  id: string;
  tenantId: string;
  userId: string;
  providerId: string;
  providerUserId: string;
  profileDataEncrypted: string;
}

export async function findPendingLinkedIdentityProvisioning(
  env: Env,
  tenantId: string,
  providerId: string,
  providerUserId: string,
  piiSource: DatabaseSource
): Promise<PendingLinkedIdentityProvisioning | null> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:find-pending-provisioning',
    piiSource
  );
  const row = await adapter.queryOne<{
    id: string;
    tenant_id: string;
    user_id: string;
    provider_id: string;
    provider_user_id: string;
    profile_data: string | null;
  }>(
    `SELECT id, tenant_id, user_id, provider_id, provider_user_id, profile_data
       FROM linked_identities
      WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?
        AND provisioning_state = 'pending'`,
    [tenantId, providerId, providerUserId],
    { consistencyClass: 'primary_required' }
  );
  if (!row?.profile_data) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    providerId: row.provider_id,
    providerUserId: row.provider_user_id,
    profileDataEncrypted: row.profile_data,
  };
}

export async function activatePendingLinkedIdentity(
  env: Env,
  input: PendingLinkedIdentityProvisioning,
  piiSource: DatabaseSource
): Promise<void> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    input.tenantId,
    'linked-identity:activate-pending-provisioning',
    piiSource
  );
  const result = await adapter.execute(
    `UPDATE linked_identities
        SET provisioning_state = 'active', profile_data = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND provider_id = ?
        AND provider_user_id = ? AND provisioning_state = 'pending'`,
    [Date.now(), input.id, input.tenantId, input.userId, input.providerId, input.providerUserId]
  );
  if (result.rowsAffected !== 1) {
    const active = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM linked_identities
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND provider_id = ?
          AND provider_user_id = ? AND provisioning_state = 'active'`,
      [input.id, input.tenantId, input.userId, input.providerId, input.providerUserId],
      { consistencyClass: 'primary_required' }
    );
    if (active?.id !== input.id) {
      throw new Error('external_idp_pending_identity_activation_conflict');
    }
  }
}

/**
 * Find linked identities within a tenant by provider and provider user ID.
 * Used for tenant-scoped backchannel logout.
 */
export async function findLinkedIdentitiesByProviderSub(
  env: Env,
  tenantId: string,
  providerId: string,
  providerUserId: string,
  piiSource: DatabaseSource
): Promise<LinkedIdentity[]> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:list-by-provider-sub',
    piiSource
  );
  const result = await adapter.query<DbLinkedIdentity>(
    `SELECT * FROM linked_identities
     WHERE tenant_id = ? AND provider_id = ? AND provider_user_id = ?
       AND provisioning_state = 'active'`,
    [tenantId, providerId, providerUserId]
  );

  return result.map(mapDbToLinkedIdentity);
}

/**
 * Find linked identities across tenants by provider and provider user ID.
 * Explicit helper for global maintenance flows only.
 * Caller must enumerate the candidate tenants so lookup stays tenant-aware.
 */
export async function findLinkedIdentitiesAcrossTenantsByProviderSub(
  env: Env,
  tenantIds: string[],
  providerId: string,
  providerUserId: string
): Promise<LinkedIdentity[]> {
  const results = await Promise.all(
    tenantIds.map(async (tenantId) => {
      try {
        const account = await resolveAccountDataContextByIdentifier(env, {
          tenantId,
          indexKind: 'external_subject',
          identifier: { issuer: providerId, subject: providerUserId },
        });
        return findLinkedIdentitiesByProviderSub(
          env,
          tenantId,
          providerId,
          providerUserId,
          account.piiDb
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'account_data_route_not_found') return [];
        throw error;
      }
    })
  );

  return results.flat();
}

/**
 * List linked identities for a user
 */
export async function listLinkedIdentities(
  env: Env,
  tenantId: string,
  userId: string,
  piiSource: DatabaseSource
): Promise<LinkedIdentity[]> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:list',
    piiSource
  );
  const result = await adapter.query<DbLinkedIdentity>(
    "SELECT * FROM linked_identities WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active' ORDER BY linked_at DESC",
    [tenantId, userId]
  );

  return result.map(mapDbToLinkedIdentity);
}

/**
 * Get linked identity for user and provider within a tenant.
 */
export async function getLinkedIdentityForUserAndProvider(
  env: Env,
  tenantId: string,
  userId: string,
  providerId: string,
  piiSource: DatabaseSource
): Promise<LinkedIdentity | null> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:get-for-user-provider',
    piiSource
  );
  const result = await adapter.queryOne<DbLinkedIdentity>(
    "SELECT * FROM linked_identities WHERE tenant_id = ? AND user_id = ? AND provider_id = ? AND provisioning_state = 'active'",
    [tenantId, userId, providerId]
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
    tenantId: string;
  },
  piiSource: DatabaseSource
): Promise<string> {
  const tenantId = params.tenantId;
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

  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:create',
    piiSource
  );
  await adapter.execute(
    `INSERT INTO linked_identities (
      id, tenant_id, user_id, provider_id, provider_user_id,
      provider_email, email_verified,
      access_token_encrypted, refresh_token_encrypted, token_expires_at,
      raw_claims, profile_data,
      linked_at, last_login_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
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
  tenantId: string,
  id: string,
  updates: {
    tokens?: TokenResponse;
    clearTokens?: boolean;
    lastLoginAt?: number;
    rawClaims?: Record<string, unknown>;
  },
  piiSource: DatabaseSource
): Promise<boolean> {
  const now = Date.now();
  const tokenExpiresAt = updates.tokens?.expires_in
    ? now + updates.tokens.expires_in * 1000
    : undefined;

  // Build dynamic update query
  const setClauses: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (updates.clearTokens) {
    setClauses.push('access_token_encrypted = NULL');
    setClauses.push('refresh_token_encrypted = NULL');
    setClauses.push('token_expires_at = NULL');
  } else if (updates.tokens) {
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

  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:update',
    piiSource
  );
  const result = await adapter.execute(
    `UPDATE linked_identities SET ${setClauses.join(', ')} WHERE tenant_id = ? AND id = ?`,
    [...params, tenantId, id]
  );

  return result.rowsAffected > 0;
}

/**
 * Delete linked identity
 */
export async function deleteLinkedIdentity(
  env: Env,
  tenantId: string,
  id: string,
  piiSource: DatabaseSource
): Promise<boolean> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:delete',
    piiSource
  );
  const result = await adapter.execute(
    'DELETE FROM linked_identities WHERE tenant_id = ? AND id = ?',
    [tenantId, id]
  );
  return result.rowsAffected > 0;
}

/**
 * Count linked identities for user (for unlink validation)
 */
export async function countLinkedIdentities(
  env: Env,
  tenantId: string,
  userId: string,
  piiSource: DatabaseSource
): Promise<number> {
  const adapter = await getTenantLinkedIdentityAdapter(
    env,
    tenantId,
    'linked-identity:count',
    piiSource
  );
  const result = await adapter.queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM linked_identities WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active'",
    [tenantId, userId]
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

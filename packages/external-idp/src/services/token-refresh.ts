/**
 * Token Refresh Service
 * Handles proactive refresh of expiring access tokens for linked identities
 *
 * This service runs as part of the scheduled handler to ensure
 * access tokens remain valid for background operations.
 */

import type { Env } from '@authrim/shared';
import type { LinkedIdentity } from '../types';
import { getProvider } from './provider-store';
import { updateLinkedIdentity, decryptLinkedIdentityTokens } from './linked-identity-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';

/**
 * Token refresh configuration
 * Configurable via KV: external_idp_token_refresh
 */
interface TokenRefreshConfig {
  /** Refresh tokens that expire within this many seconds (default: 5 minutes) */
  refreshThresholdSeconds: number;
  /** Maximum number of tokens to refresh per run (default: 100) */
  batchSize: number;
  /** Whether token refresh is enabled (default: true) */
  enabled: boolean;
}

const DEFAULT_TOKEN_REFRESH_CONFIG: TokenRefreshConfig = {
  refreshThresholdSeconds: 300, // 5 minutes
  batchSize: 100,
  enabled: true,
};

/**
 * Refresh tokens that are about to expire
 *
 * @returns Number of tokens successfully refreshed
 */
export async function refreshExpiringTokens(env: Env): Promise<number> {
  const config = await getTokenRefreshConfig(env);

  if (!config.enabled) {
    return 0;
  }

  const encryptionKey = getEncryptionKeyOrUndefined(env);
  if (!encryptionKey) {
    console.warn('Token refresh skipped: RP_TOKEN_ENCRYPTION_KEY not configured');
    return 0;
  }

  const now = Date.now();
  const threshold = now + config.refreshThresholdSeconds * 1000;

  // Find linked identities with tokens expiring soon
  const expiringIdentities = await findExpiringTokens(env, threshold, config.batchSize);

  if (expiringIdentities.length === 0) {
    return 0;
  }

  let refreshedCount = 0;

  for (const identity of expiringIdentities) {
    try {
      const success = await refreshIdentityToken(env, identity, encryptionKey);
      if (success) {
        refreshedCount++;
      }
    } catch (error) {
      console.error(`Failed to refresh token for identity ${identity.id}:`, error);
      // Continue with other tokens
    }
  }

  return refreshedCount;
}

/**
 * Find linked identities with tokens expiring before threshold
 */
async function findExpiringTokens(
  env: Env,
  threshold: number,
  limit: number
): Promise<LinkedIdentity[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM linked_identities
     WHERE token_expires_at IS NOT NULL
       AND token_expires_at < ?
       AND token_expires_at > ?
       AND refresh_token_encrypted IS NOT NULL
     ORDER BY token_expires_at ASC
     LIMIT ?`
  )
    .bind(threshold, Date.now(), limit)
    .all<DbLinkedIdentity>();

  return (result.results || []).map(mapDbToLinkedIdentity);
}

/**
 * Refresh token for a single linked identity
 */
async function refreshIdentityToken(
  env: Env,
  identity: LinkedIdentity,
  encryptionKey: string
): Promise<boolean> {
  // Get provider configuration
  const provider = await getProvider(env, identity.providerId);
  if (!provider) {
    console.warn(`Provider ${identity.providerId} not found for identity ${identity.id}`);
    return false;
  }

  // Decrypt refresh token
  const { refreshToken } = await decryptLinkedIdentityTokens(env, identity);
  if (!refreshToken) {
    console.warn(`No refresh token for identity ${identity.id}`);
    return false;
  }

  // Decrypt client secret
  const clientSecret = await decrypt(provider.clientSecretEncrypted, encryptionKey);

  // Create OIDC client
  // Note: We don't need a callback URI for token refresh
  const client = OIDCRPClient.fromProvider(provider, '', clientSecret);

  // Refresh the token
  const tokens = await client.refreshTokens(refreshToken);

  // Update the linked identity with new tokens
  await updateLinkedIdentity(env, identity.id, {
    tokens,
  });

  console.log(`Successfully refreshed token for identity ${identity.id}`);
  return true;
}

/**
 * Get token refresh configuration from KV or use defaults
 */
async function getTokenRefreshConfig(env: Env): Promise<TokenRefreshConfig> {
  try {
    const stored = await env.SETTINGS?.get('external_idp_token_refresh');
    if (stored) {
      return { ...DEFAULT_TOKEN_REFRESH_CONFIG, ...JSON.parse(stored) };
    }
  } catch {
    // Use defaults if KV fails
  }
  return DEFAULT_TOKEN_REFRESH_CONFIG;
}

// =============================================================================
// Database Types (duplicated from linked-identity-store to avoid circular deps)
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

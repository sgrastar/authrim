/**
 * Auth State Management
 * Handles storage and retrieval of OAuth state for CSRF protection
 *
 * SECURITY:
 * - State is single-use (marked as consumed atomically)
 * - State expires after 10 minutes
 * - Uses cryptographically random state values
 */

import type { Env } from '@authrim/shared';
import type { ExternalIdpAuthState } from '../types';

const STATE_TTL_SECONDS = 600; // 10 minutes

/**
 * Store auth state in D1
 */
export async function storeAuthState(
  env: Env,
  state: Omit<ExternalIdpAuthState, 'id' | 'createdAt'>
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO external_idp_auth_states (
      id, tenant_id, provider_id, state, nonce, code_verifier,
      redirect_uri, user_id, session_id, original_auth_request,
      max_age, acr_values, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      state.tenantId || 'default',
      state.providerId,
      state.state,
      state.nonce || null,
      state.codeVerifier || null,
      state.redirectUri,
      state.userId || null,
      state.sessionId || null,
      state.originalAuthRequest || null,
      state.maxAge ?? null,
      state.acrValues || null,
      state.expiresAt,
      now
    )
    .run();

  return id;
}

/**
 * Database row type for auth state
 */
interface DbAuthState {
  id: string;
  tenant_id: string;
  provider_id: string;
  state: string;
  nonce: string | null;
  code_verifier: string | null;
  redirect_uri: string;
  user_id: string | null;
  session_id: string | null;
  original_auth_request: string | null;
  max_age: number | null;
  acr_values: string | null;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
}

/**
 * Consume auth state atomically (single-use pattern)
 *
 * SECURITY: This implementation uses a two-phase approach to ensure atomicity:
 * 1. UPDATE sets consumed_at only if state is valid and not already consumed
 * 2. SELECT retrieves the state only if it was just consumed by this request
 *
 * This prevents race conditions where the same state could be used twice.
 *
 * @returns The auth state if valid and not already consumed, null otherwise
 */
export async function consumeAuthState(
  env: Env,
  state: string
): Promise<ExternalIdpAuthState | null> {
  const now = Date.now();

  // Phase 1: Atomically mark as consumed using UPDATE with conditions
  // This only succeeds if state exists, not expired, and not already consumed
  const updateResult = await env.DB.prepare(
    `UPDATE external_idp_auth_states
     SET consumed_at = ?
     WHERE state = ?
       AND expires_at > ?
       AND consumed_at IS NULL`
  )
    .bind(now, state, now)
    .run();

  // If no rows were updated, state is invalid, expired, or already consumed
  if (!updateResult.meta.changes || updateResult.meta.changes === 0) {
    return null;
  }

  // Phase 2: Retrieve the state we just consumed
  // This is safe because we only reach here if we successfully marked it as consumed
  const result = await env.DB.prepare(
    `SELECT * FROM external_idp_auth_states WHERE state = ? AND consumed_at = ?`
  )
    .bind(state, now)
    .first<DbAuthState>();

  if (!result) {
    // This should not happen if Phase 1 succeeded, but handle defensively
    console.error('State consumption anomaly: UPDATE succeeded but SELECT failed');
    return null;
  }

  return mapDbToAuthState(result);
}

/**
 * Map database row to ExternalIdpAuthState
 */
function mapDbToAuthState(db: DbAuthState): ExternalIdpAuthState {
  return {
    id: db.id,
    tenantId: db.tenant_id,
    providerId: db.provider_id,
    state: db.state,
    nonce: db.nonce || undefined,
    codeVerifier: db.code_verifier || undefined,
    redirectUri: db.redirect_uri,
    userId: db.user_id || undefined,
    sessionId: db.session_id || undefined,
    originalAuthRequest: db.original_auth_request || undefined,
    maxAge: db.max_age ?? undefined,
    acrValues: db.acr_values || undefined,
    expiresAt: db.expires_at,
    createdAt: db.created_at,
  };
}

/**
 * Clean up expired and consumed states (call periodically)
 *
 * Deletes states that are:
 * - Expired (older than STATE_TTL_SECONDS)
 * - Consumed (already used, keep for 1 hour for debugging then delete)
 *
 * @returns Number of deleted states
 */
export async function cleanupExpiredStates(env: Env): Promise<number> {
  const now = Date.now();
  const consumedRetentionMs = 3600000; // 1 hour

  // Delete expired states and old consumed states
  const result = await env.DB.prepare(
    `DELETE FROM external_idp_auth_states
     WHERE expires_at < ?
        OR (consumed_at IS NOT NULL AND consumed_at < ?)`
  )
    .bind(now, now - consumedRetentionMs)
    .run();

  return result.meta.changes || 0;
}

/**
 * Get default state expiration time
 */
export function getStateExpiresAt(): number {
  return Date.now() + STATE_TTL_SECONDS * 1000;
}

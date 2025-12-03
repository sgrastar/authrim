/**
 * Auth State Management
 * Handles storage and retrieval of OAuth state for CSRF protection
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
      expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      state.expiresAt,
      now
    )
    .run();

  return id;
}

/**
 * Consume auth state (retrieve and delete atomically)
 * Returns null if state not found or expired
 */
export async function consumeAuthState(
  env: Env,
  state: string
): Promise<ExternalIdpAuthState | null> {
  const now = Date.now();

  // Retrieve state
  const result = await env.DB.prepare(
    `SELECT * FROM external_idp_auth_states WHERE state = ? AND expires_at > ?`
  )
    .bind(state, now)
    .first<{
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
      expires_at: number;
      created_at: number;
    }>();

  if (!result) {
    return null;
  }

  // Delete state (single-use)
  await env.DB.prepare(`DELETE FROM external_idp_auth_states WHERE id = ?`).bind(result.id).run();

  return {
    id: result.id,
    tenantId: result.tenant_id,
    providerId: result.provider_id,
    state: result.state,
    nonce: result.nonce || undefined,
    codeVerifier: result.code_verifier || undefined,
    redirectUri: result.redirect_uri,
    userId: result.user_id || undefined,
    sessionId: result.session_id || undefined,
    originalAuthRequest: result.original_auth_request || undefined,
    expiresAt: result.expires_at,
    createdAt: result.created_at,
  };
}

/**
 * Clean up expired states (call periodically)
 */
export async function cleanupExpiredStates(env: Env): Promise<number> {
  const now = Date.now();
  const result = await env.DB.prepare(`DELETE FROM external_idp_auth_states WHERE expires_at < ?`)
    .bind(now)
    .run();
  return result.meta.changes || 0;
}

/**
 * Get default state expiration time
 */
export function getStateExpiresAt(): number {
  return Date.now() + STATE_TTL_SECONDS * 1000;
}

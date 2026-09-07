/**
 * Auth State Management
 * Handles storage and retrieval of OAuth state for CSRF protection
 *
 * SECURITY:
 * - State is single-use (marked as consumed atomically)
 * - State expires after 10 minutes
 * - Uses cryptographically random state values
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  createLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';
import type { ExternalIdpAuthState } from '../types';

const log = createLogger().module('EXTERNAL-IDP');

const STATE_TTL_SECONDS = 600; // 10 minutes

export async function getAuthStateCookieName(state: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
  const suffix = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `authrim_external_state_${suffix}`;
}

export function matchesAuthStateCookie(state: string, cookieValue: string | undefined): boolean {
  if (!cookieValue || cookieValue.length !== state.length) return false;
  let difference = 0;
  for (let index = 0; index < state.length; index++) {
    difference |= state.charCodeAt(index) ^ cookieValue.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Store auth state in D1
 */
export async function storeAuthState(
  env: Env,
  state: Omit<ExternalIdpAuthState, 'id' | 'createdAt'>
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'bridge-auth-state:store',
    { tenantId: state.tenantId }
  );
  await coreAdapter.execute(
    `INSERT INTO external_idp_auth_states (
      id, tenant_id, client_id, provider_id, state, nonce, code_verifier, code_challenge, flow_id,
      redirect_uri, user_id, session_id, original_auth_request,
      max_age, acr_values, prompt, enable_sso, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      state.tenantId,
      state.clientId || null,
      state.providerId,
      state.state,
      state.nonce || null,
      state.codeVerifier || null,
      state.codeChallenge || null,
      state.flowId || null,
      state.redirectUri,
      state.userId || null,
      state.sessionId || null,
      state.originalAuthRequest || null,
      state.maxAge ?? null,
      state.acrValues || null,
      state.prompt || null,
      state.enableSso !== false ? 1 : 0,
      state.expiresAt,
      now,
    ]
  );

  return id;
}

/** Attach a request object to an existing, unconsumed authorization state. */
export async function setAuthStateRequestObject(
  env: Env,
  tenantId: string,
  providerId: string,
  state: string,
  requestObject: string
): Promise<void> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'bridge-auth-state:set-request-object',
    { tenantId }
  );
  const result = await adapter.execute(
    `UPDATE external_idp_auth_states
     SET original_auth_request = ?
     WHERE tenant_id = ? AND provider_id = ? AND state = ?
       AND expires_at > ? AND consumed_at IS NULL`,
    [requestObject, tenantId, providerId, state, Date.now()]
  );
  if (result.rowsAffected !== 1) {
    throw new Error('Unable to bind request object to authorization state');
  }
}

/** Read the request object without consuming the callback state. */
export async function getAuthStateRequestObject(
  env: Env,
  tenantId: string,
  providerId: string,
  state: string
): Promise<string | null> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'bridge-auth-state:get-request-object',
    { tenantId }
  );
  const row = await adapter.queryOne<{ original_auth_request: string | null }>(
    `SELECT original_auth_request FROM external_idp_auth_states
     WHERE tenant_id = ? AND provider_id = ? AND state = ?
       AND expires_at > ? AND consumed_at IS NULL`,
    [tenantId, providerId, state, Date.now()]
  );
  return row?.original_auth_request ?? null;
}

/**
 * Database row type for auth state
 */
interface DbAuthState {
  id: string;
  tenant_id: string;
  client_id: string | null;
  provider_id: string;
  state: string;
  nonce: string | null;
  code_verifier: string | null;
  code_challenge: string | null;
  flow_id: string | null;
  redirect_uri: string;
  user_id: string | null;
  session_id: string | null;
  original_auth_request: string | null;
  max_age: number | null;
  acr_values: string | null;
  prompt: string | null;
  enable_sso: number | null;
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
  tenantId: string,
  state: string
): Promise<ExternalIdpAuthState | null> {
  const now = Date.now();

  const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'bridge-auth-state:consume',
    { tenantId }
  );

  // Phase 1: Atomically mark as consumed using UPDATE with conditions
  // This only succeeds if state exists, not expired, and not already consumed
  const updateResult = await coreAdapter.execute(
    `UPDATE external_idp_auth_states
     SET consumed_at = ?
     WHERE tenant_id = ?
       AND state = ?
       AND expires_at > ?
       AND consumed_at IS NULL`,
    [now, tenantId, state, now]
  );

  // If no rows were updated, state is invalid, expired, or already consumed
  if (updateResult.rowsAffected === 0) {
    return null;
  }

  // Phase 2: Retrieve the state we just consumed
  // This is safe because we only reach here if we successfully marked it as consumed
  const result = await coreAdapter.queryOne<DbAuthState>(
    'SELECT * FROM external_idp_auth_states WHERE tenant_id = ? AND state = ? AND consumed_at = ?',
    [tenantId, state, now]
  );

  if (!result) {
    // This should not happen if Phase 1 succeeded, but handle defensively
    log.error('State consumption anomaly: UPDATE succeeded but SELECT failed');
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
    clientId: db.client_id || undefined,
    providerId: db.provider_id,
    state: db.state,
    nonce: db.nonce || undefined,
    codeVerifier: db.code_verifier || undefined,
    codeChallenge: db.code_challenge || undefined,
    flowId: db.flow_id || undefined,
    redirectUri: db.redirect_uri,
    userId: db.user_id || undefined,
    sessionId: db.session_id || undefined,
    originalAuthRequest: db.original_auth_request || undefined,
    maxAge: db.max_age ?? undefined,
    acrValues: db.acr_values || undefined,
    prompt: db.prompt || undefined,
    enableSso: db.enable_sso === 1,
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

  const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'bridge-auth-state:cleanup'
  );
  // Delete expired states and old consumed states
  const result = await coreAdapter.execute(
    `DELETE FROM external_idp_auth_states
     WHERE expires_at < ?
        OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
    [now, now - consumedRetentionMs]
  );

  return result.rowsAffected;
}

/**
 * Get default state expiration time
 */
export function getStateExpiresAt(): number {
  return Date.now() + STATE_TTL_SECONDS * 1000;
}

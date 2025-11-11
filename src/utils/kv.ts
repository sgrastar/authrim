/**
 * KV Storage Utilities
 *
 * Provides helper functions for storing and retrieving data from Cloudflare KV namespaces.
 * Used for managing authorization codes, state parameters, and nonce values.
 */

import type { Env } from '../types/env';

/**
 * Data structure for authorization code metadata
 */
export interface AuthCodeData {
  client_id: string;
  redirect_uri: string;
  scope: string;
  sub: string; // Subject (user identifier) - required for token issuance
  nonce?: string;
  timestamp: number;
  code_challenge?: string;
  code_challenge_method?: string;
  jti?: string; // JWT ID of the access token (for revocation on code reuse)
  used?: boolean; // Whether the authorization code has been used (for detecting reuse attacks)
  claims?: string; // Requested claims (JSON string, per OIDC Core 5.5)
}

/**
 * Store authorization code in KV with associated metadata
 *
 * @param env - Cloudflare environment bindings
 * @param code - Authorization code (UUID)
 * @param data - Authorization code metadata
 * @returns Promise<void>
 */
export async function storeAuthCode(env: Env, code: string, data: AuthCodeData): Promise<void> {
  const ttl = parseInt(env.CODE_EXPIRY, 10);
  const expirationTtl = ttl; // TTL in seconds

  await env.AUTH_CODES.put(code, JSON.stringify(data), {
    expirationTtl,
  });
}

/**
 * Retrieve authorization code metadata from KV
 *
 * @param env - Cloudflare environment bindings
 * @param code - Authorization code to retrieve
 * @returns Promise<AuthCodeData | null>
 */
export async function getAuthCode(env: Env, code: string): Promise<AuthCodeData | null> {
  const data = await env.AUTH_CODES.get(code);

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as AuthCodeData;
  } catch (error) {
    console.error('Failed to parse auth code data:', error);
    return null;
  }
}

/**
 * Delete authorization code from KV (single-use enforcement)
 *
 * @param env - Cloudflare environment bindings
 * @param code - Authorization code to delete
 * @returns Promise<void>
 */
export async function deleteAuthCode(env: Env, code: string): Promise<void> {
  await env.AUTH_CODES.delete(code);
}

/**
 * Mark authorization code as used and store associated token JTI
 * This allows detection of authorization code reuse attacks (RFC 6749 Section 4.1.2)
 *
 * @param env - Cloudflare environment bindings
 * @param code - Authorization code
 * @param data - Updated authorization code data with jti and used flag
 * @returns Promise<void>
 */
export async function markAuthCodeAsUsed(
  env: Env,
  code: string,
  data: AuthCodeData
): Promise<void> {
  const ttl = parseInt(env.CODE_EXPIRY, 10);
  const expirationTtl = ttl;

  await env.AUTH_CODES.put(
    code,
    JSON.stringify({
      ...data,
      used: true,
    }),
    {
      expirationTtl,
    }
  );
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
  const ttl = parseInt(env.STATE_EXPIRY, 10);

  await env.STATE_STORE.put(state, clientId, {
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
  return await env.STATE_STORE.get(state);
}

/**
 * Delete state parameter from KV after validation
 *
 * @param env - Cloudflare environment bindings
 * @param state - State parameter to delete
 * @returns Promise<void>
 */
export async function deleteState(env: Env, state: string): Promise<void> {
  await env.STATE_STORE.delete(state);
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
  const ttl = parseInt(env.NONCE_EXPIRY, 10);

  await env.NONCE_STORE.put(nonce, clientId, {
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
  return await env.NONCE_STORE.get(nonce);
}

/**
 * Delete nonce parameter from KV after validation
 *
 * @param env - Cloudflare environment bindings
 * @param nonce - Nonce parameter to delete
 * @returns Promise<void>
 */
export async function deleteNonce(env: Env, nonce: string): Promise<void> {
  await env.NONCE_STORE.delete(nonce);
}

/**
 * Store client metadata in KV (for Dynamic Client Registration)
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID
 * @param clientData - Client metadata
 * @returns Promise<void>
 */
export async function storeClient(
  env: Env,
  clientId: string,
  clientData: Record<string, unknown>
): Promise<void> {
  await env.CLIENTS.put(clientId, JSON.stringify(clientData));
}

/**
 * Retrieve client metadata from KV
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to retrieve
 * @returns Promise<Record<string, unknown> | null>
 */
export async function getClient(
  env: Env,
  clientId: string
): Promise<Record<string, unknown> | null> {
  const data = await env.CLIENTS.get(clientId);

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch (error) {
    console.error('Failed to parse client data:', error);
    return null;
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
 * @returns Promise<void>
 */
export async function revokeToken(env: Env, jti: string, expiresIn: number): Promise<void> {
  // Store revoked token JTI with same TTL as token expiration
  // After token expires naturally, no need to keep it in revocation list
  await env.REVOKED_TOKENS.put(jti, 'revoked', {
    expirationTtl: expiresIn,
  });
}

/**
 * Check if an access token has been revoked
 *
 * @param env - Cloudflare environment bindings
 * @param jti - JWT ID of the token to check
 * @returns Promise<boolean> - True if token is revoked
 */
export async function isTokenRevoked(env: Env, jti: string): Promise<boolean> {
  const result = await env.REVOKED_TOKENS.get(jti);
  return result !== null;
}

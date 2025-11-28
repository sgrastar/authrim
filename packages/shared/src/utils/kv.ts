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
  const ttl = parseInt(env.NONCE_EXPIRY, 10);
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
      console.error('Failed to parse cached client data:', error);
      await env.CLIENTS_CACHE.delete(cacheKey).catch((e) =>
        console.warn('Failed to delete corrupted cache:', e)
      );
    }
  }

  // Step 2: Cache miss - fetch from D1 (source of truth)
  const result = await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
    .bind(clientId)
    .first<{
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
      allow_claims_without_scope: number | null;
      created_at: number;
      updated_at: number;
    }>();

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
    allow_claims_without_scope: result.allow_claims_without_scope === 1,
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
    console.warn(`Failed to cache client data for ${clientId}:`, error);
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

  // Use a tenant-scoped Durable Object instance for token revocations
  const id = env.TOKEN_REVOCATION_STORE.idFromName(buildDOInstanceName('token-revocation'));
  const stub = env.TOKEN_REVOCATION_STORE.get(id);

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

  const id = env.TOKEN_REVOCATION_STORE.idFromName(buildDOInstanceName('token-revocation'));
  const stub = env.TOKEN_REVOCATION_STORE.get(id);

  try {
    const response = await stub.fetch(`http://internal/check?jti=${encodeURIComponent(jti)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json<{ revoked: boolean }>();
    return data.revoked;
  } catch (error) {
    console.error('Failed to check token revocation:', error);
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

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(data.client_id);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  const response = await stub.fetch('http://internal/family', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: jti,
      userId: data.sub,
      clientId: data.client_id,
      scope: data.scope || '',
      ttl: parseInt(env.REFRESH_TOKEN_EXPIRY, 10),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to store refresh token: ${error}`);
  }
}

/**
 * Retrieve refresh token metadata using RefreshTokenRotator DO
 * Note: This validates the token and returns metadata if valid
 *
 * @param env - Cloudflare environment bindings
 * @param jti - Refresh token JTI (the actual token value)
 * @param client_id - Client ID (required to locate the correct DO instance)
 * @returns Promise<RefreshTokenData | null>
 */
export async function getRefreshToken(
  env: Env,
  jti: string,
  client_id: string
): Promise<RefreshTokenData | null> {
  if (!env.REFRESH_TOKEN_ROTATOR) {
    throw new Error('REFRESH_TOKEN_ROTATOR Durable Object not available');
  }

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(client_id);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  try {
    const response = await stub.fetch(`http://internal/validate?token=${encodeURIComponent(jti)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      valid: boolean;
      familyId?: string;
      userId?: string;
      clientId?: string;
      scope?: string;
      createdAt?: number;
      expiresAt?: number;
    };
    if (!data || !data.valid) {
      return null;
    }

    // Convert DO response to RefreshTokenData format
    return {
      jti,
      client_id: data.clientId!,
      sub: data.userId!,
      scope: data.scope!,
      iat: Math.floor(data.createdAt! / 1000),
      exp: Math.floor(data.expiresAt! / 1000),
    };
  } catch (error) {
    console.error('Failed to get refresh token:', error);
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

  const id = env.REFRESH_TOKEN_ROTATOR.idFromName(client_id);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(id);

  // First get the family ID for this token
  const validateResponse = await stub.fetch(
    `http://internal/validate?token=${encodeURIComponent(jti)}`,
    {
      method: 'GET',
    }
  );

  if (!validateResponse.ok) {
    // Token doesn't exist or already revoked, that's OK
    return;
  }

  const data = (await validateResponse.json()) as {
    valid?: boolean;
    familyId?: string;
  };
  const familyId = data.familyId;

  if (!familyId) {
    // No family found, nothing to revoke
    return;
  }

  // Revoke the entire family
  const response = await stub.fetch('http://internal/revoke-family', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      familyId,
      reason: 'Token revocation requested',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete refresh token: ${error}`);
  }
}

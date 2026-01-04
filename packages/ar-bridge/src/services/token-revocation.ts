/**
 * Token Revocation Service
 * Implements RFC 7009 OAuth 2.0 Token Revocation
 *
 * When a user unlinks an external identity, we attempt to revoke
 * the access token and refresh token at the provider to prevent
 * unauthorized access.
 */

import type { Env } from '@authrim/ar-lib-core';
import { createLogger } from '@authrim/ar-lib-core';
import type { LinkedIdentity, ProviderMetadata, UpstreamProvider } from '../types';

const log = createLogger().module('TOKEN-REVOCATION');
import { getProvider } from './provider-store';
import { decryptLinkedIdentityTokens } from './linked-identity-store';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';

/**
 * Token revocation result
 */
export interface TokenRevocationResult {
  success: boolean;
  accessTokenRevoked: boolean;
  refreshTokenRevoked: boolean;
  errors: string[];
}

/**
 * Revoke tokens for a linked identity at the provider
 *
 * This is a best-effort operation - we attempt to revoke both access and refresh tokens,
 * but failures don't prevent the local unlink from succeeding.
 *
 * @param env - Environment bindings
 * @param identity - The linked identity being unlinked
 * @returns Revocation result with details
 */
export async function revokeLinkedIdentityTokens(
  env: Env,
  identity: LinkedIdentity
): Promise<TokenRevocationResult> {
  const result: TokenRevocationResult = {
    success: false,
    accessTokenRevoked: false,
    refreshTokenRevoked: false,
    errors: [],
  };

  try {
    // Get provider configuration
    const provider = await getProvider(env, identity.providerId);
    if (!provider) {
      // SECURITY: Do not expose provider ID in error to prevent enumeration
      result.errors.push('Provider not found');
      return result;
    }

    // Get revocation endpoint
    const revocationEndpoint = await getRevocationEndpoint(provider);
    if (!revocationEndpoint) {
      // Provider doesn't support token revocation - this is not an error
      log.warn('Provider does not support token revocation', { provider: provider.name });
      result.success = true; // Consider it a success since we can't do anything
      return result;
    }

    // Decrypt tokens
    const { accessToken, refreshToken } = await decryptLinkedIdentityTokens(env, identity);

    // Decrypt client secret for authentication
    const encryptionKey = getEncryptionKeyOrUndefined(env);
    if (!encryptionKey) {
      result.errors.push('Encryption key not configured');
      return result;
    }
    const clientSecret = await decrypt(provider.clientSecretEncrypted, encryptionKey);

    // Revoke access token (if present)
    if (accessToken) {
      const accessResult = await revokeToken(
        revocationEndpoint,
        accessToken,
        'access_token',
        provider.clientId,
        clientSecret
      );
      result.accessTokenRevoked = accessResult.success;
      if (!accessResult.success && accessResult.error) {
        result.errors.push(`Access token: ${accessResult.error}`);
      }
    }

    // Revoke refresh token (if present) - more important than access token
    if (refreshToken) {
      const refreshResult = await revokeToken(
        revocationEndpoint,
        refreshToken,
        'refresh_token',
        provider.clientId,
        clientSecret
      );
      result.refreshTokenRevoked = refreshResult.success;
      if (!refreshResult.success && refreshResult.error) {
        result.errors.push(`Refresh token: ${refreshResult.error}`);
      }
    }

    // Overall success if at least one token was revoked or no tokens to revoke
    result.success =
      result.accessTokenRevoked || result.refreshTokenRevoked || (!accessToken && !refreshToken);

    if (result.success) {
      // PII Protection: Don't log identity.id (can be used for user tracking)
      log.info('Token revocation completed', {
        accessTokenRevoked: result.accessTokenRevoked,
        refreshTokenRevoked: result.refreshTokenRevoked,
      });
    }

    return result;
  } catch (error) {
    // PII Protection: Don't log full error object
    log.error('Token revocation error', {
      errorName: error instanceof Error ? error.name : 'Unknown error',
    });
    // SECURITY: Do not expose internal error details
    result.errors.push('Token revocation failed');
    return result;
  }
}

/**
 * Get revocation endpoint from provider configuration or discovery
 */
async function getRevocationEndpoint(provider: UpstreamProvider): Promise<string | null> {
  // Check provider quirks for custom revocation endpoint
  const quirks = provider.providerQuirks as { revocationEndpoint?: string } | undefined;
  if (quirks?.revocationEndpoint) {
    return quirks.revocationEndpoint;
  }

  // Try OIDC discovery
  if (provider.issuer) {
    try {
      const discoveryUrl = `${provider.issuer}/.well-known/openid-configuration`;
      const response = await fetch(discoveryUrl);
      if (response.ok) {
        const metadata: ProviderMetadata = await response.json();
        if (metadata.revocation_endpoint) {
          return metadata.revocation_endpoint;
        }
      }
    } catch {
      // Discovery failed - provider might not support it
    }
  }

  // Known provider revocation endpoints (fallback)
  const knownEndpoints: Record<string, string> = {
    'https://accounts.google.com': 'https://oauth2.googleapis.com/revoke',
    'https://login.microsoftonline.com': '', // Microsoft doesn't have a standard revocation endpoint
  };

  for (const [issuer, endpoint] of Object.entries(knownEndpoints)) {
    if (provider.issuer?.includes(issuer) && endpoint) {
      return endpoint;
    }
  }

  return null;
}

/**
 * Revoke a single token using RFC 7009
 */
async function revokeToken(
  revocationEndpoint: string,
  token: string,
  tokenTypeHint: 'access_token' | 'refresh_token',
  clientId: string,
  clientSecret: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const body = new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch(revocationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    // RFC 7009 specifies:
    // - 200 OK for successful revocation
    // - The server should return 200 even if the token is invalid or already revoked
    if (response.ok) {
      return { success: true };
    }

    // Handle error response - read body for parsing but don't log it (may contain sensitive data)
    const errorBody = await response.text();
    // Security: Only log HTTP status code (safe), not response body
    log.warn('Token revocation failed', { status: response.status });

    // Parse OAuth error if present (safe fields only)
    try {
      const errorJson = JSON.parse(errorBody) as { error?: string; error_description?: string };
      // Only use standard OAuth error codes, not arbitrary error_description
      // as it may contain sensitive information
      const safeError = errorJson.error || `HTTP ${response.status}`;
      return {
        success: false,
        error: safeError,
      };
    } catch {
      return { success: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    log.error('Token revocation request error', {}, error as Error);
    return {
      success: false,
      // SECURITY: Do not expose network error details (may contain URLs)
      error: 'Request failed',
    };
  }
}

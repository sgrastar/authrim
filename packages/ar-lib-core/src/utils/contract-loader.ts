/**
 * Contract Loader Utilities
 *
 * Shared utilities for loading TenantContract and ClientContract from KV.
 * Used across multiple packages (ar-discovery, ar-token, ar-auth, ar-management).
 *
 * Key format: {env}:contract:{type}:{tenantId}:{clientId?}
 *
 * @see §16 in architecture-decisions.md for Human Auth / AI Ephemeral Auth design
 */

import type { Env } from '../types/env';
import type { TenantContract, ClientContract } from '../types/contracts';
import {
  getTenantProfile,
  isValidProfileType,
  type TenantProfile,
} from '../types/contracts/tenant-profile';

// =============================================================================
// Key Building
// =============================================================================

/**
 * Build scoped KV key with environment prefix and tenant isolation
 * Format: {env}:contract:{type}:{tenantId}:{id}
 */
export function buildContractKey(
  env: Env,
  type: 'tenant' | 'client',
  tenantId: string,
  id?: string
): string {
  const envPrefix = env.ENVIRONMENT || 'dev';
  const baseKey = `${envPrefix}:contract:${type}:${tenantId}`;
  return id ? `${baseKey}:${id}` : baseKey;
}

// =============================================================================
// Contract Loading
// =============================================================================

/**
 * Load TenantContract from KV
 *
 * Uses AUTHRIM_CONFIG KV namespace to retrieve tenant-specific configuration.
 * Returns null if contract doesn't exist or KV is unavailable.
 *
 * @param kv - AUTHRIM_CONFIG KV namespace
 * @param env - Environment bindings (for key prefix)
 * @param tenantId - Tenant identifier
 * @returns TenantContract or null
 */
export async function loadTenantContract(
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string
): Promise<TenantContract | null> {
  if (!kv) {
    return null;
  }

  try {
    const key = buildContractKey(env, 'tenant', tenantId);
    const data = await kv.get(key, 'json');
    return data as TenantContract | null;
  } catch {
    return null;
  }
}

/**
 * Load ClientContract from KV
 *
 * Uses AUTHRIM_CONFIG KV namespace to retrieve client-specific configuration.
 * Returns null if contract doesn't exist or KV is unavailable.
 *
 * @param kv - AUTHRIM_CONFIG KV namespace
 * @param env - Environment bindings (for key prefix)
 * @param tenantId - Tenant identifier
 * @param clientId - Client identifier
 * @returns ClientContract or null
 */
export async function loadClientContract(
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string,
  clientId: string
): Promise<ClientContract | null> {
  if (!kv) {
    return null;
  }

  try {
    const key = buildContractKey(env, 'client', tenantId, clientId);
    const data = await kv.get(key, 'json');
    return data as ClientContract | null;
  } catch {
    return null;
  }
}

// =============================================================================
// Profile Resolution
// =============================================================================

/**
 * Load TenantProfile from TenantContract
 *
 * Convenience function that loads the TenantContract and resolves
 * the TenantProfile. Falls back to DEFAULT_HUMAN_PROFILE if contract
 * doesn't exist or profile is not specified.
 *
 * @param kv - AUTHRIM_CONFIG KV namespace
 * @param env - Environment bindings
 * @param tenantId - Tenant identifier
 * @returns TenantProfile (never null, defaults to human profile)
 */
export async function loadTenantProfile(
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string
): Promise<TenantProfile> {
  const contract = await loadTenantContract(kv, env, tenantId);
  return getTenantProfile(contract?.profile);
}

/**
 * The tenant's profile for an admin view: like loadTenantProfile, but a contract that cannot be
 * read or parsed throws instead of reading as the default (human) profile. No contract: default.
 */
export async function loadTenantProfileStrict(
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string
): Promise<TenantProfile> {
  if (!kv) return getTenantProfile(undefined);
  const raw = await kv.get(buildContractKey(env, 'tenant', tenantId));
  if (raw === null) return getTenantProfile(undefined);
  const contract: unknown = JSON.parse(raw);
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('tenant_contract_invalid');
  }
  const profile = (contract as { profile?: unknown }).profile;
  // No profile is the default one; a profile that is not one Authrim knows is a broken contract.
  if (profile !== undefined && !isValidProfileType(profile)) {
    throw new Error('tenant_contract_profile_invalid');
  }
  return getTenantProfile(profile);
}

// =============================================================================
// Profile-based Grant Type Filtering
// =============================================================================

/**
 * Filter grant_types based on TenantProfile capabilities
 *
 * Used by Discovery endpoint to return only supported grant types
 * based on the tenant's profile configuration.
 *
 * RFC 8414 §2: Discovery metadata SHOULD reflect actual capabilities.
 *
 * @param grantTypes - Array of grant types to filter
 * @param profile - TenantProfile with capability flags
 * @param featureFlags - Global feature flags (token exchange, client credentials)
 * @returns Filtered array of supported grant types
 */
export function filterGrantTypesByProfile(
  grantTypes: string[],
  profile: TenantProfile,
  featureFlags: {
    tokenExchangeEnabled: boolean;
    clientCredentialsEnabled: boolean;
  }
): string[] {
  return grantTypes.filter((grantType) => {
    switch (grantType) {
      case 'client_credentials':
        // RFC 6749 §4.4: Client Credentials Grant
        // Only allowed for ai_ephemeral profile (M2M authentication)
        return featureFlags.clientCredentialsEnabled && profile.allows_client_credentials;

      case 'refresh_token':
        // RFC 6749 §6: Refresh Token
        // Human profiles allow refresh tokens, AI ephemeral does not
        return profile.allows_refresh_token;

      case 'urn:ietf:params:oauth:grant-type:token-exchange':
        // RFC 8693: Token Exchange
        // Both profiles can use token exchange for delegation
        return featureFlags.tokenExchangeEnabled && profile.allows_token_exchange;

      case 'authorization_code':
      case 'implicit':
        // RFC 6749 §4.1/4.2: Authorization Code / Implicit Grant
        // Human profiles only (requires user interaction)
        // Note: AI ephemeral also allowed for MCP User Delegation (DO ensures security)
        return profile.allows_login || profile.type === 'ai_ephemeral';

      default:
        // Other grant types (device_code, ciba, jwt-bearer) follow global flags
        return true;
    }
  });
}

/**
 * Filter response_types based on TenantProfile capabilities
 *
 * Used by Authorize endpoint to validate supported response types
 * based on the tenant's profile configuration.
 *
 * @param responseTypes - Array of response types to filter
 * @param profile - TenantProfile with capability flags
 * @returns Filtered array of supported response types
 */
export function filterResponseTypesByProfile(
  responseTypes: string[],
  profile: TenantProfile
): string[] {
  // For AI ephemeral profile with allows_login = false:
  // - Still allow 'code' for MCP User Delegation scenario
  // - Restrict implicit flow (id_token, token) as it's less secure
  if (!profile.allows_login && profile.type === 'ai_ephemeral') {
    return responseTypes.filter((responseType) => {
      // Allow authorization code flow for MCP User Delegation
      if (responseType === 'code') {
        return true;
      }
      // Restrict implicit and hybrid flows
      return false;
    });
  }

  // Human profiles allow all response types
  return responseTypes;
}

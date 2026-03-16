/**
 * Issuer URL construction for multi-tenant Authrim
 *
 * Architecture:
 * - Each environment (test, staging, prod) runs as a separate Workers instance
 * - Each instance has its own BASE_DOMAIN (e.g., test.authrim.com, authrim.com)
 * - Within an instance, multiple tenants are managed via subdomain
 *
 * Domain patterns:
 * - Single tenant: example.com → default tenant
 * - Multi-tenant: tenant.example.com → "tenant"
 * - Complex: tenant-xyz.example.com → "tenant-xyz"
 *
 * Naked domain routing:
 * - If PRIMARY_TENANT_ID is set: example.com → specified tenant
 * - Otherwise: example.com → DEFAULT_TENANT_ID (default: "default")
 *
 * Security: Issuer determination is based on Host header (trusted),
 * NOT tenant_hint (untrusted UX hint).
 */

import type { Env } from '../types/env';
import { DEFAULT_TENANT_ID } from './tenant-context';

/**
 * Result of Host validation
 */
export interface HostValidationResult {
  valid: boolean;
  tenantId: string | null;
  error?: 'invalid_format' | 'missing_host' | 'tenant_not_found';
  statusCode?: 400 | 404;
}

/**
 * Get the effective default tenant ID for the current environment.
 */
export function getDefaultTenantId(env: Partial<Env>): string {
  return env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
}

/**
 * Get the tenant ID that should own the naked domain when BASE_DOMAIN is used.
 */
export function getPrimaryTenantId(env: Partial<Env>): string {
  return env.PRIMARY_TENANT_ID || getDefaultTenantId(env);
}

/**
 * Returns true when the provided tenant should use the naked BASE_DOMAIN as its canonical issuer.
 */
export function usesNakedDomainIssuer(env: Partial<Env>, tenantId?: string): boolean {
  if (env.NAKED_DOMAIN_AS_ISSUER !== 'true' || !env.BASE_DOMAIN) {
    return false;
  }

  return (tenantId || getDefaultTenantId(env)) === getPrimaryTenantId(env);
}

/**
 * Build the OIDC issuer URL for a tenant.
 *
 * Multi-tenant mode is always enabled. Constructs dynamic issuer URL
 * from subdomain and BASE_DOMAIN.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantSubdomain - Tenant subdomain (optional)
 * @returns The issuer URL string
 *
 * @example
 * // With BASE_DOMAIN = "authrim.com"
 * buildIssuerUrl(env)               // => 'https://default.authrim.com' (or primary tenant)
 * buildIssuerUrl(env, 'acme')       // => 'https://acme.authrim.com'
 * buildIssuerUrl(env, 'acme-test')  // => 'https://acme-test.authrim.com'
 *
 * // Legacy fallback (ISSUER_URL set, no BASE_DOMAIN)
 * buildIssuerUrl(env)               // => 'https://auth.example.com' (ISSUER_URL)
 */
export function buildIssuerUrl(env: Env, tenantSubdomain?: string): string {
  // Multi-tenant mode: construct from subdomain + BASE_DOMAIN
  if (env.BASE_DOMAIN) {
    const sub = tenantSubdomain || getDefaultTenantId(env);

    if (usesNakedDomainIssuer(env, sub)) {
      return `https://${env.BASE_DOMAIN}`;
    }

    return `https://${sub}.${env.BASE_DOMAIN}`;
  }

  // Legacy single-tenant mode: use configured ISSUER_URL
  return env.ISSUER_URL;
}

/**
 * Check if multi-tenant mode is enabled
 *
 * @deprecated Multi-tenant mode is always enabled when BASE_DOMAIN is set.
 * This function is kept for backward compatibility with legacy code.
 *
 * @param env - Environment bindings
 * @returns true if multi-tenant mode is enabled
 */
export function isMultiTenantEnabled(env: Partial<Env>): boolean {
  // Multi-tenant mode is enabled when BASE_DOMAIN is set
  return !!env.BASE_DOMAIN;
}

/**
 * Validate Host header and extract tenant ID
 *
 * Error codes:
 * - 400 Bad Request: missing_host, invalid_format
 * - 404 Not Found: tenant_not_found (tenant existence hidden for security)
 *
 * @param host - Host header value
 * @param env - Environment bindings
 * @returns Validation result with tenant ID
 */
export function validateHostHeader(
  host: string | undefined,
  env: Partial<Env>
): HostValidationResult {
  // Single-tenant mode (no BASE_DOMAIN): always valid with default tenant
  if (!env.BASE_DOMAIN) {
    return {
      valid: true,
      tenantId: getDefaultTenantId(env),
    };
  }

  // Multi-tenant mode requires Host header
  if (!host) {
    return {
      valid: false,
      tenantId: null,
      error: 'missing_host',
      statusCode: 400,
    };
  }

  // Validate Host format (basic check)
  if (!isValidHostFormat(host)) {
    return {
      valid: false,
      tenantId: null,
      error: 'invalid_format',
      statusCode: 400,
    };
  }

  // Extract tenant subdomain or use PRIMARY_TENANT_ID for naked domain
  // Normalize to lowercase per RFC 7230 (Host header is case-insensitive)
  const hostname = host.split(':')[0].toLowerCase(); // Remove port, normalize case

  // Check if hostname matches BASE_DOMAIN
  if (hostname === env.BASE_DOMAIN) {
    // Naked domain access
    const tenantId = getPrimaryTenantId(env);
    return {
      valid: true,
      tenantId,
    };
  }

  // Check if hostname ends with .BASE_DOMAIN
  if (!hostname.endsWith(`.${env.BASE_DOMAIN}`)) {
    return {
      valid: false,
      tenantId: null,
      error: 'tenant_not_found',
      statusCode: 404,
    };
  }

  // Extract subdomain
  const subdomain = hostname.slice(0, -(env.BASE_DOMAIN.length + 1));

  if (!subdomain) {
    // Empty subdomain (should not happen due to above checks, but handle gracefully)
    return {
      valid: false,
      tenantId: null,
      error: 'tenant_not_found',
      statusCode: 404,
    };
  }

  // Reject sub-subdomains (e.g., dev.acme.authrim.com)
  // Only single-level subdomains are allowed (e.g., acme.authrim.com)
  if (subdomain.includes('.')) {
    return {
      valid: false,
      tenantId: null,
      error: 'invalid_format',
      statusCode: 400,
    };
  }

  // Multi-tenant subdomain
  return {
    valid: true,
    tenantId: subdomain,
  };
}

/**
 * Validate Host header format
 *
 * @param host - Host header value
 * @returns true if format is valid
 */
function isValidHostFormat(host: string): boolean {
  // Remove port if present
  const hostWithoutPort = host.split(':')[0];

  // Basic validation: alphanumeric, hyphens, dots
  // Must not start or end with hyphen/dot
  const validPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
  return validPattern.test(hostWithoutPort);
}

/**
 * Extract the tenant subdomain from a full hostname.
 *
 * @deprecated Use validateHostHeader() instead for validation and tenant extraction.
 * This function is kept for backward compatibility with legacy code.
 *
 * @param hostname - Full hostname (e.g., 'acme.authrim.app')
 * @param baseDomain - Base domain to strip (e.g., 'authrim.app')
 * @returns Tenant subdomain or null if not found
 *
 * @example
 * extractSubdomain('acme.authrim.app', 'authrim.app') // => 'acme'
 * extractSubdomain('authrim.app', 'authrim.app') // => null
 */
export function extractSubdomain(hostname: string, baseDomain: string): string | null {
  // Remove port if present
  const host = hostname.split(':')[0];

  // Check if hostname ends with ".baseDomain" to prevent partial matches
  // e.g., "acme.notauthrim.com" should NOT match "authrim.com"
  const fullSuffix = '.' + baseDomain;
  if (!host.endsWith(fullSuffix)) {
    return null;
  }

  // Extract subdomain (exclude the dot separator)
  const subdomain = host.slice(0, -fullSuffix.length);

  // Return null if no subdomain or if it's empty
  if (!subdomain || subdomain === '') {
    return null;
  }

  // Reject sub-subdomains (e.g., dev.acme.authrim.com)
  // Only single-level subdomains are allowed
  if (subdomain.includes('.')) {
    return null;
  }

  return subdomain;
}

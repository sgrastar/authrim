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
 * - If NAKED_DOMAIN_AS_ISSUER=true and PRIMARY_TENANT_ID is set:
 *   example.com → specified tenant
 * - If NAKED_DOMAIN_AS_ISSUER=true and PRIMARY_TENANT_ID is not set:
 *   example.com → DEFAULT_TENANT_ID (default: "default")
 * - Otherwise the naked domain is not treated as a tenant endpoint
 *
 * Security: Issuer determination is based on Host header (trusted),
 * NOT tenant_hint (untrusted UX hint).
 */

import { ensureDatabaseAdapter, type DatabaseSource } from '../db';
import type { Env } from '../types/env';
import { DEFAULT_TENANT_ID } from './tenant-context';

export interface IssuerEnvLike {
  ISSUER_URL?: string;
  BASE_DOMAIN?: string;
  NAKED_DOMAIN_AS_ISSUER?: string;
  PRIMARY_TENANT_ID?: string;
  DEFAULT_TENANT_ID?: string;
}

/**
 * Validate that a tenant exists and is runtime-active using D1 + KV positive cache.
 *
 * - Positive cache TTL: 300s (negative results are NOT cached to allow immediate
 *   recognition after tenant creation)
 * - DB error → fail-open to prevent outage from blocking all requests
 *
 * @param db - D1 database binding (undefined = fail-open)
 * @param kv - KV namespace for caching (undefined = skip cache)
 * @param tenantId - Tenant ID to validate
 * @returns true if tenant exists and is active, false if not found or not runtime-active
 */
export async function validateTenantExistsAsync(
  db: DatabaseSource | undefined,
  kv: KVNamespace | undefined,
  tenantId: string
): Promise<boolean> {
  const cacheKey = `v1:tenant-exists:${tenantId}`;

  // Check KV positive cache first
  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached === 'true') return true;
    } catch {
      // KV error → fall through to D1
    }
  }

  // Fail-open if no DB binding
  if (!db) return true;

  try {
    const adapter = ensureDatabaseAdapter(db, 'tenant-exists');
    const row = await adapter.queryOne<{ id: string }>(
      "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active'",
      [tenantId]
    );

    if (!row) {
      const health = await adapter.isHealthy().catch(() => ({
        healthy: false,
      }));
      return health.healthy ? false : true;
    }

    // Write positive cache only (never cache negative to ensure immediate visibility)
    if (kv) {
      await kv.put(cacheKey, 'true', { expirationTtl: 300 }).catch(() => {});
    }
    return true;
  } catch {
    // D1 error → fail-open to prevent outage from blocking requests
    return true;
  }
}

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
export function getDefaultTenantId(env: Partial<IssuerEnvLike>): string {
  return env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
}

/**
 * Get the tenant ID that should own the naked domain when BASE_DOMAIN is used.
 */
export function getPrimaryTenantId(env: Partial<IssuerEnvLike>): string {
  return env.PRIMARY_TENANT_ID || getDefaultTenantId(env);
}

function requireIssuerTenantId(tenantId: string, context: string): string {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalizedTenantId;
}

/**
 * Returns true when the provided tenant should use the naked BASE_DOMAIN as its canonical issuer.
 */
export function usesNakedDomainIssuer(env: Partial<IssuerEnvLike>, tenantId: string): boolean {
  if (env.NAKED_DOMAIN_AS_ISSUER !== 'true' || !env.BASE_DOMAIN) {
    return false;
  }

  return requireIssuerTenantId(tenantId, 'usesNakedDomainIssuer') === getPrimaryTenantId(env);
}

/**
 * Build the OIDC issuer URL for a tenant.
 *
 * Multi-tenant mode is always enabled. Constructs dynamic issuer URL
 * from subdomain and BASE_DOMAIN.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantSubdomain - Tenant subdomain
 * @returns The issuer URL string
 *
 * @example
 * // With BASE_DOMAIN = "authrim.com"
 * buildIssuerUrl(env, 'acme')       // => 'https://acme.authrim.com'
 * buildIssuerUrl(env, 'acme-test')  // => 'https://acme-test.authrim.com'
 *
 * // Legacy fallback (ISSUER_URL set, no BASE_DOMAIN)
 * buildIssuerUrl(env, tenantId)     // => 'https://auth.example.com' (ISSUER_URL)
 */
export function buildIssuerUrl(env: IssuerEnvLike, tenantSubdomain: string): string {
  // Multi-tenant mode: construct from subdomain + BASE_DOMAIN
  if (env.BASE_DOMAIN) {
    const sub = requireIssuerTenantId(tenantSubdomain, 'buildIssuerUrl');

    if (usesNakedDomainIssuer(env, sub)) {
      return `https://${env.BASE_DOMAIN}`;
    }

    return `https://${sub}.${env.BASE_DOMAIN}`;
  }

  // Legacy single-tenant mode: use configured ISSUER_URL
  return env.ISSUER_URL || '';
}

function normalizeHostCandidate(candidate: string | null | undefined): string | null {
  const value = candidate?.split(',')[0]?.trim();
  if (!value) {
    return null;
  }

  const host = value.toLowerCase();
  return isValidHostFormat(host) ? host : null;
}

export function getRequestHost(request?: Request | null): string | null {
  if (!request) {
    return null;
  }

  return (
    normalizeHostCandidate(request.headers.get('Host')) ||
    normalizeHostCandidate(request.headers.get('X-Authrim-Forwarded-Host')) ||
    normalizeHostCandidate(request.headers.get('X-Forwarded-Host')) ||
    (() => {
      try {
        return normalizeHostCandidate(new URL(request.url).host);
      } catch {
        return null;
      }
    })()
  );
}

export function buildRequestIssuerUrl(
  request: Request | null | undefined,
  env: Partial<IssuerEnvLike>,
  tenantId: string
): string {
  const explicitHost =
    request &&
    (normalizeHostCandidate(request.headers.get('Host')) ||
      normalizeHostCandidate(request.headers.get('X-Authrim-Forwarded-Host')) ||
      normalizeHostCandidate(request.headers.get('X-Forwarded-Host')));
  const requestHost = getRequestHost(request);
  const requestHostname = requestHost?.split(':')[0];
  const shouldIgnoreImplicitLocalhost =
    !explicitHost &&
    !!requestHostname &&
    ['localhost', '127.0.0.1', '::1'].includes(requestHostname) &&
    (!!env.BASE_DOMAIN || !!env.ISSUER_URL);

  if (!env.BASE_DOMAIN) {
    if (env.ISSUER_URL) {
      return env.ISSUER_URL;
    }

    if (requestHost && !shouldIgnoreImplicitLocalhost) {
      return `https://${requestHost.split(':')[0]}`;
    }

    return buildIssuerUrl(env, tenantId);
  }

  if (requestHost && !shouldIgnoreImplicitLocalhost) {
    return `https://${requestHost.split(':')[0]}`;
  }

  return buildIssuerUrl(env, tenantId);
}

export function buildRequestIdentifier(
  request: Request | null | undefined,
  env: Partial<IssuerEnvLike>,
  tenantId: string,
  configuredIdentifier?: string
): string {
  const issuerUrl = buildRequestIssuerUrl(request, env, tenantId);
  const hostname = new URL(issuerUrl).hostname;

  if (!configuredIdentifier) {
    return `did:web:${hostname}`;
  }

  if (configuredIdentifier.startsWith('https://') || configuredIdentifier.startsWith('http://')) {
    return issuerUrl;
  }

  if (configuredIdentifier.startsWith('did:web:')) {
    return `did:web:${hostname}`;
  }

  return configuredIdentifier;
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
    // Naked domain access is only valid when explicitly enabled.
    if (env.NAKED_DOMAIN_AS_ISSUER !== 'true') {
      return {
        valid: false,
        tenantId: null,
        error: 'tenant_not_found',
        statusCode: 404,
      };
    }

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

import type { KVNamespace } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter } from '../db';
import type { TenantRBACDatabases } from '../services/tenant-rbac';
import type { Env } from '../types/env';
import { KV_MIN_TTL_SECONDS } from './kv-ttl';
import { createLogger } from './logger';

const log = createLogger().module('RBAC_CLAIMS');

export function requireTenantId(tenantId: string | undefined, context: string): string {
  const normalized = tenantId?.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

// =============================================================================
// RBAC Cache Configuration
// =============================================================================

const DEFAULT_RBAC_CACHE_TTL = 600; // 10 minutes in seconds (default)
// v2: roles named by the tenant metadata database, tenant-wide permissions from tenant-wide
// assignments only. Entries computed before are not read (they expire on their own).
// v4: organisations removed (no authrim_org_* claims, no organisation fields in the composite entry).
// v6: roles below their wildcard grant tier are ignored when read; an entry computed before could
// still name one, so none is read.
const RBAC_CACHE_PREFIX = 'rbac:v6:';
const DEFAULT_RBAC_CACHE_VERSION = 1; // Increment when CompositeRBACCache structure changes

// In-memory cache for TTL value (avoid repeated KV reads)
let cachedRBACCacheTTL: number | null = null;
let cachedRBACCacheTTLAt = 0;
const TTL_CACHE_DURATION_MS = 60000; // 1 minute

/**
 * Get RBAC cache TTL with dynamic configuration
 *
 * Priority: KV (rbac_cache_ttl) > Environment variable (RBAC_CACHE_TTL) > Default (600s)
 *
 * @param env - Environment bindings
 * @returns TTL in seconds
 */
export async function getRBACCacheTTL(env: Env): Promise<number> {
  const now = Date.now();

  // Return cached value if within TTL
  if (cachedRBACCacheTTL !== null && now - cachedRBACCacheTTLAt < TTL_CACHE_DURATION_MS) {
    return cachedRBACCacheTTL;
  }

  // KV takes priority if available (dynamically changeable)
  if (env.AUTHRIM_CONFIG) {
    const kvValue = await env.AUTHRIM_CONFIG.get('rbac_cache_ttl');
    if (kvValue) {
      const parsed = parseInt(kvValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        cachedRBACCacheTTL = parsed;
        cachedRBACCacheTTLAt = now;
        return parsed;
      }
    }
  }

  // Fallback to environment variable
  if (env.RBAC_CACHE_TTL) {
    const parsed = parseInt(env.RBAC_CACHE_TTL, 10);
    if (!isNaN(parsed) && parsed > 0) {
      cachedRBACCacheTTL = parsed;
      cachedRBACCacheTTLAt = now;
      return parsed;
    }
  }

  // Default value
  cachedRBACCacheTTL = DEFAULT_RBAC_CACHE_TTL;
  cachedRBACCacheTTLAt = now;
  return DEFAULT_RBAC_CACHE_TTL;
}

// In-memory cache for version value (avoid repeated KV reads)
let cachedRBACCacheVersion: number | null = null;
let cachedRBACCacheVersionAt = 0;

/**
 * Get RBAC cache version with dynamic configuration
 *
 * Priority: KV (rbac_cache_version) > ENV (RBAC_CACHE_VERSION) > Default (1)
 *
 * Use case: When RBAC internal logic changes and cache needs invalidation,
 * increment the version in KV to force cache miss without deployment.
 *
 * @param env - Environment bindings
 * @returns Cache version number
 */
export async function getRBACCacheVersion(env: Env): Promise<number> {
  const now = Date.now();

  // Return cached value if within TTL
  if (cachedRBACCacheVersion !== null && now - cachedRBACCacheVersionAt < TTL_CACHE_DURATION_MS) {
    return cachedRBACCacheVersion;
  }

  // KV takes priority if available (dynamically changeable)
  if (env.AUTHRIM_CONFIG) {
    const kvValue = await env.AUTHRIM_CONFIG.get('rbac_cache_version');
    if (kvValue) {
      const parsed = parseInt(kvValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        cachedRBACCacheVersion = parsed;
        cachedRBACCacheVersionAt = now;
        return parsed;
      }
    }
  }

  // Fallback to environment variable
  if (env.RBAC_CACHE_VERSION) {
    const parsed = parseInt(env.RBAC_CACHE_VERSION, 10);
    if (!isNaN(parsed) && parsed > 0) {
      cachedRBACCacheVersion = parsed;
      cachedRBACCacheVersionAt = now;
      return parsed;
    }
  }

  // Default value
  cachedRBACCacheVersion = DEFAULT_RBAC_CACHE_VERSION;
  cachedRBACCacheVersionAt = now;
  return DEFAULT_RBAC_CACHE_VERSION;
}

/**
 * Cache generations live in the claims cache namespace itself. A change that affects many
 * subjects at once (a role granted to a group, a group moved under another parent, a role's
 * permissions edited) bumps the tenant version; a change to one subject (a membership, a direct
 * assignment) bumps that subject's version. An entry is served only when both versions it was
 * computed under are still current, so a delayed write of stale data can never outlive a later
 * invalidation. Versions are read before the data is computed for the same reason.
 */
function tenantRBACCacheVersionKey(tenantId: string): string {
  // Fixed literals, the names of the first generation: workers of the older and the newer code
  // agree on them, and a data-format bump of RBAC_CACHE_PREFIX does not reset them.
  return `rbac:v2:tenant-version:${requireTenantId(tenantId, 'RBAC cache version')}`;
}

function subjectRBACCacheVersionKey(tenantId: string, subjectId: string): string {
  const tenant = requireTenantId(tenantId, 'RBAC cache version');
  return `rbac:v2:subject-version:${tenant}:${subjectId}`;
}

export async function getTenantRBACCacheVersion(
  cache: KVNamespace,
  tenantId: string
): Promise<string> {
  return (await cache.get(tenantRBACCacheVersionKey(tenantId))) ?? '0';
}

export async function bumpTenantRBACCacheVersion(
  cache: KVNamespace,
  tenantId: string
): Promise<void> {
  await cache.put(tenantRBACCacheVersionKey(tenantId), crypto.randomUUID());
}

/**
 * Makes every cached RBAC entry of a subject (the composite entry and the per-token claim sets)
 * unusable, so a removed role or membership leaves tokens issued from now on rather than when the
 * cache expires.
 */
export async function invalidateSubjectRBACCache(
  cache: KVNamespace,
  tenantId: string,
  subjectId: string
): Promise<void> {
  await cache.put(subjectRBACCacheVersionKey(tenantId, subjectId), crypto.randomUUID());
}

/**
 * Options for RBAC claims functions with caching support
 */
export interface RBACClaimsOptions {
  cache?: KVNamespace; // REBAC_CACHE KV namespace
  claimsConfig?: string; // Comma-separated list of claims to include
  env?: Env; // Environment bindings for dynamic TTL
  tenantId: string; // Tenant ID for multi-tenant isolation
}

/**
 * Build cache key for RBAC claims (with multi-tenant support)
 */
export function buildRBACCacheKey(
  subjectId: string,
  tokenType: 'id' | 'access',
  claimsConfig: string | undefined,
  tenantId: string
): string {
  const configKey =
    claimsConfig === undefined ? 'default' : 'config-' + encodeURIComponent(claimsConfig);
  const tenant = requireTenantId(tenantId, 'buildRBACCacheKey');
  return `${RBAC_CACHE_PREFIX}${tenant}:${tokenType}:${subjectId}:${configKey}`;
}

/**
 * Build cache key for Composite RBAC cache (all data in one entry)
 */
export function buildCompositeRBACCacheKey(subjectId: string, tenantId: string): string {
  const tenant = requireTenantId(tenantId, 'buildCompositeRBACCacheKey');
  return `${RBAC_CACHE_PREFIX}composite:${tenant}:${subjectId}`;
}

interface CachedClaims<T> {
  generation: string;
  /** Unix seconds; the earliest scheduled change (start, expiry, staleness) of the subject's roles. */
  validUntil: number;
  claims: T;
}

/** The next moment at which the subject's effective roles change on their own. */
async function nextRoleBoundary(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  now: number
): Promise<number> {
  const [account, metadata] = await Promise.all([
    ensureDatabaseAdapter(dbs.account).queryOne<{ boundary: number | string | null }>(
      `WITH memberships AS (SELECT starts_at, expires_at, stale_after FROM group_memberships
        WHERE tenant_id=? AND subject_id=? AND lifecycle_state='active')
      SELECT MIN(boundary) AS boundary FROM (
        SELECT starts_at AS boundary FROM memberships UNION ALL SELECT expires_at FROM memberships
        UNION ALL SELECT stale_after FROM memberships UNION ALL
        SELECT expires_at FROM role_assignments WHERE tenant_id=? AND subject_id=?
      ) AS boundaries WHERE boundary>?`,
      [tenantId, subjectId, tenantId, subjectId, now]
    ),
    ensureDatabaseAdapter(dbs.metadata).queryOne<{ boundary: number | string | null }>(
      `SELECT MIN(boundary) AS boundary FROM (
        SELECT expires_at AS boundary FROM group_role_assignments WHERE tenant_id=? AND expires_at>?
        UNION ALL
        SELECT expires_at FROM resource_permissions WHERE tenant_id=? AND is_active=1 AND expires_at>?
      ) AS boundaries`,
      [tenantId, now, tenantId, now]
    ),
  ]);
  const values = [account?.boundary, metadata?.boundary]
    .map((value) => (value === null || value === undefined ? Infinity : Number(value)))
    .filter((value) => Number.isFinite(value) && value > now);
  return values.length ? Math.min(...values) : Infinity;
}

/**
 * Reads `key` from the claims cache and returns its payload when it was written under the current
 * generation (global, tenant and subject versions) and before its validity boundary; otherwise
 * computes the payload and stores it until the configured TTL or the next boundary, whichever
 * comes first. The write is fire-and-forget, as before.
 */
export async function cachedRoleData<T>(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string,
  key: string,
  options: Partial<RBACClaimsOptions> & {
    cacheTTL?: number;
    /** Whether the computed payload may be stored (false: a partial answer, served once). */
    shouldCache?: () => boolean;
  },
  compute: (version: number) => Promise<T>
): Promise<T> {
  const { cache, env } = options;
  let version = DEFAULT_RBAC_CACHE_VERSION;
  let generation: string | null = null;
  const now = Math.floor(Date.now() / 1000);
  try {
    // A failing settings or cache read leaves this request uncached; the claims are still computed.
    const [configured, tenantVersion, subjectVersion, raw] = await Promise.all([
      env ? getRBACCacheVersion(env) : DEFAULT_RBAC_CACHE_VERSION,
      cache ? getTenantRBACCacheVersion(cache, tenantId) : '0',
      cache ? cache.get(subjectRBACCacheVersionKey(tenantId, subjectId)) : null,
      cache ? cache.get(key) : null,
    ]);
    version = configured;
    if (cache) {
      generation = `${version}:${tenantVersion}:${subjectVersion ?? '0'}`;
      if (raw) {
        const entry = JSON.parse(raw) as Partial<CachedClaims<T>>;
        if (
          entry.generation === generation &&
          typeof entry.validUntil === 'number' &&
          entry.validUntil > Math.floor(Date.now() / 1000) &&
          entry.claims !== undefined
        )
          return entry.claims;
      }
    }
  } catch {
    // PII Protection: Don't log full error object
    log.warn('RBAC cache read error');
    generation = null;
  }

  const claims = await compute(version);
  if (!cache || generation === null || options.shouldCache?.() === false) return claims;
  const stamp = generation;
  const storeCacheAsync = async () => {
    try {
      const [boundary, configured] = await Promise.all([
        nextRoleBoundary(dbs, tenantId, subjectId, now),
        options.cacheTTL ?? (env ? getRBACCacheTTL(env) : DEFAULT_RBAC_CACHE_TTL),
      ]);
      const validUntil = Math.min(now + configured, boundary);
      const ttl = validUntil - Math.floor(Date.now() / 1000);
      // Under KV's 60-second minimum the put would fail: such a TTL leaves the claims uncached.
      if (ttl < KV_MIN_TTL_SECONDS) return;
      const entry: CachedClaims<T> = { generation: stamp, validUntil, claims };
      await cache.put(key, JSON.stringify(entry), { expirationTtl: ttl });
    } catch {
      // PII Protection: Don't log full error object
      log.warn('RBAC cache write error');
    }
  };
  void storeCacheAsync();
  return claims;
}

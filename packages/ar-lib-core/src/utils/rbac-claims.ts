/**
 * RBAC Claims Utility
 *
 * Utilities for retrieving RBAC information to include in tokens.
 * Part of RBAC Phase 1 & 2 implementation.
 *
 * Environment Variables:
 * - RBAC_ID_TOKEN_CLAIMS: Comma-separated list of claims to include in ID Token
 *   Default: "roles,user_type,org_id,plan,org_type"
 *   Available: roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
 *
 * - RBAC_ACCESS_TOKEN_CLAIMS: Comma-separated list of claims to include in Access Token
 *   Default: "roles,org_id,org_type"
 *   Available: roles,scoped_roles,org_id,org_type,permissions,org_context
 *
 * Usage:
 * ```typescript
 * import { getUserRBACClaims, getIDTokenRBACClaims, getAccessTokenRBACClaims } from '@authrim/ar-lib-core';
 *
 * // Roles and organisations are defined in the tenant metadata database and assigned in the
 * // subject's account database (see services/tenant-rbac.ts).
 * const dbs = { metadata: tenantMetadataDb, account: accountCoreDb };
 * const claims = await getUserRBACClaims(dbs, subjectId, tenantId);
 * // Add to token: { ...claims }
 *
 * // Or with environment variable control:
 * const idTokenClaims = await getIDTokenRBACClaims(dbs, subjectId, {
 *   claimsConfig: env.RBAC_ID_TOKEN_CLAIMS,
 *   tenantId,
 * });
 * const accessTokenClaims = await getAccessTokenRBACClaims(dbs, subjectId, {
 *   claimsConfig: env.RBAC_ACCESS_TOKEN_CLAIMS,
 *   tenantId,
 * });
 * ```
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import { createLogger } from './logger';
import type {
  RBACTokenClaims,
  UserType,
  PlanType,
  OrganizationType,
  ScopeType,
  TokenOrgInfo,
  TokenScopedRole,
  RelationshipsSummary,
  IDTokenClaimKey,
  AccessTokenClaimKey,
} from '../types/rbac';
import { DEFAULT_ID_TOKEN_CLAIMS, DEFAULT_ACCESS_TOKEN_CLAIMS } from '../types/rbac';
import type { Env } from '../types/env';
import {
  resolveSubjectOrganizations,
  resolveSubjectRoles,
  isSet,
  rolePermissions,
  type ResolvedSubjectOrganization,
  type ResolvedSubjectRole,
  type TenantRBACDatabases,
} from '../services/tenant-rbac';

const log = createLogger().module('RBAC_CLAIMS');

function getRBACDatabaseAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'rbac-claims');
}

function requireTenantId(tenantId: string | undefined, context: string): string {
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
const RBAC_CACHE_PREFIX = 'rbac:';
const DEFAULT_RBAC_CACHE_VERSION = 1; // Increment when CompositeRBACCache structure changes

// In-memory cache for TTL value (avoid repeated KV reads)
let cachedRBACCacheTTL: number | null = null;
let cachedRBACCacheTTLAt = 0;
const TTL_CACHE_DURATION_MS = 60000; // 1 minute

// In-memory cache for version value (avoid repeated KV reads)
let cachedRBACCacheVersion: number | null = null;
let cachedRBACCacheVersionAt = 0;

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
 * Options for RBAC claims functions with caching support
 */
export interface RBACClaimsOptions {
  cache?: KVNamespace; // REBAC_CACHE KV namespace
  claimsConfig?: string; // Comma-separated list of claims to include
  env?: Env; // Environment bindings for dynamic TTL
  tenantId: string; // Tenant ID for multi-tenant isolation
}

/**
 * Composite RBAC cache entry containing all RBAC data for a user
 * This allows fetching all RBAC information with a single KV read
 */
export interface CompositeRBACCache {
  version: number; // Cache structure version (from KV/ENV)
  roles: string[];
  scoped_roles: TokenScopedRole[];
  permissions: string[];
  organizations: TokenOrgInfo[];
  user_type: UserType;
  plan: PlanType | null;
  org_id: string | null;
  org_name: string | null;
  org_type: OrganizationType | null;
  relationships_summary: RelationshipsSummary;
  cached_at: number; // Unix timestamp
}

/**
 * Build cache key for RBAC claims (with multi-tenant support)
 */
function buildRBACCacheKey(
  subjectId: string,
  tokenType: 'id' | 'access',
  claimsConfig: string | undefined,
  tenantId: string
): string {
  // Include claimsConfig hash to differentiate cache entries with different claim sets
  const configHash = claimsConfig
    ? Buffer.from(claimsConfig).toString('base64').slice(0, 8)
    : 'default';
  const tenant = requireTenantId(tenantId, 'buildRBACCacheKey');
  return `${RBAC_CACHE_PREFIX}${tenant}:${tokenType}:${subjectId}:${configHash}`;
}

/**
 * Build cache key for Composite RBAC cache (all data in one entry)
 */
function buildCompositeRBACCacheKey(subjectId: string, tenantId: string): string {
  const tenant = requireTenantId(tenantId, 'buildCompositeRBACCacheKey');
  return `${RBAC_CACHE_PREFIX}composite:${tenant}:${subjectId}`;
}

/**
 * Drops every cached RBAC entry of a subject (the composite entry and the per-token claim sets),
 * so a removed role or membership leaves tokens issued from now on rather than when the cache
 * expires. Per-token keys carry a hash of the claims configuration, so they are found by prefix.
 */
export async function invalidateSubjectRBACCache(
  cache: KVNamespace,
  tenantId: string,
  subjectId: string
): Promise<void> {
  const tenant = requireTenantId(tenantId, 'invalidateSubjectRBACCache');
  const keys = [buildCompositeRBACCacheKey(subjectId, tenant)];
  for (const tokenType of ['id', 'access'] as const) {
    let cursor: string | undefined;
    do {
      const listed = await cache.list({
        prefix: `${RBAC_CACHE_PREFIX}${tenant}:${tokenType}:${subjectId}:`,
        cursor,
      });
      keys.push(...listed.keys.map((key) => key.name));
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }
  await Promise.all(keys.map((key) => cache.delete(key)));
}

/**
 * Get or create composite RBAC cache for a user
 *
 * This function consolidates all RBAC data into a single KV entry,
 * reducing D1 queries from 7 to 1 on cache miss.
 *
 * Benefits:
 * - Single KV read for all RBAC data (cache hit)
 * - Single parallel D1 query batch on cache miss
 * - Multi-tenant isolation via tenantId in cache key
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param options - Options including cache KV, env for TTL, and tenantId
 * @returns Composite RBAC cache object
 */
export async function getCompositeRBACCache(
  dbs: TenantRBACDatabases,
  subjectId: string,
  options: Partial<RBACClaimsOptions> = {}
): Promise<CompositeRBACCache> {
  const { cache, env } = options;
  const tenantId = requireTenantId(options.tenantId, 'RBAC claims');

  // Try cache first
  if (cache) {
    const cacheKey = buildCompositeRBACCacheKey(subjectId, tenantId);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as CompositeRBACCache;
        // Get current version from KV/ENV
        const currentVersion = env ? await getRBACCacheVersion(env) : DEFAULT_RBAC_CACHE_VERSION;
        // Validate cache structure and version
        if (
          parsed.version === currentVersion &&
          parsed.cached_at &&
          typeof parsed.roles !== 'undefined'
        ) {
          return parsed;
        }
        // Version mismatch → treat as cache miss (will be refreshed)
      }
    } catch (error) {
      // PII Protection: Don't log full error object
      log.warn('Composite RBAC cache read error');
    }
  }

  // Cache miss - fetch all RBAC data in parallel
  const data = subjectRBACData(dbs, subjectId, tenantId);
  const [subjectRoles, subjectOrganizations, userType, relationships] = await Promise.all([
    data.roles(),
    data.organizations(),
    resolveUserType(dbs.account, subjectId, tenantId),
    resolveRelationshipsSummary(dbs.account, subjectId, tenantId),
  ]);
  const orgInfo = organizationInfo(subjectOrganizations);

  // Get current version for cache storage
  const cacheVersion = env ? await getRBACCacheVersion(env) : DEFAULT_RBAC_CACHE_VERSION;

  const compositeCache: CompositeRBACCache = {
    version: cacheVersion,
    roles: roleNames(subjectRoles),
    scoped_roles: scopedRoles(subjectRoles),
    permissions: grantedPermissions(subjectRoles),
    organizations: organizationList(subjectOrganizations),
    user_type: userType,
    plan: orgInfo?.plan ?? null,
    org_id: orgInfo?.org_id ?? null,
    org_name: primaryOrganization(subjectOrganizations)?.organization.name ?? null,
    org_type: orgInfo?.org_type ?? null,
    relationships_summary: relationships,
    cached_at: Math.floor(Date.now() / 1000),
  };

  // Store in cache (fire-and-forget with dynamic TTL)
  if (cache) {
    const cacheKey = buildCompositeRBACCacheKey(subjectId, tenantId);
    const storeCacheAsync = async () => {
      try {
        const ttl = env ? await getRBACCacheTTL(env) : DEFAULT_RBAC_CACHE_TTL;
        await cache.put(cacheKey, JSON.stringify(compositeCache), { expirationTtl: ttl });
      } catch (err) {
        // PII Protection: Don't log full error object
        log.warn('Composite RBAC cache write error');
      }
    };
    void storeCacheAsync();
  }

  return compositeCache;
}

/**
 * Extract ID Token claims from Composite RBAC Cache
 *
 * @param compositeCache - Pre-fetched composite RBAC cache
 * @param claimsConfig - Optional comma-separated list of claims to include
 * @returns Claims for ID Token
 */
export function extractIDTokenClaimsFromCache(
  compositeCache: CompositeRBACCache,
  claimsConfig?: string
): Partial<RBACTokenClaims> {
  const enabledClaims = parseClaimsConfig<IDTokenClaimKey>(claimsConfig, DEFAULT_ID_TOKEN_CLAIMS);

  // "none" returns empty claims immediately
  if (enabledClaims.length === 0) {
    return {};
  }

  const claims: Partial<RBACTokenClaims> = {};

  if (enabledClaims.includes('roles') && compositeCache.roles.length > 0) {
    claims.authrim_roles = compositeCache.roles;
  }

  if (enabledClaims.includes('scoped_roles') && compositeCache.scoped_roles.length > 0) {
    claims.authrim_scoped_roles = compositeCache.scoped_roles;
  }

  if (enabledClaims.includes('user_type')) {
    claims.authrim_user_type = compositeCache.user_type;
  }

  if (enabledClaims.includes('org_id') && compositeCache.org_id) {
    claims.authrim_org_id = compositeCache.org_id;
  }

  if (enabledClaims.includes('org_name') && compositeCache.org_name) {
    claims.authrim_org_name = compositeCache.org_name;
  }

  if (enabledClaims.includes('plan') && compositeCache.plan) {
    claims.authrim_plan = compositeCache.plan;
  }

  if (enabledClaims.includes('org_type') && compositeCache.org_type) {
    claims.authrim_org_type = compositeCache.org_type;
  }

  if (enabledClaims.includes('orgs') && compositeCache.organizations.length > 0) {
    claims.authrim_orgs = compositeCache.organizations;
  }

  if (enabledClaims.includes('relationships_summary')) {
    const rs = compositeCache.relationships_summary;
    if (rs.children_ids.length > 0 || rs.parent_ids.length > 0) {
      claims.authrim_relationships_summary = rs;
    }
  }

  return claims;
}

/**
 * Extract Access Token claims from Composite RBAC Cache
 *
 * @param compositeCache - Pre-fetched composite RBAC cache
 * @param claimsConfig - Optional comma-separated list of claims to include
 * @returns Claims for Access Token
 */
export function extractAccessTokenClaimsFromCache(
  compositeCache: CompositeRBACCache,
  claimsConfig?: string
): Partial<RBACTokenClaims> {
  const enabledClaims = parseClaimsConfig<AccessTokenClaimKey>(
    claimsConfig,
    DEFAULT_ACCESS_TOKEN_CLAIMS
  );

  // "none" returns empty claims immediately
  if (enabledClaims.length === 0) {
    return {};
  }

  const claims: Partial<RBACTokenClaims> = {};

  if (enabledClaims.includes('roles') && compositeCache.roles.length > 0) {
    claims.authrim_roles = compositeCache.roles;
  }

  if (enabledClaims.includes('scoped_roles') && compositeCache.scoped_roles.length > 0) {
    claims.authrim_scoped_roles = compositeCache.scoped_roles;
  }

  if (enabledClaims.includes('org_id') && compositeCache.org_id) {
    claims.authrim_org_id = compositeCache.org_id;
  }

  if (enabledClaims.includes('org_type') && compositeCache.org_type) {
    claims.authrim_org_type = compositeCache.org_type;
  }

  if (enabledClaims.includes('permissions') && compositeCache.permissions.length > 0) {
    claims.authrim_permissions = compositeCache.permissions;
  }

  // org_context is not populated here - it requires request context (acting_as parameter)

  return claims;
}
/**
 * Resolved organization information
 */
interface ResolvedOrgInfo {
  org_id: string;
  plan: PlanType;
  org_type: OrganizationType;
}

/**
 * One subject's roles and active organisations, each read at most once per claim set.
 * Roles are read from the account database and named by the metadata database
 * (see services/tenant-rbac.ts); a claim set asks for several views of the same rows.
 */
interface SubjectRBACData {
  roles(): Promise<ResolvedSubjectRole[]>;
  organizations(): Promise<ResolvedSubjectOrganization[]>;
}

function subjectRBACData(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): SubjectRBACData {
  let roles: Promise<ResolvedSubjectRole[]> | undefined;
  let organizations: Promise<ResolvedSubjectOrganization[]> | undefined;
  return {
    roles: () => (roles ??= resolveSubjectRoles(dbs, tenantId, subjectId)),
    organizations: () =>
      (organizations ??= resolveSubjectOrganizations(dbs, tenantId, subjectId, {
        activeOnly: true,
      })),
  };
}

function roleNames(roles: ResolvedSubjectRole[]): string[] {
  return [...new Set(roles.map(({ role }) => role.name))];
}

function scopedRoles(roles: ResolvedSubjectRole[]): TokenScopedRole[] {
  return roles.map(({ role, assignment }) => ({
    name: role.name,
    scope: assignment.scope_type as ScopeType,
    ...(assignment.scope_target && { scopeTarget: assignment.scope_target }),
  }));
}

function grantedPermissions(roles: ResolvedSubjectRole[]): string[] {
  return [...new Set(roles.flatMap(({ role }) => rolePermissions(role)))].sort();
}

function primaryOrganization(
  organizations: ResolvedSubjectOrganization[]
): ResolvedSubjectOrganization | null {
  return organizations.find(({ membership }) => isSet(membership.is_primary)) ?? null;
}

function organizationInfo(organizations: ResolvedSubjectOrganization[]): ResolvedOrgInfo | null {
  const primary = primaryOrganization(organizations);
  return primary
    ? {
        org_id: primary.organization.id,
        plan: primary.organization.plan as PlanType,
        org_type: primary.organization.org_type as OrganizationType,
      }
    : null;
}

function organizationList(organizations: ResolvedSubjectOrganization[]): TokenOrgInfo[] {
  return organizations.map(({ organization, membership }) => ({
    id: organization.id,
    name: organization.name,
    type: organization.org_type as OrganizationType,
    is_primary: isSet(membership.is_primary),
  }));
}

/**
 * Get user's effective roles from role_assignments
 *
 * Returns distinct role names that are:
 * 1. Assigned to the user
 * 2. Not expired
 * 3. Any scope (global, org, resource)
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Array of role names
 */
export async function resolveEffectiveRoles(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<string[]> {
  return roleNames(await resolveSubjectRoles(dbs, tenantId, subjectId));
}

/**
 * Get user's primary organization information
 *
 * Returns the primary organization for the user based on
 * subject_org_membership.is_primary = 1.
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Organization info or null if no primary org
 */
export async function resolveOrganizationInfo(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<ResolvedOrgInfo | null> {
  return organizationInfo(await subjectRBACData(dbs, subjectId, tenantId).organizations());
}

/**
 * Get user's runtime type from canonical identity accounts.
 *
 * @param account - The subject's account database
 */
export async function resolveUserType(
  account: DatabaseSource,
  subjectId: string,
  tenantId: string
): Promise<UserType> {
  const result = await getRBACDatabaseAdapter(account).queryOne<{ account_type: string }>(
    'SELECT account_type FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
    [subjectId, tenantId]
  );

  if (result?.account_type === 'admin') return 'system_admin';
  if (result?.account_type === 'service_account') return 'end_user';
  // Guest registration is exposed through account:lifecycle:read, not the subject type.
  return 'end_user';
}

/**
 * Get all RBAC claims for a user
 *
 * This is the main function to call when generating tokens.
 * Returns all RBAC-related claims with authrim_ prefix.
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param tenantId - Tenant ID
 * @returns RBACTokenClaims object
 *
 * @example
 * ```typescript
 * const rbacClaims = await getUserRBACClaims({ metadata, account }, userId, tenantId);
 * // Result:
 * // {
 * //   authrim_roles: ['end_user', 'org_admin'],
 * //   authrim_user_type: 'enterprise_admin',
 * //   authrim_org_id: 'org_123',
 * //   authrim_plan: 'professional',
 * //   authrim_org_type: 'enterprise'
 * // }
 * ```
 */
export async function getUserRBACClaims(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<RBACTokenClaims> {
  const data = subjectRBACData(dbs, subjectId, tenantId);
  // Fetch all RBAC info in parallel
  const [roles, organizations, userType] = await Promise.all([
    data.roles(),
    data.organizations(),
    resolveUserType(dbs.account, subjectId, tenantId),
  ]);
  const names = roleNames(roles);
  const orgInfo = organizationInfo(organizations);

  const claims: RBACTokenClaims = {};

  // Add roles if any exist
  if (names.length > 0) {
    claims.authrim_roles = names;
  }

  // Add user type
  claims.authrim_user_type = userType;

  // Add organization info if user has a primary org
  if (orgInfo) {
    claims.authrim_org_id = orgInfo.org_id;
    claims.authrim_plan = orgInfo.plan;
    claims.authrim_org_type = orgInfo.org_type;
  }

  return claims;
}

/**
 * Get RBAC claims for ID Token (with optional caching)
 *
 * ID Token includes all RBAC claims:
 * - authrim_roles
 * - authrim_user_type
 * - authrim_org_id
 * - authrim_plan
 *
 * When claimsConfig is provided, it controls which claims are included.
 * Available claims: roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
 *
 * Caching: When cache (REBAC_CACHE KV) is provided, claims are cached for 5 minutes.
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param claimsConfigOrOptions - Claims config string OR options object with cache
 * @returns Claims for ID Token
 */
export async function getIDTokenRBACClaims(
  dbs: TenantRBACDatabases,
  subjectId: string,
  claimsConfigOrOptions?: string | RBACClaimsOptions
): Promise<Partial<RBACTokenClaims>> {
  // Parse options
  const options: Partial<RBACClaimsOptions> =
    typeof claimsConfigOrOptions === 'string'
      ? { claimsConfig: claimsConfigOrOptions }
      : claimsConfigOrOptions || {};

  const { cache, claimsConfig } = options;
  const tenantId = requireTenantId(options.tenantId, 'RBAC claims');

  // Try cache first
  if (cache) {
    const cacheKey = buildRBACCacheKey(subjectId, 'id', claimsConfig, tenantId);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as Partial<RBACTokenClaims>;
      }
    } catch (error) {
      // PII Protection: Don't log full error object
      log.warn('RBAC cache read error (ID token)');
    }
  }

  // Cache miss - fetch from D1
  let claims: Partial<RBACTokenClaims>;
  if (claimsConfig !== undefined) {
    claims = await getIDTokenRBACClaimsConfigurable(dbs, subjectId, claimsConfig, tenantId);
  } else {
    claims = await getUserRBACClaims(dbs, subjectId, tenantId);
  }

  // Store in cache (fire-and-forget with dynamic TTL)
  if (cache) {
    const cacheKey = buildRBACCacheKey(subjectId, 'id', claimsConfig, tenantId);
    const storeCacheAsync = async () => {
      try {
        const ttl = options.env ? await getRBACCacheTTL(options.env) : DEFAULT_RBAC_CACHE_TTL;
        await cache.put(cacheKey, JSON.stringify(claims), { expirationTtl: ttl });
      } catch (err) {
        // PII Protection: Don't log full error object
        log.warn('RBAC cache write error (ID token)');
      }
    };
    void storeCacheAsync();
  }

  return claims;
}

/**
 * Get RBAC claims for Access Token (with optional caching)
 *
 * Access Token includes:
 * - authrim_roles
 * - authrim_org_id
 * - authrim_org_type
 *
 * Note: user_type and plan are omitted from access token
 * as they are primarily for client-side display purposes.
 *
 * Caching: When cache (REBAC_CACHE KV) is provided, claims are cached for 5 minutes.
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param claimsConfigOrOptions - Claims config string OR options object with cache
 * @returns Claims for Access Token
 */
export async function getAccessTokenRBACClaims(
  dbs: TenantRBACDatabases,
  subjectId: string,
  claimsConfigOrOptions?: string | RBACClaimsOptions
): Promise<Partial<RBACTokenClaims>> {
  // Parse options
  const options: Partial<RBACClaimsOptions> =
    typeof claimsConfigOrOptions === 'string'
      ? { claimsConfig: claimsConfigOrOptions }
      : claimsConfigOrOptions || {};

  const { cache, claimsConfig } = options;
  const tenantId = requireTenantId(options.tenantId, 'RBAC claims');

  // Try cache first
  if (cache) {
    const cacheKey = buildRBACCacheKey(subjectId, 'access', claimsConfig, tenantId);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as Partial<RBACTokenClaims>;
      }
    } catch (error) {
      // PII Protection: Don't log full error object
      log.warn('RBAC cache read error (access token)');
    }
  }

  // Cache miss - fetch from D1
  const claims = await getAccessTokenRBACClaimsInternal(dbs, subjectId, claimsConfig, tenantId);

  // Store in cache (fire-and-forget with dynamic TTL)
  if (cache) {
    const cacheKey = buildRBACCacheKey(subjectId, 'access', claimsConfig, tenantId);
    const storeCacheAsync = async () => {
      try {
        const ttl = options.env ? await getRBACCacheTTL(options.env) : DEFAULT_RBAC_CACHE_TTL;
        await cache.put(cacheKey, JSON.stringify(claims), { expirationTtl: ttl });
      } catch (err) {
        // PII Protection: Don't log full error object
        log.warn('RBAC cache write error (access token)');
      }
    };
    void storeCacheAsync();
  }

  return claims;
}

/**
 * Internal function to fetch access token RBAC claims from D1 (no caching)
 */
async function getAccessTokenRBACClaimsInternal(
  dbs: TenantRBACDatabases,
  subjectId: string,
  claimsConfig: string | undefined,
  tenantId: string
): Promise<Partial<RBACTokenClaims>> {
  const enabledClaims = parseClaimsConfig<AccessTokenClaimKey>(
    claimsConfig,
    DEFAULT_ACCESS_TOKEN_CLAIMS
  );

  const claims: Partial<RBACTokenClaims> = {};

  // Determine what data to fetch based on enabled claims
  const needsRoles = enabledClaims.includes('roles');
  const needsScopedRoles = enabledClaims.includes('scoped_roles');
  const needsOrgInfo = enabledClaims.includes('org_id') || enabledClaims.includes('org_type');
  const needsPermissions = enabledClaims.includes('permissions');

  // Fetch required data in parallel
  const data = subjectRBACData(dbs, subjectId, tenantId);
  const [roles, organizations] = await Promise.all([
    needsRoles || needsScopedRoles || needsPermissions ? data.roles() : Promise.resolve([]),
    needsOrgInfo ? data.organizations() : Promise.resolve([]),
  ]);
  const names = needsRoles ? roleNames(roles) : [];
  const scoped = needsScopedRoles ? scopedRoles(roles) : [];
  const orgInfo = needsOrgInfo ? organizationInfo(organizations) : null;
  const permissions = needsPermissions ? grantedPermissions(roles) : [];

  // Add claims based on configuration
  if (needsRoles && names.length > 0) {
    claims.authrim_roles = names;
  }

  if (needsScopedRoles && scoped.length > 0) {
    claims.authrim_scoped_roles = scoped;
  }

  if (orgInfo) {
    if (enabledClaims.includes('org_id')) {
      claims.authrim_org_id = orgInfo.org_id;
    }
    if (enabledClaims.includes('org_type')) {
      claims.authrim_org_type = orgInfo.org_type;
    }
  }

  if (needsPermissions && permissions.length > 0) {
    claims.authrim_permissions = permissions;
  }

  // org_context is not populated here - it requires request context (acting_as parameter)
  // This will be handled at the token endpoint level

  return claims;
}

// =============================================================================
// Phase 2: Additional Data Resolution Functions
// =============================================================================

/**
 * Get user's scoped roles with full scope information
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Array of scoped roles
 */
export async function resolveScopedRoles(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<TokenScopedRole[]> {
  return scopedRoles(await resolveSubjectRoles(dbs, tenantId, subjectId));
}

/**
 * Get all organizations the user belongs to
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Array of organization info
 */
export async function resolveAllOrganizations(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<TokenOrgInfo[]> {
  return organizationList(await subjectRBACData(dbs, subjectId, tenantId).organizations());
}

/**
 * Get relationships summary (parent/child IDs)
 *
 * @param account - The subject's account database
 * @param subjectId - User ID
 * @returns Relationships summary
 */
export async function resolveRelationshipsSummary(
  account: DatabaseSource,
  subjectId: string,
  tenantId: string
): Promise<RelationshipsSummary> {
  const now = Math.floor(Date.now() / 1000);

  // Fetch parent_child relationships where user is parent or child
  const rows = await getRBACDatabaseAdapter(account).query<{
    relationship_type: string;
    from_id: string;
    to_id: string;
  }>(
    `SELECT relationship_type, from_id, to_id
       FROM relationships
       WHERE (from_id = ? OR to_id = ?)
         AND tenant_id = ?
         AND relationship_type = 'parent_child'
         AND (expires_at IS NULL OR expires_at > ?)`,
    [subjectId, subjectId, tenantId, now]
  );

  const childrenIds: string[] = [];
  const parentIds: string[] = [];

  for (const r of rows) {
    if (r.from_id === subjectId) {
      // User is the parent
      childrenIds.push(r.to_id);
    } else {
      // User is the child
      parentIds.push(r.from_id);
    }
  }

  return {
    children_ids: childrenIds,
    parent_ids: parentIds,
  };
}

/**
 * Get resolved permissions from user's roles
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Array of permission strings
 */
export async function resolvePermissions(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<string[]> {
  return grantedPermissions(await resolveSubjectRoles(dbs, tenantId, subjectId));
}

/**
 * Get primary organization name
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @returns Organization name or null
 */
export async function resolveOrganizationName(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<string | null> {
  return (
    primaryOrganization(await subjectRBACData(dbs, subjectId, tenantId).organizations())
      ?.organization.name ?? null
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse comma-separated claims configuration string
 *
 * Special value "none" returns empty array to skip all RBAC queries.
 * This is useful for load testing where RBAC claims are not needed.
 *
 * @param config - Comma-separated claims string from environment variable
 *                 Use "none" to skip all RBAC claims
 * @param defaults - Default claims if config is not provided
 * @returns Array of enabled claim keys (empty array if config is "none")
 */
function parseClaimsConfig<T extends string>(config: string | undefined, defaults: T[]): T[] {
  // "none" skips all claims (for load testing)
  if (config === 'none') {
    return [];
  }

  if (!config || config.trim() === '') {
    return defaults;
  }

  return config
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as T[];
}

/**
 * Get RBAC claims for ID Token with environment variable control
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param claimsConfig - Optional comma-separated list of claims to include (env var)
 * @returns Claims for ID Token
 */
export async function getIDTokenRBACClaimsConfigurable(
  dbs: TenantRBACDatabases,
  subjectId: string,
  claimsConfig: string | undefined,
  tenantId: string
): Promise<Partial<RBACTokenClaims>> {
  const enabledClaims = parseClaimsConfig<IDTokenClaimKey>(claimsConfig, DEFAULT_ID_TOKEN_CLAIMS);

  const claims: Partial<RBACTokenClaims> = {};

  // Determine what data to fetch based on enabled claims
  const needsRoles = enabledClaims.includes('roles');
  const needsScopedRoles = enabledClaims.includes('scoped_roles');
  const needsUserType = enabledClaims.includes('user_type');
  const needsOrgId = enabledClaims.includes('org_id');
  const needsOrgName = enabledClaims.includes('org_name');
  const needsPlan = enabledClaims.includes('plan');
  const needsOrgType = enabledClaims.includes('org_type');
  const needsOrgs = enabledClaims.includes('orgs');
  const needsRelationships = enabledClaims.includes('relationships_summary');

  // Determine if we need basic org info
  const needsBasicOrgInfo = needsOrgId || needsPlan || needsOrgType;

  // Fetch required data in parallel
  const data = subjectRBACData(dbs, subjectId, tenantId);
  const [roles, organizations, userType, relationships] = await Promise.all([
    needsRoles || needsScopedRoles ? data.roles() : Promise.resolve([]),
    needsBasicOrgInfo || needsOrgName || needsOrgs ? data.organizations() : Promise.resolve([]),
    needsUserType
      ? resolveUserType(dbs.account, subjectId, tenantId)
      : Promise.resolve('end_user' as UserType),
    needsRelationships
      ? resolveRelationshipsSummary(dbs.account, subjectId, tenantId)
      : Promise.resolve({ children_ids: [], parent_ids: [] }),
  ]);
  const names = needsRoles ? roleNames(roles) : [];
  const scoped = needsScopedRoles ? scopedRoles(roles) : [];
  const orgInfo = needsBasicOrgInfo ? organizationInfo(organizations) : null;
  const orgName = needsOrgName
    ? (primaryOrganization(organizations)?.organization.name ?? null)
    : null;
  const orgs = needsOrgs ? organizationList(organizations) : [];

  // Add claims based on configuration
  if (needsRoles && names.length > 0) {
    claims.authrim_roles = names;
  }

  if (needsScopedRoles && scoped.length > 0) {
    claims.authrim_scoped_roles = scoped;
  }

  if (needsUserType) {
    claims.authrim_user_type = userType;
  }

  if (orgInfo) {
    if (needsOrgId) {
      claims.authrim_org_id = orgInfo.org_id;
    }
    if (needsPlan) {
      claims.authrim_plan = orgInfo.plan;
    }
    if (needsOrgType) {
      claims.authrim_org_type = orgInfo.org_type;
    }
  }

  if (needsOrgName && orgName) {
    claims.authrim_org_name = orgName;
  }

  if (needsOrgs && orgs.length > 0) {
    claims.authrim_orgs = orgs;
  }

  if (
    needsRelationships &&
    (relationships.children_ids.length > 0 || relationships.parent_ids.length > 0)
  ) {
    claims.authrim_relationships_summary = relationships;
  }

  return claims;
}

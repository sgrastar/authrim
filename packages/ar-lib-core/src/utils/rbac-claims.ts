/**
 * RBAC Claims Utility
 *
 * Utilities for retrieving RBAC information to include in tokens.
 * Part of RBAC Phase 1 & 2 implementation.
 *
 * Environment Variables:
 * - RBAC_ID_TOKEN_CLAIMS: Comma-separated list of claims to include in ID Token
 *   Default: "roles,groups,permissions,user_type"
 *   Available: roles,groups,permissions,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
 *
 * - RBAC_ACCESS_TOKEN_CLAIMS: Comma-separated list of claims to include in Access Token
 *   Default: "roles,groups"
 *   Available: roles,groups,scoped_roles,org_id,org_type,permissions,org_context
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

import {
  cachedRoleData,
  requireTenantId,
  buildRBACCacheKey,
  buildCompositeRBACCacheKey,
  type RBACClaimsOptions,
} from './rbac-cache';
export {
  invalidateSubjectRBACCache,
  bumpTenantRBACCacheVersion,
  getTenantRBACCacheVersion,
  getRBACCacheTTL,
  getRBACCacheVersion,
  type RBACClaimsOptions,
} from './rbac-cache';
import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import type {
  RBACTokenClaims,
  UserType,
  PlanType,
  OrganizationType,
  ScopeType,
  TokenOrgInfo,
  TokenScopedRole,
  TokenGroup,
  RelationshipsSummary,
  IDTokenClaimKey,
  AccessTokenClaimKey,
} from '../types/rbac';
import { DEFAULT_ID_TOKEN_CLAIMS, DEFAULT_ACCESS_TOKEN_CLAIMS } from '../types/rbac';
import {
  resolveSubjectOrganizations,
  resolveSubjectRoles,
  isSet,
  roleAssignmentHolds,
  rolePermissions,
  type ResolvedSubjectOrganization,
  type ResolvedSubjectRole,
  type TenantRBACDatabases,
} from '../services/tenant-rbac';
import { rbacIdBatches, resolveSubjectGroups } from '../services/group-membership';

function getRBACDatabaseAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'rbac-claims');
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
  groups: TokenGroup[];
  organizations: TokenOrgInfo[];
  user_type: UserType;
  plan: PlanType | null;
  org_id: string | null;
  org_name: string | null;
  org_type: OrganizationType | null;
  relationships_summary: RelationshipsSummary;
  cached_at: number; // Unix timestamp
}

export async function getCompositeRBACCache(
  dbs: TenantRBACDatabases,
  subjectId: string,
  options: Partial<RBACClaimsOptions> = {}
): Promise<CompositeRBACCache> {
  const tenantId = requireTenantId(options.tenantId, 'RBAC claims');
  return cachedRoleData(
    dbs,
    tenantId,
    subjectId,
    buildCompositeRBACCacheKey(subjectId, tenantId),
    options,
    async (version) => {
      const data = subjectRBACData(dbs, subjectId, tenantId);
      const [subjectRoles, subjectGroups, subjectOrganizations, userType, relationships] =
        await Promise.all([
          data.roles(),
          data.groups(),
          data.organizations(),
          resolveUserType(dbs.account, subjectId, tenantId),
          resolveRelationshipsSummary(dbs.account, subjectId, tenantId),
        ]);
      const orgInfo = organizationInfo(subjectOrganizations);

      return {
        version,
        roles: claimRoleNames(subjectRoles, tenantId),
        scoped_roles: scopedRoles(subjectRoles),
        permissions: grantedPermissions(subjectRoles, tenantId),
        groups: subjectGroups,
        organizations: organizationList(subjectOrganizations),
        user_type: userType,
        plan: orgInfo?.plan ?? null,
        org_id: orgInfo?.org_id ?? null,
        org_name: primaryOrganization(subjectOrganizations)?.organization.name ?? null,
        org_type: orgInfo?.org_type ?? null,
        relationships_summary: relationships,
        cached_at: Math.floor(Date.now() / 1000),
      };
    }
  );
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

  if (enabledClaims.includes('groups') && (compositeCache.groups?.length ?? 0) > 0) {
    claims.authrim_groups = compositeCache.groups;
  }

  if (enabledClaims.includes('permissions') && compositeCache.permissions.length > 0) {
    claims.authrim_permissions = compositeCache.permissions;
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

  if (enabledClaims.includes('groups') && (compositeCache.groups?.length ?? 0) > 0) {
    claims.authrim_groups = compositeCache.groups;
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
  groups(): Promise<TokenGroup[]>;
  organizations(): Promise<ResolvedSubjectOrganization[]>;
}

function subjectRBACData(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): SubjectRBACData {
  let roles: Promise<ResolvedSubjectRole[]> | undefined;
  let groups: Promise<TokenGroup[]> | undefined;
  let organizations: Promise<ResolvedSubjectOrganization[]> | undefined;
  return {
    roles: () => (roles ??= resolveSubjectRoles(dbs, tenantId, subjectId)),
    groups: () => (groups ??= resolveSubjectGroupClaims(dbs, tenantId, subjectId)),
    organizations: () =>
      (organizations ??= resolveSubjectOrganizations(dbs, tenantId, subjectId, {
        activeOnly: true,
      })),
  };
}

function roleNames(roles: ResolvedSubjectRole[]): string[] {
  return [...new Set(roles.map(({ role }) => role.name))];
}

/**
 * The flat role claim holds only roles whose assignment holds across the tenant (global, or tenant
 * in its own tenant), direct or through a group. A group- or resource-scoped assignment is only in
 * authrim_scoped_roles with its target, so a reader of the flat claim never widens it.
 */
function claimRoleNames(roles: ResolvedSubjectRole[], tenantId: string): string[] {
  return roleNames(
    roles.filter(({ assignment }) =>
      roleAssignmentHolds(
        { scope: assignment.scope_type, scopeTarget: assignment.scope_target },
        { tenantId }
      )
    )
  );
}

/**
 * The subject's effective groups (direct memberships and their ancestors, active only) as the
 * authrim_groups claim, ordered by key.
 */
export async function resolveSubjectGroupClaims(
  dbs: TenantRBACDatabases,
  tenantId: string,
  subjectId: string
): Promise<TokenGroup[]> {
  const { effectiveGroupIds } = await resolveSubjectGroups(
    dbs,
    tenantId,
    subjectId,
    Math.floor(Date.now() / 1000)
  );
  if (effectiveGroupIds.size === 0) return [];
  const db = getRBACDatabaseAdapter(dbs.metadata);
  const groups: TokenGroup[] = [];
  for (const batch of rbacIdBatches(effectiveGroupIds)) {
    const rows = await db.query<{
      id: string;
      group_key: string;
      display_name: string;
      kind: string;
    }>(
      `SELECT id, group_key, display_name, kind FROM "groups"
        WHERE tenant_id = ? AND lifecycle_state = 'active'
          AND id IN (${batch.map(() => '?').join(', ')})`,
      [tenantId, ...batch]
    );
    for (const row of rows) {
      groups.push({ id: row.id, key: row.group_key, name: row.display_name, kind: row.kind });
    }
  }
  return groups.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

function scopedRoles(roles: ResolvedSubjectRole[]): TokenScopedRole[] {
  const claims = new Map<string, TokenScopedRole>();
  for (const { role, assignment } of roles) {
    const claim = {
      name: role.name,
      scope: assignment.scope_type as ScopeType,
      ...(assignment.scope_target && { scopeTarget: assignment.scope_target }),
    };
    claims.set(JSON.stringify(claim), claim);
  }
  return [...claims.values()];
}

/**
 * The tenant-wide permissions of the subject's roles: only from assignments that hold across the
 * tenant (global, or tenant in its own tenant). A role assigned in one organisation or on one
 * resource gives its permissions there only, so not in a tenant-wide claim (its role is still in
 * authrim_scoped_roles with its scope).
 */
function grantedPermissions(roles: ResolvedSubjectRole[], tenantId: string): string[] {
  return [
    ...new Set(
      roles
        .filter(({ assignment }) =>
          roleAssignmentHolds(
            { scope: assignment.scope_type, scopeTarget: assignment.scope_target },
            { tenantId }
          )
        )
        .flatMap(({ role }) => rolePermissions(role))
    ),
  ].sort();
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

  if (result?.account_type === 'admin') return 'admin';
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
 * //   authrim_roles: ['end_user', 'billing_manager'],
 * //   authrim_user_type: 'end_user',
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
  const [roles, groups, organizations, userType] = await Promise.all([
    data.roles(),
    data.groups(),
    data.organizations(),
    resolveUserType(dbs.account, subjectId, tenantId),
  ]);
  const names = claimRoleNames(roles, tenantId);
  const orgInfo = organizationInfo(organizations);

  const claims: RBACTokenClaims = {};

  // Add roles if any exist
  if (names.length > 0) {
    claims.authrim_roles = names;
  }

  if (groups.length > 0) {
    claims.authrim_groups = groups;
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

  const { claimsConfig } = options;
  const tenantId = requireTenantId(options.tenantId, 'RBAC claims');
  return cachedRoleData(
    dbs,
    tenantId,
    subjectId,
    buildRBACCacheKey(subjectId, 'id', claimsConfig, tenantId),
    options,
    // One definition of the defaults: an unset config is the default claim list.
    () => getIDTokenRBACClaimsConfigurable(dbs, subjectId, claimsConfig, tenantId)
  );
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

  const { claimsConfig } = options;
  const tenantId = requireTenantId(options.tenantId, 'RBAC claims');
  return cachedRoleData(
    dbs,
    tenantId,
    subjectId,
    buildRBACCacheKey(subjectId, 'access', claimsConfig, tenantId),
    options,
    () => getAccessTokenRBACClaimsInternal(dbs, subjectId, claimsConfig, tenantId)
  );
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
  const needsGroups = enabledClaims.includes('groups');
  const needsScopedRoles = enabledClaims.includes('scoped_roles');
  const needsOrgInfo = enabledClaims.includes('org_id') || enabledClaims.includes('org_type');
  const needsPermissions = enabledClaims.includes('permissions');

  // Fetch required data in parallel
  const data = subjectRBACData(dbs, subjectId, tenantId);
  const [roles, groups, organizations] = await Promise.all([
    needsRoles || needsScopedRoles || needsPermissions ? data.roles() : Promise.resolve([]),
    needsGroups ? data.groups() : Promise.resolve([]),
    needsOrgInfo ? data.organizations() : Promise.resolve([]),
  ]);
  const names = needsRoles ? claimRoleNames(roles, tenantId) : [];
  const scoped = needsScopedRoles ? scopedRoles(roles) : [];
  const orgInfo = needsOrgInfo ? organizationInfo(organizations) : null;
  const permissions = needsPermissions ? grantedPermissions(roles, tenantId) : [];

  // Add claims based on configuration
  if (needsRoles && names.length > 0) {
    claims.authrim_roles = names;
  }

  if (needsGroups && groups.length > 0) {
    claims.authrim_groups = groups;
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
  return grantedPermissions(await resolveSubjectRoles(dbs, tenantId, subjectId), tenantId);
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
  const needsGroups = enabledClaims.includes('groups');
  const needsPermissions = enabledClaims.includes('permissions');
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
  const [roles, groups, organizations, userType, relationships] = await Promise.all([
    needsRoles || needsScopedRoles || needsPermissions ? data.roles() : Promise.resolve([]),
    needsGroups ? data.groups() : Promise.resolve([]),
    needsBasicOrgInfo || needsOrgName || needsOrgs ? data.organizations() : Promise.resolve([]),
    needsUserType
      ? resolveUserType(dbs.account, subjectId, tenantId)
      : Promise.resolve('end_user' as UserType),
    needsRelationships
      ? resolveRelationshipsSummary(dbs.account, subjectId, tenantId)
      : Promise.resolve({ children_ids: [], parent_ids: [] }),
  ]);
  const names = needsRoles ? claimRoleNames(roles, tenantId) : [];
  const scoped = needsScopedRoles ? scopedRoles(roles) : [];
  const permissions = needsPermissions ? grantedPermissions(roles, tenantId) : [];
  const orgInfo = needsBasicOrgInfo ? organizationInfo(organizations) : null;
  const orgName = needsOrgName
    ? (primaryOrganization(organizations)?.organization.name ?? null)
    : null;
  const orgs = needsOrgs ? organizationList(organizations) : [];

  // Add claims based on configuration
  if (needsRoles && names.length > 0) {
    claims.authrim_roles = names;
  }

  if (needsGroups && groups.length > 0) {
    claims.authrim_groups = groups;
  }

  if (needsPermissions && permissions.length > 0) {
    claims.authrim_permissions = permissions;
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

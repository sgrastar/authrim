/**
 * ID-Level Resource Permissions Utility
 *
 * Evaluates ID-level permissions (3-part format: resource:id:action)
 * in addition to type-level permissions (2-part: resource:action).
 *
 * Architecture:
 * - ID-level permissions are stored in resource_permissions table
 * - Type-level permissions come from role assignments
 * - Both can be embedded in access tokens
 *
 * Note: ID-level scope format is a non-standard OAuth 2.0 extension.
 * Standard-compliant clients should read from authrim_resource_permissions claim.
 *
 * @example
 * ```typescript
 * import { evaluateIdLevelPermissions, parseScopeWithIdLevel } from './resource-permissions';
 *
 * const result = parseScopeWithIdLevel('documents:read documents:doc_123:write');
 * // result.typeLevel: ['documents:read']
 * // result.idLevel: [{ resource: 'documents', id: 'doc_123', action: 'write' }]
 *
 * const permissions = await evaluateIdLevelPermissions({ metadata, account }, subjectId, tenantId, {
 *   cache: env.REBAC_CACHE,
 * });
 * // Returns: ['documents:doc_123:read', 'documents:doc_456:write']
 * ```
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { ensureDatabaseAdapter } from '../db';
import {
  resolveSubjectRoles,
  roleAssignmentHolds,
  type RoleAssignmentTarget,
  type TenantRBACDatabases,
} from '../services/tenant-rbac';

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}
import {
  resolveEffectiveSettingsWithSources,
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from '../services/effective-settings';
import type {
  ResourcePermission,
  ResourcePermissionRow,
  TokenEmbeddingLimits,
} from '../types/token-claim-rules';

// =============================================================================
// Scope Parsing
// =============================================================================

/**
 * Parsed ID-level scope
 */
export interface IdLevelScope {
  /** Resource type (e.g., "documents") */
  resource: string;
  /** Resource ID (e.g., "doc_123") */
  id: string;
  /** Action name (e.g., "read") */
  action: string;
  /** Original scope string (e.g., "documents:doc_123:read") */
  original: string;
}

/**
 * Parsed scope result separating type-level and ID-level scopes
 */
export interface ParsedScopeResult {
  /** Type-level scopes (2-part: resource:action) */
  typeLevel: string[];
  /** ID-level scopes (3-part: resource:id:action) */
  idLevel: IdLevelScope[];
  /** Standard OIDC scopes (openid, profile, etc.) */
  standard: string[];
}

/**
 * Standard OIDC scopes that should not be treated as permissions
 */
const STANDARD_SCOPES = new Set([
  'openid',
  'profile',
  'email',
  'address',
  'phone',
  'offline_access',
]);

/**
 * Parse scope string separating type-level and ID-level permissions
 *
 * Format:
 * - Type-level (2-part): resource:action (e.g., "documents:read")
 * - ID-level (3-part): resource:id:action (e.g., "documents:doc_123:read")
 *
 * @param scope - Space-separated scope string
 * @returns Parsed scope result with type-level and ID-level separated
 */
export function parseScopeWithIdLevel(scope: string): ParsedScopeResult {
  const result: ParsedScopeResult = {
    typeLevel: [],
    idLevel: [],
    standard: [],
  };

  if (!scope || scope.trim() === '') {
    return result;
  }

  const scopes = scope.split(/\s+/).filter(Boolean);

  for (const s of scopes) {
    // Check for standard OIDC scopes
    if (STANDARD_SCOPES.has(s.toLowerCase())) {
      result.standard.push(s);
      continue;
    }

    // Split by colon
    const parts = s.split(':');

    if (parts.length === 2) {
      // Type-level: resource:action
      result.typeLevel.push(s);
    } else if (parts.length === 3) {
      // ID-level: resource:id:action
      result.idLevel.push({
        resource: parts[0],
        id: parts[1],
        action: parts[2],
        original: s,
      });
    }
    // Scopes with other formats are ignored
  }

  return result;
}

/**
 * Format ID-level permission to scope string
 */
export function formatIdLevelPermission(resource: string, id: string, action: string): string {
  return `${resource}:${id}:${action}`;
}

// =============================================================================
// Permission Evaluation
// =============================================================================

/**
 * Cache key prefix for ID-level permissions
 */
// v2: a role's grants only for resources its assignment covers. Entries computed before are not
// read (they expire on their own).
const ID_PERMISSION_CACHE_PREFIX = 'policy:idperms:v2:';

/**
 * Convert database row to ResourcePermission object
 */
function rowToResourcePermission(row: ResourcePermissionRow): ResourcePermission {
  return {
    ...row,
    actions: JSON.parse(row.actions_json) as string[],
    condition: row.condition_json ? JSON.parse(row.condition_json) : undefined,
    is_active: row.is_active === 1,
    expires_at: row.expires_at ?? undefined,
  };
}

// D1 binds at most 100 parameters per statement.
const ROLE_SUBJECT_BATCH_SIZE = 80;

interface SubjectGrants {
  /** One or more SQL conditions for the rows granted to the subject or one of its roles. */
  clauses: { sql: string; params: string[] }[];
  /** Whether a row granted to a role holds for its resource, by the role's assignments. */
  holds(row: { subject_type: string; subject_id: string } & RoleAssignmentTarget): boolean;
}

/**
 * Who the subject's `resource_permissions` rows are granted to: the subject itself and each of
 * its roles, as one or more SQL conditions (one per batch of role ids). The grants are tenant
 * settings (metadata database); which roles the subject has is account data (account database),
 * so the role ids are read first and passed in. A row granted to a role counts only for a
 * resource one of the role's assignments holds for (an assignment limited to an organisation
 * holds only when the resource's organisation is known, `orgId`).
 */
async function subjectGrants(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string,
  now: number,
  orgId?: string
): Promise<SubjectGrants> {
  // Roles of the tenant only: an assignment of a role it does not have grants nothing.
  const assignments = new Map<string, { scope: string; scopeTarget: string }[]>();
  for (const { role, assignment } of await resolveSubjectRoles(dbs, tenantId, subjectId, now)) {
    assignments.set(role.id, [
      ...(assignments.get(role.id) ?? []),
      { scope: assignment.scope_type, scopeTarget: assignment.scope_target },
    ]);
  }
  const roleIds = [...assignments.keys()];
  const clauses = [{ sql: `(subject_type = 'user' AND subject_id = ?)`, params: [subjectId] }];
  for (let offset = 0; offset < roleIds.length; offset += ROLE_SUBJECT_BATCH_SIZE) {
    const batch = roleIds.slice(offset, offset + ROLE_SUBJECT_BATCH_SIZE);
    clauses.push({
      sql: `(subject_type = 'role' AND subject_id IN (${batch.map(() => '?').join(', ')}))`,
      params: batch,
    });
  }
  return {
    clauses,
    holds: (row) =>
      row.subject_type !== 'role' ||
      (assignments.get(row.subject_id) ?? []).some((assignment) =>
        roleAssignmentHolds(assignment, {
          tenantId,
          orgId,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
        })
      ),
  };
}

/**
 * Get ID-level permissions for a user from database
 *
 * Queries resource_permissions table for all active permissions
 * granted to the user (directly or through roles/orgs).
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param tenantId - Tenant ID
 * @returns Array of ResourcePermission objects
 */
export async function getUserIdLevelPermissions(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string
): Promise<ResourcePermission[]> {
  const normalizedTenantId = requireTenantId(tenantId, 'getUserIdLevelPermissions');
  const now = Math.floor(Date.now() / 1000);

  // Query for direct user permissions and role-based permissions
  const adapter = ensureDatabaseAdapter(dbs.metadata, 'resource-permissions');
  const rows = new Map<string, ResourcePermissionRow>();
  const grants = await subjectGrants(dbs, subjectId, normalizedTenantId, now);
  for (const grantedTo of grants.clauses) {
    const batch = await adapter.query<ResourcePermissionRow>(
      `SELECT *
         FROM resource_permissions
         WHERE tenant_id = ?
           AND is_active = 1
           AND (expires_at IS NULL OR expires_at > ?)
           AND ${grantedTo.sql}`,
      [normalizedTenantId, now, ...grantedTo.params]
    );
    for (const row of batch) {
      if (
        grants.holds({
          subject_type: row.subject_type,
          subject_id: row.subject_id,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
        })
      ) {
        rows.set(row.id, row);
      }
    }
  }

  return [...rows.values()]
    .sort(
      (left, right) =>
        compareText(left.resource_type, right.resource_type) ||
        compareText(left.resource_id, right.resource_id)
    )
    .map(rowToResourcePermission);
}

/**
 * Evaluate ID-level permissions for a user
 *
 * Returns all ID-level permissions the user has as scope strings.
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param tenantId - Tenant ID
 * @param options - Evaluation options
 * @returns Array of ID-level permission strings (e.g., "documents:doc_123:read")
 */
export async function evaluateIdLevelPermissions(
  dbs: TenantRBACDatabases,
  subjectId: string,
  tenantId: string,
  options: {
    cache?: KVNamespace;
    cacheTTL?: number;
  } = {}
): Promise<string[]> {
  const normalizedTenantId = requireTenantId(tenantId, 'evaluateIdLevelPermissions');
  // Try cache first
  const cacheKey = options.cache
    ? `${ID_PERMISSION_CACHE_PREFIX}${normalizedTenantId}:${subjectId}`
    : null;

  if (cacheKey && options.cache) {
    const cached = await options.cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as string[];
      } catch {
        // Cache is corrupted, fetch fresh
      }
    }
  }

  // Fetch from database
  const permissions = await getUserIdLevelPermissions(dbs, subjectId, normalizedTenantId);

  // Format as scope strings
  const permissionStrings: string[] = [];
  for (const perm of permissions) {
    for (const action of perm.actions) {
      permissionStrings.push(formatIdLevelPermission(perm.resource_type, perm.resource_id, action));
    }
  }

  // Cache the result
  if (cacheKey && options.cache) {
    const ttl = options.cacheTTL ?? 300;
    await options.cache.put(cacheKey, JSON.stringify(permissionStrings), {
      expirationTtl: ttl,
    });
  }

  return permissionStrings;
}

/**
 * Check if user has a specific ID-level permission
 *
 * @param dbs - The tenant's metadata and the subject's account database
 * @param subjectId - User ID
 * @param resource - Resource type
 * @param resourceId - Resource ID
 * @param action - Action name
 * @param tenantId - Tenant ID
 * @param options - orgId: the organisation the resource belongs to, when known
 * @returns true if user has the permission
 */
export async function hasIdLevelPermission(
  dbs: TenantRBACDatabases,
  subjectId: string,
  resource: string,
  resourceId: string,
  action: string,
  tenantId: string,
  options: { orgId?: string } = {}
): Promise<boolean> {
  const normalizedTenantId = requireTenantId(tenantId, 'ID-level permission check');
  const now = Math.floor(Date.now() / 1000);
  const adapter = ensureDatabaseAdapter(dbs.metadata, 'resource-permissions');
  const fullResult: { actions_json: string }[] = [];
  const grants = await subjectGrants(dbs, subjectId, normalizedTenantId, now, options.orgId);
  for (const grantedTo of grants.clauses) {
    const rows = await adapter.query<{
      actions_json: string;
      subject_type: string;
      subject_id: string;
    }>(
      `SELECT actions_json, subject_type, subject_id
           FROM resource_permissions
           WHERE tenant_id = ?
             AND resource_type = ?
             AND resource_id = ?
             AND is_active = 1
             AND (expires_at IS NULL OR expires_at > ?)
             AND ${grantedTo.sql}`,
      [normalizedTenantId, resource, resourceId, now, ...grantedTo.params]
    );
    fullResult.push(
      ...rows.filter((row) =>
        grants.holds({ ...row, resourceType: resource, resourceId: resourceId })
      )
    );
  }

  // Check if the action is in the actions_json
  for (const row of fullResult) {
    try {
      const actions = JSON.parse(row.actions_json) as string[];
      if (actions.includes(action) || actions.includes('*')) {
        return true;
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return false;
}

// =============================================================================
// Feature Flags
// =============================================================================

/**
 * A token issuance switch for a tenant (`feature.*`, as the Settings API resolves it: tenant,
 * platform, env, default). Off when it cannot be read: env does not turn on what a saved value
 * may have turned off.
 */
async function tokenFeatureEnabled(
  env: EffectiveSettingsEnv,
  tenantId: string | undefined,
  key: string
): Promise<boolean> {
  try {
    const { values } = tenantId
      ? await resolveEffectiveSettingsWithSources(env, 'feature-flags', { tenantId })
      : await resolvePlatformSettingsWithSources(env, 'feature-flags', {});
    return values[key] === true;
  } catch {
    return false;
  }
}

/** Whether the token claim rules add claims to access tokens (`feature.enable_custom_claims`). */
export async function isCustomClaimsEnabled(
  env: EffectiveSettingsEnv & { ENABLE_CUSTOM_CLAIMS?: string },
  tenantId?: string
): Promise<boolean> {
  return tokenFeatureEnabled(env, tenantId, 'feature.enable_custom_claims');
}

/** Whether ID-level permissions are embedded (`feature.enable_id_level_permissions`). */
export async function isIdLevelPermissionsEnabled(
  env: EffectiveSettingsEnv & { ENABLE_ID_LEVEL_PERMISSIONS?: string },
  tenantId?: string
): Promise<boolean> {
  return tokenFeatureEnabled(env, tenantId, 'feature.enable_id_level_permissions');
}

/**
 * Token embedding limits for a tenant: `limits.max_*` as the Settings API resolves them (tenant,
 * else platform, else the environment variables, else defaults).
 * Without a tenant, the platform's values. The defaults when the settings cannot be read.
 */
export async function getEmbeddingLimits(
  env: EffectiveSettingsEnv,
  tenantId?: string
): Promise<TokenEmbeddingLimits> {
  const limits: TokenEmbeddingLimits = {
    max_embedded_permissions: 50,
    max_resource_permissions: 100,
    max_custom_claims: 20,
  };
  try {
    const { values } = tenantId
      ? await resolveEffectiveSettingsWithSources(env, 'limits', {
          tenantId,
        })
      : await resolvePlatformSettingsWithSources(env, 'limits', {});
    for (const name of Object.keys(limits) as Array<keyof TokenEmbeddingLimits>) {
      const value = values[`limits.${name}`];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        limits[name] = value;
      }
    }
  } catch {
    // Keep the defaults.
  }
  return limits;
}

// =============================================================================
// Cache Invalidation
// =============================================================================

/**
 * Invalidate ID-level permission cache for a user
 *
 * Call this when user's permissions change.
 *
 * @param cache - KV namespace for caching
 * @param subjectId - User ID
 * @param tenantId - Tenant ID
 */
export async function invalidateIdPermissionCache(
  cache: KVNamespace,
  subjectId: string,
  tenantId: string
): Promise<void> {
  const cacheKey = `${ID_PERMISSION_CACHE_PREFIX}${requireTenantId(
    tenantId,
    'invalidateIdPermissionCache'
  )}:${subjectId}`;
  await cache.delete(cacheKey);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Policy Embedding Utility
 *
 * Evaluates requested scopes against policy rules and returns
 * only the permitted actions to embed in Access Token.
 *
 * @example
 * ```typescript
 * import { evaluatePermissionsForScope } from './policy-embedding';
 *
 * const permissions = await evaluatePermissionsForScope(
 *   db,
 *   subjectId,
 *   'openid profile documents:read documents:write users:manage',
 *   { cache: env.REBAC_CACHE }
 * );
 * // Returns: ['documents:read', 'documents:write'] if user has those permissions
 * ```
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import type { ScopeType } from '../types/rbac';

/**
 * Standard OIDC scopes that should not be treated as resource:action permissions
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
 * Parsed scope action
 */
export interface ScopeAction {
  /** Resource type (e.g., "documents", "users") */
  resource: string;
  /** Action name (e.g., "read", "write", "manage") */
  action: string;
  /** Original scope string (e.g., "documents:read") */
  original: string;
}

export interface ScopedPolicyPermission {
  permission: string;
  scope_type: Exclude<ScopeType, 'global'>;
  scope_target: string;
}

export interface PolicyPermissionEmbedding {
  permissions: string[];
  scopedPermissions: ScopedPolicyPermission[];
}

interface UserPermissionGrant {
  permission: string;
  scopeType: ScopeType;
  scopeTarget: string;
}

/**
 * Options for permission evaluation
 */
export interface PolicyEmbeddingOptions {
  /** KV namespace for caching (optional) */
  cache?: KVNamespace;
  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  cacheTTL?: number;
  /** Tenant ID for multi-tenant isolation */
  tenantId: string;
}

/**
 * Role-permission mapping cache key prefix
 */
const PERMISSION_CACHE_PREFIX = 'policy:perms:v2:';

/**
 * Parse scope string into resource:action pairs
 *
 * Standard OIDC scopes (openid, profile, email, etc.) are filtered out.
 * Only scopes in {resource}:{action} format are returned.
 *
 * @param scope - Space-separated scope string
 * @returns Array of parsed scope actions
 *
 * @example
 * parseScopeToActions('openid profile documents:read users:manage')
 * // Returns: [
 * //   { resource: 'documents', action: 'read', original: 'documents:read' },
 * //   { resource: 'users', action: 'manage', original: 'users:manage' }
 * // ]
 */
export function parseScopeToActions(scope: string): ScopeAction[] {
  if (!scope || scope.trim() === '') {
    return [];
  }

  const actions: ScopeAction[] = [];
  const scopes = scope.split(/\s+/).filter(Boolean);

  for (const s of scopes) {
    // Skip standard OIDC scopes
    if (STANDARD_SCOPES.has(s.toLowerCase())) {
      continue;
    }

    // Parse resource:action format
    const colonIndex = s.indexOf(':');
    if (colonIndex > 0 && colonIndex < s.length - 1) {
      actions.push({
        resource: s.substring(0, colonIndex),
        action: s.substring(colonIndex + 1),
        original: s,
      });
    }
    // If no colon, skip (not a valid resource:action format)
  }

  return actions;
}

/**
 * Get user's permissions from their roles
 *
 * Queries role_assignments and roles tables to get all permissions
 * associated with the user's active roles.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @returns Set of permission strings (e.g., "documents:read")
 */
async function getUserPermissionGrantsFromRoles(
  db: DatabaseSource,
  subjectId: string,
  tenantId: string
): Promise<UserPermissionGrant[]> {
  const now = Math.floor(Date.now() / 1000);

  // Get permissions from all active roles
  const rows = await ensureDatabaseAdapter(db, 'policy-embedding').query<{
    permissions_json: string;
    scope_type: ScopeType | null;
    scope_target: string | null;
  }>(
    `SELECT r.permissions_json, ra.scope_type, ra.scope_target
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND ra.tenant_id = ?
         AND r.tenant_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
         AND r.permissions_json IS NOT NULL
         AND r.permissions_json != '[]'`,
    [subjectId, tenantId, tenantId, now]
  );

  const grants: UserPermissionGrant[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    try {
      const perms = JSON.parse(r.permissions_json) as string[];
      for (const p of perms) {
        const scopeType = r.scope_type ?? 'global';
        const scopeTarget = r.scope_target ?? '';
        const key = `${p}\u0000${scopeType}\u0000${scopeTarget}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        grants.push({ permission: p, scopeType, scopeTarget });
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return grants;
}

function permissionMatches(grantPermission: string, action: ScopeAction): boolean {
  if (grantPermission === action.original) {
    return true;
  }
  if (grantPermission === `${action.resource}:*`) {
    return true;
  }
  if (grantPermission === `*:${action.action}`) {
    return true;
  }
  return grantPermission === '*:*';
}

function isTenantWideGrant(grant: UserPermissionGrant): boolean {
  return grant.scopeType === 'global' || !grant.scopeTarget;
}

/**
 * Evaluate requested scopes against user's permissions
 *
 * This is the main function for policy embedding. It:
 * 1. Parses the scope string to extract resource:action pairs
 * 2. Gets the user's permissions from their roles
 * 3. Returns only the scopes that match the user's permissions
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param scope - Requested scope string (space-separated)
 * @param options - Evaluation options
 * @returns Array of permitted scope strings
 *
 * @example
 * // User has roles that grant: ['documents:read', 'documents:write']
 * const permissions = await evaluatePermissionsForScope(
 *   db,
 *   'user_123',
 *   'openid profile documents:read documents:write users:manage'
 * );
 * // Returns: ['documents:read', 'documents:write']
 * // 'users:manage' is excluded because user doesn't have that permission
 */
export async function evaluatePermissionsForScope(
  db: DatabaseSource,
  subjectId: string,
  scope: string,
  options: PolicyEmbeddingOptions
): Promise<string[]> {
  const embedding = await evaluatePermissionEmbeddingForScope(db, subjectId, scope, options);
  return embedding.permissions;
}

export async function evaluatePermissionEmbeddingForScope(
  db: DatabaseSource,
  subjectId: string,
  scope: string,
  options: PolicyEmbeddingOptions
): Promise<PolicyPermissionEmbedding> {
  // Parse requested scopes
  const requestedActions = parseScopeToActions(scope);
  if (requestedActions.length === 0) {
    return { permissions: [], scopedPermissions: [] };
  }

  // Try cache first
  const tenantId = options.tenantId;
  const cacheKey = options.cache ? `${PERMISSION_CACHE_PREFIX}${tenantId}:${subjectId}` : null;
  let userGrants: UserPermissionGrant[];

  if (cacheKey && options.cache) {
    const cached = await options.cache.get(cacheKey);
    if (cached) {
      try {
        userGrants = JSON.parse(cached) as UserPermissionGrant[];
      } catch {
        userGrants = await getUserPermissionGrantsFromRoles(db, subjectId, tenantId);
      }
    } else {
      userGrants = await getUserPermissionGrantsFromRoles(db, subjectId, tenantId);
      // Cache for next time
      const ttl = options.cacheTTL ?? 300;
      await options.cache.put(cacheKey, JSON.stringify(userGrants), {
        expirationTtl: ttl,
      });
    }
  } else {
    userGrants = await getUserPermissionGrantsFromRoles(db, subjectId, tenantId);
  }

  // Filter requested scopes to only those the user has permission for
  const grantedPermissions: string[] = [];
  const scopedPermissions: ScopedPolicyPermission[] = [];
  const grantedSet = new Set<string>();
  const scopedSet = new Set<string>();

  for (const action of requestedActions) {
    for (const grant of userGrants) {
      if (!permissionMatches(grant.permission, action)) {
        continue;
      }

      if (isTenantWideGrant(grant)) {
        if (!grantedSet.has(action.original)) {
          grantedSet.add(action.original);
          grantedPermissions.push(action.original);
        }
        continue;
      }

      if (grant.scopeType !== 'org' && grant.scopeType !== 'resource') {
        continue;
      }
      const scopedPermission: ScopedPolicyPermission = {
        permission: action.original,
        scope_type: grant.scopeType,
        scope_target: grant.scopeTarget,
      };
      const scopedKey = `${scopedPermission.permission}\u0000${scopedPermission.scope_type}\u0000${scopedPermission.scope_target}`;
      if (!scopedSet.has(scopedKey)) {
        scopedSet.add(scopedKey);
        scopedPermissions.push(scopedPermission);
      }
    }
  }

  return { permissions: grantedPermissions, scopedPermissions };
}

/**
 * Invalidate permission cache for a user
 *
 * Call this when user's roles change to ensure fresh permissions.
 *
 * @param cache - KV namespace for caching
 * @param subjectId - User ID
 */
export async function invalidatePermissionCache(
  cache: KVNamespace,
  tenantId: string,
  subjectId: string
): Promise<void> {
  const cacheKey = `${PERMISSION_CACHE_PREFIX}${tenantId}:${subjectId}`;
  await cache.delete(cacheKey);
}

/**
 * Check if policy embedding feature is enabled
 *
 * Reads from KV first (dynamic override), then environment variable.
 *
 * @param env - Environment bindings
 * @returns true if policy embedding is enabled
 */
export async function isPolicyEmbeddingEnabled(env: {
  SETTINGS?: KVNamespace;
  ENABLE_POLICY_EMBEDDING?: string;
}): Promise<boolean> {
  // Check KV first (dynamic override)
  if (env.SETTINGS) {
    try {
      const kvValue = await env.SETTINGS.get('policy:flags:ENABLE_POLICY_EMBEDDING');
      if (kvValue !== null) {
        return kvValue.toLowerCase() === 'true' || kvValue === '1';
      }
    } catch {
      // Fall through to environment variable
    }
  }

  // Fall back to environment variable
  return env.ENABLE_POLICY_EMBEDDING === 'true';
}

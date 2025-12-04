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

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { resolveEffectiveRoles } from './rbac-claims';

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

/**
 * Options for permission evaluation
 */
export interface PolicyEmbeddingOptions {
  /** KV namespace for caching (optional) */
  cache?: KVNamespace;
  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  cacheTTL?: number;
}

/**
 * Role-permission mapping cache key prefix
 */
const PERMISSION_CACHE_PREFIX = 'policy:perms:';

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
async function getUserPermissionsFromRoles(
  db: D1Database,
  subjectId: string
): Promise<Set<string>> {
  const now = Math.floor(Date.now() / 1000);

  // Get permissions from all active roles
  const result = await db
    .prepare(
      `SELECT DISTINCT r.permissions_json
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
         AND r.permissions_json IS NOT NULL
         AND r.permissions_json != '[]'`
    )
    .bind(subjectId, now)
    .all<{ permissions_json: string }>();

  const permissionsSet = new Set<string>();

  for (const r of result.results) {
    try {
      const perms = JSON.parse(r.permissions_json) as string[];
      for (const p of perms) {
        permissionsSet.add(p);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return permissionsSet;
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
  db: D1Database,
  subjectId: string,
  scope: string,
  options: PolicyEmbeddingOptions = {}
): Promise<string[]> {
  // Parse requested scopes
  const requestedActions = parseScopeToActions(scope);
  if (requestedActions.length === 0) {
    return [];
  }

  // Try cache first
  const cacheKey = options.cache ? `${PERMISSION_CACHE_PREFIX}${subjectId}` : null;
  let userPermissions: Set<string>;

  if (cacheKey && options.cache) {
    const cached = await options.cache.get(cacheKey);
    if (cached) {
      try {
        userPermissions = new Set(JSON.parse(cached) as string[]);
      } catch {
        userPermissions = await getUserPermissionsFromRoles(db, subjectId);
      }
    } else {
      userPermissions = await getUserPermissionsFromRoles(db, subjectId);
      // Cache for next time
      const ttl = options.cacheTTL ?? 300;
      await options.cache.put(cacheKey, JSON.stringify([...userPermissions]), {
        expirationTtl: ttl,
      });
    }
  } else {
    userPermissions = await getUserPermissionsFromRoles(db, subjectId);
  }

  // Check if user has wildcard permission for any resource
  // e.g., "documents:*" grants all document actions
  const wildcardResources = new Set<string>();
  for (const perm of userPermissions) {
    if (perm.endsWith(':*')) {
      wildcardResources.add(perm.slice(0, -2));
    }
  }

  // Filter requested scopes to only those the user has permission for
  const grantedPermissions: string[] = [];

  for (const action of requestedActions) {
    // Check exact match
    if (userPermissions.has(action.original)) {
      grantedPermissions.push(action.original);
      continue;
    }

    // Check wildcard match (resource:*)
    if (wildcardResources.has(action.resource)) {
      grantedPermissions.push(action.original);
      continue;
    }

    // Check if user has global wildcard for this action
    // e.g., "*:read" grants read on all resources
    if (userPermissions.has(`*:${action.action}`)) {
      grantedPermissions.push(action.original);
      continue;
    }

    // Check full wildcard
    if (userPermissions.has('*:*')) {
      grantedPermissions.push(action.original);
      continue;
    }

    // User doesn't have this permission - skip
  }

  return grantedPermissions;
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
  subjectId: string
): Promise<void> {
  const cacheKey = `${PERMISSION_CACHE_PREFIX}${subjectId}`;
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

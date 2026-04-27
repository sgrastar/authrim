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
 * const permissions = await evaluateIdLevelPermissions(db, subjectId, env);
 * // Returns: ['documents:doc_123:read', 'documents:doc_456:write']
 * ```
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseSource } from '../db';
import { ensureDatabaseAdapter } from '../db';
import type { Env } from '../types/env';
import type {
  ResourcePermission,
  ResourcePermissionRow,
  PermissionEmbeddingResult,
  TokenEmbeddingLimits,
  DEFAULT_TOKEN_EMBEDDING_LIMITS,
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
const ID_PERMISSION_CACHE_PREFIX = 'policy:idperms:';

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

/**
 * Get ID-level permissions for a user from database
 *
 * Queries resource_permissions table for all active permissions
 * granted to the user (directly or through roles/orgs).
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Array of ResourcePermission objects
 */
export async function getUserIdLevelPermissions(
  db: DatabaseSource,
  subjectId: string,
  tenantId: string = 'default'
): Promise<ResourcePermission[]> {
  const now = Math.floor(Date.now() / 1000);

  // Query for direct user permissions and role-based permissions
  // Note: Role inheritance would require joining with role_assignments
  const rows = await ensureDatabaseAdapter(
    db,
    'resource-permissions'
  ).query<ResourcePermissionRow>(
    `SELECT *
       FROM resource_permissions
       WHERE tenant_id = ?
         AND is_active = 1
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           (subject_type = 'user' AND subject_id = ?)
           OR subject_type = 'role' AND subject_id IN (
             SELECT role_id FROM role_assignments
             WHERE subject_id = ?
               AND (expires_at IS NULL OR expires_at > ?)
           )
         )
       ORDER BY resource_type, resource_id`,
    [tenantId, now, subjectId, subjectId, now]
  );

  return rows.map(rowToResourcePermission);
}

/**
 * Evaluate ID-level permissions for a user
 *
 * Returns all ID-level permissions the user has as scope strings.
 *
 * @param db - D1 database
 * @param subjectId - User ID
 * @param tenantId - Tenant ID (default: 'default')
 * @param options - Evaluation options
 * @returns Array of ID-level permission strings (e.g., "documents:doc_123:read")
 */
export async function evaluateIdLevelPermissions(
  db: DatabaseSource,
  subjectId: string,
  tenantId: string = 'default',
  options: {
    cache?: KVNamespace;
    cacheTTL?: number;
  } = {}
): Promise<string[]> {
  // Try cache first
  const cacheKey = options.cache ? `${ID_PERMISSION_CACHE_PREFIX}${tenantId}:${subjectId}` : null;

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
  const permissions = await getUserIdLevelPermissions(db, subjectId, tenantId);

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
 * @param db - D1 database
 * @param subjectId - User ID
 * @param resource - Resource type
 * @param resourceId - Resource ID
 * @param action - Action name
 * @param tenantId - Tenant ID (default: 'default')
 * @returns true if user has the permission
 */
export async function hasIdLevelPermission(
  db: DatabaseSource,
  subjectId: string,
  resource: string,
  resourceId: string,
  action: string,
  tenantId: string = 'default'
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const adapter = ensureDatabaseAdapter(db, 'resource-permissions');

  const result = await adapter.queryOne<{ matched: number }>(
    `SELECT 1 AS matched
       FROM resource_permissions
       WHERE tenant_id = ?
         AND resource_type = ?
         AND resource_id = ?
         AND is_active = 1
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           (subject_type = 'user' AND subject_id = ?)
           OR subject_type = 'role' AND subject_id IN (
             SELECT role_id FROM role_assignments
             WHERE subject_id = ?
               AND (expires_at IS NULL OR expires_at > ?)
           )
         )
       LIMIT 1`,
    [tenantId, resource, resourceId, now, subjectId, subjectId, now]
  );

  if (!result) {
    return false;
  }

  // Check if the action is in the actions_json
  const fullResult = await adapter.query<{ actions_json: string }>(
    `SELECT actions_json
       FROM resource_permissions
       WHERE tenant_id = ?
         AND resource_type = ?
         AND resource_id = ?
         AND is_active = 1
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           (subject_type = 'user' AND subject_id = ?)
           OR subject_type = 'role' AND subject_id IN (
             SELECT role_id FROM role_assignments
             WHERE subject_id = ?
               AND (expires_at IS NULL OR expires_at > ?)
           )
         )`,
    [tenantId, resource, resourceId, now, subjectId, subjectId, now]
  );

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
 * Check if custom claims feature is enabled
 *
 * @param env - Environment bindings
 * @returns true if custom claims are enabled
 */
export async function isCustomClaimsEnabled(env: {
  SETTINGS?: KVNamespace;
  ENABLE_CUSTOM_CLAIMS?: string;
}): Promise<boolean> {
  // Check KV first (dynamic override)
  if (env.SETTINGS) {
    try {
      const kvValue = await env.SETTINGS.get('policy:flags:ENABLE_CUSTOM_CLAIMS');
      if (kvValue !== null) {
        return kvValue.toLowerCase() === 'true' || kvValue === '1';
      }
    } catch {
      // Fall through to environment variable
    }
  }

  // Fall back to environment variable (default: false)
  return env.ENABLE_CUSTOM_CLAIMS === 'true';
}

/**
 * Check if ID-level permissions feature is enabled
 *
 * @param env - Environment bindings
 * @returns true if ID-level permissions are enabled
 */
export async function isIdLevelPermissionsEnabled(env: {
  SETTINGS?: KVNamespace;
  ENABLE_ID_LEVEL_PERMISSIONS?: string;
}): Promise<boolean> {
  // Check KV first (dynamic override)
  if (env.SETTINGS) {
    try {
      const kvValue = await env.SETTINGS.get('policy:flags:ENABLE_ID_LEVEL_PERMISSIONS');
      if (kvValue !== null) {
        return kvValue.toLowerCase() === 'true' || kvValue === '1';
      }
    } catch {
      // Fall through to environment variable
    }
  }

  // Fall back to environment variable (default: false)
  return env.ENABLE_ID_LEVEL_PERMISSIONS === 'true';
}

/**
 * Get token embedding limits from KV or environment
 *
 * @param env - Environment bindings
 * @returns Token embedding limits
 */
export async function getEmbeddingLimits(env: {
  SETTINGS?: KVNamespace;
  MAX_EMBEDDED_PERMISSIONS?: string;
  MAX_RESOURCE_PERMISSIONS?: string;
  MAX_CUSTOM_CLAIMS?: string;
}): Promise<TokenEmbeddingLimits> {
  const limits: TokenEmbeddingLimits = {
    max_embedded_permissions: 50,
    max_resource_permissions: 100,
    max_custom_claims: 20,
  };

  // Try KV first for each setting
  if (env.SETTINGS) {
    try {
      const kvMaxEmbedded = await env.SETTINGS.get('config:max_embedded_permissions');
      if (kvMaxEmbedded) {
        const parsed = parseInt(kvMaxEmbedded, 10);
        if (!isNaN(parsed) && parsed > 0) {
          limits.max_embedded_permissions = parsed;
        }
      }
    } catch {
      // Ignore KV errors
    }

    try {
      const kvMaxResource = await env.SETTINGS.get('config:max_resource_permissions');
      if (kvMaxResource) {
        const parsed = parseInt(kvMaxResource, 10);
        if (!isNaN(parsed) && parsed > 0) {
          limits.max_resource_permissions = parsed;
        }
      }
    } catch {
      // Ignore KV errors
    }

    try {
      const kvMaxCustom = await env.SETTINGS.get('config:max_custom_claims');
      if (kvMaxCustom) {
        const parsed = parseInt(kvMaxCustom, 10);
        if (!isNaN(parsed) && parsed > 0) {
          limits.max_custom_claims = parsed;
        }
      }
    } catch {
      // Ignore KV errors
    }
  }

  // Fall back to environment variables
  if (env.MAX_EMBEDDED_PERMISSIONS) {
    const parsed = parseInt(env.MAX_EMBEDDED_PERMISSIONS, 10);
    if (!isNaN(parsed) && parsed > 0 && limits.max_embedded_permissions === 50) {
      limits.max_embedded_permissions = parsed;
    }
  }

  if (env.MAX_RESOURCE_PERMISSIONS) {
    const parsed = parseInt(env.MAX_RESOURCE_PERMISSIONS, 10);
    if (!isNaN(parsed) && parsed > 0 && limits.max_resource_permissions === 100) {
      limits.max_resource_permissions = parsed;
    }
  }

  if (env.MAX_CUSTOM_CLAIMS) {
    const parsed = parseInt(env.MAX_CUSTOM_CLAIMS, 10);
    if (!isNaN(parsed) && parsed > 0 && limits.max_custom_claims === 20) {
      limits.max_custom_claims = parsed;
    }
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
 * @param tenantId - Tenant ID (default: 'default')
 */
export async function invalidateIdPermissionCache(
  cache: KVNamespace,
  subjectId: string,
  tenantId: string = 'default'
): Promise<void> {
  const cacheKey = `${ID_PERMISSION_CACHE_PREFIX}${tenantId}:${subjectId}`;
  await cache.delete(cacheKey);
}

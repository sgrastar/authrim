/**
 * RBAC (Role-Based Access Control) Type Definitions
 *
 * This module contains type definitions for RBAC Phase 1:
 * - Roles and role assignments
 * - Relationships (parent-child, etc.)
 * - Token claims extensions
 */

// =============================================================================
// Role Types
// =============================================================================

/**
 * Role type classification
 * - system: Internal system roles (cannot be deleted)
 * - builtin: Default roles provided by Authrim
 * - custom: User-defined roles
 */
export type RoleType = 'system' | 'builtin' | 'custom';

/**
 * Scope type for role assignments
 * - global: Applies everywhere in the tenant
 * - tenant: Applies in its own tenant (`scope_target` empty or the tenant id)
 * - group: Applies to resources of a group (`group:<id>`)
 * - resource: Applies to a specific resource
 */
export type ScopeType = 'global' | 'tenant' | 'group' | 'resource';

/**
 * Role entity
 */
export interface Role {
  /** Unique role ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Role name (unique within tenant) */
  name: string;
  /** Role description */
  description?: string;
  /** Permissions as JSON array (for future use) */
  permissions_json: string;
  /** Role type */
  role_type: RoleType;
  /** Whether this role can be assigned to users */
  is_assignable: boolean;
  /** Delegation tier: an administrator may grant the role only up to their own tier */
  grant_tier: number;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
}

/**
 * Role row from D1 database
 */
export interface RoleRow extends Omit<Role, 'is_assignable'> {
  is_assignable: number;
}

/**
 * Role assignment
 * Links users to roles with an optional scope.
 */
export interface RoleAssignment {
  /** Unique assignment ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** User ID */
  subject_id: string;
  /** Role ID */
  role_id: string;
  /** Scope type */
  scope_type: ScopeType;
  /** Scope target (empty for global, "type:id" format otherwise) */
  scope_target: string;
  /** Optional expiration timestamp (UNIX seconds) */
  expires_at?: number;
  /** User ID who made the assignment */
  assigned_by?: string;
  /** Additional metadata (JSON) */
  metadata_json?: string;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Role assignment row from D1 database
 */
export interface RoleAssignmentRow extends Omit<RoleAssignment, 'expires_at' | 'metadata_json'> {
  expires_at: number | null;
  metadata_json: string | null;
}

// =============================================================================
// Relationship Types
// =============================================================================

/**
 * Relationship type
 * - parent_child: Parent managing a child account
 * - guardian: Legal guardian relationship
 * - delegate: Delegated access (e.g., assistant)
 * - manager: Manager-subordinate relationship
 * - reseller_of: Distributor/reseller relationship (for org-org, Phase 2+)
 */
export type RelationshipType = 'parent_child' | 'guardian' | 'delegate' | 'manager' | 'reseller_of';

/**
 * Entity type in a subject relationship
 * - subject: User
 * (ReBAC tuples use the same table with a group or an object type: see rebac/tuple-type-rules.ts.)
 */
export type RelationshipEntityType = 'subject';

/**
 * Permission level in a relationship
 * - full: Full access/management
 * - limited: Limited access
 * - read_only: Read-only access
 */
export type PermissionLevel = 'full' | 'limited' | 'read_only';

/**
 * Relationship entity
 * Represents relationships between subjects.
 */
export interface Relationship {
  /** Unique relationship ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Type of relationship */
  relationship_type: RelationshipType;
  /** Source entity type */
  from_type: RelationshipEntityType;
  /** Source entity ID */
  from_id: string;
  /** Target entity type */
  to_type: RelationshipEntityType;
  /** Target entity ID */
  to_id: string;
  /** Permission level granted */
  permission_level: PermissionLevel;
  /** Optional expiration timestamp (UNIX seconds) */
  expires_at?: number;
  /** Whether the relationship is bidirectional */
  is_bidirectional: boolean;
  /** Additional metadata (JSON) */
  metadata_json?: string;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Relationship row from D1 database
 */
export interface RelationshipRow extends Omit<
  Relationship,
  'expires_at' | 'is_bidirectional' | 'metadata_json'
> {
  expires_at: number | null;
  is_bidirectional: number;
  metadata_json: string | null;
}

// =============================================================================
// User Type Extensions
// =============================================================================

/**
 * User type classification (for UI/logging purposes)
 *
 * IMPORTANT: This is a coarse classification for display purposes.
 * Actual authorization should use role_assignments, NOT user_type.
 *
 * Types:
 * - end_user: Regular authenticated user
 *   Read registration_state from the lifecycle claim to distinguish human guests.
 * - admin: An administrator account of the service's own users (the account type `admin`)
 */
export type UserType = 'end_user' | 'admin';

// =============================================================================
// Token Claims Extensions (Namespaced)
// =============================================================================

/**
 * Scoped role for token claims (includes scope info)
 */
export interface TokenScopedRole {
  /** Role name */
  name: string;
  /** Scope type */
  scope: ScopeType;
  /** Scope target (e.g., "group:grp_123") */
  scopeTarget?: string;
}

/**
 * Relationships summary for ID token
 */
export interface RelationshipsSummary {
  /** IDs of child accounts */
  children_ids: string[];
  /** IDs of parent accounts */
  parent_ids: string[];
}

export interface TokenScopedPermission {
  permission: string;
  scope_type: Exclude<ScopeType, 'global'>;
  scope_target: string;
}

/**
 * RBAC claims to be added to tokens
 * Uses authrim_ prefix to avoid conflicts with standard claims.
 */
export interface RBACTokenClaims {
  /** User's effective roles (simple string array) */
  authrim_roles?: string[];
  /** User's effective roles with scope info (Phase 2) */
  authrim_scoped_roles?: TokenScopedRole[];
  /** User type classification */
  authrim_user_type?: UserType;
  /** Relationships summary (Phase 2) */
  authrim_relationships_summary?: RelationshipsSummary;
  /** Resolved permissions from roles (Phase 2) */
  authrim_permissions?: string[];
  /** Group- or resource-scoped permissions from scoped role assignments */
  authrim_scoped_permissions?: TokenScopedPermission[];
  /** The subject's effective groups (direct memberships and their ancestors, active only) */
  authrim_groups?: TokenGroup[];
}

/** A group in the authrim_groups claim */
export interface TokenGroup {
  id: string;
  key: string;
  name: string;
  kind: string;
}

/**
 * Available RBAC claim keys for ID Token
 * Used for environment variable configuration
 */
export type IDTokenClaimKey =
  | 'roles'
  | 'groups'
  | 'permissions'
  | 'scoped_roles'
  | 'user_type'
  | 'relationships_summary';

/**
 * Available RBAC claim keys for Access Token
 * Used for environment variable configuration
 */
export type AccessTokenClaimKey = 'roles' | 'groups' | 'scoped_roles' | 'permissions';

/**
 * Default claim sets for backward compatibility
 */
export const DEFAULT_ID_TOKEN_CLAIMS: IDTokenClaimKey[] = [
  'roles',
  'groups',
  'permissions',
  'user_type',
];

export const DEFAULT_ACCESS_TOKEN_CLAIMS: AccessTokenClaimKey[] = ['roles', 'groups'];

// =============================================================================
// Default Role Names
// =============================================================================

/**
 * Default role identifiers: the only preset roles of the service's own users. Business roles are
 * created by whoever runs Authrim. (The people who run Authrim use the separate `ar_` Admin roles.)
 */
export const DEFAULT_ROLES = {
  ADMIN: 'admin',
  END_USER: 'end_user',
} as const;

/**
 * Default role IDs (as stored in database)
 */
export const DEFAULT_ROLE_IDS = {
  ADMIN: 'role_admin',
  END_USER: 'role_end_user',
} as const;

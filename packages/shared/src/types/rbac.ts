/**
 * RBAC (Role-Based Access Control) Type Definitions
 *
 * This module contains type definitions for RBAC Phase 1:
 * - Organizations and memberships
 * - Roles and role assignments
 * - Relationships (parent-child, etc.)
 * - Token claims extensions
 */

// =============================================================================
// Organization Types
// =============================================================================

/**
 * Organization type classification
 * - distributor: Reseller/distributor company
 * - enterprise: Enterprise customer
 * - department: Internal department or sub-organization
 */
export type OrganizationType = 'distributor' | 'enterprise' | 'department';

/**
 * Plan/subscription tier
 */
export type PlanType = 'free' | 'starter' | 'professional' | 'enterprise';

/**
 * Organization entity
 * Represents companies, departments, or other organizational units.
 */
export interface Organization {
  /** Unique organization ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** Unique name within tenant */
  name: string;
  /** Human-readable display name */
  display_name?: string;
  /** Organization description */
  description?: string;
  /** Organization type */
  org_type: OrganizationType;
  /** Parent organization ID for hierarchy */
  parent_org_id?: string;
  /** Subscription plan */
  plan: PlanType;
  /** Whether the organization is active */
  is_active: boolean;
  /** Additional metadata (JSON) */
  metadata_json?: string;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Organization row from D1 database
 * SQLite stores booleans as integers
 */
export interface OrganizationRow extends Omit<Organization, 'is_active' | 'metadata_json'> {
  is_active: number;
  metadata_json: string | null;
}

// =============================================================================
// Membership Types
// =============================================================================

/**
 * Membership type within an organization
 * - member: Regular member
 * - admin: Organization administrator
 * - owner: Organization owner (full control)
 */
export type MembershipType = 'member' | 'admin' | 'owner';

/**
 * Subject-Organization membership
 * Links users to organizations with a specific role.
 */
export interface SubjectOrgMembership {
  /** Unique membership ID */
  id: string;
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;
  /** User ID */
  subject_id: string;
  /** Organization ID */
  org_id: string;
  /** Type of membership */
  membership_type: MembershipType;
  /** Whether this is the user's primary organization */
  is_primary: boolean;
  /** Creation timestamp (UNIX seconds) */
  created_at: number;
  /** Last update timestamp (UNIX seconds) */
  updated_at: number;
}

/**
 * Subject-Organization membership row from D1 database
 */
export interface SubjectOrgMembershipRow extends Omit<SubjectOrgMembership, 'is_primary'> {
  is_primary: number;
}

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
 * - global: Applies tenant-wide
 * - org: Applies to a specific organization
 * - resource: Applies to a specific resource
 */
export type ScopeType = 'global' | 'org' | 'resource';

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
  /** Hierarchy level (0-100, higher = more privileged) */
  hierarchy_level: number;
  /** Parent role ID for inheritance */
  parent_role_id?: string;
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
 * Entity type in a relationship
 * - subject: User
 * - org: Organization (for future use)
 */
export type RelationshipEntityType = 'subject' | 'org';

/**
 * Permission level in a relationship
 * - full: Full access/management
 * - limited: Limited access
 * - read_only: Read-only access
 */
export type PermissionLevel = 'full' | 'limited' | 'read_only';

/**
 * Relationship entity
 * Represents relationships between subjects (and organizations in the future).
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
export interface RelationshipRow
  extends Omit<Relationship, 'expires_at' | 'is_bidirectional' | 'metadata_json'> {
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
 */
export type UserType = 'end_user' | 'distributor_admin' | 'enterprise_admin' | 'system_admin';

// =============================================================================
// Token Claims Extensions (Namespaced)
// =============================================================================

/**
 * Organization info for token claims (multiple orgs support)
 */
export interface TokenOrgInfo {
  /** Organization ID */
  id: string;
  /** Organization name */
  name: string;
  /** Organization type */
  type: OrganizationType;
  /** Whether this is the user's primary organization */
  is_primary: boolean;
}

/**
 * Scoped role for token claims (includes scope info)
 */
export interface TokenScopedRole {
  /** Role name */
  name: string;
  /** Scope type */
  scope: ScopeType;
  /** Scope target (e.g., "org:org_123") */
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

/**
 * Organization context for Access Token
 */
export interface OrgContext {
  /** Organization ID the user is acting as */
  acting_as_org_id?: string;
  /** Organization ID the user is acting on behalf of */
  on_behalf_of_org_id?: string;
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
  /** Primary organization ID */
  authrim_org_id?: string;
  /** Primary organization name (Phase 2) */
  authrim_org_name?: string;
  /** Organization's subscription plan */
  authrim_plan?: PlanType;
  /** Organization type */
  authrim_org_type?: OrganizationType;
  /** All organizations the user belongs to (Phase 2) */
  authrim_orgs?: TokenOrgInfo[];
  /** Relationships summary (Phase 2) */
  authrim_relationships_summary?: RelationshipsSummary;
  /** Resolved permissions from roles (Phase 2) */
  authrim_permissions?: string[];
  /** Organization context for acting as/on behalf of (Phase 2) */
  authrim_org_context?: OrgContext;
}

/**
 * Available RBAC claim keys for ID Token
 * Used for environment variable configuration
 */
export type IDTokenClaimKey =
  | 'roles'
  | 'scoped_roles'
  | 'user_type'
  | 'org_id'
  | 'org_name'
  | 'plan'
  | 'org_type'
  | 'orgs'
  | 'relationships_summary';

/**
 * Available RBAC claim keys for Access Token
 * Used for environment variable configuration
 */
export type AccessTokenClaimKey =
  | 'roles'
  | 'scoped_roles'
  | 'org_id'
  | 'org_type'
  | 'permissions'
  | 'org_context';

/**
 * Default claim sets for backward compatibility
 */
export const DEFAULT_ID_TOKEN_CLAIMS: IDTokenClaimKey[] = [
  'roles',
  'user_type',
  'org_id',
  'plan',
  'org_type',
];

export const DEFAULT_ACCESS_TOKEN_CLAIMS: AccessTokenClaimKey[] = ['roles', 'org_id', 'org_type'];

// =============================================================================
// Default Role Names
// =============================================================================

/**
 * Default role identifiers
 */
export const DEFAULT_ROLES = {
  SYSTEM_ADMIN: 'system_admin',
  DISTRIBUTOR_ADMIN: 'distributor_admin',
  ORG_ADMIN: 'org_admin',
  END_USER: 'end_user',
} as const;

/**
 * Default role IDs (as stored in database)
 */
export const DEFAULT_ROLE_IDS = {
  SYSTEM_ADMIN: 'role_system_admin',
  DISTRIBUTOR_ADMIN: 'role_distributor_admin',
  ORG_ADMIN: 'role_org_admin',
  END_USER: 'role_end_user',
} as const;

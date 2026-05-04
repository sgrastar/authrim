/**
 * RBAC (Role-Based Access Control) Type Definitions
 *
 * This module contains type definitions for RBAC Phase 1:
 * - Organizations and memberships
 * - Roles and role assignments
 * - Relationships (parent-child, etc.)
 * - Token claims extensions
 */
/**
 * Default claim sets for backward compatibility
 */
export const DEFAULT_ID_TOKEN_CLAIMS = [
    'roles',
    'user_type',
    'org_id',
    'plan',
    'org_type',
];
export const DEFAULT_ACCESS_TOKEN_CLAIMS = ['roles', 'org_id', 'org_type'];
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
};
/**
 * Default role IDs (as stored in database)
 */
export const DEFAULT_ROLE_IDS = {
    SYSTEM_ADMIN: 'role_system_admin',
    DISTRIBUTOR_ADMIN: 'role_distributor_admin',
    ORG_ADMIN: 'role_org_admin',
    END_USER: 'role_end_user',
};

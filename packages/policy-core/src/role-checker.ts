/**
 * Role Checker
 *
 * Standalone role checking utilities for quick access decisions.
 * Use these for simple role-based checks without the full policy engine.
 */

import type { SubjectRole, PolicySubject } from './types';

/**
 * Options for role checking
 */
export interface RoleCheckOptions {
  /** Scope to check (default: 'global') */
  scope?: string;

  /** Specific scope target to check */
  scopeTarget?: string;

  /** Current timestamp (default: Date.now()) */
  now?: number;
}

/**
 * Check if subject has a specific role
 *
 * @param subject - Subject to check
 * @param roleName - Required role name
 * @param options - Check options
 * @returns true if subject has the role
 *
 * @example
 * ```typescript
 * if (hasRole(subject, 'system_admin')) {
 *   // Allow access
 * }
 * ```
 */
export function hasRole(
  subject: PolicySubject | SubjectRole[],
  roleName: string,
  options: RoleCheckOptions = {}
): boolean {
  const roles = Array.isArray(subject) ? subject : subject.roles;
  const { scope = 'global', scopeTarget, now = Date.now() } = options;

  return roles.some((role) => {
    if (role.name !== roleName) return false;
    if (role.expiresAt && role.expiresAt <= now) return false;

    // Global role matches any scope requirement
    if (role.scope === 'global') return true;

    // When scope matches
    if (role.scope === scope) {
      // If scopeTarget specified, must match
      if (scopeTarget && role.scopeTarget !== scopeTarget) return false;
      return true;
    }

    return false;
  });
}

/**
 * Check if subject has any of the specified roles
 *
 * @param subject - Subject to check
 * @param roleNames - Array of role names (any must match)
 * @param options - Check options
 * @returns true if subject has at least one of the roles
 *
 * @example
 * ```typescript
 * if (hasAnyRole(subject, ['system_admin', 'org_admin'])) {
 *   // Allow access
 * }
 * ```
 */
export function hasAnyRole(
  subject: PolicySubject | SubjectRole[],
  roleNames: string[],
  options: RoleCheckOptions = {}
): boolean {
  return roleNames.some((roleName) => hasRole(subject, roleName, options));
}

/**
 * Check if subject has all of the specified roles
 *
 * @param subject - Subject to check
 * @param roleNames - Array of role names (all must match)
 * @param options - Check options
 * @returns true if subject has all of the roles
 *
 * @example
 * ```typescript
 * if (hasAllRoles(subject, ['admin', 'audit_access'])) {
 *   // Allow access
 * }
 * ```
 */
export function hasAllRoles(
  subject: PolicySubject | SubjectRole[],
  roleNames: string[],
  options: RoleCheckOptions = {}
): boolean {
  return roleNames.every((roleName) => hasRole(subject, roleName, options));
}

/**
 * Check if subject is an admin (has any admin role)
 *
 * @param subject - Subject to check
 * @returns true if subject has any admin role
 */
export function isAdmin(subject: PolicySubject | SubjectRole[]): boolean {
  return hasAnyRole(subject, ['system_admin', 'distributor_admin', 'org_admin', 'admin']);
}

/**
 * Check if subject is a system admin
 *
 * @param subject - Subject to check
 * @returns true if subject has system_admin role
 */
export function isSystemAdmin(subject: PolicySubject | SubjectRole[]): boolean {
  return hasRole(subject, 'system_admin');
}

/**
 * Check if subject is an organization admin
 *
 * @param subject - Subject to check
 * @param orgId - Optional organization ID to check scoped role
 * @returns true if subject has org_admin role
 */
export function isOrgAdmin(subject: PolicySubject | SubjectRole[], orgId?: string): boolean {
  const options: RoleCheckOptions = {};
  if (orgId) {
    options.scope = 'org';
    options.scopeTarget = `org:${orgId}`;
  }
  return hasRole(subject, 'org_admin', options);
}

/**
 * Get all active role names for a subject
 *
 * @param subject - Subject to get roles for
 * @param options - Filter options
 * @returns Array of active role names
 */
export function getActiveRoles(
  subject: PolicySubject | SubjectRole[],
  options: Pick<RoleCheckOptions, 'scope' | 'scopeTarget' | 'now'> = {}
): string[] {
  const roles = Array.isArray(subject) ? subject : subject.roles;
  const { scope, scopeTarget, now = Date.now() } = options;

  const activeRoles: string[] = [];
  const seen = new Set<string>();

  for (const role of roles) {
    // Skip expired roles
    if (role.expiresAt && role.expiresAt <= now) continue;

    // Filter by scope if specified
    if (scope) {
      // Global roles always match
      if (role.scope !== 'global' && role.scope !== scope) continue;
      // Check scope target if specified
      if (scopeTarget && role.scope !== 'global' && role.scopeTarget !== scopeTarget) continue;
    }

    // Add unique role names
    if (!seen.has(role.name)) {
      seen.add(role.name);
      activeRoles.push(role.name);
    }
  }

  return activeRoles;
}

/**
 * Create a PolicySubject from token claims
 *
 * @param claims - Token claims containing RBAC information
 * @returns PolicySubject object
 *
 * @example
 * ```typescript
 * const subject = subjectFromClaims({
 *   sub: 'user_123',
 *   authrim_roles: ['end_user', 'org_admin'],
 *   authrim_user_type: 'enterprise_admin',
 *   authrim_org_id: 'org_456',
 *   authrim_plan: 'professional',
 *   authrim_org_type: 'enterprise'
 * });
 * ```
 */
export function subjectFromClaims(claims: {
  sub?: string;
  authrim_roles?: string[];
  authrim_user_type?: string;
  authrim_org_id?: string;
  authrim_plan?: string;
  authrim_org_type?: string;
}): PolicySubject {
  // Convert flat role names to SubjectRole objects (assume global scope from token)
  const roles: SubjectRole[] = (claims.authrim_roles || []).map((name) => ({
    name,
    scope: 'global' as const,
  }));

  return {
    id: claims.sub || '',
    userType: claims.authrim_user_type as PolicySubject['userType'],
    roles,
    orgId: claims.authrim_org_id,
    plan: claims.authrim_plan as PolicySubject['plan'],
    orgType: claims.authrim_org_type as PolicySubject['orgType'],
  };
}

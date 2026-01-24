/**
 * RBAC (Role-Based Access Control) Middleware
 *
 * Phase 1 Implementation:
 * - requireRole(): Check if user has required role(s)
 *
 * Phase 2 (future):
 * - requirePermission(): Check if user has required permission(s)
 *
 * Usage:
 * ```typescript
 * import { requireRole, requireAnyRole, requireAllRoles } from '@authrim/ar-lib-core';
 *
 * // Require a single role
 * app.get('/admin', requireRole('system_admin'), handler);
 *
 * // Require any of multiple roles
 * app.get('/admin', requireAnyRole(['system_admin', 'org_admin']), handler);
 *
 * // Require all roles
 * app.get('/super', requireAllRoles(['system_admin', 'audit_role']), handler);
 * ```
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';

/**
 * Error response for RBAC failures
 */
interface RBACErrorResponse {
  error: string;
  error_description: string;
  required_roles?: string[];
}

/**
 * Super admin roles that have all privileges
 *
 * These roles bypass all role checks - they are the highest privilege level.
 * Used for Admin/EndUser separation where super_admin is the Admin-side
 * equivalent of system_admin.
 */
const SUPER_ADMIN_ROLES = ['super_admin', 'system_admin'] as const;

/**
 * Check if the user has super admin privileges
 *
 * Super admins (super_admin, system_admin) bypass all role checks.
 *
 * @param roles - User's roles
 * @returns true if user has super admin privileges
 */
function hasSuperAdminPrivileges(roles: string[]): boolean {
  return roles.some((role) =>
    SUPER_ADMIN_ROLES.includes(role as (typeof SUPER_ADMIN_ROLES)[number])
  );
}

/**
 * Get admin auth context from request
 *
 * @param c - Hono context
 * @returns AdminAuthContext if present, null otherwise
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).get('adminAuth') as AdminAuthContext | null;
}

/**
 * Create an access denied response
 *
 * @param requiredRoles - Roles that were required
 * @returns RBACErrorResponse
 */
function createAccessDeniedResponse(requiredRoles: string[]): RBACErrorResponse {
  return {
    error: 'access_denied',
    error_description: `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
    required_roles: requiredRoles,
  };
}

/**
 * Require a single role
 *
 * Middleware that checks if the authenticated user has a specific role.
 * Must be used after adminAuthMiddleware().
 *
 * @param roleName - Required role name
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * app.get('/admin/users', requireRole('system_admin'), handler);
 * ```
 */
export function requireRole(roleName: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = getAdminAuth(c);

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Authentication required. Please authenticate first.',
        },
        401
      );
    }

    // Super admins bypass all role checks
    if (hasSuperAdminPrivileges(authContext.roles)) {
      return next();
    }

    if (!authContext.roles.includes(roleName)) {
      return c.json(createAccessDeniedResponse([roleName]), 403);
    }

    return next();
  };
}

/**
 * Require any of multiple roles
 *
 * Middleware that checks if the authenticated user has at least one of the specified roles.
 * Must be used after adminAuthMiddleware().
 *
 * @param roleNames - Array of role names (user needs at least one)
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * app.get('/admin/dashboard', requireAnyRole(['system_admin', 'org_admin']), handler);
 * ```
 */
export function requireAnyRole(roleNames: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = getAdminAuth(c);

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Authentication required. Please authenticate first.',
        },
        401
      );
    }

    // Super admins bypass all role checks
    if (hasSuperAdminPrivileges(authContext.roles)) {
      return next();
    }

    const hasRequiredRole = roleNames.some((role) => authContext.roles.includes(role));

    if (!hasRequiredRole) {
      return c.json(createAccessDeniedResponse(roleNames), 403);
    }

    return next();
  };
}

/**
 * Require all specified roles
 *
 * Middleware that checks if the authenticated user has all of the specified roles.
 * Must be used after adminAuthMiddleware().
 *
 * @param roleNames - Array of role names (user needs all of them)
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * app.get('/admin/audit', requireAllRoles(['system_admin', 'audit_access']), handler);
 * ```
 */
export function requireAllRoles(roleNames: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = getAdminAuth(c);

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Authentication required. Please authenticate first.',
        },
        401
      );
    }

    // Super admins bypass all role checks
    if (hasSuperAdminPrivileges(authContext.roles)) {
      return next();
    }

    const hasAllRoles = roleNames.every((role) => authContext.roles.includes(role));

    if (!hasAllRoles) {
      const missingRoles = roleNames.filter((role) => !authContext.roles.includes(role));
      return c.json(
        {
          error: 'access_denied',
          error_description: `Missing required roles: ${missingRoles.join(', ')}`,
          required_roles: roleNames,
          missing_roles: missingRoles,
        },
        403
      );
    }

    return next();
  };
}

/**
 * Require admin role
 *
 * Convenience middleware that checks for any admin role.
 * Equivalent to: requireAnyRole(['system_admin', 'distributor_admin', 'org_admin', 'admin'])
 *
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * app.get('/admin/settings', requireAdmin(), handler);
 * ```
 */
export function requireAdmin() {
  return requireAnyRole(['system_admin', 'distributor_admin', 'org_admin', 'admin']);
}

/**
 * Require system admin role
 *
 * Convenience middleware that checks for system_admin role.
 * This is the highest privilege level.
 *
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * app.post('/admin/system/config', requireSystemAdmin(), handler);
 * ```
 */
export function requireSystemAdmin() {
  return requireRole('system_admin');
}

/**
 * Predefined role names for Phase 1 RBAC
 *
 * These match the DEFAULT_ROLES in types/rbac.ts
 * Note: super_admin is the Admin-side equivalent of system_admin (from Admin/EndUser separation)
 */
export const RBAC_ROLES = {
  SUPER_ADMIN: 'super_admin',
  SYSTEM_ADMIN: 'system_admin',
  DISTRIBUTOR_ADMIN: 'distributor_admin',
  ORG_ADMIN: 'org_admin',
  TENANT_ADMIN: 'tenant_admin',
  END_USER: 'end_user',
} as const;

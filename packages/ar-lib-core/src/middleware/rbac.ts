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
 * app.get('/admin', requireRole(ADMIN_ROLES.SUPER_ADMIN), handler);
 *
 * // Require any of multiple roles
 * app.get('/admin', requireAnyRole(ADMIN_ROLE_GROUPS.tenantAdmin), handler);
 *
 * // Require all roles
 * app.get('/super', requireAllRoles([ADMIN_ROLES.SUPER_ADMIN, 'audit_role']), handler);
 * ```
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';
import { hasGlobalAdminRole, hasGlobalMachinePermission } from './admin-auth';
import { ADMIN_ROLES, ADMIN_ROLE_GROUPS } from '../constants/admin-roles';

/**
 * Error response for RBAC failures
 */
interface RBACErrorResponse {
  error: string;
  error_description: string;
  required_roles?: readonly string[];
}

/**
 * Super admin roles that have all privileges
 *
 * These roles bypass all role checks - they are the highest privilege level.
 * Only the standard super admin role: the roles of the service's own users are another world.
 */
const SUPER_ADMIN_ROLES = ADMIN_ROLE_GROUPS.platform;

/**
 * Check if the user has super admin privileges
 *
 * Super admins bypass all role checks.
 *
 * @param roles - User's roles
 * @returns true if user has super admin privileges
 */
function hasSuperAdminPrivileges(roles: string[]): boolean {
  return roles.some((role) =>
    SUPER_ADMIN_ROLES.includes(role as (typeof SUPER_ADMIN_ROLES)[number])
  );
}

function hasMachineAdminBypass(authContext: AdminAuthContext): boolean {
  return (
    authContext.authMethod === 'machine_access_token' &&
    (authContext.permissions ?? []).some((permission) => permission === 'admin:*')
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
function createAccessDeniedResponse(requiredRoles: readonly string[]): RBACErrorResponse {
  return {
    error: 'access_denied',
    error_description: `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
    required_roles: [...requiredRoles],
  };
}

function assertRequiredRoles(roleNames: readonly string[]): void {
  if (roleNames.length === 0 || roleNames.some((role) => role.trim().length === 0)) {
    throw new Error('RBAC middleware requires at least one non-empty role');
  }
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
 * app.get('/admin/users', requireRole(ADMIN_ROLES.SUPER_ADMIN), handler);
 * ```
 */
export function requireRole(roleName: string) {
  assertRequiredRoles([roleName]);
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
    if (hasSuperAdminPrivileges(authContext.roles) || hasMachineAdminBypass(authContext)) {
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
 * app.get('/admin/dashboard', requireAnyRole(ADMIN_ROLE_GROUPS.tenantAdmin), handler);
 * ```
 */
export function requireAnyRole(roleNames: readonly string[]) {
  assertRequiredRoles(roleNames);
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
    if (hasSuperAdminPrivileges(authContext.roles) || hasMachineAdminBypass(authContext)) {
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
 * app.get('/admin/audit', requireAllRoles([ADMIN_ROLES.SUPER_ADMIN, 'audit_access']), handler);
 * ```
 */
export function requireAllRoles(roleNames: readonly string[]) {
  assertRequiredRoles(roleNames);
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
    if (hasSuperAdminPrivileges(authContext.roles) || hasMachineAdminBypass(authContext)) {
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
 * Require system admin role
 *
 * Convenience middleware for platform-wide operations: the role has to come from a global
 * assignment. `authContext.roles` adds up every assignment that applies to the request, so a
 * super admin role held only for one tenant is in it too, and must not open an
 * operation that takes effect across tenants.
 *
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * app.post('/admin/system/config', requireSystemAdmin(), handler);
 * ```
 */
export function requireSystemAdmin() {
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

    // A machine token passes on `admin:*` only when its scope is global (so the permission is a
    // global one); `admin:*` limited to some tenants is the tenants' own.
    if (
      hasGlobalAdminRole(authContext, SUPER_ADMIN_ROLES) ||
      hasGlobalMachinePermission(authContext, 'admin:*')
    ) {
      return next();
    }

    return c.json(createAccessDeniedResponse([ADMIN_ROLES.SUPER_ADMIN]), 403);
  };
}

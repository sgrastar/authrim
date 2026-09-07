/**
 * Admin Session Management Handlers
 *
 * Provides session status and logout functionality for Admin UI.
 * These endpoints are designed for the Admin UI authentication flow.
 *
 * Endpoints:
 * - GET /api/admin/sessions/me - Check current admin session status
 * - POST /api/admin/logout - Admin logout with Origin check
 */

import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  parseAllowedOrigins,
  isAllowedOrigin,
  getLogger,
  type DatabaseAdapter,
  AdminSessionRepository,
  requireDedicatedAdminDatabaseAdapter,
  // Event System
  publishEvent,
  USER_EVENTS,
  SESSION_EVENTS,
  type SessionEventData,
  type UserEventData,
  // Cookie Configuration
  getAdminCookieSameSite,
} from '@authrim/ar-lib-core';
import { getCanonicalTenantBaseUrl } from './request-issuer';

interface AdminSessionRoleRow {
  id: string;
  name: string;
  permissions_json: string;
  hierarchy_level: number;
  inherits_from: string | null;
  scope_type?: string;
  scope_id?: string | null;
  has_global_scope?: number | string;
}

function parsePermissionsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is string => typeof permission === 'string')
      : [];
  } catch {
    return [];
  }
}

function collectInheritedRolePermissions(
  role: AdminSessionRoleRow,
  rolesById: Map<string, AdminSessionRoleRow>,
  permissions: Set<string>,
  visitedIds: Set<string> = new Set()
): void {
  if (visitedIds.has(role.id)) {
    return;
  }
  visitedIds.add(role.id);

  for (const permission of parsePermissionsJson(role.permissions_json)) {
    permissions.add(permission);
  }

  if (!role.inherits_from) {
    return;
  }
  const parent = rolesById.get(role.inherits_from);
  if (parent) {
    collectInheritedRolePermissions(parent, rolesById, permissions, visitedIds);
  }
}

/**
 * Check current admin session status
 * GET /api/admin/sessions/me
 *
 * Returns:
 * - 200: Authenticated admin user with user info
 * - 401: No valid session found (not authenticated)
 * - 403: Session exists but user has no admin role
 */
export async function adminSessionStatusHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-SESSION');

  try {
    // Get session from admin-specific cookie (separate from regular user sessions)
    const sessionId = getCookie(c, 'authrim_admin_session');

    if (!sessionId) {
      return c.json(
        {
          error: 'not_authenticated',
          error_description: 'No session found',
        },
        401
      );
    }

    // DB_ADMIN is required for admin sessions
    if (!c.env.DB_ADMIN) {
      log.error('DB_ADMIN not configured', { action: 'status' });
      return c.json(
        {
          error: 'server_error',
          error_description: 'Admin database not configured',
        },
        500
      );
    }

    // Get session from D1 admin_sessions table
    const adminAdapter: DatabaseAdapter = requireDedicatedAdminDatabaseAdapter(
      c.env,
      'admin-session'
    );
    const tenantId = getTenantIdFromContext(c);
    const adminSessionRepo = new AdminSessionRepository(adminAdapter, tenantId);
    const session = await adminSessionRepo.getSession(sessionId);

    if (!session) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    // Check admin role from admin_role_assignments (DB_ADMIN), scoped to the session tenant.
    const nowSeconds = Math.floor(Date.now() / 1000);

    const rolesResult = await adminAdapter.query<AdminSessionRoleRow>(
      `SELECT
         r.id,
         r.name,
         r.permissions_json,
         r.hierarchy_level,
         r.inherits_from,
         MAX(CASE WHEN ra.scope_type = 'global' THEN 1 ELSE 0 END) as has_global_scope
       FROM admin_role_assignments ra
       JOIN admin_roles r ON ra.admin_role_id = r.id
       WHERE ra.admin_user_id = ?
         AND ra.tenant_id = ?
         AND (
           r.tenant_id = ra.tenant_id
           OR (r.tenant_id = 'default' AND r.is_system = 1)
         )
         AND (
           ra.scope_type = 'global'
           OR (
             ra.scope_type = 'tenant'
             AND (
               ra.scope_id = ?
               OR (ra.scope_id IS NULL AND ? = ra.tenant_id)
             )
           )
         )
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       GROUP BY r.id, r.name, r.permissions_json, r.hierarchy_level, r.inherits_from
       ORDER BY r.name ASC`,
      [session.admin_user_id, session.tenant_id, session.tenant_id, session.tenant_id, nowSeconds]
    );
    const allTenantRoles = await adminAdapter.query<AdminSessionRoleRow>(
      `SELECT id, name, permissions_json, hierarchy_level, inherits_from
         FROM admin_roles
        WHERE tenant_id = ?
           OR (tenant_id = 'default' AND is_system = 1)`,
      [session.tenant_id]
    );
    const rolesById = new Map<string, AdminSessionRoleRow>();
    for (const role of allTenantRoles) {
      rolesById.set(role.id, role);
    }

    const roles = rolesResult.map((r) => r.name);
    const permissions = new Set<string>();
    for (const role of rolesResult) {
      collectInheritedRolePermissions(role, rolesById, permissions);
    }

    // Check if user has any admin role
    const adminRoles = ['super_admin', 'security_admin', 'admin', 'operator', 'support', 'viewer'];
    const hasAdminRole = roles.some((role) => adminRoles.includes(role));
    const isPlatformAdmin = rolesResult.some(
      (role) => role.scope_type === 'global' || Number(role.has_global_scope ?? 0) > 0
    );

    if (!hasAdminRole) {
      return c.json(
        {
          error: 'forbidden',
          error_description: 'You do not have admin permissions',
        },
        403
      );
    }

    // Fetch admin user info (email, name, last_login_at) from admin_users table
    let userEmail: string | undefined;
    let userName: string | undefined;
    let lastLoginAt: number | null = null;

    try {
      const adminUser = await adminAdapter.queryOne<{
        email: string;
        name: string | null;
        last_login_at: number | null;
        is_active: number | string | boolean;
        status: string;
      }>(
        `SELECT email, name, last_login_at, is_active, status
           FROM admin_users
          WHERE id = ? AND tenant_id = ?`,
        [session.admin_user_id, session.tenant_id]
      );
      if (!adminUser || Number(adminUser.is_active) !== 1 || adminUser.status !== 'active') {
        return c.json(
          {
            error: 'session_expired',
            error_description: 'Session has expired or is invalid',
          },
          401
        );
      }
      userEmail = adminUser.email;
      userName = adminUser.name ?? undefined;
      lastLoginAt = adminUser.last_login_at;
    } catch (error) {
      log.warn('Failed to fetch admin user info', { action: 'fetch_admin_user' });
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to check session status',
        },
        500
      );
    }

    return c.json({
      active: true,
      user_id: session.admin_user_id,
      tenant_id: session.tenant_id,
      email: userEmail,
      name: userName,
      roles,
      permissions: Array.from(permissions).sort(),
      admin_scope: isPlatformAdmin ? 'platform' : 'tenant',
      is_platform_admin: isPlatformAdmin,
      expires_at: session.expires_at,
      created_at: session.created_at,
      last_login_at: lastLoginAt,
    });
  } catch (error) {
    log.error('Admin session status error', { action: 'status' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check session status',
      },
      500
    );
  }
}

/**
 * Admin logout handler
 * POST /api/admin/logout
 *
 * Security:
 * - Requires Origin header check (CSRF protection for POST)
 * - Invalidates session in SessionStore
 * - Clears authrim_session cookie
 *
 * Returns:
 * - 200: Logout successful
 * - 403: Origin not allowed
 */
export async function adminLogoutHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-SESSION');

  try {
    // Origin/Referer check for CSRF protection
    // Legitimate browser POST requests always include Origin or Referer headers.
    // Skipping this check when headers are absent would allow CSRF attacks.
    const origin = c.req.header('Origin');
    const allowedOriginsEnv =
      c.env.ALLOWED_ORIGINS || getCanonicalTenantBaseUrl(c.env, getTenantIdFromContext(c));
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

    if (origin) {
      // Primary: validate Origin header
      if (!isAllowedOrigin(origin, allowedOrigins)) {
        log.warn('Admin logout rejected: Origin not allowed', { origin });
        return c.json(
          {
            error: 'forbidden',
            error_description: 'Origin not allowed',
          },
          403
        );
      }
    } else {
      // Fallback: validate Referer header when Origin is absent
      const referer = c.req.header('Referer');
      if (referer) {
        try {
          const refererOrigin = new URL(referer).origin;
          if (!isAllowedOrigin(refererOrigin, allowedOrigins)) {
            log.warn('Admin logout rejected: Referer origin not allowed', { referer });
            return c.json(
              {
                error: 'forbidden',
                error_description: 'Referer origin not allowed',
              },
              403
            );
          }
        } catch {
          log.warn('Admin logout rejected: Invalid Referer header', { referer });
          return c.json(
            {
              error: 'forbidden',
              error_description: 'Invalid Referer header',
            },
            403
          );
        }
      } else {
        // Neither Origin nor Referer present - reject
        // Browser POST requests always include at least one of these headers
        log.warn('Admin logout rejected: Missing Origin and Referer headers');
        return c.json(
          {
            error: 'forbidden',
            error_description: 'Origin or Referer header is required',
          },
          403
        );
      }
    }

    // Get session from admin-specific cookie (separate from regular user sessions)
    const sessionId = getCookie(c, 'authrim_admin_session');

    if (sessionId && c.env.DB_ADMIN) {
      try {
        // Get session from D1 admin_sessions for event publishing before deletion
        const adminAdapter: DatabaseAdapter = requireDedicatedAdminDatabaseAdapter(
          c.env,
          'admin-session'
        );
        const tenantId = getTenantIdFromContext(c);
        const adminSessionRepo = new AdminSessionRepository(adminAdapter, tenantId);
        const session = await adminSessionRepo.getSessionIncludingExpired(sessionId);
        const userId = session?.admin_user_id;

        // Delete session from D1
        const deleted = await adminSessionRepo.deleteSession(sessionId);

        if (deleted && userId) {
          // Publish user.logout event (non-blocking)
          publishEvent(c, {
            type: USER_EVENTS.LOGOUT,
            tenantId,
            data: {
              sessionId,
              userId,
              reason: 'logout',
            } satisfies UserEventData,
          }).catch((err) => {
            log.error('Failed to publish user.logout event', { action: 'Event' }, err as Error);
          });

          // Publish session.user.destroyed event (non-blocking)
          publishEvent(c, {
            type: SESSION_EVENTS.USER_DESTROYED,
            tenantId,
            data: {
              sessionId,
              userId,
              reason: 'logout',
            } satisfies SessionEventData,
          }).catch((err) => {
            log.error(
              'Failed to publish session.user.destroyed event',
              { action: 'Event' },
              err as Error
            );
          });
        }

        log.info('Admin logout completed', {
          sessionId: sessionId.substring(0, 8) + '...',
          deleted,
        });
      } catch (error) {
        log.warn('Failed to invalidate session', {
          sessionId: sessionId.substring(0, 8) + '...',
          error: (error as Error).message,
        });
      }
    }

    // Clear session cookie (SameSite must match original setting)
    setCookie(c, 'authrim_admin_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getAdminCookieSameSite(c.env),
      maxAge: 0,
    });

    return c.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    log.error('Admin logout error', { action: 'logout' }, error as Error);

    // Still try to clear cookie on error
    setCookie(c, 'authrim_admin_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getAdminCookieSameSite(c.env),
      maxAge: 0,
    });

    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process logout request',
      },
      500
    );
  }
}

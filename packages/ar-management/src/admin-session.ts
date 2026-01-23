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
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  createPIIContextFromHono,
  getTenantIdFromContext,
  createAuthContextFromHono,
  parseAllowedOrigins,
  isAllowedOrigin,
  getLogger,
  D1Adapter,
  type DatabaseAdapter,
  // Event System
  publishEvent,
  USER_EVENTS,
  SESSION_EVENTS,
  type SessionEventData,
  type UserEventData,
  // Cookie Configuration
  getAdminCookieSameSite,
} from '@authrim/ar-lib-core';

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

    // Check session format
    if (!isShardedSessionId(sessionId)) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    // Get session from SessionStore
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    // Check if session is expired
    if (session.expiresAt <= Date.now()) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Session has expired',
        },
        401
      );
    }

    // Check admin role from role_assignments
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const now = Math.floor(Date.now() / 1000); // UNIX seconds for role_assignments

    const rolesResult = await coreAdapter.query<{ name: string }>(
      `SELECT DISTINCT r.name
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY r.name ASC`,
      [session.userId, now]
    );

    const roles = rolesResult.map((r) => r.name);

    // Check if user has any admin role
    const adminRoles = ['system_admin', 'distributor_admin', 'org_admin', 'admin'];
    const hasAdminRole = roles.some((role) => adminRoles.includes(role));

    if (!hasAdminRole) {
      return c.json(
        {
          error: 'forbidden',
          error_description: 'You do not have admin permissions',
        },
        403
      );
    }

    // Fetch user PII
    let userEmail: string | undefined;
    let userName: string | undefined;

    if (c.env.DB_PII) {
      try {
        const tenantId = getTenantIdFromContext(c);
        const piiCtx = createPIIContextFromHono(c, tenantId);
        const userPII = await piiCtx.piiRepositories.userPII.findById(session.userId);

        if (userPII) {
          userEmail = userPII.email;
          userName = userPII.name ?? undefined;
        }
      } catch (error) {
        log.warn('Failed to fetch user PII for admin session status', { action: 'fetch_user_pii' });
      }
    }

    // Fetch last_login_at from admin_users table (DB_ADMIN)
    let lastLoginAt: number | null = null;

    if (c.env.DB_ADMIN) {
      try {
        const adminAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB_ADMIN });
        const adminUser = await adminAdapter.queryOne<{ last_login_at: number | null }>(
          'SELECT last_login_at FROM admin_users WHERE id = ? AND is_active = 1',
          [session.userId]
        );
        if (adminUser) {
          lastLoginAt = adminUser.last_login_at;
        }
      } catch (error) {
        log.warn('Failed to fetch last_login_at from admin_users', { action: 'fetch_admin_user' });
      }
    }

    return c.json({
      active: true,
      session_id: session.id,
      user_id: session.userId,
      email: userEmail,
      name: userName,
      roles,
      expires_at: session.expiresAt,
      created_at: session.createdAt,
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
    // Origin check for CSRF protection
    const origin = c.req.header('Origin');
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

    // Only check origin if it's provided (some browsers may not send it)
    if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
      log.warn('Admin logout rejected: Origin not allowed', { origin });
      return c.json(
        {
          error: 'forbidden',
          error_description: 'Origin not allowed',
        },
        403
      );
    }

    // Get session from admin-specific cookie (separate from regular user sessions)
    const sessionId = getCookie(c, 'authrim_admin_session');

    if (sessionId && isShardedSessionId(sessionId)) {
      try {
        // Get user_id for event publishing before deletion
        let userId: string | undefined;
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
        const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
        if (session) {
          userId = session.userId;
        }

        // Invalidate session
        const deleted = await sessionStore.invalidateSessionRpc(sessionId);

        if (deleted && userId) {
          const tenantId = getTenantIdFromContext(c);

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
          sessionId: sessionId.substring(0, 30),
          deleted,
        });
      } catch (error) {
        log.warn('Failed to invalidate session', {
          sessionId,
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

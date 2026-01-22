/**
 * Admin Authentication Middleware
 *
 * This middleware provides dual authentication for admin endpoints:
 * 1. Bearer Token authentication (for headless/API usage)
 * 2. Session-based authentication (for UI usage)
 *
 * Security features:
 * - Constant-time comparison to prevent timing attacks
 * - Admin role verification for session auth
 * - Sets adminAuth context for downstream handlers
 * - Configurable role requirements via requireRoles option
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';
import { D1Adapter } from '../db/adapters/d1-adapter';
import type { DatabaseAdapter } from '../db/adapter';
import { createLogger } from '../utils/logger';
import { getSessionStoreBySessionId, isRegionShardedSessionId } from '../utils/session-helper';
import type { Session } from '../durable-objects/SessionStore';

const log = createLogger().module('ADMIN-AUTH');

/**
 * Options for admin authentication middleware
 */
export interface AdminAuthOptions {
  /**
   * Required roles for access. User must have at least one of these roles.
   * Default: ['system_admin', 'distributor_admin', 'org_admin', 'admin']
   */
  requireRoles?: string[];
}

/**
 * Constant-time string comparison to prevent timing attacks
 *
 * This function compares two strings in constant time, regardless of
 * where they differ. This prevents attackers from using timing information
 * to guess valid tokens character by character.
 *
 * @param a - First string
 * @param b - Second string
 * @returns true if strings are equal, false otherwise
 */
function constantTimeCompare(a: string, b: string): boolean {
  // If lengths differ, still iterate through both to maintain constant time
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Authenticate using Bearer token
 *
 * Checks token against ADMIN_API_SECRET or KEY_MANAGER_SECRET
 *
 * @param c - Hono context
 * @param token - Bearer token from Authorization header
 * @returns AdminAuthContext if valid, null otherwise
 */
async function authenticateBearer(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<AdminAuthContext | null> {
  const env = c.env;

  // Check against ADMIN_API_SECRET first
  // ADMIN_API_SECRET grants system_admin role (highest privilege)
  if (env.ADMIN_API_SECRET && constantTimeCompare(token, env.ADMIN_API_SECRET)) {
    return {
      userId: 'system',
      authMethod: 'bearer',
      roles: ['system_admin', 'admin', 'system'],
    };
  }

  // Fallback to KEY_MANAGER_SECRET for backward compatibility
  // KEY_MANAGER_SECRET also grants system_admin role
  if (env.KEY_MANAGER_SECRET && constantTimeCompare(token, env.KEY_MANAGER_SECRET)) {
    return {
      userId: 'system',
      authMethod: 'bearer',
      roles: ['system_admin', 'admin', 'system'],
    };
  }

  return null;
}

/**
 * Authenticate using session cookie
 *
 * Validates session and checks for admin role in role_assignments table.
 * Phase 1 RBAC: Uses role_assignments with scope support.
 *
 * @param c - Hono context
 * @param sessionId - Session ID from cookie
 * @param requiredRoles - Roles required for access (user must have at least one)
 * @returns AdminAuthContext if valid, null otherwise
 */
async function authenticateSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  requiredRoles: string[] = ['system_admin', 'distributor_admin', 'org_admin', 'admin']
): Promise<AdminAuthContext | null> {
  try {
    // Validate session ID format (must be region-sharded format)
    if (!isRegionShardedSessionId(sessionId)) {
      log.warn('Invalid session ID format', { sessionId: sessionId.substring(0, 30) });
      return null;
    }

    // Fetch session from SessionStore Durable Object
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session) {
      return null;
    }

    // Check if session is expired (sessions use milliseconds)
    if (session.expiresAt <= Date.now()) {
      return null;
    }

    // Create adapter for database access (for role lookup)
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const now = Math.floor(Date.now() / 1000); // UNIX seconds for role_assignments

    // Fetch all effective roles for this user from role_assignments
    // Includes roles that are:
    // 1. Not expired (expires_at IS NULL or expires_at > now)
    // 2. Either global scope or any scope (we're checking admin access)
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

    // Check if user has any of the required roles
    const hasRequiredRole = roles.some((role) => requiredRoles.includes(role));

    if (!hasRequiredRole) {
      return null;
    }

    // Fetch user type and primary organization (Phase 1 RBAC extensions)
    // PII/Non-PII DB separation: uses users_core (user_type is stored in Core DB)
    const userInfo = await coreAdapter.queryOne<{
      user_type: string | null;
      org_id: string | null;
    }>(
      `SELECT u.user_type, m.org_id
       FROM users_core u
       LEFT JOIN subject_org_membership m ON u.id = m.subject_id AND m.is_primary = 1
       WHERE u.id = ? AND u.is_active = 1`,
      [session.userId]
    );

    return {
      userId: session.userId,
      authMethod: 'session',
      roles,
      // Phase 1 RBAC extensions (optional fields)
      user_type: (userInfo?.user_type as AdminAuthContext['user_type']) || undefined,
      org_id: userInfo?.org_id || undefined,
    };
  } catch (error) {
    log.error('Session authentication failed', {}, error as Error);
    return null;
  }
}

/**
 * Admin authentication middleware
 *
 * Supports dual authentication:
 * - Bearer Token: Authorization: Bearer <token>
 * - Session Cookie: authrim_admin_session=<id>
 *
 * Sets adminAuth context on successful authentication:
 * - c.get('adminAuth') => { userId, authMethod, roles }
 *
 * Returns 401 if authentication fails.
 *
 * @param options - Optional configuration for role requirements
 */
export function adminAuthMiddleware(options: AdminAuthOptions = {}) {
  const requiredRoles = options.requireRoles || [
    'system_admin',
    'distributor_admin',
    'org_admin',
    'admin',
  ];

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Try Bearer token authentication first
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const authContext = await authenticateBearer(c, token);
      if (authContext) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).set('adminAuth', authContext);
        return next();
      }
    }

    // Try session-based authentication as fallback
    // Cookie name: authrim_admin_session (separate from regular user sessions)
    const cookieHeader = c.req.header('Cookie');
    if (cookieHeader) {
      const sessionMatch = cookieHeader.match(/authrim_admin_session=([^;]+)/);
      if (sessionMatch) {
        // URL decode the session ID (Safari and some browsers encode special characters like ':')
        // Use try-catch to handle malformed URL-encoded strings gracefully
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(sessionMatch[1]);
        } catch {
          // Invalid URL encoding - reject silently
          return c.json(
            {
              error: 'invalid_token',
              error_description:
                'Admin authentication required. Use Bearer token or valid session.',
            },
            401
          );
        }
        const authContext = await authenticateSession(c, sessionId, requiredRoles);
        if (authContext) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c as any).set('adminAuth', authContext);
          return next();
        }
      }
    }

    // Authentication failed
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'Admin authentication required. Use Bearer token or valid session.',
      },
      401
    );
  };
}

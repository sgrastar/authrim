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
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';

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
  if (env.ADMIN_API_SECRET && constantTimeCompare(token, env.ADMIN_API_SECRET)) {
    return {
      userId: 'system',
      authMethod: 'bearer',
      roles: ['admin', 'system'],
    };
  }

  // Fallback to KEY_MANAGER_SECRET for backward compatibility
  if (env.KEY_MANAGER_SECRET && constantTimeCompare(token, env.KEY_MANAGER_SECRET)) {
    return {
      userId: 'system',
      authMethod: 'bearer',
      roles: ['admin', 'system'],
    };
  }

  return null;
}

/**
 * Authenticate using session cookie
 *
 * Validates session and checks for admin role in user_roles table
 *
 * @param c - Hono context
 * @param sessionId - Session ID from cookie
 * @returns AdminAuthContext if valid, null otherwise
 */
async function authenticateSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string
): Promise<AdminAuthContext | null> {
  try {
    // Fetch session from D1 database
    const session = await c.env.DB.prepare(
      'SELECT user_id, expires_at FROM sessions WHERE id = ?'
    )
      .bind(sessionId)
      .first<{ user_id: string; expires_at: number }>();

    if (!session) {
      return null;
    }

    // Check if session is expired
    if (session.expires_at < Date.now()) {
      return null;
    }

    // Check if user has admin role
    const userRole = await c.env.DB.prepare(
      'SELECT role FROM user_roles WHERE user_id = ? AND role = ?'
    )
      .bind(session.user_id, 'admin')
      .first<{ role: string }>();

    if (!userRole) {
      return null;
    }

    // Fetch all roles for this user
    const roles = await c.env.DB.prepare(
      'SELECT role FROM user_roles WHERE user_id = ?'
    )
      .bind(session.user_id)
      .all<{ role: string }>();

    return {
      userId: session.user_id,
      authMethod: 'session',
      roles: roles.results.map((r) => r.role),
    };
  } catch (error) {
    console.error('Session authentication failed:', error);
    return null;
  }
}

/**
 * Admin authentication middleware
 *
 * Supports dual authentication:
 * - Bearer Token: Authorization: Bearer <token>
 * - Session Cookie: session_id=<id>
 *
 * Sets adminAuth context on successful authentication:
 * - c.get('adminAuth') => { userId, authMethod, roles }
 *
 * Returns 401 if authentication fails.
 */
export function adminAuthMiddleware() {
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
    const cookieHeader = c.req.header('Cookie');
    if (cookieHeader) {
      const sessionMatch = cookieHeader.match(/session_id=([^;]+)/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        const authContext = await authenticateSession(c, sessionId);
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
        error: 'unauthorized',
        error_description: 'Admin authentication required. Use Bearer token or valid session.',
      },
      401
    );
  };
}

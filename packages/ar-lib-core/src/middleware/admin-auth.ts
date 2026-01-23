/**
 * Admin Authentication Middleware
 *
 * This middleware provides dual authentication for admin endpoints:
 * 1. Bearer Token authentication (for headless/API usage)
 * 2. Session-based authentication (for UI usage)
 *
 * Admin/EndUser Separation:
 * - Admin users are stored in DB_ADMIN (separate from EndUsers in DB_CORE)
 * - Admin sessions are stored in admin_sessions table (not Durable Objects)
 * - Admin roles/permissions are from admin_role_assignments + admin_roles
 *
 * Security features:
 * - Constant-time comparison to prevent timing attacks
 * - Admin role verification for session auth
 * - Sets adminAuth context for downstream handlers
 * - Configurable role requirements via requireRoles option
 * - IP restriction support (via admin_ip_allowlist)
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';
import { D1Adapter } from '../db/adapters/d1-adapter';
import type { DatabaseAdapter } from '../db/adapter';
import { createLogger } from '../utils/logger';
import { hasAdminPermission } from '../types/admin-user';

const log = createLogger().module('ADMIN-AUTH');

/**
 * Options for admin authentication middleware
 */
export interface AdminAuthOptions {
  /**
   * Required roles for access. User must have at least one of these roles.
   * Default: ['super_admin', 'security_admin', 'admin', 'support', 'viewer']
   */
  requireRoles?: string[];

  /**
   * Required permissions for access. User must have all of these permissions.
   * If specified, this takes precedence over requireRoles.
   * Example: ['admin:users:read', 'admin:users:write']
   */
  requirePermissions?: string[];

  /**
   * Skip IP allowlist check (default: false)
   * Set to true for endpoints that need to work from any IP (e.g., initial setup)
   */
  skipIpCheck?: boolean;

  /**
   * Require MFA to be verified for this session (default: false)
   */
  requireMfa?: boolean;
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
      roles: ['super_admin', 'system_admin', 'admin', 'system'],
      tenantId: 'default',
      permissions: ['*'], // Full access
      hierarchyLevel: 100, // Highest level
      mfaVerified: true, // Bearer token bypasses MFA
    };
  }

  // Fallback to KEY_MANAGER_SECRET for backward compatibility
  // KEY_MANAGER_SECRET also grants system_admin role
  if (env.KEY_MANAGER_SECRET && constantTimeCompare(token, env.KEY_MANAGER_SECRET)) {
    return {
      userId: 'system',
      authMethod: 'bearer',
      roles: ['super_admin', 'system_admin', 'admin', 'system'],
      tenantId: 'default',
      permissions: ['*'],
      hierarchyLevel: 100,
      mfaVerified: true,
    };
  }

  return null;
}

/**
 * Authenticate using session cookie
 *
 * Validates session from DB_ADMIN and checks for admin roles.
 * Uses admin_sessions and admin_role_assignments tables.
 *
 * @param c - Hono context
 * @param sessionId - Session ID from cookie
 * @param requiredRoles - Roles required for access (user must have at least one)
 * @returns AdminAuthContext if valid, null otherwise
 */
async function authenticateSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  requiredRoles: string[] = ['super_admin', 'security_admin', 'admin', 'support', 'viewer']
): Promise<AdminAuthContext | null> {
  try {
    // Use DB_ADMIN for Admin/EndUser separation
    // If DB_ADMIN is not available, fall back to DB (for backward compatibility during migration)
    const db = c.env.DB_ADMIN ?? c.env.DB;
    const adminAdapter: DatabaseAdapter = new D1Adapter({ db });
    const now = Date.now();

    // Fetch session from admin_sessions
    const session = await adminAdapter.queryOne<{
      id: string;
      tenant_id: string;
      admin_user_id: string;
      expires_at: number;
      mfa_verified: number;
    }>('SELECT * FROM admin_sessions WHERE id = ? AND expires_at > ?', [sessionId, now]);

    if (!session) {
      log.debug('Admin session not found or expired', { sessionId: sessionId.substring(0, 8) });
      return null;
    }

    // Fetch admin user
    const adminUser = await adminAdapter.queryOne<{
      id: string;
      tenant_id: string;
      email: string;
      is_active: number;
      status: string;
    }>('SELECT * FROM admin_users WHERE id = ? AND is_active = 1', [session.admin_user_id]);

    if (!adminUser) {
      log.debug('Admin user not found or inactive', { userId: session.admin_user_id });
      return null;
    }

    // Check if account is locked or suspended
    if (adminUser.status !== 'active') {
      log.warn('Admin account is not active', { userId: adminUser.id, status: adminUser.status });
      return null;
    }

    // Fetch all effective roles for this admin user from admin_role_assignments
    const rolesResult = await adminAdapter.query<{
      name: string;
      permissions_json: string;
      hierarchy_level: number;
    }>(
      `SELECT DISTINCT r.name, r.permissions_json, r.hierarchy_level
       FROM admin_role_assignments ra
       JOIN admin_roles r ON ra.admin_role_id = r.id
       WHERE ra.admin_user_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY r.hierarchy_level DESC`,
      [session.admin_user_id, Math.floor(now / 1000)]
    );

    const roles: string[] = [];
    const allPermissions = new Set<string>();
    let maxHierarchyLevel = 0;

    for (const role of rolesResult) {
      roles.push(role.name);
      maxHierarchyLevel = Math.max(maxHierarchyLevel, role.hierarchy_level);

      // Parse permissions JSON
      try {
        const perms = JSON.parse(role.permissions_json);
        if (Array.isArray(perms)) {
          for (const perm of perms) {
            allPermissions.add(perm);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Check if user has any of the required roles
    const hasRequiredRole = roles.some((role) => requiredRoles.includes(role));

    if (!hasRequiredRole) {
      log.debug('Admin user lacks required roles', {
        userId: adminUser.id,
        userRoles: roles,
        requiredRoles,
      });
      return null;
    }

    // Update session activity (fire and forget)
    adminAdapter
      .execute('UPDATE admin_sessions SET last_activity_at = ? WHERE id = ?', [now, sessionId])
      .catch(() => {
        // Ignore errors
      });

    return {
      userId: adminUser.id,
      authMethod: 'session',
      roles,
      tenantId: session.tenant_id,
      email: adminUser.email,
      permissions: Array.from(allPermissions),
      hierarchyLevel: maxHierarchyLevel,
      mfaVerified: Boolean(session.mfa_verified),
      sessionId: session.id,
    };
  } catch (error) {
    log.error('Admin session authentication failed', {}, error as Error);
    return null;
  }
}

/**
 * Check if client IP is allowed (from admin_ip_allowlist)
 *
 * @param c - Hono context
 * @param tenantId - Tenant ID
 * @returns true if allowed (or if no allowlist entries exist)
 */
async function isIpAllowed(c: Context<{ Bindings: Env }>, tenantId: string): Promise<boolean> {
  try {
    // Get client IP from Cloudflare header
    const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();

    if (!clientIp) {
      log.warn('Could not determine client IP for allowlist check');
      return true; // Allow if we can't determine IP (fail open)
    }

    // Use DB_ADMIN for IP allowlist
    const db = c.env.DB_ADMIN ?? c.env.DB;
    const adminAdapter: DatabaseAdapter = new D1Adapter({ db });

    // Check if any enabled entries exist
    const entries = await adminAdapter.query<{
      ip_range: string;
      ip_version: number;
    }>(
      'SELECT ip_range, ip_version FROM admin_ip_allowlist WHERE tenant_id = ? AND enabled = 1',
      [tenantId]
    );

    // If no entries, allow all IPs (default behavior)
    if (entries.length === 0) {
      return true;
    }

    // Check if client IP matches any entry
    for (const entry of entries) {
      if (ipMatches(clientIp, entry.ip_range)) {
        return true;
      }
    }

    log.warn('Client IP not in allowlist', { clientIp, tenantId });
    return false;
  } catch (error) {
    log.error('IP allowlist check failed', {}, error as Error);
    return true; // Fail open on error (to prevent lockout)
  }
}

/**
 * Check if an IP matches a range (single IP or CIDR)
 */
function ipMatches(ip: string, range: string): boolean {
  // Exact match
  if (ip === range) {
    return true;
  }

  // CIDR match
  if (range.includes('/')) {
    return ipMatchesCidr(ip, range);
  }

  return false;
}

/**
 * Check if an IP matches a CIDR range (IPv4 only for now)
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixLengthStr] = cidr.split('/');
  const prefixLength = parseInt(prefixLengthStr, 10);

  if (isNaN(prefixLength)) {
    return false;
  }

  // IPv4 handling
  if (!ip.includes(':') && !rangeIp.includes(':')) {
    const ipNum = ipv4ToNumber(ip);
    const rangeNum = ipv4ToNumber(rangeIp);

    if (ipNum === null || rangeNum === null) {
      return false;
    }

    const mask = (-1 << (32 - prefixLength)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }

  // IPv6 - simplified check (full implementation in repository)
  if (ip.includes(':') && rangeIp.includes(':')) {
    // For now, just check prefix match
    const ipParts = ip.split(':');
    const rangeParts = rangeIp.split(':');
    const partsToCheck = Math.ceil(prefixLength / 16);

    for (let i = 0; i < partsToCheck && i < ipParts.length && i < rangeParts.length; i++) {
      if (ipParts[i] !== rangeParts[i]) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Convert IPv4 address to 32-bit number
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) {
      return null;
    }
    result = (result << 8) | num;
  }

  return result >>> 0;
}

/**
 * Admin authentication middleware
 *
 * Supports dual authentication:
 * - Bearer Token: Authorization: Bearer <token>
 * - Session Cookie: authrim_admin_session=<id>
 *
 * Sets adminAuth context on successful authentication:
 * - c.get('adminAuth') => { userId, authMethod, roles, permissions, ... }
 *
 * Returns 401 if authentication fails.
 * Returns 403 if IP is not allowed or MFA required but not verified.
 *
 * @param options - Optional configuration for role/permission requirements
 */
export function adminAuthMiddleware(options: AdminAuthOptions = {}) {
  const requiredRoles = options.requireRoles || [
    'super_admin',
    'security_admin',
    'admin',
    'support',
    'viewer',
  ];

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    let authContext: AdminAuthContext | null = null;

    // Try Bearer token authentication first
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      authContext = await authenticateBearer(c, token);
    }

    // Try session-based authentication as fallback
    if (!authContext) {
      const cookieHeader = c.req.header('Cookie');
      if (cookieHeader) {
        const sessionMatch = cookieHeader.match(/authrim_admin_session=([^;]+)/);
        if (sessionMatch) {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(sessionMatch[1]);
          } catch {
            return c.json(
              {
                error: 'invalid_token',
                error_description:
                  'Admin authentication required. Use Bearer token or valid session.',
              },
              401
            );
          }
          authContext = await authenticateSession(c, sessionId, requiredRoles);
        }
      }
    }

    // Authentication failed
    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required. Use Bearer token or valid session.',
        },
        401
      );
    }

    // Check IP allowlist (unless skipped)
    if (!options.skipIpCheck && authContext.authMethod === 'session') {
      const tenantId = authContext.tenantId || 'default';
      const ipAllowed = await isIpAllowed(c, tenantId);
      if (!ipAllowed) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Access denied. Your IP address is not allowed.',
          },
          403
        );
      }
    }

    // Check MFA requirement
    if (options.requireMfa && !authContext.mfaVerified) {
      return c.json(
        {
          error: 'mfa_required',
          error_description: 'Multi-factor authentication is required for this operation.',
        },
        403
      );
    }

    // Check required permissions (if specified)
    if (options.requirePermissions && options.requirePermissions.length > 0) {
      const userPermissions = authContext.permissions || [];
      const hasAllPermissions = options.requirePermissions.every((perm) =>
        hasAdminPermission(userPermissions, perm)
      );

      if (!hasAllPermissions) {
        log.debug('Admin lacks required permissions', {
          userId: authContext.userId,
          requiredPermissions: options.requirePermissions,
          userPermissions,
        });
        return c.json(
          {
            error: 'insufficient_permissions',
            error_description: 'You do not have the required permissions for this operation.',
          },
          403
        );
      }
    }

    // Set authenticated context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('adminAuth', authContext);
    return next();
  };
}

/**
 * Require specific permissions for an endpoint
 *
 * Use this after adminAuthMiddleware to check for specific permissions.
 *
 * @example
 * app.delete('/api/admin/users/:id',
 *   adminAuthMiddleware(),
 *   requireAdminPermissions(['admin:users:delete']),
 *   deleteUserHandler
 * )
 */
export function requireAdminPermissions(permissions: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authContext = (c as any).get('adminAuth') as AdminAuthContext | undefined;

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required.',
        },
        401
      );
    }

    const userPermissions = authContext.permissions || [];
    const hasAllPermissions = permissions.every((perm) =>
      hasAdminPermission(userPermissions, perm)
    );

    if (!hasAllPermissions) {
      return c.json(
        {
          error: 'insufficient_permissions',
          error_description: 'You do not have the required permissions for this operation.',
        },
        403
      );
    }

    return next();
  };
}

/**
 * Require MFA verification for an endpoint
 *
 * Use this after adminAuthMiddleware to require MFA.
 *
 * @example
 * app.post('/api/admin/security/rotate-keys',
 *   adminAuthMiddleware(),
 *   requireMfa(),
 *   rotateKeysHandler
 * )
 */
export function requireMfa() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authContext = (c as any).get('adminAuth') as AdminAuthContext | undefined;

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required.',
        },
        401
      );
    }

    if (!authContext.mfaVerified) {
      return c.json(
        {
          error: 'mfa_required',
          error_description: 'Multi-factor authentication is required for this operation.',
        },
        403
      );
    }

    return next();
  };
}

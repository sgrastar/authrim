/**
 * System Initialization Check Utilities
 *
 * Checks whether the system has been initialized with an admin account.
 * Used to determine if the setup flow should be available.
 *
 * Admin/EndUser Separation:
 * - Uses DB_ADMIN for Admin user management (admin_users, admin_roles, admin_role_assignments)
 * - Falls back to legacy DB (users_core, roles, role_assignments) for backward compatibility
 */

import type { Env } from '../types/env';
import { D1Adapter } from '../db/adapters/d1-adapter';
import type { DatabaseAdapter } from '../db/adapter';
import { createLogger } from './logger';

const log = createLogger().module('SYSTEM_INIT');

/**
 * System initialization status
 */
export interface SystemInitStatus {
  /** Whether a super_admin user exists */
  initialized: boolean;
  /** Number of super_admin users (usually 1) */
  adminCount: number;
  /** Whether using new DB_ADMIN (true) or legacy DB (false) */
  usingAdminDb: boolean;
}

/**
 * Check if the system has been initialized with at least one super_admin
 *
 * The system is considered initialized if there is at least one active Admin user
 * with the super_admin role that hasn't expired.
 *
 * Checks DB_ADMIN first, falls back to legacy DB for backward compatibility.
 *
 * @param env - Cloudflare Workers environment
 * @returns true if system is initialized (has at least one super_admin)
 */
export async function isSystemInitialized(env: Env): Promise<boolean> {
  const status = await getSystemInitStatus(env);
  return status.initialized;
}

/**
 * Get detailed system initialization status
 *
 * @param env - Cloudflare Workers environment
 * @returns System initialization status with admin count
 */
export async function getSystemInitStatus(env: Env): Promise<SystemInitStatus> {
  // First, try DB_ADMIN (new architecture)
  if (env.DB_ADMIN) {
    try {
      const adminAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_ADMIN });
      const now = Date.now(); // Milliseconds for admin_role_assignments

      // Count Admin users with active, non-expired super_admin role
      const result = await adminAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(DISTINCT ra.admin_user_id) as count
         FROM admin_role_assignments ra
         JOIN admin_roles r ON ra.admin_role_id = r.id
         JOIN admin_users u ON ra.admin_user_id = u.id
         WHERE r.name = 'super_admin'
           AND u.is_active = 1
           AND u.status = 'active'
           AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
        [now]
      );

      const adminCount = result?.count ?? 0;

      if (adminCount > 0) {
        return {
          initialized: true,
          adminCount,
          usingAdminDb: true,
        };
      }
    } catch (error) {
      // DB_ADMIN might not be set up yet, try legacy DB
      log.debug('DB_ADMIN check failed, trying legacy DB', {});
    }
  }

  // Fallback to legacy DB (for backward compatibility)
  try {
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    const now = Math.floor(Date.now() / 1000); // UNIX seconds for legacy role_assignments

    // Count users with active, non-expired system_admin role (legacy)
    const result = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT ra.subject_id) as count
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       JOIN users_core u ON ra.subject_id = u.id
       WHERE r.name = 'system_admin'
         AND u.is_active = 1
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
      [now]
    );

    const adminCount = result?.count ?? 0;

    return {
      initialized: adminCount > 0,
      adminCount,
      usingAdminDb: false,
    };
  } catch (error) {
    // If there's a database error (e.g., tables don't exist yet),
    // treat it as not initialized
    log.error('Failed to check system initialization status', {}, error as Error);
    return {
      initialized: false,
      adminCount: 0,
      usingAdminDb: false,
    };
  }
}

/**
 * Assign super_admin role to an Admin user
 *
 * Used during initial setup to grant the first Admin user super_admin privileges.
 * Uses DB_ADMIN (new architecture) when available, falls back to legacy DB.
 *
 * @param env - Cloudflare Workers environment
 * @param adminUserId - The Admin user ID to assign the role to
 * @param tenantId - Tenant ID (default: 'default')
 * @throws Error if role assignment fails
 */
export async function assignSystemAdminRole(
  env: Env,
  adminUserId: string,
  tenantId: string = 'default'
): Promise<void> {
  // Use DB_ADMIN (new architecture) when available
  if (env.DB_ADMIN) {
    const adminAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_ADMIN });

    // Get the super_admin role ID
    const role = await adminAdapter.queryOne<{ id: string }>(
      "SELECT id FROM admin_roles WHERE name = 'super_admin' AND tenant_id = ? LIMIT 1",
      [tenantId]
    );

    if (!role) {
      throw new Error('super_admin role not found in DB_ADMIN. Database may not be properly initialized.');
    }

    // Check if assignment already exists
    const existing = await adminAdapter.queryOne<{ id: string }>(
      'SELECT id FROM admin_role_assignments WHERE admin_user_id = ? AND admin_role_id = ? LIMIT 1',
      [adminUserId, role.id]
    );

    if (existing) {
      // Already assigned
      return;
    }

    // Generate a new UUID for the role assignment
    const assignmentId = crypto.randomUUID();
    const now = Date.now(); // Milliseconds for new architecture

    // Create the role assignment (no expiration for super_admin)
    // scope_type='global' means system-wide access
    await adminAdapter.execute(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at, assigned_by, created_at)
       VALUES (?, ?, ?, ?, 'global', NULL, NULL, NULL, ?)`,
      [assignmentId, tenantId, adminUserId, role.id, now]
    );

    log.info('Assigned super_admin role to Admin user', {
      adminUserId: adminUserId.substring(0, 8) + '...',
      roleId: role.id.substring(0, 8) + '...',
    });

    return;
  }

  // Fallback to legacy DB
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });

  // Get the system_admin role ID (legacy)
  const role = await coreAdapter.queryOne<{ id: string }>(
    "SELECT id FROM roles WHERE name = 'system_admin' LIMIT 1",
    []
  );

  if (!role) {
    throw new Error('system_admin role not found. Database may not be properly initialized.');
  }

  // Check if assignment already exists
  const existing = await coreAdapter.queryOne<{ id: string }>(
    'SELECT id FROM role_assignments WHERE subject_id = ? AND role_id = ? LIMIT 1',
    [adminUserId, role.id]
  );

  if (existing) {
    // Already assigned
    return;
  }

  // Generate a new UUID for the role assignment
  const assignmentId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Create the role assignment (no expiration for system_admin)
  // scope_type='global' means system-wide access
  await coreAdapter.execute(
    `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope_type, scope_target, created_at, updated_at)
     VALUES (?, 'default', ?, ?, 'global', '', ?, ?)`,
    [assignmentId, adminUserId, role.id, now, now]
  );
}

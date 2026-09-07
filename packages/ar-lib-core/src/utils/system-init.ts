/**
 * System Initialization Check Utilities
 *
 * Checks whether the system has been initialized with an admin account.
 * Used to determine if the setup flow should be available.
 *
 * Admin/EndUser Separation:
 * - Uses DB_ADMIN for Admin user management (admin_users, admin_roles, admin_role_assignments)
 * - Never falls back to a tenant identity assignment
 */

import type { Env } from '../types/env';
import { ensureDatabaseAdapter } from '../db';
import { createLogger } from './logger';
import { DEFAULT_TENANT_ID } from './tenant-context';

const log = createLogger().module('SYSTEM_INIT');

/**
 * System initialization status
 */
export interface SystemInitStatus {
  /** Whether a super_admin user exists */
  initialized: boolean;
  /** Number of super_admin users (usually 1) */
  adminCount: number;
}

/**
 * Check if the system has been initialized with at least one super_admin
 *
 * The system is considered initialized if there is at least one active Admin user
 * with the super_admin role that hasn't expired.
 *
 * DB_ADMIN is the only authority for this check.
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
  try {
    const adminAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'admin-init');
    const now = Date.now();
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
    return {
      initialized: adminCount > 0,
      adminCount,
    };
  } catch (error) {
    log.error('Failed to check system initialization status', {}, error as Error);
    return {
      initialized: false,
      adminCount: 0,
    };
  }
}

/**
 * Assign super_admin role to an Admin user
 *
 * Used during initial setup to grant the first Admin user super_admin privileges.
 * Uses DB_ADMIN as the sole administration authority.
 *
 * @param env - Cloudflare Workers environment
 * @param adminUserId - The Admin user ID to assign the role to
 * @param tenantId - Tenant ID
 * @throws Error if role assignment fails
 */
export async function assignSystemAdminRole(
  env: Env,
  adminUserId: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<void> {
  const adminAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'admin-init');

  // Get the super_admin role ID
  const role = await adminAdapter.queryOne<{ id: string }>(
    "SELECT id FROM admin_roles WHERE name = 'super_admin' AND tenant_id = 'default' AND is_system = 1 LIMIT 1",
    []
  );

  if (!role) {
    throw new Error(
      'super_admin role not found in DB_ADMIN. Database may not be properly initialized.'
    );
  }

  // Check if assignment already exists
  const existing = await adminAdapter.queryOne<{ id: string }>(
    'SELECT id FROM admin_role_assignments WHERE tenant_id = ? AND admin_user_id = ? AND admin_role_id = ? LIMIT 1',
    [tenantId, adminUserId, role.id]
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
}

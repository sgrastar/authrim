/**
 * System Initialization Check Utilities
 *
 * Checks whether the system has been initialized with an admin account.
 * Used to determine if the setup flow should be available.
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
  /** Whether a system_admin user exists */
  initialized: boolean;
  /** Number of system_admin users (usually 1) */
  adminCount: number;
}

/**
 * Check if the system has been initialized with at least one system_admin
 *
 * The system is considered initialized if there is at least one active user
 * with the system_admin role that hasn't expired.
 *
 * @param env - Cloudflare Workers environment
 * @returns true if system is initialized (has at least one system_admin)
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
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    const now = Math.floor(Date.now() / 1000); // UNIX seconds for role_assignments

    // Count users with active, non-expired system_admin role
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
    };
  } catch (error) {
    // If there's a database error (e.g., tables don't exist yet),
    // treat it as not initialized
    log.error('Failed to check system initialization status', {}, error as Error);
    return {
      initialized: false,
      adminCount: 0,
    };
  }
}

/**
 * Assign system_admin role to a user
 *
 * Used during initial setup to grant the first user system_admin privileges.
 *
 * @param env - Cloudflare Workers environment
 * @param userId - The user ID to assign the role to
 * @throws Error if role assignment fails
 */
export async function assignSystemAdminRole(env: Env, userId: string): Promise<void> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });

  // Get the system_admin role ID
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
    [userId, role.id]
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
    [assignmentId, userId, role.id, now, now]
  );
}

/**
 * Admin Management Routes
 *
 * Routes for managing Admin users, roles, IP allowlist, audit logs,
 * and Admin-specific ABAC/ReBAC/Policies.
 * These endpoints operate on DB_ADMIN, separate from EndUser management.
 *
 * Endpoints:
 * - /api/admin/admins - Admin user management
 * - /api/admin/admin-roles - Admin role management
 * - /api/admin/ip-allowlist - IP restriction management
 * - /api/admin/admin-audit-log - Admin audit log viewing
 * - /api/admin/admin-attributes - Admin ABAC attribute management
 * - /api/admin/admin-relationships - Admin ReBAC relationship management
 * - /api/admin/admin-policies - Admin policy management
 */

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';

// Import routers
import { adminUsersRouter } from './admins';
import { adminRolesRouter } from './admin-roles';
import { ipAllowlistRouter } from './ip-allowlist';
import { adminAuditRouter } from './admin-audit';
import { adminAbacRouter } from './admin-abac';
import { adminRebacRouter } from './admin-rebac';
import { adminPoliciesRouter } from './admin-policies';

// Create main router for admin management
export const adminManagementRouter = new Hono<{ Bindings: Env }>();

// Middleware to check DB_ADMIN availability
adminManagementRouter.use('*', async (c, next) => {
  if (!c.env.DB_ADMIN) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  return next();
});

// Mount sub-routers - Core Admin Management
adminManagementRouter.route('/admins', adminUsersRouter);
adminManagementRouter.route('/admin-roles', adminRolesRouter);
adminManagementRouter.route('/ip-allowlist', ipAllowlistRouter);
adminManagementRouter.route('/admin-audit-log', adminAuditRouter);

// Mount sub-routers - Admin ABAC/ReBAC/Policies (these also have /admins/:userId subroutes)
adminManagementRouter.route('/', adminAbacRouter);
adminManagementRouter.route('/', adminRebacRouter);
adminManagementRouter.route('/', adminPoliciesRouter);

// Re-export individual routers for flexibility
export { adminUsersRouter } from './admins';
export { adminRolesRouter } from './admin-roles';
export { ipAllowlistRouter } from './ip-allowlist';
export { adminAuditRouter } from './admin-audit';
export { adminAbacRouter } from './admin-abac';
export { adminRebacRouter } from './admin-rebac';
export { adminPoliciesRouter } from './admin-policies';

export default adminManagementRouter;

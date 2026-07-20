/**
 * Admin Management Routes
 *
 * Routes for managing Admin users, roles, IP allowlist, audit logs,
 * and Admin-specific ABAC/ReBAC/Policies.
 * These endpoints operate on DB_ADMIN, separate from EndUser management.
 *
 * Endpoints:
 * - /api/admin/admin-access-control - Admin access control hub stats
 * - /api/admin/admins - Admin user management
 * - /api/admin/admin-roles - Admin role management
 * - /api/admin/ip-allowlist - IP restriction management
 * - /api/admin/admin-audit-log - Admin audit log viewing
 * - /api/admin/admin-attributes - Admin ABAC attribute management
 * - /api/admin/admin-relationships - Admin ReBAC relationship management
 * - /api/admin/admin-policies - Admin policy management
 * - /api/admin/storage-destinations - Storage destination management
 * - /api/admin/database-connections - Platform database connection management
 * - /api/admin/machine-access - Admin Machine Access management
 */

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';

// Import routers
import { adminUsersRouter } from './admins';
import { adminInvitationsRouter } from './admin-invitations';
import { adminRolesRouter } from './admin-roles';
import { ipAllowlistRouter } from './ip-allowlist';
import { adminAuditRouter } from './admin-audit';
import { adminAbacRouter } from './admin-abac';
import { adminRebacRouter } from './admin-rebac';
import { adminPoliciesRouter } from './admin-policies';
import { myPasskeysRouter } from './my-passkeys';
import { myAgentConsentsRouter } from './my-agent-consents';
import { adminAccessControlRouter } from './admin-access-control';
import { adminApprovalsRouter } from './admin-approvals';
import { operationalLogsRouter } from './operational-logs';
import { storageDestinationsRouter } from './storage-destinations';
import { databaseConnectionsRouter } from './database-connections';
import { machineAccessRouter } from './machine-access';
import { agentGrantsRouter } from './agent-grants';
import { agentLoginHandoffsRouter } from './agent-login-handoffs';
import { agentWriteOperationsRouter } from './agent-write-operations';
import { agentElevationsRouter } from './agent-elevations';
import { agentSettingsRouter } from './agent-settings';
import { agentReadOperationsRouter } from './agent-read-operations';
import {
  agentConfigurationPlansRouter,
  agentScopePoliciesRouter,
  agentSecretRefsRouter,
  agentTaskSetsRouter,
} from './agent-configuration';
import { agentBulkPlansRouter } from './agent-bulk';
import { agentBaselinesRouter, agentTemplatesRouter } from './agent-baselines';
import {
  adminLoggingRouter,
  destinationsRouter,
  loggingPoliciesRouter,
  notificationsRouter,
} from './logging-control';

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
adminManagementRouter.route('/admin-access-control', adminAccessControlRouter);
adminManagementRouter.route('/admins', adminUsersRouter);
adminManagementRouter.route('/admin-invitations', adminInvitationsRouter);
adminManagementRouter.route('/admin-roles', adminRolesRouter);
adminManagementRouter.route('/ip-allowlist', ipAllowlistRouter);
adminManagementRouter.route('/admin-audit-log', adminAuditRouter);
adminManagementRouter.route('/me/passkeys', myPasskeysRouter);
adminManagementRouter.route('/me/agent-consents', myAgentConsentsRouter);
adminManagementRouter.route('/approvals', adminApprovalsRouter);
adminManagementRouter.route('/operational-logs', operationalLogsRouter);
adminManagementRouter.route('/storage-destinations', storageDestinationsRouter);
adminManagementRouter.route('/destinations', destinationsRouter);
adminManagementRouter.route('/logging-policies', loggingPoliciesRouter);
adminManagementRouter.route('/admin-logging', adminLoggingRouter);
adminManagementRouter.route('/notifications', notificationsRouter);
adminManagementRouter.route('/database-connections', databaseConnectionsRouter);
adminManagementRouter.route('/machine-access', machineAccessRouter);
adminManagementRouter.route('/agent-grants', agentGrantsRouter);
adminManagementRouter.route('/agent-login-handoffs', agentLoginHandoffsRouter);
adminManagementRouter.route('/agent-write', agentWriteOperationsRouter);
adminManagementRouter.route('/agent-elevations', agentElevationsRouter);
adminManagementRouter.route('/settings/agent', agentSettingsRouter);
adminManagementRouter.route('/agent-read', agentReadOperationsRouter);
adminManagementRouter.route('/agent-task-sets', agentTaskSetsRouter);
adminManagementRouter.route('/agent-scope-policies', agentScopePoliciesRouter);
adminManagementRouter.route('/agent-config-plans', agentConfigurationPlansRouter);
adminManagementRouter.route('/agent-secret-refs', agentSecretRefsRouter);
adminManagementRouter.route('/agent-bulk-plans', agentBulkPlansRouter);
adminManagementRouter.route('/agent-templates', agentTemplatesRouter);
adminManagementRouter.route('/agent-baselines', agentBaselinesRouter);

// Mount sub-routers - Admin ABAC/ReBAC/Policies (these also have /admins/:userId subroutes)
adminManagementRouter.route('/', adminAbacRouter);
adminManagementRouter.route('/', adminRebacRouter);
adminManagementRouter.route('/', adminPoliciesRouter);

// Re-export individual routers for flexibility
export { adminAccessControlRouter } from './admin-access-control';
export { adminUsersRouter } from './admins';
export { adminInvitationsRouter } from './admin-invitations';
export { adminRolesRouter } from './admin-roles';
export { ipAllowlistRouter } from './ip-allowlist';
export { adminAuditRouter } from './admin-audit';
export { adminAbacRouter } from './admin-abac';
export { adminRebacRouter } from './admin-rebac';
export { adminPoliciesRouter } from './admin-policies';
export { myPasskeysRouter } from './my-passkeys';
export { myAgentConsentsRouter } from './my-agent-consents';
export { adminApprovalsRouter } from './admin-approvals';
export { operationalLogsRouter } from './operational-logs';
export { storageDestinationsRouter } from './storage-destinations';
export { databaseConnectionsRouter } from './database-connections';
export { machineAccessRouter } from './machine-access';
export { agentGrantsRouter } from './agent-grants';
export { agentLoginHandoffsRouter } from './agent-login-handoffs';
export { agentWriteOperationsRouter } from './agent-write-operations';
export { agentElevationsRouter } from './agent-elevations';
export { agentSettingsRouter } from './agent-settings';
export { agentReadOperationsRouter } from './agent-read-operations';
export {
  agentConfigurationPlansRouter,
  agentScopePoliciesRouter,
  agentSecretRefsRouter,
  agentTaskSetsRouter,
} from './agent-configuration';
export { agentBulkPlansRouter } from './agent-bulk';
export { agentBaselinesRouter, agentTemplatesRouter } from './agent-baselines';
export {
  adminLoggingRouter,
  destinationsRouter,
  loggingPoliciesRouter,
  notificationsRouter,
} from './logging-control';

export default adminManagementRouter;

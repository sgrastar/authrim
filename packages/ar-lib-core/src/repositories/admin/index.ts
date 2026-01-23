/**
 * Admin Repositories
 *
 * Re-exports all Admin-specific repositories for DB_ADMIN.
 * These repositories are used for Admin/EndUser separation architecture.
 */

// Core Admin Management
export { AdminUserRepository, type AdminUserFilterOptions } from './admin-user';
export { AdminRoleRepository, AdminRoleAssignmentRepository } from './admin-role';
export { AdminSessionRepository } from './admin-session';
export { AdminPasskeyRepository } from './admin-passkey';
export { AdminAuditLogRepository, type AdminAuditLogFilterOptions } from './admin-audit-log';
export { AdminIpAllowlistRepository } from './admin-ip-allowlist';
export {
  AdminLoginAttemptRepository,
  type AdminLoginAttemptCreateInput,
  type AdminLoginAttemptFilterOptions,
} from './admin-login-attempt';

// Admin ABAC (Attribute-Based Access Control)
export {
  AdminAttributeRepository,
  type AdminAttribute,
  type AdminAttributeCreateInput,
} from './admin-attribute';
export {
  AdminAttributeValueRepository,
  type AdminAttributeValue,
  type AdminAttributeValueCreateInput,
} from './admin-attribute-value';

// Admin ReBAC (Relationship-Based Access Control)
export {
  AdminRelationshipRepository,
  type AdminRelationship,
  type AdminRelationshipCreateInput,
} from './admin-relationship';

// Admin Policies (Combined RBAC/ABAC/ReBAC)
export {
  AdminPolicyRepository,
  type AdminPolicy,
  type AdminPolicyCreateInput,
  type AdminPolicyConditions,
} from './admin-policy';

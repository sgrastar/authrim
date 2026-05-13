/**
 * Admin Repositories
 *
 * Re-exports all Admin-specific repositories for DB_ADMIN.
 * These repositories are used for Admin/EndUser separation architecture.
 */

// Core Admin Management
export { AdminUserRepository, type AdminUserFilterOptions } from './admin-user';
export {
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  type AdminRoleAssignmentWithUser,
} from './admin-role';
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
export {
  AdminRebacDefinitionRepository,
  type AdminRebacDefinition,
  type AdminRebacDefinitionCreateInput,
  type AdminRebacDefinitionUpdateInput,
} from './admin-rebac-definition';

// Admin Policies (Combined RBAC/ABAC/ReBAC)
export {
  AdminPolicyRepository,
  type AdminPolicy,
  type AdminPolicyCreateInput,
  type AdminPolicyConditions,
} from './admin-policy';

// Approval / Elevation Governance
export {
  ApprovalRequestRepository,
  ApprovalRequestApprovalRepository,
  ElevationGrantRepository,
} from './admin-approval-request';

// Admin infrastructure resources
export {
  AdminStorageDestinationRepository,
  type AdminResourceScopeType,
  type AdminResourceStatus,
  type AdminStorageDestination,
  type AdminStorageDestinationCreateInput,
  type AdminStorageDestinationUpdateInput,
  type AdminStorageDestinationUsage,
  type AdminStorageDestinationUsageInput,
  type AdminStorageDestinationWithCredential,
  type StorageDestinationProvider,
} from './admin-storage-destination';
export {
  AdminDatabaseConnectionRepository,
  type AdminDatabaseConnection,
  type AdminDatabaseConnectionCreateInput,
  type AdminDatabaseConnectionUpdateInput,
  type AdminDatabaseConnectionUsage,
  type AdminDatabaseConnectionWithCredential,
  type DatabaseConnectionProvider,
} from './admin-database-connection';
export {
  AdminMachineAccessRepository,
  type AdminMachineActorRef,
  type AdminMachineClientCredential,
  type AdminMachineCredential,
  type AdminMachineCredentialAlgorithm,
  type AdminMachineCredentialCreateInput,
  type AdminMachineCredentialStatus,
  type AdminMachinePrincipal,
  type AdminMachinePrincipalCreateInput,
  type AdminMachinePrincipalStatus,
  type AdminMachinePrincipalType,
  type AdminMachineTenantScope,
  type AdminMachineTenantScopeMode,
} from './admin-machine-access';

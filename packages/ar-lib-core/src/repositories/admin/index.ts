/**
 * Admin Repositories
 *
 * Re-exports all Admin-specific repositories for DB_ADMIN.
 * These repositories are used for Admin/EndUser separation architecture.
 */

// Core Admin Management
export { AdminUserRepository, type AdminUserFilterOptions } from './admin-user';
export {
  AdminRoleChangedError,
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  type AdminRoleAssignmentWithUser,
} from './admin-role';
export { ADMIN_GUARD_NOW_MS, allOfGuards, guardClause, type AdminWriteGuard } from './write-guard';
export { AdminSessionRepository } from './admin-session';
export { AdminPasskeyNotFirstError, AdminPasskeyRepository } from './admin-passkey';
export {
  AdminSecondFactorRepository,
  ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS,
  ADMIN_SECOND_FACTOR_MINIMUM,
  type AdminSecondFactor,
  type AdminSecondFactorKind,
  type AdminSecondFactorInsertResult,
  type AdminSecondFactorRevokeResult,
  type AdminWebAuthnSecondFactorInput,
} from './admin-second-factor';
export {
  AdminSecondFactorRecoveryRepository,
  ADMIN_SECOND_FACTOR_RECOVERY_COMPLETION_WINDOW_MS,
  ADMIN_SECOND_FACTOR_RECOVERY_WAIT_MS,
  type AdminSecondFactorRecovery,
  type AdminSecondFactorRecoveryCancelReason,
  type AdminSecondFactorRecoveryCompleteResult,
  type AdminSecondFactorRecoveryCreateResult,
  type AdminSecondFactorRecoveryInput,
  type AdminSecondFactorRecoveryStatus,
} from './admin-second-factor-recovery';
export {
  ADMIN_NOTICE_EMAIL_DEFAULTS,
  AdminNoticeDeliveryRepository,
  severityReaches,
  type AdminNoticeChannel,
  type AdminNoticeChannelInput,
  type AdminNoticeChannelSecret,
  type AdminNoticeDelivery,
  type AdminNoticeDeliveryChannel,
  type AdminNoticeDeliveryStatus,
  type AdminNoticePreferences,
} from './admin-notice-delivery';
export {
  AdminNoticeRepository,
  ADMIN_NOTICE_LIST_LIMIT,
  ADMIN_NOTICE_SCOPES,
  ADMIN_NOTICE_SEVERITIES,
  type AdminNotice,
  type AdminNoticeInput,
  type AdminNoticeResolveResult,
  type AdminNoticeScope,
  type AdminNoticeSeverity,
  type AdminNoticeSource,
  type AdminNoticeViewer,
} from './admin-notice';
export {
  LOGIN_UI_THEME_LIMIT,
  LoginUIThemeRepository,
  loginUIThemeNameKey,
  type LoginUITheme,
  type LoginUIThemeCreateResult,
  type LoginUIThemeInput,
  type LoginUIThemeUpdateResult,
} from './login-ui-theme';
export { AdminAuditLogRepository, type AdminAuditLogFilterOptions } from './admin-audit-log';
export { AdminIpAllowlistRepository } from './admin-ip-allowlist';
export {
  AdminLoginAttemptRepository,
  type AdminLoginAttemptCreateInput,
  type AdminLoginAttemptFilterOptions,
} from './admin-login-attempt';
export {
  INTERNAL_NOTIFICATION_EVENT_CATEGORIES,
  InternalNotificationEventRepository,
  resolveLoggingNotificationRoutingPolicy,
  type InternalNotificationEventCategory,
  type InternalNotificationEventInput,
  type InternalNotificationEventRow,
  type InternalNotificationEventSeverity,
  type InternalNotificationEventStatus,
  raiseInternalEventConsoleNotice,
} from './internal-notification-event';
export {
  TenantDiscoveryIndexRepository,
  selectTenantDiscoveryPrimaryCandidate,
  type TenantDiscoveryCandidateSet,
  type TenantDiscoveryIndexInput,
  type TenantDiscoveryIndexKind,
  type TenantDiscoveryIndexRow,
  type TenantDiscoveryIndexStatus,
  type TenantDiscoverySelectionPolicy,
} from './tenant-discovery-index';

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
  AdminLoggingControlRepository,
  type AdminAuditCoverageStatusRowInput,
  type AdminLoggingCriticalDestinationRow,
  type AdminLoggingCriticalPolicyRow,
  type AdminLoggingCriticalPolicyState,
  type AdminLoggingPolicyAssignmentViewRow,
  type AdminLoggingSensitiveDetailPolicyRow,
  type AdminLoggingSensitiveDetailPolicyState,
  type LoggingKeyVersionStatusRow,
  type SensitiveDetailIndexSummaryRow,
} from './admin-logging-control';
export {
  TenantDatabaseRegistryRepository,
  type TenantDatabaseActivePointer,
  type TenantDatabaseActivePointerInput,
  type TenantDatabaseActivePointerStatus,
  type TenantDatabaseD1FileSizeStatus,
  type TenantDatabaseProvider,
  type TenantDatabaseRegistryInput,
  type TenantDatabaseRegistryKey,
  type TenantDatabaseRegistryRow,
  type TenantDatabaseRole,
  type TenantDatabaseStatsRow,
  type TenantDatabaseStatsSummary,
  type TenantDatabaseStatsWarningState,
  type TenantDatabaseStatus,
  type TenantRuntimeCacheGenerationInput,
  type TenantRuntimeCacheGenerationRow,
  type TenantRuntimeCacheNamespace,
  type TenantRuntimeRegistrySnapshotInput,
  type TenantRuntimeRegistrySnapshotRow,
  type TenantRuntimeRegistrySnapshotScope,
  type TenantRuntimeRegistrySnapshotStatus,
} from './tenant-database-registry';
export {
  AdminMachineAccessRepository,
  AdminMachineConflictError,
  type AdminMachineWriteGuard,
  type AdminMachineActorRef,
  type AdminMachineClientCredential,
  type AdminMachineGrantSnapshot,
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

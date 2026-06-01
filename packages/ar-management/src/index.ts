import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  getRateLimitProfileAsync,
  initialAccessTokenMiddleware,
  adminAuthMiddleware,
  requestContextMiddleware,
  pluginContextMiddleware,
  createPluginLoader,
  idempotencyMiddleware,
  ensureDatabaseAdapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  requireSystemAdmin,
  requireAnyRole,
  requireAdminPermissions,
  // Native SSO device_secret cleanup
  DeviceSecretRepository,
  isNativeSSOEnabled,
  // Health Check
  createHealthCheckHandlers,
  // Logger
  getLogger,
  createLogger,
  processAuditQueue,
  processLoggingDeliveryQueue,
  type AuditQueueMessage,
  isAllowedOrigin,
  parseAllowedOrigins,
  csrfProtectionMiddleware,
  getTenantIdFromContext,
  getTenantSettings,
  resolveAuthCorePersistenceAdapterFromEnv,
  createCompatibilityErrorResponse,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  type AdminAuthContext,
  getDefaultTenantId,
  readResponseTextWithLimit,
} from '@authrim/ar-lib-core';
import { cloudflareEmailPlugin, resendEmailPlugin } from '@authrim/ar-lib-plugin';
import { resolveBuiltinPluginBootstrapConfig } from '@authrim/ar-lib-plugin/core';
import { cleanupResolvedAuditPrimaries } from './audit-maintenance';
import { runObjectArtifactCleanup } from './artifact-cleanup';
import { processScheduledAdminJobQueues } from './scheduled-admin-jobs';

const VERSION_MANAGER_ERROR_BODY_MAX_BYTES = 64 * 1024;

// Import handlers
import { registerHandler } from './register';
import {
  clientConfigGetHandler,
  clientConfigUpdateHandler,
  clientConfigDeleteHandler,
} from './client-config';
import { clientPublicConfigHandler } from './client-public-config';
import {
  adminSigningKeysStatusHandler,
  adminSigningKeysRotateHandler,
  adminSigningKeysEmergencyRotateHandler,
} from './signing-keys';
import { introspectHandler } from './introspect';
import {
  adminConsentStatementsListHandler,
  adminConsentStatementCreateHandler,
  adminConsentStatementGetHandler,
  adminConsentStatementUpdateHandler,
  adminConsentStatementDeleteHandler,
  adminConsentVersionsListHandler,
  adminConsentVersionCreateHandler,
  adminConsentVersionGetHandler,
  adminConsentVersionUpdateHandler,
  adminConsentVersionActivateHandler,
  adminConsentVersionDeleteHandler,
  adminConsentLocalizationsListHandler,
  adminConsentLocalizationUpsertHandler,
  adminConsentLocalizationDeleteHandler,
  adminConsentRequirementsListHandler,
  adminConsentRequirementUpsertHandler,
  adminConsentRequirementDeleteHandler,
  adminConsentOverridesListHandler,
  adminConsentOverrideUpsertHandler,
  adminConsentOverrideDeleteHandler,
  adminUserConsentRecordsListHandler,
  adminUserConsentHistoryHandler,
  adminUserConsentWithdrawHandler,
} from './admin-consent-statements';
import { revokeHandler, batchRevokeHandler } from './revoke';
import {
  serveAvatarHandler,
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
  adminUserRetryPiiHandler,
  adminUserDeletePiiHandler,
  adminClientsListHandler,
  adminClientCreateHandler,
  adminClientGetHandler,
  adminClientUpdateHandler,
  adminClientDeleteHandler,
  adminClientsBulkDeleteHandler,
  adminUserAvatarUploadHandler,
  adminUserAvatarDeleteHandler,
  adminSessionsListHandler,
  adminSessionGetHandler,
  adminSessionRevokeHandler,
  adminUserRevokeAllSessionsHandler,
  adminAuditLogListHandler,
  adminAuditLogGetHandler,
  adminSettingsGetHandler,
  adminSettingsUpdateHandler,
  adminListCertificationProfilesHandler,
  adminApplyCertificationProfileHandler,
  adminTestSessionCreateHandler,
  adminSigningKeyGetHandler,
  adminTokenRegisterHandler,
  adminTestEmailCodeHandler,
  adminUserConsentsListHandler,
  adminUserConsentRevokeHandler,
  adminUserSuspendHandler,
  adminUserLockHandler,
  adminUserActivateHandler,
  adminUserAnonymizeHandler,
  adminClientRegenerateSecretHandler,
  adminClientUsageHandler,
  adminUserActivityLogHandler,
  adminUserSendEmailHandler,
} from './admin';
import scimApp from './scim';
import {
  adminScimTokensListHandler,
  adminScimTokenCreateHandler,
  adminScimTokenRevokeHandler,
} from './scim-tokens';
import { adminIATListHandler, adminIATCreateHandler, adminIATRevokeHandler } from './iat-tokens';
import {
  adminExternalProvidersListHandler,
  adminExternalProvidersCreateHandler,
  adminExternalProvidersGetHandler,
  adminExternalProvidersUpdateHandler,
  adminExternalProvidersDeleteHandler,
  adminExternalProvidersDiscoverOidcHandler,
  adminExternalTokenRefreshConfigGetHandler,
  adminExternalTokenRefreshConfigUpdateHandler,
  adminExternalTokenRefreshRunsListHandler,
  adminExternalTokenRefreshRunHandler,
} from './external-providers';
import { adminSessionStatusHandler, adminLogoutHandler } from './admin-session';
import {
  adminOrganizationsListHandler,
  adminOrganizationGetHandler,
  adminOrganizationCreateHandler,
  adminOrganizationUpdateHandler,
  adminOrganizationDeleteHandler,
  adminOrganizationMembersListHandler,
  adminOrganizationMemberAddHandler,
  adminOrganizationMemberRemoveHandler,
  adminRolesListHandler,
  adminRoleGetHandler,
  adminRoleAssignmentsListHandler,
  adminUserRolesListHandler,
  adminUserRoleAssignHandler,
  adminUserRoleRemoveHandler,
  adminUserRelationshipsListHandler,
  adminUserRelationshipCreateHandler,
  adminUserRelationshipDeleteHandler,
  adminOrganizationHierarchyHandler,
  adminUserEffectivePermissionsHandler,
  adminRoleCreateHandler,
  adminRoleUpdateHandler,
  adminRoleDeleteHandler,
} from './admin-rbac';
import {
  adminRelationDefinitionsListHandler,
  adminRelationDefinitionGetHandler,
  adminRelationDefinitionCreateHandler,
  adminRelationDefinitionUpdateHandler,
  adminRelationDefinitionDeleteHandler,
  adminRelationshipTuplesListHandler,
  adminRelationshipTupleCreateHandler,
  adminRelationshipTupleDeleteHandler,
  adminRelationshipCheckHandler,
  adminObjectTypesListHandler,
} from './admin-rebac';
import {
  adminAttributesListHandler,
  adminUserAttributesHandler,
  adminAttributeCreateHandler,
  adminAttributeUpdateHandler,
  adminAttributeDeleteHandler,
  adminVerificationsListHandler,
  adminAttributeStatsHandler,
  adminDeleteExpiredAttributesHandler,
  adminAttributeNamesHandler,
} from './admin-attributes';
import {
  adminCustomClaimsListHandler,
  adminCustomClaimCreateHandler,
  adminCustomClaimPresetsListHandler,
  adminCustomClaimPresetApplyHandler,
  adminCustomClaimsReservedNamesHandler,
  adminCustomClaimsStatsHandler,
  adminCustomClaimRequiredViolationsDetectHandler,
  adminCustomClaimGetHandler,
  adminCustomClaimUpdateHandler,
  adminCustomClaimDeleteHandler,
  adminCustomClaimRenameHandler,
  adminCustomClaimRetryHandler,
  adminCustomClaimHistoryListHandler,
  adminCustomClaimHistoryVersionHandler,
} from './admin-custom-claims';
import {
  adminPoliciesListHandler,
  adminPolicyGetHandler,
  adminPolicyCreateHandler,
  adminPolicyUpdateHandler,
  adminPolicyDeleteHandler,
  adminPolicySimulateHandler,
  adminPolicySimulationsHandler,
  adminConditionTypesHandler,
} from './admin-policies';
import {
  adminFlowsListHandler,
  adminFlowGetHandler,
  adminFlowCreateHandler,
  adminFlowUpdateHandler,
  adminFlowDeleteHandler,
  adminFlowCopyHandler,
  adminFlowValidateHandler,
  adminFlowCompileHandler,
  adminFlowNodeTypesHandler,
} from './admin-flows';
import {
  adminAccessTraceListHandler,
  adminAccessTraceGetHandler,
  adminAccessTraceStatsHandler,
  adminAccessTraceTimelineHandler,
} from './admin-access-trace';
import { adminAccessControlStatsHandler } from './admin-access-control-stats';
import {
  adminAIGrantsListHandler,
  adminAIGrantGetHandler,
  adminAIGrantCreateHandler,
  adminAIGrantUpdateHandler,
  adminAIGrantRevokeHandler,
} from './ai-grants';
import {
  adminJobsListHandler,
  adminJobGetHandler,
  adminJobResultHandler,
  adminJobResultDownloadHandler,
  adminJobResultArtifactManifestHandler,
  adminJobResultArtifactDownloadHandler,
  adminJobResultArtifactChunkHandler,
  adminJobsImportUploadUrlHandler,
  adminJobsImportUploadHandler,
  adminJobsUsersImportHandler,
  adminJobsUsersBulkUpdateHandler,
  adminJobsTenantDatabaseProvisionHandler,
  adminJobsTenantDatabaseActivateBatchHandler,
  adminJobsReportsGenerateHandler,
  adminJobsOrgBulkMembersHandler,
  adminJobTypesHandler,
  registerAdminJobPermissionMiddleware,
} from './admin-jobs';
import { USER_IMPORT_MAX_UPLOAD_BYTES } from './user-import-jobs';
import {
  adminStatsTokensHandler,
  adminStatsAuthHandler,
  adminStatsTimelineHandler,
  adminStatsClientHandler,
  adminStatsGeographyHandler,
} from './admin-stats';
import {
  adminSecurityAlertsListHandler,
  adminSecurityAlertAcknowledgeHandler,
  adminSecuritySuspiciousActivitiesHandler,
  adminSecurityThreatsHandler,
  adminSecurityIpReputationHandler,
} from './admin-security';
import {
  adminComplianceStatusHandler,
  adminComplianceAccessReviewsListHandler,
  adminComplianceAccessReviewsCreateHandler,
  adminComplianceReportsListHandler,
  adminDataRetentionStatusHandler,
} from './admin-compliance';
import {
  adminSettingsDiffHandler,
  adminSettingsSchemaHandler,
  adminSettingsValidateHandler,
  adminTenantCloneHandler,
} from './admin-settings-meta';
import { adminTenantInfoHandler } from './admin-info';
import {
  adminRuntimeProfileDefaultsHandler,
  adminRuntimeProfileDefaultsUpdateHandler,
  adminRuntimeProfileDeleteHandler,
  adminRuntimeProfileGetHandler,
  adminRuntimeProfileListHandler,
  adminRuntimeProfileUpsertHandler,
  adminTenantRuntimeRegistryEmergencyPurgeHandler,
  adminTenantRuntimeProfilesHandler,
} from './runtime-profiles';
import {
  adminTenantsListHandler,
  adminTenantCreateHandler,
  adminTenantGetHandler,
  adminTenantUpdateHandler,
  adminTenantDeleteHandler,
  adminTenantSetDefaultHandler,
  adminTenantProvisioningCleanupHandler,
  adminTenantProvisioningRetryHandler,
} from './admin-tenants';
import {
  listTenantDomainMappingsHandler,
  createTenantDomainMappingHandler,
  getTenantDomainMappingHandler,
  updateTenantDomainMappingHandler,
  deleteTenantDomainMappingHandler,
  initiateTenantDomainVerificationHandler,
  confirmTenantDomainVerificationHandler,
} from './admin-tenant-domain-mappings';
import {
  createPlatformTenantVanityDomainHandler,
  createTenantVanityDomainHandler,
  deletePlatformTenantVanityDomainHandler,
  deleteTenantVanityDomainHandler,
  getPlatformTenantVanityDomainHandler,
  getTenantVanityDomainHandler,
  listPlatformTenantVanityDomainsHandler,
  listTenantVanityDomainsHandler,
  setPrimaryPlatformTenantVanityDomainHandler,
  setPrimaryTenantVanityDomainHandler,
  syncPlatformTenantVanityDomainHandler,
  syncTenantVanityDomainHandler,
  updateTenantVanityDomainHandler,
  verifyPlatformTenantVanityDomainHandler,
  verifyTenantVanityDomainHandler,
} from './admin-tenant-vanity-domains';
import {
  createTenantInvitationHandler,
  listTenantInvitationsHandler,
  cancelTenantInvitationHandler,
} from './admin-tenant-invitations';
import { requireSupportedTenantParam } from './single-tenant-guard';
import { adminTenantPolicyMiddleware } from './admin-tenant-policy';
import { userConsentsListHandler, userConsentRevokeHandler } from './user-consents';
import { getLoginMethodsHandler } from './login-methods';
import {
  getDiscoveryConfigHandler,
  postDiscoveryGrantHandler,
  postDiscoveryGrantVerifyHandler,
  postDiscoveryHandler,
} from './discovery';
import {
  dataExportArtifactChunkHandler,
  dataExportArtifactDownloadHandler,
  dataExportArtifactManifestHandler,
  dataExportRequestHandler,
  dataExportStatusHandler,
  dataExportDownloadHandler,
} from './data-export';
import { getCodeShards, updateCodeShards } from './routes/settings/code-shards';
import {
  getRevocationShards,
  updateRevocationShards,
  resetRevocationShards,
} from './routes/settings/revocation-shards';
import {
  getRegionShards,
  updateRegionShards,
  deleteRegionShards,
  migrateRegionShards,
  validateRegionShardsConfig,
} from './routes/settings/region-shards';
import { getSessionShards, updateSessionShards } from './routes/settings/session-shards';
import { getChallengeShards, updateChallengeShards } from './routes/settings/challenge-shards';
import { approvalArtifactsRouter } from './routes/approval-artifacts';
import { approvalReceiptsRouter } from './routes/approval-receipts';
import { stepUpRouter } from './routes/step-up';
import {
  getPartitionSettings,
  updatePartitionSettings,
  testPartitionRouting,
  getPartitionStats,
  getPlatformPartitionStats,
  deletePartitionSettings,
} from './routes/settings/pii-partitions';
import {
  getRefreshTokenShardingConfig,
  updateRefreshTokenShardingConfig,
  getRefreshTokenShardingStats,
  cleanupRefreshTokenGeneration,
  revokeAllUserRefreshTokens,
} from './routes/settings/refresh-token-sharding';
import {
  getOAuthConfig,
  updateOAuthConfig,
  clearOAuthConfig,
  clearAllOAuthConfig,
} from './routes/settings/oauth-config';
import {
  getAnonymousAuthConfig,
  updateAnonymousAuthConfig,
  listAnonymousUsers,
  getAnonymousUser,
  getAnonymousUserUpgrades,
  deleteAnonymousUser,
  cleanupExpiredAnonymousUsers,
} from './routes/settings/anonymous-auth';
import { getPolicyFlags, updatePolicyFlag, clearPolicyFlag } from './routes/settings/policy-flags';
import {
  getCheckApiAuditSettings,
  updateCheckApiAuditSetting,
  clearCheckApiAuditSetting,
} from './routes/settings/check-api-audit';
import {
  getRateLimitSettings,
  getRateLimitProfile,
  updateRateLimitProfile,
  resetRateLimitProfile,
  getProfileOverride,
  setProfileOverride,
  clearProfileOverride,
} from './routes/settings/rate-limit';
import {
  getPlatformCacheModeHandler,
  setPlatformCacheModeHandler,
  getClientCacheModeHandler,
  setClientCacheModeHandler,
  getCacheModeInfoHandler,
} from './routes/settings/cache-mode';
import {
  getErrorConfig,
  getErrorLocale,
  updateErrorLocale,
  resetErrorLocale,
  getErrorResponseFormat,
  updateErrorResponseFormat,
  resetErrorResponseFormat,
  getErrorIdMode,
  updateErrorIdMode,
  resetErrorIdMode,
} from './routes/settings/error-config';
import {
  getTokenExchangeConfig,
  updateTokenExchangeConfig,
  clearTokenExchangeConfig,
} from './routes/settings/token-exchange';
import {
  getIntrospectionValidationConfig,
  updateIntrospectionValidationConfig,
  clearIntrospectionValidationConfig,
} from './routes/settings/introspection-validation';
import {
  getIntrospectionCacheConfigHandler,
  updateIntrospectionCacheConfigHandler,
  clearIntrospectionCacheConfigHandler,
} from './routes/settings/introspection-cache';
import {
  listTombstones,
  listPlatformTombstones,
  getTombstone,
  getPlatformTombstone,
  getTombstoneStats,
  getPlatformTombstoneStats,
  cleanupTombstones,
  cleanupPlatformTombstones,
  deleteTombstone,
  deletePlatformTombstone,
} from './routes/settings/tombstones';
import {
  getFapiSecurityConfig,
  updateFapiSecurityConfig,
  clearFapiSecurityConfig,
} from './routes/settings/fapi-security';
import {
  getAssuranceLevelsConfig,
  updateAssuranceLevelsConfig,
  deleteAssuranceLevelsConfig,
} from './routes/settings/assurance-levels';
import {
  getIpSecurityConfig,
  updateIpSecurityConfig,
  clearIpSecurityConfig,
} from './routes/settings/ip-security';
import {
  getUIConfigHandler,
  updateUIConfigHandler,
  deleteUIConfigHandler,
  getUIRoutingHandler,
  updateUIRoutingHandler,
  deleteUIRoutingHandler,
} from './routes/settings/ui-config';
import {
  getConformanceConfigHandler,
  updateConformanceConfigHandler,
  deleteConformanceConfigHandler,
} from './routes/settings/conformance-config';
import {
  createRoleAssignmentRule,
  listRoleAssignmentRules,
  getRoleAssignmentRule,
  updateRoleAssignmentRule,
  deleteRoleAssignmentRule,
  testRoleAssignmentRule,
  evaluateRoleAssignmentRules,
} from './routes/settings/role-assignment-rules';
import { supportOpsRouter } from './support-ops';
import {
  createOrgDomainMapping,
  listOrgDomainMappings,
  getOrgDomainMapping,
  updateOrgDomainMapping,
  deleteOrgDomainMapping,
  listOrgDomainMappingsByOrg,
  verifyDomainOwnership,
  confirmDomainVerification,
} from './routes/settings/org-domain-mappings';
import {
  getJITProvisioningConfig,
  updateJITProvisioningConfig,
  resetJITProvisioningConfig,
} from './routes/settings/jit-provisioning';
import {
  getDomainHashKeysConfig,
  rotateDomainHashKey,
  completeDomainHashKeyRotation,
  getDomainHashKeyStatus,
  deleteDomainHashKeyVersion,
} from './routes/settings/domain-hash-keys';
import {
  createTokenClaimRule,
  listTokenClaimRules,
  getTokenClaimRule,
  updateTokenClaimRule,
  deleteTokenClaimRule,
  testTokenClaimRuleHandler,
  evaluateTokenClaimRules,
} from './routes/settings/token-claim-rules';
import {
  createResourcePermission,
  listResourcePermissions,
  deleteResourcePermission,
  getPermissionsBySubject,
  getPermissionsByResource,
  checkResourcePermission,
} from './routes/settings/resource-permissions';
import {
  getTokenEmbeddingSettings,
  updateTokenEmbeddingSettings,
} from './routes/settings/token-embedding';
import {
  createCheckApiKey,
  listCheckApiKeys,
  getCheckApiKey,
  deleteCheckApiKey,
  rotateCheckApiKey,
} from './routes/settings/check-api-keys';
import {
  getLogoutConfig,
  updateLogoutConfig,
  resetLogoutConfig,
} from './routes/settings/logout-config';
import {
  getLogoutWebhookConfig,
  updateLogoutWebhookConfig,
  resetLogoutWebhookConfig,
} from './routes/settings/logout-webhook-config';
import {
  listLogoutFailures,
  getLogoutFailure,
  clearLogoutFailure,
  clearAllLogoutFailures,
} from './routes/settings/logout-failures';
import { getEncryptionStatus } from './routes/settings/encryption-config';
import settingsV2 from './routes/settings-v2';
import policyRouter from './routes/policy';
import adminManagementRouter from './routes/admin-management';
import diagnosticLoggingRouter from './routes/diagnostic-logging';
import {
  revokeCredentialHandler,
  suspendCredentialHandler,
  activateCredentialHandler,
  listStatusListsHandler,
  getStatusListHandler,
  getStatusListStatsHandler,
} from './routes/vc/credential-status';
import {
  listPluginsHandler,
  getPluginHandler,
  getPluginConfigHandler,
  updatePluginConfigHandler,
  enablePluginHandler,
  disablePluginHandler,
  sendPluginTestEmailHandler,
  getPluginHealthHandler,
  getPluginSchemaHandler,
  ensureBuiltinPluginsRegistered,
  platformPluginScopeMiddleware,
} from './routes/settings/plugins';
import {
  getNativeSSOSettingsConfig,
  updateNativeSSOConfig,
  clearNativeSSOConfig,
} from './routes/settings/native-sso';
import {
  listUserDeviceSecrets,
  getDeviceSecret,
  revokeDeviceSecret,
  revokeAllUserDeviceSecrets,
  cleanupExpiredDeviceSecrets,
} from './routes/device-secrets';
import {
  listMyDevicesHandler,
  updateMyDeviceHandler,
  deleteMyDeviceHandler,
} from './self-service-devices';
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  listWebhookDeliveries,
  getWebhookDelivery,
  replayWebhookDelivery,
} from './routes/settings/webhooks';
import {
  adminCsvDryRunPreviewHandler,
  adminOidcReleasePreviewHandler,
  adminSamlReleasePreviewHandler,
} from './identity-mapping-preview';
import {
  adminIdentityMappingCatalogCreateHandler,
  adminIdentityMappingCatalogsListHandler,
  adminIdentityMappingExternalSchemaImportHandler,
  adminIdentityMappingExternalSchemasListHandler,
  adminIdentityMappingCsvSourceProfileParseHandler,
  adminIdentityMappingDestinationProfileActivateHandler,
  adminIdentityMappingDestinationProfileCreateHandler,
  adminIdentityMappingDestinationProfileDeleteHandler,
  adminIdentityMappingDestinationProfileReviewHandler,
  adminIdentityMappingDestinationProfileUpdateHandler,
  adminIdentityMappingDestinationProfilesListHandler,
  adminIdentityMappingPoliciesListHandler,
  adminIdentityMappingPolicyCreateHandler,
  adminIdentityMappingPolicyRollbackHandler,
  adminIdentityMappingPolicyVersionActivateHandler,
  adminIdentityMappingPolicyVersionCompileHandler,
  adminIdentityMappingPolicyVersionCreateHandler,
  adminIdentityMappingPolicyVersionsListHandler,
  adminIdentityMappingPolicyVersionPublishHandler,
  adminIdentityMappingEntitlementGrantHandler,
  adminIdentityMappingFederationMetadataDocumentCreateHandler,
  adminIdentityMappingFederationMetadataDocumentsListHandler,
  adminIdentityMappingFederationTrustSourceCreateHandler,
  adminIdentityMappingFederationTrustSourceDeleteHandler,
  adminIdentityMappingFederationTrustSourceUpdateHandler,
  adminIdentityMappingGroupCreateHandler,
  adminIdentityMappingGroupMembershipCreateHandler,
  adminIdentityMappingKeyAccessRecordHandler,
  adminIdentityMappingKeyRegistriesListHandler,
  adminIdentityMappingKeyRegistryCreateHandler,
  adminIdentityMappingKeyRegistryRotateHandler,
  adminIdentityMappingLifecycleSignalRecordHandler,
  adminIdentityMappingOidcCustomClaimCreateHandler,
  adminIdentityMappingOidcCustomClaimsListHandler,
  adminIdentityMappingOidcCustomScopeCreateHandler,
  adminIdentityMappingOidcCustomScopesListHandler,
  adminIdentityMappingSourceProfileActivateHandler,
  adminIdentityMappingSourceProfileCreateHandler,
  adminIdentityMappingSourceProfileDeleteHandler,
  adminIdentityMappingSourceProfileReviewHandler,
  adminIdentityMappingSourceProfileUpdateHandler,
  adminIdentityMappingSourceProfilesListHandler,
  adminIdentityMappingProtocolSchemaCreateHandler,
  adminIdentityMappingProtocolSchemasListHandler,
  adminIdentityMappingOperationalNotificationAcknowledgeHandler,
  adminIdentityMappingOperationalNotificationCreateHandler,
  adminIdentityMappingOperationalNotificationResolveHandler,
  adminIdentityMappingProvisioningAssignmentRuleCreateHandler,
  adminIdentityMappingProvisioningAssignmentRuleEvaluateHandler,
  adminIdentityMappingReviewTaskCreateHandler,
  adminIdentityMappingReviewTaskGroupCreateHandler,
  adminIdentityMappingReviewTasksListHandler,
  adminIdentityMappingReviewTaskTransitionHandler,
  adminIdentityMappingSchemaReadinessHandler,
  adminIdentityMappingSourceAuthorityContractCreateHandler,
  adminIdentityMappingSourceAuthorityContractsListHandler,
  adminIdentityMappingSourceAuthorityEvaluateHandler,
  adminIdentityMappingFederationTrustSourcesListHandler,
  adminIdentityMappingTemplateCreateHandler,
  adminIdentityMappingTemplatesListHandler,
} from './identity-mapping-control-plane';
import {
  getLoggingConfig,
  updateLoggingConfig,
  resetLoggingConfig,
  getTenantLoggingConfig,
  updateTenantLoggingConfig,
  resetTenantLoggingConfig,
  listTenantLoggingOverrides,
} from './routes/settings/logging-config';
import {
  getTenantPIIConfig,
  updateTenantPIIConfig,
  resetTenantPIIConfig,
  applyGDPRPreset,
  applyMinimalPreset,
  listAllTenantPIIConfigs,
} from './routes/settings/audit-pii-config';
import {
  getAuditStorageConfig,
  updateAuditStorageConfig,
  getRetentionConfig,
  updateRetentionConfig,
  getRoutingRules,
  updateRoutingRules,
  addRoutingRule,
  deleteRoutingRule,
  triggerRetentionCleanup,
  getStorageStats,
} from './routes/settings/audit-storage';
import {
  getDataRetentionEstimate,
  updateCategoryRetention,
  runDataRetentionCleanup,
  getCleanupRunStatus,
  listRetentionCategories,
} from './routes/settings/data-retention';
import {
  getTenantEmailSettingsHandler,
  updateTenantEmailSettingsHandler,
} from './routes/email-settings';

const AI_GRANTS_ADMIN_ROLES = ['system_admin', 'distributor_admin'];

function requireAiGrantAdminAccess(requiredPermission: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = (c as unknown as { get: (key: string) => unknown }).get('adminAuth') as
      | AdminAuthContext
      | undefined;

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Authentication required. Please authenticate first.',
        },
        401
      );
    }

    if (authContext.authMethod === 'machine_access_token') {
      const permissions = authContext.permissions || [];
      if (hasAdminPermission(permissions, requiredPermission)) {
        return next();
      }

      return c.json(
        {
          error: 'insufficient_permissions',
          error_description: 'You do not have the required permissions for this operation.',
        },
        403
      );
    }

    return requireAnyRole(AI_GRANTS_ADMIN_ROLES)(c, next);
  };
}

function requireClientManagementPermission() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const method = c.req.method.toUpperCase();
    const requiredPermissions =
      method === 'GET'
        ? [ADMIN_PERMISSIONS.CLIENTS_READ]
        : method === 'DELETE'
          ? [ADMIN_PERMISSIONS.CLIENTS_DELETE]
          : [ADMIN_PERMISSIONS.CLIENTS_WRITE];
    return requireAdminPermissions(requiredPermissions)(c, next);
  };
}

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

const loadPlugins = createPluginLoader([
  {
    plugin: cloudflareEmailPlugin,
    skipIfConfigEmpty: true,
    envConfigResolver: (env) => resolveBuiltinPluginBootstrapConfig(env, cloudflareEmailPlugin.id),
  },
  {
    plugin: resendEmailPlugin,
    skipIfConfigEmpty: true,
    envConfigResolver: (env) => resolveBuiltinPluginBootstrapConfig(env, resendEmailPlugin.id),
  },
]);

// Middleware
app.use('*', logger());
app.use('*', requestContextMiddleware());
app.use('*', pluginContextMiddleware({ loadPlugins }));

// Enhanced security headers
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
    strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
  })
);

/**
 * CORS configuration with dynamic origin validation
 *
 * Security considerations for Management API:
 * - Per CORS spec, when credentials: true, origin cannot be '*'
 * - If ALLOWED_ORIGINS is set, validates against whitelist with credentials enabled
 * - If not set, uses '*' with credentials disabled (safe default)
 * - Admin endpoints (/api/admin/*) should have ALLOWED_ORIGINS configured in production
 */
app.use('*', async (c, next) => {
  let allowedOriginsStr: string | null = null;

  // 1. Try to get from KV (tenant-aware settings)
  const tenantSettings = await getTenantSettings(
    c.env.AUTHRIM_CONFIG,
    getTenantIdFromContext(c),
    'tenant'
  );
  if (tenantSettings) {
    const kvValue = tenantSettings['tenant.allowed_origins'];
    if (typeof kvValue === 'string' && kvValue.length > 0) {
      allowedOriginsStr = kvValue;
    }
  }

  // 2. Merge with environment variable (do not override tenant settings)
  if (c.env.ALLOWED_ORIGINS) {
    allowedOriginsStr = allowedOriginsStr
      ? `${allowedOriginsStr},${c.env.ALLOWED_ORIGINS}`
      : c.env.ALLOWED_ORIGINS;
  }

  // 3. Parse allowed origins (supports wildcards)
  const allowedOrigins = allowedOriginsStr ? parseAllowedOrigins(allowedOriginsStr) : null;

  // Only allow credentials when specific origins are configured
  const allowCredentials = !!allowedOrigins && allowedOrigins.length > 0;

  // Origin validation function (supports wildcards)
  const validateOrigin = (origin: string): string | undefined | null => {
    if (!allowedOrigins || allowedOrigins.length === 0) {
      // No whitelist configured: allow all origins but without credentials
      return origin;
    }
    // Check against whitelist with wildcard support
    if (isAllowedOrigin(origin, allowedOrigins)) {
      return origin;
    }
    // Origin not in whitelist
    return null;
  };

  return cors({
    origin: validateOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'DPoP',
      'If-Match',
      'If-None-Match',
      'X-Tenant-Id',
      'X-Diagnostic-Session-Id',
    ],
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'ETag',
      'Location',
    ],
    maxAge: 86400,
    credentials: allowCredentials,
  })(c, next);
});

// Rate limiting for registration endpoint
// Configurable via KV (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
app.use('/register', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/register'],
  })(c, next);
});

// Initial Access Token validation for Dynamic Client Registration (RFC 7591)
// Can be disabled by setting ENABLE_OPEN_REGISTRATION=true in environment variables
app.use('/register', initialAccessTokenMiddleware());

// Rate limiting for introspect endpoint
// Configurable via KV (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
app.use('/introspect', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/introspect'],
  })(c, next);
});

// RFC 7662 Section 4: Token introspection responses MUST NOT be cached
app.use('/introspect', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

// Rate limiting for revoke endpoint
// Configurable via KV (rate_limit_{profile}_max_requests, rate_limit_{profile}_window_seconds)
// or RATE_LIMIT_PROFILE env var for profile selection
app.use('/revoke', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/revoke'],
  })(c, next);
});

// RFC 7009: Token revocation responses should not be cached
app.use('/revoke', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

// Rate limiting for batch revoke endpoint (more restrictive due to batch nature)
app.use('/revoke/batch', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/revoke/batch'],
  })(c, next);
});

// Batch revocation responses should not be cached
app.use('/revoke/batch', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

// Health check endpoints - rate limited with lenient profile
// These are public endpoints that should be protected from abuse
app.use('/api/admin/*', adminTenantPolicyMiddleware);

app.use('/api/health', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/health'],
  })(c, next);
});
app.use('/health/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/health/*'],
  })(c, next);
});

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'ar-management',
    timestamp: new Date().toISOString(),
  });
});

// Kubernetes health probes
const healthHandlers = createHealthCheckHandlers({
  serviceName: 'ar-management',
  version: '0.1.0',
  checkDatabase: true,
  checkKV: true,
  checkKeyManager: true,
});
app.get('/health/live', healthHandlers.liveness);
app.get('/health/ready', healthHandlers.readiness);

// Login Methods API - public endpoint for Login UI
// Returns enabled login methods (passkey, emailCode, external providers) and UI config
app.use('/api/auth/login-methods', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/login-methods'],
  })(c, next);
});
app.get('/api/auth/login-methods', getLoginMethodsHandler);
app.use('/api/auth/discovery', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/discovery'],
  })(c, next);
});
app.use('/api/auth/discovery/grant', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/discovery/grant'],
  })(c, next);
});
app.use('/api/auth/discovery/grant/verify', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/auth/discovery/grant/verify'],
  })(c, next);
});
app.get('/api/auth/discovery', getDiscoveryConfigHandler);
app.post('/api/auth/discovery', postDiscoveryHandler);
app.post('/api/auth/discovery/grant', postDiscoveryGrantHandler);
app.post('/api/auth/discovery/grant/verify', postDiscoveryGrantVerifyHandler);

// Dynamic Client Registration endpoint - RFC 7591
app.post('/register', registerHandler);

// Client Configuration Endpoint - RFC 7592
// Rate limit: moderate (sensitive but not auth-critical)
app.get(
  '/clients/:client_id',
  rateLimitMiddleware(RateLimitProfiles.moderate),
  clientConfigGetHandler
);
app.put(
  '/clients/:client_id',
  rateLimitMiddleware(RateLimitProfiles.moderate),
  clientConfigUpdateHandler
);
app.delete(
  '/clients/:client_id',
  rateLimitMiddleware(RateLimitProfiles.moderate),
  clientConfigDeleteHandler
);

// Public Client Configuration endpoint (no authentication required)
app.get(
  '/clients/:client_id/config',
  rateLimitMiddleware(RateLimitProfiles.moderate),
  clientPublicConfigHandler
);

// Token Introspection endpoint - RFC 7662
app.post('/introspect', introspectHandler);

// Token Revocation endpoint - RFC 7009
app.post('/revoke', revokeHandler);

// Batch Token Revocation endpoint (RFC 7009 extension)
app.post('/revoke/batch', batchRevokeHandler);

// Self-service device inventory
app.get('/me/devices', listMyDevicesHandler);
app.patch('/me/devices/:id', updateMyDeviceHandler);
app.delete('/me/devices/:id', deleteMyDeviceHandler);

// Removed Admin API endpoint compatibility surface
app.get('/api/admin/sessions/me', () =>
  createCompatibilityErrorResponse('legacy_endpoint_not_supported', 404)
);

// CSRF protection for Admin API - validates Origin/Referer on state-changing requests
// Applied before auth to reject CSRF attempts early (defense-in-depth with SameSite cookies + CORS)
// Skips Bearer token requests (server-to-server API calls are not vulnerable to CSRF)
app.use('/api/admin/*', csrfProtectionMiddleware());

// Admin authentication middleware - applies to ALL /api/admin/* routes
// Supports both Bearer token (for headless/API usage) and session-based auth (for UI)
// Note: /api/admin/auth/* routes are handled by ar-auth via ar-router
app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));

// Body size limit for Admin API - prevents DoS attacks via large payloads
// 100KB is sufficient for policy/settings updates while blocking malicious large payloads
app.use('/api/admin/*', async (c, next) => {
  const isImportUpload = c.req.path.startsWith('/api/admin/jobs/users/import/upload/');
  const maxSize = isImportUpload ? USER_IMPORT_MAX_UPLOAD_BYTES : 100 * 1024;
  const maxSizeLabel = isImportUpload ? '50MB' : '100KB';

  return bodyLimit({
    maxSize,
    onError: (ctx) => {
      return ctx.json(
        {
          error: 'payload_too_large',
          message: `Request body exceeds maximum allowed size (${maxSizeLabel})`,
        },
        413
      );
    },
  })(c, next);
});

// Admin API endpoints
app.get('/api/admin/stats', adminStatsHandler);
app.get('/api/admin/users', adminUsersListHandler);
app.get('/api/admin/users/:id', adminUserGetHandler);
app.post('/api/admin/users', adminUserCreateHandler);
app.put('/api/admin/users/:id', adminUserUpdateHandler);
app.delete('/api/admin/users/:id', adminUserDeleteHandler);
app.post('/api/admin/users/:id/avatar', adminUserAvatarUploadHandler);
app.delete('/api/admin/users/:id/avatar', adminUserAvatarDeleteHandler);
app.get('/api/admin/avatars/:filename', serveAvatarHandler); // Avatar serving (protected by adminAuthMiddleware)
app.post('/api/admin/users/:id/retry-pii', adminUserRetryPiiHandler);
app.delete('/api/admin/users/:id/pii', adminUserDeletePiiHandler);
app.use('/api/admin/clients', requireClientManagementPermission());
app.use('/api/admin/clients/*', requireClientManagementPermission());
app.get('/api/admin/clients', adminClientsListHandler);
app.post('/api/admin/clients', adminClientCreateHandler);
app.delete('/api/admin/clients/bulk', adminClientsBulkDeleteHandler); // Must be before :id route

// Rate limiting for sensitive client operations (strict profile)
// regenerate-secret: Credential regeneration is a sensitive operation
app.use('/api/admin/clients/:id/regenerate-secret', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/clients/:id/regenerate-secret'],
  })(c, next);
});
// Idempotency support for regenerate-secret (prevents duplicate credential regeneration)
app.use('/api/admin/clients/:id/regenerate-secret', idempotencyMiddleware());
app.post('/api/admin/clients/:id/regenerate-secret', adminClientRegenerateSecretHandler);
app.get('/api/admin/clients/:id/usage', adminClientUsageHandler);
// Note: Routes with additional path segments (e.g., /usage, /regenerate-secret) must be before :id routes
app.get('/api/admin/clients/:id', adminClientGetHandler);
app.put('/api/admin/clients/:id', adminClientUpdateHandler);
app.delete('/api/admin/clients/:id', adminClientDeleteHandler);

// Admin UI Session endpoints (Phase 1 - Authentication)
// - GET /api/admin/me/session - Check current session status with role validation (401/403/200)
// - POST /api/admin/logout - Admin logout with Origin check (CSRF protection)
// Note: me/session must be registered BEFORE sessions/:id to avoid route conflict
app.get('/api/admin/me/session', adminSessionStatusHandler);
app.post('/api/admin/logout', adminLogoutHandler);

// Admin Session Management endpoints (RESTful naming)
app.get('/api/admin/sessions', adminSessionsListHandler);
app.get('/api/admin/sessions/:id', adminSessionGetHandler);
app.delete('/api/admin/sessions/:id', adminSessionRevokeHandler); // RESTful: DELETE instead of POST
app.delete('/api/admin/users/:id/sessions', adminUserRevokeAllSessionsHandler); // RESTful: /sessions instead of /revoke-all-sessions

// Admin User Suspend/Lock endpoints (sensitive operation - with audit logs)
// Rate limiting with strict profile (10 req/min) to prevent abuse
app.use('/api/admin/users/:id/suspend', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/users/:id/suspend'],
  })(c, next);
});
app.use('/api/admin/users/:id/lock', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/users/:id/lock'],
  })(c, next);
});
// RBAC: Require tenant_admin or higher for suspend/lock operations
app.use(
  '/api/admin/users/:id/suspend',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/users/:id/lock',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
// Idempotency support for suspend/lock/activate (prevents duplicate status changes on retry)
app.use('/api/admin/users/:id/suspend', idempotencyMiddleware());
app.use('/api/admin/users/:id/lock', idempotencyMiddleware());
app.use('/api/admin/users/:id/activate', idempotencyMiddleware());
app.post('/api/admin/users/:id/suspend', adminUserSuspendHandler);
app.post('/api/admin/users/:id/lock', adminUserLockHandler);
// Admin User Activate endpoint (restore suspended/locked users)
app.use('/api/admin/users/:id/activate', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/users/:id/activate'],
  })(c, next);
});
app.use(
  '/api/admin/users/:id/activate',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.post('/api/admin/users/:id/activate', adminUserActivateHandler);
app.use('/api/admin/users/:id/anonymize', idempotencyMiddleware());
app.post('/api/admin/users/:id/anonymize', adminUserAnonymizeHandler);
// Phase 3: User activity log and send-email
app.get('/api/admin/users/:id/activity-log', adminUserActivityLogHandler);
app.post('/api/admin/users/:id/send-email', adminUserSendEmailHandler);

// Admin Audit Log endpoints
app.get('/api/admin/audit-logs', adminAuditLogListHandler);
app.get('/api/admin/audit-logs/:id', adminAuditLogGetHandler);

// Admin Settings endpoints (legacy - will be deprecated)
app.get('/api/admin/settings', adminSettingsGetHandler);
app.put('/api/admin/settings', adminSettingsUpdateHandler);

// Settings Metadata API (Phase 2)
// - GET /api/admin/settings/diff     - Compare settings between versions
// - GET /api/admin/settings/schema   - Get settings schema definition
// - POST /api/admin/settings/validate - Validate settings before applying (Phase 3)
app.get('/api/admin/settings/diff', adminSettingsDiffHandler);
app.get('/api/admin/settings/schema', adminSettingsSchemaHandler);
app.post('/api/admin/settings/validate', adminSettingsValidateHandler);

// Runtime Profile Registry API
// - GET    /api/admin/runtime-profiles                 - List runtime profiles
// - GET    /api/admin/runtime-profiles/defaults        - Get environment default profiles
// - PUT    /api/admin/runtime-profiles/defaults        - Update environment default profiles
// - GET    /api/admin/runtime-profiles/:kind/:id       - Get runtime profile
// - PUT    /api/admin/runtime-profiles/:kind/:id       - Create/update runtime profile
// - DELETE /api/admin/runtime-profiles/:kind/:id       - Delete runtime profile
app.get('/api/admin/runtime-profiles', requireSystemAdmin(), adminRuntimeProfileListHandler);
app.get(
  '/api/admin/runtime-profiles/defaults',
  requireSystemAdmin(),
  adminRuntimeProfileDefaultsHandler
);
app.put(
  '/api/admin/runtime-profiles/defaults',
  requireSystemAdmin(),
  adminRuntimeProfileDefaultsUpdateHandler
);
app.get(
  '/api/admin/runtime-profiles/:kind/:id',
  requireSystemAdmin(),
  adminRuntimeProfileGetHandler
);
app.put(
  '/api/admin/runtime-profiles/:kind/:id',
  requireSystemAdmin(),
  adminRuntimeProfileUpsertHandler
);
app.delete(
  '/api/admin/runtime-profiles/:kind/:id',
  requireSystemAdmin(),
  adminRuntimeProfileDeleteHandler
);

// Tenant Management API
// - GET    /api/admin/tenants          - List all tenants
// - POST   /api/admin/tenants          - Create tenant
// - GET    /api/admin/tenants/:id      - Get tenant
// - PATCH  /api/admin/tenants/:id      - Update tenant
// - DELETE /api/admin/tenants/:id      - Delete tenant (default not allowed)
// - POST   /api/admin/tenants/:id/set-default - Set as default tenant
// - POST   /api/admin/tenants/:id/clone       - Clone tenant settings
// Note: /set-default and /clone must be registered BEFORE :id routes to avoid conflicts
app.use('/api/admin/tenants', requireSystemAdmin());
app.use('/api/admin/tenants/*', requireSystemAdmin());
app.use('/api/admin/tenants/:id', requireSupportedTenantParam('id'));
app.use('/api/admin/tenants/:id/*', requireSupportedTenantParam('id'));
app.use('/api/admin/tenants/:tenantId', requireSupportedTenantParam('tenantId'));
app.use('/api/admin/tenants/:tenantId/*', requireSupportedTenantParam('tenantId'));
app.get('/api/admin/tenants', adminTenantsListHandler);
app.post('/api/admin/tenants', adminTenantCreateHandler);
app.post('/api/admin/tenants/:id/set-default', adminTenantSetDefaultHandler);
app.post('/api/admin/tenants/:id/clone', adminTenantCloneHandler);
app.post('/api/admin/tenants/:id/provisioning/retry', adminTenantProvisioningRetryHandler);
app.post('/api/admin/tenants/:id/provisioning/cleanup', adminTenantProvisioningCleanupHandler);
app.get('/api/admin/tenants/:id/info', adminTenantInfoHandler);
app.get('/api/admin/tenants/:id/runtime-profiles', adminTenantRuntimeProfilesHandler);
app.post(
  '/api/admin/tenants/:id/runtime-registry/emergency-purge',
  requireSystemAdmin(),
  adminTenantRuntimeRegistryEmergencyPurgeHandler
);
app.get('/api/admin/tenants/:id', adminTenantGetHandler);
app.patch('/api/admin/tenants/:id', adminTenantUpdateHandler);
app.delete('/api/admin/tenants/:id', adminTenantDeleteHandler);

// Tenant Invitations API
// - POST   /api/admin/tenants/:id/invitations          - Create invitation
// - GET    /api/admin/tenants/:id/invitations          - List invitations
// - DELETE /api/admin/tenants/:id/invitations/:inv_id  - Cancel invitation
app.post('/api/admin/tenants/:id/invitations', createTenantInvitationHandler);
app.get('/api/admin/tenants/:id/invitations', listTenantInvitationsHandler);
app.delete('/api/admin/tenants/:id/invitations/:inv_id', cancelTenantInvitationHandler);
app.get('/api/admin/tenants/:tenantId/email-settings', getTenantEmailSettingsHandler);
app.patch('/api/admin/tenants/:tenantId/email-settings', updateTenantEmailSettingsHandler);

// Platform Tenant Domain Mappings API (system_admin only)
// - GET    /api/admin/platform/tenant-domain-mappings        - List mappings
// - POST   /api/admin/platform/tenant-domain-mappings        - Create mapping
// - POST   /api/admin/platform/tenant-domain-mappings/verify          - Initiate DNS verification
// - POST   /api/admin/platform/tenant-domain-mappings/verify/confirm  - Confirm DNS verification
// - GET    /api/admin/platform/tenant-domain-mappings/:id    - Get mapping
// - PUT    /api/admin/platform/tenant-domain-mappings/:id    - Update mapping
// - DELETE /api/admin/platform/tenant-domain-mappings/:id    - Delete mapping
// Note: /verify and /verify/confirm must be before /:id to avoid route conflicts
app.get(
  '/api/admin/platform/tenant-domain-mappings',
  requireSystemAdmin,
  listTenantDomainMappingsHandler
);
app.post(
  '/api/admin/platform/tenant-domain-mappings',
  requireSystemAdmin,
  createTenantDomainMappingHandler
);
app.post(
  '/api/admin/platform/tenant-domain-mappings/verify',
  requireSystemAdmin,
  initiateTenantDomainVerificationHandler
);
app.post(
  '/api/admin/platform/tenant-domain-mappings/verify/confirm',
  requireSystemAdmin,
  confirmTenantDomainVerificationHandler
);
app.get(
  '/api/admin/platform/tenant-domain-mappings/:id',
  requireSystemAdmin,
  getTenantDomainMappingHandler
);
app.put(
  '/api/admin/platform/tenant-domain-mappings/:id',
  requireSystemAdmin,
  updateTenantDomainMappingHandler
);
app.delete(
  '/api/admin/platform/tenant-domain-mappings/:id',
  requireSystemAdmin,
  deleteTenantDomainMappingHandler
);

// Tenant Vanity Domains API
// Tenant-scoped endpoints require admin:tenant_domains:* permission. Platform endpoints are
// system-admin only and operate across tenants.
app.get('/api/admin/tenant-vanity-domains', listTenantVanityDomainsHandler);
app.post('/api/admin/tenant-vanity-domains', createTenantVanityDomainHandler);
app.get('/api/admin/tenant-vanity-domains/:id', getTenantVanityDomainHandler);
app.patch('/api/admin/tenant-vanity-domains/:id', updateTenantVanityDomainHandler);
app.post('/api/admin/tenant-vanity-domains/:id/primary', setPrimaryTenantVanityDomainHandler);
app.post('/api/admin/tenant-vanity-domains/:id/sync', syncTenantVanityDomainHandler);
app.post('/api/admin/tenant-vanity-domains/:id/verify', verifyTenantVanityDomainHandler);
app.delete('/api/admin/tenant-vanity-domains/:id', deleteTenantVanityDomainHandler);

app.get('/api/admin/platform/tenant-vanity-domains', listPlatformTenantVanityDomainsHandler);
app.post('/api/admin/platform/tenant-vanity-domains', createPlatformTenantVanityDomainHandler);
app.get('/api/admin/platform/tenant-vanity-domains/:id', getPlatformTenantVanityDomainHandler);
app.post(
  '/api/admin/platform/tenant-vanity-domains/:id/primary',
  setPrimaryPlatformTenantVanityDomainHandler
);
app.post(
  '/api/admin/platform/tenant-vanity-domains/:id/sync',
  syncPlatformTenantVanityDomainHandler
);
app.post(
  '/api/admin/platform/tenant-vanity-domains/:id/verify',
  verifyPlatformTenantVanityDomainHandler
);
app.delete(
  '/api/admin/platform/tenant-vanity-domains/:id',
  deletePlatformTenantVanityDomainHandler
);

// =============================================================================
// Settings API v2 (Unified Settings Management) - RECOMMENDED
// =============================================================================
// New unified settings API with:
// - Category-based endpoints (oauth, session, security, etc.)
// - Optimistic locking (version/ifMatch)
// - Audit logging
// - env > KV > default priority
//
// Routes:
// - GET/PATCH /api/admin/tenants/:tenantId/settings/:category
// - GET/PATCH /api/admin/clients/:clientId/settings
// - GET /api/admin/platform/settings/:category (read-only)
// - GET /api/admin/settings/meta/:category
// - GET /api/admin/settings/meta (list all categories)
//
// Migration: Legacy endpoints below will be deprecated in favor of settings-v2
// =============================================================================
app.route('/api/admin', settingsV2);

// =============================================================================
// Policy API (Contract Hierarchy - Tenant Policy / Client Profile / Effective Policy)
// =============================================================================
// Routes:
// - GET/PUT /api/admin/tenant-policy
// - GET /api/admin/tenant-policy/presets
// - POST /api/admin/tenant-policy/apply-preset
// - GET /api/admin/tenant-policy/validate
// - GET/PUT /api/admin/clients/:clientId/profile
// - GET /api/admin/client-profile-presets
// - POST /api/admin/clients/:clientId/apply-preset
// - GET /api/admin/clients/:clientId/profile/validate
// - GET /api/admin/effective-policy?client_id=xxx
// - GET /api/admin/effective-policy/options?client_id=xxx
app.route('/api/admin', policyRouter);

// =============================================================================
// Admin Management API (Admin/EndUser Separation - DB_ADMIN)
// =============================================================================
// Routes:
// - GET/POST /api/admin/admins - Admin user list/create
// - GET/PATCH/DELETE /api/admin/admins/:id - Admin user CRUD
// - POST /api/admin/admins/:id/suspend|activate|unlock
// - POST/DELETE /api/admin/admins/:id/roles - Role assignment
// - GET/POST /api/admin/admin-roles - Admin role list/create
// - GET/PATCH/DELETE /api/admin/admin-roles/:id - Admin role CRUD
// - GET/POST /api/admin/ip-allowlist - IP restriction list/create
// - GET/PATCH/DELETE /api/admin/ip-allowlist/:id - IP entry CRUD
// - GET /api/admin/admin-audit-log - Admin audit log viewing
app.route('/api/admin', adminManagementRouter);
app.route('/api/approval-artifacts', approvalArtifactsRouter);
app.route('/api/approval-receipts', approvalReceiptsRouter);
app.route('/auth/step-up', stepUpRouter);

// =============================================================================
// Diagnostic Logging API (Debugging, Troubleshooting, OIDF Conformance)
// =============================================================================
// Admin routes:
// - POST /api/admin/diagnostic-logging/test-connection - Test R2 connectivity
// - GET /api/admin/diagnostic-logging/export - Export diagnostic logs
app.route('/api/admin/diagnostic-logging', diagnosticLoggingRouter);

// Public API routes:
// - POST /api/v1/diagnostic-logs/ingest - Ingest logs from SDK (public API with client auth)
app.route('/api/v1/diagnostic-logs', diagnosticLoggingRouter);

// Admin Certification Profile endpoints (OpenID Certification)
// NOTE: Profiles apply predefined settings - kept for certification testing
app.get('/api/admin/settings/profiles', adminListCertificationProfilesHandler);
app.put('/api/admin/settings/profile/:profileName', adminApplyCertificationProfileHandler);

// =============================================================================
// Legacy Settings Endpoints (DEPRECATED - Use settings-v2)
// =============================================================================
// These endpoints will be deprecated. Use the unified settings-v2 API instead:
// - Infrastructure settings → GET/PATCH /api/admin/platform/settings/infrastructure
// - OAuth settings → GET/PATCH /api/admin/tenants/:tenantId/settings/oauth
// - Security settings → GET/PATCH /api/admin/tenants/:tenantId/settings/security
// - Token settings → GET/PATCH /api/admin/tenants/:tenantId/settings/tokens
// - Session settings → GET/PATCH /api/admin/tenants/:tenantId/settings/session
// =============================================================================

// [DEPRECATED] Admin Code Shards Configuration
// → Migrate to: /api/admin/platform/settings/infrastructure
app.get('/api/admin/settings/code-shards', getCodeShards);
app.put('/api/admin/settings/code-shards', updateCodeShards);

// [DEPRECATED] Admin Token Revocation Shards Configuration
// → Migrate to: /api/admin/platform/settings/infrastructure
// NOTE: Has reset operation - complex functionality, keep until migration complete
app.get('/api/admin/settings/revocation-shards', getRevocationShards);
app.put('/api/admin/settings/revocation-shards', updateRevocationShards);
app.delete('/api/admin/settings/revocation-shards', resetRevocationShards);

// [DEPRECATED] Admin Region Sharding
// → Migrate to: /api/admin/platform/settings/infrastructure
// NOTE: Has migrate/validate operations - keep until settings-v2 supports operations
app.get('/api/admin/settings/region-shards', getRegionShards);
app.put('/api/admin/settings/region-shards', updateRegionShards);
app.delete('/api/admin/settings/region-shards', deleteRegionShards);
app.post('/api/admin/settings/region-shards/migrate', migrateRegionShards);
app.get('/api/admin/settings/region-shards/validate', validateRegionShardsConfig);

// Admin Session Shards Configuration
// Session Store DO sharding (default: 4 shards)
app.get('/api/admin/settings/session-shards', requireSystemAdmin(), getSessionShards);
app.put('/api/admin/settings/session-shards', requireSystemAdmin(), updateSessionShards);

// Admin Challenge Shards Configuration
// Challenge Store DO sharding (default: 4 shards)
app.get('/api/admin/settings/challenge-shards', requireSystemAdmin(), getChallengeShards);
app.put('/api/admin/settings/challenge-shards', requireSystemAdmin(), updateChallengeShards);

// [DEPRECATED] Admin PII Partition
// → Migrate to: /api/admin/platform/settings/infrastructure
// NOTE: Has test/stats operations - keep until settings-v2 supports operations
app.get('/api/admin/settings/pii-partitions', getPartitionSettings);
app.put('/api/admin/settings/pii-partitions', updatePartitionSettings);
app.post('/api/admin/settings/pii-partitions/test', testPartitionRouting);
app.get('/api/admin/settings/pii-partitions/stats', getPartitionStats);
app.get(
  '/api/admin/platform/settings/pii-partitions/stats',
  requireSystemAdmin(),
  getPlatformPartitionStats
);
app.delete('/api/admin/settings/pii-partitions', deletePartitionSettings);

// Admin Tombstone Management endpoints (GDPR Art.17 deletion tracking)
app.get('/api/admin/tombstones', listTombstones);
app.get('/api/admin/tombstones/stats', getTombstoneStats); // Must be before :id
app.post('/api/admin/tombstones/cleanup', cleanupTombstones);
app.get('/api/admin/tombstones/:id', getTombstone);
app.delete('/api/admin/tombstones/:id', deleteTombstone);
app.get('/api/admin/platform/tombstones', requireSystemAdmin(), listPlatformTombstones);
app.get('/api/admin/platform/tombstones/stats', requireSystemAdmin(), getPlatformTombstoneStats);
app.post('/api/admin/platform/tombstones/cleanup', requireSystemAdmin(), cleanupPlatformTombstones);
app.get('/api/admin/platform/tombstones/:id', requireSystemAdmin(), getPlatformTombstone);
app.delete('/api/admin/platform/tombstones/:id', requireSystemAdmin(), deletePlatformTombstone);

// [DEPRECATED] Admin OAuth/OIDC Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/oauth
app.get('/api/admin/settings/oauth-config', getOAuthConfig);
app.put('/api/admin/settings/oauth-config/:name', updateOAuthConfig);
app.delete('/api/admin/settings/oauth-config/:name', clearOAuthConfig);
app.delete('/api/admin/settings/oauth-config', clearAllOAuthConfig);

// Anonymous Authentication Admin API (architecture-decisions.md §17)
// Configuration
app.get('/api/admin/settings/anonymous-auth', getAnonymousAuthConfig);
app.put('/api/admin/settings/anonymous-auth', updateAnonymousAuthConfig);
// User Management
app.get('/api/admin/anonymous-users', listAnonymousUsers);
app.get('/api/admin/anonymous-users/:id', getAnonymousUser);
app.get('/api/admin/anonymous-users/:id/upgrades', getAnonymousUserUpgrades);
app.delete('/api/admin/anonymous-users/:id', deleteAnonymousUser);
app.post('/api/admin/anonymous-users/cleanup', cleanupExpiredAnonymousUsers);

// [DEPRECATED] Admin PII Encryption Configuration
// → Migrate to: /api/admin/platform/settings/encryption
app.get('/api/admin/settings/encryption/status', getEncryptionStatus);

// [DEPRECATED] Admin Policy Flags (Check API) Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/security
app.get('/api/admin/settings/policy-flags', getPolicyFlags);
app.put('/api/admin/settings/policy-flags/:name', updatePolicyFlag);
app.delete('/api/admin/settings/policy-flags/:name', clearPolicyFlag);

// Check API Audit Configuration (Phase 3 - Access Control)
// Manages permission check audit logging settings
// RBAC: Requires tenant_admin or higher role
app.use(
  '/api/admin/settings/check-api-audit',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/settings/check-api-audit/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.get('/api/admin/settings/check-api-audit', getCheckApiAuditSettings);
app.put('/api/admin/settings/check-api-audit/:name', updateCheckApiAuditSetting);
app.delete('/api/admin/settings/check-api-audit/:name', clearCheckApiAuditSetting);

// [DEPRECATED] Admin Rate Limit Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/rate-limit
// NOTE: Has profile-based overrides - complex functionality
app.get('/api/admin/settings/rate-limits', getRateLimitSettings);
app.get('/api/admin/settings/rate-limits/profile-override', getProfileOverride);
app.put('/api/admin/settings/rate-limits/profile-override', setProfileOverride);
app.delete('/api/admin/settings/rate-limits/profile-override', clearProfileOverride);
app.get('/api/admin/settings/rate-limits/:profile', getRateLimitProfile);
app.put('/api/admin/settings/rate-limits/:profile', updateRateLimitProfile);
app.delete('/api/admin/settings/rate-limits/:profile', resetRateLimitProfile);

// Admin Cache Mode Configuration (P0 KV Cache Optimization)
// Platform-level cache mode (maintenance/fixed)
app.get('/api/admin/settings/cache-mode', getPlatformCacheModeHandler);
app.post('/api/admin/settings/cache-mode', setPlatformCacheModeHandler);
app.get('/api/admin/settings/cache-mode/info', getCacheModeInfoHandler);
// Client-specific cache mode overrides
app.get('/api/admin/clients/:clientId/cache-mode', getClientCacheModeHandler);
app.post('/api/admin/clients/:clientId/cache-mode', setClientCacheModeHandler);

// [DEPRECATED] Admin Error Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/oauth (error settings)
app.get('/api/admin/settings/error-config', getErrorConfig);
app.get('/api/admin/settings/error-locale', getErrorLocale);
app.put('/api/admin/settings/error-locale', updateErrorLocale);
app.delete('/api/admin/settings/error-locale', resetErrorLocale);
app.get('/api/admin/settings/error-response-format', getErrorResponseFormat);
app.put('/api/admin/settings/error-response-format', updateErrorResponseFormat);
app.delete('/api/admin/settings/error-response-format', resetErrorResponseFormat);
app.get('/api/admin/settings/error-id-mode', getErrorIdMode);
app.put('/api/admin/settings/error-id-mode', updateErrorIdMode);
app.delete('/api/admin/settings/error-id-mode', resetErrorIdMode);

// [DEPRECATED] Admin Token Exchange Configuration (RFC 8693)
// → Migrate to: /api/admin/tenants/:tenantId/settings/tokens
// Rate limiting: moderate profile (60 req/min) - sensitive configuration endpoint
app.use('/api/admin/settings/token-exchange', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/token-exchange'],
  })(c, next);
});
app.get('/api/admin/settings/token-exchange', getTokenExchangeConfig);
app.put('/api/admin/settings/token-exchange', updateTokenExchangeConfig);
app.delete('/api/admin/settings/token-exchange', clearTokenExchangeConfig);

// [DEPRECATED] Admin Introspection Validation Configuration (RFC 7662)
// → Migrate to: /api/admin/tenants/:tenantId/settings/tokens
app.get('/api/admin/settings/introspection-validation', getIntrospectionValidationConfig);
app.put('/api/admin/settings/introspection-validation', updateIntrospectionValidationConfig);
app.delete('/api/admin/settings/introspection-validation', clearIntrospectionValidationConfig);

// [DEPRECATED] Admin Introspection Cache Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/tokens
app.get('/api/admin/settings/introspection-cache', getIntrospectionCacheConfigHandler);
app.put('/api/admin/settings/introspection-cache', updateIntrospectionCacheConfigHandler);
app.delete('/api/admin/settings/introspection-cache', clearIntrospectionCacheConfigHandler);

// [DEPRECATED] Admin FAPI/Security Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/security
app.get('/api/admin/settings/fapi-security', getFapiSecurityConfig);
app.put('/api/admin/settings/fapi-security', updateFapiSecurityConfig);
app.delete('/api/admin/settings/fapi-security', clearFapiSecurityConfig);

// NIST SP 800-63-4 Assurance Levels Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/security
// Rate limiting: moderate profile (60 req/min) - security-sensitive configuration
app.use('/api/admin/settings/assurance-levels', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/assurance-levels'],
  })(c, next);
});
app.get('/api/admin/settings/assurance-levels', getAssuranceLevelsConfig);
app.put('/api/admin/settings/assurance-levels', updateAssuranceLevelsConfig);
app.delete('/api/admin/settings/assurance-levels', deleteAssuranceLevelsConfig);

// [DEPRECATED] Admin IP Security Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/security
// Security: Requires system_admin role
app.get('/api/admin/settings/ip-security', requireSystemAdmin(), getIpSecurityConfig);
app.put('/api/admin/settings/ip-security', requireSystemAdmin(), updateIpSecurityConfig);
app.delete('/api/admin/settings/ip-security', requireSystemAdmin(), clearIpSecurityConfig);

// [DEPRECATED] Admin UI Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/oauth (ui settings)
app.get('/api/admin/settings/ui-config', getUIConfigHandler);
app.put('/api/admin/settings/ui-config', updateUIConfigHandler);
app.delete('/api/admin/settings/ui-config', deleteUIConfigHandler);
app.get('/api/admin/settings/ui-routing', getUIRoutingHandler);
app.put('/api/admin/settings/ui-routing', updateUIRoutingHandler);
app.delete('/api/admin/settings/ui-routing', deleteUIRoutingHandler);

// [DEPRECATED] Admin Conformance Mode Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/oauth
app.get('/api/admin/settings/conformance', getConformanceConfigHandler);
app.put('/api/admin/settings/conformance', updateConformanceConfigHandler);
app.delete('/api/admin/settings/conformance', deleteConformanceConfigHandler);

// [DEPRECATED] Admin Refresh Token Sharding Configuration
// → Migrate to: /api/admin/platform/settings/infrastructure
// NOTE: Has stats/cleanup operations
app.get('/api/admin/settings/refresh-token-sharding', getRefreshTokenShardingConfig);
app.put('/api/admin/settings/refresh-token-sharding', updateRefreshTokenShardingConfig);
app.get('/api/admin/settings/refresh-token-sharding/stats', getRefreshTokenShardingStats);
app.delete('/api/admin/settings/refresh-token-sharding/cleanup', cleanupRefreshTokenGeneration);

// User Refresh Token Revocation (all tokens for a user)
app.delete('/api/admin/users/:userId/refresh-tokens', revokeAllUserRefreshTokens);

// Admin Signing Keys Management endpoints
app.get('/api/admin/signing-keys/status', adminSigningKeysStatusHandler);
app.post('/api/admin/signing-keys/rotate', adminSigningKeysRotateHandler);
app.post('/api/admin/signing-keys/emergency-rotate', adminSigningKeysEmergencyRotateHandler);

// Admin SCIM Token Management endpoints
app.get('/api/admin/scim-tokens', adminScimTokensListHandler);
app.post('/api/admin/scim-tokens', adminScimTokenCreateHandler);
app.delete('/api/admin/scim-tokens/:tokenHash', adminScimTokenRevokeHandler);

// Admin Initial Access Token (IAT) Management endpoints
// RFC 7591 Dynamic Client Registration requires Initial Access Token
// Tokens are stored with SHA-256 hash as key (iat:${hash}) - same pattern as SCIM tokens
app.get('/api/admin/iat-tokens', adminIATListHandler);
app.post('/api/admin/iat-tokens', adminIATCreateHandler);
app.delete('/api/admin/iat-tokens/:tokenHash', adminIATRevokeHandler);

// Admin External IdP Provider Management endpoints (proxy to ar-bridge)
// Enables Admin UI to manage external identity providers (Google, GitHub, etc.)
app.get('/api/admin/external-providers', adminExternalProvidersListHandler);
app.post('/api/admin/external-providers', adminExternalProvidersCreateHandler);

// Rate limiting for OIDC discovery proxy (strict profile)
// This endpoint fetches external URLs, so strict rate limiting prevents abuse as DDoS amplifier
app.use('/api/admin/external-providers/discover-oidc', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/external-providers/discover-oidc'],
  })(c, next);
});

// OIDC Discovery proxy (must be before :id route to avoid conflict)
app.post('/api/admin/external-providers/discover-oidc', adminExternalProvidersDiscoverOidcHandler);
app.get('/api/admin/external-providers/:id', adminExternalProvidersGetHandler);
app.put('/api/admin/external-providers/:id', adminExternalProvidersUpdateHandler);
app.delete('/api/admin/external-providers/:id', adminExternalProvidersDeleteHandler);

// Admin External IdP token refresh endpoints (proxy to ar-bridge)
app.get('/api/admin/external-token-refresh/config', adminExternalTokenRefreshConfigGetHandler);
app.put('/api/admin/external-token-refresh/config', adminExternalTokenRefreshConfigUpdateHandler);
app.get('/api/admin/external-token-refresh/runs', adminExternalTokenRefreshRunsListHandler);
app.post('/api/admin/external-token-refresh/run', adminExternalTokenRefreshRunHandler);

// Admin RBAC endpoints - Phase 1

// Organization management
app.get('/api/admin/organizations', adminOrganizationsListHandler);
app.get('/api/admin/organizations/:id', adminOrganizationGetHandler);
app.post('/api/admin/organizations', adminOrganizationCreateHandler);
app.put('/api/admin/organizations/:id', adminOrganizationUpdateHandler);
app.delete('/api/admin/organizations/:id', adminOrganizationDeleteHandler);

// Organization membership management
app.get('/api/admin/organizations/:id/members', adminOrganizationMembersListHandler);
app.post('/api/admin/organizations/:id/members', adminOrganizationMemberAddHandler);
app.delete('/api/admin/organizations/:id/members/:subjectId', adminOrganizationMemberRemoveHandler);

// Organization hierarchy
app.get('/api/admin/organizations/:id/hierarchy', adminOrganizationHierarchyHandler);

// Role management (read-only for system roles, custom roles can be created/edited/deleted)
app.get('/api/admin/roles', adminRolesListHandler);
app.get('/api/admin/roles/:id', adminRoleGetHandler);
app.get('/api/admin/roles/:id/assignments', adminRoleAssignmentsListHandler);
app.post('/api/admin/roles', adminRoleCreateHandler);
app.patch('/api/admin/roles/:id', adminRoleUpdateHandler);
app.delete('/api/admin/roles/:id', adminRoleDeleteHandler);

// User role assignment management
app.get('/api/admin/users/:id/roles', adminUserRolesListHandler);
app.post('/api/admin/users/:id/roles', adminUserRoleAssignHandler);
app.delete('/api/admin/users/:id/roles/:assignmentId', adminUserRoleRemoveHandler);

// User relationship management
app.get('/api/admin/users/:id/relationships', adminUserRelationshipsListHandler);
app.post('/api/admin/users/:id/relationships', adminUserRelationshipCreateHandler);
app.delete(
  '/api/admin/users/:id/relationships/:relationshipId',
  adminUserRelationshipDeleteHandler
);

// User effective permissions (aggregated from all sources)
app.get('/api/admin/users/:id/effective-permissions', adminUserEffectivePermissionsHandler);

// =============================================================================
// ReBAC Management (Relationship-Based Access Control)
// =============================================================================
// Manages relation definitions (Zanzibar-style DSL) and relationship tuples.
// RBAC: Requires system_admin role.
app.use('/api/admin/rebac', requireSystemAdmin());
app.use('/api/admin/rebac/*', requireSystemAdmin());

// Relation definitions management
app.get('/api/admin/rebac/relation-definitions', adminRelationDefinitionsListHandler);
app.get('/api/admin/rebac/relation-definitions/:id', adminRelationDefinitionGetHandler);
app.post('/api/admin/rebac/relation-definitions', adminRelationDefinitionCreateHandler);
app.put('/api/admin/rebac/relation-definitions/:id', adminRelationDefinitionUpdateHandler);
app.delete('/api/admin/rebac/relation-definitions/:id', adminRelationDefinitionDeleteHandler);

// Relationship tuples management
app.get('/api/admin/rebac/tuples', adminRelationshipTuplesListHandler);
app.post('/api/admin/rebac/tuples', adminRelationshipTupleCreateHandler);
app.delete('/api/admin/rebac/tuples/:id', adminRelationshipTupleDeleteHandler);

// Permission check simulation
app.post('/api/admin/rebac/check', adminRelationshipCheckHandler);

// Object types summary
app.get('/api/admin/rebac/object-types', adminObjectTypesListHandler);

// =============================================================================
// ABAC (Attribute-Based Access Control)
// =============================================================================
// Manages user attributes for ABAC policy evaluation.
// Attributes can come from VCs, SAML, or manual assignment.
app.use(
  '/api/admin/attributes',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/attributes/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

// Attribute management
app.get('/api/admin/attributes', adminAttributesListHandler);
app.get('/api/admin/attributes/stats', adminAttributeStatsHandler);
app.get('/api/admin/attributes/names', adminAttributeNamesHandler);
app.get('/api/admin/attributes/verifications', adminVerificationsListHandler);
app.get('/api/admin/attributes/users/:userId', adminUserAttributesHandler);
app.post('/api/admin/attributes', adminAttributeCreateHandler);
app.put('/api/admin/attributes/:id', adminAttributeUpdateHandler);
app.delete('/api/admin/attributes/:id', adminAttributeDeleteHandler);
app.delete('/api/admin/attributes/expired', adminDeleteExpiredAttributesHandler);

// =============================================================================
// Custom Claim Schemas Management
// =============================================================================
// Defines and manages custom claim field schemas.
// Controls field types, validation rules, PII classification,
// and OIDC token/endpoint inclusion settings.
// RBAC: Requires tenant_admin or higher role.

app.use(
  '/api/admin/custom-claims',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/custom-claims/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

app.get('/api/admin/custom-claims', adminCustomClaimsListHandler);
app.post('/api/admin/custom-claims', adminCustomClaimCreateHandler);
app.get('/api/admin/custom-claims/presets', adminCustomClaimPresetsListHandler);
app.post('/api/admin/custom-claims/presets/apply', adminCustomClaimPresetApplyHandler);
app.get('/api/admin/custom-claims/reserved-names', adminCustomClaimsReservedNamesHandler);
app.get('/api/admin/custom-claims/stats', adminCustomClaimsStatsHandler);
app.post(
  '/api/admin/custom-claims/required-violations/detect',
  adminCustomClaimRequiredViolationsDetectHandler
);
app.get('/api/admin/custom-claims/:id', adminCustomClaimGetHandler);
app.put('/api/admin/custom-claims/:id', adminCustomClaimUpdateHandler);
app.delete('/api/admin/custom-claims/:id', adminCustomClaimDeleteHandler);
app.patch('/api/admin/custom-claims/:id/rename', adminCustomClaimRenameHandler);
app.post('/api/admin/custom-claims/:id/retry', adminCustomClaimRetryHandler);
app.get('/api/admin/custom-claims/:schemaId/history', adminCustomClaimHistoryListHandler);
app.get(
  '/api/admin/custom-claims/:schemaId/history/:version',
  adminCustomClaimHistoryVersionHandler
);

// =============================================================================
// Policy Rules Management (Visual Policy Builder)
// =============================================================================
// Manages custom policy rules for fine-grained access control.
// Supports RBAC, ABAC, time-based, geo, and rate conditions.
// RBAC: Requires tenant_admin or higher role.

app.use(
  '/api/admin/policies',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/policies/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

// Policy rules CRUD
app.get('/api/admin/policies', adminPoliciesListHandler);
app.post('/api/admin/policies', adminPolicyCreateHandler);
app.get('/api/admin/policies/condition-types', adminConditionTypesHandler);
app.get('/api/admin/policies/simulations', adminPolicySimulationsHandler);
app.post('/api/admin/policies/simulate', adminPolicySimulateHandler);
app.get('/api/admin/policies/:id', adminPolicyGetHandler);
app.put('/api/admin/policies/:id', adminPolicyUpdateHandler);
app.delete('/api/admin/policies/:id', adminPolicyDeleteHandler);

// =============================================================================
// Flow Management (Flow Engine Admin UI)
// =============================================================================
// Manages authentication/authorization flows per tenant/client.
// Flows define the steps and capabilities required for different auth scenarios.
// RBAC: Requires tenant_admin or higher role.

app.use('/api/admin/flows', requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin']));
app.use(
  '/api/admin/flows/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

// Flow CRUD endpoints
app.get('/api/admin/flows', adminFlowsListHandler);
app.post('/api/admin/flows', adminFlowCreateHandler);
app.get('/api/admin/flows/node-types', adminFlowNodeTypesHandler);
app.get('/api/admin/flows/:id', adminFlowGetHandler);
app.put('/api/admin/flows/:id', adminFlowUpdateHandler);
app.delete('/api/admin/flows/:id', adminFlowDeleteHandler);
app.post('/api/admin/flows/:id/copy', adminFlowCopyHandler);
app.post('/api/admin/flows/:id/validate', adminFlowValidateHandler);
app.post('/api/admin/flows/:id/compile', adminFlowCompileHandler);

// =============================================================================
// Access Trace (Permission Check Audit Logs)
// =============================================================================
// Real-time access decision logs for debugging and monitoring.
// Shows which rules allowed/denied access and why.
// RBAC: Requires tenant_admin or higher role.

app.use(
  '/api/admin/access-trace',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/access-trace/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

// Access trace endpoints
app.get('/api/admin/access-trace', adminAccessTraceListHandler);
app.get('/api/admin/access-trace/stats', adminAccessTraceStatsHandler);
app.get('/api/admin/access-trace/timeline', adminAccessTraceTimelineHandler);
app.get('/api/admin/access-trace/:id', adminAccessTraceGetHandler);

// =============================================================================
// Access Control Hub (Aggregated Statistics)
// =============================================================================
// Provides aggregated statistics for RBAC, ABAC, ReBAC, and Policies.
// Used by the Access Control Hub dashboard.

// Rate limiting for Access Control stats
app.use('/api/admin/access-control/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/access-control'],
  })(c, next);
});

// RBAC: Require admin role for access control stats
app.use(
  '/api/admin/access-control/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

// Access Control Hub endpoints
app.get('/api/admin/access-control/stats', adminAccessControlStatsHandler);

// =============================================================================
// AI Grants (Human Auth / AI Ephemeral Auth Two-Layer Model)
// =============================================================================
// Manages grants that authorize AI principals (agents, tools, services) to act
// on behalf of users or systems. Used for MCP integration and AI-to-AI delegation.
// Rate limited with RateLimitProfiles.moderate.
// AuthZ: Human admins require system_admin/distributor_admin; machine callers
// require scoped Admin Machine Access permissions such as admin:ai_grants:*.

// Rate limiting for AI Grants endpoints
app.use('/api/admin/ai-grants', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/ai-grants'],
  })(c, next);
});

app.get(
  '/api/admin/ai-grants',
  requireAiGrantAdminAccess(ADMIN_PERMISSIONS.AI_GRANTS_READ),
  adminAIGrantsListHandler
);
app.get(
  '/api/admin/ai-grants/:id',
  requireAiGrantAdminAccess(ADMIN_PERMISSIONS.AI_GRANTS_READ),
  adminAIGrantGetHandler
);
app.post(
  '/api/admin/ai-grants',
  requireAiGrantAdminAccess(ADMIN_PERMISSIONS.AI_GRANTS_CREATE),
  adminAIGrantCreateHandler
);
app.put(
  '/api/admin/ai-grants/:id',
  requireAiGrantAdminAccess(ADMIN_PERMISSIONS.AI_GRANTS_UPDATE),
  adminAIGrantUpdateHandler
);
app.delete(
  '/api/admin/ai-grants/:id',
  requireAiGrantAdminAccess(ADMIN_PERMISSIONS.AI_GRANTS_REVOKE),
  adminAIGrantRevokeHandler
);

// =============================================================================
// Policy ↔ Identity Integration (Phase 8.1)
// =============================================================================

// Role Assignment Rules endpoints
app.post('/api/admin/role-assignment-rules', createRoleAssignmentRule);
app.get('/api/admin/role-assignment-rules', listRoleAssignmentRules);
app.post('/api/admin/role-assignment-rules/evaluate', evaluateRoleAssignmentRules);
app.get('/api/admin/role-assignment-rules/:id', getRoleAssignmentRule);
app.put('/api/admin/role-assignment-rules/:id', updateRoleAssignmentRule);
app.delete('/api/admin/role-assignment-rules/:id', deleteRoleAssignmentRule);
app.post('/api/admin/role-assignment-rules/:id/test', testRoleAssignmentRule);

// Organization Domain Mappings endpoints
app.post('/api/admin/org-domain-mappings', createOrgDomainMapping);
app.get('/api/admin/org-domain-mappings', listOrgDomainMappings);
app.post('/api/admin/org-domain-mappings/verify', verifyDomainOwnership);
app.post('/api/admin/org-domain-mappings/verify/confirm', confirmDomainVerification);
app.get('/api/admin/org-domain-mappings/:id', getOrgDomainMapping);
app.put('/api/admin/org-domain-mappings/:id', updateOrgDomainMapping);
app.delete('/api/admin/org-domain-mappings/:id', deleteOrgDomainMapping);
app.get('/api/admin/organizations/:org_id/domain-mappings', listOrgDomainMappingsByOrg);

// [DEPRECATED] JIT Provisioning Configuration
// → Migrate to: /api/admin/tenants/:tenantId/settings/federation
app.get('/api/admin/settings/jit-provisioning', getJITProvisioningConfig);
app.put('/api/admin/settings/jit-provisioning', updateJITProvisioningConfig);
app.delete('/api/admin/settings/jit-provisioning', resetJITProvisioningConfig);

// [DEPRECATED] Domain Hash Key Rotation
// → Migrate to: /api/admin/platform/settings/encryption
// NOTE: Has rotate/complete lifecycle operations - keep for key management
app.get('/api/admin/settings/domain-hash-keys', getDomainHashKeysConfig);
app.post('/api/admin/settings/domain-hash-keys/rotate', rotateDomainHashKey);
app.put('/api/admin/settings/domain-hash-keys/complete', completeDomainHashKeyRotation);
app.get('/api/admin/settings/domain-hash-keys/status', getDomainHashKeyStatus);
app.delete('/api/admin/settings/domain-hash-keys/:version', deleteDomainHashKeyVersion);

// =============================================================================
// Token Embedding Model (Phase 8.2)
// =============================================================================

// Token Claim Rules endpoints
app.post('/api/admin/token-claim-rules', createTokenClaimRule);
app.get('/api/admin/token-claim-rules', listTokenClaimRules);
app.post('/api/admin/token-claim-rules/evaluate', evaluateTokenClaimRules);
app.get('/api/admin/token-claim-rules/:id', getTokenClaimRule);
app.put('/api/admin/token-claim-rules/:id', updateTokenClaimRule);
app.delete('/api/admin/token-claim-rules/:id', deleteTokenClaimRule);
app.post('/api/admin/token-claim-rules/:id/test', testTokenClaimRuleHandler);

// Resource Permissions endpoints (ID-level permissions)
app.post('/api/admin/resource-permissions', createResourcePermission);
app.get('/api/admin/resource-permissions', listResourcePermissions);
app.post('/api/admin/resource-permissions/check', checkResourcePermission);
app.get('/api/admin/resource-permissions/subject/:id', getPermissionsBySubject);
app.get('/api/admin/resource-permissions/resource/:type/:id', getPermissionsByResource);
app.delete('/api/admin/resource-permissions/:id', deleteResourcePermission);

// [DEPRECATED] Token Embedding Settings
// → Migrate to: /api/admin/tenants/:tenantId/settings/tokens
app.get('/api/admin/settings/token-embedding', getTokenEmbeddingSettings);
app.put('/api/admin/settings/token-embedding', updateTokenEmbeddingSettings);

// [DEPRECATED] Logout Configuration (Phase A-6)
// → Migrate to: /api/admin/tenants/:tenantId/settings/session
app.get('/api/admin/settings/logout', getLogoutConfig);
app.put('/api/admin/settings/logout', updateLogoutConfig);
app.delete('/api/admin/settings/logout', resetLogoutConfig);

// Logout Failure Visibility endpoints (Phase A-6)
app.get('/api/admin/settings/logout/failures', listLogoutFailures);
app.get('/api/admin/settings/logout/failures/:clientId', getLogoutFailure);
app.delete('/api/admin/settings/logout/failures/:clientId', clearLogoutFailure);
app.delete('/api/admin/settings/logout/failures', clearAllLogoutFailures);

// Logout Webhook Configuration (Simple Logout Webhook - Authrim Extension)
// Rate limited with RateLimitProfiles.moderate to prevent abuse
app.use('/api/admin/settings/logout-webhook', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/logout-webhook'],
  })(c, next);
});

app.get('/api/admin/settings/logout-webhook', getLogoutWebhookConfig);
app.put('/api/admin/settings/logout-webhook', updateLogoutWebhookConfig);
app.delete('/api/admin/settings/logout-webhook', resetLogoutWebhookConfig);

// Check API Key Management endpoints (Phase 8.3)
app.post('/api/admin/check-api-keys', createCheckApiKey);
app.get('/api/admin/check-api-keys', listCheckApiKeys);
app.get('/api/admin/check-api-keys/:id', getCheckApiKey);
app.delete('/api/admin/check-api-keys/:id', deleteCheckApiKey);
app.post('/api/admin/check-api-keys/:id/rotate', rotateCheckApiKey);

// =============================================================================
// VC Credential Status Management (Phase 9)
// =============================================================================

// Credential status management endpoints
app.post('/api/admin/vc/credentials/:id/revoke', revokeCredentialHandler);
app.post('/api/admin/vc/credentials/:id/suspend', suspendCredentialHandler);
app.post('/api/admin/vc/credentials/:id/activate', activateCredentialHandler);

// Status list management endpoints
app.get('/api/admin/vc/status-lists', listStatusListsHandler);
app.get('/api/admin/vc/status-lists/stats', getStatusListStatsHandler); // Must be before :id
app.get('/api/admin/vc/status-lists/:id', getStatusListHandler);

// =============================================================================
// Plugin Management (Phase 9 - Plugin Architecture)
// =============================================================================

// Platform/global plugin management. System admins may manage global defaults or
// target a tenant explicitly with tenant_id/X-Tenant-Id.
app.use('/api/admin/platform/plugins/*', requireSystemAdmin(), platformPluginScopeMiddleware);
app.use('/api/admin/platform/plugins', requireSystemAdmin(), platformPluginScopeMiddleware);
app.get('/api/admin/platform/plugins', listPluginsHandler);
app.get('/api/admin/platform/plugins/:id', getPluginHandler);
app.get('/api/admin/platform/plugins/:id/config', getPluginConfigHandler);
app.put('/api/admin/platform/plugins/:id/config', updatePluginConfigHandler);
app.post('/api/admin/platform/plugins/:id/test-email', sendPluginTestEmailHandler);
app.put('/api/admin/platform/plugins/:id/enable', enablePluginHandler);
app.put('/api/admin/platform/plugins/:id/disable', disablePluginHandler);
app.get('/api/admin/platform/plugins/:id/health', getPluginHealthHandler);
app.get('/api/admin/platform/plugins/:id/schema', getPluginSchemaHandler);

// Plugin listing and details
app.get('/api/admin/plugins', listPluginsHandler);
app.get('/api/admin/plugins/:id', getPluginHandler);

// Plugin configuration
app.get('/api/admin/plugins/:id/config', getPluginConfigHandler);
app.put('/api/admin/plugins/:id/config', updatePluginConfigHandler);
app.post('/api/admin/plugins/:id/test-email', sendPluginTestEmailHandler);

// Plugin enable/disable
app.put('/api/admin/plugins/:id/enable', enablePluginHandler);
app.put('/api/admin/plugins/:id/disable', disablePluginHandler);

// Plugin health and schema
app.get('/api/admin/plugins/:id/health', getPluginHealthHandler);
app.get('/api/admin/plugins/:id/schema', getPluginSchemaHandler);

// =============================================================================
// Native SSO Settings (OIDC Native SSO 1.0)
// =============================================================================
// Settings for Native SSO feature (device_secret, ds_hash, Token Exchange)
// - GET: Retrieve current settings with value sources
// - PUT: Update settings (partial update supported)
// - DELETE: Reset to defaults
app.get('/api/admin/settings/native-sso', getNativeSSOSettingsConfig);
app.put('/api/admin/settings/native-sso', updateNativeSSOConfig);
app.delete('/api/admin/settings/native-sso', clearNativeSSOConfig);

// Device Secret Management (Native SSO)
// - List user's device secrets (with pagination and summary)
// - Get, revoke individual device secrets
// - Bulk revoke all device secrets for a user
// - Cleanup expired device secrets
app.get('/api/admin/users/:userId/device-secrets', listUserDeviceSecrets);
app.delete('/api/admin/users/:userId/device-secrets', revokeAllUserDeviceSecrets);
app.post('/api/admin/device-secrets/cleanup', cleanupExpiredDeviceSecrets); // Must be before :id
app.get('/api/admin/device-secrets/:id', getDeviceSecret);
app.delete('/api/admin/device-secrets/:id', revokeDeviceSecret);

// =============================================================================
// Webhook Management (Unified Event System)
// =============================================================================
// CRUD operations for webhook configurations.
// Webhooks can be tenant-level (receive all events) or client-level (receive specific client events).
// RBAC: Requires tenant_admin or higher role.
// Rate limit: lenient profile.

// Rate limiting for Webhook endpoints
app.use('/api/admin/webhooks', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/webhooks'],
  })(c, next);
});
app.use('/api/admin/webhooks/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/webhooks/*'],
  })(c, next);
});

app.post(
  '/api/admin/webhooks',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_WRITE]),
  createWebhook
);
app.get(
  '/api/admin/webhooks',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_READ]),
  listWebhooks
);
app.get(
  '/api/admin/webhooks/:id',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_READ]),
  getWebhook
);
app.put(
  '/api/admin/webhooks/:id',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_WRITE]),
  updateWebhook
);
app.delete(
  '/api/admin/webhooks/:id',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_DELETE]),
  deleteWebhook
);
app.post(
  '/api/admin/webhooks/:id/test',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_WRITE]),
  testWebhook
);
app.get(
  '/api/admin/webhooks/:id/deliveries',
  requireAdminPermissions([ADMIN_PERMISSIONS.WEBHOOKS_READ]),
  listWebhookDeliveries
);
app.get(
  '/api/admin/webhooks/:id/deliveries/:deliveryId',
  requireAdminPermissions([
    ADMIN_PERMISSIONS.WEBHOOKS_READ,
    ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ,
  ]),
  getWebhookDelivery
);
app.post(
  '/api/admin/webhooks/:id/replay',
  requireAdminPermissions([
    ADMIN_PERMISSIONS.WEBHOOKS_WRITE,
    ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ,
  ]),
  replayWebhookDelivery
);

// =============================================================================
// Identity Mapping Preview API
// =============================================================================
// Dry-run only. Does not persist CSV rows or canonical identity values.
app.post(
  '/api/admin/identity-mapping/preview/csv',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminCsvDryRunPreviewHandler
);
app.post(
  '/api/admin/identity-mapping/preview/saml',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminSamlReleasePreviewHandler
);
app.post(
  '/api/admin/identity-mapping/preview/oidc',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminOidcReleasePreviewHandler
);
app.get(
  '/api/admin/identity-mapping/catalogs',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingCatalogsListHandler
);
app.post(
  '/api/admin/identity-mapping/catalogs',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingCatalogCreateHandler
);
app.get(
  '/api/admin/identity-mapping/protocol-schemas',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingProtocolSchemasListHandler
);
app.post(
  '/api/admin/identity-mapping/protocol-schemas',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingProtocolSchemaCreateHandler
);
app.get(
  '/api/admin/identity-mapping/external-schemas',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingExternalSchemasListHandler
);
app.post(
  '/api/admin/identity-mapping/external-schemas',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingExternalSchemaImportHandler
);
app.get(
  '/api/admin/identity-mapping/source-profiles',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingSourceProfilesListHandler
);
app.post(
  '/api/admin/identity-mapping/source-profiles/csv/parse',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingCsvSourceProfileParseHandler
);
app.post(
  '/api/admin/identity-mapping/source-profiles',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceProfileCreateHandler
);
app.put(
  '/api/admin/identity-mapping/source-profiles/:sourceProfileId',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceProfileUpdateHandler
);
app.post(
  '/api/admin/identity-mapping/source-profiles/:sourceProfileId/versions/:sourceProfileVersionId/review',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceProfileReviewHandler
);
app.post(
  '/api/admin/identity-mapping/source-profiles/:sourceProfileId/versions/:sourceProfileVersionId/activate',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceProfileActivateHandler
);
app.delete(
  '/api/admin/identity-mapping/source-profiles/:sourceProfileId',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceProfileDeleteHandler
);
app.get(
  '/api/admin/identity-mapping/destination-profiles',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingDestinationProfilesListHandler
);
app.post(
  '/api/admin/identity-mapping/destination-profiles',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingDestinationProfileCreateHandler
);
app.put(
  '/api/admin/identity-mapping/destination-profiles/:destinationProfileId',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingDestinationProfileUpdateHandler
);
app.post(
  '/api/admin/identity-mapping/destination-profiles/:destinationProfileId/versions/:destinationProfileVersionId/review',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingDestinationProfileReviewHandler
);
app.post(
  '/api/admin/identity-mapping/destination-profiles/:destinationProfileId/versions/:destinationProfileVersionId/activate',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingDestinationProfileActivateHandler
);
app.delete(
  '/api/admin/identity-mapping/destination-profiles/:destinationProfileId',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingDestinationProfileDeleteHandler
);
app.get(
  '/api/admin/identity-mapping/oidc/custom-scopes',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingOidcCustomScopesListHandler
);
app.post(
  '/api/admin/identity-mapping/oidc/custom-scopes',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingOidcCustomScopeCreateHandler
);
app.get(
  '/api/admin/identity-mapping/oidc/custom-claims',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingOidcCustomClaimsListHandler
);
app.post(
  '/api/admin/identity-mapping/oidc/custom-claims',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingOidcCustomClaimCreateHandler
);
app.get(
  '/api/admin/identity-mapping/templates',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingTemplatesListHandler
);
app.post(
  '/api/admin/identity-mapping/templates',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingTemplateCreateHandler
);
app.get(
  '/api/admin/identity-mapping/policies',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingPoliciesListHandler
);
app.post(
  '/api/admin/identity-mapping/policies',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingPolicyCreateHandler
);
app.post(
  '/api/admin/identity-mapping/policies/:policySetId/versions',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingPolicyVersionCreateHandler
);
app.get(
  '/api/admin/identity-mapping/policies/:policySetId/versions',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingPolicyVersionsListHandler
);
app.post(
  '/api/admin/identity-mapping/policies/:policySetId/versions/:policyVersionId/publish',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingPolicyVersionPublishHandler
);
app.post(
  '/api/admin/identity-mapping/policies/:policySetId/versions/:policyVersionId/compile',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingPolicyVersionCompileHandler
);
app.post(
  '/api/admin/identity-mapping/policies/:policySetId/versions/:policyVersionId/activate',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingPolicyVersionActivateHandler
);
app.post(
  '/api/admin/identity-mapping/policies/:policySetId/rollback',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingPolicyRollbackHandler
);
app.get(
  '/api/admin/identity-mapping/source-authority-contracts',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingSourceAuthorityContractsListHandler
);
app.post(
  '/api/admin/identity-mapping/source-authority-contracts',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceAuthorityContractCreateHandler
);
app.post(
  '/api/admin/identity-mapping/source-authority-contracts/evaluate',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingSourceAuthorityEvaluateHandler
);
app.get(
  '/api/admin/identity-mapping/schema-readiness',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingSchemaReadinessHandler
);
app.get(
  '/api/admin/identity-mapping/review-tasks',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingReviewTasksListHandler
);
app.post(
  '/api/admin/identity-mapping/review-tasks',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingReviewTaskCreateHandler
);
app.post(
  '/api/admin/identity-mapping/review-tasks/:reviewTaskId/transition',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingReviewTaskTransitionHandler
);
app.post(
  '/api/admin/identity-mapping/review-task-groups',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingReviewTaskGroupCreateHandler
);
app.post(
  '/api/admin/identity-mapping/operational-notifications',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingOperationalNotificationCreateHandler
);
app.post(
  '/api/admin/identity-mapping/operational-notification-states/:stateId/acknowledge',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingOperationalNotificationAcknowledgeHandler
);
app.post(
  '/api/admin/identity-mapping/operational-notification-states/:stateId/resolve',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingOperationalNotificationResolveHandler
);
app.post(
  '/api/admin/identity-mapping/groups',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingGroupCreateHandler
);
app.post(
  '/api/admin/identity-mapping/groups/:groupId/memberships',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingGroupMembershipCreateHandler
);
app.post(
  '/api/admin/identity-mapping/entitlements',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingEntitlementGrantHandler
);
app.post(
  '/api/admin/identity-mapping/provisioning-assignment-rules',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingProvisioningAssignmentRuleCreateHandler
);
app.post(
  '/api/admin/identity-mapping/provisioning-assignment-rules/:ruleId/evaluate',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingProvisioningAssignmentRuleEvaluateHandler
);
app.post(
  '/api/admin/identity-mapping/lifecycle-signals',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingLifecycleSignalRecordHandler
);
app.post(
  '/api/admin/identity-mapping/key-registries',
  requireAdminPermissions([
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
  ]),
  adminIdentityMappingKeyRegistryCreateHandler
);
app.get(
  '/api/admin/identity-mapping/key-registries',
  requireAdminPermissions([
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
  ]),
  adminIdentityMappingKeyRegistriesListHandler
);
app.post(
  '/api/admin/identity-mapping/key-registries/:keyRegistryId/rotate',
  requireAdminPermissions([
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
  ]),
  adminIdentityMappingKeyRegistryRotateHandler
);
app.post(
  '/api/admin/identity-mapping/key-registries/:keyRegistryId/access-events',
  requireAdminPermissions([
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
  ]),
  adminIdentityMappingKeyAccessRecordHandler
);
app.post(
  '/api/admin/identity-mapping/federation-trust-sources',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingFederationTrustSourceCreateHandler
);
app.get(
  '/api/admin/identity-mapping/federation-trust-sources',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingFederationTrustSourcesListHandler
);
app.put(
  '/api/admin/identity-mapping/federation-trust-sources/:trustSourceId',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingFederationTrustSourceUpdateHandler
);
app.delete(
  '/api/admin/identity-mapping/federation-trust-sources/:trustSourceId',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingFederationTrustSourceDeleteHandler
);
app.get(
  '/api/admin/identity-mapping/federation-trust-sources/:trustSourceId/metadata-documents',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_READ]),
  adminIdentityMappingFederationMetadataDocumentsListHandler
);
app.post(
  '/api/admin/identity-mapping/federation-metadata-documents',
  requireAdminPermissions([ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminIdentityMappingFederationMetadataDocumentCreateHandler
);

// =============================================================================
// Logging Configuration API
// =============================================================================
// Manage logging settings dynamically via KV.
// Supports global settings and per-tenant overrides.
// RBAC: Requires system_admin role for global settings.
// Rate limit: moderate profile.

// Rate limiting for Logging config endpoints
app.use('/api/admin/settings/logging', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/logging'],
  })(c, next);
});
app.use('/api/admin/settings/logging/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/logging/*'],
  })(c, next);
});

// Global logging config (system_admin only)
app.get('/api/admin/settings/logging', requireSystemAdmin(), getLoggingConfig);
app.put('/api/admin/settings/logging', requireSystemAdmin(), updateLoggingConfig);
app.delete('/api/admin/settings/logging', requireSystemAdmin(), resetLoggingConfig);

// Tenant-specific logging overrides
app.get('/api/admin/settings/logging/tenants', listTenantLoggingOverrides);
app.get('/api/admin/settings/logging/tenant/:tenantId', getTenantLoggingConfig);
app.put('/api/admin/settings/logging/tenant/:tenantId', updateTenantLoggingConfig);
app.delete('/api/admin/settings/logging/tenant/:tenantId', resetTenantLoggingConfig);

// =============================================================================
// Audit PII Configuration API
// =============================================================================
// Per-tenant PII configuration for audit logging.
// Determines which fields are PII, encryption settings, retention periods.
// RBAC: Requires tenant_admin or higher.
// Rate limit: moderate profile.

// Rate limiting for Audit PII config endpoints
app.use('/api/admin/tenants/:tenantId/audit/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/tenants/:tenantId/audit/*'],
  })(c, next);
});

// RBAC for PII config
app.use(
  '/api/admin/tenants/:tenantId/audit/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

app.get('/api/admin/tenants/:tenantId/audit/pii-config', getTenantPIIConfig);
app.put('/api/admin/tenants/:tenantId/audit/pii-config', updateTenantPIIConfig);
app.delete('/api/admin/tenants/:tenantId/audit/pii-config', resetTenantPIIConfig);
app.post('/api/admin/tenants/:tenantId/audit/pii-config/preset/gdpr', applyGDPRPreset);
app.post('/api/admin/tenants/:tenantId/audit/pii-config/preset/minimal', applyMinimalPreset);

// List all tenant PII configs (system_admin only)
app.get('/api/admin/settings/audit/pii-config', requireSystemAdmin(), listAllTenantPIIConfigs);

// =============================================================================
// Audit Storage Configuration API
// =============================================================================
// Manage audit log storage backends, routing rules, and retention policies.
// RBAC: Requires system_admin role (infrastructure-level settings).
// Rate limit: moderate profile.

// Rate limiting for Audit Storage config endpoints
app.use('/api/admin/settings/audit-storage', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/audit-storage'],
  })(c, next);
});
app.use('/api/admin/settings/audit-storage/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/settings/audit-storage/*'],
  })(c, next);
});

// Storage config (system_admin only)
app.get('/api/admin/settings/audit-storage', requireSystemAdmin(), getAuditStorageConfig);
app.put('/api/admin/settings/audit-storage', requireSystemAdmin(), updateAuditStorageConfig);

// Retention config
app.get('/api/admin/settings/audit-storage/retention', requireSystemAdmin(), getRetentionConfig);
app.put('/api/admin/settings/audit-storage/retention', requireSystemAdmin(), updateRetentionConfig);

// Routing rules
app.get('/api/admin/settings/audit-storage/routing-rules', requireSystemAdmin(), getRoutingRules);
app.put(
  '/api/admin/settings/audit-storage/routing-rules',
  requireSystemAdmin(),
  updateRoutingRules
);
app.post('/api/admin/settings/audit-storage/routing-rules', requireSystemAdmin(), addRoutingRule);
app.delete(
  '/api/admin/settings/audit-storage/routing-rules/:name',
  requireSystemAdmin(),
  deleteRoutingRule
);

// Maintenance operations
app.post(
  '/api/admin/settings/audit-storage/cleanup',
  requireSystemAdmin(),
  triggerRetentionCleanup
);
app.get('/api/admin/settings/audit-storage/stats', requireSystemAdmin(), getStorageStats);

// =============================================================================
// Admin Jobs Management (Async Job Tracking)
// =============================================================================
// Endpoints for tracking async job execution status and results.
// Used for bulk imports, exports, and other long-running operations.
// RBAC: Requires tenant_admin or higher role.
// Rate limit: moderate profile.

// Rate limiting for Jobs endpoints
app.use('/api/admin/jobs', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/jobs'],
  })(c, next);
});
app.use('/api/admin/jobs/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/jobs/*'],
  })(c, next);
});

registerAdminJobPermissionMiddleware(app);

app.get('/api/admin/jobs', adminJobsListHandler);
// Job creation endpoints (must be before :id routes)
app.post('/api/admin/jobs/users/import/upload-url', adminJobsImportUploadUrlHandler);
app.put('/api/admin/jobs/users/import/upload/:upload_id', adminJobsImportUploadHandler);
app.post('/api/admin/jobs/users/import', adminJobsUsersImportHandler);
app.post('/api/admin/jobs/users/bulk-update', adminJobsUsersBulkUpdateHandler);
app.post('/api/admin/jobs/tenant-databases/provision', adminJobsTenantDatabaseProvisionHandler);
app.post(
  '/api/admin/jobs/tenant-databases/activate-batch',
  adminJobsTenantDatabaseActivateBatchHandler
);
app.post('/api/admin/jobs/reports/generate', adminJobsReportsGenerateHandler);
app.post('/api/admin/jobs/organizations/:id/bulk-members', adminJobsOrgBulkMembersHandler);
// Job status endpoints
app.get('/api/admin/jobs/types', adminJobTypesHandler);
app.get('/api/admin/jobs/artifacts/:artifactId', adminJobResultArtifactManifestHandler);
app.get('/api/admin/jobs/artifacts/:artifactId/download', adminJobResultArtifactDownloadHandler);
app.get('/api/admin/jobs/artifacts/:artifactId/chunks/:index', adminJobResultArtifactChunkHandler);
app.get('/api/admin/jobs/:id/result', adminJobResultHandler); // Must be before :id
app.get('/api/admin/jobs/:id/result/download', adminJobResultDownloadHandler);
app.get('/api/admin/jobs/:id', adminJobGetHandler);

// =============================================================================
// Privacy-Preserving Support Operations
// =============================================================================
app.route('/api/admin/support-ops', supportOpsRouter);

// =============================================================================
// Admin Statistics API (Dashboard Analytics)
// =============================================================================
// Time-series and aggregate statistics for administrative dashboards.
// Supports date range filtering, interval selection, and timezone output.
// RBAC: Requires tenant_admin or higher role.
// Rate limit: moderate profile.

// Rate limiting for Stats endpoints
app.use('/api/admin/stats/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/stats/*'],
  })(c, next);
});

// RBAC: Require tenant_admin or higher for statistics access
app.use(
  '/api/admin/stats/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

app.get('/api/admin/stats/tokens', adminStatsTokensHandler);
app.get('/api/admin/stats/auth', adminStatsAuthHandler);
app.get('/api/admin/stats/timeline', adminStatsTimelineHandler);
app.get('/api/admin/stats/geography', adminStatsGeographyHandler);
app.get('/api/admin/stats/clients/:id', adminStatsClientHandler);

// =============================================================================
// Security Alerts API
// =============================================================================
// Security monitoring and alert management endpoints.
// Routes:
// - GET  /api/admin/security/alerts - List security alerts
// - POST /api/admin/security/alerts/:id/acknowledge - Acknowledge alert
//
// Security:
// - RBAC: tenant_admin or higher required
// - Rate limit: moderate profile
// - Tenant isolation: All queries scoped by tenant_id
// =============================================================================

// Rate limiting for Security endpoints (moderate profile: 60 req/min)
app.use('/api/admin/security/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/security/*'],
  })(c, next);
});

// RBAC: Require tenant_admin or higher for security alerts
app.use(
  '/api/admin/security/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

app.get('/api/admin/security/alerts', adminSecurityAlertsListHandler);
app.post('/api/admin/security/alerts/:id/acknowledge', adminSecurityAlertAcknowledgeHandler);
app.get('/api/admin/security/suspicious-activities', adminSecuritySuspiciousActivitiesHandler);
app.get('/api/admin/security/threats', adminSecurityThreatsHandler);
app.post('/api/admin/security/ip-reputation', adminSecurityIpReputationHandler);

// =============================================================================
// Compliance API
// =============================================================================
// Compliance monitoring and status overview.
// Routes:
// - GET /api/admin/compliance/status - Get compliance status
//
// Security:
// - RBAC: tenant_admin or higher required
// - Tenant isolation: All data scoped by tenant_id
// =============================================================================
app.use(
  '/api/admin/compliance/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

app.get('/api/admin/compliance/status', adminComplianceStatusHandler);
app.get('/api/admin/compliance/access-reviews', adminComplianceAccessReviewsListHandler);
app.post('/api/admin/compliance/access-reviews', adminComplianceAccessReviewsCreateHandler);
app.get('/api/admin/compliance/reports', adminComplianceReportsListHandler);

// =============================================================================
// Data Retention API (Phase 3)
// =============================================================================
// Data retention policy status and statistics.
// Routes:
// - GET /api/admin/data-retention/status - Get retention policy status
//
// Security:
// - RBAC: tenant_admin or higher required
// - Tenant isolation: All data scoped by tenant_id
// =============================================================================
app.use(
  '/api/admin/data-retention/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.get('/api/admin/data-retention/status', adminDataRetentionStatusHandler);
app.get('/api/admin/data-retention/estimate', getDataRetentionEstimate);
app.get('/api/admin/data-retention/categories', listRetentionCategories);
app.put('/api/admin/data-retention/categories/:category', updateCategoryRetention);
app.post('/api/admin/data-retention/cleanup', runDataRetentionCleanup);
app.get('/api/admin/data-retention/cleanup/:runId', getCleanupRunStatus);

// =============================================================================
// User Consent Management API (GDPR Article 7 - User Rights)
// =============================================================================
// User-facing endpoints for viewing and revoking consents.
// Supports both access token (Bearer) and session-based authentication.
// Rate limit: moderate profile.

// CSRF protection for User API - validates Origin/Referer on state-changing requests
app.use('/api/user/*', csrfProtectionMiddleware());

// Rate limiting for User consent endpoints
app.use('/api/user/consents', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/user/consents'],
  })(c, next);
});
app.use('/api/user/consents/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/user/consents/*'],
  })(c, next);
});

// User consent routes - authentication is handled inside handlers (token or session)
app.get('/api/user/consents', userConsentsListHandler);
app.delete('/api/user/consents/:clientId', userConsentRevokeHandler);

// =============================================================================
// Data Portability API (GDPR Article 20 - Right to Data Portability)
// =============================================================================
// User-facing endpoints for exporting personal data.
// Supports both access token (Bearer) and session-based authentication.
// Implements hybrid processing: sync for small data, async for large data.
// Rate limit: lenient profile (export is expensive).

// Rate limiting for Data export endpoints
app.use('/api/user/data-export', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/user/data-export'],
  })(c, next);
});
app.use('/api/user/data-export/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/user/data-export/*'],
  })(c, next);
});

// Data export routes
app.post('/api/user/data-export', dataExportRequestHandler);
app.get('/api/user/data-export/artifacts/:artifactId', dataExportArtifactManifestHandler);
app.get('/api/user/data-export/artifacts/:artifactId/download', dataExportArtifactDownloadHandler);
app.get(
  '/api/user/data-export/artifacts/:artifactId/chunks/:index',
  dataExportArtifactChunkHandler
);
app.get('/api/user/data-export/:id', dataExportStatusHandler);
app.get('/api/user/data-export/:id/download', dataExportDownloadHandler);

// =============================================================================
// Admin Consent Management API (GDPR Article 7 - Admin Oversight)
// =============================================================================
// Admin endpoints for viewing and managing user consents.
// Protected by adminAuthMiddleware (from /api/admin/*).

app.get('/api/admin/users/:userId/consents', adminUserConsentsListHandler);
app.delete('/api/admin/users/:userId/consents/:clientId', adminUserConsentRevokeHandler);

// =============================================================================
// Admin Consent Statement Management API
// =============================================================================
// Rate limiting for consent management endpoints (moderate profile)
app.use('/api/admin/consent-statements/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware(profile)(c, next);
});
app.use('/api/admin/consent-requirements/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware(profile)(c, next);
});
app.use('/api/admin/clients/:clientId/consent-overrides/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware(profile)(c, next);
});
app.use('/api/admin/users/:userId/consent-records/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware(profile)(c, next);
});

// Consent items CRUD
app.get('/api/admin/consent-statements', adminConsentStatementsListHandler);
app.post('/api/admin/consent-statements', adminConsentStatementCreateHandler);
app.get('/api/admin/consent-statements/:id', adminConsentStatementGetHandler);
app.put('/api/admin/consent-statements/:id', adminConsentStatementUpdateHandler);
app.delete('/api/admin/consent-statements/:id', adminConsentStatementDeleteHandler);

// Version management
app.get('/api/admin/consent-statements/:sid/versions', adminConsentVersionsListHandler);
app.post('/api/admin/consent-statements/:sid/versions', adminConsentVersionCreateHandler);
app.get('/api/admin/consent-statements/:sid/versions/:vid', adminConsentVersionGetHandler);
app.put('/api/admin/consent-statements/:sid/versions/:vid', adminConsentVersionUpdateHandler);
app.post(
  '/api/admin/consent-statements/:sid/versions/:vid/activate',
  adminConsentVersionActivateHandler
);
app.delete('/api/admin/consent-statements/:sid/versions/:vid', adminConsentVersionDeleteHandler);

// Localizations
app.get(
  '/api/admin/consent-statements/:sid/versions/:vid/localizations',
  adminConsentLocalizationsListHandler
);
app.put(
  '/api/admin/consent-statements/:sid/versions/:vid/localizations/:lang',
  adminConsentLocalizationUpsertHandler
);
app.delete(
  '/api/admin/consent-statements/:sid/versions/:vid/localizations/:lang',
  adminConsentLocalizationDeleteHandler
);

// Tenant requirements
app.get('/api/admin/consent-requirements', adminConsentRequirementsListHandler);
app.put('/api/admin/consent-requirements/:statementId', adminConsentRequirementUpsertHandler);
app.delete('/api/admin/consent-requirements/:statementId', adminConsentRequirementDeleteHandler);

// Client overrides
app.get('/api/admin/clients/:clientId/consent-overrides', adminConsentOverridesListHandler);
app.put(
  '/api/admin/clients/:clientId/consent-overrides/:statementId',
  adminConsentOverrideUpsertHandler
);
app.delete(
  '/api/admin/clients/:clientId/consent-overrides/:statementId',
  adminConsentOverrideDeleteHandler
);

// User consent records (admin view)
app.get('/api/admin/users/:userId/consent-records', adminUserConsentRecordsListHandler);
app.get(
  '/api/admin/users/:userId/consent-records/:statementId/history',
  adminUserConsentHistoryHandler
);
app.post(
  '/api/admin/users/:userId/consent-records/:statementId/withdraw',
  adminUserConsentWithdrawHandler
);

// SCIM 2.0 endpoints - RFC 7643, 7644
// Rate limited with moderate profile for standard operations, stricter for bulk
app.use('/scim/v2/*', async (c, next) => {
  // Use stricter rate limiting for bulk operations
  const path = new URL(c.req.url).pathname;
  const profileName = path.endsWith('/Bulk') ? 'strict' : 'moderate';
  const profile = await getRateLimitProfileAsync(c.env, profileName);
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/scim/v2/*'],
  })(c, next);
});

app.route('/scim/v2', scimApp);

// =====================================================
// Test Endpoints - Load Testing / Conformance Testing Only
// Controlled by ENABLE_TEST_ENDPOINTS environment variable
// =====================================================

/**
 * Test endpoint guard middleware
 * Returns 404 when ENABLE_TEST_ENDPOINTS is not set to 'true'
 * This allows disabling all test endpoints in production with a single env var
 */
app.use('/api/admin/test/*', async (c, next) => {
  if (c.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }
  return next();
});

// Test endpoints (all protected by adminAuthMiddleware from /api/admin/* and test guard above)
app.post('/api/admin/test/sessions', adminTestSessionCreateHandler); // Create session without login
app.post('/api/admin/test/email-codes', adminTestEmailCodeHandler); // Generate OTP code without email
app.get('/api/admin/test/signing-key', adminSigningKeyGetHandler); // Get signing key with private key
app.post('/api/admin/test/tokens', adminTokenRegisterHandler); // Register pre-generated tokens

// =====================================================
// Internal API - Version Management
// Used by deploy scripts to register new versions
// =====================================================

/**
 * POST /api/internal/versions/:workerName
 * Register a new version for a specific Worker
 *
 * Request body:
 * {
 *   "uuid": "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
 *   "deployTime": "2025-11-28T03:20:15Z"
 * }
 *
 * Requires: Admin authentication plus internal VersionManager DO secret.
 */
app.post(
  '/api/internal/versions/:workerName',
  adminAuthMiddleware({ plane: 'platform' }),
  async (c) => {
    const workerName = c.req.param('workerName')!;

    // Validate worker name (only allow known workers)
    const validWorkers = [
      'ar-auth',
      'ar-token',
      'ar-management',
      'ar-userinfo',
      'ar-async',
      'ar-discovery',
      'ar-policy',
      'ar-saml',
      'ar-bridge',
      'ar-vc',
    ];
    if (!validWorkers.includes(workerName)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const body = (await c.req.json()) as { uuid: string; deployTime: string };

    if (!body.uuid || !body.deployTime) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'uuid, deployTime' },
      });
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(body.uuid)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    try {
      const vmId = c.env.VERSION_MANAGER.idFromName('global');
      const vm = c.env.VERSION_MANAGER.get(vmId);
      if (!c.env.VERSION_MANAGER_SECRET) {
        const log = getLogger(c).module('VERSION-API');
        log.error('VERSION_MANAGER_SECRET not configured');
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      const response = await vm.fetch(
        new Request(`https://do/version/${workerName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.env.VERSION_MANAGER_SECRET}`,
          },
          body: JSON.stringify({
            uuid: body.uuid,
            deployTime: body.deployTime,
          }),
        })
      );

      if (!response.ok) {
        const error = await readResponseTextWithLimit(
          response,
          VERSION_MANAGER_ERROR_BODY_MAX_BYTES
        );
        const log = getLogger(c).module('VERSION-API');
        log.error('Failed to register version', { workerName, error });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      const log = getLogger(c).module('VERSION-API');
      log.info('Registered version', {
        workerName,
        uuid: body.uuid.substring(0, 8) + '...',
        deployTime: body.deployTime,
      });

      return c.json({ success: true, workerName, uuid: body.uuid });
    } catch (error) {
      const log = getLogger(c).module('VERSION-API');
      log.error('Version registration error', {}, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  }
);

/**
 * GET /api/internal/version-manager/status
 * Get all registered versions
 *
 * Requires: Admin authentication plus internal VersionManager DO secret.
 */
app.get(
  '/api/internal/version-manager/status',
  adminAuthMiddleware({ plane: 'platform' }),
  async (c) => {
    try {
      const vmId = c.env.VERSION_MANAGER.idFromName('global');
      const vm = c.env.VERSION_MANAGER.get(vmId);
      if (!c.env.VERSION_MANAGER_SECRET) {
        const log = getLogger(c).module('VERSION-API');
        log.error('VERSION_MANAGER_SECRET not configured');
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      const response = await vm.fetch(
        new Request('https://do/version-manager/status', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${c.env.VERSION_MANAGER_SECRET}`,
          },
        })
      );

      if (!response.ok) {
        const error = await readResponseTextWithLimit(
          response,
          VERSION_MANAGER_ERROR_BODY_MAX_BYTES
        );
        const log = getLogger(c).module('VERSION-API');
        log.error('Failed to get version status', { error });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      const data = await response.json();
      return c.json(data);
    } catch (error) {
      const log = getLogger(c).module('VERSION-API');
      log.error('Version status error', {}, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  }
);

// 404 handler
app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// Error handler
app.onError((err, c) => {
  const log = getLogger(c).module('MANAGEMENT');
  log.error('Unhandled error', {}, err);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

async function listMaintenanceTenantIds(
  adapter: DatabaseAdapter,
  env: Env,
  log: ReturnType<typeof createLogger>
): Promise<string[]> {
  try {
    const rows = await adapter.query<{ id: string }>(
      "SELECT id FROM tenants WHERE lifecycle_state = 'active' ORDER BY id"
    );
    const tenantIds = rows.map((row) => row.id).filter((id) => id.length > 0);
    if (tenantIds.length > 0) {
      return tenantIds;
    }
  } catch (error) {
    log.warn('Failed to list active tenants for scheduled cleanup', {
      error: (error as Error).message,
    });
  }

  return [getDefaultTenantId(env)];
}

async function deleteExpiredTenantRows(
  adapter: DatabaseAdapter,
  tenantIds: string[],
  sql: string,
  getParams: (tenantId: string) => unknown[]
): Promise<number> {
  let deleted = 0;
  for (const tenantId of tenantIds) {
    const result = await adapter.execute(sql, getParams(tenantId));
    deleted += result.rowsAffected || 0;
  }
  return deleted;
}

/**
 * Scheduled handler for D1 database cleanup and async job processing.
 * Runs hourly to clean up expired data and process pending jobs.
 *
 * Cron configuration in wrangler.toml:
 * [triggers]
 * crons = ["0 * * * *"]  # Hourly
 */
async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
  const log = createLogger().module('SCHEDULED');
  log.info('Scheduled maintenance job started', { timestamp: new Date().toISOString() });

  // Register builtin plugins (idempotent - skips if already registered)
  try {
    if (env.SETTINGS) {
      const pluginResult = await ensureBuiltinPluginsRegistered(env.SETTINGS);
      if (pluginResult && pluginResult.registered > 0) {
        log.info('Builtin plugins registered during scheduled job', {
          registered: pluginResult.registered,
        });
      }
    }
  } catch (pluginError) {
    log.warn('Builtin plugin registration failed', { error: (pluginError as Error).message });
  }

  try {
    const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      'management-scheduled'
    );
    const maintenanceTenantIds = await listMaintenanceTenantIds(coreAdapter, env, log);

    // 1. Cleanup expired sessions (with 1-day grace period)
    const sessionsDeleted = await deleteExpiredTenantRows(
      coreAdapter,
      maintenanceTenantIds,
      'DELETE FROM sessions WHERE tenant_id = ? AND expires_at < ?',
      (tenantId) => [tenantId, now - 86400] // 1 day grace period
    );
    log.debug('Deleted expired sessions', {
      count: sessionsDeleted,
      tenantCount: maintenanceTenantIds.length,
    });

    // 2. Cleanup expired/used password reset tokens
    const passwordTokensDeleted = await deleteExpiredTenantRows(
      coreAdapter,
      maintenanceTenantIds,
      'DELETE FROM password_reset_tokens WHERE tenant_id = ? AND (expires_at < ? OR used = 1)',
      (tenantId) => [tenantId, now]
    );
    log.debug('Deleted expired/used password reset tokens', {
      count: passwordTokensDeleted,
      tenantCount: maintenanceTenantIds.length,
    });

    // 3. Legacy audit_log cleanup is disabled. Unified audit retention is handled below
    // by cleanupResolvedAuditPrimaries(), which resolves the effective audit profile per tenant
    // and applies retention to D1/Postgres primaries or skips archive-only installs.
    const auditLogsDeleted = 0;

    // 4. Cleanup expired Native SSO device_secrets (if enabled)
    // This cleans up device secrets that have passed their expiration date
    let deviceSecretsDeleted = 0;
    try {
      const nativeSSOEnabled = await isNativeSSOEnabled(env);
      if (nativeSSOEnabled) {
        for (const tenantId of maintenanceTenantIds) {
          const deviceSecretRepo = new DeviceSecretRepository(coreAdapter, tenantId);
          deviceSecretsDeleted += await deviceSecretRepo.cleanupExpired();
        }
        log.debug('Cleaned up expired device secrets', {
          count: deviceSecretsDeleted,
          tenantCount: maintenanceTenantIds.length,
        });
      }
    } catch (deviceSecretError) {
      // Log but don't fail the entire cleanup job
      log.error('Device secret cleanup failed', {}, deviceSecretError as Error);
    }

    // 5. Cleanup expired operational logs (reason_detail storage)
    // Retention period is tenant-configurable, defaults to 90 days
    let operationalLogsDeleted = 0;
    try {
      operationalLogsDeleted = await deleteExpiredTenantRows(
        coreAdapter,
        maintenanceTenantIds,
        'DELETE FROM operational_logs WHERE tenant_id = ? AND expires_at < ?',
        (tenantId) => [tenantId, now]
      );
      log.debug('Deleted expired operational logs', {
        count: operationalLogsDeleted,
        tenantCount: maintenanceTenantIds.length,
      });
    } catch (operationalLogError) {
      // Log but don't fail - table might not exist yet
      log.warn('Operational logs cleanup failed (table may not exist)', {
        error: (operationalLogError as Error).message,
      });
    }

    // 6. Cleanup expired idempotency keys (24 hour TTL)
    let idempotencyKeysDeleted = 0;
    try {
      idempotencyKeysDeleted = await deleteExpiredTenantRows(
        coreAdapter,
        maintenanceTenantIds,
        'DELETE FROM idempotency_keys WHERE tenant_id = ? AND expires_at < ?',
        (tenantId) => [tenantId, now]
      );
      log.debug('Deleted expired idempotency keys', {
        count: idempotencyKeysDeleted,
        tenantCount: maintenanceTenantIds.length,
      });
    } catch (idempotencyError) {
      // Log but don't fail - table might not exist yet
      log.warn('Idempotency keys cleanup failed (table may not exist)', {
        error: (idempotencyError as Error).message,
      });
    }

    let unifiedAuditCleanup = {
      tenantCount: 0,
      processedTenants: 0,
      archiveOnlyTenants: 0,
      pendingSupportTenants: 0,
      archiveCopyFailures: 0,
      eventArchived: 0,
      piiArchived: 0,
      eventDeleted: 0,
      piiDeleted: 0,
    };

    try {
      unifiedAuditCleanup = await cleanupResolvedAuditPrimaries(env, {
        logger: log.module('AUDIT-MAINTENANCE'),
      });
      log.debug('Unified audit retention cleanup completed', unifiedAuditCleanup);
    } catch (auditCleanupError) {
      log.error('Unified audit retention cleanup failed', {}, auditCleanupError as Error);
    }

    log.info('Scheduled maintenance cleanup completed', {
      sessionsDeleted,
      passwordTokensDeleted,
      auditLogsDeleted,
      deviceSecretsDeleted,
      operationalLogsDeleted,
      idempotencyKeysDeleted,
      unifiedAuditCleanup,
    });
  } catch (error) {
    log.error('Scheduled maintenance job failed', {}, error as Error);
    // Don't throw - we don't want to mark the cron job as failed
    // Errors are logged for monitoring
  }

  await processScheduledAdminJobQueues(env, log);

  try {
    await runObjectArtifactCleanup(env, log);
  } catch (cleanupError) {
    log.error('Object artifact cleanup failed', {}, cleanupError as Error);
  }
}

const LOGGING_DELIVERY_QUEUE_NAMES = new Set([
  'LOGGING_DELIVERY_CRITICAL_QUEUE',
  'LOGGING_DELIVERY_QUEUE',
  'LOGGING_DELIVERY_BULK_QUEUE',
]);

function parseConfiguredLoggingDeliveryQueueNames(env: Env): Set<string> {
  const raw = env.LOGGING_DELIVERY_QUEUE_NAMES;
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function isLoggingDeliveryQueueName(queueName: string, env: Env): boolean {
  return (
    LOGGING_DELIVERY_QUEUE_NAMES.has(queueName) ||
    parseConfiguredLoggingDeliveryQueueNames(env).has(queueName) ||
    /(?:^|-)logging-delivery-(?:critical-|bulk-)?queue$/.test(queueName)
  );
}

async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const queueName = String((batch as { queue?: unknown }).queue ?? '');
  if (isLoggingDeliveryQueueName(queueName, env)) {
    await processLoggingDeliveryQueue(
      batch,
      env,
      createLogger().module('AR-MANAGEMENT-LOGGING-DELIVERY-QUEUE')
    );
    return;
  }

  await processAuditQueue(
    batch as MessageBatch<AuditQueueMessage>,
    env,
    createLogger().module('AR-MANAGEMENT-AUDIT-QUEUE')
  );
}

// Export for Cloudflare Workers with scheduled + queue handlers
export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
  queue: handleQueue,
};

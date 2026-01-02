import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '@authrim/ar-lib-core';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  getRateLimitProfileAsync,
  initialAccessTokenMiddleware,
  adminAuthMiddleware,
  versionCheckMiddleware,
  requestContextMiddleware,
  pluginContextMiddleware,
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  requireSystemAdmin,
  requireAnyRole,
  // Native SSO device_secret cleanup
  DeviceSecretRepository,
  isNativeSSOEnabled,
  // Health Check
  createHealthCheckHandlers,
} from '@authrim/ar-lib-core';

// Import handlers
import { registerHandler } from './register';
import {
  clientConfigGetHandler,
  clientConfigUpdateHandler,
  clientConfigDeleteHandler,
} from './client-config';
import {
  adminSigningKeysStatusHandler,
  adminSigningKeysRotateHandler,
  adminSigningKeysEmergencyRotateHandler,
} from './signing-keys';
import { introspectHandler } from './introspect';
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
} from './admin';
import scimApp from './scim';
import {
  adminScimTokensListHandler,
  adminScimTokenCreateHandler,
  adminScimTokenRevokeHandler,
} from './scim-tokens';
import { adminIATListHandler, adminIATCreateHandler, adminIATRevokeHandler } from './iat-tokens';
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
  adminUserRolesListHandler,
  adminUserRoleAssignHandler,
  adminUserRoleRemoveHandler,
  adminUserRelationshipsListHandler,
  adminUserRelationshipCreateHandler,
  adminUserRelationshipDeleteHandler,
} from './admin-rbac';
import {
  adminAIGrantsListHandler,
  adminAIGrantGetHandler,
  adminAIGrantCreateHandler,
  adminAIGrantUpdateHandler,
  adminAIGrantRevokeHandler,
} from './ai-grants';
import { userConsentsListHandler, userConsentRevokeHandler } from './user-consents';
import {
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
import {
  getPartitionSettings,
  updatePartitionSettings,
  testPartitionRouting,
  getPartitionStats,
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
  getRateLimitSettings,
  getRateLimitProfile,
  updateRateLimitProfile,
  resetRateLimitProfile,
  getProfileOverride,
  setProfileOverride,
  clearProfileOverride,
} from './routes/settings/rate-limit';
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
  getTombstone,
  getTombstoneStats,
  cleanupTombstones,
  deleteTombstone,
} from './routes/settings/tombstones';
import {
  getFapiSecurityConfig,
  updateFapiSecurityConfig,
  clearFapiSecurityConfig,
} from './routes/settings/fapi-security';
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
  getPluginHealthHandler,
  getPluginSchemaHandler,
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
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
} from './routes/settings/webhooks';

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', versionCheckMiddleware('ar-management'));
app.use('*', requestContextMiddleware());
app.use('*', pluginContextMiddleware());

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
  const allowedOriginsEnv = c.env.ALLOWED_ORIGINS;

  // Parse allowed origins from environment (comma-separated)
  const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((o: string) => o.trim())
    : null;

  // Only allow credentials when specific origins are configured
  const allowCredentials = !!allowedOrigins;

  // Origin validation function
  const validateOrigin = (origin: string): string | undefined | null => {
    if (!allowedOrigins) {
      // No whitelist configured: allow all origins but without credentials
      return origin;
    }
    // Check against whitelist
    if (allowedOrigins.includes(origin)) {
      return origin;
    }
    // Origin not in whitelist
    return null;
  };

  return cors({
    origin: validateOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'DPoP', 'If-Match', 'If-None-Match'],
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
// Can be disabled by setting OPEN_REGISTRATION=true in environment variables
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
    version: '0.1.0',
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

// Token Introspection endpoint - RFC 7662
app.post('/introspect', introspectHandler);

// Token Revocation endpoint - RFC 7009
app.post('/revoke', revokeHandler);

// Batch Token Revocation endpoint (RFC 7009 extension)
app.post('/revoke/batch', batchRevokeHandler);

// Admin authentication middleware - applies to ALL /api/admin/* routes
// Supports both Bearer token (for headless/API usage) and session-based auth (for UI)
app.use('/api/admin/*', adminAuthMiddleware());

// Body size limit for Admin API - prevents DoS attacks via large payloads
// 100KB is sufficient for policy/settings updates while blocking malicious large payloads
app.use(
  '/api/admin/*',
  bodyLimit({
    maxSize: 100 * 1024, // 100KB
    onError: (c) => {
      return c.json(
        {
          error: 'payload_too_large',
          message: 'Request body exceeds maximum allowed size (100KB)',
        },
        413
      );
    },
  })
);

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
app.get('/api/admin/clients', adminClientsListHandler);
app.post('/api/admin/clients', adminClientCreateHandler);
app.delete('/api/admin/clients/bulk', adminClientsBulkDeleteHandler); // Must be before :id route
app.get('/api/admin/clients/:id', adminClientGetHandler);
app.put('/api/admin/clients/:id', adminClientUpdateHandler);
app.delete('/api/admin/clients/:id', adminClientDeleteHandler);

// Admin Session Management endpoints (RESTful naming)
app.get('/api/admin/sessions', adminSessionsListHandler);
app.get('/api/admin/sessions/:id', adminSessionGetHandler);
app.delete('/api/admin/sessions/:id', adminSessionRevokeHandler); // RESTful: DELETE instead of POST
app.delete('/api/admin/users/:id/sessions', adminUserRevokeAllSessionsHandler); // RESTful: /sessions instead of /revoke-all-sessions

// Admin Audit Log endpoints
app.get('/api/admin/audit-logs', adminAuditLogListHandler);
app.get('/api/admin/audit-logs/:id', adminAuditLogGetHandler);

// Admin Settings endpoints (legacy - will be deprecated)
app.get('/api/admin/settings', adminSettingsGetHandler);
app.put('/api/admin/settings', adminSettingsUpdateHandler);

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

// [DEPRECATED] Admin PII Partition
// → Migrate to: /api/admin/platform/settings/infrastructure
// NOTE: Has test/stats operations - keep until settings-v2 supports operations
app.get('/api/admin/settings/pii-partitions', getPartitionSettings);
app.put('/api/admin/settings/pii-partitions', updatePartitionSettings);
app.post('/api/admin/settings/pii-partitions/test', testPartitionRouting);
app.get('/api/admin/settings/pii-partitions/stats', getPartitionStats);
app.delete('/api/admin/settings/pii-partitions', deletePartitionSettings);

// Admin Tombstone Management endpoints (GDPR Art.17 deletion tracking)
app.get('/api/admin/tombstones', listTombstones);
app.get('/api/admin/tombstones/stats', getTombstoneStats); // Must be before :id
app.post('/api/admin/tombstones/cleanup', cleanupTombstones);
app.get('/api/admin/tombstones/:id', getTombstone);
app.delete('/api/admin/tombstones/:id', deleteTombstone);

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

// Role management (read-only for system roles)
app.get('/api/admin/roles', adminRolesListHandler);
app.get('/api/admin/roles/:id', adminRoleGetHandler);

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

// =============================================================================
// AI Grants (Human Auth / AI Ephemeral Auth Two-Layer Model)
// =============================================================================
// Manages grants that authorize AI principals (agents, tools, services) to act
// on behalf of users or systems. Used for MCP integration and AI-to-AI delegation.
// Rate limited with RateLimitProfiles.moderate.
// RBAC: Requires system_admin or distributor_admin role.

// Rate limiting for AI Grants endpoints
app.use('/api/admin/ai-grants', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/ai-grants'],
  })(c, next);
});

// RBAC: Require system_admin or distributor_admin for AI Grant management
app.use('/api/admin/ai-grants/*', requireAnyRole(['system_admin', 'distributor_admin']));

app.get('/api/admin/ai-grants', adminAIGrantsListHandler);
app.get('/api/admin/ai-grants/:id', adminAIGrantGetHandler);
app.post('/api/admin/ai-grants', adminAIGrantCreateHandler);
app.put('/api/admin/ai-grants/:id', adminAIGrantUpdateHandler);
app.delete('/api/admin/ai-grants/:id', adminAIGrantRevokeHandler);

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

// Plugin listing and details
app.get('/api/admin/plugins', listPluginsHandler);
app.get('/api/admin/plugins/:id', getPluginHandler);

// Plugin configuration
app.get('/api/admin/plugins/:id/config', getPluginConfigHandler);
app.put('/api/admin/plugins/:id/config', updatePluginConfigHandler);

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

// RBAC: Require tenant_admin or higher for webhook management
app.use(
  '/api/admin/webhooks',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);
app.use(
  '/api/admin/webhooks/*',
  requireAnyRole(['system_admin', 'distributor_admin', 'tenant_admin'])
);

app.post('/api/admin/webhooks', createWebhook);
app.get('/api/admin/webhooks', listWebhooks);
app.get('/api/admin/webhooks/:id', getWebhook);
app.put('/api/admin/webhooks/:id', updateWebhook);
app.delete('/api/admin/webhooks/:id', deleteWebhook);

// =============================================================================
// User Consent Management API (GDPR Article 7 - User Rights)
// =============================================================================
// User-facing endpoints for viewing and revoking consents.
// Supports both access token (Bearer) and session-based authentication.
// Rate limit: moderate profile.

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
app.get('/api/user/data-export/:id', dataExportStatusHandler);
app.get('/api/user/data-export/:id/download', dataExportDownloadHandler);

// =============================================================================
// Admin Consent Management API (GDPR Article 7 - Admin Oversight)
// =============================================================================
// Admin endpoints for viewing and managing user consents.
// Protected by adminAuthMiddleware (from /api/admin/*).

app.get('/api/admin/users/:userId/consents', adminUserConsentsListHandler);
app.delete('/api/admin/users/:userId/consents/:clientId', adminUserConsentRevokeHandler);

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
 * Requires: Bearer token (ADMIN_API_SECRET)
 */
app.post('/api/internal/versions/:workerName', adminAuthMiddleware(), async (c) => {
  const workerName = c.req.param('workerName');

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

    const response = await vm.fetch(
      new Request(`https://do/version/${workerName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.env.ADMIN_API_SECRET}`,
        },
        body: JSON.stringify({
          uuid: body.uuid,
          deployTime: body.deployTime,
        }),
      })
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Version API] Failed to register version: ${error}`);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    console.log(`[Version API] Registered version for ${workerName}`, {
      uuid: body.uuid.substring(0, 8) + '...',
      deployTime: body.deployTime,
    });

    return c.json({ success: true, workerName, uuid: body.uuid });
  } catch (error) {
    console.error('[Version API] Error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/internal/version-manager/status
 * Get all registered versions
 *
 * Requires: Bearer token (ADMIN_API_SECRET)
 */
app.get('/api/internal/version-manager/status', adminAuthMiddleware(), async (c) => {
  try {
    const vmId = c.env.VERSION_MANAGER.idFromName('global');
    const vm = c.env.VERSION_MANAGER.get(vmId);

    const response = await vm.fetch(
      new Request('https://do/version-manager/status', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${c.env.ADMIN_API_SECRET}`,
        },
      })
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Version API] Failed to get status: ${error}`);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('[Version API] Error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

// 404 handler
app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

/**
 * Scheduled handler for D1 database cleanup
 * Runs daily at 2:00 AM UTC to clean up expired data
 *
 * Cron configuration in wrangler.toml:
 * [triggers]
 * crons = ["0 2 * * *"]  # Daily at 2:00 AM UTC
 */
async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
  console.log(`[Scheduled] D1 cleanup job started at ${new Date().toISOString()}`);

  try {
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });

    // 1. Cleanup expired sessions (with 1-day grace period)
    const sessionsResult = await coreAdapter.execute(
      'DELETE FROM sessions WHERE expires_at < ?',
      [now - 86400] // 1 day grace period
    );
    const sessionsDeleted = sessionsResult.rowsAffected || 0;
    console.log(`[Scheduled] Deleted ${sessionsDeleted} expired sessions`);

    // 2. Cleanup expired/used password reset tokens
    const passwordTokensResult = await coreAdapter.execute(
      'DELETE FROM password_reset_tokens WHERE expires_at < ? OR used = 1',
      [now]
    );
    const passwordTokensDeleted = passwordTokensResult.rowsAffected || 0;
    console.log(`[Scheduled] Deleted ${passwordTokensDeleted} expired/used password reset tokens`);

    // 3. Cleanup old audit logs (older than 90 days)
    // Keep audit logs for 90 days for compliance (adjust based on requirements)
    const ninetyDaysAgo = now - 90 * 86400;
    const auditLogsResult = await coreAdapter.execute(
      'DELETE FROM audit_log WHERE created_at < ?',
      [ninetyDaysAgo]
    );
    const auditLogsDeleted = auditLogsResult.rowsAffected || 0;
    console.log(`[Scheduled] Deleted ${auditLogsDeleted} audit logs older than 90 days`);

    // 4. Cleanup expired Native SSO device_secrets (if enabled)
    // This cleans up device secrets that have passed their expiration date
    let deviceSecretsDeleted = 0;
    try {
      const nativeSSOEnabled = await isNativeSSOEnabled(env);
      if (nativeSSOEnabled) {
        const deviceSecretRepo = new DeviceSecretRepository(coreAdapter);
        deviceSecretsDeleted = await deviceSecretRepo.cleanupExpired();
        console.log(`[Scheduled] Cleaned up ${deviceSecretsDeleted} expired device secrets`);
      }
    } catch (deviceSecretError) {
      // Log but don't fail the entire cleanup job
      console.error('[Scheduled] Device secret cleanup failed:', deviceSecretError);
    }

    console.log(
      `[Scheduled] D1 cleanup completed: ${sessionsDeleted} sessions, ${passwordTokensDeleted} tokens, ` +
        `${auditLogsDeleted} audit logs, ${deviceSecretsDeleted} device secrets`
    );
  } catch (error) {
    console.error('[Scheduled] D1 cleanup job failed:', error);
    // Don't throw - we don't want to mark the cron job as failed
    // Errors are logged for monitoring
  }
}

// Export for Cloudflare Workers with scheduled handler
export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/shared';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
  getRateLimitProfileAsync,
  initialAccessTokenMiddleware,
  adminAuthMiddleware,
  versionCheckMiddleware,
  requestContextMiddleware,
} from '@authrim/shared';

// Import handlers
import { registerHandler } from './register';
import {
  adminSigningKeysStatusHandler,
  adminSigningKeysRotateHandler,
  adminSigningKeysEmergencyRotateHandler,
} from './signing-keys';
import { introspectHandler } from './introspect';
import { revokeHandler } from './revoke';
import {
  serveAvatarHandler,
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
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
  getRateLimitSettings,
  getRateLimitProfile,
  updateRateLimitProfile,
  resetRateLimitProfile,
  getProfileOverride,
  setProfileOverride,
  clearProfileOverride,
} from './routes/settings/rate-limit';
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

// Create Hono app with Cloudflare Workers types
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', versionCheckMiddleware('op-management'));
app.use('*', requestContextMiddleware());

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

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'op-management',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Dynamic Client Registration endpoint - RFC 7591
app.post('/register', registerHandler);

// Token Introspection endpoint - RFC 7662
app.post('/introspect', introspectHandler);

// Token Revocation endpoint - RFC 7009
app.post('/revoke', revokeHandler);

// Avatar serving endpoint
app.get('/api/avatars/:filename', serveAvatarHandler);

// Admin authentication middleware - applies to ALL /api/admin/* routes
// Supports both Bearer token (for headless/API usage) and session-based auth (for UI)
app.use('/api/admin/*', adminAuthMiddleware());

// Admin API endpoints
app.get('/api/admin/stats', adminStatsHandler);
app.get('/api/admin/users', adminUsersListHandler);
app.get('/api/admin/users/:id', adminUserGetHandler);
app.post('/api/admin/users', adminUserCreateHandler);
app.put('/api/admin/users/:id', adminUserUpdateHandler);
app.delete('/api/admin/users/:id', adminUserDeleteHandler);
app.post('/api/admin/users/:id/avatar', adminUserAvatarUploadHandler);
app.delete('/api/admin/users/:id/avatar', adminUserAvatarDeleteHandler);
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
app.get('/api/admin/audit-log', adminAuditLogListHandler);
app.get('/api/admin/audit-log/:id', adminAuditLogGetHandler);

// Admin Settings endpoints
app.get('/api/admin/settings', adminSettingsGetHandler);
app.put('/api/admin/settings', adminSettingsUpdateHandler);

// Admin Certification Profile endpoints (OpenID Certification)
app.get('/api/admin/settings/profiles', adminListCertificationProfilesHandler);
app.put('/api/admin/settings/profile/:profileName', adminApplyCertificationProfileHandler);

// Admin Code Shards Configuration endpoints
app.get('/api/admin/settings/code-shards', getCodeShards);
app.put('/api/admin/settings/code-shards', updateCodeShards);

// Admin Token Revocation Shards Configuration endpoints
app.get('/api/admin/settings/revocation-shards', getRevocationShards);
app.put('/api/admin/settings/revocation-shards', updateRevocationShards);
app.delete('/api/admin/settings/revocation-shards', resetRevocationShards);

// Admin Region Sharding endpoints
app.get('/api/admin/settings/region-shards', getRegionShards);
app.put('/api/admin/settings/region-shards', updateRegionShards);
app.delete('/api/admin/settings/region-shards', deleteRegionShards);

// Admin PII Partition endpoints
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

// Admin OAuth/OIDC Configuration endpoints
app.get('/api/admin/settings/oauth-config', getOAuthConfig);
app.put('/api/admin/settings/oauth-config/:name', updateOAuthConfig);
app.delete('/api/admin/settings/oauth-config/:name', clearOAuthConfig);
app.delete('/api/admin/settings/oauth-config', clearAllOAuthConfig);

// Admin Rate Limit Configuration endpoints
app.get('/api/admin/settings/rate-limit', getRateLimitSettings);
app.get('/api/admin/settings/rate-limit/profile-override', getProfileOverride);
app.put('/api/admin/settings/rate-limit/profile-override', setProfileOverride);
app.delete('/api/admin/settings/rate-limit/profile-override', clearProfileOverride);
app.get('/api/admin/settings/rate-limit/:profile', getRateLimitProfile);
app.put('/api/admin/settings/rate-limit/:profile', updateRateLimitProfile);
app.delete('/api/admin/settings/rate-limit/:profile', resetRateLimitProfile);

// Admin Token Exchange Configuration endpoints (RFC 8693)
app.get('/api/admin/settings/token-exchange', getTokenExchangeConfig);
app.put('/api/admin/settings/token-exchange', updateTokenExchangeConfig);
app.delete('/api/admin/settings/token-exchange', clearTokenExchangeConfig);

// Admin Introspection Validation Configuration endpoints
// RFC 7662 strict validation mode (aud/client_id checks)
app.get('/api/admin/settings/introspection-validation', getIntrospectionValidationConfig);
app.put('/api/admin/settings/introspection-validation', updateIntrospectionValidationConfig);
app.delete('/api/admin/settings/introspection-validation', clearIntrospectionValidationConfig);

// Admin Introspection Cache Configuration endpoints
// Cache active=true responses to reduce DO/D1 load
app.get('/api/admin/settings/introspection-cache', getIntrospectionCacheConfigHandler);
app.put('/api/admin/settings/introspection-cache', updateIntrospectionCacheConfigHandler);
app.delete('/api/admin/settings/introspection-cache', clearIntrospectionCacheConfigHandler);

// Admin Refresh Token Sharding Configuration endpoints
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

// SCIM 2.0 endpoints - RFC 7643, 7644
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
    return c.json(
      {
        error: 'not_found',
        error_description: 'Test endpoints are disabled. Set ENABLE_TEST_ENDPOINTS=true to enable.',
      },
      404
    );
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
 * POST /api/internal/version/:workerName
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
app.post('/api/internal/version/:workerName', adminAuthMiddleware(), async (c) => {
  const workerName = c.req.param('workerName');

  // Validate worker name (only allow known workers)
  const validWorkers = [
    'op-auth',
    'op-token',
    'op-management',
    'op-userinfo',
    'op-async',
    'op-discovery',
    'policy-service',
    'op-saml',
    'external-idp',
  ];
  if (!validWorkers.includes(workerName)) {
    return c.json(
      {
        error: 'invalid_worker',
        error_description: `Invalid worker name: ${workerName}`,
      },
      400
    );
  }

  const body = (await c.req.json()) as { uuid: string; deployTime: string };

  if (!body.uuid || !body.deployTime) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'uuid and deployTime are required',
      },
      400
    );
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(body.uuid)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'uuid must be a valid UUID v4',
      },
      400
    );
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
      return c.json(
        {
          error: 'internal_error',
          error_description: 'Failed to register version',
        },
        500
      );
    }

    console.log(`[Version API] Registered version for ${workerName}`, {
      uuid: body.uuid.substring(0, 8) + '...',
      deployTime: body.deployTime,
    });

    return c.json({ success: true, workerName, uuid: body.uuid });
  } catch (error) {
    console.error('[Version API] Error:', error);
    return c.json(
      {
        error: 'internal_error',
        error_description: 'Failed to register version',
      },
      500
    );
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
      return c.json(
        {
          error: 'internal_error',
          error_description: 'Failed to get version status',
        },
        500
      );
    }

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('[Version API] Error:', error);
    return c.json(
      {
        error: 'internal_error',
        error_description: 'Failed to get version status',
      },
      500
    );
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: 'internal_server_error', message: 'An unexpected error occurred' }, 500);
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
    // 1. Cleanup expired sessions (with 1-day grace period)
    const sessionsResult = await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?')
      .bind(now - 86400) // 1 day grace period
      .run();
    const sessionsDeleted = sessionsResult.meta?.changes || 0;
    console.log(`[Scheduled] Deleted ${sessionsDeleted} expired sessions`);

    // 2. Cleanup expired/used password reset tokens
    const passwordTokensResult = await env.DB.prepare(
      'DELETE FROM password_reset_tokens WHERE expires_at < ? OR used = 1'
    )
      .bind(now)
      .run();
    const passwordTokensDeleted = passwordTokensResult.meta?.changes || 0;
    console.log(`[Scheduled] Deleted ${passwordTokensDeleted} expired/used password reset tokens`);

    // 3. Cleanup old audit logs (older than 90 days)
    // Keep audit logs for 90 days for compliance (adjust based on requirements)
    const ninetyDaysAgo = now - 90 * 86400;
    const auditLogsResult = await env.DB.prepare('DELETE FROM audit_log WHERE created_at < ?')
      .bind(ninetyDaysAgo)
      .run();
    const auditLogsDeleted = auditLogsResult.meta?.changes || 0;
    console.log(`[Scheduled] Deleted ${auditLogsDeleted} audit logs older than 90 days`);

    console.log(
      `[Scheduled] D1 cleanup completed: ${sessionsDeleted} sessions, ${passwordTokensDeleted} tokens, ${auditLogsDeleted} audit logs`
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

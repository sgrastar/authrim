import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env } from '@authrim/shared';
import {
  rateLimitMiddleware,
  RateLimitProfiles,
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
} from './admin';
import scimApp from './scim';
import {
  adminScimTokensListHandler,
  adminScimTokenCreateHandler,
  adminScimTokenRevokeHandler,
} from './scim-tokens';

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

// CORS configuration
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'If-Match', 'If-None-Match'],
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'ETag',
      'Location',
    ],
    maxAge: 86400,
    credentials: true,
  })
);

// Rate limiting and Initial Access Token for registration endpoint
app.use(
  '/register',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/register'],
  })
);

// Initial Access Token validation for Dynamic Client Registration (RFC 7591)
// Can be disabled by setting OPEN_REGISTRATION=true in environment variables
app.use('/register', initialAccessTokenMiddleware());

app.use(
  '/introspect',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/introspect'],
  })
);

app.use(
  '/revoke',
  rateLimitMiddleware({
    ...RateLimitProfiles.strict,
    endpoints: ['/revoke'],
  })
);

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

// Admin Signing Keys Management endpoints
app.get('/api/admin/signing-keys/status', adminSigningKeysStatusHandler);
app.post('/api/admin/signing-keys/rotate', adminSigningKeysRotateHandler);
app.post('/api/admin/signing-keys/emergency-rotate', adminSigningKeysEmergencyRotateHandler);

// Admin SCIM Token Management endpoints
app.get('/api/admin/scim-tokens', adminScimTokensListHandler);
app.post('/api/admin/scim-tokens', adminScimTokenCreateHandler);
app.delete('/api/admin/scim-tokens/:tokenHash', adminScimTokenRevokeHandler);

// SCIM 2.0 endpoints - RFC 7643, 7644
app.route('/scim/v2', scimApp);

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
  const validWorkers = ['op-auth', 'op-token', 'op-management', 'op-userinfo', 'op-async', 'op-discovery'];
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

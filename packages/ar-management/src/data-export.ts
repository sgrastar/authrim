/**
 * Data Portability API (GDPR Article 20)
 *
 * Provides endpoints for users to export their personal data
 * in a structured, commonly used, and machine-readable format.
 *
 * Implements hybrid processing:
 * - Synchronous export for small data (< threshold KB)
 * - Asynchronous export for large data (returns request ID, processes via Queue)
 *
 * Endpoints:
 * - POST /api/user/data-export - Request data export
 * - GET /api/user/data-export/:id - Check export status
 * - GET /api/user/data-export/:id/download - Download exported data
 */

import { Context } from 'hono';
import type {
  Env,
  DataExportRequest,
  DataExportSection,
  DataExportFormat,
  ExportedUserData,
} from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  createPIIContextFromHono,
  getTenantIdFromContext,
  introspectTokenFromContext,
  getSessionStoreBySessionId,
  createOAuthConfigManager,
  getLogger,
} from '@authrim/ar-lib-core';
import { getCookie } from 'hono/cookie';

// Default export sections
const ALL_SECTIONS: DataExportSection[] = [
  'profile',
  'consents',
  'sessions',
  'audit_log',
  'passkeys',
];

/**
 * Get user ID from request context
 * Supports both access token (Bearer) and session-based (Cookie) auth
 */
async function getUserIdFromContext(c: Context<{ Bindings: Env }>): Promise<string | null> {
  // 1. Try Bearer token authentication first
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const introspection = await introspectTokenFromContext(c);
    if (introspection.valid && introspection.claims?.sub) {
      return introspection.claims.sub as string;
    }
    return null;
  }

  // 2. Try session-based authentication
  const sid = getCookie(c, 'sid');
  if (sid) {
    try {
      const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sid);
      const response = await sessionStore.fetch(
        new Request(`https://do/session/${sid}`, { method: 'GET' })
      );
      if (response.ok) {
        const session = await response.json();
        if (session && typeof session === 'object' && 'userId' in session) {
          return (session as { userId: string }).userId;
        }
      }
    } catch (error) {
      const log = getLogger(c).module('DATA-EXPORT');
      log.error('Session validation error', {}, error as Error);
    }
  }

  return null;
}

/**
 * Request data export
 * POST /api/user/data-export
 *
 * Body:
 * - sections: string[] - Sections to include (optional, defaults to all)
 * - format: 'json' | 'csv' - Export format (optional, defaults to 'json')
 */
export async function dataExportRequestHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    // Parse request body
    let sections: DataExportSection[] = ALL_SECTIONS;
    let format: DataExportFormat = 'json';

    const contentType = c.req.header('Content-Type') || '';
    if (contentType.includes('application/json')) {
      try {
        const body = await c.req.json<{
          sections?: DataExportSection[];
          format?: DataExportFormat;
        }>();
        if (body.sections && Array.isArray(body.sections)) {
          // Validate sections
          const validSections = body.sections.filter((s) =>
            ALL_SECTIONS.includes(s as DataExportSection)
          );
          if (validSections.length > 0) {
            sections = validSections;
          }
        }
        if (body.format === 'json' || body.format === 'csv') {
          format = body.format;
        }
      } catch {
        // Ignore parse errors, use defaults
      }
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if data export is enabled
    const configManager = createOAuthConfigManager(c.env);
    const exportEnabled = await configManager.getConsentDataExportEnabled();

    if (!exportEnabled) {
      return c.json(
        {
          error: 'feature_disabled',
          error_description: 'Data export is not enabled',
        },
        403
      );
    }

    // Get sync threshold from config
    const syncThresholdKB = await configManager.getConsentDataExportSyncThresholdKB();

    // Estimate data size (simplified - just count records)
    const estimatedSize = await estimateExportSize(authCtx.coreAdapter, userId, sections);

    const now = Date.now();
    const requestId = crypto.randomUUID();

    if (estimatedSize < syncThresholdKB * 1024) {
      // Synchronous export for small data
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const exportedData = await collectExportData(
        authCtx.coreAdapter,
        piiCtx?.defaultPiiAdapter ?? null,
        userId,
        tenantId,
        sections
      );

      // Return JSON directly
      return c.json({
        status: 'completed',
        requestId,
        format,
        data: exportedData,
        exportedAt: now,
      });
    } else {
      // Asynchronous export for large data - create export request
      await authCtx.coreAdapter.execute(
        `INSERT INTO data_export_requests
         (id, tenant_id, user_id, status, format, include_sections, requested_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        [requestId, tenantId, userId, format, JSON.stringify(sections), now]
      );

      // Queue the export job (if queue is available)
      // For now, return pending status - actual processing would be done by scheduled worker
      return c.json(
        {
          status: 'pending',
          requestId,
          message: 'Export request created. Use GET /api/user/data-export/:id to check status.',
          estimatedWaitSeconds: Math.ceil(estimatedSize / (50 * 1024)), // Rough estimate
        },
        202
      );
    }
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to create export request', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create export request',
      },
      500
    );
  }
}

/**
 * Check export status
 * GET /api/user/data-export/:id
 */
export async function dataExportStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const requestId = c.req.param('id');
    if (!requestId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Request ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const result = await authCtx.coreAdapter.query<{
      id: string;
      status: string;
      format: string;
      include_sections: string;
      requested_at: number;
      started_at: number | null;
      completed_at: number | null;
      expires_at: number | null;
      file_size: number | null;
      error_message: string | null;
    }>(
      `SELECT id, status, format, include_sections, requested_at,
              started_at, completed_at, expires_at, file_size, error_message
       FROM data_export_requests
       WHERE id = ? AND user_id = ? AND tenant_id = ?`,
      [requestId, userId, tenantId]
    );

    if (result.length === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export request not found',
        },
        404
      );
    }

    const request = result[0];

    const response: DataExportRequest = {
      id: request.id,
      userId,
      status: request.status as DataExportRequest['status'],
      format: request.format as DataExportFormat,
      includeSections: JSON.parse(request.include_sections) as DataExportSection[],
      requestedAt: request.requested_at,
      startedAt: request.started_at ?? undefined,
      completedAt: request.completed_at ?? undefined,
      expiresAt: request.expires_at ?? undefined,
      fileSize: request.file_size ?? undefined,
      errorMessage: request.error_message ?? undefined,
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to check export status', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check export status',
      },
      500
    );
  }
}

/**
 * Download exported data
 * GET /api/user/data-export/:id/download
 */
export async function dataExportDownloadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const requestId = c.req.param('id');
    if (!requestId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Request ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const result = await authCtx.coreAdapter.query<{
      status: string;
      format: string;
      include_sections: string;
      expires_at: number | null;
      file_path: string | null;
    }>(
      `SELECT status, format, include_sections, expires_at, file_path
       FROM data_export_requests
       WHERE id = ? AND user_id = ? AND tenant_id = ?`,
      [requestId, userId, tenantId]
    );

    if (result.length === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export request not found',
        },
        404
      );
    }

    const request = result[0];

    if (request.status !== 'completed') {
      return c.json(
        {
          error: 'not_ready',
          error_description: `Export is ${request.status}`,
        },
        409
      );
    }

    // Check expiration
    const now = Date.now();
    if (request.expires_at && request.expires_at < now) {
      return c.json(
        {
          error: 'expired',
          error_description: 'Export has expired',
        },
        410
      );
    }

    // For async exports, file would be in R2
    // For now, regenerate the data (sync fallback)
    const sections = JSON.parse(request.include_sections) as DataExportSection[];
    const piiCtx = createPIIContextFromHono(c, tenantId);

    const exportedData = await collectExportData(
      authCtx.coreAdapter,
      piiCtx?.defaultPiiAdapter ?? null,
      userId,
      tenantId,
      sections
    );

    // Set appropriate headers
    const filename = `data-export-${new Date().toISOString().split('T')[0]}.json`;
    c.header('Content-Type', 'application/json');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);

    return c.json(exportedData);
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to download export', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to download export',
      },
      500
    );
  }
}

/**
 * Estimate export data size (simplified)
 */
async function estimateExportSize(
  adapter: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  userId: string,
  sections: DataExportSection[]
): Promise<number> {
  let totalSize = 0;

  // Estimate ~500 bytes per consent record
  if (sections.includes('consents')) {
    const consents = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM oauth_client_consents WHERE user_id = ?',
      [userId]
    );
    totalSize += (consents[0]?.count || 0) * 500;
  }

  // Estimate ~200 bytes per session
  if (sections.includes('sessions')) {
    const sessions = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM sessions WHERE user_id = ?',
      [userId]
    );
    totalSize += (sessions[0]?.count || 0) * 200;
  }

  // Estimate ~300 bytes per audit log entry
  if (sections.includes('audit_log')) {
    const logs = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM consent_history WHERE user_id = ?',
      [userId]
    );
    totalSize += (logs[0]?.count || 0) * 300;
  }

  // Estimate ~400 bytes per passkey
  if (sections.includes('passkeys')) {
    const passkeys = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM user_passkeys WHERE user_id = ?',
      [userId]
    );
    totalSize += (passkeys[0]?.count || 0) * 400;
  }

  // Add base overhead for profile
  if (sections.includes('profile')) {
    totalSize += 2000; // Profile data estimate
  }

  return totalSize;
}

/**
 * Convert Unix timestamp to ISO string
 */
function toISOString(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Collect user data for export
 */
async function collectExportData(
  coreAdapter: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  piiAdapter: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> } | null,
  userId: string,
  tenantId: string,
  sections: DataExportSection[]
): Promise<ExportedUserData> {
  const now = Date.now();
  const exportedData: ExportedUserData = {
    metadata: {
      exportedAt: toISOString(now),
      format: 'json',
      version: '1.0',
      userId,
      tenantId,
    },
  };

  // Collect profile data
  if (sections.includes('profile')) {
    // Core user data
    const coreUser = await coreAdapter.query<{
      id: string;
      email_domain_hash: string | null;
      created_at: number;
      updated_at: number;
      email_verified: number | null;
      phone_verified: number | null;
    }>(
      'SELECT id, email_domain_hash, created_at, updated_at, email_verified, phone_verified FROM users WHERE id = ?',
      [userId]
    );

    // PII data (if available)
    let piiData: {
      email?: string;
      phone_number?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      middle_name?: string;
      nickname?: string;
      preferred_username?: string;
      picture?: string;
      website?: string;
      gender?: string;
      birthdate?: string;
      zoneinfo?: string;
      locale?: string;
    } = {};
    if (piiAdapter) {
      const piiUser = await piiAdapter.query<{
        email?: string;
        phone_number?: string;
        name?: string;
        given_name?: string;
        family_name?: string;
        middle_name?: string;
        nickname?: string;
        preferred_username?: string;
        picture?: string;
        website?: string;
        gender?: string;
        birthdate?: string;
        zoneinfo?: string;
        locale?: string;
      }>('SELECT * FROM users_pii WHERE user_id = ?', [userId]);
      if (piiUser.length > 0) {
        piiData = piiUser[0];
      }
    }

    if (coreUser.length > 0) {
      exportedData.profile = {
        id: coreUser[0].id,
        email: piiData.email ?? '',
        emailVerified: coreUser[0].email_verified === 1,
        phoneNumber: piiData.phone_number,
        phoneNumberVerified: coreUser[0].phone_verified === 1,
        name: piiData.name,
        givenName: piiData.given_name,
        familyName: piiData.family_name,
        middleName: piiData.middle_name,
        nickname: piiData.nickname,
        preferredUsername: piiData.preferred_username,
        picture: piiData.picture,
        website: piiData.website,
        gender: piiData.gender,
        birthdate: piiData.birthdate,
        zoneinfo: piiData.zoneinfo,
        locale: piiData.locale,
        createdAt: toISOString(coreUser[0].created_at),
        updatedAt: toISOString(coreUser[0].updated_at),
      };
    }
  }

  // Collect consents
  if (sections.includes('consents')) {
    const consents = await coreAdapter.query<{
      client_id: string;
      scope: string;
      selected_scopes: string | null;
      granted_at: number;
      expires_at: number | null;
      privacy_policy_version: string | null;
      tos_version: string | null;
    }>(
      `SELECT client_id, scope, selected_scopes, granted_at, expires_at,
              privacy_policy_version, tos_version
       FROM oauth_client_consents
       WHERE user_id = ? AND tenant_id = ?`,
      [userId, tenantId]
    );

    exportedData.consents = consents.map((c) => ({
      clientId: c.client_id,
      scopes: c.scope.split(' '),
      selectedScopes: c.selected_scopes ? JSON.parse(c.selected_scopes) : undefined,
      grantedAt: toISOString(c.granted_at),
      expiresAt: c.expires_at ? toISOString(c.expires_at) : undefined,
      policyVersions:
        c.privacy_policy_version || c.tos_version
          ? {
              privacyPolicy: c.privacy_policy_version ?? undefined,
              termsOfService: c.tos_version ?? undefined,
            }
          : undefined,
    }));
  }

  // Collect active sessions (without sensitive data)
  if (sections.includes('sessions')) {
    const sessions = await coreAdapter.query<{
      id: string;
      created_at: number;
      expires_at: number;
      last_activity_at: number | null;
    }>(
      `SELECT id, created_at, expires_at, last_activity_at
       FROM sessions
       WHERE user_id = ? AND tenant_id = ? AND expires_at > ?`,
      [userId, tenantId, now]
    );

    exportedData.sessions = sessions.map((s) => ({
      id: s.id,
      createdAt: toISOString(s.created_at),
      expiresAt: toISOString(s.expires_at),
      lastActiveAt: s.last_activity_at ? toISOString(s.last_activity_at) : undefined,
    }));
  }

  // Collect consent history (audit log)
  if (sections.includes('audit_log')) {
    const history = await coreAdapter.query<{
      client_id: string;
      action: string;
      scopes_before: string | null;
      scopes_after: string | null;
      created_at: number;
    }>(
      `SELECT client_id, action, scopes_before, scopes_after, created_at
       FROM consent_history
       WHERE user_id = ? AND tenant_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId, tenantId]
    );

    exportedData.consentHistory = history.map((h) => ({
      action: h.action,
      clientId: h.client_id,
      scopesBefore: h.scopes_before ? JSON.parse(h.scopes_before) : undefined,
      scopesAfter: h.scopes_after ? JSON.parse(h.scopes_after) : undefined,
      timestamp: toISOString(h.created_at),
    }));
  }

  // Collect passkeys (minimal info for portability)
  if (sections.includes('passkeys')) {
    const passkeys = await coreAdapter.query<{
      id: string;
      created_at: number;
      last_used_at: number | null;
      name: string | null;
    }>(
      `SELECT id, created_at, last_used_at, name
       FROM user_passkeys
       WHERE user_id = ?`,
      [userId]
    );

    exportedData.passkeys = passkeys.map((p) => ({
      id: p.id,
      deviceName: p.name ?? undefined,
      createdAt: toISOString(p.created_at),
      lastUsedAt: p.last_used_at ? toISOString(p.last_used_at) : undefined,
    }));
  }

  return exportedData;
}

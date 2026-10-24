import { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  ADMIN_SESSION_PII_FIELDS,
  createAdminPiiAccessLog,
  noteAdminPiiRead,
  scheduleAdminPiiAccessLog,
} from './admin-pii-access-log';
import {
  invalidateUserCache,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  createPIIContextFromHono,
  createAuthContextFromHono,
  CanonicalRuntimeUserStore,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  createAuditLogFromContext,
  getLogger,
  recordUserSessionRevocationEndingSessions,
} from '@authrim/ar-lib-core';
import { getCanonicalTenantBaseUrl } from './request-issuer';
import { detectImageType, logSanitizedError, scheduleAdminAuditLog } from './admin-shared';
import { adminActorIdFromContext, startAdminSessionEndLogout } from './admin-session-end';
import { endedSessionsOf } from './session-end-logout';
import { getCanonicalAccountStatus } from './account-status';
import {
  adminAccountContact,
  adminAccountContacts,
  adminAccountCoreAdapter,
} from './admin-account-storage';

const AVATAR_CONTENT_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function resolveAvatarContentType(filename: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.(?:gif|jpe?g|png|webp)$/u.test(filename)) {
    return null;
  }
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension ? (AVATAR_CONTENT_TYPES[extension] ?? null) : null;
}

function buildAvatarObjectKey(tenantId: string, filename: string): string {
  return `avatars/${tenantId}/users/${filename}`;
}

function resolveOwnedAvatarFilename(pictureUrl: string, canonicalBaseUrl: string): string | null {
  try {
    const picture = new URL(pictureUrl);
    const canonical = new URL(canonicalBaseUrl);
    if (picture.origin !== canonical.origin || picture.search || picture.hash) {
      return null;
    }
    const match = /^\/api\/avatars\/([^/]+)$/u.exec(picture.pathname);
    const filename = match?.[1] ? decodeURIComponent(match[1]) : '';
    return filename && resolveAvatarContentType(filename) ? filename : null;
  } catch {
    return null;
  }
}

function createAvatarRuntimeUserStore(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): CanonicalRuntimeUserStore {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
}

/**
 * Serve avatar image from R2
 * GET /api/avatars/:filename
 */
export async function serveAvatarHandler(c: Context<{ Bindings: Env }>) {
  try {
    const filename = c.req.param('filename')!;
    const tenantId = getTenantIdFromContext(c);
    const contentType = resolveAvatarContentType(filename);
    if (!contentType) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const object = await c.env.PUBLIC_ASSETS?.get(buildAvatarObjectKey(tenantId, filename));

    if (!object) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', contentType);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');

    return new Response(object.body, {
      headers,
    });
  } catch (error) {
    logSanitizedError('Serve avatar error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Upload user avatar
 * POST /admin/users/:id/avatar
 *
 * PII Separation: picture field is stored in the canonical PII value store.
 */
export async function adminUserAvatarUploadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const runtimeUsers = createAvatarRuntimeUserStore(c, tenantId);

    const runtimeUser = await runtimeUsers.findById(userId);

    if (!runtimeUser) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const body = await c.req.parseBody();
    const file = body['avatar'];

    if (!file || !(file instanceof File)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Avatar file is required',
        },
        400
      );
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.type)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid file type. Allowed types: JPEG, PNG, GIF, WebP',
        },
        400
      );
    }

    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'File size exceeds 5MB limit',
        },
        400
      );
    }

    const sanitizedName = file.name.replace(/\.\./g, '').replace(/[/\\]/g, '');
    const rawExtension = sanitizedName.split('.').pop()?.toLowerCase() || '';
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    if (!allowedExtensions.includes(rawExtension)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid file extension. Allowed: jpg, jpeg, png, gif, webp',
        },
        400
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const detectedType = detectImageType(uint8Array);
    if (!detectedType) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'File content does not appear to be a valid image',
        },
        400
      );
    }

    const fileExtension = detectedType.extension;
    const fileName = `${crypto.randomUUID()}.${fileExtension}`;
    const filePath = buildAvatarObjectKey(tenantId, fileName);

    if (!c.env.PUBLIC_ASSETS) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Public assets bucket is not configured',
        },
        503
      );
    }

    await c.env.PUBLIC_ASSETS.put(filePath, arrayBuffer, {
      httpMetadata: {
        contentType: detectedType.mimeType,
      },
    });

    const canonicalBaseUrl = getCanonicalTenantBaseUrl(c.env, tenantId);
    const avatarUrl = `${canonicalBaseUrl}/api/avatars/${fileName}`;

    try {
      await runtimeUsers.syncUser({
        userId,
        active: runtimeUser.active === 1,
        emailVerified: runtimeUser.email_verified === 1,
        phoneNumberVerified: runtimeUser.phone_number_verified === 1,
        piiFields: { picture: true },
        sensitiveValues: { picture: avatarUrl },
      });
    } catch (error) {
      await c.env.PUBLIC_ASSETS.delete(filePath).catch((cleanupError) => {
        logSanitizedError('Avatar upload rollback delete error', cleanupError);
      });
      throw error;
    }

    if (runtimeUser.picture) {
      const previousFilename = resolveOwnedAvatarFilename(runtimeUser.picture, canonicalBaseUrl);
      if (previousFilename && previousFilename !== fileName) {
        await c.env.PUBLIC_ASSETS.delete(buildAvatarObjectKey(tenantId, previousFilename)).catch(
          (error) => {
            logSanitizedError('Previous avatar delete error', error);
          }
        );
      }
    }

    await invalidateUserCache(c.env, tenantId, userId);

    return c.json({
      success: true,
      avatarUrl,
      message: 'Avatar uploaded successfully',
    });
  } catch (error) {
    logSanitizedError('Admin avatar upload error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to upload avatar',
      },
      500
    );
  }
}

/**
 * Delete user avatar
 * DELETE /admin/users/:id/avatar
 *
 * PII Separation: picture field is stored in the canonical PII value store.
 */
export async function adminUserAvatarDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const runtimeUsers = createAvatarRuntimeUserStore(c, tenantId);

    const runtimeUser = await runtimeUsers.findById(userId);

    if (!runtimeUser) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const pictureUrl = runtimeUser.picture ?? null;

    if (!pictureUrl) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'User does not have an avatar',
        },
        404
      );
    }

    const canonicalBaseUrl = getCanonicalTenantBaseUrl(c.env, tenantId);
    const filename = resolveOwnedAvatarFilename(pictureUrl, canonicalBaseUrl);

    await runtimeUsers.syncUser({
      userId,
      active: runtimeUser.active === 1,
      emailVerified: runtimeUser.email_verified === 1,
      phoneNumberVerified: runtimeUser.phone_number_verified === 1,
      piiFields: { picture: true },
      sensitiveValues: { picture: null },
    });

    await invalidateUserCache(c.env, tenantId, userId);

    if (filename) {
      try {
        await c.env.PUBLIC_ASSETS?.delete(buildAvatarObjectKey(tenantId, filename));
      } catch (error) {
        logSanitizedError('R2 delete error', error);
      }
    }

    return c.json({
      success: true,
      message: 'Avatar deleted successfully',
    });
  } catch (error) {
    logSanitizedError('Admin avatar delete error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete avatar',
      },
      500
    );
  }
}

/**
 * List sessions with filtering
 * GET /admin/sessions
 *
 * PII Separation: Sessions are in Core DB. User email/name must be fetched from PII DB separately.
 * Cannot use JOIN across databases.
 */
export async function adminSessionsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const userId = c.req.query('user_id') || c.req.query('userId');
    const status = c.req.query('status');
    const active = c.req.query('active');

    const offset = (page - 1) * limit;
    const now = Math.floor(Date.now() / 1000);

    let query = 'SELECT * FROM sessions WHERE tenant_id = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ?';
    const bindings: unknown[] = [tenantId];
    const countBindings: unknown[] = [tenantId];

    if (userId) {
      query += ' AND user_id = ?';
      countQuery += ' AND user_id = ?';
      bindings.push(userId);
      countBindings.push(userId);
    }

    if (status === 'active' || active === 'true') {
      query += ' AND expires_at > ?';
      countQuery += ' AND expires_at > ?';
      bindings.push(now);
      countBindings.push(now);
    } else if (status === 'expired' || active === 'false') {
      query += ' AND expires_at <= ?';
      countQuery += ' AND expires_at <= ?';
      bindings.push(now);
      countBindings.push(now);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    interface SessionRow {
      id: string;
      user_id: string;
      created_at: number;
      last_accessed_at: number | null;
      expires_at: number;
      ip_address: string | null;
      user_agent: string | null;
    }

    const [totalResult, sessions] = await Promise.all([
      authCtx.coreAdapter.queryOne<{ count: number }>(countQuery, countBindings),
      authCtx.coreAdapter.query<SessionRow>(query, bindings),
    ]);

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    const userContactMap = await adminAccountContacts(
      c,
      tenantId,
      sessions.map((session) => session.user_id)
    );

    const formattedSessions = sessions.map((session) => {
      const userContact = userContactMap.get(session.user_id);
      return {
        id: session.id,
        user_id: session.user_id,
        user_email: userContact?.email ?? null,
        user_name: userContact?.name ?? null,
        created_at: new Date(session.created_at * 1000).toISOString(),
        last_accessed_at: session.last_accessed_at
          ? new Date(session.last_accessed_at * 1000).toISOString()
          : new Date(session.created_at * 1000).toISOString(),
        expires_at: new Date(session.expires_at * 1000).toISOString(),
        ip_address: session.ip_address || null,
        user_agent: session.user_agent || null,
        is_active: session.expires_at > now,
      };
    });

    if (formattedSessions.length > 0) {
      const accessLog = createAdminPiiAccessLog(c, tenantId, 'admin.sessions.list');
      for (const session of formattedSessions) {
        const contact = userContactMap.get(session.user_id);
        if (contact) {
          noteAdminPiiRead(
            accessLog,
            contact.store,
            session.user_id,
            session,
            ADMIN_SESSION_PII_FIELDS
          );
        } else if (session.ip_address || session.user_agent) {
          // A routed session's client facts are personal data too. Do not disclose them with an
          // arbitrary default-store audit when the account's PII owner cannot be verified.
          throw new Error('admin_session_pii_audit_owner_unavailable');
        }
      }
      scheduleAdminPiiAccessLog(c, accessLog, tenantId);
    }

    return c.json({
      sessions: formattedSessions,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    logSanitizedError('Admin sessions list error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve sessions',
      },
      500
    );
  }
}

/**
 * Get session details by ID
 * GET /admin/sessions/:id
 */
export async function adminSessionGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const sessionId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    let sessionData: Session | null = null;
    let isActive = false;
    let sessionStoreOk = false;

    if (isShardedSessionId(sessionId)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
        sessionData = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

        if (sessionData && (sessionData.tenantId !== tenantId || sessionData.id !== sessionId)) {
          return c.json({ error: 'not_found', error_description: 'Session not found' }, 404);
        }
        if (sessionData) {
          isActive = sessionData.expiresAt > Date.now();
          sessionStoreOk = true;
        }
      } catch {
        const log = getLogger(c).module('ADMIN');
        log.warn('Failed to get session from SessionStore', { action: 'session_get', sessionId });
      }
    }

    interface SessionRow {
      id: string;
      user_id: string;
      created_at: number;
      expires_at: number;
    }
    const session = await authCtx.coreAdapter.queryOne<SessionRow>(
      'SELECT * FROM sessions WHERE id = ? AND tenant_id = ?',
      [sessionId, tenantId]
    );

    if (!session && !sessionData) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Session not found',
        },
        404
      );
    }

    const userId = sessionData?.userId || session?.user_id;
    const contact = userId ? await adminAccountContact(c, tenantId, userId) : null;
    const userEmail = contact?.email ?? null;
    const userName = contact?.name ?? null;

    const result = {
      id: sessionId,
      userId,
      userEmail,
      userName,
      expiresAt: sessionData?.expiresAt || (session?.expires_at as number) * 1000,
      createdAt: sessionData?.createdAt || (session?.created_at as number) * 1000,
      isActive: isActive || (session?.expires_at as number) > Math.floor(Date.now() / 1000),
      source: sessionStoreOk ? 'memory' : 'database',
    };

    if (userId && contact) {
      const accessLog = createAdminPiiAccessLog(c, tenantId, 'admin.sessions.get');
      noteAdminPiiRead(
        accessLog,
        contact.store,
        userId,
        { user_email: userEmail, user_name: userName },
        ADMIN_SESSION_PII_FIELDS
      );
      scheduleAdminPiiAccessLog(c, accessLog, tenantId);
    }

    return c.json({
      session: result,
    });
  } catch (error) {
    logSanitizedError('Admin session get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve session',
      },
      500
    );
  }
}

/**
 * Force logout individual session
 * DELETE /api/admin/sessions/:id
 */
export async function adminSessionRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const sessionId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    let liveSession: Session | null = null;
    let sessionStore: ReturnType<typeof getSessionStoreBySessionId>['stub'] | undefined;
    const log = getLogger(c).module('ADMIN');
    if (isShardedSessionId(sessionId)) {
      sessionStore = getSessionStoreBySessionId(c.env, sessionId, tenantId).stub;
      liveSession = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
      if (liveSession && (liveSession.tenantId !== tenantId || liveSession.id !== sessionId)) {
        return c.json({ error: 'not_found', error_description: 'Session not found' }, 404);
      }
    }
    const session = liveSession
      ? null
      : await authCtx.coreAdapter.queryOne<{ id: string; user_id: string }>(
          'SELECT id, user_id FROM sessions WHERE id = ? AND tenant_id = ?',
          [sessionId, tenantId]
        );
    const userId = liveSession?.userId ?? session?.user_id;
    if (!userId) {
      return c.json({ error: 'not_found', error_description: 'Session not found' }, 404);
    }

    // The DO's tenant-bound owner is authoritative for live sessions. A legacy row is not
    // required: current sign-in stores the session in SessionStore, not in this SQL table.
    let ended = false;
    if (sessionStore) {
      ended = await sessionStore.invalidateSessionRpc(sessionId);
      if (!ended) {
        log.warn('Failed to delete session from SessionStore', {
          action: 'session_delete',
          sessionId,
        });
      }
    } else {
      log.warn('Session is not in sharded format, skipping DO deletion', {
        action: 'session_delete',
        sessionId,
      });
    }
    try {
      const removed = await authCtx.coreAdapter.execute(
        'DELETE FROM sessions WHERE id = ? AND tenant_id = ? AND user_id = ?',
        [sessionId, tenantId, userId]
      );
      ended = ended || (removed.rowsAffected ?? 0) > 0;
    } finally {
      // A SQL failure cannot undo a DO invalidation: keep logout for the sessions already ended.
      if (ended) {
        await startAdminSessionEndLogout(c, {
          tenantId,
          sessions: endedSessionsOf(userId, [sessionId]),
          trigger: { action: 'session.revoke', actorId: adminActorIdFromContext(c) },
          log,
        });
      }
    }

    log.info('Admin revoked session', {
      action: 'session_revoke',
      sessionId,
      userId,
    });

    return c.json({
      success: true,
      message: 'Session revoked successfully',
      sessionId,
    });
  } catch (error) {
    logSanitizedError('Admin session revoke error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke session',
      },
      500
    );
  }
}

/**
 * Revoke all sessions for a user
 * DELETE /api/admin/users/:id/sessions
 *
 * Deletes persisted session rows and invalidates any sharded SessionStore entries
 * that can be located from the persistence index.
 */
export async function adminUserRevokeAllSessionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const accountAdapter = await adminAccountCoreAdapter(c, tenantId, userId);
    const account = accountAdapter
      ? await getCanonicalAccountStatus(accountAdapter, tenantId, userId)
      : null;

    if (!account) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const log = getLogger(c).module('ADMIN');
    const revokedAfterMs = Date.now();
    // The sessions this revocation ended (read with the epoch move): their relying parties are
    // told after the response.
    const { endedSessionIds } = await recordUserSessionRevocationEndingSessions(
      c.env,
      tenantId,
      userId,
      revokedAfterMs
    );
    await startAdminSessionEndLogout(c, {
      tenantId,
      sessions: endedSessionsOf(userId, endedSessionIds),
      trigger: { action: 'user.sessions_revoked', actorId: adminActorIdFromContext(c) },
      log,
    });

    const sessions = await authCtx.coreAdapter.query<{ id: string }>(
      'SELECT id FROM sessions WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    let storeRevokedCount = 0;
    for (const session of sessions) {
      if (!isShardedSessionId(session.id)) {
        continue;
      }
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, session.id, tenantId);
        const deleted = await sessionStore.invalidateSessionRpc(session.id);
        if (deleted) {
          storeRevokedCount += 1;
        } else {
          log.warn('Failed to delete session from SessionStore', {
            action: 'session_delete',
            sessionId: session.id,
          });
        }
      } catch {
        log.warn('Failed to route to session store', {
          action: 'session_delete',
          sessionId: session.id,
        });
      }
    }

    const deleteResult = await authCtx.coreAdapter.execute(
      'DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    const dbRevokedCount = deleteResult.rowsAffected || 0;

    log.info('Admin revoked all sessions for user', {
      action: 'revoke_all_sessions',
      userId,
      revokedCount: dbRevokedCount,
      storeRevokedCount,
    });

    await createAuditLogFromContext(c, 'user.sessions_revoked', 'user', userId, {
      revoked_count: dbRevokedCount,
      store_revoked_count: storeRevokedCount,
      revoked_after_ms: revokedAfterMs,
    });
    scheduleAdminAuditLog(c, 'user.sessions_revoked', userId, 'success', {
      revoked_count: dbRevokedCount,
      store_revoked_count: storeRevokedCount,
      revoked_after_ms: revokedAfterMs,
    });

    return c.json({
      success: true,
      message: 'All located user sessions were revoked.',
      userId,
      revokedCount: dbRevokedCount,
      storeRevokedCount,
      revokedAfterMs,
    });
  } catch (error) {
    logSanitizedError('Admin revoke all sessions error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke user sessions',
      },
      500
    );
  }
}

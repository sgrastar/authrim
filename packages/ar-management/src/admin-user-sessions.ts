import { Context } from 'hono';
import type { Env, Session } from '@authrim/ar-lib-core';
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
  getSessionRevocationStore,
  recordUserSessionRevocation,
} from '@authrim/ar-lib-core';
import { getCanonicalTenantBaseUrl } from './request-issuer';
import { detectImageType, logSanitizedError, scheduleAdminAuditLog } from './admin-shared';

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

function createRuntimeUserStore(
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
 * GET /avatars/:filename
 */
export async function serveAvatarHandler(c: Context<{ Bindings: Env }>) {
  try {
    const filename = c.req.param('filename')!;
    const contentType = resolveAvatarContentType(filename);
    if (!contentType) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const filePath = `avatars/${filename}`;

    const object = await c.env.AVATARS.get(filePath);

    if (!object) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', contentType);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
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
    const runtimeUsers = createRuntimeUserStore(c, tenantId);

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
    const fileName = `${userId}.${fileExtension}`;
    const filePath = `avatars/${fileName}`;

    await c.env.AVATARS.put(filePath, arrayBuffer, {
      httpMetadata: {
        contentType: detectedType.mimeType,
      },
    });

    const avatarUrl = `${getCanonicalTenantBaseUrl(c.env, tenantId)}/${filePath}`;

    await runtimeUsers.syncUser({
      userId,
      active: runtimeUser.active === 1,
      emailVerified: runtimeUser.email_verified === 1,
      phoneNumberVerified: runtimeUser.phone_number_verified === 1,
      piiFields: { picture: true },
      sensitiveValues: { picture: avatarUrl },
    });

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
    const runtimeUsers = createRuntimeUserStore(c, tenantId);

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

    const urlParts = pictureUrl.split('/');
    const filePath = urlParts.slice(-2).join('/');

    try {
      await c.env.AVATARS.delete(filePath);
    } catch (error) {
      logSanitizedError('R2 delete error', error);
    }

    await runtimeUsers.syncUser({
      userId,
      active: runtimeUser.active === 1,
      emailVerified: runtimeUser.email_verified === 1,
      phoneNumberVerified: runtimeUser.phone_number_verified === 1,
      piiFields: { picture: true },
      sensitiveValues: { picture: null },
    });

    await invalidateUserCache(c.env, tenantId, userId);

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
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const userId = c.req.query('user_id') || c.req.query('userId');
    const status = c.req.query('status');
    const active = c.req.query('active');
    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'user_id is required for session listing',
        },
        400
      );
    }
    if (status === 'expired' || active === 'false') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Only active Durable Object sessions can be listed',
        },
        400
      );
    }

    const nowMs = Date.now();
    const indexedSessions = await getSessionRevocationStore(
      c.env,
      tenantId,
      userId
    ).listActiveSessionsRpc(tenantId, userId, `account:${userId}`, nowMs);
    const activeSessions: Session[] = [];
    for (const indexed of indexedSessions.slice(0, 1_000)) {
      if (!isShardedSessionId(indexed.sessionId)) continue;
      try {
        const { stub } = getSessionStoreBySessionId(c.env, indexed.sessionId, tenantId);
        const session = (await stub.getSessionRpc(indexed.sessionId)) as Session | null;
        if (session && session.userId === userId && session.tenantId === tenantId) {
          activeSessions.push(session);
        }
      } catch {
        getLogger(c).module('ADMIN').warn('Failed to verify indexed session', {
          action: 'session_list',
          sessionId: indexed.sessionId,
        });
      }
    }

    const total = activeSessions.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const user = await createRuntimeUserStore(c, tenantId).findById(userId, {
      includeInactive: true,
    });
    const formattedSessions = activeSessions.slice(offset, offset + limit).map((session) => {
      return {
        id: session.id,
        user_id: session.userId,
        user_email: user?.email ?? null,
        user_name: user?.name ?? null,
        created_at: new Date(session.createdAt).toISOString(),
        last_accessed_at: new Date(session.createdAt).toISOString(),
        expires_at: new Date(session.expiresAt).toISOString(),
        ip_address: session.data?.ipAddress ?? null,
        user_agent: session.data?.userAgent ?? null,
        is_active: session.expiresAt > nowMs,
      };
    });

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
    let sessionData: Session | null = null;

    if (isShardedSessionId(sessionId)) {
      try {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
        sessionData = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

        if (sessionData) {
          if (sessionData.tenantId !== tenantId) sessionData = null;
        }
      } catch {
        const log = getLogger(c).module('ADMIN');
        log.warn('Failed to get session from SessionStore', { action: 'session_get', sessionId });
      }
    }

    if (!sessionData) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Session not found',
        },
        404
      );
    }

    let userEmail: string | null = null;
    let userName: string | null = null;
    const userId = sessionData.userId;
    if (userId) {
      const runtimeUser = await createRuntimeUserStore(c, tenantId).findById(userId, {
        includeInactive: true,
      });
      userEmail = runtimeUser?.email || null;
      userName = runtimeUser?.name || null;
    }

    const result = {
      id: sessionId,
      userId,
      userEmail,
      userName,
      expiresAt: sessionData.expiresAt,
      createdAt: sessionData.createdAt,
      isActive: sessionData.expiresAt > Date.now(),
      source: 'durable_object',
    };

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
 * POST /admin/sessions/:id/revoke
 */
export async function adminSessionRevokeHandler(c: Context<{ Bindings: Env }>) {
  try {
    const sessionId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    if (!isShardedSessionId(sessionId)) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Session not found',
        },
        404
      );
    }

    const log = getLogger(c).module('ADMIN');
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
    if (!session || session.tenantId !== tenantId) {
      return c.json({ error: 'not_found', error_description: 'Session not found' }, 404);
    }
    const deleted = await sessionStore.invalidateSessionRpc(sessionId);
    if (!deleted) throw new Error('session_revocation_failed');

    log.info('Admin revoked session', {
      action: 'session_revoke',
      sessionId,
      userId: session.userId,
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
 * POST /admin/users/:id/revoke-all-sessions
 *
 * Advances the per-user Durable Object revocation epoch.
 */
export async function adminUserRevokeAllSessionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const runtimeUser = await createRuntimeUserStore(c, tenantId).findById(userId);

    if (!runtimeUser) {
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
    const indexedSessions = await getSessionRevocationStore(
      c.env,
      tenantId,
      userId
    ).listActiveSessionsRpc(tenantId, userId, `account:${userId}`, revokedAfterMs);
    await recordUserSessionRevocation(c.env, tenantId, userId, revokedAfterMs);
    const revokedCount = indexedSessions.length;

    log.info('Admin revoked all sessions for user', {
      action: 'revoke_all_sessions',
      userId,
      revokedCount,
    });

    await createAuditLogFromContext(c, 'user.sessions_revoked', 'user', userId, {
      revoked_count: revokedCount,
      revoked_after_ms: revokedAfterMs,
    });
    scheduleAdminAuditLog(c, 'user.sessions_revoked', userId, 'success', {
      revoked_count: revokedCount,
      revoked_after_ms: revokedAfterMs,
    });

    return c.json({
      success: true,
      message: 'All user sessions were revoked.',
      userId,
      revokedCount,
      storeRevokedCount: revokedCount,
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

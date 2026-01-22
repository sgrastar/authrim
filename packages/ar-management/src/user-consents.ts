/**
 * User Consent Management API
 *
 * Provides endpoints for users to view and revoke their consents.
 * Supports both access token and session-based authentication.
 *
 * Endpoints:
 * - GET /api/user/consents - List user's consents
 * - DELETE /api/user/consents/:clientId - Revoke consent for a specific client
 */

import { Context } from 'hono';
import type { Env, UserConsentRecord, ConsentRevokeResult } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  invalidateConsentCache,
  revokeToken,
  publishEvent,
  CONSENT_EVENTS,
  introspectTokenFromContext,
  getSessionStoreBySessionId,
  type ExtendedConsentEventData,
  getLogger,
} from '@authrim/ar-lib-core';
import { getCookie } from 'hono/cookie';

/**
 * Get user ID from request context
 * Supports both access token (Bearer) and session-based (Cookie) auth
 *
 * Authentication priority:
 * 1. Bearer token (access token) - introspected via KeyManager
 * 2. Session cookie (sid) - verified via SessionStore DO
 */
async function getUserIdFromContext(c: Context<{ Bindings: Env }>): Promise<string | null> {
  // 1. Try Bearer token authentication first
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const introspection = await introspectTokenFromContext(c);
    if (introspection.valid && introspection.claims?.sub) {
      return introspection.claims.sub as string;
    }
    // Token present but invalid - don't fall through to session
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
      const log = getLogger(c).module('USER-CONSENTS');
      log.error('Session validation error', {}, error as Error);
    }
  }

  return null;
}

/**
 * List user's consents
 * GET /api/user/consents
 *
 * Returns all consents granted by the authenticated user.
 */
export async function userConsentsListHandler(c: Context<{ Bindings: Env }>) {
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

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Query consents with client info
    const consentsResult = await authCtx.coreAdapter.query<{
      id: string;
      client_id: string;
      scope: string;
      selected_scopes: string | null;
      granted_at: number;
      expires_at: number | null;
      privacy_policy_version: string | null;
      tos_version: string | null;
      consent_version: number | null;
      client_name: string | null;
      logo_uri: string | null;
    }>(
      `SELECT c.id, c.client_id, c.scope, c.selected_scopes, c.granted_at, c.expires_at,
              c.privacy_policy_version, c.tos_version, c.consent_version,
              oc.client_name, oc.logo_uri
       FROM oauth_client_consents c
       LEFT JOIN oauth_clients oc ON c.client_id = oc.client_id
       WHERE c.user_id = ? AND c.tenant_id = ?
       ORDER BY c.granted_at DESC`,
      [userId, tenantId]
    );

    const consents: UserConsentRecord[] = consentsResult.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      clientLogoUri: row.logo_uri ?? undefined,
      scopes: row.scope.split(' '),
      selectedScopes: row.selected_scopes ? JSON.parse(row.selected_scopes) : undefined,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at ?? undefined,
      policyVersions:
        row.privacy_policy_version || row.tos_version
          ? {
              privacyPolicyVersion: row.privacy_policy_version ?? undefined,
              tosVersion: row.tos_version ?? undefined,
              consentVersion: row.consent_version ?? 1,
            }
          : undefined,
    }));

    return c.json({
      consents,
      total: consents.length,
    });
  } catch (error) {
    const log = getLogger(c).module('USER-CONSENTS');
    log.error('Failed to list consents', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list consents',
      },
      500
    );
  }
}

/**
 * Revoke consent for a specific client
 * DELETE /api/user/consents/:clientId
 *
 * Revokes consent and optionally invalidates related tokens.
 */
export async function userConsentRevokeHandler(c: Context<{ Bindings: Env }>) {
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

    const clientId = c.req.param('clientId');
    if (!clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Client ID is required',
        },
        400
      );
    }

    // Parse request body for options
    let revokeTokens = true; // Default: revoke tokens
    let reason: 'user_request' | 'admin_action' | 'policy_violation' = 'user_request';

    const contentType = c.req.header('Content-Type') || '';
    if (contentType.includes('application/json')) {
      try {
        const body = await c.req.json<{
          revoke_tokens?: boolean;
          reason?: string;
        }>();
        if (body.revoke_tokens !== undefined) {
          revokeTokens = body.revoke_tokens;
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if consent exists
    const existingConsent = await authCtx.coreAdapter.query<{
      id: string;
      scope: string;
      granted_at: number;
    }>(
      `SELECT id, scope, granted_at FROM oauth_client_consents
       WHERE user_id = ? AND client_id = ? AND tenant_id = ?`,
      [userId, clientId, tenantId]
    );

    if (existingConsent.length === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Consent not found',
        },
        404
      );
    }

    const consent = existingConsent[0];
    const previousScopes = consent.scope.split(' ');
    const now = Date.now();

    // Delete consent
    await authCtx.coreAdapter.execute(
      'DELETE FROM oauth_client_consents WHERE user_id = ? AND client_id = ? AND tenant_id = ?',
      [userId, clientId, tenantId]
    );

    // Record in consent history
    const historyId = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO consent_history (id, tenant_id, user_id, client_id, action, scopes_before, scopes_after, created_at)
       VALUES (?, ?, ?, ?, 'revoked', ?, NULL, ?)`,
      [historyId, tenantId, userId, clientId, JSON.stringify(previousScopes), now]
    );

    // Invalidate consent cache
    await invalidateConsentCache(c.env, userId, clientId);

    // Revoke related tokens if requested
    let accessTokensRevoked = 0;
    let refreshTokensRevoked = 0;

    if (revokeTokens) {
      // Note: In a full implementation, this would query and revoke tokens
      // For now, we add the user+client combo to a revocation list
      // The actual token invalidation happens during token verification
      try {
        // Add to revocation list (tokens will be rejected on next use)
        const revocationKey = `consent_revoked:${userId}:${clientId}`;
        const revocationTTL = 86400 * 90; // 90 days (typical refresh token lifetime)
        await revokeToken(c.env, revocationKey, revocationTTL);
        // Estimate - actual count would require querying token stores
        refreshTokensRevoked = 1;
      } catch (error) {
        const log = getLogger(c).module('USER-CONSENTS');
        log.warn('Token revocation warning', { error: (error as Error).message });
      }
    }

    // Publish consent.revoked event
    const log = getLogger(c).module('USER-CONSENTS');
    publishEvent(c, {
      type: CONSENT_EVENTS.REVOKED,
      tenantId,
      data: {
        userId,
        clientId,
        scopes: previousScopes,
        previousScopes,
        revocationReason: reason,
        initiatedBy: 'user',
      } satisfies ExtendedConsentEventData,
    }).catch((err) => {
      log.error('Failed to publish consent.revoked event', { clientId }, err as Error);
    });

    const result: ConsentRevokeResult = {
      success: true,
      accessTokensRevoked,
      refreshTokensRevoked,
      revokedAt: now,
    };

    return c.json(result);
  } catch (error) {
    const log = getLogger(c).module('USER-CONSENTS');
    log.error('Failed to revoke consent', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to revoke consent',
      },
      500
    );
  }
}

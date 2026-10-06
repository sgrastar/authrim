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
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  getTenantIdFromContext,
  invalidateConsentCache,
  listOAuthClientConsentsWithClients,
  resolveAccountDataContextFromHono,
  publishEvent,
  CONSENT_EVENTS,
  introspectTokenFromContext,
  getSessionStoreBySessionId,
  type ExtendedConsentEventData,
  getLogger,
} from '@authrim/ar-lib-core';
import { getCookie } from 'hono/cookie';
import { withdrawOAuthClientConsent } from './oauth-client-consent-withdrawal';

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
      const { stub: sessionStore } = getSessionStoreBySessionId(
        c.env,
        sid,
        getTenantIdFromContext(c)
      );
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
 * Resolve the user's account databases, where its consents are stored. Returns false when the
 * user has no account route, i.e. it has no consents.
 */
async function resolveConsentOwnerAccount(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<boolean> {
  try {
    await resolveAccountDataContextFromHono(c, userId);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return false;
    throw error;
  }
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
    if (!(await resolveConsentOwnerAccount(c, userId))) {
      return c.json({ consents: [], total: 0 });
    }

    // Consents are stored with the user in its account database; client records are tenant
    // metadata.
    const consentsResult = await listOAuthClientConsentsWithClients({
      accountCore: createAccountAuthContextFromHono(c, tenantId).coreAdapter,
      tenantMetadata: createAuthContextFromHono(c, tenantId).coreAdapter,
      tenantId,
      userId,
    });

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
 * Revokes consent and the client's refresh tokens for the user: withdrawing the grant ends the
 * tokens issued under it.
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

    const clientId = c.req.param('clientId')!;
    if (!clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Client ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    // Consents and their history are stored with the user in its account database.
    if (!(await resolveConsentOwnerAccount(c, userId))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Consent not found',
        },
        404
      );
    }
    const authCtx = createAccountAuthContextFromHono(c, tenantId);

    // Check if consent exists
    const existingConsent = await authCtx.coreAdapter.query<{
      id: string;
      scope: string;
      granted_at: number;
    }>(
      `SELECT id, scope, granted_at FROM oauth_client_consents
       WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
      [tenantId, userId, clientId]
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

    // Ends the tokens issued under the consent, then deletes it; a failure leaves the consent in
    // place so that a retry can complete the withdrawal.
    const { revokedAt: now, refreshTokenFamilies: familyCount } = await withdrawOAuthClientConsent(
      c.env,
      authCtx.coreAdapter,
      { tenantId, userId, clientId, previousScopes }
    );

    // Invalidate consent cache
    await invalidateConsentCache(c.env, userId, tenantId, clientId);

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
        revocationReason: 'user_request',
        initiatedBy: 'user',
      } satisfies ExtendedConsentEventData,
    }).catch((err) => {
      log.error('Failed to publish consent.revoked event', { clientId }, err as Error);
    });

    const result: ConsentRevokeResult = {
      success: true,
      accessTokensRevoked: 0,
      refreshTokensRevoked: familyCount,
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

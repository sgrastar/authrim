/**
 * Link/Unlink Identity Handlers
 * POST /auth/external/link - Start linking flow
 * GET /auth/external/link - List linked identities
 * DELETE /auth/external/link/:id - Unlink identity
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  buildIssuerUrl,
  getTenantIdFromContext,
  getLogger,
  resolveAccountDataContext,
} from '@authrim/ar-lib-core';
import {
  getLinkedIdentityById,
  listLinkedIdentities,
  deleteLinkedIdentity,
  countLinkedIdentities,
  getLinkedIdentityForUserAndProvider,
} from '../services/linked-identity-store';
import { getProvider } from '../services/provider-store';
import { hasPasskeyCredential } from '../services/identity-stitching';
import { revokeLinkedIdentityTokens } from '../services/token-revocation';
import type { LinkedIdentityListResponse } from '../types';

async function resolveLinkedIdentityAccountContext(env: Env, tenantId: string, userId: string) {
  const account = await resolveAccountDataContext(env, {
    tenantId,
    accountId: `account:${userId}`,
  });
  if (account.legacyUserId !== userId) throw new Error('external_idp_link_account_mismatch');
  return account;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * List linked identities for current user
 * GET /auth/external/link
 */
export async function handleListLinkedIdentities(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  const session = await verifySession(c);
  if (!session) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const account = await resolveLinkedIdentityAccountContext(c.env, tenantId, session.userId);
    const identities = await listLinkedIdentities(c.env, tenantId, session.userId, account?.piiDb);

    // Enrich with provider names
    const enrichedIdentities = await Promise.all(
      identities.map(async (identity) => {
        const provider = await getProvider(c.env, tenantId, identity.providerId);
        return {
          id: identity.id,
          providerId: identity.providerId,
          providerName: provider?.name || 'Unknown',
          providerEmail: identity.providerEmail,
          linkedAt: identity.linkedAt,
          lastLoginAt: identity.lastLoginAt,
        };
      })
    );

    const response: LinkedIdentityListResponse = {
      identities: enrichedIdentities,
    };

    return c.json(response);
  } catch (error) {
    log.error('Failed to list linked identities', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Start linking flow for existing account
 * POST /auth/external/link
 *
 * Request body:
 * - provider_id: ID of the provider to link
 * - redirect_uri: Optional redirect URI after linking
 */
export async function handleLinkIdentity(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  const session = await verifySession(c);
  if (!session) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  try {
    const body = await c.req.json<{
      provider_id: string;
      redirect_uri?: string;
    }>();

    if (!body.provider_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'provider_id' },
      });
    }

    const tenantId = getTenantIdFromContext(c);
    const account = await resolveLinkedIdentityAccountContext(c.env, tenantId, session.userId);

    // Check if provider exists
    const provider = await getProvider(c.env, tenantId, body.provider_id);
    if (!provider || !provider.enabled) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if already linked to this provider
    const existing = await getLinkedIdentityForUserAndProvider(
      c.env,
      tenantId,
      session.userId,
      body.provider_id,
      account?.piiDb
    );
    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Build URL to start linking flow
    const startUrl = new URL(
      `${buildIssuerUrl(c.env, tenantId)}/auth/external/${body.provider_id}/start`
    );
    startUrl.searchParams.set('link', 'true');
    if (body.redirect_uri) {
      startUrl.searchParams.set('redirect_uri', body.redirect_uri);
    }

    return c.json({ authorization_url: startUrl.toString() });
  } catch (error) {
    log.error('Failed to start linking', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Unlink identity from account
 * DELETE /auth/external/link/:id
 */
export async function handleUnlinkIdentity(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  const session = await verifySession(c);
  if (!session) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  const linkedIdentityId = c.req.param('id');
  if (!linkedIdentityId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  try {
    const tenantId = getTenantIdFromContext(c);
    const account = await resolveLinkedIdentityAccountContext(c.env, tenantId, session.userId);
    const removalDigest = account
      ? await sha256Hex(`${tenantId}\u0000${account.accountId}\u0000${linkedIdentityId}`)
      : undefined;
    const removalOperationId = removalDigest
      ? `external-idp-route-remove-${removalDigest.slice(0, 32)}`
      : undefined;
    // Verify ownership
    const identity = await getLinkedIdentityById(c.env, tenantId, linkedIdentityId, account?.piiDb);
    if (!identity && account && removalOperationId) {
      const provisioner = c.env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
      if (!provisioner) throw new Error('external_idp_account_provisioner_unavailable');
      try {
        const removal = await provisioner.getExternalIdpRouteRemovalStatus({
          schemaVersion: 1,
          tenantId,
          accountId: account.accountId,
          userId: session.userId,
          operationId: removalOperationId,
        });
        if (
          removal.operationId !== removalOperationId ||
          removal.accountId !== account.accountId ||
          (removal.status !== 201 && removal.status !== 202)
        ) {
          throw new Error('external_idp_route_removal_response_invalid');
        }
        return c.json({
          success: true,
          cleanup_pending: removal.status === 202,
          operation_id: removalOperationId,
          token_revocation: {
            attempted: false,
            access_token_revoked: false,
            refresh_token_revoked: false,
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'external_idp_route_removal_status_not_found'
        ) {
          return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
        }
        throw error;
      }
    }
    if (!identity || identity.userId !== session.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if this is the only authentication method
    const linkedCount = await countLinkedIdentities(
      c.env,
      tenantId,
      session.userId,
      account?.piiDb
    );
    const hasPasskey = await hasPasskeyCredential(c.env, tenantId, session.userId, account);

    if (linkedCount === 1 && !hasPasskey) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Attempt to revoke tokens at the provider (best-effort, RFC 7009)
    // This is done before deletion to ensure we have the tokens to revoke
    const revocationResult = await revokeLinkedIdentityTokens(c.env, identity);
    if (!revocationResult.success && revocationResult.errors.length > 0) {
      log.warn('Token revocation failed for identity', {
        errorCount: revocationResult.errors.length,
      });
    }

    let cleanupPending = false;
    let cleanupOperationId: string | undefined;
    const provisioner = c.env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
    if (!provisioner) throw new Error('external_idp_account_provisioner_unavailable');
    if (!removalDigest || !removalOperationId) {
      throw new Error('external_idp_route_removal_operation_invalid');
    }
    cleanupOperationId = removalOperationId;
    const removal = await provisioner.removeExternalIdpRoute({
      schemaVersion: 1,
      operationId: cleanupOperationId,
      idempotencyKey: `auth-external-idp-route-remove:${removalDigest}`,
      tenantId,
      accountId: account.accountId,
      userId: session.userId,
      linkedIdentityId,
      providerId: identity.providerId,
      providerUserId: identity.providerUserId,
    });
    if (
      removal.operationId !== cleanupOperationId ||
      removal.accountId !== account.accountId ||
      (removal.status !== 201 && removal.status !== 202)
    ) {
      throw new Error('external_idp_route_removal_response_invalid');
    }
    cleanupPending = removal.status === 202;

    // Include revocation status in response for transparency
    return c.json({
      success: true,
      cleanup_pending: cleanupPending,
      operation_id: cleanupOperationId,
      token_revocation: {
        attempted: true,
        access_token_revoked: revocationResult.accessTokenRevoked,
        refresh_token_revoked: revocationResult.refreshTokenRevoked,
        warnings: revocationResult.errors.length > 0 ? revocationResult.errors : undefined,
      },
    });
  } catch (error) {
    log.error('Failed to unlink identity', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

interface SessionInfo {
  id: string;
  userId: string;
}

/**
 * Verify session from cookie or Authorization header
 */
async function verifySession(c: Context<{ Bindings: Env }>): Promise<SessionInfo | null> {
  // Try cookie first
  const sessionCookie = c.req.header('Cookie')?.match(/authrim_session=([^;]+)/)?.[1];

  // Try Authorization header
  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const sessionToken = sessionCookie || bearerToken;
  if (!sessionToken) {
    return null;
  }

  // Verify session token using SESSION_STORE Durable Object (sharded)
  if (!isShardedSessionId(sessionToken)) {
    return null;
  }

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionToken,
      getTenantIdFromContext(c)
    );
    const response = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionToken}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      return null;
    }

    const session: { sessionId: string; userId: string } = await response.json();
    return { id: session.sessionId, userId: session.userId };
  } catch {
    return null;
  }
}

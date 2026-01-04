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
  getLogger,
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
    const identities = await listLinkedIdentities(c.env, session.userId);

    // Enrich with provider names
    const enrichedIdentities = await Promise.all(
      identities.map(async (identity) => {
        const provider = await getProvider(c.env, identity.providerId);
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

    // Check if provider exists
    const provider = await getProvider(c.env, body.provider_id);
    if (!provider || !provider.enabled) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if already linked to this provider
    const existing = await getLinkedIdentityForUserAndProvider(
      c.env,
      session.userId,
      body.provider_id
    );
    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Build URL to start linking flow
    const startUrl = new URL(`${c.env.ISSUER_URL}/auth/external/${body.provider_id}/start`);
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

  try {
    // Verify ownership
    const identity = await getLinkedIdentityById(c.env, linkedIdentityId);
    if (!identity || identity.userId !== session.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if this is the only authentication method
    const linkedCount = await countLinkedIdentities(c.env, session.userId);
    const hasPasskey = await hasPasskeyCredential(c.env, session.userId);

    if (linkedCount === 1 && !hasPasskey) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Attempt to revoke tokens at the provider (best-effort, RFC 7009)
    // This is done before deletion to ensure we have the tokens to revoke
    const revocationResult = await revokeLinkedIdentityTokens(c.env, identity);
    if (!revocationResult.success && revocationResult.errors.length > 0) {
      log.warn('Token revocation failed for identity', {
        linkedIdentityId,
        errors: revocationResult.errors,
      });
    }

    // Delete linked identity (always proceed even if revocation failed)
    await deleteLinkedIdentity(c.env, linkedIdentityId);

    // Include revocation status in response for transparency
    return c.json({
      success: true,
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
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionToken);
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

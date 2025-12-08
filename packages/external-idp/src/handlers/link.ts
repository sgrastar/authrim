/**
 * Link/Unlink Identity Handlers
 * POST /auth/external/link - Start linking flow
 * GET /auth/external/link - List linked identities
 * DELETE /auth/external/link/:id - Unlink identity
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { getSessionStoreBySessionId, isShardedSessionId } from '@authrim/shared';
import {
  getLinkedIdentityById,
  listLinkedIdentities,
  deleteLinkedIdentity,
  countLinkedIdentities,
  getLinkedIdentityForUserAndProvider,
} from '../services/linked-identity-store';
import { getProvider } from '../services/provider-store';
import { hasPasskeyCredential } from '../services/identity-stitching';
import type { LinkedIdentityListResponse } from '../types';

/**
 * List linked identities for current user
 * GET /auth/external/link
 */
export async function handleListLinkedIdentities(c: Context<{ Bindings: Env }>): Promise<Response> {
  const session = await verifySession(c);
  if (!session) {
    return c.json({ error: 'unauthorized' }, 401);
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
    console.error('Failed to list linked identities:', error);
    return c.json({ error: 'internal_error' }, 500);
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
  const session = await verifySession(c);
  if (!session) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await c.req.json<{
      provider_id: string;
      redirect_uri?: string;
    }>();

    if (!body.provider_id) {
      return c.json({ error: 'invalid_request', message: 'provider_id is required' }, 400);
    }

    // Check if provider exists
    const provider = await getProvider(c.env, body.provider_id);
    if (!provider || !provider.enabled) {
      return c.json({ error: 'unknown_provider' }, 404);
    }

    // Check if already linked to this provider
    const existing = await getLinkedIdentityForUserAndProvider(
      c.env,
      session.userId,
      body.provider_id
    );
    if (existing) {
      return c.json(
        {
          error: 'already_linked',
          message: 'Account is already linked to this provider',
        },
        400
      );
    }

    // Build URL to start linking flow
    const startUrl = new URL(`${c.env.ISSUER_URL}/auth/external/${body.provider_id}/start`);
    startUrl.searchParams.set('link', 'true');
    if (body.redirect_uri) {
      startUrl.searchParams.set('redirect_uri', body.redirect_uri);
    }

    return c.json({ authorization_url: startUrl.toString() });
  } catch (error) {
    console.error('Failed to start linking:', error);
    return c.json({ error: 'internal_error' }, 500);
  }
}

/**
 * Unlink identity from account
 * DELETE /auth/external/link/:id
 */
export async function handleUnlinkIdentity(c: Context<{ Bindings: Env }>): Promise<Response> {
  const session = await verifySession(c);
  if (!session) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const linkedIdentityId = c.req.param('id');

  try {
    // Verify ownership
    const identity = await getLinkedIdentityById(c.env, linkedIdentityId);
    if (!identity || identity.userId !== session.userId) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Check if this is the only authentication method
    const linkedCount = await countLinkedIdentities(c.env, session.userId);
    const hasPasskey = await hasPasskeyCredential(c.env, session.userId);

    if (linkedCount === 1 && !hasPasskey) {
      return c.json(
        {
          error: 'cannot_unlink',
          message: 'Cannot remove last authentication method',
        },
        400
      );
    }

    // Delete linked identity
    await deleteLinkedIdentity(c.env, linkedIdentityId);

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to unlink identity:', error);
    return c.json({ error: 'internal_error' }, 500);
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
    const sessionStore = getSessionStoreBySessionId(c.env, sessionToken);
    const response = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionToken}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      return null;
    }

    const session = (await response.json()) as { userId: string; sessionId: string };
    return { id: session.sessionId, userId: session.userId };
  } catch {
    return null;
  }
}

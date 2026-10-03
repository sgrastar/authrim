/**
 * Link/Unlink Identity Handlers (the account page's linked external accounts)
 * GET /api/external/links - List linked identities
 * POST /api/external/links - Start linking flow (re-authentication required)
 * DELETE /api/external/links/:id - Unlink identity (re-authentication required)
 *
 * Each is also served under /auth/external/links. Only the session cookie authenticates them,
 * so the router's Origin check covers the state-changing ones.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  ACCOUNT_REAUTH_REQUIRED_ERROR,
  createErrorResponse,
  AR_ERROR_CODES,
  buildIssuerUrl,
  ensureDatabaseAdapter,
  getTenantIdFromContext,
  getLogger,
  isLoginMethodRemovalSafe,
  isAccountReauthFresh,
  LoginMethodRemovalInProgressError,
  readAccountSession,
  resolveAccountDataContext,
  withLoginMethodRemovalLock,
  type AccountSession,
} from '@authrim/ar-lib-core';
import {
  getLinkedIdentityById,
  listLinkedIdentities,
  getLinkedIdentityForUserAndProvider,
} from '../services/linked-identity-store';
import { getProvider, getProviderByIdOrSlug } from '../services/provider-store';
import { revokeLinkedIdentityTokens } from '../services/token-revocation';
import { createLinkIntent, recordSocialAccountActivity } from '../services/link-intent';
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
 * GET /api/external/links
 */
export async function handleListLinkedIdentities(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  c.header('Cache-Control', 'no-store');
  const session = await verifySession(c);
  if (session instanceof Response) return session;

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
          ...(provider?.slug && { providerSlug: provider.slug }),
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
 * POST /api/external/links
 *
 * Request body:
 * - provider_id: ID of the provider to link
 *
 * Returns the external start URL carrying a one-use link intent; the provider's answer comes back
 * to the account page.
 */
export async function handleLinkIdentity(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  c.header('Cache-Control', 'no-store');
  const session = await verifyRecentSession(c);
  if (session instanceof Response) return session;

  try {
    const body = await c.req.json<{ provider_id?: unknown }>().catch(() => null);
    if (!body || typeof body.provider_id !== 'string' || !body.provider_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'provider_id' },
      });
    }
    const providerId = body.provider_id;

    const tenantId = getTenantIdFromContext(c);
    const account = await resolveLinkedIdentityAccountContext(c.env, tenantId, session.userId);

    // Check if provider exists
    // The account page names providers as the authentication-methods API does (slug, else id).
    const provider = await getProviderByIdOrSlug(c.env, providerId, tenantId);
    if (!provider || !provider.enabled) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if already linked to this provider
    const existing = await getLinkedIdentityForUserAndProvider(
      c.env,
      tenantId,
      session.userId,
      provider.id,
      account?.piiDb
    );
    if (existing) {
      return c.json(
        {
          error: 'already_linked',
          error_description: 'An account from this provider is already linked.',
        },
        409
      );
    }

    const intent = await createLinkIntent(c.env, tenantId, {
      userId: session.userId,
      sessionId: session.sessionId,
      providerId: provider.id,
    });
    const startUrl = new URL(
      `${buildIssuerUrl(c.env, tenantId)}/auth/external/${encodeURIComponent(provider.slug || provider.id)}/start`
    );
    startUrl.searchParams.set('link_intent', intent);

    return c.json({ authorization_url: startUrl.toString() });
  } catch (error) {
    log.error('Failed to start linking', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Unlink identity from account
 * DELETE /api/external/links/:id
 */
export async function handleUnlinkIdentity(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  c.header('Cache-Control', 'no-store');
  const session = await verifyRecentSession(c);
  if (session instanceof Response) return session;

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

    const provisioner = c.env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
    if (!provisioner) throw new Error('external_idp_account_provisioner_unavailable');
    if (!removalDigest || !removalOperationId) {
      throw new Error('external_idp_route_removal_operation_invalid');
    }

    // Only the check and the removal run under the account's removal lease; the provider's token
    // revocation (a call to another service) waits until after. Once the removal was asked for,
    // the tokens are revoked whatever its answer: it may have removed the link and then failed.
    let removalAttempted = false;
    const revokeTokens = async () => {
      const result = await revokeLinkedIdentityTokens(c.env, identity).catch((error: unknown) => ({
        success: false,
        accessTokenRevoked: false,
        refreshTokenRevoked: false,
        errors: [error instanceof Error ? error.message : 'revocation_failed'],
      }));
      if (!result.success && result.errors.length > 0) {
        log.warn('Token revocation failed for identity', { errorCount: result.errors.length });
      }
      return result;
    };
    let removal: Awaited<ReturnType<typeof provisioner.removeExternalIdpRoute>> | null;
    try {
      removal = await withLoginMethodRemovalLock(c.env, tenantId, session.userId, async (lease) => {
        // Never remove the last way the account signs in.
        const remains = await isLoginMethodRemovalSafe(c.env, {
          tenantId,
          userId: session.userId,
          coreAdapter: ensureDatabaseAdapter(account.coreDb, 'external-idp-unlink-core'),
          piiAdapter: ensureDatabaseAdapter(account.piiDb, 'external-idp-unlink-pii'),
          removing: { kind: 'linked_identity', id: identity.id },
        });
        if (!remains) return null;

        await lease.assertHeld();
        removalAttempted = true;
        return provisioner.removeExternalIdpRoute({
          schemaVersion: 1,
          operationId: removalOperationId,
          idempotencyKey: `auth-external-idp-route-remove:${removalDigest}`,
          tenantId,
          accountId: account.accountId,
          userId: session.userId,
          linkedIdentityId,
          providerId: identity.providerId,
          providerUserId: identity.providerUserId,
        });
      });
    } catch (error) {
      if (removalAttempted) await revokeTokens();
      throw error;
    }
    if (!removal) {
      return c.json(
        {
          error: 'remaining_login_method_required',
          error_description: 'Cannot remove the last available login method.',
        },
        400
      );
    }
    if (
      removal.operationId !== removalOperationId ||
      removal.accountId !== account.accountId ||
      (removal.status !== 201 && removal.status !== 202)
    ) {
      throw new Error('external_idp_route_removal_response_invalid');
    }

    await recordSocialAccountActivity(c, session.userId, 'account.social_account.unlinked', {
      linkedIdentityId: identity.id,
      providerId: identity.providerId,
    });

    // Revoke the provider's tokens (best-effort, RFC 7009) with the identity read before removal.
    const revocationResult = await revokeTokens();

    // Include revocation status in response for transparency
    return c.json({
      success: true,
      cleanup_pending: removal.status === 202,
      operation_id: removalOperationId,
      token_revocation: {
        attempted: true,
        access_token_revoked: revocationResult.accessTokenRevoked,
        refresh_token_revoked: revocationResult.refreshTokenRevoked,
        warnings: revocationResult.errors.length > 0 ? revocationResult.errors : undefined,
      },
    });
  } catch (error) {
    if (error instanceof LoginMethodRemovalInProgressError) {
      return c.json(
        {
          error: 'operation_in_progress',
          error_description: 'Another change to how this account signs in is in progress.',
        },
        409
      );
    }
    log.error('Failed to unlink identity', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * The signed-in account from the session cookie, or the 401 to answer. A session store failure is
 * a server error, never "signed out".
 */
async function verifySession(c: Context<{ Bindings: Env }>): Promise<AccountSession | Response> {
  const sessionId = c.req.header('Cookie')?.match(/(?:^|;\s*)authrim_session=([^;]+)/)?.[1];
  let session: AccountSession | null;
  try {
    session = await readAccountSession(
      c.env,
      getTenantIdFromContext(c),
      sessionId ? decodeURIComponent(sessionId) : null
    );
  } catch (error) {
    getLogger(c)
      .module('EXTERNAL-IDP')
      .error('Failed to read the account session', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  if (!session) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  return session;
}

/**
 * As verifySession, for changes to how the account signs in: a full (not guest) session
 * authenticated within the re-authentication window, as the account API requires.
 */
async function verifyRecentSession(
  c: Context<{ Bindings: Env }>
): Promise<AccountSession | Response> {
  const session = await verifySession(c);
  if (session instanceof Response) return session;
  if (session.isGuestSession) return c.json({ error: 'guest_registration_required' }, 403);
  if (!isAccountReauthFresh(session.authTime)) return c.json(ACCOUNT_REAUTH_REQUIRED_ERROR, 403);
  return session;
}

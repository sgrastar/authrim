/**
 * CIBA Pending Requests API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Lists pending CIBA authentication requests for a user
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getClient,
  createAuthContextFromHono,
  buildDOInstanceName,
  isMockAuthEnabled,
} from '@authrim/ar-lib-core';
import { resolveAsyncTenantId } from './tenant';
import {
  cibaLoginHintMatchesAuthenticatedUser,
  cibaRequestMatchesAuthenticatedUser,
  getAuthenticatedAsyncUser,
} from './authenticated-session';

/**
 * GET /api/ciba/pending
 * List the pending CIBA requests addressed to the signed-in user
 *
 * Query parameters:
 *   - login_hint: email, phone, sub, or username (optional)
 *   - user_id: user identifier (optional, from session in production)
 *
 * Response:
 *   {
 *     "requests": [
 *       {
 *         "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
 *         "client_id": "client123",
 *         "client_name": "Banking App",
 *         "client_logo_uri": "https://...",
 *         "scope": "openid profile email",
 *         "binding_message": "Sign in to Banking App",
 *         "user_code": "ABCD-1234",
 *         "created_at": 1770000000000,   // epoch milliseconds
 *         "expires_at": 1770000300000,   // epoch milliseconds
 *         "status": "pending"
 *       }
 *     ]
 *   }
 */
export async function cibaPendingHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CIBA');
  const tenantId = resolveAsyncTenantId(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant context' },
    });
  }
  const internalHeaders = {
    'Content-Type': 'application/json',
    'X-Authrim-Tenant-Id': tenantId,
  };
  try {
    const loginHint = c.req.query('login_hint');
    const userId = c.req.query('user_id');
    const authenticatedUser = await getAuthenticatedAsyncUser(c, tenantId);
    const mockAuthEnabled = await isMockAuthEnabled(c.env);
    if (!authenticatedUser && !mockAuthEnabled) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    if (
      authenticatedUser &&
      ((loginHint && !cibaLoginHintMatchesAuthenticatedUser(loginHint, authenticatedUser)) ||
        (userId && userId !== authenticatedUser.userId && userId !== authenticatedUser.sub))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // The requests are found by the identifiers of the signed-in user, never by request
    // parameters, so nobody can list requests addressed to someone else. (Only a deployment with
    // mock authentication, never production, falls back to the query parameters.)
    const subjectIds = authenticatedUser
      ? [authenticatedUser.userId, authenticatedUser.sub]
      : userId
        ? [userId]
        : [];
    const loginHints = authenticatedUser
      ? [
          `sub:${authenticatedUser.sub}`,
          authenticatedUser.sub,
          authenticatedUser.userId,
          ...(authenticatedUser.email ? [authenticatedUser.email] : []),
        ]
      : [...(loginHint ? [loginHint] : []), ...(userId ? [`sub:${userId}`] : [])];
    if (subjectIds.length === 0 && loginHints.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'login_hint or user_id' },
      });
    }

    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName(
      buildDOInstanceName('ciba', tenantId)
    );
    const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

    const listResponse = await cibaRequestStore.fetch(
      new Request('https://internal/list-pending-for-user', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({
          subject_ids: [...new Set(subjectIds)],
          login_hints: [...new Set(loginHints)],
        }),
      })
    );

    if (listResponse.status === 503) {
      // The store could not bring its index up to date: say "try again", never a partial list.
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Pending requests are temporarily unavailable. Try again.',
        },
        503
      );
    }
    if (!listResponse.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const { requests: stored } = (await listResponse.json()) as {
      requests?: CIBARequestMetadata[];
    };
    // The same ownership rule the approval applies, so the list never shows a request the user
    // could not approve.
    const pending = (stored ?? []).filter(
      (metadata) =>
        metadata.status === 'pending' &&
        (!authenticatedUser || cibaRequestMatchesAuthenticatedUser(metadata, authenticatedUser))
    );

    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const requests = await Promise.all(
      pending.map(async (metadata) => {
        // Enrich with client metadata from KV cache (with D1 fallback)
        const client = await getClient(c.env, tenantId, metadata.client_id, coreAdapter);
        return {
          auth_req_id: metadata.auth_req_id,
          client_id: metadata.client_id,
          client_name: client?.client_name || metadata.client_id,
          client_logo_uri: client?.logo_uri || null,
          scope: metadata.scope,
          binding_message: metadata.binding_message || null,
          user_code: metadata.user_code || null,
          created_at: metadata.created_at,
          expires_at: metadata.expires_at,
          status: metadata.status,
        };
      })
    );

    return c.json({ requests });
  } catch (error) {
    log.error('CIBA pending requests API error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

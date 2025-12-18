/**
 * CIBA Pending Requests API Handler
 * OpenID Connect CIBA Core 1.0
 *
 * Lists pending CIBA authentication requests for a user
 */

import type { Context } from 'hono';
import type { Env, CIBARequestMetadata } from '@authrim/shared';
import { parseLoginHint, D1Adapter, type DatabaseAdapter } from '@authrim/shared';

/**
 * GET /api/ciba/pending
 * List pending CIBA requests for a user
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
 *         "created_at": 1234567890,
 *         "expires_at": 1234568190,
 *         "status": "pending"
 *       }
 *     ]
 *   }
 */
export async function cibaPendingHandler(c: Context<{ Bindings: Env }>) {
  try {
    // TODO: In production, get user_id from session
    const loginHint = c.req.query('login_hint');
    const userId = c.req.query('user_id');

    if (!loginHint && !userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Either login_hint or user_id is required',
        },
        400
      );
    }

    // Get CIBA request metadata from CIBARequestStore
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName('global');
    const cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);

    // Use login_hint if provided, otherwise fall back to user_id
    let getResponse: Response;
    if (loginHint) {
      getResponse = await cibaRequestStore.fetch(
        new Request('https://internal/get-by-login-hint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login_hint: loginHint }),
        })
      );
    } else {
      // If only user_id is provided, construct a query for all requests
      // For now, use login_hint endpoint with user_id as sub
      getResponse = await cibaRequestStore.fetch(
        new Request('https://internal/get-by-login-hint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login_hint: `sub:${userId}` }),
        })
      );
    }

    if (!getResponse.ok) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to retrieve CIBA requests',
        },
        500
      );
    }

    const metadata: CIBARequestMetadata | null = await getResponse.json();

    // If no pending requests found, return empty array
    if (!metadata) {
      return c.json({
        requests: [],
      });
    }

    // Filter only pending requests (the DO should already do this, but double-check)
    if (metadata.status !== 'pending') {
      return c.json({
        requests: [],
      });
    }

    // Enrich with client metadata from database
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const client = await coreAdapter.queryOne<{
      client_id: string;
      client_name: string | null;
      logo_uri: string | null;
    }>('SELECT client_id, client_name, logo_uri FROM oauth_clients WHERE client_id = ?', [
      metadata.client_id,
    ]);

    const request = {
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

    return c.json({
      requests: [request],
    });
  } catch (error) {
    console.error('CIBA pending requests API error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

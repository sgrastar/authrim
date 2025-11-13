/**
 * OAuth Consent Screen Handler
 * Handles OAuth2/OIDC consent screen data retrieval and approval
 */

import { Context } from 'hono';
import type { Env } from '@enrai/shared';

// Scope descriptions (human-readable)
const SCOPE_DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  openid: {
    title: 'Identity',
    description: 'Access your basic profile information',
  },
  profile: {
    title: 'Profile',
    description: 'Access your full profile (name, picture, etc.)',
  },
  email: {
    title: 'Email',
    description: 'Access your email address',
  },
  phone: {
    title: 'Phone',
    description: 'Access your phone number',
  },
  address: {
    title: 'Address',
    description: 'Access your physical address',
  },
  offline_access: {
    title: 'Offline Access',
    description: 'Maintain access when you are offline',
  },
};

/**
 * Get consent screen data
 * GET /auth/consent
 */
export async function consentGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get session ID from query or cookie
    const sessionId = c.req.query('session_id') || c.req.header('cookie')?.match(/session_id=([^;]+)/)?.[1];

    if (!sessionId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Session ID is required',
        },
        400
      );
    }

    // Retrieve authorization request from session
    const sessionStoreId = c.env.SESSION_STORE.idFromName(sessionId);
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request(`https://session-store/get?sessionId=${sessionId}`)
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          error: 'invalid_session',
          error_description: 'Session not found or expired',
        },
        400
      );
    }

    const sessionData = await sessionResponse.json<{
      userId: string;
      email: string;
      name?: string;
      authRequest?: {
        client_id: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        response_type: string;
      };
    }>();

    if (!sessionData.authRequest) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No pending authorization request',
        },
        400
      );
    }

    const { authRequest, userId, email, name } = sessionData;
    const { client_id, scope, redirect_uri } = authRequest;

    // Load client metadata from D1
    const client = await c.env.DB.prepare(
      'SELECT client_id, client_name, logo_uri, client_uri, policy_uri, tos_uri FROM oauth_clients WHERE client_id = ?'
    )
      .bind(client_id)
      .first();

    if (!client) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client not found',
        },
        400
      );
    }

    // Parse scopes and convert to human-readable format
    const requestedScopes = scope.split(' ').filter((s) => s.length > 0);
    const scopeDetails = requestedScopes.map((scopeName) => {
      const scopeInfo = SCOPE_DESCRIPTIONS[scopeName];
      return {
        name: scopeName,
        title: scopeInfo?.title || scopeName,
        description: scopeInfo?.description || `Access ${scopeName} data`,
        required: scopeName === 'openid', // openid is always required
      };
    });

    return c.json({
      client: {
        client_id: client.client_id,
        client_name: client.client_name,
        logo_uri: client.logo_uri,
        client_uri: client.client_uri,
        policy_uri: client.policy_uri,
        tos_uri: client.tos_uri,
      },
      scopes: scopeDetails,
      user: {
        id: userId,
        email,
        name,
      },
      redirect_uri,
    });
  } catch (error) {
    console.error('Consent get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve consent data',
      },
      500
    );
  }
}

/**
 * Handle consent approval/denial
 * POST /auth/consent
 */
export async function consentPostHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      session_id: string;
      approved: boolean;
      scopes?: string[];
    }>();

    const { session_id, approved, scopes } = body;

    if (!session_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Session ID is required',
        },
        400
      );
    }

    // Retrieve authorization request from session
    const sessionStoreId = c.env.SESSION_STORE.idFromName(session_id);
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request(`https://session-store/get?sessionId=${session_id}`)
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          error: 'invalid_session',
          error_description: 'Session not found or expired',
        },
        400
      );
    }

    const sessionData = await sessionResponse.json<{
      userId: string;
      email: string;
      name?: string;
      authRequest?: {
        client_id: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        response_type: string;
      };
    }>();

    if (!sessionData.authRequest) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No pending authorization request',
        },
        400
      );
    }

    const { authRequest, userId } = sessionData;

    // If denied, redirect with error
    if (!approved) {
      const redirectUrl = new URL(authRequest.redirect_uri);
      redirectUrl.searchParams.set('error', 'access_denied');
      redirectUrl.searchParams.set('error_description', 'User denied the consent request');
      if (authRequest.state) {
        redirectUrl.searchParams.set('state', authRequest.state);
      }

      return c.json({
        approved: false,
        redirect_uri: redirectUrl.toString(),
      });
    }

    // Generate authorization code
    const code = crypto.randomUUID();
    const now = Date.now();
    const codeExpiresAt = now + 600_000; // 10 minutes

    // Determine granted scopes (use provided scopes or all requested scopes)
    const grantedScopes = scopes?.join(' ') || authRequest.scope;

    // Store authorization code in AuthorizationCodeStore Durable Object
    const codeStoreId = c.env.AUTH_CODE_STORE.idFromName(code);
    const codeStore = c.env.AUTH_CODE_STORE.get(codeStoreId);

    await codeStore.fetch(
      new Request(`https://auth-code-store/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: authRequest.client_id,
          redirect_uri: authRequest.redirect_uri,
          scope: grantedScopes,
          nonce: authRequest.nonce,
          userId,
          expiresAt: codeExpiresAt,
        }),
      })
    );

    // Build redirect URL with authorization code
    const redirectUrl = new URL(authRequest.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (authRequest.state) {
      redirectUrl.searchParams.set('state', authRequest.state);
    }

    // Clear auth request from session
    await sessionStore.fetch(
      new Request(`https://session-store/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session_id,
          authRequest: null,
        }),
      })
    );

    return c.json({
      approved: true,
      redirect_uri: redirectUrl.toString(),
      code,
    });
  } catch (error) {
    console.error('Consent post error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process consent',
      },
      500
    );
  }
}

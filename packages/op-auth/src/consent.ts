/**
 * OAuth Consent Screen Handler
 * Handles OAuth2/OIDC consent screen display and approval/denial
 *
 * Flow:
 * 1. GET /auth/consent?challenge_id=xxx - Show consent screen
 * 2. POST /auth/consent with { challenge_id, approved } - Process consent
 */

import { Context } from 'hono';
import type { Env } from '@authrim/shared';

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
 * Get consent screen data and show consent UI
 * GET /auth/consent?challenge_id=xxx
 */
export async function consentGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const challenge_id = c.req.query('challenge_id');

    if (!challenge_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        },
        400
      );
    }

    // Retrieve consent challenge from ChallengeStore
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    const challengeResponse = await challengeStore.fetch(
      new Request(`https://challenge-store/challenge/${challenge_id}`, {
        method: 'GET',
      })
    );

    if (!challengeResponse.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }

    const challengeData = (await challengeResponse.json()) as {
      id: string;
      type: string;
      userId: string;
      metadata?: {
        client_id?: string;
        scope?: string;
        [key: string]: unknown;
      };
    };

    if (challengeData.type !== 'consent') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid challenge type',
        },
        400
      );
    }

    const metadata = challengeData.metadata || {};
    const client_id = metadata.client_id as string;
    const scope = metadata.scope as string;

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

    // Render simple consent screen (HTML stub)
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Consent Required</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 500px;
      width: 100%;
    }
    h1 {
      margin: 0 0 0.5rem 0;
      font-size: 1.5rem;
      color: #333;
    }
    .client-name {
      margin: 0 0 1.5rem 0;
      color: #667eea;
      font-weight: 600;
    }
    p {
      margin: 0 0 1.5rem 0;
      color: #666;
      line-height: 1.5;
    }
    .scopes {
      list-style: none;
      padding: 0;
      margin: 0 0 1.5rem 0;
    }
    .scope-item {
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      background: #f5f5f5;
      border-radius: 4px;
    }
    .scope-title {
      font-weight: 600;
      color: #333;
    }
    .scope-desc {
      font-size: 0.875rem;
      color: #666;
      margin-top: 0.25rem;
    }
    .button-group {
      display: flex;
      gap: 1rem;
    }
    button {
      flex: 1;
      padding: 0.75rem;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .approve {
      background: #667eea;
      color: white;
    }
    .approve:hover {
      background: #5568d3;
    }
    .deny {
      background: #e0e0e0;
      color: #333;
    }
    .deny:hover {
      background: #d0d0d0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Consent Required</h1>
    <p class="client-name">${client.client_name || client_id}</p>
    <p>This application is requesting access to:</p>
    <ul class="scopes">
      ${scopeDetails
        .map(
          (s) => `
        <li class="scope-item">
          <div class="scope-title">${s.title}</div>
          <div class="scope-desc">${s.description}</div>
        </li>
      `
        )
        .join('')}
    </ul>
    <div class="button-group">
      <form method="POST" action="/auth/consent" style="flex: 1;">
        <input type="hidden" name="challenge_id" value="${challenge_id}">
        <input type="hidden" name="approved" value="false">
        <button type="submit" class="deny">Deny</button>
      </form>
      <form method="POST" action="/auth/consent" style="flex: 1;">
        <input type="hidden" name="challenge_id" value="${challenge_id}">
        <input type="hidden" name="approved" value="true">
        <button type="submit" class="approve">Approve</button>
      </form>
    </div>
  </div>
</body>
</html>`);
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
    // Parse form data
    const body = await c.req.parseBody();
    const challenge_id = typeof body.challenge_id === 'string' ? body.challenge_id : undefined;
    const approved = body.approved === 'true';

    if (!challenge_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        },
        400
      );
    }

    // Consume consent challenge from ChallengeStore
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    const consumeResponse = await challengeStore.fetch(
      new Request('https://challenge-store/challenge/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: challenge_id,
          type: 'consent',
          challenge: challenge_id,
        }),
      })
    );

    if (!consumeResponse.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }

    const challengeData = (await consumeResponse.json()) as {
      userId: string;
      metadata?: {
        response_type?: string;
        client_id?: string;
        redirect_uri?: string;
        scope?: string;
        state?: string;
        nonce?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        claims?: string;
        response_mode?: string;
        [key: string]: unknown;
      };
    };

    const metadata = challengeData.metadata || {};
    const userId = challengeData.userId;

    // If denied, redirect with error
    if (!approved) {
      const redirectUri = metadata.redirect_uri as string;
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('error', 'access_denied');
      redirectUrl.searchParams.set('error_description', 'User denied the consent request');
      if (metadata.state) {
        redirectUrl.searchParams.set('state', metadata.state as string);
      }

      return c.redirect(redirectUrl.toString(), 302);
    }

    // Save consent to D1
    const scope = metadata.scope as string;
    const client_id = metadata.client_id as string;
    const consentId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = null; // No expiration (permanent consent)

    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO oauth_client_consents
       (id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(consentId, userId, client_id, scope, now, expiresAt)
      .run();

    console.log(`Consent granted: user=${userId}, client=${client_id}, scope=${scope}`);

    // Build query string for internal redirect to /authorize
    const params = new URLSearchParams();
    if (metadata.response_type) params.set('response_type', metadata.response_type as string);
    if (metadata.client_id) params.set('client_id', metadata.client_id as string);
    if (metadata.redirect_uri) params.set('redirect_uri', metadata.redirect_uri as string);
    if (metadata.scope) params.set('scope', metadata.scope as string);
    if (metadata.state) params.set('state', metadata.state as string);
    if (metadata.nonce) params.set('nonce', metadata.nonce as string);
    if (metadata.code_challenge) params.set('code_challenge', metadata.code_challenge as string);
    if (metadata.code_challenge_method)
      params.set('code_challenge_method', metadata.code_challenge_method as string);
    if (metadata.claims) params.set('claims', metadata.claims as string);
    if (metadata.response_mode) params.set('response_mode', metadata.response_mode as string);
    if (metadata.max_age) params.set('max_age', metadata.max_age as string);
    if (metadata.prompt) params.set('prompt', metadata.prompt as string);
    if (metadata.acr_values) params.set('acr_values', metadata.acr_values as string);

    // Add flag to indicate consent is confirmed
    params.set('_consent_confirmed', 'true');

    // Redirect to /authorize with original parameters
    const redirectUrl = `/authorize?${params.toString()}`;
    return c.redirect(redirectUrl, 302);
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

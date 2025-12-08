/**
 * External IdP Callback Handler
 * GET /auth/external/:provider/callback - Handle OAuth callback
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { getSessionStoreForNewSession } from '@authrim/shared';
import { getProvider } from '../services/provider-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { consumeAuthState } from '../utils/state';
import { handleIdentity } from '../services/identity-stitching';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';

/**
 * Handle OAuth callback from external IdP
 *
 * Query Parameters:
 * - code: Authorization code from provider
 * - state: State parameter for CSRF validation
 * - error: Error code (if authorization failed)
 * - error_description: Error description
 */
export async function handleExternalCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const providerId = c.req.param('provider');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');

  // Handle provider errors
  if (error) {
    console.error('Provider error:', error, errorDescription);
    return redirectWithError(c, error, errorDescription);
  }

  if (!code || !state) {
    return redirectWithError(c, 'invalid_request', 'Missing code or state');
  }

  try {
    // 1. Validate state and get stored data
    const authState = await consumeAuthState(c.env, state);
    if (!authState) {
      return redirectWithError(c, 'invalid_state', 'State validation failed or expired');
    }

    if (authState.providerId !== providerId) {
      return redirectWithError(c, 'invalid_state', 'Provider mismatch');
    }

    // 2. Get provider configuration
    const provider = await getProvider(c.env, providerId);
    if (!provider) {
      return redirectWithError(c, 'unknown_provider', 'Provider not found');
    }

    // 3. Decrypt client secret
    const clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);

    // 4. Build callback URL (same as in start)
    const callbackUri = `${c.env.ISSUER_URL}/auth/external/${provider.id}/callback`;

    // 5. Exchange code for tokens
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret);
    const tokens = await client.handleCallback(code, authState.codeVerifier || '');

    // 6. Validate ID token or fetch user info
    let userInfo;
    if (provider.providerType === 'oidc' && tokens.id_token && authState.nonce) {
      userInfo = await client.validateIdToken(tokens.id_token, authState.nonce);
    } else {
      userInfo = await client.fetchUserInfo(tokens.access_token);
    }

    // 7. Handle identity stitching or account creation
    const result = await handleIdentity(c.env, {
      provider,
      userInfo,
      tokens,
      linkingUserId: authState.userId,
      tenantId: authState.tenantId,
    });

    // 8. Create Authrim session
    const sessionId = await createSession(c.env, result.userId);

    // 9. Build redirect URL with success
    const redirectUrl = new URL(authState.redirectUri);

    // Add success indicator
    if (result.isNewUser) {
      redirectUrl.searchParams.set('external_auth', 'registered');
    } else if (result.stitchedFromExisting) {
      redirectUrl.searchParams.set('external_auth', 'linked');
    } else {
      redirectUrl.searchParams.set('external_auth', 'success');
    }

    // 10. Return redirect with session cookie
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl.toString(),
        'Set-Cookie': buildSessionCookie(sessionId, c.env.ISSUER_URL),
      },
    });
  } catch (error) {
    console.error('Callback error:', error);

    if (error instanceof Error) {
      if (error.message === 'no_account_found') {
        return redirectWithError(
          c,
          'account_required',
          'No account found. Please register first or enable JIT provisioning.'
        );
      }
      return redirectWithError(c, 'callback_failed', error.message);
    }

    return redirectWithError(c, 'internal_error', 'Callback processing failed');
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Redirect with error parameters
 */
function redirectWithError(
  c: Context<{ Bindings: Env }>,
  error: string,
  description?: string
): Response {
  const baseUrl = c.env.UI_BASE_URL || c.env.ISSUER_URL;
  const redirectUrl = new URL('/login', baseUrl);
  redirectUrl.searchParams.set('error', error);
  if (description) {
    redirectUrl.searchParams.set('error_description', description);
  }

  return c.redirect(redirectUrl.toString());
}

/**
 * Create Authrim session (sharded)
 */
async function createSession(env: Env, userId: string): Promise<string> {
  try {
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(env);

    const response = await sessionStore.fetch(
      new Request('https://session-store/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId,
          ttl: 3600, // 1 hour in seconds
          data: {
            amr: ['external_idp'],
            acr: 'urn:mace:incommon:iap:bronze',
          },
        }),
      })
    );

    if (!response.ok) {
      throw new Error('Session creation failed');
    }

    return sessionId;
  } catch (error) {
    console.error('Failed to create session:', error);
    throw new Error('session_creation_failed');
  }
}

/**
 * Build session cookie
 */
function buildSessionCookie(sessionId: string, issuerUrl: string): string {
  const domain = new URL(issuerUrl).hostname;
  const isSecure = issuerUrl.startsWith('https://');

  const parts = [
    `authrim_session=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=3600', // 1 hour
  ];

  if (isSecure) {
    parts.push('Secure');
  }

  // Don't set domain for localhost
  if (!domain.includes('localhost') && !domain.includes('127.0.0.1')) {
    parts.push(`Domain=${domain}`);
  }

  return parts.join('; ');
}

/**
 * Decrypt client secret
 * Requires RP_TOKEN_ENCRYPTION_KEY to be configured
 */
async function decryptClientSecret(env: Env, encrypted: string): Promise<string> {
  const encryptionKey = getEncryptionKeyOrUndefined(env);

  if (!encryptionKey) {
    throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
  }

  return decrypt(encrypted, encryptionKey);
}

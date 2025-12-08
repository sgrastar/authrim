/**
 * External IdP Start Handler
 * GET /auth/external/:provider/start - Initiate external IdP login
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { getSessionStoreBySessionId, isShardedSessionId } from '@authrim/shared';
import { getProviderByName, getProvider } from '../services/provider-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { generatePKCE, generateState, generateNonce } from '../utils/pkce';
import { storeAuthState, getStateExpiresAt } from '../utils/state';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';

/**
 * Start external IdP login flow
 *
 * Query Parameters:
 * - redirect_uri: Where to redirect after successful login (default: UI base URL)
 * - link: "true" if linking to existing account (requires session)
 * - prompt: Optional OIDC prompt parameter
 * - login_hint: Optional email hint for provider
 */
export async function handleExternalStart(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const providerIdOrName = c.req.param('provider');
    const redirectUri = c.req.query('redirect_uri') || `${c.env.UI_BASE_URL || c.env.ISSUER_URL}/`;
    const isLinking = c.req.query('link') === 'true';
    const prompt = c.req.query('prompt');
    const loginHint = c.req.query('login_hint');
    const tenantId = c.req.query('tenant_id') || 'default';

    // 1. Get provider configuration (by ID or name)
    let provider = await getProvider(c.env, providerIdOrName);
    if (!provider) {
      provider = await getProviderByName(c.env, providerIdOrName, tenantId);
    }

    if (!provider || !provider.enabled) {
      return c.json(
        {
          error: 'unknown_provider',
          error_description: `Provider "${providerIdOrName}" not found or disabled`,
        },
        404
      );
    }

    // 2. If linking, verify session
    let userId: string | undefined;
    let sessionId: string | undefined;

    if (isLinking) {
      // Try to get session from cookie or Authorization header
      const session = await verifySession(c);
      if (!session) {
        return c.json(
          {
            error: 'unauthorized',
            error_description: 'Session required for linking',
          },
          401
        );
      }
      userId = session.userId;
      sessionId = session.id;
    }

    // 3. Generate PKCE, state, nonce
    const { codeVerifier } = await generatePKCE();
    const state = generateState();
    const nonce = generateNonce();

    // 4. Decrypt client secret
    const clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);

    // 5. Build callback URL
    const callbackUri = `${c.env.ISSUER_URL}/auth/external/${provider.id}/callback`;

    // 6. Store state in D1
    await storeAuthState(c.env, {
      tenantId,
      providerId: provider.id,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      userId,
      sessionId,
      expiresAt: getStateExpiresAt(),
    });

    // 7. Create OIDC client and generate authorization URL
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret);
    const authUrl = await client.createAuthorizationUrl({
      state,
      nonce,
      codeVerifier,
      prompt,
      loginHint,
    });

    // 8. Redirect to provider
    return c.redirect(authUrl);
  } catch (error) {
    console.error('External start error:', error);
    return c.json(
      {
        error: 'internal_error',
        error_description: 'Failed to start external login',
      },
      500
    );
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

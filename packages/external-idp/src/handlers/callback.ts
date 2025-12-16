/**
 * External IdP Callback Handler
 * GET /auth/external/:provider/callback - Handle OAuth callback
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { getSessionStoreForNewSession } from '@authrim/shared';
import { getProviderByIdOrSlug } from '../services/provider-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { consumeAuthState } from '../utils/state';
import { handleIdentity } from '../services/identity-stitching';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';
import {
  ExternalIdPError,
  ExternalIdPErrorCode,
  type UserInfo,
  type UpstreamProvider,
} from '../types';
import {
  GITHUB_USER_EMAILS_ENDPOINT,
  type GitHubEmail,
  type GitHubProviderQuirks,
} from '../providers/github';

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
  const providerIdOrSlug = c.req.param('provider');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');
  const tenantId = c.req.query('tenant_id') || 'default';

  // Handle provider errors
  if (error) {
    console.error('Provider error:', error, errorDescription);
    return redirectWithError(c, error, errorDescription);
  }

  if (!code || !state) {
    return redirectWithError(c, 'invalid_request', 'Missing code or state');
  }

  try {
    // 1. Get provider configuration first (by slug or ID)
    const provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
    if (!provider) {
      return redirectWithError(c, 'unknown_provider', 'Provider not found');
    }

    // 2. Validate state and get stored data
    const authState = await consumeAuthState(c.env, state);
    if (!authState) {
      return redirectWithError(c, 'invalid_state', 'State validation failed or expired');
    }

    // Verify the provider ID matches (authState always stores the actual ID)
    if (authState.providerId !== provider.id) {
      return redirectWithError(c, 'invalid_state', 'Provider mismatch');
    }

    // 3. Decrypt client secret
    const clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);

    // 4. Build callback URL (use slug if available, same as in start)
    const providerIdentifier = provider.slug || provider.id;
    const callbackUri = `${c.env.ISSUER_URL}/auth/external/${providerIdentifier}/callback`;

    // 5. Exchange code for tokens
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret);
    const tokens = await client.handleCallback(code, authState.codeVerifier || '');

    // 6. Validate ID token or fetch user info
    let userInfo;
    if (provider.providerType === 'oidc' && tokens.id_token && authState.nonce) {
      // Use the new options-based signature for comprehensive OIDC validation
      userInfo = await client.validateIdToken(tokens.id_token, {
        nonce: authState.nonce,
        accessToken: tokens.access_token, // For at_hash validation if present
        maxAge: authState.maxAge, // For auth_time validation if max_age was requested
        acrValues: authState.acrValues, // For acr validation if acr_values was requested
      });
    } else {
      userInfo = await client.fetchUserInfo(tokens.access_token);
    }

    // 6.3. GitHub-specific: Fetch primary email from /user/emails if needed
    // GitHub's /user endpoint may not return email if it's set to private
    if (isGitHubProvider(provider) && !userInfo.email) {
      const quirks = provider.providerQuirks as GitHubProviderQuirks | undefined;
      const fetchPrimaryEmail = quirks?.fetchPrimaryEmail !== false; // Default: true

      if (fetchPrimaryEmail) {
        const emailInfo = await fetchGitHubPrimaryEmail(
          tokens.access_token,
          quirks?.allowUnverifiedEmail || false
        );
        if (emailInfo) {
          userInfo.email = emailInfo.email;
          userInfo.email_verified = emailInfo.verified;
        }
      }
    }

    // 6.5. Normalize userinfo using attributeMapping (important for OAuth2 providers)
    // OAuth2 providers like GitHub may use different claim names (e.g., "id" instead of "sub")
    userInfo = normalizeUserInfo(userInfo, provider.attributeMapping);

    // Ensure sub is present (required for identity linking)
    if (!userInfo.sub) {
      return redirectWithError(
        c,
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'Provider did not return a user identifier. Check attributeMapping configuration.'
      );
    }

    // 7. Handle identity stitching or account creation
    const result = await handleIdentity(c.env, {
      provider,
      userInfo,
      tokens,
      linkingUserId: authState.userId,
      tenantId: authState.tenantId,
    });

    // 8. Create Authrim session with external provider info for backchannel logout
    const sessionId = await createSession(c.env, {
      userId: result.userId,
      externalProviderId: provider.id,
      externalProviderSub: userInfo.sub,
      acr: userInfo.acr, // Pass ACR if provider returned it
    });

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

    // Handle specific ExternalIdPError with appropriate error codes
    if (error instanceof ExternalIdPError) {
      return redirectWithError(c, error.code, error.message);
    }

    // Handle generic errors
    if (error instanceof Error) {
      // Check for specific OIDC validation errors
      if (error.message.includes('acr')) {
        // ACR validation failed - the authentication level doesn't meet requirements
        return redirectWithError(
          c,
          ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED,
          'The authentication level does not meet the required security level. Please try again with a stronger authentication method.'
        );
      }

      // Log for debugging but return a generic message
      console.error('Unexpected error in callback:', error.stack);
      return redirectWithError(
        c,
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'An error occurred during authentication. Please try again.'
      );
    }

    return redirectWithError(
      c,
      ExternalIdPErrorCode.CALLBACK_FAILED,
      'Authentication failed. Please try again.'
    );
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
 * Session creation options for external IdP authentication
 */
interface CreateSessionOptions {
  userId: string;
  /** External provider ID used for authentication */
  externalProviderId: string;
  /** Subject ID from the external provider (for backchannel logout) */
  externalProviderSub: string;
  /** ACR value returned by the provider */
  acr?: string;
}

/**
 * Create Authrim session (sharded)
 * Stores external provider information for backchannel logout support
 */
async function createSession(env: Env, options: CreateSessionOptions): Promise<string> {
  try {
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(env);
    const now = Date.now();
    const ttl = 3600; // 1 hour in seconds
    const expiresAt = now + ttl * 1000;

    // 1. Create session in Durable Object (for session data and validation)
    const response = await sessionStore.fetch(
      new Request('https://session-store/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId: options.userId,
          ttl,
          data: {
            amr: ['external_idp'],
            acr: options.acr || 'urn:mace:incommon:iap:bronze',
            // Store external provider info for backchannel logout
            external_provider_id: options.externalProviderId,
            external_provider_sub: options.externalProviderSub,
          },
        }),
      })
    );

    if (!response.ok) {
      throw new Error('Session creation failed');
    }

    // 2. Also record in D1 for backchannel logout queries
    // This allows us to find sessions by (provider_id, provider_sub)
    try {
      await env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at, created_at, external_provider_id, external_provider_sub)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          sessionId,
          options.userId,
          expiresAt,
          now,
          options.externalProviderId,
          options.externalProviderSub
        )
        .run();
    } catch (dbError) {
      // Log but don't fail session creation if D1 insert fails
      // Session is still valid in DO, just backchannel logout may not work
      console.warn('Failed to record session in D1 for backchannel logout:', dbError);
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

/**
 * Normalize userinfo using provider's attributeMapping
 *
 * This is critical for OAuth2 providers that don't follow OIDC conventions:
 * - GitHub uses "id" (number) instead of "sub" (string)
 * - Twitter uses "data.id" (nested)
 * - Facebook uses "id" instead of "sub"
 *
 * The attributeMapping allows mapping provider-specific claims to standard OIDC claims.
 *
 * Example attributeMapping for GitHub:
 * {
 *   "sub": "id",
 *   "name": "name",
 *   "email": "email",
 *   "picture": "avatar_url"
 * }
 *
 * @param userInfo - Raw userinfo from provider
 * @param attributeMapping - Mapping from OIDC claim names to provider claim names
 * @returns Normalized userinfo with standard claim names
 */
function normalizeUserInfo(userInfo: UserInfo, attributeMapping: Record<string, string>): UserInfo {
  // If no mapping provided, return as-is (assume OIDC-compliant provider)
  if (!attributeMapping || Object.keys(attributeMapping).length === 0) {
    return userInfo;
  }

  const normalized: UserInfo = { ...userInfo };

  // Apply attribute mapping
  for (const [targetClaim, sourcePath] of Object.entries(attributeMapping)) {
    const value = getNestedValue(userInfo, sourcePath);
    if (value !== undefined) {
      // Convert numbers to strings for sub (required for OIDC compatibility)
      if (targetClaim === 'sub' && typeof value === 'number') {
        (normalized as Record<string, unknown>)[targetClaim] = String(value);
      } else {
        (normalized as Record<string, unknown>)[targetClaim] = value;
      }
    }
  }

  return normalized;
}

/**
 * Get a nested value from an object using dot notation
 * e.g., getNestedValue(obj, "data.user.id") returns obj.data.user.id
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// =============================================================================
// GitHub-specific helpers
// =============================================================================

/**
 * Check if a provider is GitHub (by checking endpoints or name)
 */
function isGitHubProvider(provider: UpstreamProvider): boolean {
  // Check by userinfo endpoint
  if (
    provider.userinfoEndpoint?.includes('api.github.com') ||
    provider.userinfoEndpoint?.includes('/api/v3/user')
  ) {
    return true;
  }
  // Check by authorization endpoint
  if (provider.authorizationEndpoint?.includes('github.com/login/oauth')) {
    return true;
  }
  // Check by name (case insensitive)
  if (provider.name.toLowerCase().includes('github')) {
    return true;
  }
  return false;
}

/**
 * Fetch primary verified email from GitHub /user/emails API
 *
 * GitHub's /user endpoint may not return email if:
 * - User has set their email to private
 * - User has no public email
 *
 * The /user/emails endpoint returns all user emails with verification status.
 * Requires `user:email` scope.
 *
 * @param accessToken - GitHub access token
 * @param allowUnverified - Whether to accept unverified emails (not recommended)
 * @returns Primary email info or null if not found
 */
async function fetchGitHubPrimaryEmail(
  accessToken: string,
  allowUnverified: boolean = false
): Promise<{ email: string; verified: boolean } | null> {
  try {
    const response = await fetch(GITHUB_USER_EMAILS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      console.warn(`GitHub /user/emails failed: ${response.status}`);
      return null;
    }

    const emails: GitHubEmail[] = await response.json();

    // Find primary email
    const primaryEmail = emails.find((e) => e.primary);

    if (!primaryEmail) {
      console.warn('GitHub: No primary email found');
      return null;
    }

    // Check if email is verified (security requirement)
    if (!primaryEmail.verified && !allowUnverified) {
      console.warn('GitHub: Primary email is not verified');
      return null;
    }

    return {
      email: primaryEmail.email,
      verified: primaryEmail.verified,
    };
  } catch (error) {
    console.error('Failed to fetch GitHub emails:', error);
    return null;
  }
}

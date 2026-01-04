/**
 * External IdP Callback Handler
 * GET/POST /auth/external/:provider/callback - Handle OAuth callback
 *
 * Most OAuth providers use GET with query parameters.
 * Apple Sign In uses POST with response_mode=form_post when name/email scope is requested.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  type DatabaseAdapter,
  getSessionStoreForNewSession,
  getUIConfig,
  buildIssuerUrl,
  shouldUseBuiltinForms,
  getTenantIdFromContext,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Logger
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';
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
import { type FacebookProviderQuirks, generateAppSecretProof } from '../providers/facebook';
import { type TwitterProviderQuirks } from '../providers/twitter';
import { isAppleProvider, type AppleProviderQuirks } from '../providers/apple';
import { generateAppleClientSecret, parseAppleUserData } from '../utils/apple-jwt';

/**
 * Extract callback parameters from GET query string or POST form body
 * Apple Sign In uses POST with form_post response mode
 */
async function getCallbackParams(c: Context<{ Bindings: Env }>): Promise<{
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
  errorDescription: string | undefined;
  tenantId: string;
  user: string | undefined; // Apple-specific: user data JSON
}> {
  // Try GET parameters first (standard OAuth)
  let code = c.req.query('code');
  let state = c.req.query('state');
  let error = c.req.query('error');
  let errorDescription = c.req.query('error_description');
  let tenantId = c.req.query('tenant_id') || 'default';
  let user = c.req.query('user');

  // If POST request (Apple form_post), try to get from body
  if (c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      // POST body takes precedence over query params for OAuth response
      code = (body.code as string) || code;
      state = (body.state as string) || state;
      error = (body.error as string) || error;
      errorDescription = (body.error_description as string) || errorDescription;
      // Apple-specific: user data is only in POST body
      user = (body.user as string) || user;
      // id_token may also be in body for Apple
    } catch {
      // Body parsing failed, fall back to query params
    }
  }

  return { code, state, error, errorDescription, tenantId, user };
}

/**
 * Handle OAuth callback from external IdP
 *
 * Query/Body Parameters:
 * - code: Authorization code from provider
 * - state: State parameter for CSRF validation
 * - error: Error code (if authorization failed)
 * - error_description: Error description
 * - user: (Apple only) JSON with user name, only on first authorization
 */
export async function handleExternalCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('CALLBACK');
  const providerIdOrSlug = c.req.param('provider');
  const { code, state, error, errorDescription, tenantId, user } = await getCallbackParams(c);

  // Handle provider errors
  if (error) {
    // PII Protection: Do not log errorDescription (may contain user info from provider)
    log.error('External IdP returned error', { error });
    return redirectWithError(c, error, errorDescription);
  }

  if (!code || !state) {
    return redirectWithError(c, 'invalid_request', 'Missing code or state');
  }

  // Declare provider outside try block so it's accessible in catch block for event logging
  let provider: UpstreamProvider | null = null;

  try {
    // 1. Get provider configuration first (by slug or ID)
    provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
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

    // 3. Get client secret (Apple requires dynamic JWT generation)
    let clientSecret: string;
    if (isAppleProvider(provider)) {
      // Apple: Generate JWT client_secret from private key
      const quirks = provider.providerQuirks as unknown as AppleProviderQuirks;
      const encryptionKey = getEncryptionKeyOrUndefined(c.env);
      if (!encryptionKey) {
        throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
      }
      const privateKey = await decrypt(quirks.privateKeyEncrypted, encryptionKey);
      clientSecret = await generateAppleClientSecret(
        quirks.teamId,
        provider.clientId,
        quirks.keyId,
        privateKey,
        quirks.clientSecretTtl || 2592000 // Default 30 days
      );
    } else {
      // Standard: Decrypt stored client secret
      clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);
    }

    // 4. Build callback URL (use slug if available, same as in start)
    const providerIdentifier = provider.slug || provider.id;
    const callbackUri = `${c.env.ISSUER_URL}/auth/external/${providerIdentifier}/callback`;

    // 5. Exchange code for tokens
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret);
    const tokens = await client.handleCallback(code, authState.codeVerifier || '');

    // 6. Validate ID token and/or fetch user info
    let userInfo;
    if (provider.providerType === 'oidc' && tokens.id_token && authState.nonce) {
      // Use the new options-based signature for comprehensive OIDC validation
      userInfo = await client.validateIdToken(tokens.id_token, {
        nonce: authState.nonce,
        accessToken: tokens.access_token, // For at_hash validation if present
        maxAge: authState.maxAge, // For auth_time validation if max_age was requested
        acrValues: authState.acrValues, // For acr validation if acr_values was requested
      });

      // Optionally fetch userinfo even when id_token is present
      // Enable this for OIDC RP certification testing or when userinfo has additional claims
      if (provider.alwaysFetchUserinfo) {
        try {
          const userinfoData = await client.fetchUserInfo(tokens.access_token);
          // Merge userinfo data (userinfo may have additional claims not in id_token)
          userInfo = { ...userInfo, ...userinfoData };
        } catch {
          // Userinfo fetch failure is not fatal - we already have claims from id_token
          log.warn('Userinfo fetch failed, using id_token claims only');
        }
      }
    } else {
      userInfo = await client.fetchUserInfo(tokens.access_token);
    }

    // 6.2. Apple-specific: Parse user data from POST body (first authorization only)
    // Apple returns name info in a JSON 'user' parameter, not in the ID token
    // Note: 'user' is extracted by getCallbackParams() from POST body for form_post mode
    if (isAppleProvider(provider)) {
      const appleUserData = parseAppleUserData(user);
      if (appleUserData) {
        // Merge Apple user data (name only provided on first auth)
        if (appleUserData.name) userInfo.name = appleUserData.name;
        if (appleUserData.given_name) userInfo.given_name = appleUserData.given_name;
        if (appleUserData.family_name) userInfo.family_name = appleUserData.family_name;
        // Note: email from ID token is more reliable than from user param
      }
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

    // 6.4. Facebook-specific: Re-fetch with app_secret_proof if enabled
    if (isFacebookProvider(provider) && provider.providerType === 'oauth2') {
      const quirks = provider.providerQuirks as FacebookProviderQuirks | undefined;
      if (quirks?.useAppSecretProof) {
        const facebookUserInfo = await fetchFacebookUserInfo(
          tokens.access_token,
          clientSecret,
          quirks
        );
        if (facebookUserInfo) {
          userInfo = { ...userInfo, ...facebookUserInfo };
        }
      }
    }

    // 6.5. Twitter-specific: Re-fetch with user.fields if configured
    if (isTwitterProvider(provider) && provider.providerType === 'oauth2') {
      const quirks = provider.providerQuirks as TwitterProviderQuirks | undefined;
      if (quirks?.userFields) {
        const twitterUserInfo = await fetchTwitterUserInfo(tokens.access_token, quirks);
        if (twitterUserInfo) {
          userInfo = { ...userInfo, ...twitterUserInfo };
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

    // 9. Publish authentication success events (non-blocking)
    publishEvent(c, {
      type: AUTH_EVENTS.EXTERNAL_IDP_SUCCEEDED,
      tenantId: authState.tenantId,
      data: {
        userId: result.userId,
        method: 'external_idp',
        clientId: provider.id,
        sessionId,
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish auth.external_idp.succeeded', {}, err as Error);
    });

    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId: authState.tenantId,
      data: {
        sessionId,
        userId: result.userId,
        ttlSeconds: 3600,
      } satisfies SessionEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish session.user.created', {}, err as Error);
    });

    // 10. Build redirect URL with success
    const redirectUrl = new URL(authState.redirectUri);

    // Add success indicator
    if (result.isNewUser) {
      redirectUrl.searchParams.set('external_auth', 'registered');
    } else if (result.stitchedFromExisting) {
      redirectUrl.searchParams.set('external_auth', 'linked');
    } else {
      redirectUrl.searchParams.set('external_auth', 'success');
    }

    // 11. Return redirect with session cookie
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl.toString(),
        'Set-Cookie': buildSessionCookie(sessionId, c.env.ISSUER_URL),
      },
    });
  } catch (error) {
    log.error('Callback error', {}, error as Error);

    // Determine error code for event
    let errorCode: string = ExternalIdPErrorCode.CALLBACK_FAILED;
    if (error instanceof ExternalIdPError) {
      errorCode = error.code;
    } else if (error instanceof Error && error.message.includes('acr')) {
      errorCode = ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED;
    }

    // Publish authentication failure event (non-blocking)
    // SECURITY: Use validated provider.id, fallback to 'invalid_provider' to prevent log injection
    publishEvent(c, {
      type: AUTH_EVENTS.EXTERNAL_IDP_FAILED,
      tenantId,
      data: {
        method: 'external_idp',
        clientId: provider?.id || 'invalid_provider',
        errorCode,
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish auth.external_idp.failed', {}, err as Error);
    });

    // Handle specific ExternalIdPError with appropriate error codes
    // SECURITY: Do not expose internal error details in redirect URL
    if (error instanceof ExternalIdPError) {
      return redirectWithError(c, error.code, 'Authentication failed. Please try again.');
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
      log.error('Unexpected error in callback', { stack: error.stack });
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
 * Uses UI config if available, falls back to issuer URL
 */
async function redirectWithError(
  c: Context<{ Bindings: Env }>,
  error: string,
  description?: string
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const uiConfig = await getUIConfig(c.env);

  let baseUrl: string;
  if (uiConfig?.baseUrl) {
    baseUrl = uiConfig.baseUrl;
  } else {
    // Fallback to issuer URL
    baseUrl = buildIssuerUrl(c.env, tenantId);
  }

  const loginPath = uiConfig?.paths?.login || '/login';
  const redirectUrl = new URL(loginPath, baseUrl);
  redirectUrl.searchParams.set('error', error);
  if (description) {
    redirectUrl.searchParams.set('error_description', description);
  }
  // Add tenant_hint for UI branding (UX only)
  if (tenantId && tenantId !== 'default') {
    redirectUrl.searchParams.set('tenant_hint', tenantId);
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
      const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
      await coreAdapter.execute(
        `INSERT INTO sessions (id, user_id, expires_at, created_at, external_provider_id, external_provider_sub)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          options.userId,
          expiresAt,
          now,
          options.externalProviderId,
          options.externalProviderSub,
        ]
      );
    } catch (dbError) {
      // Log but don't fail session creation if D1 insert fails
      // Session is still valid in DO, just backchannel logout may not work
      const log = createLogger().module('CALLBACK');
      log.warn('Failed to record session in D1 for backchannel logout');
    }

    return sessionId;
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to create session', {}, error as Error);
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
      // Security: Only log HTTP status code (safe), not response body (may contain user data)
      const log = createLogger().module('CALLBACK');
      log.warn('GitHub /user/emails failed', { status: response.status });
      return null;
    }

    const emails: GitHubEmail[] = await response.json();

    // Find primary email
    const primaryEmail = emails.find((e) => e.primary);

    if (!primaryEmail) {
      const log = createLogger().module('CALLBACK');
      log.warn('GitHub: No primary email found');
      return null;
    }

    // Check if email is verified (security requirement)
    if (!primaryEmail.verified && !allowUnverified) {
      const log = createLogger().module('CALLBACK');
      log.warn('GitHub: Primary email is not verified');
      return null;
    }

    return {
      email: primaryEmail.email,
      verified: primaryEmail.verified,
    };
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch GitHub emails', {}, error as Error);
    return null;
  }
}

// =============================================================================
// Facebook-specific helpers
// =============================================================================

/**
 * Check if a provider is Facebook
 */
function isFacebookProvider(provider: UpstreamProvider): boolean {
  // Check by authorization endpoint
  if (provider.authorizationEndpoint?.includes('facebook.com')) {
    return true;
  }
  // Check by token endpoint
  if (provider.tokenEndpoint?.includes('graph.facebook.com')) {
    return true;
  }
  // Check by name (case insensitive)
  if (provider.name.toLowerCase().includes('facebook')) {
    return true;
  }
  return false;
}

/**
 * Fetch user info from Facebook Graph API with app_secret_proof
 *
 * @param accessToken - Facebook access token
 * @param appSecret - Facebook app secret (for app_secret_proof)
 * @param quirks - Facebook provider quirks
 * @returns User info or null if failed
 */
async function fetchFacebookUserInfo(
  accessToken: string,
  appSecret: string,
  quirks?: FacebookProviderQuirks
): Promise<Record<string, unknown> | null> {
  try {
    const apiVersion = quirks?.apiVersion || 'v20.0';
    const fields = quirks?.fields?.join(',') || 'id,name,email,picture.type(large)';

    const url = new URL(`https://graph.facebook.com/${apiVersion}/me`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('access_token', accessToken);

    // Add app_secret_proof if enabled
    if (quirks?.useAppSecretProof) {
      const proof = await generateAppSecretProof(accessToken, appSecret);
      url.searchParams.set('appsecret_proof', proof);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const log = createLogger().module('CALLBACK');
      log.warn('Facebook /me failed', { status: response.status });
      return null;
    }

    const data: Record<string, unknown> = await response.json();
    return data;
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch Facebook user info', {}, error as Error);
    return null;
  }
}

// =============================================================================
// Twitter-specific helpers
// =============================================================================

/**
 * Check if a provider is Twitter/X
 */
function isTwitterProvider(provider: UpstreamProvider): boolean {
  // Check by authorization endpoint
  if (provider.authorizationEndpoint?.includes('twitter.com')) {
    return true;
  }
  // Check by token endpoint
  if (
    provider.tokenEndpoint?.includes('api.twitter.com') ||
    provider.tokenEndpoint?.includes('api.x.com')
  ) {
    return true;
  }
  // Check by name (case insensitive)
  const name = provider.name.toLowerCase();
  if (name.includes('twitter') || name === 'x') {
    return true;
  }
  return false;
}

/**
 * Fetch user info from Twitter API v2 with user.fields
 *
 * @param accessToken - Twitter access token
 * @param quirks - Twitter provider quirks
 * @returns User info or null if failed
 */
async function fetchTwitterUserInfo(
  accessToken: string,
  quirks?: TwitterProviderQuirks
): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL('https://api.twitter.com/2/users/me');

    // Add user.fields
    const userFields = quirks?.userFields || 'id,name,username,profile_image_url';
    url.searchParams.set('user.fields', userFields);

    // Add expansions if specified
    if (quirks?.expansions) {
      url.searchParams.set('expansions', quirks.expansions);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const log = createLogger().module('CALLBACK');
      log.warn('Twitter /users/me failed', { status: response.status });
      return null;
    }

    const data: Record<string, unknown> = await response.json();
    return data;
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch Twitter user info', {}, error as Error);
    return null;
  }
}

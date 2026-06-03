/**
 * External IdP Callback Handler
 * GET/POST /auth/external/:provider/callback - Handle OAuth callback
 *
 * Most OAuth providers use GET with query parameters.
 * Apple Sign In uses POST with response_mode=form_post when name/email scope is requested.
 */

import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  getSessionStoreForNewSession,
  getUIConfig,
  buildIssuerUrl,
  shouldUseBuiltinForms,
  getDefaultTenantId,
  getTenantIdFromContext,
  createDiagnosticLoggerFromContext,
  getDiagnosticSessionId,
  createAuthContextFromHono,
  createPIIContextFromHono,
  CanonicalRuntimeUserStore,
  // Challenge Store for auth_code generation
  getChallengeStoreByChallengeId,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Logger
  getLogger,
  createLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  // Audit Log
  createAuditLog,
  // Errors
  AR_ERROR_CODES,
  createErrorResponse,
  safeFetchJson,
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
  const tenantId = getTenantIdFromContext(c);
  let code = c.req.query('code');
  let state = c.req.query('state');
  let error = c.req.query('error');
  let errorDescription = c.req.query('error_description');
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
 * Generate authorization code for Direct Auth token exchange
 * TTL: 60 seconds, single-use
 */
async function generateAuthCode(
  env: Env,
  tenantId: string,
  userId: string,
  codeChallenge: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const authCode = crypto.randomUUID();
  const challengeStore = await getChallengeStoreByChallengeId(env, authCode, tenantId);

  await challengeStore.storeChallengeRpc({
    id: `direct_auth:${authCode}`,
    tenantId,
    type: 'direct_auth_code',
    userId,
    challenge: codeChallenge, // Store code_challenge for verification
    ttl: 60, // 60 seconds
    metadata: {
      ...metadata,
      created_at: Date.now(),
    },
  });

  return authCode;
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
  if (!providerIdOrSlug) return redirectWithError(c, 'invalid_request', 'Missing provider');
  const { code, state, error, errorDescription, tenantId, user } = await getCallbackParams(c);
  let diagnosticLogger: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>> = null;

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

    // Create diagnostic logger (OIDF conformance)
    diagnosticLogger = await createDiagnosticLoggerFromContext(c, {
      tenantId: authState.tenantId || tenantId,
      clientId: provider.clientId,
    });
    const diagnosticSessionId = getDiagnosticSessionId(c);
    const flowId = authState.flowId;

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
    const callbackTenantId = authState.tenantId || tenantId;
    const callbackUri = `${buildIssuerUrl(c.env, callbackTenantId)}/auth/external/${providerIdentifier}/callback`;

    // 4b. Log authorization response (OIDF conformance)
    if (diagnosticLogger) {
      await diagnosticLogger.logAuthDecision({
        diagnosticSessionId,
        flowId,
        decision: 'allow',
        reason: 'authorization_response',
        flow: 'external_idp',
        context: {
          provider: provider.slug ?? provider.id,
          client_id: provider.clientId,
          authrim_client_id: authState.clientId,
          redirect_uri: callbackUri,
          state,
          code,
        },
      });
    }

    // 5. Exchange code for tokens
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret);
    if (!authState.codeVerifier) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'Missing code_verifier in auth state'
      );
    }

    const { tokens, requestContext } = await client.exchangeCode(code, authState.codeVerifier);

    if (diagnosticLogger) {
      await diagnosticLogger.logTokenValidation({
        diagnosticSessionId,
        flowId,
        step: 'token-request',
        tokenType: 'authorization_code',
        result: 'pass',
        details: {
          token_endpoint: requestContext.tokenEndpoint,
          auth_method: requestContext.authMethod,
          auth_header_present: requestContext.authHeaderPresent,
          grant_type: 'authorization_code',
          redirect_uri: callbackUri,
          client_id: provider.clientId,
          code,
          code_verifier: authState.codeVerifier,
        },
      });

      await diagnosticLogger.logTokenValidation({
        diagnosticSessionId,
        flowId,
        step: 'token-response',
        tokenType: 'token',
        token: tokens.access_token,
        result: 'pass',
        details: {
          token_endpoint: requestContext.tokenEndpoint,
          token_type: tokens.token_type,
          expires_in: tokens.expires_in,
          scope: tokens.scope,
          access_token: tokens.access_token,
          id_token: tokens.id_token,
          refresh_token: tokens.refresh_token,
        },
      });
    }

    // 6. Validate ID token and/or fetch user info
    let userInfo;
    let idTokenSub: string | undefined;
    const diagnostics = diagnosticLogger
      ? {
          logger: diagnosticLogger,
          flowId,
          diagnosticSessionId,
        }
      : undefined;
    if (provider.providerType === 'oidc' && tokens.id_token && authState.nonce) {
      // Use the new options-based signature for comprehensive OIDC validation
      userInfo = await client.validateIdToken(
        tokens.id_token,
        {
          nonce: authState.nonce,
          accessToken: tokens.access_token, // For at_hash validation if present
          maxAge: authState.maxAge, // For auth_time validation if max_age was requested
          acrValues: authState.acrValues, // For acr validation if acr_values was requested
        },
        diagnostics
      );
      idTokenSub = userInfo.sub;

      // Optionally fetch userinfo even when id_token is present
      // Enable this for OIDC RP certification testing or when userinfo has additional claims
      if (provider.alwaysFetchUserinfo) {
        try {
          const { userInfo: userinfoData, endpoint } = await client.fetchUserInfoWithMeta(
            tokens.access_token
          );
          if (diagnosticLogger) {
            await diagnosticLogger.logTokenValidation({
              diagnosticSessionId,
              flowId,
              step: 'userinfo-request',
              tokenType: 'access_token',
              token: tokens.access_token,
              result: 'pass',
              details: {
                endpoint,
              },
            });
            await diagnosticLogger.logTokenValidation({
              diagnosticSessionId,
              flowId,
              step: 'userinfo-response',
              tokenType: 'access_token',
              token: tokens.access_token,
              result: 'pass',
              details: {
                endpoint,
                claims: userinfoData,
              },
            });
          }
          if (idTokenSub && userinfoData.sub && userinfoData.sub !== idTokenSub) {
            if (diagnosticLogger) {
              await diagnosticLogger.logTokenValidation({
                diagnosticSessionId,
                flowId,
                step: 'userinfo-mismatch',
                tokenType: 'id_token',
                result: 'fail',
                errorMessage: 'Userinfo sub claim does not match ID token sub',
                details: {
                  expected_sub: idTokenSub,
                  actual_sub: userinfoData.sub,
                },
              });
            }
            throw new Error('Userinfo sub claim mismatch');
          }
          // Merge userinfo data (userinfo may have additional claims not in id_token)
          userInfo = { ...userInfo, ...userinfoData };
        } catch {
          // Userinfo fetch failure is not fatal - we already have claims from id_token
          log.warn('Userinfo fetch failed, using id_token claims only');
        }
      }
    } else {
      const { userInfo: userinfoData, endpoint } = await client.fetchUserInfoWithMeta(
        tokens.access_token
      );
      if (diagnosticLogger) {
        await diagnosticLogger.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'userinfo-request',
          tokenType: 'access_token',
          token: tokens.access_token,
          result: 'pass',
          details: {
            endpoint,
          },
        });
        await diagnosticLogger.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'userinfo-response',
          tokenType: 'access_token',
          token: tokens.access_token,
          result: 'pass',
          details: {
            endpoint,
            claims: userinfoData,
          },
        });
      }
      userInfo = userinfoData;
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

    // 8. Publish authentication success event (non-blocking)
    // Note: Session will be created during token exchange, not here
    publishEvent(c, {
      type: AUTH_EVENTS.EXTERNAL_IDP_SUCCEEDED,
      tenantId: authState.tenantId,
      data: {
        userId: result.userId,
        method: 'external_idp',
        clientId: provider.id,
      } satisfies Omit<AuthEventData, 'sessionId'>,
    }).catch((err: unknown) => {
      log.error('Failed to publish auth.external_idp.succeeded', {}, err as Error);
    });

    // 9. Generate authorization code for Direct Auth token exchange
    // Use code_challenge from authState (client-side PKCE)
    const codeChallenge = authState.codeChallenge;
    if (!codeChallenge) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'Missing code_challenge in auth state'
      );
    }

    const clientId = authState.clientId;
    if (!clientId) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'Missing client_id in auth state'
      );
    }

    // 11. SSO decision: SSO is enabled by default (handoff flow)
    const enableSso = authState.enableSso !== false; // Default: true

    if (enableSso) {
      // SSO enabled: handoff flow

      // 11a. User verification (performed before session creation)
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const runtimeUsers = new CanonicalRuntimeUserStore({
        coreAdapter: authCtx.coreAdapter,
        piiAdapter: piiCtx.defaultPiiAdapter,
        tenantId,
      });
      const runtimeUser = await runtimeUsers.findById(result.userId);

      if (!runtimeUser) {
        return createErrorResponse(c, AR_ERROR_CODES.USER_INACTIVE);
      }

      // 11b. Create session (SSO session)
      const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);
      const sessionTTL = 24 * 60 * 60; // 24 hours

      await sessionStore.createSessionRpc(
        sessionId,
        result.userId,
        sessionTTL,
        {
          email: userInfo.email || null,
          name: userInfo.name || null,
          amr: ['external_idp'],
          acr: 'urn:mace:incommon:iap:bronze',
          client_id: clientId,
          external_idp: provider.id,
        },
        tenantId
      );

      // Set session cookie
      const issuerUrl = buildIssuerUrl(c.env, authState.tenantId || tenantId);
      const isSecure = issuerUrl.startsWith('https://');

      setCookie(c, 'authrim_session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: isSecure,
        sameSite: 'Lax',
        maxAge: sessionTTL,
      });

      // 11c. handoff tokengenerate
      const handoffToken = crypto.randomUUID();
      const handoffStore = await getChallengeStoreByChallengeId(c.env, handoffToken, tenantId);

      await handoffStore.storeChallengeRpc({
        id: `handoff:${handoffToken}`,
        tenantId,
        type: 'handoff',
        userId: result.userId,
        challenge: sessionId, // Store sessionId
        ttl: 30, // 30 seconds (enough for redirect + JS execution)
        metadata: {
          client_id: clientId,
          state: authState.state,
          aud: 'handoff', // prevent accidental token reuse
          created_at: Date.now(),
        },
      });

      // 11d. Redirect to the RP (with handoff token + Referrer mitigation)
      const redirectUrl = new URL(authState.redirectUri);
      redirectUrl.searchParams.set('handoff_token', handoffToken);
      redirectUrl.searchParams.set('state', authState.state);

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          'Referrer-Policy': 'no-referrer', // Mitigate browser-history and referrer leakage
          'Cache-Control': 'no-store', // Prevent caching
        },
      });
    } else {
      // SSO disabled: legacy Direct Auth flow (returns authCode)
      const authCode = await generateAuthCode(c.env, tenantId, result.userId, codeChallenge, {
        method: 'external_idp',
        provider: provider.id,
        provider_id: provider.id,
        provider_slug: provider.slug ?? provider.id,
        client_id: clientId,
        is_new_user: result.isNewUser,
        stitched_from_existing: result.stitchedFromExisting,
      });

      const redirectUrl = new URL(authState.redirectUri);
      redirectUrl.searchParams.set('code', authCode);

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
        },
      });
    }
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

      log.error('Unexpected error in callback', {});
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
  } finally {
    if (diagnosticLogger) {
      await diagnosticLogger.cleanup();
    }
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
  if (tenantId && tenantId !== getDefaultTenantId(c.env)) {
    redirectUrl.searchParams.set('tenant_hint', tenantId);
  }

  return c.redirect(redirectUrl.toString());
}

/**
 * Session creation options for external IdP authentication
 */
interface CreateSessionOptions {
  userId: string;
  tenantId: string;
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
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(
      env,
      options.tenantId
    );
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
      const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
        env,
        'bridge-callback-session-record',
        { tenantId: options.tenantId }
      );
      await coreAdapter.execute(
        `INSERT INTO sessions (
           id, user_id, expires_at, created_at, external_provider_id, external_provider_sub, tenant_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          options.userId,
          expiresAt,
          now,
          options.externalProviderId,
          options.externalProviderSub,
          options.tenantId,
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
// URL Host Checking Helper
// =============================================================================

/**
 * Safely check if a URL's host matches expected hosts
 * This prevents URL substring attacks like "evil.com/api.github.com"
 *
 * @param url - The URL string to check
 * @param allowedHosts - Array of allowed hostnames (exact match or subdomain)
 * @returns true if the URL's host matches one of the allowed hosts
 */
function urlHostMatches(url: string | undefined, allowedHosts: string[]): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some((allowed) => {
      const normalizedAllowed = allowed.toLowerCase();
      // Exact match or subdomain match (e.g., "api.github.com" matches "github.com")
      return host === normalizedAllowed || host.endsWith('.' + normalizedAllowed);
    });
  } catch {
    return false;
  }
}

// =============================================================================
// GitHub-specific helpers
// =============================================================================

/**
 * Check if a provider is GitHub (by checking endpoints or name)
 */
function isGitHubProvider(provider: UpstreamProvider): boolean {
  // Check by userinfo endpoint - must be github.com domain
  if (urlHostMatches(provider.userinfoEndpoint, ['api.github.com', 'github.com'])) {
    return true;
  }
  // Check by authorization endpoint - must be github.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['github.com'])) {
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
    const emails = await safeFetchJson<GitHubEmail[]>(GITHUB_USER_EMAILS_ENDPOINT, {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

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
  // Check by authorization endpoint - must be facebook.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['facebook.com', 'www.facebook.com'])) {
    return true;
  }
  // Check by token endpoint - must be graph.facebook.com domain
  if (urlHostMatches(provider.tokenEndpoint, ['graph.facebook.com'])) {
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

    const data = await safeFetchJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
    });
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
  // Check by authorization endpoint - must be twitter.com or x.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['twitter.com', 'x.com'])) {
    return true;
  }
  // Check by token endpoint - must be api.twitter.com or api.x.com domain
  if (urlHostMatches(provider.tokenEndpoint, ['api.twitter.com', 'api.x.com'])) {
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

    const data = await safeFetchJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return data;
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch Twitter user info', {}, error as Error);
    return null;
  }
}

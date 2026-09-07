/**
 * External IdP Start Handler
 * GET /auth/external/:provider/start - Initiate external IdP login
 *
 * Security Features:
 * - Rate limiting per IP to prevent auth flooding
 * - Open redirect prevention
 * - Session verification for linking flows
 */

import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  getUIConfig,
  buildIssuerUrl,
  getTenantIdFromContext,
  getLogger,
  createLogger,
  createDiagnosticLoggerFromContext,
  getDiagnosticSessionId,
  createAuthContextFromHono,
  getChallengeStoreByChallengeId,
  DIAGNOSTIC_FLOW_ID_HEADER,
  verifyHumanVerificationWithRunner,
} from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';
import {
  ensureDynamicClientRegistration,
  getDynamicClientRegistrationConfig,
} from '../services/dynamic-registration';
import { OIDCRPClient } from '../clients/oidc-client';
import { Fapi2Client } from '../clients/fapi2-client';
import { generatePKCE, generateState, generateNonce } from '../utils/pkce';
import {
  storeAuthState,
  getStateExpiresAt,
  consumeAuthState,
  getAuthStateCookieName,
} from '../utils/state';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';
import { isAppleProvider, type AppleProviderQuirks } from '../providers/apple';
import { publishRequestObject } from './request-object';
import {
  isFapi2Provider,
  loadFapi2ProviderConfig,
  validateFapi2ProviderMetadata,
} from '../services/fapi2-provider';

/**
 * Rate limit configuration
 * Configurable via KV: external_idp_rate_limit
 */
interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Whether rate limiting is enabled */
  enabled: boolean;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 60,
  enabled: true,
};

function remoteIp(c: Context<{ Bindings: Env }>): string | undefined {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    undefined
  );
}

async function verifyExternalStartHumanVerification(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  try {
    const result = await verifyHumanVerificationWithRunner(c.env, {
      tenantId,
      action: 'login',
      responseToken:
        c.req.query('human_verification_response') ?? c.req.query('cf_turnstile_response'),
      remoteIp: remoteIp(c),
    });
    if (result.verified) return null;
  } catch {
    // Provider, configuration, and Runner failures share the same public denial.
  }

  return c.json(
    {
      error: 'invalid_request',
      error_description: 'Human verification failed',
    },
    400
  );
}

/**
 * Start external IdP login flow
 *
 * Query Parameters:
 * - redirect_uri: Where to redirect after successful login (default: UI base URL)
 * - link: "true" if linking to existing account (requires session)
 * - prompt: Optional OIDC prompt parameter
 * - login_hint: Optional email hint for provider
 * - max_age: Optional maximum authentication age in seconds (OIDC)
 * - acr_values: Optional authentication context class reference values (OIDC)
 * - handoff: "true" to enable Session Token Handoff SSO (page-level navigation)
 */
export async function handleExternalStart(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('START');
  let diagnosticLogger: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>> = null;
  let diagnosticFlowId: string | undefined;
  try {
    // Rate limiting check
    const rateLimitResult = await checkRateLimit(c);
    if (!rateLimitResult.allowed) {
      return c.json(
        {
          error: 'rate_limit_exceeded',
          error_description: 'Too many authentication requests. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        429,
        {
          'Retry-After': String(rateLimitResult.retryAfter),
        }
      );
    }

    const providerIdOrName = c.req.param('provider');
    if (!providerIdOrName) {
      return c.json({ error: 'invalid_request', error_description: 'Missing provider' }, 400);
    }
    const requestedRedirectUri = c.req.query('redirect_uri');
    const isLinking = c.req.query('link') === 'true';
    const prompt = c.req.query('prompt');
    const loginHint = c.req.query('login_hint');
    const maxAgeParam = c.req.query('max_age');
    const acrValues = c.req.query('acr_values');
    const tenantId = getTenantIdFromContext(c);
    const clientId = c.req.query('client_id');
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method');
    const stateParam = c.req.query('state');
    const turnstileError = await verifyExternalStartHumanVerification(c, tenantId);
    if (turnstileError) return turnstileError;

    // Parse max_age parameter (OIDC Core)
    const maxAge = maxAgeParam ? parseInt(maxAgeParam, 10) : undefined;
    if (maxAgeParam && (isNaN(maxAge!) || maxAge! < 0)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'max_age must be a non-negative integer',
        },
        400
      );
    }

    // 1. Get client configuration (to validate redirect_uri)
    const tenantIdResolved = getTenantIdFromContext(c);
    let clientRedirectUris: string[] | undefined;

    if (clientId) {
      try {
        const authCtx = createAuthContextFromHono(c, tenantIdResolved);
        const client = await authCtx.repositories.client.findByClientId(clientId);

        if (client && client.redirect_uris) {
          // Parse redirect_uris (handle both JSON array and single string)
          if (typeof client.redirect_uris === 'string') {
            if (client.redirect_uris.trim().startsWith('[')) {
              clientRedirectUris = JSON.parse(client.redirect_uris);
            } else {
              clientRedirectUris = [client.redirect_uris];
            }
          } else if (Array.isArray(client.redirect_uris)) {
            clientRedirectUris = client.redirect_uris;
          }
        }
      } catch (error) {
        // Client lookup failed - continue without client redirect_uris
        log.warn('Failed to load client for redirect_uri validation', { clientId });
      }
    }

    // Validate and sanitize redirect_uri to prevent Open Redirect attacks
    const redirectUri = await validateRedirectUri(
      requestedRedirectUri,
      c.env,
      tenantIdResolved,
      clientId,
      clientRedirectUris
    );

    // 2. Get provider configuration (by slug or ID)
    let provider = await getProviderByIdOrSlug(c.env, providerIdOrName, tenantIdResolved);

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
            error: 'invalid_token',
            error_description: 'Session required for linking',
          },
          401
        );
      }
      userId = session.userId;
      sessionId = session.id;
    }

    // 3. Validate PKCE parameters from client
    if (!clientId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_id is required',
        },
        400
      );
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'code_challenge and code_challenge_method=S256 are required',
        },
        400
      );
    }

    // 4. Generate state, nonce, and flowId
    const state = generateState();
    const nonce = generateNonce();
    const flowId = crypto.randomUUID();
    diagnosticFlowId = flowId;
    c.header(DIAGNOSTIC_FLOW_ID_HEADER, flowId);
    c.header('Cache-Control', 'no-store');

    // 5. Decrypt client secret
    let clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);

    // 5b. Decrypt private key for request object signing (if configured)
    let privateKeyJwk: Record<string, unknown> | undefined;
    if (provider.useRequestObject && provider.privateKeyJwkEncrypted) {
      const decryptedPrivateKey = await decryptClientSecret(c.env, provider.privateKeyJwkEncrypted);
      privateKeyJwk = JSON.parse(decryptedPrivateKey);
    }

    // 6. Build callback URL (use slug if available for cleaner URLs)
    const providerIdentifier = provider.slug || provider.id;
    const callbackUri = `${buildIssuerUrl(c.env, tenantIdResolved)}/auth/external/${providerIdentifier}/callback`;

    // Register dynamically when enabled and no registration exists for the
    // current issuer. Changing issuer deliberately invalidates the cached
    // credentials, which is also required by the OIDC Dynamic RP tests.
    const dynamicResult = await ensureDynamicClientRegistration({
      env: c.env,
      tenantId: tenantIdResolved,
      provider,
      callbackUri,
    });
    provider = dynamicResult.provider;
    clientSecret = dynamicResult.clientSecret;

    // 7. Generate PKCE for Authrim ↔ External IdP flow
    // This is separate from the client ↔ Authrim PKCE flow
    const externalIdpPKCE = await generatePKCE();

    // 8. Store state in D1 (including code_challenge for client-side PKCE)
    await storeAuthState(c.env, {
      tenantId: tenantIdResolved,
      clientId,
      providerId: provider.id,
      state,
      nonce,
      codeVerifier: externalIdpPKCE.codeVerifier,
      codeChallenge,
      flowId,
      redirectUri,
      userId,
      sessionId,
      maxAge,
      acrValues,
      prompt,
      enableSso: provider.enableSso !== false,
      expiresAt: getStateExpiresAt(),
    });

    // 9. Silent Auth handling (prompt=none) + Session Token Handoff SSO (handoff=true)
    // OIDC Core 3.1.2.1: when prompt=none, authenticated users succeed and unauthenticated users return error=login_required
    // ⚠️ Note: prompt can contain multiple values (space-separated), example: "none login"
    // 📝 handoff=true: SDK → direct External IdP Start call (third-party cookie blocking support)
    //    - Check the session via top-level navigation
    //    - Return a handoff token and redirect to the RP callback
    //    - Same logic as the existing prompt=none flow (maintain backward compatibility)
    const promptValues = (prompt ?? '').split(' ').filter(Boolean);
    const isSilentAuth = promptValues.includes('none');

    if (isSilentAuth) {
      // OIDC spec: prompt=none cannot be combined with other prompt values
      // example: "none login" conflicts (no user interaction vs forced login)
      if (promptValues.length > 1) {
        log.warn('Silent Auth: prompt=none with other values', { allPrompts: prompt });
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'invalid_request');
        errorRedirectUrl.searchParams.set(
          'error_description',
          'prompt=none cannot be combined with other values'
        );
        errorRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: errorRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }

      log.info('Silent Auth: prompt=none detected', { sessionId });

      // PKCE requirement check (Authrim requires PKCE for all codes)
      if (!codeChallenge) {
        log.error('Silent Auth: Missing code_challenge', { clientId });
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'invalid_request');
        errorRedirectUrl.searchParams.set('error_description', 'code_challenge is required');
        errorRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: errorRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }

      // Check SSO settings
      // Priority: Client KV > Tenant KV > Client ENV > Tenant ENV > Default (provider.enableSso)
      let ssoEnabled = provider.enableSso !== false; // Default from provider config

      try {
        const [settingsManagerModule, clientSettingsModule, oauthSettingsModule] =
          await Promise.all([
            import('@authrim/ar-lib-core/utils/settings-manager'),
            import('@authrim/ar-lib-core/types/settings/client'),
            import('@authrim/ar-lib-core/types/settings/oauth'),
          ]);
        const { createSettingsManager } = settingsManagerModule;
        const { CLIENT_CATEGORY_META } = clientSettingsModule;
        const { OAUTH_CATEGORY_META } = oauthSettingsModule;
        const settingsManager = createSettingsManager({
          env: c.env as unknown as Record<string, string | undefined>,
          kv: c.env.SETTINGS ?? null,
        });

        // Register category metadata
        settingsManager.registerCategory(CLIENT_CATEGORY_META);
        settingsManager.registerCategory(OAUTH_CATEGORY_META);

        // 1. Try client-level setting first (highest priority)
        if (clientId) {
          try {
            const clientSsoSetting = await settingsManager.get('client.sso_enabled', {
              type: 'client',
              id: clientId,
              tenantId,
            });
            if (typeof clientSsoSetting === 'boolean') {
              ssoEnabled = clientSsoSetting;
              log.debug('SSO setting from client config', { clientId, ssoEnabled });
            }
          } catch (error) {
            // Client setting not found or error - continue to tenant level
            log.debug('Client SSO setting not found, trying tenant level', {
              clientId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // 2. If client setting not found, try tenant-level setting
        if (ssoEnabled === (provider.enableSso !== false)) {
          try {
            const tenantSsoSetting = await settingsManager.get('oauth.sso_enabled', {
              type: 'tenant',
              id: tenantIdResolved,
            });
            if (typeof tenantSsoSetting === 'boolean') {
              ssoEnabled = tenantSsoSetting;
              log.debug('SSO setting from tenant config', {
                tenantId: tenantIdResolved,
                ssoEnabled,
              });
            }
          } catch (error) {
            // Tenant setting not found - use provider default
            log.debug('Tenant SSO setting not found, using provider default', {
              tenantId: tenantIdResolved,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        log.warn('Failed to load SSO settings, using provider default', {
          action: 'sso_check_error',
          error: error instanceof Error ? error.message : String(error),
        });
        // Keep provider default
      }

      if (!ssoEnabled) {
        // SSO disabled → login_required
        log.info('Silent Auth: SSO disabled', { clientId, tenantId: tenantIdResolved });
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'login_required');
        errorRedirectUrl.searchParams.set('error_description', 'SSO is disabled for this client');
        if (stateParam) {
          errorRedirectUrl.searchParams.set('state', stateParam);
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: errorRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }

      // Check whether the session exists
      if (!sessionId) {
        // No session → error=login_required
        log.info('Silent Auth: No active session', { clientId });
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'login_required');
        errorRedirectUrl.searchParams.set('error_description', 'Authentication required');
        errorRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: errorRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }

      // Check session validity
      const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantIdResolved);
      const session: Session | null = await sessionStore.getSessionRpc(sessionId);

      if (!session) {
        // Invalid session → error=login_required
        log.info('Silent Auth: Session expired or invalid', { sessionId });
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'login_required');
        errorRedirectUrl.searchParams.set('error_description', 'Authentication required');
        errorRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: errorRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }

      // ⚠️ CRITICAL: Consume state (replay attack mitigation)
      // Mark consumed_at even on Silent Auth success to prevent state reuse
      // 📝 Timing: after session validation and before token issuance
      //   - failure paths leave state unconsumed (retryable)
      //   - success paths consume it before issuance (handoff/codeissuance failure is near zero)
      const consumedAuthState = await consumeAuthState(c.env, tenantIdResolved, state);
      if (!consumedAuthState) {
        // State consumption failed (already used, expired, or conflicted)
        // 📝 error=invalid_request: indicates a state issue (vs login_required=not logged in)
        log.info('Silent Auth: State already consumed or expired', { state });
        const errorRedirectUrl = new URL(redirectUri);
        errorRedirectUrl.searchParams.set('error', 'invalid_request');
        errorRedirectUrl.searchParams.set('error_description', 'Authentication request expired');
        errorRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: errorRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }

      // Valid session → handoff token or code issuance
      // TypeScript type narrowing: session is guaranteed non-null after the check above
      const validSession: Session = session;
      log.info('Silent Auth: Issuing token', { sessionId, userId: validSession.userId });

      // Issue a handoff token only when SSO is enabled (issue a code when enableSso=false)
      const enableSso = provider.enableSso !== false;

      if (enableSso) {
        // handoff tokengenerate (reuse the callback.ts pattern)
        const handoffToken = crypto.randomUUID();
        const handoffStore = await getChallengeStoreByChallengeId(
          c.env,
          handoffToken,
          getTenantIdFromContext(c)
        );

        await handoffStore.storeChallengeRpc({
          id: `handoff:${handoffToken}`,
          tenantId: getTenantIdFromContext(c),
          type: 'handoff',
          userId: validSession.userId,
          challenge: sessionId,
          ttl: 30, // 30 seconds
          metadata: {
            client_id: clientId,
            state,
            aud: 'handoff',
            created_at: Date.now(),
          },
        });

        // Redirect to the RP (with handoff token)
        const successRedirectUrl = new URL(redirectUri);
        successRedirectUrl.searchParams.set('handoff_token', handoffToken);
        successRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: successRedirectUrl.toString(),
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
          },
        });
      } else {
        // When SSO is disabled: issue an authorization code
        // codeChallenge was checked above and is safe to use
        const authCode = await generateAuthCode(
          c.env,
          tenantId,
          validSession.userId,
          codeChallenge,
          {
            method: 'silent_auth',
            provider: provider.id,
            provider_id: provider.id,
            provider_slug: provider.slug ?? provider.id,
            client_id: clientId!,
            is_new_user: false,
            stitched_from_existing: false,
          }
        );

        const successRedirectUrl = new URL(redirectUri);
        successRedirectUrl.searchParams.set('code', authCode);
        successRedirectUrl.searchParams.set('state', state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: successRedirectUrl.toString(),
            'Cache-Control': 'no-store',
          },
        });
      }
    }

    // 10. Create OIDC client and generate authorization URL
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret, privateKeyJwk);

    // Initialize before discovery so metadata validation failures are visible
    // in RP certification evidence and operational diagnostics.
    diagnosticLogger = await createDiagnosticLoggerFromContext(c, {
      tenantId,
      clientId: provider.clientId,
    });

    // Apple Sign In requires response_mode=form_post when requesting name or email scope
    let responseMode: string | undefined;
    if (isAppleProvider(provider)) {
      const quirks = provider.providerQuirks as unknown as AppleProviderQuirks | undefined;
      // Use form_post if configured (default: true) or if name/email scope is requested
      const scopes = provider.scopes?.toLowerCase() || '';
      const needsFormPost = scopes.includes('name') || scopes.includes('email');
      if (quirks?.useFormPost !== false && needsFormPost) {
        responseMode = 'form_post';
      }
    }

    const configuredResponseType = provider.providerQuirks?.responseType;
    const responseType = configuredResponseType === 'code id_token' ? 'code id_token' : 'code';

    if (isFapi2Provider(provider)) {
      const encryptionKey = getEncryptionKeyOrUndefined(c.env);
      if (!encryptionKey) throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
      const fapiConfig = await loadFapi2ProviderConfig(provider, encryptionKey);
      const metadata = await client.discover();
      validateFapi2ProviderMetadata(metadata, fapiConfig.profile, fapiConfig);
      const fapiClient = new Fapi2Client({
        issuer: metadata.issuer,
        clientId: provider.clientId,
        redirectUri: callbackUri,
        clientAssertionPrivateJwk: fapiConfig.clientAssertionPrivateJwk,
        dpopPrivateJwk: fapiConfig.dpopPrivateJwk,
      });
      const authorizationParams = {
        client_id: provider.clientId,
        redirect_uri: callbackUri,
        response_type: 'code',
        scope: provider.scopes,
        state,
        ...(fapiConfig.profile === 'oidc' ? { nonce } : {}),
        code_challenge: externalIdpPKCE.codeChallenge,
        code_challenge_method: 'S256',
        ...(fapiConfig.jarm ? { response_mode: 'jwt' } : {}),
      };
      const parParameters = fapiConfig.requestObjectSigning
        ? {
            request: await fapiClient.createAuthorizationRequestObject(authorizationParams),
          }
        : authorizationParams;
      const par = await fapiClient.pushAuthorizationRequest(
        metadata.pushed_authorization_request_endpoint!,
        parParameters
      );
      const authUrl = new URL(metadata.authorization_endpoint);
      authUrl.searchParams.set('client_id', provider.clientId);
      authUrl.searchParams.set('request_uri', par.request_uri);

      if (diagnosticLogger) {
        await diagnosticLogger.logAuthDecision({
          diagnosticSessionId: getDiagnosticSessionId(c),
          decision: 'allow',
          reason: 'fapi2_pushed_authorization_request',
          flow: 'external_idp',
          flowId,
          context: {
            provider: provider.slug ?? provider.id,
            client_id: provider.clientId,
            authrim_client_id: clientId,
            authorization_endpoint: authUrl.origin + authUrl.pathname,
            pushed_authorization_request_endpoint: metadata.pushed_authorization_request_endpoint,
            redirect_uri: callbackUri,
            response_type: 'code',
            scope: provider.scopes,
            state_present: true,
            nonce_present: Boolean(nonce),
            code_challenge_present: true,
            code_challenge_method: 'S256',
          },
        });
        await diagnosticLogger.cleanup();
        diagnosticLogger = null;
      }

      const stateCookieName = await getAuthStateCookieName(state);
      const secureCookie = buildIssuerUrl(c.env, tenantIdResolved).startsWith('https://');
      setCookie(c, stateCookieName, state, {
        path: '/auth/external/',
        httpOnly: true,
        secure: secureCookie,
        sameSite: secureCookie ? 'None' : 'Lax',
        maxAge: 10 * 60,
      });
      return c.redirect(authUrl.toString());
    }

    const authUrl = await client.createAuthorizationUrl({
      state,
      nonce,
      codeVerifier: externalIdpPKCE.codeVerifier, // For Authrim ↔ External IdP PKCE
      prompt,
      loginHint,
      maxAge,
      acrValues,
      responseType,
      responseMode,
      requestUri: (() => {
        const registeredUri = getDynamicClientRegistrationConfig(provider)?.requestUris?.[0];
        if (!registeredUri) return undefined;
        const uri = new URL(registeredUri);
        uri.searchParams.set('id', state);
        return uri.toString();
      })(),
      publishRequestObject: async (requestObject) =>
        publishRequestObject(c.env, tenantIdResolved, provider.id, state, requestObject),
    });

    if (diagnosticLogger) {
      const authUrlParsed = new URL(authUrl);
      await diagnosticLogger.logAuthDecision({
        diagnosticSessionId: getDiagnosticSessionId(c),
        decision: 'allow',
        reason: 'authorization_request',
        flow: 'external_idp',
        flowId,
        context: {
          provider: provider.slug ?? provider.id,
          client_id: provider.clientId,
          authrim_client_id: clientId,
          authorization_endpoint: authUrlParsed.origin + authUrlParsed.pathname,
          redirect_uri: callbackUri,
          response_type: responseType,
          scope: provider.scopes,
          state_present: true,
          nonce_present: Boolean(nonce),
          code_challenge_present: authUrlParsed.searchParams.has('code_challenge'),
          code_challenge_method: authUrlParsed.searchParams.get('code_challenge_method'),
          request_uri_present: authUrlParsed.searchParams.has('request_uri'),
          request_object_by_reference: authUrlParsed.searchParams.has('request_uri'),
          request_object_signing_alg: provider.requestObjectSigningAlg,
          response_mode: responseMode,
          prompt_present: Boolean(prompt),
          login_hint_present: Boolean(loginHint),
          max_age: maxAge,
          acr_values: acrValues,
        },
      });
      await diagnosticLogger.cleanup();
      diagnosticLogger = null;
    }

    // Bind this state to the initiating browser. A per-state cookie supports
    // concurrent login tabs and prevents login-CSRF/session swapping.
    const stateCookieName = await getAuthStateCookieName(state);
    const secureCookie = buildIssuerUrl(c.env, tenantIdResolved).startsWith('https://');
    setCookie(c, stateCookieName, state, {
      path: '/auth/external/',
      httpOnly: true,
      secure: secureCookie,
      sameSite: secureCookie ? 'None' : 'Lax',
      maxAge: 10 * 60,
    });

    // 10. Redirect to provider
    return c.redirect(authUrl);
  } catch (error) {
    const err = error as Error;
    if (diagnosticLogger) {
      try {
        await diagnosticLogger.logAuthDecision({
          diagnosticSessionId: getDiagnosticSessionId(c),
          flowId: diagnosticFlowId,
          decision: 'deny',
          reason: classifyExternalStartDiagnosticFailure(err),
          flow: 'external_idp',
          context: {
            provider: c.req.param('provider'),
            error_name: err.name,
            error_message: err.message,
          },
        });
      } catch (diagnosticError) {
        log.warn('Failed to record external start rejection diagnostic', {
          error:
            diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
        });
      } finally {
        await diagnosticLogger.cleanup().catch(() => undefined);
        diagnosticLogger = null;
      }
    }
    log.error(
      'External start error',
      {
        errorName: err.name,
        errorMessage: err.message,
        errorStack: err.stack,
        provider: c.req.param('provider'),
      },
      err
    );

    // Include error details in development/conformance mode
    const isDev = c.env.ENABLE_CONFORMANCE_MODE === 'true';

    return c.json(
      {
        error: 'server_error',
        error_description: isDev
          ? `Failed to start external login: ${err.message}`
          : 'Failed to start external login',
      },
      500
    );
  }
}

export function classifyExternalStartDiagnosticFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /discovery|issuer|jwks/i.test(message)
    ? 'discovery_validation_failed'
    : 'authorization_request_failed';
}

// =============================================================================
// Rate Limiting
// =============================================================================

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Check rate limit for the current request
 * Uses KV for distributed rate limiting
 */
async function checkRateLimit(c: Context<{ Bindings: Env }>): Promise<RateLimitResult> {
  const config = await getRateLimitConfig(c.env);

  if (!config.enabled) {
    return { allowed: true, remaining: config.maxRequests, retryAfter: 0 };
  }

  // Get client IP
  const clientIp = getClientIp(c);
  const tenantId = getTenantIdFromContext(c);
  const key = `tenant:${tenantId}:rate_limit:external_idp:start:${clientIp}`;

  try {
    // Get current count from KV
    const stored = await c.env.SETTINGS?.get(key);
    const current = stored ? JSON.parse(stored) : { count: 0, windowStart: Date.now() };
    const now = Date.now();

    // Check if window has expired
    if (now - current.windowStart > config.windowSeconds * 1000) {
      // Start new window
      current.count = 0;
      current.windowStart = now;
    }

    // Check if limit exceeded
    if (current.count >= config.maxRequests) {
      const windowEnd = current.windowStart + config.windowSeconds * 1000;
      const retryAfter = Math.ceil((windowEnd - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Increment count
    current.count++;
    await c.env.SETTINGS?.put(key, JSON.stringify(current), {
      expirationTtl: config.windowSeconds + 60, // Add buffer for cleanup
    });

    return {
      allowed: true,
      remaining: config.maxRequests - current.count,
      retryAfter: 0,
    };
  } catch (error) {
    // If rate limiting fails, allow the request (fail open)
    const log = getLogger(c).module('START');
    log.warn('Rate limit check failed, allowing request');
    return { allowed: true, remaining: config.maxRequests, retryAfter: 0 };
  }
}

/**
 * Get rate limit configuration from KV or use defaults
 */
async function getRateLimitConfig(env: Env): Promise<RateLimitConfig> {
  try {
    const stored = await env.SETTINGS?.get('external_idp_rate_limit');
    if (stored) {
      return { ...DEFAULT_RATE_LIMIT, ...JSON.parse(stored) };
    }
  } catch {
    // Use defaults if KV fails
  }
  return DEFAULT_RATE_LIMIT;
}

/**
 * Get client IP from request headers
 */
function getClientIp(c: Context<{ Bindings: Env }>): string {
  // Cloudflare provides real client IP in CF-Connecting-IP header
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

// =============================================================================
// Session Verification
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
    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionToken,
      getTenantIdFromContext(c)
    );
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

// =============================================================================
// Helper Functions
// =============================================================================

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
 * Default allowed redirect paths (when origin matches)
 * These are standard OAuth/OIDC callback and flow endpoints
 */
const DEFAULT_ALLOWED_REDIRECT_PATHS = [
  '/',
  '/callback',
  '/consent',
  '/reauth',
  '/device',
  '/ciba',
];

/**
 * Validate redirect_uri to prevent Open Redirect attacks
 *
 * Uses whitelist-based validation with exact path matching:
 * 1. Origin must match UI URL or Issuer URL
 * 2. Path must be in the allowed list (exact match)
 * 3. OR: redirect_uri must match client's registered redirect_uris
 *
 * Falls back to UI URL if redirect_uri is invalid or not provided
 *
 * SECURITY: This prevents Open Redirect attacks by rejecting arbitrary paths
 * even if they share the same origin (e.g., /malicious-page?redirect=evil.com)
 */
async function validateRedirectUri(
  requestedUri: string | undefined,
  env: Env,
  tenantId: string,
  clientId?: string,
  clientRedirectUris?: string[]
): Promise<string> {
  // Get UI config and build base URL
  const uiConfig = await getUIConfig(env);
  const issuerUrl = buildIssuerUrl(env, tenantId);

  // Determine base URL: UI config > issuer URL
  const baseUrl = uiConfig?.baseUrl || issuerUrl;
  const defaultRedirect = `${baseUrl}/`;

  if (!requestedUri) {
    return defaultRedirect;
  }

  const log = createLogger().module('START');

  try {
    // Handle relative paths - convert to absolute and re-validate
    if (requestedUri.startsWith('/')) {
      const absoluteUri = new URL(requestedUri, baseUrl).toString();
      // Recursively validate the absolute URI
      return validateRedirectUri(absoluteUri, env, tenantId, clientId, clientRedirectUris);
    }

    // Parse the requested URI
    const requestedUrl = new URL(requestedUri);
    const baseUrlParsed = new URL(baseUrl);
    const issuerUrlParsed = new URL(issuerUrl);

    // Extract allowed origins from configuration
    const allowedOrigins = new Set([baseUrlParsed.origin, issuerUrlParsed.origin]);

    // Add origins from ALLOWED_ORIGINS environment variable
    if (env.ALLOWED_ORIGINS) {
      const additionalOrigins = env.ALLOWED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
      additionalOrigins.forEach((origin) => {
        try {
          const parsed = new URL(origin);
          allowedOrigins.add(parsed.origin);
        } catch {
          // Ignore invalid origins
        }
      });
    }

    // SECURITY: Check both origin AND path (whitelist-based exact match)
    if (!allowedOrigins.has(requestedUrl.origin)) {
      log.warn('Blocked redirect to unauthorized origin', {
        requestedOrigin: requestedUrl.origin,
        allowedOrigins: Array.from(allowedOrigins),
      });
      return defaultRedirect;
    }

    // Origin is allowed, now check the path
    const requestedPath = requestedUrl.pathname;

    // First, check if redirect_uri matches client's registered redirect_uris
    if (clientRedirectUris && clientRedirectUris.length > 0) {
      // Check if requested URI matches any registered redirect_uri
      // Remove query params and hash for comparison
      const requestedUriBase = requestedUrl.origin + requestedUrl.pathname;
      for (const registeredUri of clientRedirectUris) {
        try {
          const registeredUrl = new URL(registeredUri);
          const registeredUriBase = registeredUrl.origin + registeredUrl.pathname;

          if (requestedUriBase === registeredUriBase) {
            // Match found - allow the redirect_uri
            return requestedUri;
          }
        } catch {
          // Invalid registered URI - skip
        }
      }
    }

    // Fallback: Check against default allowed paths (for same-origin UI)
    const allowedPaths = DEFAULT_ALLOWED_REDIRECT_PATHS;

    if (!allowedPaths.includes(requestedPath)) {
      log.warn('Blocked redirect to unauthorized path', {
        requestedPath,
        requestedOrigin: requestedUrl.origin,
        allowedPaths,
        clientId,
      });
      return defaultRedirect;
    }

    // Both origin and path are allowed - accept the redirect_uri
    // Note: Query parameters are preserved and passed through
    return requestedUri;
  } catch {
    // Invalid URL format - use default
    log.warn('Invalid redirect_uri format', { requestedUri });
    return defaultRedirect;
  }
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

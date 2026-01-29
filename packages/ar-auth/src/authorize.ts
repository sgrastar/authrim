import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  validateResponseType,
  validateClientId,
  validateRedirectUri,
  validateScope,
  validateState,
  validateNonce,
  isRedirectUriRegistered,
  createOAuthConfigManager,
  getAuthCodeShardIndex,
  createShardedAuthCode,
  buildAuthCodeShardInstanceName,
  getShardCount,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isShardedSessionId,
  parseShardedSessionId,
  getCachedUser,
  getCachedConsent,
  invalidateConsentCache,
  getChallengeStoreByChallengeId,
  generateRegionAwareJti,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getTenantIdFromContext,
  getPARRequestStoreByUri,
  parsePARRequestUri,
  // UI Configuration
  getUIConfig,
  buildUIUrl,
  shouldUseBuiltinForms,
  createConfigurationError,
  // Custom Redirect URIs (Authrim Extension)
  validateCustomRedirectParams,
  // Contract Loader (Human Auth / AI Ephemeral Auth two-layer model)
  filterResponseTypesByProfile,
  // Request-level caching (P0 KV Cache Optimization)
  getClientCached,
  loadTenantProfileCached,
  loadClientContractCached,
  // Database Adapter and Session-Client Repository (for implicit/hybrid logout support)
  D1Adapter,
  SessionClientRepository,
  // Logging
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';
import type { CachedUser, CachedConsent } from '@authrim/ar-lib-core';
import type { Session, PARRequestData } from '@authrim/ar-lib-core';
import type { PublicJWK, JWKS } from '@authrim/ar-lib-core';
import { isSigningJWK, isEncryptionJWK } from '@authrim/ar-lib-core';
import { validateAuthorizationDetails } from '@authrim/ar-lib-core';
import {
  generateSecureRandomString,
  parseToken,
  verifyToken,
  createAccessToken,
  createIDToken,
  calculateCHash,
  calculateAtHash,
  getTokenFormat,
  encryptJWT,
  type JWEAlgorithm,
  type JWEEncryption,
  extractDPoPProof,
  validateDPoPProof,
  calculateSessionState,
  extractOrigin,
  isInternalUrl,
  generateBrowserState,
  BROWSER_STATE_COOKIE_NAME,
  // Event System
  publishEvent,
  CONSENT_EVENTS,
  type ConsentEventData,
  // Cookie Configuration
  getSessionCookieSameSite,
  getBrowserStateCookieSameSite,
} from '@authrim/ar-lib-core';
import { SignJWT, importJWK, importPKCS8, compactDecrypt, type CryptoKey } from 'jose';
// NIST SP 800-63-4 Assurance Levels
import { type FAL } from '@authrim/ar-lib-core';

// ===== Key Caching for Performance Optimization =====
// Cache signing key to avoid expensive RSA key import (5-7ms) on every request
let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
let cachedKeyTimestamp = 0;
const KEY_CACHE_TTL = 60000; // 60 seconds

// ===== Module-level Logger for Helper Functions =====
const moduleLogger = createLogger().module('AUTHORIZE');

// ===== UI Redirect Result Type =====
/**
 * Result of determining UI redirect target
 */
type UIRedirectResult =
  | { type: 'redirect'; url: string }
  | { type: 'builtin'; fallbackPath: string }
  | { type: 'error'; response: Response };

/**
 * Determine UI redirect target based on conformance mode and configuration.
 *
 * Priority:
 * 1. Conformance mode enabled → use builtin forms
 * 2. UI configured → redirect to external UI
 * 3. Neither → return configuration error
 *
 * @param env - Environment bindings
 * @param path - UI path key (e.g., 'login', 'consent', 'error')
 * @param queryParams - Query parameters to append to URL
 * @param tenantHint - Optional tenant hint for branding (UX only, untrusted)
 * @returns UIRedirectResult indicating where to redirect
 */
async function getUIRedirectTarget(
  env: Env,
  path:
    | 'login'
    | 'consent'
    | 'reauth'
    | 'error'
    | 'device'
    | 'deviceAuthorize'
    | 'logoutComplete'
    | 'loggedOut'
    | 'register',
  queryParams?: Record<string, string>,
  tenantHint?: string
): Promise<UIRedirectResult> {
  // Check conformance mode first
  if (await shouldUseBuiltinForms(env)) {
    // Builtin forms - determine fallback path
    const fallbackPaths: Record<string, string> = {
      login: '/flow/login',
      consent: '/auth/consent',
      reauth: '/flow/confirm',
      error: '/error',
      device: '/device',
      deviceAuthorize: '/device/authorize',
      logoutComplete: '/logout-complete',
      loggedOut: '/logged-out',
      register: '/register',
    };
    return { type: 'builtin', fallbackPath: fallbackPaths[path] || '/error' };
  }

  // Check UI configuration
  const uiConfig = await getUIConfig(env);
  if (!uiConfig?.baseUrl) {
    // No UI configured and conformance mode disabled
    return {
      type: 'error',
      response: new Response(JSON.stringify(createConfigurationError()), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  // Build UI URL with optional query params and tenant hint
  const url = buildUIUrl(uiConfig, path, queryParams, tenantHint);
  return { type: 'redirect', url };
}

/**
 * Authorization Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 *
 * Handles authorization requests and returns authorization codes
 * Per OIDC Core 3.1.2.1: MUST support both GET and POST methods
 * RFC 9126: Supports request_uri parameter for PAR
 */
export async function authorizeHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AUTHORIZE');
  // Parse parameters from either GET (query string) or POST (form body)
  // OIDC Core 3.1.2.1: Authorization Servers MUST support the use of the HTTP GET and POST methods
  let response_type: string | undefined;
  let client_id: string | undefined;
  let redirect_uri: string | undefined;
  let scope: string | undefined;
  let state: string | undefined;
  let nonce: string | undefined;
  let code_challenge: string | undefined;
  let code_challenge_method: string | undefined;
  let claims: string | undefined;
  let authorization_details: string | undefined; // RFC 9396: Rich Authorization Requests
  let request_uri: string | undefined;
  let response_mode: string | undefined;
  let request: string | undefined; // RFC 9101: Request Object (JAR)
  let prompt: string | undefined;
  let max_age: string | undefined;
  let id_token_hint: string | undefined;
  let acr_values: string | undefined;
  let display: string | undefined;
  let ui_locales: string | undefined;
  let login_hint: string | undefined;
  let _confirmed: string | undefined;
  let _auth_time: string | undefined;
  let _session_user_id: string | undefined;
  // Phase 2-B RBAC extensions
  let org_id: string | undefined; // Target organization ID
  let acting_as: string | undefined; // Acting on behalf of user ID
  let _consent_confirmed: string | undefined; // Internal: consent was confirmed
  // Custom Redirect URIs (Authrim Extension)
  let error_uri: string | undefined; // Redirect on error
  let cancel_uri: string | undefined; // Redirect on user cancel

  if (c.req.method === 'POST') {
    // Parse POST body (application/x-www-form-urlencoded)
    try {
      const body = await c.req.parseBody();
      request_uri = typeof body.request_uri === 'string' ? body.request_uri : undefined;
      request = typeof body.request === 'string' ? body.request : undefined;
      response_type = typeof body.response_type === 'string' ? body.response_type : undefined;
      client_id = typeof body.client_id === 'string' ? body.client_id : undefined;
      redirect_uri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
      scope = typeof body.scope === 'string' ? body.scope : undefined;
      state = typeof body.state === 'string' ? body.state : undefined;
      nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
      code_challenge = typeof body.code_challenge === 'string' ? body.code_challenge : undefined;
      code_challenge_method =
        typeof body.code_challenge_method === 'string' ? body.code_challenge_method : undefined;
      claims = typeof body.claims === 'string' ? body.claims : undefined;
      authorization_details =
        typeof body.authorization_details === 'string' ? body.authorization_details : undefined;
      response_mode = typeof body.response_mode === 'string' ? body.response_mode : undefined;
      prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
      max_age = typeof body.max_age === 'string' ? body.max_age : undefined;
      id_token_hint = typeof body.id_token_hint === 'string' ? body.id_token_hint : undefined;
      acr_values = typeof body.acr_values === 'string' ? body.acr_values : undefined;
      display = typeof body.display === 'string' ? body.display : undefined;
      ui_locales = typeof body.ui_locales === 'string' ? body.ui_locales : undefined;
      login_hint = typeof body.login_hint === 'string' ? body.login_hint : undefined;
      _confirmed = typeof body._confirmed === 'string' ? body._confirmed : undefined;
      _auth_time = typeof body._auth_time === 'string' ? body._auth_time : undefined;
      _session_user_id =
        typeof body._session_user_id === 'string' ? body._session_user_id : undefined;
      // Phase 2-B RBAC extensions
      org_id = typeof body.org_id === 'string' ? body.org_id : undefined;
      acting_as = typeof body.acting_as === 'string' ? body.acting_as : undefined;
      _consent_confirmed =
        typeof body._consent_confirmed === 'string' ? body._consent_confirmed : undefined;
      // Custom Redirect URIs (Authrim Extension)
      error_uri = typeof body.error_uri === 'string' ? body.error_uri : undefined;
      cancel_uri = typeof body.cancel_uri === 'string' ? body.cancel_uri : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    // Parse GET query parameters
    request_uri = c.req.query('request_uri');
    request = c.req.query('request');
    response_type = c.req.query('response_type');
    client_id = c.req.query('client_id');
    redirect_uri = c.req.query('redirect_uri');
    scope = c.req.query('scope');
    state = c.req.query('state');
    nonce = c.req.query('nonce');
    code_challenge = c.req.query('code_challenge');
    code_challenge_method = c.req.query('code_challenge_method');
    claims = c.req.query('claims');
    authorization_details = c.req.query('authorization_details');
    response_mode = c.req.query('response_mode');
    prompt = c.req.query('prompt');
    max_age = c.req.query('max_age');
    id_token_hint = c.req.query('id_token_hint');
    acr_values = c.req.query('acr_values');
    display = c.req.query('display');
    ui_locales = c.req.query('ui_locales');
    login_hint = c.req.query('login_hint');
    _confirmed = c.req.query('_confirmed');
    _auth_time = c.req.query('_auth_time');
    _session_user_id = c.req.query('_session_user_id');
    // Phase 2-B RBAC extensions
    org_id = c.req.query('org_id');
    acting_as = c.req.query('acting_as');
    _consent_confirmed = c.req.query('_consent_confirmed');
    // Custom Redirect URIs (Authrim Extension)
    error_uri = c.req.query('error_uri') ?? undefined;
    cancel_uri = c.req.query('cancel_uri') ?? undefined;
  }

  // RFC 9126: If request_uri is present, fetch parameters from PAR storage
  // OIDC Core 6.2: Also support HTTPS request_uri (Request Object by Reference)
  if (request_uri) {
    // Check if this is a PAR request_uri (URN) or HTTPS request_uri
    const isPAR = request_uri.startsWith('urn:ietf:params:oauth:request_uri:');
    const isHTTPS = request_uri.startsWith('https://');

    if (!isPAR && !isHTTPS) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'request_uri must be either urn:ietf:params:oauth:request_uri: or https://',
        },
        400
      );
    }

    // Handle HTTPS request_uri (Request Object by Reference)
    // SECURITY: This feature is disabled by default to prevent SSRF attacks
    // Enable via SETTINGS KV (oidc.httpsRequestUri.enabled) or ENABLE_HTTPS_REQUEST_URI env var
    if (isHTTPS) {
      // Load HTTPS request_uri configuration from SETTINGS KV
      // Priority: SETTINGS KV > Environment variable > Default (disabled)
      let httpsRequestUriConfig: {
        enabled: boolean;
        allowedDomains: string[];
        timeoutMs: number;
        maxSizeBytes: number;
      } = {
        enabled: false,
        allowedDomains: [],
        timeoutMs: 5000,
        maxSizeBytes: 102400,
      };

      try {
        const settingsJson = await c.env.SETTINGS?.get('system_settings');
        if (settingsJson) {
          const settings = JSON.parse(settingsJson);
          const kvConfig = settings.oidc?.httpsRequestUri;
          if (kvConfig) {
            httpsRequestUriConfig = {
              enabled: kvConfig.enabled ?? false,
              allowedDomains: kvConfig.allowedDomains ?? [],
              timeoutMs: kvConfig.timeoutMs ?? 5000,
              maxSizeBytes: kvConfig.maxSizeBytes ?? 102400,
            };
          }
        }
      } catch (error) {
        log.error(
          'Failed to load HTTPS request_uri settings from KV',
          { action: 'settings_load' },
          error as Error
        );
      }

      // Fall back to environment variables if not configured in KV
      if (!httpsRequestUriConfig.enabled) {
        httpsRequestUriConfig.enabled = c.env.ENABLE_HTTPS_REQUEST_URI === 'true';
      }
      if (httpsRequestUriConfig.allowedDomains.length === 0) {
        const allowedDomainsStr = c.env.HTTPS_REQUEST_URI_ALLOWED_DOMAINS || '';
        httpsRequestUriConfig.allowedDomains = allowedDomainsStr
          ? allowedDomainsStr.split(',').map((d) => d.trim().toLowerCase())
          : [];
      }
      if (c.env.HTTPS_REQUEST_URI_TIMEOUT_MS) {
        httpsRequestUriConfig.timeoutMs = parseInt(c.env.HTTPS_REQUEST_URI_TIMEOUT_MS, 10);
      }
      if (c.env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES) {
        httpsRequestUriConfig.maxSizeBytes = parseInt(c.env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES, 10);
      }

      if (!httpsRequestUriConfig.enabled) {
        return c.json(
          {
            error: 'request_uri_not_supported',
            error_description:
              'HTTPS request_uri is disabled. Use PAR (RFC 9126) with urn:ietf:params:oauth:request_uri: format instead.',
          },
          400
        );
      }

      // Security controls for HTTPS request_uri
      const allowedDomains = httpsRequestUriConfig.allowedDomains;
      const timeoutMs = httpsRequestUriConfig.timeoutMs;
      const maxSizeBytes = httpsRequestUriConfig.maxSizeBytes;

      // Validate URL and extract domain
      let requestUrl: URL;
      try {
        requestUrl = new URL(request_uri);
      } catch {
        return c.json(
          {
            error: 'invalid_request_uri',
            error_description: 'Invalid URL format for request_uri',
          },
          400
        );
      }

      // Validate domain against allowlist (if configured)
      if (allowedDomains.length > 0) {
        const requestDomain = requestUrl.hostname.toLowerCase();
        const isDomainAllowed = allowedDomains.some(
          (allowed) => requestDomain === allowed || requestDomain.endsWith('.' + allowed)
        );

        if (!isDomainAllowed) {
          log.warn('SSRF prevention: Rejected request_uri domain', {
            action: 'ssrf_block',
            domain: requestDomain,
            allowedDomains: allowedDomains.join(', '),
          });
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: 'request_uri domain is not in the allowed list',
            },
            400
          );
        }
      }

      // Prevent SSRF to localhost/internal IPs
      if (isInternalUrl(requestUrl)) {
        log.warn('SSRF prevention: Blocked request_uri to internal address', {
          action: 'ssrf_block',
          hostname: requestUrl.hostname,
        });
        return c.json(
          {
            error: 'invalid_request_uri',
            error_description: 'request_uri cannot point to internal addresses',
          },
          400
        );
      }

      try {
        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Fetch the Request Object from the URL with security controls
        // Allow redirects but validate final URL (OIDF Conformance Suite uses redirects)
        const requestObjectResponse = await fetch(request_uri, {
          method: 'GET',
          headers: {
            Accept: 'application/oauth-authz-req+jwt, application/jwt',
          },
          signal: controller.signal,
          redirect: 'follow', // Follow redirects (OIDF uses 302)
        });

        clearTimeout(timeoutId);

        // Security: Validate redirected URL domain is still in allowed list
        if (requestObjectResponse.url && requestObjectResponse.url !== request_uri) {
          try {
            const finalUrl = new URL(requestObjectResponse.url);
            const finalDomain = finalUrl.hostname.toLowerCase();
            if (allowedDomains.length > 0) {
              const isFinalDomainAllowed = allowedDomains.some(
                (allowed) => finalDomain === allowed || finalDomain.endsWith('.' + allowed)
              );
              if (!isFinalDomainAllowed) {
                log.warn('SSRF prevention: Rejected redirect to disallowed domain', {
                  action: 'ssrf_block',
                  domain: finalDomain,
                  allowedDomains: allowedDomains.join(', '),
                });
                return c.json(
                  {
                    error: 'invalid_request_uri',
                    error_description: 'Redirected request_uri domain is not in the allowed list',
                  },
                  400
                );
              }
            }
            // Also check if redirected to internal URL
            if (isInternalUrl(finalUrl)) {
              log.warn('SSRF prevention: Blocked redirect to internal address', {
                action: 'ssrf_block',
                hostname: finalUrl.hostname,
              });
              return c.json(
                {
                  error: 'invalid_request_uri',
                  error_description: 'request_uri cannot redirect to internal addresses',
                },
                400
              );
            }
          } catch {
            // URL parsing failed - should not happen for valid redirect
          }
        }

        if (!requestObjectResponse.ok) {
          log.error('Failed to fetch request_uri', {
            action: 'request_uri_fetch',
            httpStatus: requestObjectResponse.status,
            statusText: requestObjectResponse.statusText,
          });
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: 'Failed to fetch request object from request_uri',
            },
            400
          );
        }

        // Check Content-Length header first
        const contentLength = requestObjectResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: `Response too large: ${contentLength} bytes exceeds limit of ${maxSizeBytes} bytes`,
            },
            400
          );
        }

        // Read response with size limit
        const reader = requestObjectResponse.body?.getReader();
        if (!reader) {
          return c.json(
            {
              error: 'invalid_request_uri',
              error_description: 'Failed to read response body',
            },
            400
          );
        }

        const chunks: Uint8Array[] = [];
        let totalSize = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalSize += value.length;
          if (totalSize > maxSizeBytes) {
            reader.cancel();
            return c.json(
              {
                error: 'invalid_request_uri',
                error_description: `Response too large: exceeds limit of ${maxSizeBytes} bytes`,
              },
              400
            );
          }
          chunks.push(value);
        }

        // Combine chunks into a single buffer and decode
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const requestObject = new TextDecoder().decode(combined);

        // Use the fetched Request Object as if it was the 'request' parameter
        request = requestObject;
        // Continue to request parameter processing below
        request_uri = undefined; // Clear request_uri to avoid PAR processing
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isTimeout = errorMessage.includes('abort') || errorMessage.includes('timeout');
        log.error(
          'Failed to fetch request_uri',
          { action: 'request_uri_fetch', isTimeout },
          error as Error
        );
        return c.json(
          {
            error: 'invalid_request_uri',
            error_description: isTimeout
              ? `Request timed out after ${timeoutMs}ms`
              : 'Failed to fetch request object from request_uri',
          },
          400
        );
      }
    }

    // Handle PAR request_uri (URN format)
    if (isPAR) {
      // Retrieve request parameters atomically (issue #11: single-use guarantee)
      // Try DO first, fall back to KV
      let parsedData: {
        client_id: string;
        response_type: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        claims?: string;
        response_mode?: string;
      } | null = null;

      if (!c.env.PAR_REQUEST_STORE) {
        return c.json(
          {
            error: 'server_error',
            error_description: 'PAR request storage unavailable',
          },
          500
        );
      }

      // Try to parse as region-sharded request_uri (new format)
      // Format: urn:ietf:params:oauth:request_uri:g{gen}:{region}:{shard}:par_{uuid}
      const parsedPar = parsePARRequestUri(request_uri!);

      try {
        let consumed: PARRequestData;

        if (parsedPar) {
          // New region-sharded format: route via embedded shard info
          const { stub } = getPARRequestStoreByUri(c.env, request_uri!, 'default');
          consumed = (await stub.consumeRequestRpc({
            requestUri: request_uri!,
            client_id: client_id || '', // May be empty for new format
          })) as PARRequestData;
        } else {
          // Legacy format: route via client_id
          if (!client_id) {
            return c.json(
              {
                error: 'invalid_request',
                error_description: 'client_id required for legacy PAR format',
              },
              400
            );
          }
          const id = c.env.PAR_REQUEST_STORE.idFromName(client_id);
          const stub = c.env.PAR_REQUEST_STORE.get(id);
          consumed = (await stub.consumeRequestRpc({
            requestUri: request_uri!,
            client_id: client_id,
          })) as PARRequestData;
        }

        // Map PARRequestData to the expected format
        parsedData = {
          client_id: consumed.client_id,
          response_type: consumed.response_type || 'code',
          redirect_uri: consumed.redirect_uri,
          scope: consumed.scope,
          state: consumed.state,
          nonce: consumed.nonce,
          code_challenge: consumed.code_challenge,
          code_challenge_method: consumed.code_challenge_method,
          claims: consumed.claims,
          response_mode: undefined,
        };
      } catch {
        // RPC error (invalid/expired request_uri)
        parsedData = null;
      }

      if (!parsedData) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid or expired request_uri',
          },
          400
        );
      }

      // Type assertion to help TypeScript understand parsedData is non-null after null check
      const parData: {
        client_id: string;
        response_type: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        nonce?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        claims?: string;
        response_mode?: string;
        authorization_details?: string; // RFC 9396: Rich Authorization Requests
      } = parsedData;

      try {
        // RFC 9126: When using request_uri, client_id from query MUST match client_id from PAR
        if (client_id && client_id !== parData.client_id) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'client_id mismatch',
            },
            400
          );
        }

        // Load parameters from PAR request
        response_type = parData.response_type;
        client_id = parData.client_id;
        redirect_uri = parData.redirect_uri;
        scope = parData.scope;
        state = parData.state;
        nonce = parData.nonce;
        code_challenge = parData.code_challenge;
        code_challenge_method = parData.code_challenge_method;
        claims = parData.claims;
        authorization_details = parData.authorization_details; // RFC 9396 RAR
        response_mode = parData.response_mode;
      } catch {
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to process request_uri',
          },
          500
        );
      }
    }
  }

  // RFC 9101 (JAR): If request parameter is present, parse JWT request object
  if (request) {
    try {
      let requestObjectClaims: Record<string, unknown> | undefined;

      // Check if request is JWE (encrypted) or JWT (signed)
      let tokenFormat = getTokenFormat(request);

      if (tokenFormat === 'unknown') {
        return c.json(
          {
            error: 'invalid_request_object',
            error_description: 'Request object must be a valid JWT or JWE',
          },
          400
        );
      }

      // Step 1: Decrypt JWE if needed (RFC 9101 Section 6.1)
      let jwtRequest = request;
      if (tokenFormat === 'jwe') {
        // JWE: Decrypt using server's private key
        const privateKeyPem = c.env.PRIVATE_KEY_PEM;
        if (!privateKeyPem) {
          return c.json(
            {
              error: 'server_error',
              error_description: 'Server private key not configured',
            },
            500
          );
        }

        const privateKey = await importPKCS8(privateKeyPem, 'RS256');

        try {
          // Decrypt JWE to get inner JWT/payload
          const { plaintext } = await compactDecrypt(request, privateKey);
          const decoder = new TextDecoder();
          const decrypted = decoder.decode(plaintext);

          // Check if decrypted content is a JWT (needs verification) or direct JSON payload
          if (decrypted.startsWith('{')) {
            // Direct JSON payload
            requestObjectClaims = JSON.parse(decrypted) as Record<string, unknown>;
          } else {
            // Nested JWT - need to verify signature
            jwtRequest = decrypted;
            tokenFormat = getTokenFormat(jwtRequest);
            // Continue to JWT verification below
          }
        } catch (decryptError) {
          log.error(
            'Failed to decrypt JWE request object',
            { action: 'jwe_decrypt' },
            decryptError as Error
          );
          return c.json(
            {
              error: 'invalid_request_object',
              error_description: 'Failed to decrypt request object',
            },
            400
          );
        }
      }

      // Step 2: Verify JWT signature (if not already decrypted to payload)
      if (tokenFormat === 'jwt') {
        // Parse JWT header to check algorithm
        const parts = jwtRequest.split('.');
        const base64url = parts[0];
        const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        const header = JSON.parse(atob(base64));
        const alg = header.alg;

        if (alg === 'none') {
          // SECURITY: Block alg=none in production environment regardless of settings
          // This is a critical security measure to prevent unsigned JWT attacks
          const isProduction =
            c.env.ENVIRONMENT === 'production' || c.env.NODE_ENV === 'production';

          if (isProduction) {
            log.error(
              'SECURITY CRITICAL: Blocked unsigned request object (alg=none) in production',
              { action: 'security_block', algorithm: 'none' }
            );
            return c.json(
              {
                error: 'invalid_request_object',
                error_description:
                  'Unsigned request objects (alg=none) are not permitted in production',
              },
              400
            );
          }

          // Check if 'none' algorithm is allowed (read from KV settings)
          // Only applies to non-production environments
          const settingsJson = await c.env.SETTINGS?.get('system_settings');
          const settings = settingsJson ? JSON.parse(settingsJson) : {};
          const allowNoneAlgorithm = settings.oidc?.allowNoneAlgorithm ?? false;

          if (!allowNoneAlgorithm) {
            log.warn('Rejected unsigned request object (alg=none) - not allowed in configuration', {
              action: 'security_block',
              algorithm: 'none',
            });
            return c.json(
              {
                error: 'invalid_request_object',
                error_description:
                  'Unsigned request objects (alg=none) are not allowed in this environment',
              },
              400
            );
          }

          // Unsigned request object - just parse without verification
          // Note: This is ONLY allowed in development/testing environments
          log.warn('Using unsigned request object (alg=none) - development/testing only', {
            action: 'security_warning',
            algorithm: 'none',
          });
          requestObjectClaims = parseToken(jwtRequest) as Record<string, unknown>;
        } else {
          // Signed request object - verify using client's public key
          // Get client metadata to retrieve jwks or jwks_uri
          if (!client_id) {
            return c.json(
              {
                error: 'invalid_request',
                error_description: 'client_id is required when using signed request objects',
              },
              400
            );
          }

          const clientResult = await getClientCached(c, c.env, client_id);
          if (!clientResult) {
            return c.json(
              {
                error: 'invalid_client',
                error_description: 'Client authentication failed',
              },
              401
            );
          }

          let publicKey: CryptoKey;

          // Try to get public key from client's jwks
          if (
            clientResult.jwks &&
            typeof clientResult.jwks === 'object' &&
            clientResult.jwks !== null &&
            'keys' in clientResult.jwks &&
            Array.isArray(clientResult.jwks.keys)
          ) {
            // Find a suitable key for signature verification
            const signingKey = (clientResult.jwks.keys as PublicJWK[]).find((key) =>
              isSigningJWK(key)
            );

            if (!signingKey) {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'No suitable signing key found in client jwks',
                },
                400
              );
            }

            publicKey = (await importJWK(signingKey, alg)) as CryptoKey;
          } else if (clientResult.jwks_uri && typeof clientResult.jwks_uri === 'string') {
            // Fetch JWKS from jwks_uri
            // SSRF protection: Block requests to internal addresses
            if (isInternalUrl(clientResult.jwks_uri)) {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'jwks_uri cannot point to internal addresses',
                },
                400
              );
            }

            try {
              const jwksResponse = await fetch(clientResult.jwks_uri);
              if (!jwksResponse.ok) {
                return c.json(
                  {
                    error: 'invalid_request_object',
                    error_description: 'Failed to fetch client jwks_uri',
                  },
                  400
                );
              }

              const jwks = (await jwksResponse.json()) as JWKS;
              const signingKey = jwks.keys.find((key) => isSigningJWK(key));

              if (!signingKey) {
                return c.json(
                  {
                    error: 'invalid_request_object',
                    error_description: 'No suitable signing key found in client jwks_uri',
                  },
                  400
                );
              }

              publicKey = (await importJWK(signingKey, alg)) as CryptoKey;
            } catch (fetchError) {
              log.error('Failed to fetch jwks_uri', { action: 'jwks_fetch' }, fetchError as Error);
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'Failed to fetch client jwks_uri',
                },
                400
              );
            }
          } else {
            // Fallback: Use server's public key (for backward compatibility)
            // This should be removed in production
            const publicJwkJson = c.env.PUBLIC_JWK_JSON;
            if (!publicJwkJson) {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'No client public key available for verification',
                },
                400
              );
            }

            let publicJwk;
            try {
              publicJwk = JSON.parse(publicJwkJson);
            } catch {
              return c.json(
                {
                  error: 'server_error',
                  error_description: 'Server configuration error',
                },
                500
              );
            }

            publicKey = (await importJWK(publicJwk, alg)) as CryptoKey;
          }

          // Verify the signature
          // OIDC Core 6.1: For client-signed request objects:
          // - iss = client_id (the client is the issuer)
          // - aud = OP's issuer URL (the OP is the audience)
          const verified = await verifyToken(jwtRequest, publicKey, client_id, {
            audience: c.env.ISSUER_URL,
          });
          requestObjectClaims = verified as Record<string, unknown>;
        }
      }

      // Override parameters with those from request object
      // Per OIDC Core 6.1: request object parameters take precedence
      if (requestObjectClaims) {
        // OIDC Core 6.1: redirect_uri is REQUIRED in the request object
        if (!requestObjectClaims.redirect_uri) {
          return c.json(
            {
              error: 'invalid_request_object',
              error_description: 'redirect_uri is required in request object',
            },
            400
          );
        }

        // If redirect_uri was also provided as a query parameter, it must match
        const queryRedirectUri = redirect_uri;
        const requestObjectRedirectUri = requestObjectClaims.redirect_uri as string;

        if (queryRedirectUri && queryRedirectUri !== requestObjectRedirectUri) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'redirect_uri mismatch between query parameter and request object',
            },
            400
          );
        }

        if (requestObjectClaims.response_type)
          response_type = requestObjectClaims.response_type as string;
        if (requestObjectClaims.client_id) client_id = requestObjectClaims.client_id as string;
        redirect_uri = requestObjectRedirectUri;
        if (requestObjectClaims.scope) scope = requestObjectClaims.scope as string;
        if (requestObjectClaims.state) state = requestObjectClaims.state as string;
        if (requestObjectClaims.nonce) nonce = requestObjectClaims.nonce as string;
        if (requestObjectClaims.code_challenge)
          code_challenge = requestObjectClaims.code_challenge as string;
        if (requestObjectClaims.code_challenge_method)
          code_challenge_method = requestObjectClaims.code_challenge_method as string;
        if (requestObjectClaims.claims) claims = requestObjectClaims.claims as string;
        if (requestObjectClaims.response_mode)
          response_mode = requestObjectClaims.response_mode as string;
        if (requestObjectClaims.prompt) prompt = requestObjectClaims.prompt as string;
        if (requestObjectClaims.max_age) max_age = requestObjectClaims.max_age as string;
        if (requestObjectClaims.id_token_hint)
          id_token_hint = requestObjectClaims.id_token_hint as string;
        if (requestObjectClaims.acr_values) acr_values = requestObjectClaims.acr_values as string;
        if (requestObjectClaims.display) display = requestObjectClaims.display as string;
        if (requestObjectClaims.ui_locales) ui_locales = requestObjectClaims.ui_locales as string;
        if (requestObjectClaims.login_hint) login_hint = requestObjectClaims.login_hint as string;
      }
    } catch (error) {
      log.error(
        'Failed to parse request object',
        { action: 'request_object_parse' },
        error as Error
      );
      return c.json(
        {
          error: 'invalid_request_object',
          error_description: 'Failed to parse or verify request object',
        },
        400
      );
    }
  }

  // Validate response_type
  // RFC 6749 Section 4.1.2.1:
  // - invalid_request: missing required parameter (response_type is absent)
  // - unsupported_response_type: response_type value is not supported
  if (!response_type) {
    // response_type is missing - use invalid_request per RFC 6749
    const uiTarget = await getUIRedirectTarget(c.env, 'error', {
      error: 'invalid_request',
      error_description: 'response_type is required',
    });
    if (uiTarget.type === 'redirect') {
      return c.redirect(uiTarget.url, 302);
    } else if (uiTarget.type === 'error') {
      return uiTarget.response;
    }
    // Builtin forms - return JSON error (no UI error page in conformance mode for this case)
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'response_type is required',
      },
      400
    );
  }

  const responseTypeValidation = validateResponseType(response_type);
  if (!responseTypeValidation.valid) {
    // response_type is present but unsupported - use unsupported_response_type
    const uiTarget = await getUIRedirectTarget(c.env, 'error', {
      error: 'unsupported_response_type',
      error_description: responseTypeValidation.error || 'Unsupported response_type',
    });
    if (uiTarget.type === 'redirect') {
      return c.redirect(uiTarget.url, 302);
    } else if (uiTarget.type === 'error') {
      return uiTarget.response;
    }
    // Builtin forms - return JSON error
    return c.json(
      {
        error: 'unsupported_response_type',
        error_description: responseTypeValidation.error,
      },
      400
    );
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: clientIdValidation.error,
      },
      400
    );
  }

  // Validate max_age if provided (OIDC Core 3.1.2.1)
  // max_age MUST be a non-negative integer
  if (max_age) {
    const maxAgeInt = parseInt(max_age, 10);
    if (Number.isNaN(maxAgeInt) || maxAgeInt < 0 || !/^\d+$/.test(max_age)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'max_age must be a non-negative integer',
        },
        400
      );
    }
  }

  // Type narrowing: client_id is guaranteed to be a string at this point
  const validClientId: string = client_id as string;

  // Fetch client metadata to validate redirect_uri (request-level cached)
  const clientMetadata = await getClientCached(c, c.env, validClientId);
  if (!clientMetadata) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      },
      401
    );
  }

  // Profile-based response_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // AI Ephemeral profile restricts implicit/hybrid flows to 'code' only for MCP User Delegation
  const tenantId = (clientMetadata.tenant_id as string) || 'default';
  const tenantProfile = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId);
  const profileAllowedResponseTypes = filterResponseTypesByProfile(
    ['code', 'id_token', 'id_token token', 'code id_token', 'code token', 'code id_token token'],
    tenantProfile
  );
  if (!profileAllowedResponseTypes.includes(response_type!)) {
    return c.json(
      {
        error: 'unauthorized_client',
        error_description: `Response type '${response_type}' is not allowed for this tenant profile. Allowed: ${profileAllowedResponseTypes.join(', ')}`,
      },
      400
    );
  }

  // VG-006: Validate response_type against client's allowed response_types
  // RFC 7591 Section 2: response_types defaults to ["code"] if not specified
  const clientResponseTypes = (clientMetadata.response_types as string[] | undefined) || ['code'];
  if (!clientResponseTypes.includes(response_type!)) {
    return c.json(
      {
        error: 'unauthorized_client',
        error_description: `Response type '${response_type}' is not allowed for this client. Allowed: ${clientResponseTypes.join(', ')}`,
      },
      400
    );
  }

  // Load FAPI 2.0 configuration from SETTINGS KV
  interface FAPIConfig {
    enabled?: boolean;
    allowPublicClients?: boolean;
    /** Strict DPoP enforcement mode */
    strictDPoP?: boolean;
  }
  interface OIDCConfig {
    requirePar?: boolean;
    /** RFC 9396: Rich Authorization Requests */
    rar?: { enabled: boolean };
    /** Supported ACR values */
    supportedAcrValues?: string[];
  }
  let fapiConfig: FAPIConfig = {};
  let oidcConfig: OIDCConfig = {};
  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      fapiConfig = settings.fapi || {};
      oidcConfig = settings.oidc || {};
    }
  } catch (error) {
    log.error(
      'Failed to load FAPI settings from KV',
      { action: 'fapi_settings_load' },
      error as Error
    );
    // Continue with default values (FAPI disabled)
  }

  // FAPI 2.0 Security Profile validation
  if (fapiConfig.enabled) {
    // FAPI 2.0 SHALL reject authorization requests sent without PAR
    const requirePar = oidcConfig.requirePar !== false; // Default to true in FAPI mode
    const usedPAR = request_uri && request_uri.startsWith('urn:ietf:params:oauth:request_uri:');

    if (requirePar && !usedPAR) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PAR is required in FAPI 2.0 mode. Use /par endpoint first.',
        },
        400
      );
    }

    // FAPI 2.0 SHALL only support confidential clients (unless explicitly allowed)
    const allowPublicClients = fapiConfig.allowPublicClients !== false;
    const isPublicClient = !clientMetadata.client_secret_hash;

    if (!allowPublicClients && isPublicClient) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Public clients are not allowed in FAPI 2.0 mode',
        },
        400
      );
    }

    // FAPI 2.0 SHALL require PKCE with S256
    // Exception: response_type=none does not issue authorization code, so PKCE is not required
    if (response_type !== 'none' && (!code_challenge || code_challenge_method !== 'S256')) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PKCE with S256 is required in FAPI 2.0 mode',
        },
        400
      );
    }
  }

  // OAuth 2.0 Section 3.1.2.3: Handle redirect_uri based on registration
  // Must be done BEFORE format validation to support default redirect_uri
  const registeredRedirectUrisForDefault = clientMetadata.redirect_uris as string[] | undefined;
  if (
    !redirect_uri &&
    registeredRedirectUrisForDefault &&
    Array.isArray(registeredRedirectUrisForDefault)
  ) {
    if (registeredRedirectUrisForDefault.length === 1) {
      // Only one registered - use as default (redirect_uri parameter is optional)
      redirect_uri = registeredRedirectUrisForDefault[0];
      log.info('Using default redirect_uri', {
        action: 'redirect_uri_default',
        redirectUri: redirect_uri,
      });
    } else if (registeredRedirectUrisForDefault.length > 1) {
      // Multiple registered - redirect_uri is required
      return c.html(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Missing Redirect URI</title>
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
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Missing Redirect URI</h1>
    <p>The redirect_uri parameter is required when the client has multiple registered redirect URIs.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> redirect_uri is required when multiple redirect URIs are registered
    </div>
    <p>Please include the redirect_uri parameter in your authorization request.</p>
  </div>
</body>
</html>`,
        400
      );
    }
  }

  // Validate redirect_uri format (allow http for development)
  const allowHttp = c.env.ENABLE_HTTP_REDIRECT === 'true';
  const redirectUriValidation = validateRedirectUri(redirect_uri, allowHttp);
  if (!redirectUriValidation.valid) {
    // Invalid redirect_uri format - cannot redirect, must show error page
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Redirect URI</title>
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
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Invalid Redirect URI</h1>
    <p>The redirect URI provided in the authorization request is invalid.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> ${redirectUriValidation.error}
    </div>
    <p>Please contact the application developer to resolve this issue.</p>
  </div>
</body>
</html>`,
      400
    );
  }

  // Check if redirect_uri is registered for this client
  // Per OAuth 2.0 Section 3.1.2.3: redirect_uri MUST match one of the registered redirect URIs
  const registeredRedirectUris = clientMetadata.redirect_uris as string[] | undefined;
  if (
    !registeredRedirectUris ||
    !Array.isArray(registeredRedirectUris) ||
    registeredRedirectUris.length === 0
  ) {
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Client Configuration Error</title>
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
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Client Configuration Error</h1>
    <p>The client application has not registered any redirect URIs.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_client<br>
      <strong>Description:</strong> Client has no registered redirect URIs
    </div>
    <p>Please contact the application developer to resolve this issue.</p>
  </div>
</body>
</html>`,
      400
    );
  }

  // Check if the provided redirect_uri matches one of the registered URIs
  // Note: redirect_uri default handling is done earlier (before format validation)
  // RFC 6749 Section 3.1.2.3: Use URL normalization for secure comparison
  // to prevent Open Redirect attacks via URL manipulation
  const redirectUriMatches = isRedirectUriRegistered(
    redirect_uri as string,
    registeredRedirectUris
  );
  if (!redirectUriMatches) {
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unregistered Redirect URI</title>
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
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #d32f2f;
    }
    p {
      margin: 0 0 1rem 0;
      color: #666;
      line-height: 1.5;
    }
    .error-code {
      background: #f5f5f5;
      padding: 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Unregistered Redirect URI</h1>
    <p>The redirect URI provided in the authorization request is not registered for this client application.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> redirect_uri is not registered for this client<br>
      <strong>Provided URI:</strong> ${redirect_uri || '(none)'}
    </div>
    <p>Please contact the application developer to register the redirect URI or use a registered redirect URI.</p>
  </div>
</body>
</html>`,
      400
    );
  }

  // From here on, we have a valid and registered redirect_uri, so errors should be returned via redirect
  // Type narrowing: redirect_uri is guaranteed to be a string at this point
  const validRedirectUri: string = redirect_uri as string;

  // ==========================================================================
  // Custom Redirect URIs Validation (Authrim Extension)
  // ==========================================================================
  // Get allowed_redirect_origins from client metadata (already an array from getClient)
  const allowedRedirectOrigins = clientMetadata.allowed_redirect_origins ?? [];

  // Validate error_uri and cancel_uri if provided
  let validatedErrorUri: string | undefined;
  let validatedCancelUri: string | undefined;

  if (error_uri || cancel_uri) {
    const customRedirectValidation = validateCustomRedirectParams(
      { error_uri, cancel_uri },
      validRedirectUri,
      allowedRedirectOrigins
    );

    if (!customRedirectValidation.valid) {
      // Return HTML error page (cannot redirect to invalid URI)
      const errorMessages = Object.entries(customRedirectValidation.errors)
        .map(([key, msg]) => `${key}: ${msg}`)
        .join(', ');
      return c.html(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Custom Redirect URI</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); max-width: 500px; width: 100%; }
    h1 { margin: 0 0 1rem 0; font-size: 1.5rem; color: #d32f2f; }
    p { margin: 0 0 1rem 0; color: #666; line-height: 1.5; }
    .error-code { background: #f5f5f5; padding: 0.5rem; border-radius: 4px; font-family: monospace; font-size: 0.875rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Invalid Custom Redirect URI</h1>
    <p>The custom redirect URI provided is not allowed for this client.</p>
    <div class="error-code">
      <strong>Error:</strong> invalid_request<br>
      <strong>Description:</strong> ${errorMessages}
    </div>
    <p>Please ensure custom redirect URIs are same-origin with redirect_uri or pre-registered in allowed_redirect_origins.</p>
  </div>
</body>
</html>`,
        400
      );
    }

    validatedErrorUri = customRedirectValidation.validatedUris?.error_uri;
    validatedCancelUri = customRedirectValidation.validatedUris?.cancel_uri;
  }

  // Helper to send error - uses error_uri if provided
  const sendError = (
    error: string,
    description?: string,
    overrideState: string | undefined = state
  ) =>
    redirectWithError(c, validRedirectUri, error, description, overrideState, {
      responseMode: response_mode,
      responseType: response_type,
      clientId: validClientId,
      errorUri: validatedErrorUri,
    });

  // Validate scope
  const scopeValidation = validateScope(scope);
  if (!scopeValidation.valid) {
    return sendError('invalid_scope', scopeValidation.error);
  }

  // ==========================================================================
  // DCR Scope Restriction Check (RFC 7591 extension)
  // If client has requestable_scopes whitelist, verify all requested scopes
  // are in that list. This prevents clients from requesting unauthorized scopes.
  // ==========================================================================
  if (clientMetadata.requestable_scopes && clientMetadata.requestable_scopes.length > 0 && scope) {
    const requestableSet = new Set(clientMetadata.requestable_scopes);
    const requestedScopes = scope.split(' ').filter((s) => s.length > 0);
    const disallowedScopes = requestedScopes.filter((s) => !requestableSet.has(s));

    if (disallowedScopes.length > 0) {
      return sendError(
        'invalid_scope',
        `Client is not authorized to request scope(s): ${disallowedScopes.join(', ')}. ` +
          `Allowed scopes: ${clientMetadata.requestable_scopes.join(', ')}`
      );
    }
  }

  // RFC 9396: Rich Authorization Requests (RAR) validation
  // Check if RAR is enabled via Feature Flag
  const rarEnabled = oidcConfig.rar?.enabled ?? c.env.ENABLE_RAR === 'true';
  if (authorization_details) {
    if (!rarEnabled) {
      // RAR is not enabled for this tenant
      return sendError(
        'invalid_request',
        'authorization_details parameter is not supported. Enable RAR feature to use Rich Authorization Requests.'
      );
    }

    // Parse and validate authorization_details
    try {
      const parsedDetails = JSON.parse(authorization_details);
      const rarValidation = validateAuthorizationDetails(parsedDetails, {
        allowedTypes: ['ai_agent_action', 'payment_initiation', 'account_information'],
      });

      if (!rarValidation.valid) {
        const errorMessage = rarValidation.errors?.[0]?.message || 'Invalid authorization_details';
        return sendError('invalid_authorization_details', errorMessage);
      }

      // Use sanitized version
      authorization_details = JSON.stringify(rarValidation.sanitized);
    } catch {
      return sendError('invalid_authorization_details', 'authorization_details must be valid JSON');
    }
  }

  // Check if state parameter is required (configurable via KV)
  const configManager = createOAuthConfigManager(c.env);
  const stateRequired = await configManager.isStateRequired();

  // Validate state (conditionally required based on configuration)
  // SECURITY: response_type=none ALWAYS requires state for CSRF protection
  // (used for session checks, state prevents cross-site request forgery)
  const isNoneResponseTypeForState = response_type === 'none';
  if ((stateRequired || isNoneResponseTypeForState) && (!state || state.trim().length === 0)) {
    return sendError('invalid_request', 'state parameter is required (CSRF protection)');
  }
  const stateValidation = validateState(state);
  if (!stateValidation.valid) {
    return sendError('invalid_request', stateValidation.error);
  }

  // Validate nonce (optional for code flow, required for implicit/hybrid flows)
  const nonceValidation = validateNonce(nonce);
  if (!nonceValidation.valid) {
    return sendError('invalid_request', nonceValidation.error);
  }

  // Per OIDC Core 3.2.2.1 and 3.3.2.11: nonce is REQUIRED when id_token is returned directly
  // from the authorization endpoint (Implicit and Hybrid flows with id_token)
  // - code: nonce optional (id_token returned from token endpoint)
  // - code token: nonce optional (id_token returned from token endpoint)
  // - id_token: nonce REQUIRED (id_token returned directly)
  // - id_token token: nonce REQUIRED (id_token returned directly)
  // - code id_token: nonce REQUIRED (id_token returned directly)
  // - code id_token token: nonce REQUIRED (id_token returned directly)
  const nonceCheckResponseTypes = response_type!.split(/\s+/);
  const nonceCheckIncludesIdToken = nonceCheckResponseTypes.includes('id_token');
  const requiresNonce = nonceCheckIncludesIdToken;
  if (requiresNonce && !nonce) {
    return sendError('invalid_request', 'nonce is required when response_type contains id_token');
  }

  // Validate response_mode (optional)
  // Supported modes: query, fragment, form_post, and their JWT variants (JARM)
  if (response_mode) {
    const supportedResponseModes = [
      'query',
      'fragment',
      'form_post',
      'query.jwt',
      'fragment.jwt',
      'form_post.jwt',
      'jwt', // Generic JWT mode (defaults to fragment for implicit/hybrid, query for code)
    ];
    if (!supportedResponseModes.includes(response_mode)) {
      return sendError(
        'invalid_request',
        `Unsupported response_mode. Supported modes: ${supportedResponseModes.join(', ')}`
      );
    }

    // Extract base mode and JWT flag
    const baseMode = response_mode.replace('.jwt', '');
    const isJARM = response_mode.includes('.jwt') || response_mode === 'jwt';

    // Validate response_mode compatibility with response_type
    // Per OIDC Core 3.3.2.5: For response_type=code only, fragment is not allowed
    // For hybrid flows (code + token/id_token), fragment is required by default
    if (response_type === 'code' && baseMode === 'fragment') {
      return sendError(
        'invalid_request',
        'response_mode=fragment is not compatible with response_type=code'
      );
    }
  }

  // Validate claims parameter (optional, per OIDC Core 5.5)
  if (claims) {
    try {
      const parsedClaims: unknown = JSON.parse(claims);

      // Validate claims structure
      if (
        typeof parsedClaims !== 'object' ||
        parsedClaims === null ||
        Array.isArray(parsedClaims)
      ) {
        return sendError('invalid_request', 'claims parameter must be a JSON object');
      }

      // Validate that claims object contains valid sections (userinfo and/or id_token)
      const validSections = ['userinfo', 'id_token'];
      const claimsSections = Object.keys(parsedClaims as Record<string, unknown>);

      if (claimsSections.length === 0) {
        return sendError(
          'invalid_request',
          'claims parameter must contain at least one of: userinfo, id_token'
        );
      }

      for (const section of claimsSections) {
        if (!validSections.includes(section)) {
          return sendError(
            'invalid_request',
            `Invalid claims section: ${section}. Must be one of: ${validSections.join(', ')}`
          );
        }

        // Validate section contains an object
        const claimsObj = parsedClaims as Record<string, unknown>;
        if (typeof claimsObj[section] !== 'object' || claimsObj[section] === null) {
          return sendError('invalid_request', `claims.${section} must be an object`);
        }
      }
    } catch {
      return sendError('invalid_request', 'claims parameter must be valid JSON');
    }
  }

  // Validate PKCE parameters if provided
  if (code_challenge) {
    if (!code_challenge_method) {
      return sendError(
        'invalid_request',
        'code_challenge_method is required when code_challenge is provided'
      );
    }

    // Only support S256 for security (plain is deprecated)
    if (code_challenge_method !== 'S256') {
      return sendError(
        'invalid_request',
        'Unsupported code_challenge_method. Only S256 is supported'
      );
    }

    // Validate code_challenge format (base64url, 43-128 characters)
    const base64urlPattern = /^[A-Za-z0-9_-]{43,128}$/;
    if (!base64urlPattern.test(code_challenge)) {
      return sendError('invalid_request', 'Invalid code_challenge format');
    }
  }

  // Process authentication-related parameters (OIDC Core 3.1.2.1)
  let sessionUserId: string | undefined;
  let authTime: number | undefined;
  let sessionAcr: string | undefined;
  let isAnonymousSession: boolean = false;

  // Check for existing session (cookie)
  // This is required for prompt=none to work correctly
  const sessionId = c.req.header('Cookie')?.match(/authrim_session=([^;]+)/)?.[1];
  // Only process sharded session IDs (new format: {shardIndex}_session_{uuid})
  // Legacy sessions without shard prefix are treated as invalid (user must re-login)
  if (sessionId && c.env.SESSION_STORE && isShardedSessionId(sessionId)) {
    try {
      const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);

      const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

      if (session) {
        // Check if session is not expired
        if (session.expiresAt > Date.now()) {
          sessionUserId = session.userId;
          // Check if this is an anonymous session (architecture-decisions.md §17)
          isAnonymousSession = session.data?.is_anonymous === true;
          // Don't set authTime from session if this is a confirmed re-authentication
          // (it will be set later based on prompt parameter)
          if (_confirmed !== 'true') {
            // OIDC Conformance: Use authTime from session data if available
            // This ensures consistency between initial login and prompt=none requests
            // Fallback to createdAt for backward compatibility with existing sessions
            if (session.data?.authTime && typeof session.data.authTime === 'number') {
              authTime = session.data.authTime;
              log.debug('Setting authTime from session data', {
                action: 'auth_time_session',
                authTime,
              });
            } else {
              authTime = Math.floor(session.createdAt / 1000);
              log.debug('Setting authTime from session createdAt (legacy)', {
                action: 'auth_time_legacy',
                authTime,
              });
            }
          } else {
            log.debug('Skipping session authTime (_confirmed=true)', { action: 'auth_time_skip' });
          }
        }
      }
    } catch (error) {
      log.error('Failed to retrieve session', { action: 'session_retrieve' }, error as Error);
      // Continue without session
    }
  }

  // If this is a re-authentication confirmation callback, restore original auth_time and sessionUserId
  // EXCEPT when prompt=login or max_age re-authentication (which require a new auth_time)
  if (_confirmed === 'true') {
    log.debug('Confirmation callback', {
      action: 'confirmation',
      prompt,
      maxAge: max_age,
      authTime: _auth_time,
    });

    // prompt=login or max_age re-authentication requires a new auth_time (user just re-authenticated)
    if (prompt?.includes('login') || max_age) {
      authTime = Math.floor(Date.now() / 1000);
      log.debug('Re-authentication confirmed, setting new authTime', {
        action: 'reauth',
        authTime,
      });
    } else if (_auth_time) {
      // For other scenarios, restore original auth_time
      authTime = parseInt(_auth_time, 10);
      log.debug('Restoring original authTime', { action: 'auth_time_restore', authTime });
    }

    if (_session_user_id) {
      sessionUserId = _session_user_id;
    }
  }

  // Handle id_token_hint parameter (fallback if no session cookie)
  if (id_token_hint && !sessionUserId) {
    try {
      // Decode JWT header to get kid (Key ID)
      const parts = id_token_hint.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }
      const headerBase64url = parts[0];
      const headerBase64 = headerBase64url.replace(/-/g, '+').replace(/_/g, '/');
      const headerJson = JSON.parse(atob(headerBase64)) as { kid?: string; alg?: string };
      const kid = headerJson.kid;

      // Fetch JWKS from KeyManager DO
      let publicKey: CryptoKey | null = null;

      if (c.env.KEY_MANAGER) {
        try {
          const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
          const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
          const keys = await keyManager.getAllPublicKeysRpc();

          // Find key by kid
          const jwk = kid ? keys.find((k: { kid?: string }) => k.kid === kid) : keys[0];
          if (jwk) {
            publicKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
          }
        } catch (kmError) {
          log.warn('Failed to fetch key from KeyManager, falling back to PUBLIC_JWK_JSON', {
            action: 'key_manager_fallback',
          });
        }
      }

      // Fallback to PUBLIC_JWK_JSON if KeyManager unavailable
      if (!publicKey) {
        const publicJwkJson = c.env.PUBLIC_JWK_JSON;
        if (publicJwkJson) {
          const publicJwk = JSON.parse(publicJwkJson);
          // Check if kid matches (if available)
          if (!kid || publicJwk.kid === kid) {
            publicKey = (await importJWK(publicJwk, 'RS256')) as CryptoKey;
          }
        }
      }

      if (publicKey) {
        const verified = await verifyToken(id_token_hint, publicKey, c.env.ISSUER_URL, {
          audience: client_id || '',
        });
        const idTokenPayload = verified.payload as Record<string, unknown>;

        // Extract user identifier and auth_time from ID token
        sessionUserId = idTokenPayload.sub as string;
        authTime = idTokenPayload.auth_time as number;
        sessionAcr = idTokenPayload.acr as string;
        log.info('id_token_hint verified successfully', {
          action: 'id_token_hint_verify',
          sub: sessionUserId,
          authTime,
        });
      } else {
        log.error('No matching public key found for id_token_hint verification', {
          action: 'id_token_hint_key_missing',
        });
      }
    } catch (error) {
      log.error(
        'Failed to verify id_token_hint',
        { action: 'id_token_hint_verify' },
        error as Error
      );
      // Invalid id_token_hint - treat as if no session exists
    }
  }

  // Handle prompt parameter (OIDC Core 3.1.2.1)
  if (prompt) {
    const promptValues = prompt.split(' ');

    // Check for invalid prompt combinations
    if (promptValues.includes('none') && promptValues.length > 1) {
      return sendError(
        'invalid_request',
        'prompt=none cannot be combined with other prompt values'
      );
    }

    if (promptValues.includes('none')) {
      // prompt=none: MUST NOT display any authentication or consent UI
      // If not authenticated, return login_required error
      if (!sessionUserId) {
        return sendError('login_required', 'User authentication is required');
      }

      // Anonymous session check (architecture-decisions.md §17)
      // For anonymous users, prompt=none requires explicit client permission
      if (isAnonymousSession) {
        // client_id is validated earlier via validateClientId()
        const clientContract = await loadClientContractCached(
          c,
          c.env.AUTHRIM_CONFIG,
          c.env,
          tenantId,
          client_id!
        );

        // Check if client allows prompt=none for anonymous users
        // Default to false for security (require explicit opt-in)
        const allowPromptNone = clientContract?.anonymousAuth?.allowPromptNone ?? false;

        if (!allowPromptNone) {
          log.info('Anonymous session denied prompt=none - client does not allow it', {
            action: 'prompt_none_denied',
            clientId: client_id,
          });
          return sendError(
            'login_required',
            'Anonymous users cannot use prompt=none for this client'
          );
        }

        log.info('Anonymous session allowed for prompt=none', {
          action: 'prompt_none_allowed',
          clientId: client_id,
        });
      }

      // Check max_age if provided
      if (max_age && authTime) {
        const maxAgeSeconds = parseInt(max_age, 10);
        const currentTime = Math.floor(Date.now() / 1000);
        const timeSinceAuth = currentTime - authTime;

        if (timeSinceAuth > maxAgeSeconds) {
          return sendError(
            'login_required',
            'Re-authentication is required due to max_age constraint'
          );
        }
      }
    }

    if (promptValues.includes('login') && _confirmed !== 'true') {
      // prompt=login: Force re-authentication even if user has valid session
      // Clear session context to force login (unless user has already confirmed)
      sessionUserId = undefined;
      authTime = undefined;
    }

    // Note: prompt=consent and prompt=select_account are handled by consent UI
    // They don't affect the authorization endpoint logic directly
  }

  // Handle max_age parameter (OIDC Core 3.1.2.1)
  // Skip this check if user has already confirmed re-authentication
  let requiresReauthentication = false;
  if (max_age && !prompt?.includes('none') && _confirmed !== 'true') {
    const maxAgeSeconds = parseInt(max_age, 10);

    if (authTime) {
      const currentTime = Math.floor(Date.now() / 1000);
      const timeSinceAuth = currentTime - authTime;

      if (timeSinceAuth > maxAgeSeconds) {
        // Re-authentication required - show confirmation screen
        requiresReauthentication = true;
        // Note: Do NOT clear auth_time here - it will be preserved through the confirmation flow
      }
    }
  }

  // If re-authentication is required, show confirmation screen (unless already confirmed)
  if (
    (requiresReauthentication || (prompt?.includes('login') && sessionUserId)) &&
    _confirmed !== 'true'
  ) {
    // Store authorization request parameters in ChallengeStore (RPC)
    // Use challengeId-based sharding for better scalability
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId);

    await challengeStore.storeChallengeRpc({
      id: challengeId,
      type: 'reauth',
      userId: sessionUserId || 'anonymous',
      challenge: challengeId,
      ttl: 600, // 10 minutes
      metadata: {
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        nonce,
        code_challenge,
        code_challenge_method,
        claims,
        response_mode,
        max_age,
        prompt,
        id_token_hint,
        acr_values,
        display,
        ui_locales,
        login_hint,
        sessionUserId,
        authTime, // Preserve original auth_time
        // Custom Redirect URIs (Authrim Extension)
        error_uri: validatedErrorUri,
        cancel_uri: validatedCancelUri,
      },
    });

    // Redirect to UI re-authentication screen
    // Conformance mode: use builtin forms
    // UI configured: redirect to external UI
    // Neither: return configuration error
    const reauthTarget = await getUIRedirectTarget(c.env, 'reauth', {
      challenge_id: challengeId,
    });
    if (reauthTarget.type === 'redirect') {
      return c.redirect(reauthTarget.url, 302);
    } else if (reauthTarget.type === 'error') {
      return reauthTarget.response;
    }
    // Builtin forms: redirect to local confirm endpoint
    return c.redirect(
      `${reauthTarget.fallbackPath}?challenge_id=${encodeURIComponent(challengeId)}`,
      302
    );
  }

  // If no session exists and prompt is not 'none', redirect to login screen
  if (!sessionUserId && !prompt?.includes('none')) {
    // Store authorization request parameters in ChallengeStore (RPC)
    // Use challengeId-based sharding for better scalability
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId);

    await challengeStore.storeChallengeRpc({
      id: challengeId,
      type: 'login',
      userId: 'anonymous',
      challenge: challengeId,
      ttl: 600, // 10 minutes
      metadata: {
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        nonce,
        code_challenge,
        code_challenge_method,
        claims,
        response_mode,
        max_age,
        prompt,
        id_token_hint,
        acr_values,
        display,
        ui_locales,
        login_hint,
        // Client metadata for login page display (OIDC Dynamic OP requirement)
        client_name: clientMetadata?.client_name || client_id,
        logo_uri: clientMetadata?.logo_uri,
        policy_uri: clientMetadata?.policy_uri,
        tos_uri: clientMetadata?.tos_uri,
        client_uri: clientMetadata?.client_uri,
        // Custom Redirect URIs (Authrim Extension)
        error_uri: validatedErrorUri,
        cancel_uri: validatedCancelUri,
      },
    });

    // Redirect to UI login screen
    // Conformance mode: use builtin forms
    // UI configured: redirect to external UI
    // Neither: return configuration error
    const loginTarget = await getUIRedirectTarget(c.env, 'login', {
      challenge_id: challengeId,
    });
    if (loginTarget.type === 'redirect') {
      return c.redirect(loginTarget.url, 302);
    } else if (loginTarget.type === 'error') {
      return loginTarget.response;
    }
    // Builtin forms: redirect to local login endpoint
    return c.redirect(
      `${loginTarget.fallbackPath}?challenge_id=${encodeURIComponent(challengeId)}`,
      302
    );
  }

  // Determine user identifier (sub)
  // Use session user if available, otherwise not allowed (should have been redirected to login)
  if (!sessionUserId) {
    // This should only happen with prompt=none (which should have failed earlier with login_required)
    return sendError('login_required', 'User authentication is required');
  }

  const sub = sessionUserId;

  // Check if consent is required (unless already confirmed)
  // Note: _consent_confirmed is already parsed at the top of this function
  if (_consent_confirmed !== 'true') {
    // Get client metadata to check if it's a trusted client (request-level cached)
    const clientMetadata = await getClientCached(c, c.env, validClientId);

    // Check if this is a trusted client that can skip consent
    const isTrustedClient =
      clientMetadata && clientMetadata.is_trusted && clientMetadata.skip_consent;

    // Trusted clients skip consent (unless prompt=consent is explicitly specified)
    if (isTrustedClient && !prompt?.includes('consent')) {
      // Check if consent already exists (using cache)
      const existingConsent = await getCachedConsent(c.env, sub, validClientId);

      if (!existingConsent) {
        // Auto-grant consent for trusted client
        const consentId = crypto.randomUUID();
        const now = Date.now();

        // Use DatabaseAdapter for consent insert (portable across D1/PostgreSQL/MySQL)
        const tenantId = getTenantIdFromContext(c);
        const authCtx = createAuthContextFromHono(c, tenantId);
        await authCtx.coreAdapter.execute(
          `INSERT INTO oauth_client_consents
           (id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [consentId, sub, validClientId, scope, now, null, now, now]
        );

        // Invalidate consent cache after insert so next read picks up new consent
        await invalidateConsentCache(c.env, sub, validClientId);

        log.info('Auto-granted consent for trusted client', {
          action: 'consent_auto_grant',
          clientId: validClientId,
          userId: sub,
        });
      }

      // Skip consent screen
      // Continue to authorization code generation
    } else {
      // Third-Party Client or prompt=consent: Check consent requirements
      let consentRequired = false;
      try {
        // Use cached consent check (Read-Through Cache)
        const existingConsent = await getCachedConsent(c.env, sub, validClientId);

        if (!existingConsent) {
          // No consent record exists
          consentRequired = true;
        } else {
          // Check if consent has expired
          const expiresAt = existingConsent.expires_at;
          if (expiresAt && expiresAt < Date.now()) {
            consentRequired = true;

            // Publish consent expired event
            try {
              const tenantId = getTenantIdFromContext(c);
              const expiredEventData: ConsentEventData = {
                userId: sub,
                clientId: validClientId,
                scopes: existingConsent.scope.split(' '),
                timestamp: Date.now(),
              };
              await publishEvent(c, {
                type: CONSENT_EVENTS.EXPIRED,
                tenantId,
                data: expiredEventData,
              });
              log.info('Consent expired', {
                action: 'consent_expired',
                clientId: validClientId,
                userId: sub,
                expiredAt: new Date(expiresAt).toISOString(),
              });
            } catch (eventError) {
              // Log but don't fail the flow
              log.error(
                'Failed to publish consent expired event',
                { action: 'consent_event_publish' },
                eventError as Error
              );
            }
          } else {
            // Check if requested scopes are covered by existing consent
            const grantedScopes = existingConsent.scope.split(' ');
            const requestedScopes = (scope as string).split(' ');
            const hasAllScopes = requestedScopes.every((s) => grantedScopes.includes(s));

            if (!hasAllScopes) {
              // Requested scopes exceed granted scopes
              consentRequired = true;
            }
          }
        }

        // Force consent if prompt=consent
        if (prompt?.includes('consent')) {
          consentRequired = true;
        }
      } catch (error) {
        log.error('Failed to check consent', { action: 'consent_check' }, error as Error);
        // On error, assume consent is required for safety
        consentRequired = true;
      }

      if (consentRequired) {
        // prompt=none requires consent but can't show UI
        if (prompt?.includes('none')) {
          return sendError('consent_required', 'User consent is required');
        }

        // Store authorization request parameters in ChallengeStore for consent flow (RPC)
        // Use challengeId-based sharding for better scalability
        const challengeId = crypto.randomUUID();
        const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId);

        await challengeStore.storeChallengeRpc({
          id: challengeId,
          type: 'consent',
          userId: sub,
          challenge: challengeId,
          ttl: 600, // 10 minutes
          metadata: {
            response_type,
            client_id,
            redirect_uri,
            scope,
            state,
            nonce,
            code_challenge,
            code_challenge_method,
            claims,
            response_mode,
            max_age,
            prompt,
            id_token_hint,
            acr_values,
            display,
            ui_locales,
            login_hint,
            sessionUserId: sub,
            authTime, // Preserve auth_time
            // Phase 2-B RBAC extensions
            org_id,
            acting_as,
            // Custom Redirect URIs (Authrim Extension)
            error_uri: validatedErrorUri,
            cancel_uri: validatedCancelUri,
          },
        });

        // Redirect to UI consent screen
        // Conformance mode: use builtin forms
        // UI configured: redirect to external UI
        // Neither: return configuration error
        const consentTarget = await getUIRedirectTarget(c.env, 'consent', {
          challenge_id: challengeId,
        });
        if (consentTarget.type === 'redirect') {
          return c.redirect(consentTarget.url, 302);
        } else if (consentTarget.type === 'error') {
          return consentTarget.response;
        }
        // Builtin forms: redirect to local consent endpoint
        return c.redirect(
          `${consentTarget.fallbackPath}?challenge_id=${encodeURIComponent(challengeId)}`,
          302
        );
      }
    } // End of Third-Party Client consent check
  }

  // Record authentication time
  const currentAuthTime = authTime || Math.floor(Date.now() / 1000);
  log.debug('Final authTime for code', {
    action: 'auth_time_final',
    authTime,
    currentAuthTime,
    prompt,
  });

  // Handle acr_values parameter (Authentication Context Class Reference)
  // OIDC Core 3.1.2.1: acr_values is a space-separated string of ACR values in order of preference
  let selectedAcr = sessionAcr;
  if (acr_values && !selectedAcr) {
    // Load supported ACR values from settings (KV > env > default)
    // Default ACR values per OIDC Core specification
    const defaultSupportedAcr = [
      'urn:mace:incommon:iap:silver', // Basic authentication
      'urn:mace:incommon:iap:bronze', // Minimal authentication
      'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport', // Password over TLS
      'urn:oasis:names:tc:SAML:2.0:ac:classes:Password', // Simple password
      '0', // No authentication context (fallback)
    ];

    let supportedAcrValues: string[] = defaultSupportedAcr;

    // Try to load custom ACR values from FAPI/OIDC config (already loaded earlier)
    if (oidcConfig.supportedAcrValues && Array.isArray(oidcConfig.supportedAcrValues)) {
      supportedAcrValues = oidcConfig.supportedAcrValues;
    } else if (c.env.SUPPORTED_ACR_VALUES) {
      // Fallback to environment variable (comma-separated)
      supportedAcrValues = c.env.SUPPORTED_ACR_VALUES.split(',').map((v: string) => v.trim());
    }

    // Match requested ACR values against supported values (in order of client preference)
    const requestedAcrList = acr_values.split(' ');
    const matchedAcr = requestedAcrList.find((acr) => supportedAcrValues.includes(acr));

    if (matchedAcr) {
      selectedAcr = matchedAcr;
      log.debug('Selected ACR from client request', { action: 'acr_selected', acr: selectedAcr });
    } else {
      // No match found - use the first supported ACR as default
      // Per OIDC Core: The OP SHOULD process the request, but MAY return a different acr
      selectedAcr = supportedAcrValues[0];
      log.debug('No matching ACR found, using default', {
        action: 'acr_fallback',
        requested: requestedAcrList,
        supported: supportedAcrValues,
        defaultAcr: selectedAcr,
      });
    }
  }

  // Type narrowing: scope is guaranteed to be a string at this point
  const validScope: string = scope as string;

  // Type narrowing: response_type is guaranteed to be defined (validated earlier)
  const validResponseType: string = response_type!;

  // Parse response_type to determine what to return
  // Per OIDC Core 3.3: Hybrid Flow supports combinations of code, id_token, and token
  // Per OAuth 2.0 Multiple Response Types 1.0 §5: response_type=none returns no tokens
  const responseTypes = validResponseType.split(' ');
  const isNoneResponseType = validResponseType === 'none';

  // SECURITY: response_type=none cannot be combined with other response types
  // (OAuth 2.0 Multiple Response Types 1.0 §5: "none" is mutually exclusive)
  if (responseTypes.includes('none') && responseTypes.length > 1) {
    return sendError(
      'invalid_request',
      'response_type=none cannot be combined with other response types'
    );
  }

  // For response_type=none: skip code/token/id_token generation
  // Redirect with state and iss only (session check without token issuance)
  const includesCode = responseTypes.includes('code') && !isNoneResponseType;
  const includesIdToken = responseTypes.includes('id_token') && !isNoneResponseType;
  const includesToken = responseTypes.includes('token') && !isNoneResponseType;

  // Extract and validate DPoP proof (if present) for authorization code binding
  // FAPI 2.0: DPoP validation is strict when DPoP header is provided
  let dpopJkt: string | undefined;
  const dpopProof = extractDPoPProof(c.req.raw.headers);

  // Determine if strict DPoP validation is required
  // - FAPI 2.0 mode with strictDPoP enabled: Always strict when DPoP header is present
  // - Client metadata dpop_bound_access_tokens: Client requires DPoP
  const isStrictDPoPMode =
    (fapiConfig.enabled && fapiConfig.strictDPoP !== false) ||
    (clientMetadata && clientMetadata.dpop_bound_access_tokens === true);

  if (dpopProof) {
    // Validate DPoP proof
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined, // No access token yet
      c.env.DPOP_JTI_STORE,
      validClientId
    );

    if (dpopValidation.valid && dpopValidation.jkt) {
      dpopJkt = dpopValidation.jkt; // Store JWK thumbprint for code binding
      log.info('Authorization code will be bound to DPoP key', {
        action: 'dpop_bind',
        jkt: dpopJkt,
      });
    } else {
      // FAPI 2.0 / Strict DPoP mode: Reject invalid DPoP proofs
      if (isStrictDPoPMode) {
        log.error('DPoP STRICT: Rejected invalid DPoP proof', {
          action: 'dpop_reject',
          error: dpopValidation.error_description,
        });
        return sendError(
          'invalid_dpop_proof',
          dpopValidation.error_description || 'Invalid DPoP proof'
        );
      }

      // Non-strict mode: Log warning but continue without binding
      log.warn('Invalid DPoP proof provided, continuing without binding', {
        action: 'dpop_skip',
        error: dpopValidation.error_description,
      });
      // Note: We don't fail the request if DPoP is invalid, just don't bind the code
      // This allows flexibility for clients that may have optional DPoP support
    }
  } else if (isStrictDPoPMode && clientMetadata?.dpop_bound_access_tokens === true) {
    // Client requires DPoP but no DPoP header provided
    log.error('DPoP STRICT: Client requires DPoP but no DPoP header provided', {
      action: 'dpop_required',
    });
    return sendError('invalid_dpop_proof', 'DPoP proof is required for this client');
  }

  // =============================================================================
  // NIST SP 800-63-4 Federation Assurance Level (FAL) Determination
  // =============================================================================
  // FAL is determined based on security features used in the authorization request:
  // - FAL1: Bearer assertions (basic OIDC/SAML)
  // - FAL2: Proof of possession (DPoP, holder-of-key)
  // - FAL3: Cryptographic authenticator + signed assertions + PAR
  // Note: This is for logging/tracking purposes; actual FAL enforcement is at token issuance
  const hasDPoPBound = dpopJkt !== undefined;
  // Note: PAR and signed request detection would require passing flags from earlier in the flow
  // For now, we only reliably track DPoP binding which is the key factor for FAL2
  const determinedFAL: FAL = hasDPoPBound ? 'FAL2' : 'FAL1';

  log.debug('NIST FAL Determination', {
    action: 'fal_determined',
    fal: determinedFAL,
    hasDPoP: hasDPoPBound,
    clientId: validClientId,
  });

  // Generate authorization code if needed (for code flow and hybrid flows)
  let code: string | undefined;
  if (includesCode) {
    const randomCode = generateSecureRandomString(96); // ~128 base64url chars

    // Determine shard count from KV (dynamic) > environment > default
    // This ensures both op-auth and op-token use the same shard count
    const shardCount = await getShardCount(c.env);

    // Session→AuthCode Sticky Routing: Use session's shard index for AuthCode
    // This collocates Session and AuthCode on the same DO shard for locality,
    // reducing cross-POD latency by ~700-1500ms per request
    let authCodeStoreId: DurableObjectId;
    if (shardCount > 0) {
      // Prefer session-based shard routing for locality
      const parsedSession = sessionId ? parseShardedSessionId(sessionId) : null;
      const shardIndex = parsedSession
        ? parsedSession.shardIndex % shardCount // Session Sticky: same shard as session
        : getAuthCodeShardIndex(sub, validClientId, shardCount); // Fallback: hash-based
      code = createShardedAuthCode(shardIndex, randomCode);
      const instanceName = buildAuthCodeShardInstanceName(shardIndex);
      authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(instanceName);
    } else {
      // Sharding disabled - use legacy 'global' instance
      code = randomCode;
      authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName('global');
    }

    // Store authorization code using AuthorizationCodeStore Durable Object (RPC)
    try {
      const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);

      await authCodeStore.storeCodeRpc({
        code,
        clientId: validClientId,
        redirectUri: validRedirectUri,
        userId: sub,
        scope: validScope,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method as 'S256' | 'plain' | undefined,
        nonce,
        state,
        claims,
        authTime: currentAuthTime,
        acr: selectedAcr,
        dpopJkt, // Bind authorization code to DPoP key (RFC 9449)
        sid: sessionId, // OIDC Session Management: Session ID for RP-Initiated Logout
        authorizationDetails: authorization_details, // RFC 9396 RAR
      });
    } catch (error) {
      log.error('AuthCodeStore DO error', { action: 'auth_code_store' }, error as Error);
      return sendError('server_error', 'Failed to process authorization request');
    }
  }

  // Generate access token if needed (for implicit and hybrid flows)
  let accessToken: string | undefined;
  let accessTokenJti: string | undefined;
  if (includesToken) {
    try {
      // Get issuer from environment
      const issuer = c.env.ISSUER_URL;

      const { privateKey, kid: signingKeyId } = await getSigningKeyFromKeyManager(c.env);

      // Generate region-aware JTI for token revocation sharding
      const { jti: regionAwareJti } = await generateRegionAwareJti(c.env);

      const tokenResult = await createAccessToken(
        {
          iss: issuer,
          sub,
          aud: issuer, // Access token audience should be issuer (resource server), not client_id
          scope: validScope,
          client_id: validClientId,
          claims,
        },
        privateKey,
        signingKeyId,
        3600, // 1 hour
        regionAwareJti
      );

      accessToken = tokenResult.token;
      accessTokenJti = tokenResult.jti;

      log.info('Generated access_token for hybrid/implicit flow', {
        action: 'access_token_generate',
        sub,
        clientId: validClientId,
      });
    } catch (error) {
      log.error(
        'Failed to generate access token',
        { action: 'access_token_generate' },
        error as Error
      );
      return sendError('server_error', 'Failed to generate access token');
    }
  }

  // Generate ID token if needed (for implicit and hybrid flows)
  let idToken: string | undefined;
  if (includesIdToken) {
    try {
      // Get issuer from environment
      const issuer = c.env.ISSUER_URL;

      const { privateKey, kid: signingKeyId } = await getSigningKeyFromKeyManager(c.env);

      // Calculate c_hash if code is present (for hybrid flows)
      // Per OIDC Core 3.3.2.11
      let cHash: string | undefined;
      if (code) {
        cHash = await calculateCHash(code, 'SHA-256');
      }

      // Calculate at_hash if access token is present
      // Per OIDC Core 3.2.2.9 and 3.3.2.11
      let atHash: string | undefined;
      if (accessToken) {
        atHash = await calculateAtHash(accessToken, 'SHA-256');
      }

      // Create ID token with appropriate claims
      // Build base claims for ID token
      // Note: sid (session ID) is required for RP-Initiated Logout per OIDC Session Management 1.0
      const idTokenClaims: Record<string, unknown> = {
        iss: issuer,
        sub,
        aud: validClientId,
        auth_time: currentAuthTime,
        nonce, // Include nonce (required for implicit/hybrid flows)
        c_hash: cHash,
        at_hash: atHash,
        ...(sessionId && { sid: sessionId }), // OIDC Session Management: Session ID for RP-Initiated Logout
      };

      // Add acr claim if acr_values was requested (OIDC Core 2: SHOULD return acr)
      if (selectedAcr) {
        idTokenClaims.acr = selectedAcr;
      }

      // OIDC Core 5.4: For response_type=id_token (no access token), scope-based claims
      // must be included in the ID token since UserInfo endpoint is not accessible
      // Also include essential claims from claims parameter
      const isIdTokenOnly = includesIdToken && !includesToken && !includesCode;
      const scopes = validScope.split(' ');

      // Parse claims parameter for id_token essential claims
      let idTokenEssentialClaims: Record<string, { essential?: boolean; value?: unknown }> = {};
      if (claims) {
        try {
          const parsedClaims = JSON.parse(claims) as Record<string, unknown>;
          if (parsedClaims.id_token && typeof parsedClaims.id_token === 'object') {
            idTokenEssentialClaims = parsedClaims.id_token as Record<
              string,
              { essential?: boolean; value?: unknown }
            >;
          }
        } catch {
          // Ignore parsing errors, claims was already validated earlier
        }
      }

      // Check if we need to add scope-based or essential claims
      const hasEssentialClaims = Object.entries(idTokenEssentialClaims).some(
        ([, v]) => v?.essential === true
      );

      if (isIdTokenOnly || hasEssentialClaims) {
        // Fetch user data from cache (Read-Through Cache) or D1
        const user = await getCachedUser(c.env, sub);

        if (user) {
          // Parse address JSON if present (CachedUser.address is already JSON string)
          let address = null;
          if (user.address) {
            try {
              address = JSON.parse(user.address);
            } catch {
              // Ignore address parsing errors
            }
          }

          // Map user data to OIDC claims
          const userData: Record<string, unknown> = {
            name: user.name || undefined,
            family_name: user.family_name || undefined,
            given_name: user.given_name || undefined,
            middle_name: user.middle_name || undefined,
            nickname: user.nickname || undefined,
            preferred_username: user.preferred_username || undefined,
            profile: user.profile || undefined,
            picture: user.picture || undefined,
            website: user.website || undefined,
            gender: user.gender || undefined,
            birthdate: user.birthdate || undefined,
            zoneinfo: user.zoneinfo || undefined,
            locale: user.locale || undefined,
            updated_at: user.updated_at
              ? user.updated_at >= 1e12
                ? Math.floor(user.updated_at / 1000)
                : user.updated_at
              : Math.floor(Date.now() / 1000),
            email: user.email || undefined,
            email_verified: user.email_verified,
            phone_number: user.phone_number || undefined,
            phone_number_verified: user.phone_number_verified,
            address: address || undefined,
          };

          // Profile scope claims
          const profileClaims = [
            'name',
            'family_name',
            'given_name',
            'middle_name',
            'nickname',
            'preferred_username',
            'profile',
            'picture',
            'website',
            'gender',
            'birthdate',
            'zoneinfo',
            'locale',
            'updated_at',
          ];

          // Add scope-based claims for response_type=id_token
          if (isIdTokenOnly) {
            if (scopes.includes('profile')) {
              for (const claim of profileClaims) {
                if (userData[claim] !== undefined) {
                  idTokenClaims[claim] = userData[claim];
                }
              }
            }
            if (scopes.includes('email')) {
              if (userData.email !== undefined) idTokenClaims.email = userData.email;
              if (userData.email_verified !== undefined)
                idTokenClaims.email_verified = userData.email_verified;
            }
            if (scopes.includes('phone')) {
              if (userData.phone_number !== undefined)
                idTokenClaims.phone_number = userData.phone_number;
              if (userData.phone_number_verified !== undefined)
                idTokenClaims.phone_number_verified = userData.phone_number_verified;
            }
            if (scopes.includes('address') && userData.address !== undefined) {
              idTokenClaims.address = userData.address;
            }
          }

          // Add essential claims from claims parameter
          for (const [claimName, claimSpec] of Object.entries(idTokenEssentialClaims)) {
            if (claimSpec?.essential === true && userData[claimName] !== undefined) {
              idTokenClaims[claimName] = userData[claimName];
            }
          }
        }
      }

      idToken = await createIDToken(
        idTokenClaims as Parameters<typeof createIDToken>[0],
        privateKey,
        signingKeyId,
        3600 // 1 hour
      );

      log.info('Generated id_token for hybrid/implicit flow', {
        action: 'id_token_generate',
        sub,
        clientId: validClientId,
        hasCHash: !!cHash,
        hasAtHash: !!atHash,
      });
    } catch (error) {
      log.error('Failed to generate ID token', { action: 'id_token_generate' }, error as Error);
      return sendError('server_error', 'Failed to generate ID token');
    }
  }

  // OIDC Session Management: Register session-client association for logout (Implicit/Hybrid flows)
  // This enables frontchannel/backchannel logout to notify the correct RPs
  // For code flow, this is done in the token endpoint; for implicit/hybrid, we do it here
  if ((includesIdToken || includesToken) && sessionId && c.env.DB) {
    try {
      log.debug('Registering session-client for implicit/hybrid logout', {
        action: 'session_client_register',
        sidPrefix: sessionId.substring(0, 25),
        clientIdPrefix: validClientId.substring(0, 25),
      });
      const coreAdapter = new D1Adapter({ db: c.env.DB });
      const sessionClientRepo = new SessionClientRepository(coreAdapter);
      const result = await sessionClientRepo.createOrUpdate({
        session_id: sessionId,
        client_id: validClientId,
      });
      log.debug('Successfully registered session-client', {
        action: 'session_client_registered',
        resultId: result.id,
      });
    } catch (error) {
      // Log error but don't fail the authorization - logout tracking is non-critical
      log.error(
        'Failed to register session-client for implicit/hybrid logout',
        { action: 'session_client_register' },
        error as Error
      );
    }
  }

  // Determine response mode
  // Per OIDC Core 3.3.2.5: Default response_mode for hybrid flows is 'fragment'
  // For response_type=code only, default is 'query'
  let effectiveResponseMode = response_mode;
  if (!effectiveResponseMode) {
    if (includesIdToken || includesToken) {
      // Implicit or hybrid flow: default to fragment
      effectiveResponseMode = 'fragment';
    } else {
      // Pure code flow: default to query
      effectiveResponseMode = 'query';
    }
  }

  // Build response parameters
  const responseParams: Record<string, string> = {};
  if (code) responseParams.code = code;
  if (accessToken) responseParams.access_token = accessToken;
  if (accessToken) responseParams.token_type = 'Bearer';
  if (accessToken) responseParams.expires_in = '3600';
  if (idToken) responseParams.id_token = idToken;
  if (state) responseParams.state = state;
  // RFC 9207: Add iss parameter to prevent mix-up attacks
  responseParams.iss = c.env.ISSUER_URL;

  // OIDC Session Management 1.0: Add session_state parameter
  // https://openid.net/specs/openid-connect-session-1_0.html#CreatingUpdatingSessions
  // Use browser state (derived from session ID) instead of raw session ID
  // because browser state is what the check_session_iframe can read (non-HttpOnly cookie)
  if (sessionId && validRedirectUri) {
    try {
      const rpOrigin = extractOrigin(validRedirectUri);
      if (rpOrigin) {
        // Generate browser state from session ID - this must match what's in the cookie
        const browserState = await generateBrowserState(sessionId);
        const sessionState = await calculateSessionState(validClientId, rpOrigin, browserState);
        responseParams.session_state = sessionState;

        // CRITICAL: Set browser_state cookie for check_session_iframe
        // This is needed when user has existing session but no browser_state cookie
        // (e.g., session created before browser_state feature was deployed)
        // SameSite is determined dynamically based on origin configuration
        const browserStateSameSite = getBrowserStateCookieSameSite(c.env);
        c.res.headers.append(
          'Set-Cookie',
          `${BROWSER_STATE_COOKIE_NAME}=${browserState}; Path=/; SameSite=${browserStateSameSite}; Secure; Max-Age=3600`
        );
      }
    } catch (error) {
      log.error(
        'Failed to calculate session_state',
        { action: 'session_state_calculate' },
        error as Error
      );
      // Continue without session_state - it's optional
    }
  }

  // Check if JARM (JWT-secured Authorization Response Mode) is requested
  // SECURITY AUDIT: Log response_type=none requests for monitoring
  // This helps detect session oracle attacks and abuse patterns
  if (isNoneResponseType) {
    log.info('response_type=none session check', {
      action: 'authorize_none',
      clientId: validClientId,
      hasSession: !!sessionId,
      prompt: prompt || 'not_specified',
      referer: c.req.header('referer')?.substring(0, 200) || 'none',
    });
  }

  const isJARM = effectiveResponseMode.includes('.jwt') || effectiveResponseMode === 'jwt';

  if (isJARM) {
    // JARM: Create JWT-secured response
    // Determine base mode for JWT response
    let baseMode = effectiveResponseMode.replace('.jwt', '');
    if (effectiveResponseMode === 'jwt') {
      // Generic 'jwt' mode: use default based on flow
      baseMode = includesIdToken || includesToken ? 'fragment' : 'query';
    }

    return await createJARMResponse(c, validRedirectUri, responseParams, baseMode, validClientId);
  }

  // Handle response based on response_mode (traditional non-JWT modes)
  if (effectiveResponseMode === 'form_post') {
    // OAuth 2.0 Form Post Response Mode
    return createFormPostResponse(c, validRedirectUri, responseParams);
  } else if (effectiveResponseMode === 'fragment') {
    // Fragment encoding (for implicit and hybrid flows)
    return createFragmentResponse(c, validRedirectUri, responseParams);
  } else {
    // Query mode (for code-only flow)
    return createQueryResponse(c, validRedirectUri, responseParams);
  }
}

/**
 * Get signing key from KeyManager with caching
 * Performance optimization: Caches the imported CryptoKey to avoid expensive
 * RSA key import operation (5-7ms) on every request. Cache TTL is 60 seconds.
 */
async function getSigningKeyFromKeyManager(
  env: Env
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();

  // Check cache first (cache hit = avoid KeyManager DO call + RSA import)
  if (cachedSigningKey && now - cachedKeyTimestamp < KEY_CACHE_TTL) {
    return cachedSigningKey;
  }

  // Cache miss: fetch from KeyManager
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  if (!env.KEY_MANAGER_SECRET) {
    throw new Error('KEY_MANAGER_SECRET not configured');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Try to get active key via RPC
  let keyData = await keyManager.getActiveKeyWithPrivateRpc();

  if (keyData) {
    moduleLogger.debug('Active key response', {
      action: 'key_manager_active',
      hasKid: !!keyData.kid,
      hasPrivatePEM: !!keyData.privatePEM,
      pemLength: keyData.privatePEM?.length,
    });
  } else {
    moduleLogger.debug('No active key, rotating', { action: 'key_manager_rotate' });
    keyData = await keyManager.rotateKeysWithPrivateRpc();
    moduleLogger.debug('Rotated key', {
      action: 'key_manager_rotated',
      hasKid: !!keyData.kid,
      hasPrivatePEM: !!keyData.privatePEM,
      pemLength: keyData.privatePEM?.length,
    });
  }

  // Validate keyData before using it
  if (!keyData) {
    throw new Error('Failed to retrieve signing key: keyData is undefined');
  }

  if (!keyData.kid) {
    throw new Error('Failed to retrieve signing key: kid is missing');
  }

  if (!keyData.privatePEM) {
    throw new Error('Failed to retrieve signing key: privatePEM is missing');
  }

  if (typeof keyData.privatePEM !== 'string' || keyData.privatePEM.length === 0) {
    throw new Error(
      `Failed to retrieve signing key: privatePEM is invalid (type: ${typeof keyData.privatePEM}, length: ${keyData.privatePEM?.length})`
    );
  }

  moduleLogger.debug('About to import PKCS8', {
    action: 'key_import',
    kid: keyData.kid,
    pemLength: keyData.privatePEM.length,
  });

  // Import private key (expensive operation: 5-7ms)
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // Update cache
  cachedSigningKey = { privateKey, kid: keyData.kid };
  cachedKeyTimestamp = now;

  return { privateKey, kid: keyData.kid };
}

/**
 * Helper function to redirect with OAuth error parameters
 * https://tools.ietf.org/html/rfc6749#section-4.1.2.1
 *
 * Supports custom redirect URIs (Authrim Extension):
 * - errorUri: Redirect to this URI on technical errors
 * - cancelUri: Redirect to this URI on user cancellation
 * - isUserCancellation: Explicit flag for user-initiated cancellation
 *
 * IMPORTANT: error_uri/cancel_uri are NOT token delivery endpoints.
 * Tokens are ALWAYS returned to redirect_uri only.
 */
interface ErrorRedirectOptions {
  responseMode?: string;
  responseType?: string | null;
  clientId?: string;
  // Custom Redirect URIs (Authrim Extension)
  errorUri?: string;
  cancelUri?: string;
  isUserCancellation?: boolean;
}

async function redirectWithError(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  error: string,
  errorDescription?: string,
  state?: string,
  options?: ErrorRedirectOptions
): Promise<Response> {
  // Determine target URI based on error type and custom URIs
  // - User cancellation → use cancelUri if available
  // - Technical errors → use errorUri if available
  // - Fallback → always use redirect_uri
  let targetUri = redirectUri;
  if (options?.isUserCancellation && options?.cancelUri) {
    targetUri = options.cancelUri;
  } else if (options?.errorUri) {
    targetUri = options.errorUri;
  }

  const params: Record<string, string> = { error };
  if (errorDescription) {
    params.error_description = errorDescription;
  }
  // state is ALWAYS included (same rules as redirect_uri)
  if (state) {
    params.state = state;
  }
  // RFC 9207: Add iss parameter to prevent mix-up attacks (including error responses)
  params.iss = c.env.ISSUER_URL;

  const parsedResponseType = options?.responseType?.split(' ') ?? [];
  const isImplicitOrHybrid = parsedResponseType.some((t) => t === 'id_token' || t === 'token');

  let responseMode = options?.responseMode;
  let baseMode = responseMode;
  let isJARM = false;

  if (!responseMode || responseMode === '') {
    baseMode = isImplicitOrHybrid ? 'fragment' : 'query';
    responseMode = baseMode;
  } else if (responseMode === 'jwt') {
    baseMode = isImplicitOrHybrid ? 'fragment' : 'query';
    isJARM = true;
  } else if (responseMode.endsWith('.jwt')) {
    baseMode = responseMode.replace('.jwt', '');
    isJARM = true;
  } else {
    baseMode = responseMode;
  }

  if (isJARM) {
    if (options?.clientId) {
      return await createJARMResponse(c, targetUri, params, baseMode || 'query', options.clientId);
    }
    moduleLogger.warn(
      'JARM error response requested but client_id unavailable; falling back to base mode',
      { action: 'jarm_fallback' }
    );
  }

  switch (baseMode) {
    case 'form_post':
      return createFormPostResponse(c, targetUri, params);
    case 'fragment':
      return createFragmentResponse(c, targetUri, params);
    case 'query':
    default:
      return createQueryResponse(c, targetUri, params);
  }
}

/**
 * Create Form Post Response
 * OAuth 2.0 Form Post Response Mode
 * https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html
 *
 * Returns an HTML page with an auto-submitting form that POSTs the
 * authorization response parameters to the client's redirect_uri
 */
/**
 * Create a query-encoded redirect response
 * Used for response_type=code (pure authorization code flow)
 */
function createQueryResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return c.redirect(url.toString(), 302);
}

/**
 * Create a fragment-encoded redirect response
 * Used for implicit and hybrid flows per OIDC Core 3.3.2.5
 */
function createFragmentResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>
): Response {
  const url = new URL(redirectUri);
  // Build fragment from parameters
  const fragmentParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    fragmentParams.set(key, value);
  }
  url.hash = fragmentParams.toString();
  return c.redirect(url.toString(), 302);
}

/**
 * Create a form_post response
 * Used when response_mode=form_post per OAuth 2.0 Form Post Response Mode
 */
function createFormPostResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>
): Response {
  // Generate nonce for CSP (Content Security Policy)
  const nonce = crypto.randomUUID();

  // Build form inputs from all parameters
  const inputs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    inputs.push(`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`);
  }

  // Generate HTML page with auto-submitting form
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization</title>
  <style nonce="${nonce}">
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      text-align: center;
      color: white;
    }
    .spinner {
      width: 50px;
      height: 50px;
      margin: 0 auto 20px;
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .message {
      font-size: 18px;
      margin-bottom: 10px;
    }
    .note {
      font-size: 14px;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p class="message">Redirecting to application...</p>
    <p class="note">Please wait</p>
  </div>
  <form id="auth-form" method="post" action="${escapeHtml(redirectUri)}">
    ${inputs.join('\n    ')}
  </form>
  <script nonce="${nonce}">
    // Auto-submit form immediately
    document.getElementById('auth-form').submit();
  </script>
</body>
</html>`;

  // Set CSP header with nonce to allow inline script and style
  return c.html(html, 200, {
    'Content-Security-Policy': `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}';`,
  });
}

/**
 * Create JARM (JWT-Secured Authorization Response Mode) response
 * https://openid.net/specs/oauth-v2-jarm.html
 *
 * @param c - Hono context
 * @param redirectUri - Client redirect URI
 * @param params - Authorization response parameters
 * @param baseMode - Base response mode (query, fragment, or form_post)
 * @param clientId - Client identifier
 * @returns Response with JWT-secured authorization response
 */
async function createJARMResponse(
  c: Context<{ Bindings: Env }>,
  redirectUri: string,
  params: Record<string, string>,
  baseMode: string,
  clientId: string
): Promise<Response> {
  try {
    // Get client metadata to check for encryption requirements (request-level cached)
    const client = await getClientCached(c, c.env, clientId);
    if (!client) {
      throw new Error('Client authentication failed');
    }

    // Build JWT payload from response parameters
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: c.env.ISSUER_URL, // Issuer
      aud: clientId, // Audience (client_id)
      exp: now + 600, // Expires in 10 minutes
      iat: now, // Issued at
      ...params, // Include all response parameters
    };

    // Get server's signing key
    const privateKeyPem = c.env.PRIVATE_KEY_PEM;
    if (!privateKeyPem) {
      throw new Error('Server private key not configured');
    }

    const privateKey = await importPKCS8(privateKeyPem, 'RS256');

    // Get key ID from KV or use default
    let kid = 'default';
    try {
      if (c.env.KV) {
        const signingKey = (await c.env.KV.get('keys:signing', 'json')) as { kid: string } | null;
        if (signingKey?.kid) {
          kid = signingKey.kid;
        }
      }
    } catch (error) {
      moduleLogger.warn('Failed to get signing key ID, using default', {
        action: 'signing_key_id_fallback',
      });
    }

    // Sign the JWT
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .sign(privateKey);

    let responseToken = jwt;

    // Check if client requested encryption
    if (
      client.authorization_encrypted_response_alg &&
      client.authorization_encrypted_response_enc
    ) {
      // Encrypt the JWT using client's public key
      let clientPublicKeyJWK: PublicJWK | undefined;

      if (
        client.jwks &&
        typeof client.jwks === 'object' &&
        client.jwks !== null &&
        'keys' in client.jwks &&
        Array.isArray(client.jwks.keys)
      ) {
        // Find encryption key
        const encKey = (client.jwks.keys as PublicJWK[]).find((key) => isEncryptionJWK(key));

        if (!encKey) {
          throw new Error('No suitable encryption key found in client jwks');
        }

        clientPublicKeyJWK = encKey;
      } else if (client.jwks_uri && typeof client.jwks_uri === 'string') {
        // SSRF protection: Block requests to internal addresses
        if (isInternalUrl(client.jwks_uri)) {
          throw new Error('SSRF protection: jwks_uri cannot point to internal addresses');
        }

        // Fetch JWKS from jwks_uri
        const jwksResponse = await fetch(client.jwks_uri);
        if (!jwksResponse.ok) {
          throw new Error('Failed to fetch client jwks_uri');
        }

        const jwks = (await jwksResponse.json()) as JWKS;
        const encKey = jwks.keys.find((key) => isEncryptionJWK(key));

        if (!encKey) {
          throw new Error('No suitable encryption key found in client jwks_uri');
        }

        clientPublicKeyJWK = encKey;
      } else {
        throw new Error('Client requested encryption but no public key available');
      }

      // Encrypt the signed JWT (using jwe.ts encryptJWT)
      // Type assertions for JWE algorithm types (validated during client registration)
      responseToken = await encryptJWT(
        jwt, // The signed JWT string
        clientPublicKeyJWK, // JWK format
        {
          alg: client.authorization_encrypted_response_alg as JWEAlgorithm,
          enc: client.authorization_encrypted_response_enc as JWEEncryption,
          cty: 'JWT',
        }
      );
    }

    // Build response with single 'response' parameter containing the JWT
    const jarmParams: Record<string, string> = {
      response: responseToken,
    };

    // Send response using base mode
    if (baseMode === 'form_post') {
      return createFormPostResponse(c, redirectUri, jarmParams);
    } else if (baseMode === 'fragment') {
      return createFragmentResponse(c, redirectUri, jarmParams);
    } else {
      return createQueryResponse(c, redirectUri, jarmParams);
    }
  } catch (error) {
    moduleLogger.error(
      'Failed to create JARM response',
      { action: 'jarm_response' },
      error as Error
    );
    // Fall back to error redirect
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create JWT-secured authorization response',
      },
      500
    );
  }
}

/**
 * Escape HTML special characters to prevent XSS
 * Essential for safely embedding user-provided values in HTML
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Handle login screen (TEST/STUB ONLY)
 * GET/POST /flow/login
 *
 * ⚠️ PII/Non-PII SEPARATION NOTE:
 * This is a STUB implementation for OIDC Conformance Testing.
 * It creates test users with PII data, which requires PIIContext.
 *
 * In production:
 * - Real login flows use /api/auth/passkeys, /api/auth/email-codes, etc.
 * - Users are created through proper signup flows
 * - This endpoint is only used for OIDC certification tests
 *
 * Non-certification test clients require ENABLE_TEST_ENDPOINTS=true
 */
export async function authorizeLoginHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AUTHORIZE');
  // Parse challenge_id and username from request
  let challenge_id: string | undefined;
  let loginUsername: string | undefined;

  if (c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      challenge_id = typeof body.challenge_id === 'string' ? body.challenge_id : undefined;
      loginUsername = typeof body.username === 'string' ? body.username : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    challenge_id = c.req.query('challenge_id');
  }

  if (!challenge_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing challenge_id parameter',
      },
      400
    );
  }

  // GET request: Show login form (stub implementation with username/password fields)
  if (c.req.method === 'GET') {
    // Fetch challenge data to display client logo and info (OIDC Dynamic OP conformance)
    let logoUri: string | undefined;
    let clientName: string | undefined;
    let policyUri: string | undefined;
    let tosUri: string | undefined;

    try {
      const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);
      const challengeData = (await challengeStore.getChallengeRpc(challenge_id)) as {
        id: string;
        type: string;
        metadata?: {
          logo_uri?: string;
          client_name?: string;
          policy_uri?: string;
          tos_uri?: string;
          [key: string]: unknown;
        };
      } | null;
      if (challengeData?.metadata) {
        logoUri = challengeData.metadata.logo_uri;
        clientName = challengeData.metadata.client_name;
        policyUri = challengeData.metadata.policy_uri;
        tosUri = challengeData.metadata.tos_uri;
      }
    } catch (e) {
      log.warn('Failed to fetch challenge data for client info', { action: 'challenge_fetch' });
    }

    // Build client info section HTML
    const clientInfoHtml =
      logoUri || clientName
        ? `
    <div class="client-info">
      ${logoUri ? `<img src="${escapeHtml(logoUri)}" alt="${escapeHtml(clientName || 'Client')} logo" class="client-logo" onerror="this.style.display='none'">` : ''}
      ${clientName ? `<p class="client-name">Signing in to <strong>${escapeHtml(clientName)}</strong></p>` : ''}
      ${
        policyUri || tosUri
          ? `<div class="client-links">
        ${policyUri ? `<a href="${escapeHtml(policyUri)}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>` : ''}
        ${tosUri ? `<a href="${escapeHtml(tosUri)}" target="_blank" rel="noopener noreferrer">Terms of Service</a>` : ''}
      </div>`
          : ''
      }
    </div>`
        : '';

    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Required</title>
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
      max-width: 400px;
      width: 100%;
    }
    .client-info {
      text-align: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid #eee;
    }
    .client-logo {
      max-width: 120px;
      max-height: 80px;
      object-fit: contain;
      margin-bottom: 0.5rem;
    }
    .client-name {
      margin: 0.5rem 0;
      color: #666;
      font-size: 0.9rem;
    }
    .client-links {
      margin-top: 0.5rem;
      font-size: 0.8rem;
    }
    .client-links a {
      color: #667eea;
      text-decoration: none;
      margin: 0 0.5rem;
    }
    .client-links a:hover {
      text-decoration: underline;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #333;
    }
    p {
      margin: 0 0 1.5rem 0;
      color: #666;
      line-height: 1.5;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    input {
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
    }
    button {
      padding: 0.75rem;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    ${clientInfoHtml}
    <h1>Login Required</h1>
    <p>Please enter your credentials to continue.</p>
    <form method="POST" action="/flow/login">
      <input type="hidden" name="challenge_id" value="${challenge_id}">
      <input type="text" name="username" placeholder="Username" required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`);
  }

  // POST request: Process login (stub - accepts any credentials) (RPC)
  // Use challengeId-based sharding - must match the shard used during challenge creation
  const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

  let challengeData: {
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

  try {
    challengeData = await challengeStore.consumeChallengeRpc({
      id: challenge_id,
      type: 'login',
      challenge: challenge_id,
    });
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid or expired challenge',
      },
      400
    );
  }

  const metadata = challengeData.metadata || {};

  // Determine if this is an OIDC Conformance Test client
  const client_id = metadata.client_id as string | undefined;
  let isCertificationTest = false;

  if (client_id) {
    const clientMetadata = await getClientCached(c, c.env, client_id);
    if (clientMetadata?.redirect_uris && Array.isArray(clientMetadata.redirect_uris)) {
      isCertificationTest = (clientMetadata.redirect_uris as string[]).some((uri: string) =>
        uri.includes('certification.openid.net')
      );
    }
  }

  // Create a new user and session (stub - in production, verify credentials first)
  let userId: string;
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);

  if (isCertificationTest) {
    // Use fixed test user for OIDC Conformance Tests
    userId = 'user-oidc-conformance-test';
    log.info('Using OIDC Conformance Test user', { action: 'login_test_user' });

    // Verify test user exists in Core DB (should have been created during DCR)
    const existingUser = await authCtx.repositories.userCore.findById(userId);

    if (!existingUser) {
      log.warn('Test user not found, creating it now', { action: 'login_test_user_create' });

      // Step 1: Create user in Core DB with pii_status='pending'
      await authCtx.repositories.userCore
        .createUser({
          id: userId,
          tenant_id: tenantId,
          email_verified: true,
          phone_number_verified: true,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'pending',
        })
        .catch((error: unknown) => {
          // PII Protection: Don't log full error
          log.error('Failed to create test user in Core DB', {
            action: 'login_test_user_core',
            errorName: error instanceof Error ? error.name : 'Unknown error',
          });
        });

      // Step 2: Insert into users_pii (if DB_PII is configured)
      if (c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        await piiCtx.piiRepositories.userPII
          .createPII({
            id: userId,
            tenant_id: tenantId,
            pii_class: 'PROFILE',
            email: 'test@example.com',
            name: 'John Doe',
            given_name: 'John',
            family_name: 'Doe',
            nickname: 'Johnny',
            preferred_username: 'test',
            picture: 'https://example.com/avatar.jpg',
            website: 'https://example.com',
            gender: 'male',
            birthdate: '1990-01-01',
            zoneinfo: 'America/New_York',
            locale: 'en-US',
            phone_number: '+1-555-0100',
            address_formatted: '1234 Main St, Anytown, ST 12345, USA',
            address_street_address: '1234 Main St',
            address_locality: 'Anytown',
            address_region: 'ST',
            address_postal_code: '12345',
            address_country: 'USA',
          })
          .catch((error: unknown) => {
            // PII Protection: Don't log full error
            log.error('Failed to create test user in PII DB', {
              action: 'login_test_user_pii',
              errorName: error instanceof Error ? error.name : 'Unknown error',
            });
          });

        // Step 3: Update pii_status to 'active'
        await authCtx.repositories.userCore
          .updatePIIStatus(userId, 'active')
          .catch((error: unknown) => {
            // PII Protection: Don't log full error
            log.error('Failed to update pii_status', {
              action: 'login_pii_status_update',
              errorName: error instanceof Error ? error.name : 'Unknown error',
            });
          });
      }
    }
  } else {
    // Normal client: create new random user
    // ⚠️ PII/Non-PII SEPARATION NOTE:
    // This is a STUB implementation for testing purposes only.
    // Requires ENABLE_TEST_ENDPOINTS=true for non-certification test clients.
    //
    // In production, users should be created through proper flows:
    // - /api/auth/passkey (WebAuthn registration)
    // - /api/auth/email-code (Passwordless OTP)
    // - External IdP (SAML/OIDC federation)
    if (c.env.ENABLE_TEST_ENDPOINTS !== 'true') {
      log.warn('Non-certification client attempted stub login without ENABLE_TEST_ENDPOINTS', {
        action: 'login_stub_denied',
      });
      return c.json(
        {
          error: 'access_denied',
          error_description:
            'Stub login is only available for OIDC certification tests or when ENABLE_TEST_ENDPOINTS is enabled',
        },
        403
      );
    }

    log.info('Creating stub user (ENABLE_TEST_ENDPOINTS=true)', {
      action: 'login_stub_user_create',
    });
    userId = 'user-' + crypto.randomUUID();

    // Use the email from login form, or fall back to a dummy email
    const userEmail = loginUsername || `${userId}@example.com`;

    // Step 1: Create user in Core DB with pii_status='pending'
    await authCtx.repositories.userCore
      .createUser({
        id: userId,
        tenant_id: tenantId,
        email_verified: false,
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: 'pending',
      })
      .catch((error: unknown) => {
        // PII Protection: Don't log full error
        log.error('Failed to create user in Core DB', {
          action: 'login_user_core_create',
          errorName: error instanceof Error ? error.name : 'Unknown error',
        });
      });

    // Step 2: Insert into users_pii (if DB_PII is configured)
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      try {
        await piiCtx.piiRepositories.userPII.createPII({
          id: userId,
          tenant_id: tenantId,
          email: userEmail,
        });

        // Step 3: Update pii_status to 'active' (only on successful PII DB write)
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
      } catch (error: unknown) {
        // PII Protection: Don't log full error
        log.error('Failed to create user in PII DB', {
          action: 'login_user_pii_create',
          errorName: error instanceof Error ? error.name : 'Unknown error',
        });
        // Update pii_status to 'failed' to indicate PII DB write failure
        await authCtx.repositories.userCore
          .updatePIIStatus(userId, 'failed')
          .catch((statusError: unknown) => {
            // PII Protection: Don't log full error
            log.error('Failed to update pii_status to failed', {
              action: 'login_pii_status_failed',
              errorName: statusError instanceof Error ? statusError.name : 'Unknown error',
            });
          });
      }
    } else {
      log.warn('DB_PII not configured - user created with pii_status=pending', {
        action: 'login_pii_missing',
      });
    }
  }

  // Calculate auth_time BEFORE creating session to ensure consistency
  // This value will be used for both the session and the redirect parameter
  const loginAuthTime = Math.floor(Date.now() / 1000);

  // Profile-based session management (Human Auth / AI Ephemeral Auth two-layer model)
  // For AI Ephemeral profile (uses_do_for_state=false), skip session creation.
  // AI agents typically don't maintain browser sessions - they use tokens directly.
  const sessionTenantProfile = await loadTenantProfileCached(
    c,
    c.env.AUTHRIM_CONFIG,
    c.env,
    tenantId
  );

  if (sessionTenantProfile.uses_do_for_state) {
    // Human profile: Create session using sharded SessionStore
    const { stub: sessionStore, sessionId: newSessionId } = await getSessionStoreForNewSession(
      c.env
    );

    try {
      await sessionStore.createSessionRpc(
        newSessionId, // Required: Sharded session ID
        userId,
        3600, // 1 hour session
        {
          clientId: metadata.client_id as string,
          authTime: loginAuthTime, // Store auth_time for OIDC conformance (prompt=none consistency)
        }
      );

      // Set session cookie with the pre-generated sharded session ID (HttpOnly for security)
      // SameSite is determined dynamically based on origin configuration
      const sessionSameSiteValue = getSessionCookieSameSite(c.env);
      c.header(
        'Set-Cookie',
        `authrim_session=${newSessionId}; Path=/; HttpOnly; SameSite=${sessionSameSiteValue}; Secure; Max-Age=3600`
      );

      // Generate and set browser state cookie for OIDC Session Management
      // This cookie is NOT HttpOnly so check_session_iframe can read it via JavaScript
      const browserState = await generateBrowserState(newSessionId);
      const browserStateSameSiteValue = getBrowserStateCookieSameSite(c.env);
      c.res.headers.append(
        'Set-Cookie',
        `${BROWSER_STATE_COOKIE_NAME}=${browserState}; Path=/; SameSite=${browserStateSameSiteValue}; Secure; Max-Age=3600`
      );
    } catch (error) {
      log.error('Failed to create session', { action: 'session_create' }, error as Error);
      // Continue even if session creation fails - user can re-login
    }
  } else {
    // AI Ephemeral profile: Skip session creation (stateless approach)
    // AI agents will use the authorization code to obtain tokens directly
    log.info('AI Ephemeral profile - skipping session creation (stateless mode)', {
      action: 'session_skip_ai',
    });
  }

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

  // Add a flag to indicate login is complete
  params.set('_confirmed', 'true');

  // Pass auth_time to ensure consistency between initial login and prompt=none requests
  // This is critical for OIDC conformance: auth_time in ID tokens must be identical
  // when the user is authenticated once and then prompt=none is used
  // Use the same loginAuthTime that was stored in the session
  params.set('_auth_time', loginAuthTime.toString());
  log.debug('Setting auth_time for authorization redirect', {
    action: 'auth_time_set',
    authTime: loginAuthTime,
  });

  // Redirect to /authorize with original parameters
  const redirectUrl = `/authorize?${params.toString()}`;
  return c.redirect(redirectUrl, 302);
}

/**
 * Handle re-authentication confirmation
 * POST /flow/confirm
 */
export async function authorizeConfirmHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AUTHORIZE');
  // Parse challenge_id from request
  let challenge_id: string | undefined;

  if (c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      challenge_id = typeof body.challenge_id === 'string' ? body.challenge_id : undefined;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        },
        400
      );
    }
  } else {
    challenge_id = c.req.query('challenge_id');
  }

  if (!challenge_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing challenge_id parameter',
      },
      400
    );
  }

  // GET request: Show re-authentication confirmation form with username/password
  if (c.req.method === 'GET') {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Re-authentication Required</title>
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
      max-width: 400px;
      width: 100%;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #333;
    }
    p {
      margin: 0 0 1.5rem 0;
      color: #666;
      line-height: 1.5;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    input {
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Re-authentication Required</h1>
    <p>For security reasons, please re-enter your credentials.</p>
    <form method="POST" action="/flow/confirm">
      <input type="hidden" name="challenge_id" value="${challenge_id}">
      <input type="text" name="username" placeholder="Username" required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Confirm</button>
    </form>
  </div>
</body>
</html>`);
  }

  // POST request: Process confirmation and redirect to /authorize (RPC)
  // Use challengeId-based sharding - must match the shard used during challenge creation
  const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

  let challengeData: {
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
      sessionUserId?: string;
      [key: string]: unknown;
    };
  };

  try {
    challengeData = await challengeStore.consumeChallengeRpc({
      id: challenge_id,
      type: 'reauth',
      challenge: challenge_id,
    });
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid or expired challenge',
      },
      400
    );
  }

  const metadata = challengeData.metadata || {};

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
  if (metadata.prompt) {
    params.set('prompt', metadata.prompt as string);
    log.debug('Passing prompt to confirmation redirect', {
      action: 'confirm_prompt',
      prompt: metadata.prompt,
    });
  }
  if (metadata.acr_values) params.set('acr_values', metadata.acr_values as string);

  // Add a flag to indicate this is a re-authentication confirmation
  params.set('_confirmed', 'true');

  // Preserve original auth_time and sessionUserId for consistency
  if (metadata.authTime) {
    params.set('_auth_time', metadata.authTime.toString());
    log.debug('Passing auth_time to confirmation redirect', {
      action: 'confirm_auth_time',
      authTime: metadata.authTime,
    });
  }
  if (metadata.sessionUserId) params.set('_session_user_id', metadata.sessionUserId as string);

  // Redirect to /authorize with original parameters
  const redirectUrl = `/authorize?${params.toString()}`;
  return c.redirect(redirectUrl, 302);
}

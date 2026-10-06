import type { Context } from 'hono';
import type { ClientMetadata, Env } from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  validateResponseType,
  validateClientId,
  validateRedirectUri,
  validateScope,
  validateState,
  validateNonce,
  isRedirectUriRegistered,
  redirectUriMatchOptionsFor,
  resolveEffectiveSettings,
  falRequiresDpop,
  falRequiresSignedPushedRequest,
  computeAAL,
  meetsAAL,
  mergeStepUpEvidence,
  parseScopeAALRequirements,
  parseOutboundAcrMappings,
  parseUpstreamAcrMappings,
  requiredAAL,
  selectAcr,
  aalToAcr,
  sessionAssuranceEvidence,
  type AAL,
  type AssuranceLevel,
  getAuthCodeShardIndex,
  createShardedAuthCode,
  buildAuthCodeShardInstanceName,
  getShardCount,
  buildDOInstanceName,
  getSessionStoreBySessionId,
  deriveOidcSid,
  isShardedSessionId,
  parseShardedSessionId,
  getCachedUser,
  getCachedConsent,
  upsertOAuthClientConsent,
  isOAuthClientConsentGenerationChanged,
  findOAuthClientConsentRevocation,
  type OAuthClientConsentRevocationState,
  getChallengeStoreByChallengeId,
  generateRegionAwareJti,
  createAuthContextFromHono,
  createAccountAuthContextFromHono,
  createPIIContextFromHono,
  getTenantMetadataContextFromHono,
  resolveAccountDataContextFromHono,
  registerSessionClientInStore,
  getTenantIdFromContext,
  getDefaultTenantId,
  getPARRequestStoreByUri,
  parsePARRequestUri,
  // UI Configuration
  getTenantUIConfig,
  buildUIUrl,
  DEFAULT_UI_PATHS,
  type UIConfig,
  // Custom Redirect URIs (Authrim Extension)
  validateCustomRedirectParams,
  // Contract Loader (Human Auth / AI Ephemeral Auth two-layer model)
  filterResponseTypesByProfile,
  // Request-level caching (P0 KV Cache Optimization)
  getClientCached,
  loadTenantProfileCached,
  loadClientContractCached,
  areGuestScopesAllowed,
  // Logging
  getLogger,
  createLogger,
  // Consent Management
  resolveConsentRequirements,
  checkUserConsentSatisfaction,
  getUserClaimsForRules,
  resolveClientTrustPolicy,
  resolveSignInConfirmationPolicy,
  // Settings Manager
  createSettingsManager,
  CLIENT_CATEGORY_META,
  OAUTH_CATEGORY_META,
  parseClaimsRequest,
  evaluateClaimsForTarget,
  buildStandardUserClaims,
  canonicalProjectionToOIDCClaimsUser,
  hasSAORulesForTarget,
  normalizeAttributeReleaseConsentPolicy,
  resolveProtocolSettings,
  type FAPIProtocolSettings,
  type OIDCProtocolSettings,
  resolveAuthorizationResponseSigningAlgorithm,
  resolveIDTokenSigningAlgorithm,
  resolveIDTokenSigningPolicy,
  resolveAppSecurityRequirements,
  type AppSecurityRequirements,
  decryptRequestObject,
  RequestObjectDecryptionError,
  validateIdTokenHint,
  getIssuedIDTokenKeys,
  importIssuedTokenKey,
  deriveOIDCSubject,
  selectJWEEncryptionKey,
  setBoundedMapEntry,
  timingSafeEqual,
  type OIDCSigningAlgorithm,
} from '@authrim/ar-lib-core';
import type { CachedUser, CachedConsent } from '@authrim/ar-lib-core';
import type { Session, SessionData, PARRequestData } from '@authrim/ar-lib-core';
import type { PublicJWK, JWKS } from '@authrim/ar-lib-core';
import { isSigningJWK } from '@authrim/ar-lib-core';
import { safeFetch, safeFetchJson } from '@authrim/ar-lib-core';
import { validateAuthorizationDetails } from '@authrim/ar-lib-core';
import {
  CONSENT_CONFIRMATION_COOKIE_NAME,
  parseAuthorizationRequestContinuation,
  type AuthorizationRequestContinuation,
  type AuthorizationRequestSource,
} from './authorization-continuation';
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
import { SignJWT, importJWK, importPKCS8, type CryptoKey } from 'jose';
// NIST SP 800-63-4 Assurance Levels
import { type FAL } from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';
import type { FAPI2MessageSigningConfig } from './fapi-message-signing';
import { timeAuthRequestDiagnosticOperation } from './request-diagnostics';

const DEFAULT_HANDOFF_ARTIFACT_TTL_SECONDS = 60;
const MIN_HANDOFF_ARTIFACT_TTL_SECONDS = 30;
const MAX_HANDOFF_ARTIFACT_TTL_SECONDS = 300;
const HTTPS_REQUEST_URI_MAX_REDIRECTS = 5;
const AUTHORIZE_CONFIRMATION_COOKIE_NAME = 'authrim_authorize_confirmation';
const DEFAULT_CLIENT_AUTHORIZATION_SCOPES = ['openid', 'profile', 'email'];

function splitScopes(scope: string | undefined | null): string[] {
  return (scope ?? '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function collectRequestedClaimNames(
  request: ReturnType<typeof parseClaimsRequest>['request']
): string[] {
  if (!request) return [];
  return Array.from(
    new Set([...Object.keys(request.userinfo ?? {}), ...Object.keys(request.id_token ?? {})])
  );
}

/**
 * A re-authentication completed before the consent screen, as the consent challenge carries it
 * back: its auth_time (seconds), when it was asked for, and the step-up it completed.
 */
interface ConfirmedReauthentication {
  authTime: number;
  reauthIssuedAt?: number;
  assuranceStepUp?: { priorSessionId?: string; issuedAt: number };
}

function readConfirmedReauthentication(value: unknown): ConfirmedReauthentication | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const authTime = record.auth_time;
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0) {
    return undefined;
  }
  const reauthIssuedAt =
    typeof record.reauth_issued_at === 'number' && Number.isSafeInteger(record.reauth_issued_at)
      ? record.reauth_issued_at
      : undefined;
  const stepUp = record.assurance_step_up as
    | { prior_session_id?: unknown; issued_at?: unknown }
    | null
    | undefined;
  const assuranceStepUp =
    stepUp &&
    typeof stepUp === 'object' &&
    typeof stepUp.issued_at === 'number' &&
    Number.isSafeInteger(stepUp.issued_at)
      ? {
          priorSessionId:
            typeof stepUp.prior_session_id === 'string' &&
            isShardedSessionId(stepUp.prior_session_id)
              ? stepUp.prior_session_id
              : undefined,
          issuedAt: stepUp.issued_at,
        }
      : undefined;
  return { authTime, reauthIssuedAt, assuranceStepUp };
}

function getClientAllowedScopes(clientMetadata: {
  allowed_scopes?: string[] | null;
  requestable_scopes?: string[] | null;
  scope?: string | null;
}): string[] {
  if (
    Array.isArray(clientMetadata.requestable_scopes) &&
    clientMetadata.requestable_scopes.length
  ) {
    return clientMetadata.requestable_scopes;
  }
  if (Array.isArray(clientMetadata.allowed_scopes) && clientMetadata.allowed_scopes.length) {
    return clientMetadata.allowed_scopes;
  }
  const registeredScopes = splitScopes(clientMetadata.scope);
  return registeredScopes.length > 0 ? registeredScopes : [...DEFAULT_CLIENT_AUTHORIZATION_SCOPES];
}

function isClientPublic(clientMetadata: {
  client_secret_hash?: string | null;
  client_secret?: string | null;
  token_endpoint_auth_method?: string | null;
}): boolean {
  return (
    clientMetadata.token_endpoint_auth_method === 'none' ||
    (!clientMetadata.client_secret_hash && !clientMetadata.client_secret)
  );
}

function responseTypeIssuesAuthorizationCode(responseType: string | undefined): boolean {
  return splitScopes(responseType).includes('code');
}

async function loadOIDCClaimsUser(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string,
  piiCtx: ReturnType<typeof createPIIContextFromHono>
): Promise<
  Awaited<ReturnType<typeof getCachedUser>> | ReturnType<typeof canonicalProjectionToOIDCClaimsUser>
> {
  const canonicalProjectionRepository = new CanonicalRuntimeUserProjectionRepository(
    piiCtx.coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiCtx.defaultPiiAdapter)
  );
  const projection = await canonicalProjectionRepository.findByLegacyUserId(userId);
  return projection ? canonicalProjectionToOIDCClaimsUser(projection) : null;
}

function clampHandoffArtifactTtlSeconds(value: number): number {
  return Math.min(
    MAX_HANDOFF_ARTIFACT_TTL_SECONDS,
    Math.max(MIN_HANDOFF_ARTIFACT_TTL_SECONDS, value)
  );
}

function parseHandoffArtifactTtlSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampHandoffArtifactTtlSeconds(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return clampHandoffArtifactTtlSeconds(Math.trunc(parsed));
    }
  }
  return undefined;
}

function resolveHandoffArtifactTtlSeconds(
  c: Context<{ Bindings: Env }>,
  clientMetadata: Record<string, unknown>
): number {
  const clientTtl =
    parseHandoffArtifactTtlSeconds(clientMetadata.handoff_artifact_ttl_seconds) ??
    parseHandoffArtifactTtlSeconds(clientMetadata.handoff_artifact_ttl);
  if (clientTtl !== undefined) {
    return clientTtl;
  }

  return (
    parseHandoffArtifactTtlSeconds(
      (c.env as unknown as Record<string, unknown>).HANDOFF_ARTIFACT_TTL_SECONDS
    ) ?? DEFAULT_HANDOFF_ARTIFACT_TTL_SECONDS
  );
}

/**
 * Whether a request_uri host is an allowed domain or under it. An empty entry (from a list such as
 * 'a.example,') matches nothing: otherwise every host ending in a dot would be under it.
 */
function domainMatches(host: string, allowed: string): boolean {
  return allowed !== '' && (host === allowed || host.endsWith('.' + allowed));
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ===== Key Caching for Performance Optimization =====
// Per-tenant Map cache for signing keys (avoids expensive RSA key import on every request)
const signingKeyCache = new Map<
  string,
  {
    privateKey: CryptoKey;
    kid: string;
    timestamp: number;
    version: string;
  }
>();
const KEY_CACHE_TTL = 60000; // 60 seconds
const MAX_SIGNING_KEY_CACHE_ENTRIES = 128;

// ===== SettingsManager Caching for Performance Optimization =====
// Cache SettingsManager instance to avoid recreating it on every request
// This reduces ~133ms (2x KV reads) to near-zero for cached requests
let cachedSettingsManager: ReturnType<typeof createSettingsManager> | null = null;
let cachedSettingsTimestamp = 0;
let cachedSettingsBinding: Env['SETTINGS'] | null = null;
const SETTINGS_CACHE_TTL = 60000; // 60 seconds

/**
 * Get or create cached SettingsManager instance
 * Reuses the same instance for SETTINGS_CACHE_TTL (60s) to improve performance
 */
function getSettingsManager(env: Env): ReturnType<typeof createSettingsManager> {
  const now = Date.now();
  const currentSettingsBinding = env.SETTINGS ?? null;

  // Return cached instance if valid
  if (
    cachedSettingsManager &&
    cachedSettingsBinding === currentSettingsBinding &&
    now - cachedSettingsTimestamp < SETTINGS_CACHE_TTL
  ) {
    return cachedSettingsManager;
  }

  // Create new instance with extended cache TTL
  const settingsManager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    cacheTTL: 60000, // 60 seconds (increased from 5s)
  });

  // Register required categories
  settingsManager.registerCategory(CLIENT_CATEGORY_META);
  settingsManager.registerCategory(OAUTH_CATEGORY_META);

  // Update cache
  cachedSettingsManager = settingsManager;
  cachedSettingsTimestamp = now;
  cachedSettingsBinding = currentSettingsBinding;

  return settingsManager;
}

// ===== Module-level Logger for Helper Functions =====
const moduleLogger = createLogger().module('AUTHORIZE');

// ===== UI Redirect Result Type =====
/**
 * Result of determining UI redirect target
 */
type UIRedirectResult =
  | { type: 'redirect'; url: string }
  | { type: 'config_error'; reason: 'ui_not_configured' };

/**
 * Determine the UI redirect target from the client's, tenant's or global UI configuration.
 *
 * Priority:
 * 1. Client login UI URL → redirect there
 * 2. Tenant or global UI configured → redirect to that UI
 * 3. Neither → signal configuration error
 *
 * @param env - Environment bindings
 * @param path - UI path key (e.g., 'login', 'consent', 'error')
 * @param queryParams - Query parameters to append to URL
 * @param tenantId - The request's tenant: its UI settings apply, and the UI gets it as a
 *   branding hint (tenant_hint)
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
  tenantId?: string,
  clientLoginUiUrl?: string | null,
  issuerUiBaseUrl?: string | null
): Promise<UIRedirectResult> {
  // Check client-specific login UI URL (priority 1)
  if (clientLoginUiUrl) {
    const clientConfig: UIConfig = {
      baseUrl: clientLoginUiUrl,
      paths: DEFAULT_UI_PATHS,
    };
    const url = buildUIUrl(clientConfig, path, queryParams, tenantId);
    return { type: 'redirect', url };
  }

  // Check the tenant's, else the global, UI configuration (priority 2). A UI base URL the
  // tenant set is its explicit choice, so it goes before the issuer-hosted Login UI.
  const { config: uiConfig, tenantBaseUrl } = await getTenantUIConfig(env, tenantId);
  if (!uiConfig?.baseUrl) {
    return { type: 'config_error', reason: 'ui_not_configured' };
  }

  const baseUrl =
    !tenantBaseUrl && shouldUseIssuerHostedUi(env, issuerUiBaseUrl)
      ? issuerUiBaseUrl!
      : uiConfig.baseUrl;
  const effectiveUiConfig: UIConfig = {
    ...uiConfig,
    baseUrl,
  };

  // Build UI URL with optional query params and tenant hint
  const url = buildUIUrl(effectiveUiConfig, path, queryParams, tenantId);
  return { type: 'redirect', url };
}

function shouldUseIssuerHostedUi(env: Env, issuerUiBaseUrl?: string | null): boolean {
  if (!issuerUiBaseUrl || env.LOGIN_UI_ENABLED === 'false') {
    return false;
  }

  // Setup-generated deployments pin browser Login UI execution to the issuer.
  // This preserves the primary tenant's Login UI origin when a custom-domain
  // single-tenant deployment is later expanded to multi-tenant routing.
  if (env.LOGIN_UI_EXECUTION_HOST_MODE === 'issuer') {
    return true;
  }
  if (env.LOGIN_UI_EXECUTION_HOST_MODE === 'dedicated') {
    return false;
  }

  // Legacy configurations used issuer-hosted Login UI only for multi-tenant
  // deployments. Preserve that behavior until they opt in explicitly.
  if (!env.BASE_DOMAIN) {
    return false;
  }

  try {
    const issuerOrigin = new URL(issuerUiBaseUrl).origin;
    return issuerOrigin === issuerUiBaseUrl.replace(/\/$/, '');
  } catch {
    return false;
  }
}

function getTenantAwareUiQueryParams(
  c: Context<{ Bindings: Env }>,
  queryParams: Record<string, string>
): Record<string, string> {
  const issuer = getRequestIssuer(c);
  try {
    return {
      ...queryParams,
      tenant_host: new URL(issuer).host,
    };
  } catch {
    return queryParams;
  }
}

function getChallengeUiQueryParams(
  challengeId: string,
  uiLocales: string | undefined
): Record<string, string> {
  const normalizedUiLocales = uiLocales?.trim();
  return {
    challenge_id: challengeId,
    ...(normalizedUiLocales ? { ui_locales: normalizedUiLocales } : {}),
  };
}

function createLocalUiUnavailableResponse(
  c: Context<{ Bindings: Env }>,
  title = 'Authorization UI Unavailable',
  description = 'Login UI is not configured. Please try again later or contact the administrator.'
): Response {
  return c.html(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f4f5f7;
      color: #1f2937;
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      max-width: 520px;
      width: calc(100% - 2rem);
      border: 1px solid #e5e7eb;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #b42318;
    }
    p {
      margin: 0 0 1rem 0;
      line-height: 1.5;
      color: #475467;
    }
    .error-code {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 0.75rem;
      font-family: monospace;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${description}</p>
    <div class="error-code">
      <strong>Error:</strong> temporarily_unavailable<br>
      <strong>Description:</strong> Login UI is not configured
    </div>
  </div>
</body>
</html>`,
    400
  );
}

function createLocalAuthorizationErrorResponse(
  c: Context<{ Bindings: Env }>,
  error: string,
  description: string,
  title = 'Invalid Authorization Request'
): Response {
  const safeTitle = escapeHtml(title);
  const safeError = escapeHtml(error);
  const safeDescription = escapeHtml(description);
  return c.html(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f4f5f7;
      color: #1f2937;
    }
    .container {
      background: white;
      padding: 2rem;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      max-width: 520px;
      width: calc(100% - 2rem);
      border: 1px solid #e5e7eb;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
      color: #b42318;
    }
    p {
      margin: 0 0 1rem 0;
      line-height: 1.5;
      color: #475467;
    }
    .error-code {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 0.75rem;
      font-family: monospace;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${safeTitle}</h1>
    <p>${safeDescription}</p>
    <div class="error-code">
      <strong>Error:</strong> ${safeError}<br>
      <strong>Description:</strong> ${safeDescription}
    </div>
  </div>
</body>
</html>`,
    400
  );
}

async function cleanupFailedUIChallenge(
  challengeStore: { deleteChallengeRpc(id: string): Promise<{ deleted: boolean }> },
  challengeId: string,
  challengeType: 'login' | 'reauth' | 'consent'
): Promise<void> {
  try {
    const result = await challengeStore.deleteChallengeRpc(challengeId);
    if (!result.deleted) {
      moduleLogger.warn('Failed to delete challenge after UI configuration error', {
        action: 'ui_config_challenge_cleanup_missing',
        challengeId,
        challengeType,
      });
    }
  } catch (error) {
    moduleLogger.warn(
      'Failed to delete challenge after UI configuration error',
      {
        action: 'ui_config_challenge_cleanup_error',
        challengeId,
        challengeType,
      },
      error as Error
    );
  }
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
  let dpop_jkt: string | undefined;
  let authorization_details: string | undefined; // RFC 9396: Rich Authorization Requests
  let request_uri: string | undefined;
  let par_request_uri: string | undefined;
  let response_mode: string | undefined;
  let request: string | undefined; // RFC 9101: Request Object (JAR)
  let prompt: string | undefined;
  let max_age: string | undefined;
  let id_token_hint: string | undefined;
  let acr_values: string | undefined;
  let display: string | undefined;
  let ui_locales: string | undefined;
  let login_hint: string | undefined;
  let handoff: string | undefined; // Authrim Extension: Session Token Handoff SSO
  let claimsRequestIntegrityProtected = false;
  // The request came in a request object the client signed (verified), directly or pushed.
  let requestObjectSigned = false;
  // The request came in a request object encrypted to this tenant, directly or pushed.
  let requestObjectEncrypted = false;
  let authorizationRequestSource: AuthorizationRequestSource = 'frontchannel';
  let restoredAuthorizationRequest: AuthorizationRequestContinuation | undefined;
  let _confirmed: string | undefined;
  let _auth_time: string | undefined;
  let _session_user_id: string | undefined;
  // The confirmation of an assurance step-up: when it began (only an authentication after it is
  // the step-up's), and the session the user had before stepping up, when there was one.
  let confirmedAssuranceStepUp: { priorSessionId?: string; issuedAt: number } | undefined;
  // The confirmation of a re-authentication: when it was asked for (milliseconds). Only a session
  // proven after it is that re-authentication's result.
  let confirmedReauthIssuedAt: number | undefined;
  // The auth_time of a re-authentication completed before consent: the consent screen ran after it,
  // so the time it was confirmed (now) would make the authentication look newer than it is.
  let confirmedReauthAuthTime: number | undefined;
  let _confirmation_challenge: string | undefined;
  let _consent_confirmation_challenge: string | undefined;
  let confirmedConsentUserId: string | undefined;
  // The consent withdrawal generation the confirmed consent was approved under.
  let confirmedConsentGeneration: number | undefined;
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
      dpop_jkt = typeof body.dpop_jkt === 'string' ? body.dpop_jkt : undefined;
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
      _confirmation_challenge =
        typeof body._confirmation_challenge === 'string' ? body._confirmation_challenge : undefined;
      _consent_confirmation_challenge =
        typeof body._consent_confirmation_challenge === 'string'
          ? body._consent_confirmation_challenge
          : undefined;
      // Phase 2-B RBAC extensions
      org_id = typeof body.org_id === 'string' ? body.org_id : undefined;
      acting_as = typeof body.acting_as === 'string' ? body.acting_as : undefined;
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
    dpop_jkt = c.req.query('dpop_jkt');
    authorization_details = c.req.query('authorization_details');
    response_mode = c.req.query('response_mode');
    prompt = c.req.query('prompt');
    max_age = c.req.query('max_age');
    id_token_hint = c.req.query('id_token_hint');
    acr_values = c.req.query('acr_values');
    display = c.req.query('display');
    ui_locales = c.req.query('ui_locales');
    login_hint = c.req.query('login_hint');
    handoff = c.req.query('handoff');
    _confirmation_challenge = c.req.query('_confirmation_challenge');
    _consent_confirmation_challenge = c.req.query('_consent_confirmation_challenge');
    // Phase 2-B RBAC extensions
    org_id = c.req.query('org_id');
    acting_as = c.req.query('acting_as');
    // Custom Redirect URIs (Authrim Extension)
    error_uri = c.req.query('error_uri') ?? undefined;
    cancel_uri = c.req.query('cancel_uri') ?? undefined;
  }

  // RFC 9101 Section 5: request and request_uri are mutually exclusive.
  // Reject before resolving either container so one protected request cannot
  // silently override the other.
  if (request && request_uri) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'request and request_uri must not be used together',
      },
      400
    );
  }

  if (_confirmation_challenge) {
    const tenantId = getTenantIdFromContext(c);
    const confirmationStore = await getChallengeStoreByChallengeId(
      c.env,
      _confirmation_challenge,
      tenantId
    );
    type AuthorizeConfirmationData = {
      userId?: string;
      metadata?: {
        purpose?: string;
        authTime?: number;
        sessionUserId?: string;
        sessionId?: string;
        browserBinding?: string;
        authorization_request?: unknown;
        assurance_step_up?: unknown;
        reauth_issued_at?: unknown;
      };
    };
    let confirmationData: AuthorizeConfirmationData;

    try {
      const pendingConfirmation = (await confirmationStore.getChallengeRpc(
        _confirmation_challenge
      )) as AuthorizeConfirmationData | null;
      if (pendingConfirmation?.metadata?.purpose !== 'authorize_confirmation') {
        throw new Error('Invalid confirmation challenge');
      }

      const boundSessionId = pendingConfirmation.metadata.sessionId;
      const browserBinding = pendingConfirmation.metadata.browserBinding;
      if (typeof browserBinding !== 'string' || browserBinding.length === 0) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Authorization confirmation requires browser binding',
          },
          401
        );
      }
      {
        const rawBindingCookie = c.req
          .header('Cookie')
          ?.match(new RegExp(`(?:^|;\\s*)${AUTHORIZE_CONFIRMATION_COOKIE_NAME}=([^;]+)`))?.[1];
        let presentedBrowserBinding: string | undefined;
        try {
          presentedBrowserBinding = rawBindingCookie
            ? decodeURIComponent(rawBindingCookie)
            : undefined;
        } catch {
          presentedBrowserBinding = undefined;
        }
        if (!presentedBrowserBinding || !timingSafeEqual(presentedBrowserBinding, browserBinding)) {
          return c.json(
            {
              error: 'access_denied',
              error_description: 'Authorization confirmation requires the originating browser',
            },
            401
          );
        }
      }
      if (boundSessionId) {
        const rawCookie = c.req.header('Cookie')?.match(/(?:^|;\s*)authrim_session=([^;]+)/)?.[1];
        let presentedSessionId: string | undefined;
        try {
          presentedSessionId = rawCookie ? decodeURIComponent(rawCookie) : undefined;
        } catch {
          presentedSessionId = undefined;
        }
        if (presentedSessionId !== boundSessionId || !isShardedSessionId(boundSessionId)) {
          return c.json(
            {
              error: 'access_denied',
              error_description: 'Authorization confirmation requires the bound session',
            },
            401
          );
        }
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, boundSessionId, tenantId);
        const session = (await sessionStore.getSessionRpc(boundSessionId)) as Session | null;
        if (
          !session ||
          session.userId !== pendingConfirmation.userId ||
          session.expiresAt <= Date.now()
        ) {
          return c.json(
            {
              error: 'access_denied',
              error_description: 'Authorization confirmation requires the bound session',
            },
            401
          );
        }
      }

      confirmationData = (await confirmationStore.consumeChallengeRpc({
        id: _confirmation_challenge,
        tenantId,
        type: 'reauth',
        challenge: _confirmation_challenge,
      })) as typeof confirmationData;
      if (browserBinding) {
        c.res.headers.append(
          'Set-Cookie',
          `${AUTHORIZE_CONFIRMATION_COOKIE_NAME}=; Path=/authorize; HttpOnly; SameSite=${getSessionCookieSameSite(c.env)}; Secure; Max-Age=0`
        );
      }
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired confirmation challenge',
        },
        400
      );
    }

    if (confirmationData.metadata?.purpose !== 'authorize_confirmation') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid confirmation challenge',
        },
        400
      );
    }

    _confirmed = 'true';
    if (typeof confirmationData.metadata.authTime === 'number') {
      _auth_time = confirmationData.metadata.authTime.toString();
    }
    const reauthIssuedAt = confirmationData.metadata.reauth_issued_at;
    if (typeof reauthIssuedAt === 'number' && Number.isSafeInteger(reauthIssuedAt)) {
      confirmedReauthIssuedAt = reauthIssuedAt;
    }
    const stepUp = confirmationData.metadata.assurance_step_up as
      | { prior_session_id?: unknown; issued_at?: unknown }
      | null
      | undefined;
    if (
      stepUp &&
      typeof stepUp === 'object' &&
      typeof stepUp.issued_at === 'number' &&
      Number.isSafeInteger(stepUp.issued_at)
    ) {
      // A step-up was tried (never again), whether or not there is a session to combine with.
      confirmedAssuranceStepUp = {
        priorSessionId:
          typeof stepUp.prior_session_id === 'string' && isShardedSessionId(stepUp.prior_session_id)
            ? stepUp.prior_session_id
            : undefined,
        issuedAt: stepUp.issued_at,
      };
    }
    _session_user_id = confirmationData.metadata.sessionUserId || confirmationData.userId;
    if (confirmationData.metadata.authorization_request !== undefined) {
      const parsed = parseAuthorizationRequestContinuation(
        confirmationData.metadata.authorization_request
      );
      if (!parsed) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid authorization continuation',
          },
          400
        );
      }
      restoredAuthorizationRequest = parsed;
    }
  }

  if (_consent_confirmation_challenge) {
    const tenantId = getTenantIdFromContext(c);
    const confirmationStore = await getChallengeStoreByChallengeId(
      c.env,
      _consent_confirmation_challenge,
      tenantId
    );
    let confirmationData: {
      userId?: string;
      metadata?: {
        purpose?: string;
        sessionId?: string;
        browserBinding?: string;
        authorization_request?: unknown;
        confirmed_reauth?: unknown;
        consent_generation?: unknown;
      };
    };

    try {
      const pendingConfirmation = (await confirmationStore.getChallengeRpc(
        _consent_confirmation_challenge
      )) as typeof confirmationData | null;
      if (pendingConfirmation?.metadata?.purpose !== 'authorize_consent_confirmation') {
        throw new Error('Invalid consent confirmation challenge');
      }

      const boundSessionId = pendingConfirmation.metadata.sessionId;
      const browserBinding = pendingConfirmation.metadata.browserBinding;
      if (
        typeof boundSessionId !== 'string' ||
        boundSessionId.length === 0 ||
        typeof browserBinding !== 'string' ||
        browserBinding.length === 0
      ) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Consent confirmation requires session and browser binding',
          },
          401
        );
      }

      const rawBindingCookie = c.req
        .header('Cookie')
        ?.match(new RegExp(`(?:^|;\\s*)${CONSENT_CONFIRMATION_COOKIE_NAME}=([^;]+)`))?.[1];
      let presentedBrowserBinding: string | undefined;
      try {
        presentedBrowserBinding = rawBindingCookie
          ? decodeURIComponent(rawBindingCookie)
          : undefined;
      } catch {
        presentedBrowserBinding = undefined;
      }
      if (!presentedBrowserBinding || !timingSafeEqual(presentedBrowserBinding, browserBinding)) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Consent confirmation requires the originating browser',
          },
          401
        );
      }

      const rawSessionCookie = c.req
        .header('Cookie')
        ?.match(/(?:^|;\s*)authrim_session=([^;]+)/)?.[1];
      let presentedSessionId: string | undefined;
      try {
        presentedSessionId = rawSessionCookie ? decodeURIComponent(rawSessionCookie) : undefined;
      } catch {
        presentedSessionId = undefined;
      }
      if (presentedSessionId !== boundSessionId || !isShardedSessionId(boundSessionId)) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Consent confirmation requires the bound session',
          },
          401
        );
      }

      const { stub: sessionStore } = getSessionStoreBySessionId(c.env, boundSessionId, tenantId);
      const session = (await sessionStore.getSessionRpc(boundSessionId)) as Session | null;
      if (
        !session ||
        session.userId !== pendingConfirmation.userId ||
        session.expiresAt <= Date.now()
      ) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Consent confirmation requires the bound session',
          },
          401
        );
      }

      confirmationData = (await confirmationStore.consumeChallengeRpc({
        id: _consent_confirmation_challenge,
        tenantId,
        type: 'consent',
        challenge: _consent_confirmation_challenge,
      })) as typeof confirmationData;
      c.res.headers.append(
        'Set-Cookie',
        `${CONSENT_CONFIRMATION_COOKIE_NAME}=; Path=/authorize; HttpOnly; SameSite=${getSessionCookieSameSite(
          c.env
        )}; Secure; Max-Age=0`
      );
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired consent confirmation challenge',
        },
        400
      );
    }

    if (confirmationData.metadata?.purpose !== 'authorize_consent_confirmation') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid consent confirmation challenge',
        },
        400
      );
    }

    _consent_confirmed = 'true';
    confirmedConsentUserId = confirmationData.userId;
    const approvedGeneration = confirmationData.metadata.consent_generation;
    confirmedConsentGeneration =
      typeof approvedGeneration === 'number' && Number.isSafeInteger(approvedGeneration)
        ? approvedGeneration
        : undefined;
    // A re-authentication (prompt=login, max_age, step-up) completed before the consent screen
    // stays completed: the restored request still carries prompt=login / max_age, and asking
    // again would send the user back and forth between the two screens.
    const confirmedReauth = readConfirmedReauthentication(
      confirmationData.metadata.confirmed_reauth
    );
    if (confirmedReauth) {
      _confirmed = 'true';
      confirmedReauthAuthTime = confirmedReauth.authTime;
      confirmedReauthIssuedAt = confirmedReauth.reauthIssuedAt;
      confirmedAssuranceStepUp = confirmedReauth.assuranceStepUp;
    }
    if (confirmationData.metadata.authorization_request !== undefined) {
      const parsed = parseAuthorizationRequestContinuation(
        confirmationData.metadata.authorization_request
      );
      if (!parsed) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid authorization continuation',
          },
          400
        );
      }
      restoredAuthorizationRequest = parsed;
    }
  }

  if (restoredAuthorizationRequest) {
    response_type = restoredAuthorizationRequest.response_type;
    client_id = restoredAuthorizationRequest.client_id;
    redirect_uri = restoredAuthorizationRequest.redirect_uri;
    scope = restoredAuthorizationRequest.scope;
    state = restoredAuthorizationRequest.state;
    nonce = restoredAuthorizationRequest.nonce;
    code_challenge = restoredAuthorizationRequest.code_challenge;
    code_challenge_method = restoredAuthorizationRequest.code_challenge_method;
    claims = restoredAuthorizationRequest.claims;
    dpop_jkt = restoredAuthorizationRequest.dpop_jkt;
    par_request_uri = restoredAuthorizationRequest.par_request_uri;
    authorization_details = restoredAuthorizationRequest.authorization_details;
    response_mode = restoredAuthorizationRequest.response_mode;
    max_age = restoredAuthorizationRequest.max_age;
    prompt = restoredAuthorizationRequest.prompt;
    id_token_hint = restoredAuthorizationRequest.id_token_hint;
    acr_values = restoredAuthorizationRequest.acr_values;
    display = restoredAuthorizationRequest.display;
    ui_locales = restoredAuthorizationRequest.ui_locales;
    login_hint = restoredAuthorizationRequest.login_hint;
    handoff = restoredAuthorizationRequest.handoff;
    org_id = restoredAuthorizationRequest.org_id;
    acting_as = restoredAuthorizationRequest.acting_as;
    error_uri = restoredAuthorizationRequest.error_uri;
    cancel_uri = restoredAuthorizationRequest.cancel_uri;
    request_uri = undefined;
    request = undefined;
    authorizationRequestSource = restoredAuthorizationRequest.source;
    claimsRequestIntegrityProtected = restoredAuthorizationRequest.integrity_protected;
    requestObjectSigned = restoredAuthorizationRequest.request_object_signed === true;
    requestObjectEncrypted = restoredAuthorizationRequest.request_object_encrypted === true;
  }

  const sendRequestUriError = async (error: string, description: string): Promise<Response> => {
    // Request Object processing happens before the main client/redirect validation below. An
    // OAuth error may still be returned to the client, but only after independently proving that
    // the outer client and redirect URI belong to this tenant. Never trust values recovered from
    // an invalid Request Object or PAR entry.
    if (
      client_id &&
      redirect_uri &&
      response_type &&
      validateClientId(client_id).valid &&
      validateResponseType(response_type).valid
    ) {
      try {
        const errorClient = await getClientCached(c, c.env, client_id);
        const requestTenantId = getTenantIdFromContext(c);
        const errorClientTenantId =
          typeof errorClient?.tenant_id === 'string' && errorClient.tenant_id.length > 0
            ? errorClient.tenant_id
            : requestTenantId;
        const registeredRedirectUris = errorClient?.redirect_uris;
        // http only on a loopback host, for a native app or as the tenant allows (as the main
        // path decides); a policy that cannot be read allows the native app's only.
        const errorPolicy = errorClient
          ? await resolveAppSecurityRequirements(c.env, requestTenantId, client_id).catch(
              () => null
            )
          : null;
        const redirectValidation = validateRedirectUri(
          redirect_uri,
          errorClient?.application_type === 'native' ||
            (errorPolicy !== null && !errorPolicy.httpsRedirectOnly)
        );
        if (
          errorClient &&
          errorClientTenantId === requestTenantId &&
          Array.isArray(registeredRedirectUris) &&
          redirectValidation.valid &&
          isRedirectUriRegistered(
            redirect_uri,
            registeredRedirectUris,
            redirectUriMatchOptionsFor(errorClient)
          )
        ) {
          return redirectWithError(c, redirect_uri, error, description, state, {
            responseMode: response_mode,
            responseType: response_type,
            clientId: client_id,
          });
        }
      } catch (validationError) {
        log.warn('Failed to validate redirect for request_uri error', {
          action: 'request_uri_error_redirect_validation',
          error: validationError instanceof Error ? validationError.message : 'unknown',
        });
      }
    }

    return c.json({ error, error_description: description }, 400);
  };

  // RFC 9126: If request_uri is present, fetch parameters from PAR storage
  // OIDC Core 6.2: Also support HTTPS request_uri (Request Object by Reference)
  if (request_uri) {
    // Check if this is a PAR request_uri (URN) or HTTPS request_uri
    const isPAR = request_uri.startsWith('urn:ietf:params:oauth:request_uri:');
    const isHTTPS = request_uri.startsWith('https://');

    if (!isPAR && !isHTTPS) {
      return sendRequestUriError(
        'invalid_request',
        'request_uri must be either urn:ietf:params:oauth:request_uri: or https://'
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

      // A saved value wins over env, including an explicit false; env applies only when
      // nothing is saved.
      let saved: NonNullable<OIDCProtocolSettings['httpsRequestUri']> = {};
      try {
        // Values set for a client apply only to a registered client: an unknown client_id must
        // not cost settings reads (the request is rejected once the client is checked).
        const requestClient =
          typeof client_id === 'string' && client_id
            ? await getClientCached(c, c.env, client_id)
            : null;
        const requestTenantId = getTenantIdFromContext(c);
        const clientInTenant =
          requestClient &&
          (typeof requestClient.tenant_id !== 'string' ||
            requestClient.tenant_id.length === 0 ||
            requestClient.tenant_id === requestTenantId);
        // An unknown client, or one of another tenant, gets no external fetch and costs no
        // settings reads: the request would be rejected once the client is checked anyway.
        if (!clientInTenant) {
          return sendRequestUriError(
            'request_uri_not_supported',
            'HTTPS request_uri is not available for this client'
          );
        }
        // Settings that cannot be read must not let env allow the fetch.
        const settings = await resolveProtocolSettings(c.env, requestTenantId, {
          clientId: client_id,
          keys: [
            'oauth.https_request_uri_enabled',
            'oauth.https_request_uri_allowed_domains',
            'oauth.https_request_uri_timeout_ms',
            'oauth.https_request_uri_max_size',
          ],
        });
        saved = settings.oidc.httpsRequestUri ?? {};
      } catch (error) {
        log.error(
          'Failed to load HTTPS request_uri settings from KV',
          { action: 'settings_load' },
          error as Error
        );
        // Fail closed: without the saved settings, an external fetch could be allowed that the
        // tenant or client has turned off or restricted.
        return sendRequestUriError(
          'temporarily_unavailable',
          'HTTPS request_uri settings are unavailable; use PAR or try again later'
        );
      }

      // Environment variables apply where nothing is saved.
      if (typeof saved.enabled === 'boolean') {
        httpsRequestUriConfig.enabled = saved.enabled;
      } else {
        httpsRequestUriConfig.enabled = c.env.ENABLE_HTTPS_REQUEST_URI === 'true';
      }
      if (Array.isArray(saved.allowedDomains)) {
        httpsRequestUriConfig.allowedDomains = saved.allowedDomains as string[];
      } else {
        const allowedDomainsStr = c.env.HTTPS_REQUEST_URI_ALLOWED_DOMAINS || '';
        httpsRequestUriConfig.allowedDomains = allowedDomainsStr
          ? allowedDomainsStr.split(',').map((d) => d.trim().toLowerCase())
          : [];
      }
      if (saved.timeoutMs !== undefined) {
        httpsRequestUriConfig.timeoutMs = saved.timeoutMs;
      } else if (c.env.HTTPS_REQUEST_URI_TIMEOUT_MS) {
        httpsRequestUriConfig.timeoutMs = parseInt(c.env.HTTPS_REQUEST_URI_TIMEOUT_MS, 10);
      }
      if (saved.maxSizeBytes !== undefined) {
        httpsRequestUriConfig.maxSizeBytes = saved.maxSizeBytes;
      } else if (c.env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES) {
        httpsRequestUriConfig.maxSizeBytes = parseInt(c.env.HTTPS_REQUEST_URI_MAX_SIZE_BYTES, 10);
      }

      if (!httpsRequestUriConfig.enabled) {
        return sendRequestUriError(
          'request_uri_not_supported',
          'HTTPS request_uri is disabled. Use PAR (RFC 9126) with urn:ietf:params:oauth:request_uri: format instead.'
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
        return sendRequestUriError('invalid_request_uri', 'Invalid URL format for request_uri');
      }

      // Validate domain against allowlist (if configured)
      if (allowedDomains.length > 0) {
        const requestDomain = requestUrl.hostname.toLowerCase();
        const isDomainAllowed = allowedDomains.some((allowed) =>
          domainMatches(requestDomain, allowed)
        );

        if (!isDomainAllowed) {
          log.warn('SSRF prevention: Rejected request_uri domain', {
            action: 'ssrf_block',
            domain: requestDomain,
            allowedDomains: allowedDomains.join(', '),
          });
          return sendRequestUriError(
            'invalid_request_uri',
            'request_uri domain is not in the allowed list'
          );
        }
      }

      // Prevent SSRF to localhost/internal IPs
      if (isInternalUrl(requestUrl)) {
        log.warn('SSRF prevention: Blocked request_uri to internal address', {
          action: 'ssrf_block',
          hostname: requestUrl.hostname,
        });
        return sendRequestUriError(
          'invalid_request_uri',
          'request_uri cannot point to internal addresses'
        );
      }

      try {
        let fetchUrl = request_uri;
        let requestObjectResponse: Response | null = null;

        for (
          let redirectCount = 0;
          redirectCount <= HTTPS_REQUEST_URI_MAX_REDIRECTS;
          redirectCount++
        ) {
          requestObjectResponse = await safeFetch(fetchUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/oauth-authz-req+jwt, application/jwt',
            },
            timeoutMs,
            maxResponseSize: maxSizeBytes,
            redirect: 'manual',
          });

          if (!isRedirectStatus(requestObjectResponse.status)) {
            break;
          }

          if (redirectCount === HTTPS_REQUEST_URI_MAX_REDIRECTS) {
            return sendRequestUriError(
              'invalid_request_uri',
              'request_uri exceeded maximum redirect depth'
            );
          }

          const location = requestObjectResponse.headers.get('location');
          if (!location) {
            return sendRequestUriError(
              'invalid_request_uri',
              'request_uri redirect response is missing Location header'
            );
          }

          try {
            const finalUrl = new URL(location, fetchUrl);
            const finalDomain = finalUrl.hostname.toLowerCase();
            if (finalUrl.protocol !== 'https:') {
              return sendRequestUriError(
                'invalid_request_uri',
                'request_uri redirect target must use HTTPS'
              );
            }

            const isFinalDomainAllowed =
              allowedDomains.length === 0 ||
              allowedDomains.some((allowed) => domainMatches(finalDomain, allowed));
            if (!isFinalDomainAllowed) {
              log.warn('SSRF prevention: Rejected redirect to disallowed domain', {
                action: 'ssrf_block',
                domain: finalDomain,
                allowedDomains: allowedDomains.join(', '),
              });
              return sendRequestUriError(
                'invalid_request_uri',
                'Redirected request_uri domain is not in the allowed list'
              );
            }

            // Validate before issuing the next request, not after following it.
            if (isInternalUrl(finalUrl)) {
              log.warn('SSRF prevention: Blocked redirect to internal address', {
                action: 'ssrf_block',
                hostname: finalUrl.hostname,
              });
              return sendRequestUriError(
                'invalid_request_uri',
                'request_uri cannot redirect to internal addresses'
              );
            }

            fetchUrl = finalUrl.toString();
          } catch {
            return sendRequestUriError(
              'invalid_request_uri',
              'request_uri redirect target is invalid'
            );
          }
        }

        if (!requestObjectResponse) {
          return sendRequestUriError(
            'invalid_request_uri',
            'Failed to fetch request object from request_uri'
          );
        }

        if (!requestObjectResponse.ok) {
          log.error('Failed to fetch request_uri', {
            action: 'request_uri_fetch',
            httpStatus: requestObjectResponse.status,
            statusText: requestObjectResponse.statusText,
          });
          return sendRequestUriError(
            'invalid_request_uri',
            'Failed to fetch request object from request_uri'
          );
        }

        // Check Content-Length header first
        const contentLength = requestObjectResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
          return sendRequestUriError(
            'invalid_request_uri',
            `Response too large: ${contentLength} bytes exceeds limit of ${maxSizeBytes} bytes`
          );
        }

        // Read response with size limit
        const reader = requestObjectResponse.body?.getReader();
        if (!reader) {
          return sendRequestUriError('invalid_request_uri', 'Failed to read response body');
        }

        const chunks: Uint8Array[] = [];
        let totalSize = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalSize += value.length;
          if (totalSize > maxSizeBytes) {
            reader.cancel();
            return sendRequestUriError(
              'invalid_request_uri',
              `Response too large: exceeds limit of ${maxSizeBytes} bytes`
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
        const isTooLarge = errorMessage.includes('Response size exceeds limit');
        log.error(
          'Failed to fetch request_uri',
          { action: 'request_uri_fetch', isTimeout, isTooLarge },
          error as Error
        );
        return sendRequestUriError(
          'invalid_request_uri',
          isTimeout
            ? `Request timed out after ${timeoutMs}ms`
            : isTooLarge
              ? `Response too large: exceeds limit of ${maxSizeBytes} bytes`
              : 'Failed to fetch request object from request_uri'
        );
      }
    }

    // Handle PAR request_uri (URN format)
    if (isPAR) {
      // Read the PAR request without consuming it. RFC 9126 Section 7.3 recommends that
      // one-time-use enforcement happen when the user authorizes the request, not merely when
      // the authorization endpoint is visited. This lets a login page be revisited safely while
      // preserving an atomic consume operation after authentication.
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
        dpop_jkt?: string;
        response_mode?: string;
        prompt?: string;
        display?: string;
        max_age?: number;
        ui_locales?: string;
        id_token_hint?: string;
        login_hint?: string;
        acr_values?: string;
        authorization_details?: string;
        error_uri?: string;
        cancel_uri?: string;
        request_object_signed?: boolean;
        request_object_encrypted?: boolean;
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
        let stored: PARRequestData | null;

        if (parsedPar) {
          // New region-sharded format: route via embedded shard info
          const tenantId = getTenantIdFromContext(c);
          const { stub } = getPARRequestStoreByUri(c.env, request_uri!, tenantId);
          stored = (await stub.getRequestRpc(request_uri!)) as PARRequestData | null;
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
          stored = (await stub.getRequestRpc(request_uri!)) as PARRequestData | null;
        }

        const requestTenantId = getTenantIdFromContext(c);
        if (
          !stored ||
          stored.consumed ||
          stored.tenant_id !== requestTenantId ||
          (client_id && stored.client_id !== client_id) ||
          (stored.authorization_server ?? 'default') !== 'default'
        ) {
          throw new Error('Invalid or expired request_uri');
        }

        // Map PARRequestData to the expected format
        parsedData = {
          client_id: stored.client_id,
          response_type: stored.response_type || 'code',
          redirect_uri: stored.redirect_uri,
          scope: stored.scope,
          state: stored.state,
          nonce: stored.nonce,
          code_challenge: stored.code_challenge,
          code_challenge_method: stored.code_challenge_method,
          claims: stored.claims,
          dpop_jkt: stored.dpop_jkt,
          authorization_details: stored.authorization_details,
          response_mode: stored.response_mode,
          prompt: stored.prompt,
          display: stored.display,
          max_age: stored.max_age,
          ui_locales: stored.ui_locales,
          id_token_hint: stored.id_token_hint,
          login_hint: stored.login_hint,
          acr_values: stored.acr_values,
          error_uri: stored.error_uri,
          cancel_uri: stored.cancel_uri,
          request_object_signed: stored.request_object_signed === true,
          request_object_encrypted: stored.request_object_encrypted === true,
        };
      } catch {
        // RPC error (invalid/expired request_uri)
        parsedData = null;
      }

      if (!parsedData) {
        // RFC 9126 errors may be returned through the browser only after independently
        // re-validating the outer client and redirect URI. Never trust a redirect URI recovered
        // from an invalid/expired request_uri, and never redirect to an unregistered URI.
        if (client_id && redirect_uri) {
          try {
            const errorClient = await getClientCached(c, c.env, client_id);
            const requestTenantId = getTenantIdFromContext(c);
            const errorClientTenantId =
              typeof errorClient?.tenant_id === 'string' && errorClient.tenant_id.length > 0
                ? errorClient.tenant_id
                : requestTenantId;
            const registeredRedirectUris = errorClient?.redirect_uris;
            // As the main path decides; a policy that cannot be read allows a native app's only.
            const errorPolicy = errorClient
              ? await resolveAppSecurityRequirements(c.env, requestTenantId, client_id).catch(
                  () => null
                )
              : null;
            if (
              errorClient &&
              errorClientTenantId === requestTenantId &&
              Array.isArray(registeredRedirectUris) &&
              validateRedirectUri(
                redirect_uri,
                errorClient.application_type === 'native' ||
                  (errorPolicy !== null && !errorPolicy.httpsRedirectOnly)
              ).valid &&
              isRedirectUriRegistered(
                redirect_uri,
                registeredRedirectUris,
                redirectUriMatchOptionsFor(errorClient)
              )
            ) {
              return redirectWithError(
                c,
                redirect_uri,
                'invalid_request_uri',
                'Invalid or expired request_uri',
                state,
                { responseType: 'code', clientId: client_id }
              );
            }
          } catch (error) {
            log.warn('Failed to validate redirect for invalid request_uri', {
              action: 'invalid_request_uri_redirect_validation',
              error: error instanceof Error ? error.message : 'unknown',
            });
          }
        }
        return c.json(
          {
            error: 'invalid_request_uri',
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
        dpop_jkt?: string;
        response_mode?: string;
        prompt?: string;
        display?: string;
        max_age?: number;
        ui_locales?: string;
        id_token_hint?: string;
        login_hint?: string;
        acr_values?: string;
        authorization_details?: string; // RFC 9396: Rich Authorization Requests
        error_uri?: string;
        cancel_uri?: string;
        request_object_signed?: boolean;
        request_object_encrypted?: boolean;
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
        dpop_jkt = parData.dpop_jkt;
        claimsRequestIntegrityProtected = true;
        requestObjectSigned = parData.request_object_signed === true;
        requestObjectEncrypted = parData.request_object_encrypted === true;
        authorization_details = parData.authorization_details; // RFC 9396 RAR
        response_mode = parData.response_mode;
        prompt = parData.prompt;
        display = parData.display;
        max_age = parData.max_age === undefined ? undefined : String(parData.max_age);
        ui_locales = parData.ui_locales;
        id_token_hint = parData.id_token_hint;
        login_hint = parData.login_hint;
        acr_values = parData.acr_values;
        error_uri = parData.error_uri;
        cancel_uri = parData.cancel_uri;
        authorizationRequestSource = 'par';
        par_request_uri = request_uri;
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

  // Preserve the front-channel client identity. A Request Object may protect
  // parameters for that client, but it must not switch the authorization
  // transaction to another registered client after signature verification.
  const outerRequestClientId = client_id;

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

      // An unsigned request object (alg=none, or an encrypted bare JSON object: anyone can encrypt
      // to the tenant's public key) is refused in production, and elsewhere unless the tenant
      // allows it (security.allow_unsigned_request_object).
      const refuseUnsignedRequestObject = async (): Promise<Response | null> => {
        // SECURITY: Block alg=none in production environment regardless of settings
        // This is a critical security measure to prevent unsigned JWT attacks
        const isProduction = c.env.ENVIRONMENT === 'production' || c.env.NODE_ENV === 'production';

        if (isProduction) {
          log.error('SECURITY CRITICAL: Blocked unsigned request object (alg=none) in production', {
            action: 'security_block',
            algorithm: 'none',
          });
          return c.json(
            {
              error: 'invalid_request_object',
              error_description:
                'Unsigned request objects (alg=none) are not permitted in production',
            },
            400
          );
        }

        // Check if 'none' algorithm is allowed (security.allow_unsigned_request_object).
        // Only applies to non-production environments; settings that cannot be read do not
        // allow it.
        let allowNoneAlgorithm = false;
        try {
          const settings = await resolveProtocolSettings(c.env, getTenantIdFromContext(c), {
            clientId: client_id,
            keys: ['security.allow_unsigned_request_object'],
          });
          allowNoneAlgorithm = settings.oidc.allowNoneAlgorithm ?? false;
        } catch (error) {
          log.error(
            'Unsigned request object settings could not be read',
            { action: 'settings_load' },
            error as Error
          );
        }

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
        return null;
      };

      // Step 1: Decrypt JWE if needed (RFC 9101 Section 6.1)
      let jwtRequest = request;
      if (tokenFormat === 'jwe') {
        try {
          // Encrypted to this tenant's request object encryption key (use enc in its JWKS).
          const decrypted = await decryptRequestObject(c.env, getTenantIdFromContext(c), request);
          requestObjectEncrypted = true;

          // Check if decrypted content is a JWT (needs verification) or direct JSON payload
          if (decrypted.trimStart().startsWith('{')) {
            // Direct JSON payload: encrypted, but not signed by the client.
            const unsignedRefusal = await refuseUnsignedRequestObject();
            if (unsignedRefusal) return unsignedRefusal;
            requestObjectClaims = JSON.parse(decrypted) as Record<string, unknown>;
            claimsRequestIntegrityProtected = false;
            requestObjectSigned = false;
          } else {
            // Nested JWT - need to verify signature
            jwtRequest = decrypted;
            tokenFormat = getTokenFormat(jwtRequest);
            // Anything else is not a request object: encrypting it must not stand in for one.
            if (tokenFormat !== 'jwt') {
              return c.json(
                {
                  error: 'invalid_request_object',
                  error_description: 'Decrypted request object must be a JWT or JSON object',
                },
                400
              );
            }
          }
        } catch (decryptError) {
          log.error(
            'Failed to decrypt JWE request object',
            { action: 'jwe_decrypt' },
            decryptError as Error
          );
          if (
            decryptError instanceof RequestObjectDecryptionError &&
            decryptError.reason === 'unavailable'
          ) {
            return c.json(
              {
                error: 'temporarily_unavailable',
                error_description: 'Request object decryption is temporarily unavailable',
              },
              503
            );
          }
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
          const unsignedRefusal = await refuseUnsignedRequestObject();
          if (unsignedRefusal) return unsignedRefusal;

          // Unsigned request object - just parse without verification
          // Note: This is ONLY allowed in development/testing environments
          log.warn('Using unsigned request object (alg=none) - development/testing only', {
            action: 'security_warning',
            algorithm: 'none',
          });
          requestObjectClaims = parseToken(jwtRequest) as Record<string, unknown>;
          claimsRequestIntegrityProtected = false;
          requestObjectSigned = false;
        } else {
          if (alg !== 'RS256') {
            return c.json(
              {
                error: 'invalid_request_object',
                error_description: 'Unsupported request object signing algorithm',
              },
              400
            );
          }

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
              const jwks = await safeFetchJson<JWKS>(clientResult.jwks_uri, {
                timeoutMs: 5000,
                maxResponseSize: 256 * 1024,
              });
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
            return c.json(
              {
                error: 'invalid_request_object',
                error_description: 'No client public key available for verification',
              },
              400
            );
          }

          // Verify the signature
          // OIDC Core 6.1: For client-signed request objects:
          // - iss = client_id (the client is the issuer)
          // - aud = OP's issuer URL (the OP is the audience)
          const verified = await verifyToken(jwtRequest, publicKey, client_id, {
            audience: getRequestIssuer(c),
          });
          requestObjectClaims = verified as Record<string, unknown>;
          claimsRequestIntegrityProtected = true;
          requestObjectSigned = true;
        }
      }

      // Override parameters with those from request object
      // Per OIDC Core 6.1: request object parameters take precedence
      if (requestObjectClaims) {
        if (
          typeof requestObjectClaims.client_id !== 'string' ||
          !outerRequestClientId ||
          requestObjectClaims.client_id !== outerRequestClientId
        ) {
          return c.json(
            {
              error: 'invalid_request_object',
              error_description:
                'client_id in the request object must match the authorization request',
            },
            400
          );
        }

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
        client_id = requestObjectClaims.client_id;
        redirect_uri = requestObjectRedirectUri;
        if (requestObjectClaims.scope) scope = requestObjectClaims.scope as string;
        if (requestObjectClaims.state) state = requestObjectClaims.state as string;
        if (requestObjectClaims.nonce) nonce = requestObjectClaims.nonce as string;
        if (requestObjectClaims.code_challenge)
          code_challenge = requestObjectClaims.code_challenge as string;
        if (requestObjectClaims.code_challenge_method)
          code_challenge_method = requestObjectClaims.code_challenge_method as string;
        if (requestObjectClaims.claims)
          claims =
            typeof requestObjectClaims.claims === 'string'
              ? requestObjectClaims.claims
              : JSON.stringify(requestObjectClaims.claims);
        if (requestObjectClaims.response_mode)
          response_mode = requestObjectClaims.response_mode as string;
        if (requestObjectClaims.prompt) prompt = requestObjectClaims.prompt as string;
        if (requestObjectClaims.max_age !== undefined) {
          max_age = String(requestObjectClaims.max_age);
        }
        // Present means given, whatever its value: a non-string is refused below.
        if (requestObjectClaims.id_token_hint !== undefined)
          id_token_hint = requestObjectClaims.id_token_hint as string;
        if (requestObjectClaims.acr_values) acr_values = requestObjectClaims.acr_values as string;
        if (requestObjectClaims.display) display = requestObjectClaims.display as string;
        if (requestObjectClaims.ui_locales) ui_locales = requestObjectClaims.ui_locales as string;
        if (requestObjectClaims.login_hint) login_hint = requestObjectClaims.login_hint as string;
        if (requestObjectClaims.authorization_details) {
          authorization_details =
            typeof requestObjectClaims.authorization_details === 'string'
              ? requestObjectClaims.authorization_details
              : JSON.stringify(requestObjectClaims.authorization_details);
        }
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
    // This is a pre-redirect validation error, so respond from the AS directly.
    return createLocalAuthorizationErrorResponse(c, 'invalid_request', 'response_type is required');
  }

  const responseTypeValidation = validateResponseType(response_type);
  if (!responseTypeValidation.valid) {
    // response_type is present but unsupported - use unsupported_response_type
    // This is a pre-redirect validation error, so respond from the AS directly.
    return createLocalAuthorizationErrorResponse(
      c,
      'unsupported_response_type',
      responseTypeValidation.error || 'Unsupported response_type'
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
  const clientMetadata = await timeAuthRequestDiagnosticOperation(c, 'auth_authorize_client', () =>
    getClientCached(c, c.env, validClientId)
  );
  if (!clientMetadata) {
    return createLocalAuthorizationErrorResponse(
      c,
      'invalid_request',
      'client_id is invalid',
      'Invalid Client'
    );
  }
  // Profile-based response_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // AI Ephemeral profile restricts implicit/hybrid flows to 'code' only for MCP User Delegation
  const requestTenantId = getTenantIdFromContext(c);
  const clientTenantId =
    typeof clientMetadata.tenant_id === 'string' && clientMetadata.tenant_id.length > 0
      ? clientMetadata.tenant_id
      : null;
  if (
    clientTenantId &&
    requestTenantId !== getDefaultTenantId(c.env) &&
    clientTenantId !== requestTenantId
  ) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'client_id is invalid for this tenant',
      },
      400
    );
  }

  const tenantId = clientTenantId || requestTenantId;
  const tenantProfilePromise = timeAuthRequestDiagnosticOperation(
    c,
    'auth_authorize_tenant_profile',
    () => loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId)
  );
  const securitySettingsPromise = timeAuthRequestDiagnosticOperation(
    c,
    'auth_authorize_security_settings',
    () =>
      resolveProtocolSettings(c.env, tenantId, {
        clientId: validClientId,
        sections: ['fapi'],
        keys: ['security.par_required', 'oauth.response_types_supported', 'feature.enable_rar'],
      })
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const tenantProfile = await tenantProfilePromise;
  const profileAllowedResponseTypes = filterResponseTypesByProfile(
    ['code', 'id_token', 'id_token token', 'code id_token', 'code token', 'code id_token token'],
    tenantProfile
  );

  // VG-006: Validate response_type against client's allowed response_types
  // RFC 7591 Section 2: response_types defaults to ["code"] if not specified
  const clientResponseTypes = (clientMetadata.response_types as string[] | undefined) || ['code'];

  // FAPI 2.0 and OIDC settings saved for the tenant or client (see resolveProtocolSettings).
  let fapiConfig: FAPIProtocolSettings = {};
  let oidcConfig: OIDCProtocolSettings = {};
  const securitySettings = await securitySettingsPromise;
  if (!securitySettings.ok) {
    log.error(
      'Failed to load FAPI settings from KV',
      { action: 'fapi_settings_load' },
      securitySettings.error as Error
    );
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Security profile settings are temporarily unavailable',
      },
      503
    );
  }
  fapiConfig = securitySettings.value.fapi;
  oidcConfig = securitySettings.value.oidc;

  let configuredResponseTypes: string[] | undefined;
  if (oidcConfig.responseTypesSupported !== undefined) {
    if (
      !Array.isArray(oidcConfig.responseTypesSupported) ||
      oidcConfig.responseTypesSupported.length === 0 ||
      oidcConfig.responseTypesSupported.some(
        (value) => typeof value !== 'string' || !validateResponseType(value).valid
      )
    ) {
      log.error('Invalid tenant response type policy', {
        action: 'oidc_response_type_policy',
      });
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'OIDC response type policy is unavailable',
        },
        503
      );
    }
    configuredResponseTypes = oidcConfig.responseTypesSupported as string[];
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

  // The tenant's security floor for its apps (PKCE, http loopback, encrypted request objects).
  // Read strictly: requirements that cannot be read refuse the request rather than lapse.
  let securityPolicy: AppSecurityRequirements;
  try {
    securityPolicy = await resolveAppSecurityRequirements(c.env, requestTenantId, validClientId);
  } catch (error) {
    log.error('Security policy settings could not be read', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to process authorization request' },
      500
    );
  }

  // Validate redirect_uri format: http only on a loopback host, for a native app (RFC 8252) or
  // when the tenant allows it for web apps (security.https_redirect_only off).
  const allowHttp =
    clientMetadata.application_type === 'native' || !securityPolicy.httpsRedirectOnly;
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
    registeredRedirectUris,
    redirectUriMatchOptionsFor(clientMetadata)
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
      <strong>Provided URI:</strong> ${escapeHtml(redirect_uri || '(none)')}
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
      <strong>Description:</strong> ${escapeHtml(errorMessages)}
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
      messageSigning: fapiConfig.messageSigning,
      errorUri: validatedErrorUri,
    });

  if (configuredResponseTypes && !configuredResponseTypes.includes(response_type!)) {
    return sendError(
      'unsupported_response_type',
      `Response type '${response_type}' is not enabled for this tenant`
    );
  }

  if (!profileAllowedResponseTypes.includes(response_type!)) {
    return sendError(
      'unsupported_response_type',
      `Response type '${response_type}' is not allowed for this tenant profile. Allowed: ${profileAllowedResponseTypes.join(', ')}`
    );
  }

  if (!clientResponseTypes.includes(response_type!)) {
    return sendError(
      'unsupported_response_type',
      `Response type '${response_type}' is not allowed for this client. Allowed: ${clientResponseTypes.join(', ')}`
    );
  }

  // FAPI errors are safe to redirect only after client_id and redirect_uri have been
  // validated. This also lets a relying party (including the OIDF suite) observe a
  // standards-compliant authorization error instead of leaving the browser at the AS.
  // PAR is required in FAPI 2.0 mode, and wherever the tenant (or client) requires it: what
  // discovery advertises as require_pushed_authorization_requests.
  if (authorizationRequestSource !== 'par') {
    if (fapiConfig.enabled) {
      return sendError(
        'invalid_request',
        'PAR is required in FAPI 2.0 mode. Use /par endpoint first.'
      );
    }
    if (oidcConfig.requirePar) {
      return sendError('invalid_request', 'PAR is required. Use /par endpoint first.');
    }
  }

  if (fapiConfig.enabled) {
    // The saved value, else FAPI_ALLOW_PUBLIC_CLIENTS
    // (anything but 'false' / '0' allows), else allowed.
    const envAllowsPublicClients = c.env.FAPI_ALLOW_PUBLIC_CLIENTS;
    const allowPublicClients =
      typeof fapiConfig.allowPublicClients === 'boolean'
        ? fapiConfig.allowPublicClients
        : envAllowsPublicClients === undefined ||
          (envAllowsPublicClients.toLowerCase() !== 'false' && envAllowsPublicClients !== '0');
    const isPublicClient = !clientMetadata.client_secret_hash;
    if (!allowPublicClients && isPublicClient) {
      return sendError('invalid_client', 'Public clients are not allowed in FAPI 2.0 mode');
    }

    // response_type=none does not issue an authorization code, so PKCE is not required.
    if (response_type !== 'none' && (!code_challenge || code_challenge_method !== 'S256')) {
      return sendError('invalid_request', 'PKCE with S256 is required in FAPI 2.0 mode');
    }
  }

  // A signed request object may be required (FAPI message signing, or the Settings API's
  // security.require_signed_request_object for the tenant or client). PAR enforces it when the
  // request is pushed; a request sent here directly must carry a request object whose signature
  // was verified (or come from PAR, which is integrity protected).
  const messageSigning = fapiConfig.messageSigning;
  if (messageSigning?.requireSignedRequestObject === true && !claimsRequestIntegrityProtected) {
    return sendError('invalid_request', 'A signed request object is required for this client');
  }

  // security.require_encrypted_request_object (the tenant's or the app's): the request came in a
  // request object encrypted to this tenant, sent here directly, by reference, or pushed (PAR).
  if (securityPolicy.requireEncryptedRequestObject && !requestObjectEncrypted) {
    return sendError(
      'invalid_request_object',
      'An encrypted request object is required for this client'
    );
  }

  // Validate scope
  const scopeValidation = validateScope(scope);
  if (!scopeValidation.valid) {
    return sendError('invalid_scope', scopeValidation.error);
  }

  // OIDC Core 11: offline_access is ignored unless the response returns an authorization code
  // (only a code can be exchanged for a refresh token).
  if (scope && !(response_type ?? '').split(' ').includes('code')) {
    scope = splitScopes(scope)
      .filter((value) => value !== 'offline_access')
      .join(' ');
  }

  const requestedScopes = splitScopes(scope);
  const clientAllowedScopes = getClientAllowedScopes(clientMetadata);
  if (requestedScopes.length > 0 && clientAllowedScopes.length > 0) {
    const clientAllowedScopeSet = new Set(clientAllowedScopes);
    const disallowedScopes = requestedScopes.filter((s) => !clientAllowedScopeSet.has(s));
    if (disallowedScopes.length > 0) {
      return sendError(
        'invalid_scope',
        `Client is not authorized to request scope(s): ${disallowedScopes.join(', ')}. ` +
          `Allowed scopes: ${clientAllowedScopes.join(', ')}`
      );
    }
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

  // Validate state (conditionally required based on configuration)
  // SECURITY: response_type=none ALWAYS requires state for CSRF protection
  // (used for session checks, state prevents cross-site request forgery)
  // Whether the configuration requires state is checked once the rest of the request is valid
  // (below), so invalid requests do not cost a settings read.
  const isNoneResponseTypeForState = response_type === 'none';
  const stateMissing = !state || state.trim().length === 0;
  if (isNoneResponseTypeForState && stateMissing) {
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

    // OAuth 2.0 Multiple Response Type Encoding Practices: credentials returned
    // directly from the authorization endpoint must not be placed in the query,
    // where they leak through browser history, server logs and Referer headers.
    const responseTypes = response_type!.split(/\s+/);
    if (
      baseMode === 'query' &&
      (responseTypes.includes('token') || responseTypes.includes('id_token'))
    ) {
      return sendError(
        'invalid_request',
        'response_mode=query is not compatible with token or id_token response types'
      );
    }
  }

  if (
    fapiConfig.messageSigning?.requireJarm &&
    (!response_mode || (!response_mode.includes('.jwt') && response_mode !== 'jwt'))
  ) {
    return sendError('invalid_request', 'A JARM response_mode is required for this FAPI profile');
  }

  // Validate claims parameter (optional, per OIDC Core 5.5)
  const parsedClaimsRequest = parseClaimsRequest(claims);
  if (!parsedClaimsRequest.ok) {
    return sendError(parsedClaimsRequest.error, parsedClaimsRequest.error_description);
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

  const requiresPkce =
    responseTypeIssuesAuthorizationCode(response_type) &&
    (clientMetadata.require_pkce === true ||
      isClientPublic(clientMetadata) ||
      securityPolicy.pkceRequired);
  if (requiresPkce && (!code_challenge || code_challenge_method !== 'S256')) {
    return sendError('invalid_request', 'PKCE with S256 is required for this client');
  }

  // State required by configuration: the Settings API value for the client or tenant, else the
  // older oauth-config value, else env, else the default. Only read when state is missing; a
  // setting that cannot be read refuses the request rather than assuming state is optional.
  if (stateMissing) {
    let stateRequired: unknown;
    try {
      stateRequired = (
        await resolveEffectiveSettings(c.env, 'oauth', {
          tenantId: getTenantIdFromContext(c),
          clientId: validClientId,
        })
      )['oauth.state_required'];
    } catch (error) {
      log.error('State requirement settings could not be read', {}, error as Error);
      return sendError('server_error', 'Failed to process authorization request');
    }
    if (stateRequired === true) {
      return sendError('invalid_request', 'state parameter is required (CSRF protection)');
    }
  }

  // Start optional SSO settings only after request validation, while still overlapping session I/O.
  // Invalid authorization requests must not amplify Settings KV reads.
  const settingsManager = getSettingsManager(c.env);
  const ssoSettingsPromise = timeAuthRequestDiagnosticOperation(
    c,
    'auth_authorize_sso_settings',
    () =>
      Promise.all([
        settingsManager
          .getAll('client', {
            type: 'client',
            id: validClientId,
            tenantId,
          })
          .catch(() => null),
        settingsManager
          .getAll('oauth', {
            type: 'tenant',
            id: tenantId,
          })
          .catch(() => null),
      ])
  );

  // Process authentication-related parameters (OIDC Core 3.1.2.1)
  let sessionUserId: string | undefined;
  let authTime: number | undefined;
  // What a consent challenge carries back about a re-authentication completed in this request.
  const describeConfirmedReauthentication = (): Record<string, unknown> | undefined =>
    _confirmed === 'true' && authTime !== undefined
      ? {
          auth_time: authTime,
          ...(confirmedReauthIssuedAt !== undefined
            ? { reauth_issued_at: confirmedReauthIssuedAt }
            : {}),
          ...(confirmedAssuranceStepUp
            ? {
                assurance_step_up: {
                  prior_session_id: confirmedAssuranceStepUp.priorSessionId,
                  issued_at: confirmedAssuranceStepUp.issuedAt,
                },
              }
            : {}),
        }
      : undefined;
  let sessionAcr: string | undefined;
  let sessionAmr: string[] | undefined;
  // The session's own data (assurance evidence included), and whose session it is.
  let sessionData: Record<string, unknown> | undefined;
  let sessionDataUserId: string | undefined;
  let isAnonymousSession: boolean = false;

  // Check for existing session (cookie)
  // This is required for prompt=none to work correctly
  const cookieHeader = c.req.header('Cookie');
  const rawSessionId = cookieHeader?.match(/authrim_session=([^;]+)/)?.[1];
  // URL decode the session ID - browsers may encode special characters like colons
  const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : undefined;

  // Debug logging for SSO troubleshooting
  log.info('Session detection', {
    action: 'session_detect',
    hasCookieHeader: !!cookieHeader,
    hasSessionId: !!sessionId,
    isShardedFormat: sessionId ? isShardedSessionId(sessionId) : false,
    clientId: validClientId,
  });

  // Only process sharded session IDs (new format: {shardIndex}_session_{uuid})
  // Legacy sessions without shard prefix are treated as invalid (user must re-login)
  if (sessionId && c.env.SESSION_STORE && isShardedSessionId(sessionId)) {
    try {
      const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);

      const session = (await timeAuthRequestDiagnosticOperation(
        c,
        'auth_authorize_session_read',
        () => sessionStore.getSessionRpc(sessionId)
      )) as Session | null;

      // Debug: Log session retrieval result
      log.info('Session retrieved', {
        action: 'session_retrieved',
        hasSession: !!session,
        sessionExpired: session ? session.expiresAt <= Date.now() : null,
        hasSessionUserId: typeof session?.userId === 'string' && session.userId.length > 0,
        clientId: validClientId,
      });

      if (session) {
        // Check if session is not expired
        if (session.expiresAt > Date.now()) {
          sessionUserId = session.userId;
          sessionData = session.data as Record<string, unknown> | undefined;
          sessionDataUserId = session.userId;
          // Check if this is an anonymous session (architecture-decisions.md §17)
          isAnonymousSession = session.data?.is_guest_session === true;
          if (typeof session.data?.acr === 'string' && session.data.acr.length > 0) {
            sessionAcr = session.data.acr;
          }
          if (Array.isArray(session.data?.amr)) {
            const normalizedAmr = session.data.amr.filter(
              (method): method is string => typeof method === 'string' && method.length > 0
            );
            if (normalizedAmr.length > 0) {
              sessionAmr = normalizedAmr;
            }
          }
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
    if (prompt?.includes('login') || max_age !== undefined) {
      // The time of the authentication that answered the challenge, as the confirmation carries it
      // (the sign-in just made, or the session's own time when a session answered). "Now" would
      // date an authentication that did not happen.
      const confirmedAuthTime = _auth_time ? parseInt(_auth_time, 10) : NaN;
      authTime =
        confirmedReauthAuthTime ??
        (Number.isSafeInteger(confirmedAuthTime) && confirmedAuthTime > 0
          ? confirmedAuthTime
          : Math.floor(Date.now() / 1000));
      log.debug('Re-authentication confirmed, setting new authTime', {
        action: 'reauth',
        authTime,
      });
    } else if (confirmedReauthAuthTime !== undefined) {
      // Back from the consent screen: the authentication's time travelled with the consent.
      authTime = confirmedReauthAuthTime;
      log.debug('Restoring authTime carried through consent', {
        action: 'auth_time_restore',
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

  // ============================================================
  // SSO Configuration Retrieval and Application
  // ============================================================
  // Priority: Client KV > Tenant KV > Client ENV > Tenant ENV > Default (false)
  let ssoEnabled = false; // Default: disabled for security

  try {
    let clientSsoSetting: boolean | null = null;
    let tenantSsoSetting: boolean | null = null;

    // Fetch client and tenant settings in parallel for better performance
    // Priority: Client setting > Tenant setting > Default (false)
    try {
      const [clientSettings, tenantSettings] = await ssoSettingsPromise;

      // A category default is not an explicit client override. Treating the client default as
      // configured here prevents the tenant setting from ever being inherited by newly registered
      // clients (including DCR clients). Only KV/env values participate in the override chain.
      const clientSso = clientSettings?.values['client.sso_enabled'];
      if (
        clientSettings?.sources['client.sso_enabled'] !== 'default' &&
        typeof clientSso === 'boolean'
      ) {
        clientSsoSetting = clientSso;
      }

      const tenantSso = tenantSettings?.values['oauth.sso_enabled'];
      if (
        tenantSettings?.sources['oauth.sso_enabled'] !== 'default' &&
        typeof tenantSso === 'boolean'
      ) {
        tenantSsoSetting = tenantSso;
      }
    } catch (error) {
      // Both settings failed - use default
      log.debug('Failed to fetch SSO settings, using default', {
        clientId: validClientId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Priority: Client setting > Tenant setting > Default (false)
    ssoEnabled = clientSsoSetting ?? tenantSsoSetting ?? false;

    log.info('SSO configuration', {
      action: 'sso_config',
      clientId: validClientId,
      tenantSsoSetting,
      clientSsoSetting,
      ssoEnabled,
    });
  } catch (error) {
    log.error('Failed to get SSO settings, defaulting to disabled', {
      action: 'sso_config_error',
      error: error instanceof Error ? error.message : String(error),
    });
    ssoEnabled = false;
  }

  // id_token_hint (OIDC Core 3.1.2.1, 3.1.2.2): an ID token this server issued, naming the
  // End-User the client expects. It is never a sign-in: without a session it stands in for
  // nothing (an ID token reaches every app it was issued to, so any holder could replay it with
  // prompt=none). It must verify (signature and issuer; it may have expired), and the signed-in
  // End-User must be the one it names, else login_required (the request is not completed for
  // someone else, prompt=none or not). It is kept with the request, not shown to the login UI.
  if (id_token_hint !== undefined) {
    const hintToken: unknown = id_token_hint;
    if (typeof hintToken !== 'string') {
      return sendError('invalid_request', 'id_token_hint must be a string');
    }
    const hint = await validateIdTokenHint(
      hintToken,
      async () =>
        (await importIssuedTokenKey(await getIssuedIDTokenKeys(c.env, tenantId), hintToken)).key,
      getRequestIssuer(c),
      { allowExpired: true }
    );
    if (!hint.valid || !hint.userId) {
      return sendError('invalid_request', 'id_token_hint is not an ID token this server issued');
    }
    if (
      sessionUserId &&
      !(await idTokenHintNamesUser(
        c,
        tenantId,
        validClientId,
        clientMetadata,
        scope,
        hint.userId,
        sessionUserId
      ))
    ) {
      return sendError(
        'login_required',
        'The End-User identified by id_token_hint is not signed in'
      );
    }
  }

  // ============================================================
  // OIDC Compliance: Authentication State Evaluation Order
  // ============================================================
  // Evaluation order: prompt=login (highest priority) → max_age → SSO setting
  // This ensures OIDC specification compliance while enabling SSO control
  let forceReauthentication = false;

  // 1. prompt=login: Explicit re-authentication request (OIDC Core 3.1.2.1)
  //    → Always force re-authentication regardless of SSO setting
  if (prompt && prompt.includes('login') && _confirmed !== 'true') {
    log.info('prompt=login - forcing re-authentication', {
      action: 'prompt_login',
      clientId: validClientId,
    });
    // Preserve the authenticated subject long enough to create a reauth challenge. Clearing it
    // here routes through the ordinary login challenge, which may be auto-completed from the
    // existing browser session and violates prompt=login.
    forceReauthentication = sessionUserId !== undefined;
  }

  // 2. max_age: Authentication age constraint (OIDC Core 3.1.2.1)
  //    → Evaluated before SSO setting (specification requirement)
  //    → For prompt=none, separate check in prompt processing (Line 2143-2155) returns error
  //    → For other cases, clear session to trigger re-authentication
  else if (
    max_age !== undefined &&
    authTime !== undefined &&
    !prompt?.includes('none') &&
    _confirmed !== 'true'
  ) {
    const authAge = Math.floor(Date.now() / 1000) - authTime;
    const maxAgeSeconds = parseInt(max_age, 10);
    if (maxAgeSeconds === 0 || authAge > maxAgeSeconds) {
      log.info('max_age exceeded - re-authentication required', {
        action: 'max_age_exceeded',
        clientId: validClientId,
        authAge,
        maxAge: maxAgeSeconds,
      });
      forceReauthentication = sessionUserId !== undefined;
    }
  }

  // 3. SSO Setting: Session sharing control (Authrim-specific feature)
  //    → Applied after prompt=login and max_age
  if (
    !ssoEnabled &&
    sessionUserId &&
    !forceReauthentication &&
    _confirmed !== 'true' &&
    _consent_confirmed !== 'true'
  ) {
    // Log if id_token_hint was provided but ignored due to SSO disabled
    if (id_token_hint) {
      log.warn('SSO disabled - ignoring id_token_hint', {
        action: 'sso_disabled_id_token_hint',
        clientId: validClientId,
      });
    }

    log.info('SSO disabled - ignoring existing session', {
      action: 'sso_disabled',
      clientId: validClientId,
      ignoredSessionUserId: sessionUserId,
    });

    sessionUserId = undefined;
    authTime = undefined;
    isAnonymousSession = false;
  }

  if (sessionUserId && isAnonymousSession) {
    const guestClient = await loadClientContractCached(
      c,
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      validClientId
    );
    if (!areGuestScopesAllowed(guestClient?.guestAuth, scope ?? '')) {
      return sendError('invalid_scope', 'The client does not permit the requested guest scopes');
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

      // When SSO is disabled, prompt=none always returns login_required
      // because session sharing is not allowed (sessionUserId was cleared in OIDC compliance section)
      if (!ssoEnabled) {
        log.info('prompt=none rejected due to SSO disabled', {
          action: 'prompt_none_sso_disabled',
          clientId: validClientId,
        });
        return sendError(
          'login_required',
          'SSO is disabled for this client - prompt=none requires an active session but session sharing is not allowed'
        );
      }

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
        const allowPromptNone = clientContract?.guestAuth?.allowPromptNone ?? false;

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
      if (max_age !== undefined && authTime !== undefined) {
        const maxAgeSeconds = parseInt(max_age, 10);
        const currentTime = Math.floor(Date.now() / 1000);
        const timeSinceAuth = currentTime - authTime;

        if (maxAgeSeconds === 0 || timeSinceAuth > maxAgeSeconds) {
          return sendError(
            'login_required',
            'Re-authentication is required due to max_age constraint'
          );
        }
      }

      // Handoff token issuance is handled after consent checks below.
    }

    // Note: prompt=login is handled in the OIDC compliance section above
    // Note: prompt=consent and prompt=select_account are handled by consent UI
    // They don't affect the authorization endpoint logic directly
  }

  // Note: max_age parameter is handled in the OIDC compliance section above

  // ============================================================
  // Assurance (NIST SP 800-63-4): the AAL this authorization requires
  // ============================================================
  // Off (the default): nothing here changes the request. On: the session's AAL is computed from
  // what it proved, and a request needing more steps up once (re-authentication), fails with
  // login_required for prompt=none, or with unmet_authentication_requirements after the step-up.
  let assuranceSettings: Record<string, unknown>;
  try {
    assuranceSettings = await resolveEffectiveSettings(c.env, 'assurance', { tenantId });
  } catch (error) {
    log.error(
      'Failed to load assurance settings',
      { action: 'assurance_settings' },
      error as Error
    );
    return sendError('temporarily_unavailable', 'Assurance settings are temporarily unavailable');
  }
  const assuranceEnabled = assuranceSettings['assurance.enabled'] === true;
  // The FAL assurance enforces (enforcedFAL). FAL3: a pushed request with a signed request object.
  // FAL2 and above with DPoP: no token from the front channel, where none can be bound to a key
  // (the token endpoint requires the DPoP proof for the rest).
  if (
    falRequiresSignedPushedRequest(assuranceSettings) &&
    !(authorizationRequestSource === 'par' && requestObjectSigned)
  ) {
    return sendError(
      'invalid_request',
      'A pushed authorization request with a signed request object is required (FAL3)'
    );
  }
  if (falRequiresDpop(assuranceSettings) && (response_type ?? '').split(/\s+/).includes('token')) {
    return sendError(
      'unsupported_response_type',
      'An access token is not issued from the authorization endpoint (FAL2 requires DPoP)'
    );
  }
  // The step-up this request needs (a re-authentication challenge), when it needs one.
  let assuranceStepUp: { requiredAal: AssuranceLevel } | undefined;
  // The AAL the authentication reached, and the acr assurance chose (undefined: unchanged).
  let assuranceAal: AssuranceLevel | undefined;
  let assuranceAcr: string | null | undefined;
  // The acr of the AAL reached, for access tokens (include_in_access_token), whatever ID tokens get.
  let assuranceTokenAcr: string | undefined;
  // The methods the authentication proved (none merely registered), for access tokens.
  let assuranceTokenAmr: string[] | undefined;
  // A forced re-authentication (prompt=login, max_age) comes first; assurance applies to its result.
  if (assuranceEnabled && sessionUserId && !(forceReauthentication && _confirmed !== 'true')) {
    const upstreamAcrMappings = parseUpstreamAcrMappings(
      assuranceSettings['assurance.upstream_acr_mappings']
    );
    // Only the evidence of the session of the user being authorized counts (a confirmation names the
    // user; the cookie may carry someone else's session).
    const ownSession = sessionDataUserId === sessionUserId;
    const provenAt = typeof sessionData?.proven_at === 'number' ? sessionData.proven_at : undefined;
    // After a re-authentication, only a session proven after it was asked for is its result: an
    // older session of the user (switched in by cookie) counts for nothing. An external IdP login
    // records no proof time (its IdP's times are in that IdP's clock), so it never counts here.
    const reauthResult =
      confirmedReauthIssuedAt === undefined ||
      (provenAt !== undefined && provenAt >= confirmedReauthIssuedAt);
    const evidenceSession = ownSession && reauthResult;
    let evidence = sessionAssuranceEvidence(
      evidenceSession ? sessionData : undefined,
      upstreamAcrMappings
    );
    if (!evidenceSession) {
      // What that session proved is not this authentication's: the code reports none of it.
      sessionAmr = undefined;
      sessionAcr = undefined;
    }
    // A completed step-up: the factors the earlier session had proven, with the one just completed,
    // provided the earlier session is still that user's live session and the current one records
    // that its authentication was proven after the step-up began (proven_at, milliseconds; a
    // session without it is never combined).
    if (
      _confirmed === 'true' &&
      confirmedAssuranceStepUp &&
      sessionId &&
      ownSession &&
      provenAt !== undefined &&
      provenAt >= confirmedAssuranceStepUp.issuedAt
    ) {
      const priorSessionId = confirmedAssuranceStepUp.priorSessionId;
      if (priorSessionId && priorSessionId !== sessionId) {
        const prior = (await getSessionStoreBySessionId(
          c.env,
          priorSessionId,
          tenantId
        ).stub.getSessionRpc(priorSessionId)) as Session | null;
        if (prior && prior.userId === sessionUserId && prior.expiresAt > Date.now()) {
          evidence = mergeStepUpEvidence(
            sessionAssuranceEvidence(
              prior.data as Record<string, unknown> | undefined,
              upstreamAcrMappings
            ),
            evidence
          );
          // The combined evidence is as old as its oldest proof (0: unknown, never fresh), so it
          // cannot pass for a later step-up's own authentication.
          const combinedProvenAt =
            typeof prior.data?.proven_at === 'number'
              ? Math.min(prior.data.proven_at, provenAt)
              : 0;
          const store = getSessionStoreBySessionId(c.env, sessionId, tenantId).stub;
          // Written only over the evidence this request read: another step-up of the same session
          // may have combined its own factors meanwhile, and those are kept rather than replaced.
          let read = sessionData;
          let stored = evidence;
          let storedProvenAt = combinedProvenAt;
          let written = false;
          // The step-up's own login, just proven, stays what a later re-authentication can take,
          // paired with its own time, while the combined evidence counts from its oldest proof.
          const ownUnverified = Array.isArray(sessionData?.unverified_amr)
            ? sessionData.unverified_amr
            : [];
          const ownProvenAmr = (Array.isArray(sessionData?.amr) ? sessionData.amr : []).filter(
            (method) => !ownUnverified.includes(method)
          );
          let ownReauthProof =
            typeof sessionData?.reauth_proven_at === 'number' ||
            ownProvenAmr.length === 0 ||
            provenAt === undefined
              ? {}
              : { reauth_proven_amr: ownProvenAmr, reauth_proven_at: provenAt };
          for (let attempt = 0; attempt < 3 && !written; attempt++) {
            const updates = {
              amr: [...stored.amr],
              unverified_amr: [...(stored.unverifiedMethods ?? [])],
              ...(stored.upstreamAcr ? { upstream_acr: stored.upstreamAcr } : {}),
              proven_at: storedProvenAt,
              ...ownReauthProof,
            };
            const updated = (await store.updateSessionDataRpc(sessionId, updates, {
              ifDataMatches: {
                amr: read?.amr,
                unverified_amr: read?.unverified_amr,
                upstream_acr: read?.upstream_acr,
                proven_at: read?.proven_at,
                // Writing its own pair, a re-authentication completed meanwhile (a newer pair) must
                // fail the write rather than be replaced; without one, the newer pair is merged over.
                ...('reauth_proven_at' in ownReauthProof
                  ? {
                      reauth_proven_amr: read?.reauth_proven_amr,
                      reauth_proven_at: read?.reauth_proven_at,
                    }
                  : {}),
              } as Partial<SessionData>,
            })) as Session | null;
            if (!updated) {
              // The session ended meanwhile: nothing it proved may be used.
              return sendError('login_required', 'The session ended during the step-up');
            }
            const latest = updated.data as Record<string, unknown> | undefined;
            written = Object.entries(updates).every(
              ([field, value]) => JSON.stringify(latest?.[field]) === JSON.stringify(value)
            );
            if (!written) {
              read = latest;
              if (typeof latest?.reauth_proven_at === 'number') ownReauthProof = {};
              stored = mergeStepUpEvidence(
                sessionAssuranceEvidence(latest, upstreamAcrMappings),
                evidence
              );
              storedProvenAt = Math.min(
                typeof latest?.proven_at === 'number' ? latest.proven_at : 0,
                combinedProvenAt
              );
            }
          }
          if (!written) {
            // This request's own evidence stands; the session keeps what was written last.
            log.warn('The step-up could not be recorded in the session', {
              action: 'assurance_step_up_record',
            });
          }
          sessionAmr = [...evidence.amr];
        }
      }
    }
    const actualAal = computeAAL(evidence);
    const acrClaim = parsedClaimsRequest.request?.id_token?.acr as
      | { essential?: unknown; value?: unknown; values?: unknown }
      | null
      | undefined;
    const essentialValues = Array.isArray(acrClaim?.values)
      ? acrClaim.values.filter((value): value is string => typeof value === 'string')
      : typeof acrClaim?.value === 'string'
        ? [acrClaim.value]
        : null;
    const acrValueList = acr_values ? acr_values.split(' ').filter(Boolean) : [];
    // The other vocabularies' acr values Authrim issues: asked for, they count as their AAL.
    const outboundAcrMappings = parseOutboundAcrMappings(
      assuranceSettings['assurance.outbound_acr_mappings']
    );
    const interactive = !prompt?.split(' ').includes('none');
    const required = requiredAAL({
      defaultAAL: (assuranceSettings['assurance.default_aal'] as AAL) ?? 'AAL1',
      scopes: (scope ?? '').split(' ').filter(Boolean),
      scopeRequirements: parseScopeAALRequirements(
        assuranceSettings['assurance.scope_aal_requirements']
      ),
      essentialAcr: acrClaim?.essential === true ? { values: essentialValues } : null,
      acrValues: acrValueList,
      outboundAcrMappings,
      interactive,
      // A guest exemption only from the session of the user being authorized.
      guest: ownSession && isAnonymousSession,
    });
    if (required.unsatisfiable) {
      return sendError(
        'unmet_authentication_requirements',
        'None of the essential acr values requested can be met'
      );
    }
    const mandatoryMet = meetsAAL(actualAal, required.mandatory);
    if (!mandatoryMet && !interactive) {
      return sendError('login_required', 'A higher authentication assurance level is required');
    }
    if (!mandatoryMet && confirmedAssuranceStepUp) {
      // Stepped up once already: never loop.
      return sendError(
        'unmet_authentication_requirements',
        'The authentication does not meet the required assurance level'
      );
    }
    // Below the mandatory level: step up (whatever the step). Below only a voluntary target: step
    // up before consent, never again on the way back from it.
    const reachTarget = !mandatoryMet || _consent_confirmed !== 'true';
    if (
      !meetsAAL(actualAal, required.target) &&
      interactive &&
      !confirmedAssuranceStepUp &&
      reachTarget
    ) {
      assuranceStepUp = { requiredAal: required.target };
    }
    assuranceAal = actualAal;
    // The acr of the AAL actually reached, never a lower one the request asked for (selectAcr
    // answers the request, for ID tokens).
    assuranceTokenAcr = aalToAcr(actualAal) ?? undefined;
    const unproven = new Set(evidence.unverifiedMethods ?? []);
    assuranceTokenAmr = evidence.amr.filter((method) => !unproven.has(method));
    // An essential acr naming values always gets one of them back (OIDC Core 5.5.1.1), whether or
    // not assurance claims are otherwise included.
    if (
      assuranceSettings['assurance.include_in_id_token'] === true ||
      (required.essential && required.essentialAcrs)
    ) {
      assuranceAcr = selectAcr(actualAal, required, acrValueList, outboundAcrMappings);
    }
  }

  // prompt=login and an expired max_age both require proof of a new authentication ceremony.
  // Use a reauth challenge tied to the current subject; never let an ordinary login challenge be
  // auto-completed merely because the browser still has a valid session cookie.
  if (
    (forceReauthentication && sessionUserId && _confirmed !== 'true') ||
    (assuranceStepUp && sessionUserId)
  ) {
    // Store authorization request parameters in ChallengeStore (RPC)
    // Use challengeId-based sharding for better scalability
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: challengeId,
      tenantId: getTenantIdFromContext(c),
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
        dpop_jkt,
        par_request_uri,
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
        issuer: getRequestIssuer(c),
        authorization_request_source: authorizationRequestSource,
        authorization_request_integrity_protected: claimsRequestIntegrityProtected,
        authorization_request_signed: requestObjectSigned,
        authorization_request_encrypted: requestObjectEncrypted,
        authorization_server: 'default',
        session_mode:
          clientMetadata?.browser_public_client_mode === 'strict'
            ? 'token_session'
            : 'managed_browser_session',
        handoff_methods:
          clientMetadata?.browser_public_client_mode === 'strict'
            ? ['dpop_token_verify']
            : ['cookie_session_finalize'],
        allowed_redirect_origins: clientMetadata?.allowed_redirect_origins ?? [],
        iframe_allowed:
          (clientMetadata as unknown as { iframe_allowed?: boolean } | null)?.iframe_allowed ===
          true,
        tenant_id: tenantId,
        // Custom Redirect URIs (Authrim Extension)
        error_uri: validatedErrorUri,
        cancel_uri: validatedCancelUri,
        // When the re-authentication was asked for (milliseconds): only a session proven after it
        // is its result.
        reauth_issued_at: Date.now(),
        // An assurance step-up: the session the user steps up from, and the level to reach.
        ...(assuranceStepUp
          ? {
              assurance_step_up: {
                ...(sessionId ? { prior_session_id: sessionId } : {}),
                required_aal: assuranceStepUp.requiredAal,
                // Milliseconds, compared with the creation of the step-up's session.
                issued_at: Date.now(),
              },
            }
          : {}),
      },
    });

    // Redirect to UI re-authentication screen
    // UI configured: redirect to external UI
    // Not configured: return configuration error
    const reauthUiQueryParams = getChallengeUiQueryParams(challengeId, ui_locales);
    if (assuranceStepUp) reauthUiQueryParams.required_aal = assuranceStepUp.requiredAal;
    const reauthTarget = await getUIRedirectTarget(
      c.env,
      'reauth',
      getTenantAwareUiQueryParams(c, reauthUiQueryParams),
      tenantId,
      undefined,
      getRequestIssuer(c)
    );
    if (reauthTarget.type === 'config_error') {
      await cleanupFailedUIChallenge(challengeStore, challengeId, 'reauth');
      return sendError('temporarily_unavailable', 'Login UI is not configured');
    }
    return c.redirect(reauthTarget.url, 302);
  }

  // If no session exists and prompt is not 'none', redirect to login screen
  if (!sessionUserId && !prompt?.includes('none')) {
    // Store authorization request parameters in ChallengeStore (RPC)
    // Use challengeId-based sharding for better scalability
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: challengeId,
      tenantId: getTenantIdFromContext(c),
      type: 'login',
      userId: 'anonymous',
      challenge: challengeId,
      ttl: 600, // 10 minutes
      metadata: {
        // SSO off: the browser's session never answers this client's sign-in, so only an
        // authentication made after this challenge completes it (no silent reuse through the UI).
        ...(!ssoEnabled ? { fresh_sign_in_after: Date.now() } : {}),
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        nonce,
        code_challenge,
        code_challenge_method,
        claims,
        dpop_jkt,
        par_request_uri,
        response_mode,
        max_age,
        prompt,
        id_token_hint,
        acr_values,
        display,
        ui_locales,
        login_hint,
        session_mode:
          clientMetadata?.browser_public_client_mode === 'strict'
            ? 'token_session'
            : 'managed_browser_session',
        handoff_methods:
          clientMetadata?.browser_public_client_mode === 'strict'
            ? ['dpop_token_verify']
            : ['cookie_session_finalize'],
        allowed_redirect_origins: clientMetadata?.allowed_redirect_origins ?? [],
        iframe_allowed:
          (clientMetadata as unknown as { iframe_allowed?: boolean } | null)?.iframe_allowed ===
          true,
        // Client metadata for login page display (OIDC Dynamic OP requirement)
        client_name: clientMetadata?.client_name || client_id,
        logo_uri: clientMetadata?.logo_uri,
        policy_uri: clientMetadata?.policy_uri,
        tos_uri: clientMetadata?.tos_uri,
        client_uri: clientMetadata?.client_uri,
        tenant_id: tenantId,
        issuer: getRequestIssuer(c),
        authorization_request_source: authorizationRequestSource,
        authorization_request_integrity_protected: claimsRequestIntegrityProtected,
        authorization_request_signed: requestObjectSigned,
        authorization_request_encrypted: requestObjectEncrypted,
        authorization_server: 'default',
        // Custom Redirect URIs (Authrim Extension)
        error_uri: validatedErrorUri,
        cancel_uri: validatedCancelUri,
      },
    });

    // Redirect to UI login screen
    // Client-specific UI: use client's login_ui_url
    // Global UI configured: redirect to external UI
    // Neither: return configuration error
    const loginUiQueryParams = getChallengeUiQueryParams(challengeId, ui_locales);
    const loginTarget = await getUIRedirectTarget(
      c.env,
      'login',
      getTenantAwareUiQueryParams(c, loginUiQueryParams),
      tenantId,
      clientMetadata?.login_ui_url,
      getRequestIssuer(c)
    );
    if (loginTarget.type === 'config_error') {
      await cleanupFailedUIChallenge(challengeStore, challengeId, 'login');
      return sendError('temporarily_unavailable', 'Login UI is not configured');
    }
    return c.redirect(loginTarget.url, 302);
  }

  // Determine user identifier (sub)
  // Use session user if available, otherwise not allowed (should have been redirected to login)
  if (!sessionUserId) {
    // This should only happen with prompt=none (which should have failed earlier with login_required)
    return sendError('login_required', 'User authentication is required');
  }

  const sub = sessionUserId;
  try {
    await timeAuthRequestDiagnosticOperation(c, 'auth_authorize_account_route', () =>
      resolveAccountDataContextFromHono(c, sub)
    );
  } catch (error) {
    log.error(
      'Unable to resolve account data for authorization',
      { action: 'account_route_resolve' },
      error as Error
    );
    return sendError('temporarily_unavailable', 'Account data is temporarily unavailable');
  }
  if (_consent_confirmed === 'true' && confirmedConsentUserId && confirmedConsentUserId !== sub) {
    return sendError('invalid_request', 'Consent confirmation does not match the active session');
  }

  // The user's consent withdrawals for this client, read before the consent is checked: the code
  // records this generation, so a withdrawal completing while the old consent is still seen here
  // refuses the code at the token endpoint. A consent a cache still holds from before the last
  // withdrawal is not used.
  let consentWithdrawal: OAuthClientConsentRevocationState;
  try {
    consentWithdrawal = await timeAuthRequestDiagnosticOperation(
      c,
      'auth_authorize_consent_withdrawal',
      () =>
        findOAuthClientConsentRevocation(
          createAccountAuthContextFromHono(c, tenantId).coreAdapter,
          {
            tenantId,
            userId: sub,
            clientId: validClientId,
          }
        )
    );
  } catch (error) {
    log.error(
      'Unable to read consent withdrawals for authorization',
      { action: 'consent_withdrawal_read' },
      error as Error
    );
    return sendError('temporarily_unavailable', 'Account data is temporarily unavailable');
  }
  // A consent confirmed on the consent screen counts only while no withdrawal has moved the
  // generation on since it was approved; otherwise it is checked (and asked for) again. A
  // confirmation without a generation predates generations and is checked again too.
  const consentConfirmed =
    _consent_confirmed === 'true' && confirmedConsentGeneration === consentWithdrawal.generation;
  const findCurrentConsent = async (
    adapter: Parameters<typeof getCachedConsent>[4]
  ): Promise<CachedConsent | null> => {
    const consent = await getCachedConsent(c.env, sub, validClientId, tenantId, adapter);
    if (!consent || consent.consent_generation === consentWithdrawal.generation) return consent;
    // Cached under another generation (or before generations were cached): the database holds
    // the consent now (one given again, or none), and the cache is refreshed from it. A consent
    // recorded under an earlier generation (an approval racing a withdrawal) counts as absent.
    const current = await getCachedConsent(c.env, sub, validClientId, tenantId, adapter, {
      refresh: true,
    });
    return current?.consent_generation === consentWithdrawal.generation ? current : null;
  };

  // Enforce PAR request_uri one-time use only after the request has reached an authenticated
  // authorization journey. The Durable Object consume remains atomic, so concurrent attempts
  // cannot both proceed.
  if (par_request_uri) {
    try {
      const parsedPar = parsePARRequestUri(par_request_uri);
      const stub = parsedPar
        ? getPARRequestStoreByUri(c.env, par_request_uri, tenantId).stub
        : c.env.PAR_REQUEST_STORE.get(c.env.PAR_REQUEST_STORE.idFromName(validClientId));
      await stub.consumeRequestRpc({
        requestUri: par_request_uri,
        tenant_id: tenantId,
        client_id: validClientId,
        expected_authorization_server: 'default',
      });
      par_request_uri = undefined;
    } catch {
      return sendError('invalid_request', 'Invalid or expired request_uri');
    }
  }

  // Check if consent is required (unless already confirmed)
  // Note: _consent_confirmed is already parsed at the top of this function
  if (!consentConfirmed) {
    // Get client metadata for logging (request-level cached)
    const clientMetadata = await getClientCached(c, c.env, validClientId);
    // Trust and sign-in confirmation policies are the tenant's; a user's consents live with the
    // user's account (where the consent screen records them), not in the tenant metadata database.
    const authCtx = createAuthContextFromHono(c, tenantId);
    const accountAuthCtx = createAccountAuthContextFromHono(c, tenantId);

    // Client Trust Policy is the sole authority for first-party and consent bypass decisions.
    let consentRequired = true; // Default: require consent (security-first)
    let firstParty = false;
    let clientTrustPolicySource: string | null = null;
    let signInConfirmationMode: string | null = null;
    let signInConfirmationRememberDurationDays: number | null = null;
    let requiresFirstTimeSignInConfirmation = false;

    try {
      const [clientTrustPolicy, signInConfirmationPolicy] =
        await timeAuthRequestDiagnosticOperation(c, 'auth_authorize_trust_policy', () =>
          Promise.all([
            resolveClientTrustPolicy(authCtx.coreAdapter, tenantId, 'oidc_client', validClientId),
            resolveSignInConfirmationPolicy(authCtx.coreAdapter, tenantId),
          ])
        );
      if (clientTrustPolicy) {
        firstParty = clientTrustPolicy.first_party;
        consentRequired = !(
          clientTrustPolicy.trusted || clientTrustPolicy.skip_authorization_consent
        );
        clientTrustPolicySource = 'client';
      }
      signInConfirmationMode = signInConfirmationPolicy?.mode ?? null;
      signInConfirmationRememberDurationDays =
        signInConfirmationPolicy?.remember_duration_days ?? null;
      if (signInConfirmationPolicy?.mode === 'every_time') {
        consentRequired = true;
      } else if (signInConfirmationPolicy?.mode === 'first_time') {
        requiresFirstTimeSignInConfirmation = true;
      }
    } catch (error) {
      log.warn('Failed to apply authoritative consent policies', {
        action: 'consent_policy_settings',
        clientId: validClientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const attributeReleaseConsentPolicy = normalizeAttributeReleaseConsentPolicy(
      clientMetadata?.attribute_release_consent
    );
    const requiresPerAuthorizationAttributeReleaseConsent =
      attributeReleaseConsentPolicy?.enabled === true &&
      attributeReleaseConsentPolicy.mode === 'every_time';
    const requiresEveryTimeSignInConfirmation = signInConfirmationMode === 'every_time';

    // Debug: Log consent decision factors
    log.info('Consent check - settings', {
      action: 'consent_check_settings',
      clientId: validClientId,
      consentRequired,
      firstParty,
      clientTrustPolicySource,
      signInConfirmationMode,
      attributeReleaseConsentMode: attributeReleaseConsentPolicy?.mode ?? null,
      requiresPerAuthorizationAttributeReleaseConsent,
      // Legacy D1 fields (for migration tracking)
      legacy_is_trusted: clientMetadata?.is_trusted,
      legacy_skip_consent: clientMetadata?.skip_consent,
    });

    // An active authoritative trust policy allows skipping consent.
    // (unless prompt=consent is explicitly specified)
    const isTrustedClient = !consentRequired;

    log.info('Consent check - decision', {
      action: 'consent_check_decision',
      clientId: validClientId,
      isTrustedClient,
      promptIncludesConsent: prompt?.includes('consent'),
      willSkipConsent:
        isTrustedClient &&
        !prompt?.includes('consent') &&
        !requiresPerAuthorizationAttributeReleaseConsent &&
        !requiresFirstTimeSignInConfirmation &&
        !requiresEveryTimeSignInConfirmation,
    });

    // Trusted clients skip consent (unless prompt=consent is explicitly specified)
    if (
      isTrustedClient &&
      !prompt?.includes('consent') &&
      !requiresPerAuthorizationAttributeReleaseConsent &&
      !requiresFirstTimeSignInConfirmation &&
      !requiresEveryTimeSignInConfirmation
    ) {
      // Check if consent already exists (using cache)
      const existingConsent = await timeAuthRequestDiagnosticOperation(
        c,
        'auth_authorize_consent_lookup',
        () => findCurrentConsent(accountAuthCtx.coreAdapter)
      );

      if (!existingConsent) {
        // Auto-grant consent for trusted client. The shared consent service
        // handles a concurrent first-grant race without a database-specific SQL
        // upsert, preserving the DatabaseAdapter abstraction.
        const consentId = crypto.randomUUID();
        const now = Date.now();

        try {
          await timeAuthRequestDiagnosticOperation(c, 'auth_authorize_consent_grant', () =>
            upsertOAuthClientConsent(accountAuthCtx.coreAdapter, {
              consentId,
              tenantId,
              userId: sub,
              clientId: validClientId,
              scope: scope ?? '',
              grantedAt: now,
              expiresAt: null,
              now,
              consentGeneration: consentWithdrawal.generation,
            })
          );
        } catch (error) {
          // Withdrawn while this request granted it: nothing was recorded; a new request starts
          // from the withdrawal.
          if (isOAuthClientConsentGenerationChanged(error)) {
            return sendError('temporarily_unavailable', 'Consent changed during authorization');
          }
          throw error;
        }

        // getCachedConsent does not negative-cache misses, so there is no stale entry to delete.

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
        const existingConsent = await findCurrentConsent(accountAuthCtx.coreAdapter);

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
        if (requiresPerAuthorizationAttributeReleaseConsent) {
          consentRequired = true;
        }
        if (requiresEveryTimeSignInConfirmation) {
          consentRequired = true;
        }
        if (requiresFirstTimeSignInConfirmation && signInConfirmationRememberDurationDays === 0) {
          consentRequired = true;
        }
        if (
          requiresFirstTimeSignInConfirmation &&
          existingConsent &&
          signInConfirmationRememberDurationDays !== null &&
          signInConfirmationRememberDurationDays > 0
        ) {
          const rememberMs = signInConfirmationRememberDurationDays * 24 * 60 * 60 * 1000;
          if (existingConsent.granted_at + rememberMs < Date.now()) {
            consentRequired = true;
          }
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
        const challengeStore = await getChallengeStoreByChallengeId(
          c.env,
          challengeId,
          getTenantIdFromContext(c)
        );

        await challengeStore.storeChallengeRpc({
          id: challengeId,
          tenantId: getTenantIdFromContext(c),
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
            dpop_jkt,
            par_request_uri,
            response_mode,
            max_age,
            prompt,
            id_token_hint,
            acr_values,
            display,
            ui_locales,
            login_hint,
            authorization_details,
            sessionUserId: sub,
            session_id: sessionId,
            authTime, // Preserve auth_time
            issuer: getRequestIssuer(c),
            authorization_request_source: authorizationRequestSource,
            authorization_request_integrity_protected: claimsRequestIntegrityProtected,
            authorization_request_signed: requestObjectSigned,
            authorization_request_encrypted: requestObjectEncrypted,
            authorization_server: 'default',
            // Phase 2-B RBAC extensions
            org_id,
            acting_as,
            // Custom Redirect URIs (Authrim Extension)
            error_uri: validatedErrorUri,
            cancel_uri: validatedCancelUri,
            confirmed_reauth: describeConfirmedReauthentication(),
          },
        });

        // Redirect to UI consent screen
        // UI configured: redirect to external UI
        // Not configured: return configuration error
        const consentUiQueryParams = getChallengeUiQueryParams(challengeId, ui_locales);
        const consentTarget = await getUIRedirectTarget(
          c.env,
          'consent',
          getTenantAwareUiQueryParams(c, consentUiQueryParams),
          tenantId,
          undefined,
          getRequestIssuer(c)
        );
        if (consentTarget.type === 'config_error') {
          await cleanupFailedUIChallenge(challengeStore, challengeId, 'consent');
          return sendError('temporarily_unavailable', 'Login UI is not configured');
        }
        return c.redirect(consentTarget.url, 302);
      }
    } // End of Third-Party Client consent check
  }

  // ==========================================================================
  // Consent Management Check (SAP CDC-like consent items)
  // Only when consent_management_enabled and not already confirmed
  // ==========================================================================
  if (!consentConfirmed) {
    try {
      const tenantId = getTenantIdFromContext(c);

      // Check KV first, then env, then code default (false)
      let consentMgmtEnabled = false;
      if (c.env.KV) {
        try {
          const settingsKv = c.env.KV;
          const kvVal = await timeAuthRequestDiagnosticOperation(
            c,
            'auth_authorize_consent_management_config',
            () => settingsKv.get('consent:consent_management_enabled')
          );
          if (kvVal !== null) {
            consentMgmtEnabled = kvVal === 'true' || kvVal === '1';
          } else {
            const envVal = (c.env as unknown as Record<string, string>).ENABLE_CONSENT_MANAGEMENT;
            consentMgmtEnabled = envVal === 'true' || envVal === '1';
          }
        } catch {
          const envVal = (c.env as unknown as Record<string, string>).ENABLE_CONSENT_MANAGEMENT;
          consentMgmtEnabled = envVal === 'true' || envVal === '1';
        }
      } else {
        const envVal = (c.env as unknown as Record<string, string>).ENABLE_CONSENT_MANAGEMENT;
        consentMgmtEnabled = envVal === 'true' || envVal === '1';
      }

      const authCtx = createAuthContextFromHono(c, tenantId);
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userClaims = await timeAuthRequestDiagnosticOperation(
        c,
        'auth_authorize_consent_user_claims',
        () => getUserClaimsForRules(authCtx.coreAdapter, tenantId, sub, piiCtx.defaultPiiAdapter)
      );
      const requirements = await timeAuthRequestDiagnosticOperation(
        c,
        'auth_authorize_consent_requirements',
        () =>
          resolveConsentRequirements(authCtx.coreAdapter, tenantId, validClientId, userClaims, {
            target_type: 'oidc_client',
            target_id: validClientId,
            requested_scopes: splitScopes(scope),
            requested_claims: collectRequestedClaimNames(parsedClaimsRequest.request),
          })
      );

      if (consentMgmtEnabled || requirements.length > 0) {
        if (requirements.length > 0) {
          const { satisfied, unsatisfied } = await timeAuthRequestDiagnosticOperation(
            c,
            'auth_authorize_consent_satisfaction',
            () => checkUserConsentSatisfaction(authCtx.coreAdapter, tenantId, sub, requirements)
          );

          if (!satisfied) {
            // prompt=none: can't show UI
            if (prompt?.includes('none')) {
              return sendError(
                'consent_required',
                'Consent management items require user interaction'
              );
            }

            // Determine enforcement from first unsatisfied required item
            const firstUnsatisfiedReq = requirements.find(
              (r) => unsatisfied.includes(r.statement_id) && r.is_required
            );
            const enforcement = firstUnsatisfiedReq?.enforcement ?? 'block';

            // Store challenge with consent item metadata
            const challengeId = crypto.randomUUID();
            const challengeStore = await getChallengeStoreByChallengeId(
              c.env,
              challengeId,
              getTenantIdFromContext(c)
            );

            await challengeStore.storeChallengeRpc({
              id: challengeId,
              tenantId: getTenantIdFromContext(c),
              type: 'consent',
              userId: sub,
              challenge: challengeId,
              ttl: 600,
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
                dpop_jkt,
                par_request_uri,
                response_mode,
                max_age,
                prompt,
                id_token_hint,
                acr_values,
                display,
                ui_locales,
                login_hint,
                authorization_details,
                sessionUserId: sub,
                session_id: sessionId,
                authTime,
                issuer: getRequestIssuer(c),
                authorization_request_source: authorizationRequestSource,
                authorization_request_integrity_protected: claimsRequestIntegrityProtected,
                authorization_request_signed: requestObjectSigned,
                authorization_request_encrypted: requestObjectEncrypted,
                authorization_server: 'default',
                org_id,
                acting_as,
                error_uri: validatedErrorUri,
                cancel_uri: validatedCancelUri,
                // Consent management metadata
                consent_items_required: unsatisfied,
                consent_items_enforcement: enforcement,
                confirmed_reauth: describeConfirmedReauthentication(),
              },
            });

            const clientMetadata = await getClientCached(c, c.env, validClientId);
            const consentUiQueryParams = getChallengeUiQueryParams(challengeId, ui_locales);
            const consentTarget = await getUIRedirectTarget(
              c.env,
              'consent',
              getTenantAwareUiQueryParams(c, consentUiQueryParams),
              tenantId,
              undefined,
              getRequestIssuer(c)
            );
            if (consentTarget.type === 'config_error') {
              await cleanupFailedUIChallenge(challengeStore, challengeId, 'consent');
              return sendError('temporarily_unavailable', 'Login UI is not configured');
            }
            return c.redirect(consentTarget.url, 302);
          }
        }
      }
    } catch (error) {
      log.error(
        'Consent management check failed',
        { action: 'consent_mgmt_check' },
        error as Error
      );
      return sendError('temporarily_unavailable', 'Unable to evaluate consent requirements');
    }
  }

  // Handoff Token SSO (Authrim Extension)
  // Issue only after all prompt=none, session, max_age, and consent checks have passed.
  if (prompt?.split(' ').includes('none') && handoff === 'true') {
    log.info('Handoff SSO: Issuing handoff token', {
      action: 'handoff_sso',
      hasSession: !!sessionId,
      hasUser: !!sessionUserId,
    });

    const handoffToken = crypto.randomUUID();
    const handoffStore = await getChallengeStoreByChallengeId(
      c.env,
      handoffToken,
      getTenantIdFromContext(c)
    );

    const handoffArtifactTtlSeconds = resolveHandoffArtifactTtlSeconds(
      c,
      clientMetadata as unknown as Record<string, unknown>
    );

    await handoffStore.storeChallengeRpc({
      id: `handoff:${handoffToken}`,
      tenantId: getTenantIdFromContext(c),
      type: 'handoff',
      userId: sessionUserId!,
      challenge: sessionId!,
      ttl: handoffArtifactTtlSeconds,
      metadata: {
        client_id: validClientId,
        state,
        aud: 'handoff',
        created_at: Date.now(),
      },
    });

    const callbackUrl = new URL(validRedirectUri);
    callbackUrl.searchParams.set('handoff_token', handoffToken);
    if (state) {
      callbackUrl.searchParams.set('state', state);
    }

    return c.redirect(callbackUrl.toString(), 302);
  }

  // Record authentication time
  const currentAuthTime = authTime || Math.floor(Date.now() / 1000);
  const oidcSid = sessionId
    ? await deriveOidcSid(sessionId, validClientId, getRequestIssuer(c))
    : undefined;
  log.debug('Final authTime for code', {
    action: 'auth_time_final',
    authTime,
    currentAuthTime,
    prompt,
  });

  // Handle acr_values parameter (Authentication Context Class Reference)
  // Only emit an ACR that came from the authenticated session. A requested
  // acr_values parameter is not proof that the authentication actually met it.
  // With assurance on and in ID tokens, the acr assurance chose (none when it has none to give).
  let selectedAcr = assuranceAcr !== undefined ? (assuranceAcr ?? undefined) : sessionAcr;
  if (acr_values && !selectedAcr) {
    log.debug('Ignoring requested acr_values without verified session ACR', {
      action: 'acr_unverified_request_ignored',
    });
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
  let dpopJkt: string | undefined = dpop_jkt;
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
      c.env,
      validClientId,
      getTenantIdFromContext(c)
    );

    if (dpopValidation.valid && dpopValidation.jkt) {
      if (dpopJkt && dpopJkt !== dpopValidation.jkt) {
        return sendError('invalid_dpop_proof', 'dpop_jkt does not match the key in the DPoP proof');
      }
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
  } else if (!dpopJkt && isStrictDPoPMode && clientMetadata?.dpop_bound_access_tokens === true) {
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
    const shardCount = await timeAuthRequestDiagnosticOperation(
      c,
      'auth_authorize_code_shard_config',
      () => getShardCount(c.env)
    );

    // Session→AuthCode Sticky Routing: Use session's shard index for AuthCode
    // This collocates Session and AuthCode on the same DO shard for locality,
    // reducing cross-POD latency by ~700-1500ms per request
    let authCodeStoreId: DurableObjectId;
    let authCodeStoreInstanceName: string;
    let authCodeShardIndex: number | null = null;
    if (shardCount > 0) {
      // Prefer session-based shard routing for locality
      const parsedSession = sessionId ? parseShardedSessionId(sessionId) : null;
      const shardIndex = parsedSession
        ? parsedSession.shardIndex % shardCount // Session Sticky: same shard as session
        : getAuthCodeShardIndex(sub, validClientId, shardCount); // Fallback: hash-based
      authCodeShardIndex = shardIndex;
      code = createShardedAuthCode(shardIndex, randomCode);
      authCodeStoreInstanceName = buildAuthCodeShardInstanceName(
        shardIndex,
        getTenantIdFromContext(c)
      );
      authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(authCodeStoreInstanceName);
    } else {
      // Sharding disabled - use tenant-scoped legacy instance
      code = randomCode;
      authCodeStoreInstanceName = buildDOInstanceName('auth-code', getTenantIdFromContext(c));
      authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(authCodeStoreInstanceName);
    }

    // Store authorization code using AuthorizationCodeStore Durable Object (RPC)
    try {
      const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);
      const authorizationGrantResource =
        typeof clientMetadata.default_resource === 'string' &&
        clientMetadata.default_resource.length > 0
          ? clientMetadata.default_resource
          : typeof clientMetadata.default_audience === 'string' &&
              clientMetadata.default_audience.length > 0
            ? clientMetadata.default_audience
            : undefined;

      // Code lifetime for the client or tenant, and the per-user code limit (Settings API, else
      // the older oauth-config value, else env, else the default); the code store's own values
      // apply otherwise.
      const oauthSettings = await resolveEffectiveSettings(c.env, 'oauth', {
        tenantId: getTenantIdFromContext(c),
        clientId: validClientId,
      });
      const authCodeTtl = oauthSettings['oauth.auth_code_ttl'];
      const authCodeTtlSeconds = typeof authCodeTtl === 'number' ? authCodeTtl : undefined;
      const maxCodesPerUser = oauthSettings['oauth.max_codes_per_user'];
      await timeAuthRequestDiagnosticOperation(c, 'auth_authorize_code_store', () =>
        authCodeStore.storeCodeRpc({
          code: code as string,
          tenantId: getTenantIdFromContext(c),
          clientId: validClientId,
          ttlSeconds: authCodeTtlSeconds,
          maxCodesPerUser: typeof maxCodesPerUser === 'number' ? maxCodesPerUser : undefined,
          redirectUri: validRedirectUri,
          userId: sub,
          scope: validScope,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method as 'S256' | 'plain' | undefined,
          nonce,
          state,
          claims,
          claimsRequestProtected: claimsRequestIntegrityProtected,
          authTime: currentAuthTime,
          acr: selectedAcr,
          amr: sessionAmr,
          ...(assuranceAal ? { aal: assuranceAal } : {}),
          ...(assuranceTokenAcr ? { assuranceAcr: assuranceTokenAcr } : {}),
          ...(assuranceTokenAmr ? { assuranceAmr: assuranceTokenAmr } : {}),
          // FAL3 evidence the token endpoint checks: pushed (PAR) with a signed request object.
          ...(authorizationRequestSource === 'par' && requestObjectSigned
            ? { pushedSignedRequest: true }
            : {}),
          dpopJkt, // Bind authorization code to DPoP key (RFC 9449)
          sid: oidcSid, // OIDC Session Management: derived RP-specific session identifier
          sessionId, // Internal OP session key for logout target lookup
          authorizationDetails: authorization_details, // RFC 9396 RAR
          resource: authorizationGrantResource,
          // The generation the consent was approved under (the current one, checked above), or the
          // one read before the consent was checked here.
          consentGeneration:
            consentConfirmed && confirmedConsentGeneration !== undefined
              ? confirmedConsentGeneration
              : consentWithdrawal.generation,
        })
      );
      log.info('Stored authorization code', {
        action: 'auth_code_store',
        tenantId: getTenantIdFromContext(c),
        clientId: validClientId,
        shardCount,
        shardIndex: authCodeShardIndex,
      });
    } catch (error) {
      log.error('AuthCodeStore DO error', { action: 'auth_code_store' }, error as Error);
      return sendError('server_error', 'Failed to process authorization request');
    }
  }

  // Token lifetimes for the client or tenant (Settings API, else env, else the default), as the
  // token endpoint reads them: the access token's and the ID token's, each under the tenant
  // profile's max_token_ttl_seconds.
  let tokenLifetimeSeconds = 3600;
  let idTokenLifetimeSeconds = 3600;
  if (includesToken || includesIdToken) {
    try {
      const [oauthSettings, profile] = await Promise.all([
        resolveEffectiveSettings(c.env, 'oauth', {
          tenantId: getTenantIdFromContext(c),
          clientId: validClientId,
        }),
        tenantProfilePromise,
      ]);
      const lifetime = (key: string, fallback: number) => {
        const configured = Number(oauthSettings[key]);
        const seconds = Number.isFinite(configured) && configured > 0 ? configured : fallback;
        return Math.min(seconds, profile.max_token_ttl_seconds);
      };
      tokenLifetimeSeconds = lifetime('oauth.access_token_expiry', tokenLifetimeSeconds);
      idTokenLifetimeSeconds = lifetime('oauth.id_token_expiry', idTokenLifetimeSeconds);
    } catch (error) {
      log.error('Token lifetime settings could not be read', {}, error as Error);
      return sendError('server_error', 'Failed to process authorization request');
    }
  }

  // Generate access token if needed (for implicit and hybrid flows)
  let accessToken: string | undefined;
  let accessTokenJti: string | undefined;
  if (includesToken) {
    try {
      // Get issuer from environment
      const issuer = getRequestIssuer(c);

      const { privateKey, kid: signingKeyId } = await getSigningKeyFromKeyManager(
        c.env,
        getTenantIdFromContext(c)
      );

      // Generate region-aware JTI for token revocation sharding
      const { jti: regionAwareJti } = await generateRegionAwareJti(
        c.env,
        getTenantIdFromContext(c)
      );

      const tokenResult = await createAccessToken(
        {
          iss: issuer,
          sub,
          aud: issuer, // Access token audience should be issuer (resource server), not client_id
          scope: validScope,
          client_id: validClientId,
          claims,
          ...(claims ? { claims_request_protected: claimsRequestIntegrityProtected === true } : {}),
          // Assurance (include_in_access_token): how the user authenticated, as RFC 9068 has it.
          ...(assuranceEnabled && assuranceSettings['assurance.include_in_access_token'] === true
            ? {
                auth_time: currentAuthTime,
                ...(assuranceTokenAcr ? { acr: assuranceTokenAcr } : {}),
                ...(assuranceTokenAmr?.length ? { amr: assuranceTokenAmr } : {}),
              }
            : {}),
        },
        privateKey,
        signingKeyId,
        tokenLifetimeSeconds,
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
      const issuer = getRequestIssuer(c);

      // Signed as the token endpoint signs this app's ID tokens.
      const idTokenSigningAlgorithm = resolveIDTokenSigningAlgorithm(
        clientMetadata,
        await resolveIDTokenSigningPolicy(c.env, getTenantIdFromContext(c))
      );
      const { privateKey, kid: signingKeyId } = await getSigningKeyFromKeyManager(
        c.env,
        getTenantIdFromContext(c),
        idTokenSigningAlgorithm
      );

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
      let idTokenClaims: Record<string, unknown> = {
        iss: issuer,
        sub,
        aud: validClientId,
        auth_time: currentAuthTime,
        nonce, // Include nonce (required for implicit/hybrid flows)
        c_hash: cHash,
        at_hash: atHash,
        ...(oidcSid && { sid: oidcSid }), // OIDC Session Management: derived RP-specific session identifier
      };

      // Add acr claim if acr_values was requested (OIDC Core 2: SHOULD return acr)
      if (selectedAcr) {
        idTokenClaims.acr = selectedAcr;
      }
      if (sessionAmr?.length) {
        idTokenClaims.amr = sessionAmr;
      }

      // OIDC Core 5.4: For response_type=id_token (no access token), scope-based claims
      // must be included in the ID token since UserInfo endpoint is not accessible
      // Also include individual claims from the claims parameter.
      const isIdTokenOnly = includesIdToken && !includesToken && !includesCode;
      const scopes = validScope.split(' ');
      const hasRequestedIdTokenClaims =
        Object.keys(parsedClaimsRequest.request?.id_token ?? {}).length > 0;
      const hasIdTokenSAORules = hasSAORulesForTarget(parsedClaimsRequest.request, 'id_token');

      if (isIdTokenOnly || hasRequestedIdTokenClaims || hasIdTokenSAORules) {
        // Fetch user data from cache (Read-Through Cache) or D1
        const piiCtx = createPIIContextFromHono(c, tenantId);
        const user = await loadOIDCClaimsUser(c, tenantId, sub, piiCtx);

        const userData: Record<string, unknown> = {
          ...(user ? buildStandardUserClaims(user) : {}),
          sub,
          auth_time: currentAuthTime,
          ...(selectedAcr ? { acr: selectedAcr } : {}),
          ...(sessionAmr?.length ? { amr: sessionAmr } : {}),
        };

        const requestedClaims = evaluateClaimsForTarget({
          target: 'id_token',
          claimsRequest: parsedClaimsRequest.request,
          initialClaims: idTokenClaims,
          availableClaims: userData,
          grantedScopes: scopes,
          clientPolicy: clientMetadata,
          includeScopeClaims: isIdTokenOnly,
          requestIntegrityProtected: claimsRequestIntegrityProtected,
        });
        if (!requestedClaims.ok) {
          return sendError(requestedClaims.error, requestedClaims.error_description);
        }
        idTokenClaims = requestedClaims.claims;
      }

      idToken = await createIDToken(
        idTokenClaims as Parameters<typeof createIDToken>[0],
        privateKey,
        signingKeyId,
        idTokenLifetimeSeconds,
        idTokenSigningAlgorithm
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
  if ((includesIdToken || includesToken) && sessionId) {
    try {
      const tenantId = getTenantIdFromContext(c);
      log.debug('Registering session-client for implicit/hybrid logout', {
        action: 'session_client_register',
        clientId: validClientId,
      });
      const registrationInput = {
        session_id: sessionId,
        client_id: validClientId,
        oidc_sid: oidcSid,
      };
      const storeRegistrationPromise = registerSessionClientInStore(
        c.env,
        tenantId,
        registrationInput
      )
        .then((result) => {
          if (!result) {
            return;
          }
          log.debug('Successfully registered session-client in DO', {
            action: 'session_client_registered',
          });
        })
        .catch((error) => {
          log.error(
            'Failed to register session-client in DO for implicit/hybrid logout',
            { action: 'session_client_register' },
            error as Error
          );
        });
      c.executionCtx?.waitUntil(storeRegistrationPromise);
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
  if (accessToken) responseParams.expires_in = String(tokenLifetimeSeconds);
  if (idToken) responseParams.id_token = idToken;
  if (state) responseParams.state = state;
  // RFC 9207: Add iss parameter to prevent mix-up attacks
  responseParams.iss = getRequestIssuer(c);

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

    return await createJARMResponse(
      c,
      validRedirectUri,
      responseParams,
      baseMode,
      validClientId,
      fapiConfig.messageSigning
    );
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
 * Whether an id_token_hint's sub names this user: the user's id, or the sub this app's ID tokens
 * carry for them when its identity mapping issues another one (pairwise or persistent
 * identifiers). A mapping that cannot be applied names no one.
 */
async function idTokenHintNamesUser(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientId: string,
  clientMetadata: ClientMetadata,
  scope: string | undefined,
  hintSubject: string,
  userId: string
): Promise<boolean> {
  if (hintSubject === userId) return true;
  try {
    // The user's claims, as an ID token is built from them: a mapping may derive sub from one.
    // Without them the sub is derived from the id alone (a mismatch at worst, never a match).
    const user = await resolveAccountDataContextFromHono(c, userId)
      .then(() => loadOIDCClaimsUser(c, tenantId, userId, createPIIContextFromHono(c, tenantId)))
      .catch(() => null);
    const subject = await deriveOIDCSubject({
      adapter: createAuthContextFromHono(c, tenantId).coreAdapter,
      env: c.env,
      tenantId,
      clientId,
      sectorIdentifier: clientMetadata.sector_identifier_uri,
      selector: clientMetadata.identity_mapping,
      destinationSurface: 'id_token',
      grantedScopes: scope?.split(' ').filter(Boolean),
      claims: { ...(user ? buildStandardUserClaims(user) : {}), sub: userId },
    });
    return subject === hintSubject;
  } catch (error) {
    getLogger(c)
      .module('AUTHORIZE')
      .warn('id_token_hint subject could not be mapped for this app', {
        action: 'id_token_hint_mapping_failed',
        clientId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    return false;
  }
}

/**
 * Get signing key from per-tenant KeyManager with caching.
 * Checks KV version signal to detect cross-worker emergency rotations.
 */
async function getSigningKeyFromKeyManager(
  env: Env,
  tenantId: string,
  algorithm: OIDCSigningAlgorithm = 'RS256'
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();
  const cacheKey = `${tenantId}:${algorithm}`;
  const cached = signingKeyCache.get(cacheKey);

  // Check cache — if within TTL, verify KV version to detect emergency rotation
  if (cached && now - cached.timestamp < KEY_CACHE_TTL) {
    const currentVersion =
      (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';
    if (currentVersion === cached.version) {
      return { privateKey: cached.privateKey, kid: cached.kid };
    }
    // Version mismatch: emergency rotation detected — fall through to refresh
  }

  // Cache miss or version mismatch: fetch from per-tenant KeyManager DO
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Try to get active key via RPC
  const keyData = await keyManager.getActiveOIDCSigningKeyWithPrivateRpc(algorithm);

  if (keyData) {
    moduleLogger.debug('Active key response', {
      action: 'key_manager_active',
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
  const privateKey = await importPKCS8(keyData.privatePEM, algorithm);

  // Fetch current version for cache coherence
  const version =
    (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';

  setBoundedMapEntry(
    signingKeyCache,
    cacheKey,
    { privateKey, kid: keyData.kid, timestamp: now, version },
    MAX_SIGNING_KEY_CACHE_ENTRIES
  );
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
  messageSigning?: FAPI2MessageSigningConfig;
  // Custom Redirect URIs (Authrim Extension)
  errorUri?: string;
  cancelUri?: string;
  isUserCancellation?: boolean;
}

export async function redirectWithError(
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
  params.iss = getRequestIssuer(c);

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
      return await createJARMResponse(
        c,
        targetUri,
        params,
        baseMode || 'query',
        options.clientId,
        options.messageSigning
      );
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

  const redirectOrigin = new URL(redirectUri).origin;

  // Set CSP header with nonce to allow inline script/style and restrict form submission.
  return c.html(html, 200, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      `form-action ${redirectOrigin}`,
      "base-uri 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
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
  clientId: string,
  messageSigning?: FAPI2MessageSigningConfig
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
      iss: getRequestIssuer(c), // Issuer
      aud: clientId, // Audience (client_id)
      exp: now + 600, // Expires in 10 minutes
      iat: now, // Issued at
      ...params, // Include all response parameters
    };

    const tenantId = getTenantIdFromContext(c);
    const defaultSigningAlgorithm =
      messageSigning?.enabled && messageSigning.defaultAuthorizationSigningAlgorithm
        ? messageSigning.defaultAuthorizationSigningAlgorithm
        : 'RS256';
    const signingAlgorithm = resolveAuthorizationResponseSigningAlgorithm(
      client,
      defaultSigningAlgorithm
    );
    if (
      messageSigning?.enabled &&
      messageSigning.authorizationSigningAlgorithms &&
      !messageSigning.authorizationSigningAlgorithms.includes(signingAlgorithm)
    ) {
      throw new Error('Client authorization response signing algorithm is not allowed by tenant');
    }
    const { privateKey, kid } = await getSigningKeyFromKeyManager(
      c.env,
      tenantId,
      signingAlgorithm
    );

    // Sign the JWT
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: signingAlgorithm, typ: 'oauth-authz-resp+jwt', kid })
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
        const encKey = selectJWEEncryptionKey(
          client.jwks.keys,
          client.authorization_encrypted_response_alg as JWEAlgorithm
        );

        if (!encKey) {
          throw new Error('No suitable encryption key found in client jwks');
        }

        clientPublicKeyJWK = encKey as PublicJWK;
      } else if (client.jwks_uri && typeof client.jwks_uri === 'string') {
        // SSRF protection: Block requests to internal addresses
        if (isInternalUrl(client.jwks_uri)) {
          throw new Error('SSRF protection: jwks_uri cannot point to internal addresses');
        }

        // Fetch JWKS from jwks_uri
        const jwks = await safeFetchJson<JWKS>(client.jwks_uri, {
          timeoutMs: 5000,
          maxResponseSize: 256 * 1024,
          redirect: 'error',
        });
        const encKey = selectJWEEncryptionKey(
          jwks.keys,
          client.authorization_encrypted_response_alg as JWEAlgorithm
        );

        if (!encKey) {
          throw new Error('No suitable encryption key found in client jwks_uri');
        }

        clientPublicKeyJWK = encKey as PublicJWK;
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
          ...(clientPublicKeyJWK.kid ? { kid: clientPublicKeyJWK.kid } : {}),
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

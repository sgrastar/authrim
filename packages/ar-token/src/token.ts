import type { Context } from 'hono';
import type { DatabaseAdapter, DatabaseSource, Env } from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  CanonicalIdentityRepository,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getRuntimeUserStoreSourcesFromHonoContext,
  resolveCustomClaimRuntimeSourcesFromEnv,
  registerSessionClientInStore,
  createRefreshTokenFamily,
  getRefreshTokenRotatorStubByJti,
  // Logging
  getLogger,
  createLogger,
  type Logger,
  // Validation
  validateGrantType,
  validateAuthCode,
  validateClientId,
  validateRedirectUri,
  parseShardedAuthCode,
  buildAuthCodeShardInstanceName,
  buildDOInstanceName,
  remapShardIndex,
  getShardCount,
  getChallengeStoreByChallengeId,
  // Token Revocation Sharding (Region-aware)
  generateRegionAwareJti,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  // Configuration Manager (KV > env > default)
  createOAuthConfigManager,
  recordRefreshTokenFamilyIndex,
  // Request-level caching (P0 KV Cache Optimization)
  getClientCached,
  loadTenantProfileCached,
  getSystemSettingsCached,
  requireDedicatedAdminDatabaseAdapter,
  resolveElevationGrantSubjectToken,
  ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
  getTenantSettings,
  TENANT_DEFAULTS,
  getDeviceSecretInstallationId,
  AdminMachineAccessRepository,
  hasAdminPermission,
  parseClaimsRequest,
  evaluateClaimsForTarget,
  buildStandardUserClaims,
  canonicalProjectionToOIDCClaimsUser,
  hasSAORulesForTarget,
  canIssueTokenWithPIIStatus,
  resolveOIDCPIIRequirement,
  applyOIDCIdentityMapping,
  OIDCIdentityMappingRuntimeError,
  enforceOIDCAttributeReleaseConsent,
  OIDCAttributeReleaseConsentRequiredError,
  FAPI2_MESSAGE_SIGNING_ALGS,
  validateClientCertificateBinding,
  setBoundedMapEntry,
} from '@authrim/ar-lib-core';
import {
  resolveIDTokenSigningAlgorithm,
  type OIDCSigningAlgorithm,
} from '@authrim/ar-lib-core/utils/oidc-signing';
import {
  revokeToken,
  getCachedUser,
  // Native SSO (OIDC Native SSO 1.0)
  DeviceInstallationRepository,
  DeviceSecretRepository,
  isNativeSSOEnabled,
  getNativeSSOConfig,
  DEVICE_SECRET_TOKEN_TYPE,
} from '@authrim/ar-lib-core';
import {
  createIDToken,
  createAccessToken,
  calculateAtHash,
  calculateDsHash,
  createRefreshToken,
  parseToken,
  parseTokenHeader,
  verifyToken,
  createSDJWTIDTokenFromClaims,
} from '@authrim/ar-lib-core';
import {
  encryptJWT,
  isIDTokenEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
  validateJWTBearerAssertion,
  validateClientAssertion,
  parseOAuthClientAuthenticationParams,
  authenticateConfidentialOAuthClient,
  parseTrustedIssuers,
  getIDTokenRBACClaims,
  getAccessTokenRBACClaims,
  evaluatePermissionEmbeddingForScope,
  isPolicyEmbeddingEnabled,
  isTokenRevoked,
  timingSafeEqual,
  verifyClientSecretHash,
  // Phase 8.2: Token Embedding Model
  createTokenClaimEvaluator,
  evaluateIdLevelPermissions,
  isCustomClaimsEnabled,
  isIdLevelPermissionsEnabled,
  getEmbeddingLimits,
  // Shared utilities
  parseBasicAuth,
  type TokenClaimEvaluationContext,
  type JWEAlgorithm,
  type JWEEncryption,
  type IDTokenClaims,
  type TokenTypeURN,
  type ActClaim,
  type ClientMetadata,
  type DeviceInstallation,
  type DeviceSecret,
  type NativeSSOErrorDetailCode,
  type ClientAssertionValidationOptions,
  type Phase1ErrorDetailSeverity,
  type Phase1ErrorDetailUserAction,
} from '@authrim/ar-lib-core';
import { importPKCS8, importJWK, type CryptoKey } from 'jose';
import { verifyExternalIdJagSubjectToken } from './external-id-jag-verifier';
import {
  extractDPoPProof,
  validateDPoPProof,
  isDPoPRequiredForRequest,
  type DPoPMode,
} from '@authrim/ar-lib-core';
import { parseDeviceCodeId, getDeviceCodeStoreById } from '@authrim/ar-lib-core';
import { parseCIBARequestId, getCIBARequestStoreById } from '@authrim/ar-lib-core';
// Custom Claim Schema Resolver
import {
  loadFeatureConfig,
  createCustomClaimSchemaResolverFromSources,
} from '@authrim/ar-lib-core';
// Tenant context
import { getTenantIdFromContext, hasPIIDatabase } from '@authrim/ar-lib-core';
// Event System
import { publishEvent, TOKEN_EVENTS, type TokenEventData } from '@authrim/ar-lib-core';
// ID-JAG (Identity Assertion Authorization Grant)
import {
  TOKEN_TYPE_ID_JAG,
  isValidIdJagSubjectTokenType,
  isIdJagRequest,
  type IdJagConfig,
  DEFAULT_ID_JAG_CONFIG,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';
import {
  NATIVE_SSO_ID_TOKEN_CLOCK_SKEW_SECONDS,
  buildNativeSSOInstallationMetadata,
  buildNativeSSOInstallationMetadataForIssuedInstallation,
  buildNativeSSOTokenExchangeSuccessResponse,
  isNativeSSOClientEnabled,
  isNativeSSOIssuanceEligible,
  nativeSSOError,
  nativeSSOInvalidGrant,
  normalizeDeviceSecretName,
  normalizeDeviceSecretPlatform,
  normalizeNativeSSOAudience,
  validateNativeSSODeviceSecretBinding,
  type NativeSSOFailureAuditContext,
  type RefreshTokenExpiryMetadata,
} from './native-sso-token-exchange';

export { validateNativeSSODeviceSecretBinding } from './native-sso-token-exchange';

const ADMIN_API_AUDIENCE = 'authrim:admin-api';
const DIRECT_AUTH_FINISH_GRANT_TYPE = 'urn:authrim:params:oauth:grant-type:direct-auth-finish';
const DIRECT_AUTH_GRANT_REDIRECT_URI = 'https://authrim.local/direct-auth/callback';
type DirectAuthChannel = 'browser' | 'native' | 'server';
type BrowserPublicClientMode = 'strict' | 'cookie_fallback' | 'legacy';
type BrowserRefreshTokenPolicy = 'disabled' | 'dpop_bound';

class SecurityProfileSettingsUnavailableError extends Error {
  constructor() {
    super('Security profile settings are temporarily unavailable');
    this.name = 'SecurityProfileSettingsUnavailableError';
  }
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

async function findCanonicalRuntimeAccount(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  options?: { includeInactive?: boolean }
) {
  return new CanonicalIdentityRepository(coreAdapter, tenantId).findAccountByLegacyUserId(
    userId,
    options
  );
}

function isDirectAuthChannel(channel: unknown): channel is DirectAuthChannel {
  return channel === 'browser' || channel === 'native' || channel === 'server';
}

function getClientTrustGroup(
  clientMetadata: ClientMetadata | null | undefined
): string | undefined {
  if (!clientMetadata) {
    return undefined;
  }

  const metadata = clientMetadata as ClientMetadata & {
    trust_group?: unknown;
    trust_group_id?: unknown;
  };
  const trustGroup = metadata.trust_group ?? metadata.trust_group_id;
  return typeof trustGroup === 'string' && trustGroup.length > 0 ? trustGroup : undefined;
}

type AccessTokenAudience = string | string[];
type AccessTokenAudienceSource =
  | 'resource_param'
  | 'audience_param'
  | 'both'
  | 'client_default_resource'
  | 'client_default_audience';

function normalizeTargetParameter(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    return value.map((item) => item.trim());
  }
  return [];
}

function getClientDefaultResource(clientMetadata: ClientMetadata): {
  value?: string;
  source?: 'client_default_resource' | 'client_default_audience';
} {
  const metadata = clientMetadata as ClientMetadata & {
    default_resource?: unknown;
    default_audience?: unknown;
  };

  if (typeof metadata.default_resource === 'string' && metadata.default_resource.length > 0) {
    return { value: metadata.default_resource, source: 'client_default_resource' };
  }

  if (typeof metadata.default_audience === 'string' && metadata.default_audience.length > 0) {
    return { value: metadata.default_audience, source: 'client_default_audience' };
  }

  return {};
}

function splitScope(scope: string | undefined): string[] {
  return (scope ?? '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function intersectScopes(requestedScopes: string[], allowedScopes: string[]): string[] {
  return requestedScopes.filter((scope) => hasAdminPermission(allowedScopes, scope));
}

function intersectMachinePermissionSets(
  principalPermissions: string[],
  credentialPermissions: string[]
): string[] {
  const result = new Set<string>();
  for (const principalPermission of principalPermissions) {
    for (const credentialPermission of credentialPermissions) {
      if (hasAdminPermission([principalPermission], credentialPermission)) {
        result.add(credentialPermission);
      } else if (hasAdminPermission([credentialPermission], principalPermission)) {
        result.add(principalPermission);
      }
    }
  }
  return Array.from(result);
}

function resolveMachineTenantScope(
  principalScopes: Array<{ scopeMode: string; tenantId: string | null }>,
  credentialScopes: Array<{ scopeMode: string; tenantId: string | null }>
): string[] {
  const effectiveCredentialScopes =
    credentialScopes.length > 0 ? credentialScopes : principalScopes;
  const principalAll = principalScopes.some((scope) => scope.scopeMode === 'all');
  const credentialAll = effectiveCredentialScopes.some((scope) => scope.scopeMode === 'all');

  if (principalAll && credentialAll) {
    return ['*'];
  }

  const principalTenants = principalAll
    ? null
    : new Set(
        principalScopes
          .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
          .map((scope) => scope.tenantId as string)
      );
  const credentialTenants = credentialAll
    ? null
    : new Set(
        effectiveCredentialScopes
          .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
          .map((scope) => scope.tenantId as string)
      );

  if (principalTenants === null) {
    return Array.from(credentialTenants ?? []);
  }
  if (credentialTenants === null) {
    return Array.from(principalTenants);
  }

  return Array.from(principalTenants).filter((tenantId) => credentialTenants.has(tenantId));
}

function toAccessTokenAudience(targets: string[]): AccessTokenAudience {
  return targets.length === 1 ? targets[0] : targets;
}

function normalizeStoredAccessTokenAudience(value: unknown): AccessTokenAudience | undefined {
  const normalized = normalizeTargetParameter(value);
  return normalized.length > 0 ? toAccessTokenAudience(normalized) : undefined;
}

function resolveAccessTokenAudience(
  c: Context<{ Bindings: Env }>,
  clientMetadata: ClientMetadata,
  input: {
    resource?: unknown;
    audience?: unknown;
    rejectResourceAudienceMismatch?: boolean;
  } = {}
):
  | {
      ok: true;
      audience: AccessTokenAudience;
      targets: string[];
      source: AccessTokenAudienceSource;
    }
  | { ok: false; description: string } {
  const resources = normalizeTargetParameter(input.resource);
  const audiences = normalizeTargetParameter(input.audience);

  if (
    input.rejectResourceAudienceMismatch &&
    resources.length > 0 &&
    audiences.length > 0 &&
    resources.join('\u0000') !== audiences.join('\u0000')
  ) {
    return {
      ok: false,
      description: 'resource and audience identify different access token targets',
    };
  }

  let targets: string[] = [];
  let source: AccessTokenAudienceSource;

  if (audiences.length > 0 && resources.length > 0) {
    targets = [...audiences, ...resources];
    source = 'both';
  } else if (audiences.length > 0) {
    targets = audiences;
    source = 'audience_param';
  } else if (resources.length > 0) {
    targets = resources;
    source = 'resource_param';
  } else {
    const clientDefault = getClientDefaultResource(clientMetadata);
    if (clientDefault.value && clientDefault.source) {
      targets = [clientDefault.value];
      source = clientDefault.source;
    } else {
      return {
        ok: false,
        description: 'No target resource is configured for this access token',
      };
    }
  }

  const allowedTargets = clientMetadata.allowed_token_exchange_resources || [];
  if (allowedTargets.length > 0) {
    const disallowedTargets = targets.filter((target) => !allowedTargets.includes(target));
    if (disallowedTargets.length > 0) {
      return {
        ok: false,
        description: `Requested audience/resource not allowed: ${disallowedTargets.join(', ')}`,
      };
    }
  }

  return {
    ok: true,
    audience: toAccessTokenAudience(targets),
    targets,
    source,
  };
}

function buildRefreshTokenExpiryMetadata(
  issuedAtEpochSeconds: number,
  expiresInSeconds: number | null | undefined
): RefreshTokenExpiryMetadata | undefined {
  if (
    expiresInSeconds === undefined ||
    expiresInSeconds === null ||
    !Number.isFinite(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    return undefined;
  }

  const refreshTokenExpiresAtUnix = issuedAtEpochSeconds + expiresInSeconds;
  const refreshTokenExpiresAt = formatEpochSecondsAsRfc3339(refreshTokenExpiresAtUnix);

  return {
    refresh_token_expires_in: expiresInSeconds,
    refresh_token_expires_at: refreshTokenExpiresAt,
    refresh_token_expires_at_unix: refreshTokenExpiresAtUnix,
  };
}

function isValidBrowserPublicClientMode(value: unknown): value is BrowserPublicClientMode {
  return value === 'strict' || value === 'cookie_fallback' || value === 'legacy';
}

function isPublicClientMetadata(clientMetadata: ClientMetadata): boolean {
  return (
    clientMetadata.token_endpoint_auth_method === 'none' ||
    (!clientMetadata.client_secret_hash &&
      clientMetadata.token_endpoint_auth_method !== 'client_secret_basic' &&
      clientMetadata.token_endpoint_auth_method !== 'client_secret_post' &&
      clientMetadata.token_endpoint_auth_method !== 'client_secret_jwt' &&
      clientMetadata.token_endpoint_auth_method !== 'private_key_jwt')
  );
}

function isBrowserPublicTokenRequest(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>,
  clientMetadata: ClientMetadata
): boolean {
  if (!isPublicClientMetadata(clientMetadata)) {
    return false;
  }

  if (formData.channel === 'native') {
    return false;
  }

  if (formData.channel === 'browser') {
    return true;
  }

  if (
    clientMetadata.application_type === 'spa' ||
    isValidBrowserPublicClientMode(clientMetadata.browser_public_client_mode)
  ) {
    return true;
  }

  return Boolean(c.req.header('Origin'));
}

function isNativePublicTokenRequest(
  formData: Record<string, string>,
  clientMetadata: ClientMetadata
): boolean {
  if (!isPublicClientMetadata(clientMetadata)) {
    return false;
  }

  return formData.channel === 'native' || clientMetadata.application_type === 'native';
}

function getDPoPJktFromCnfClaim(payload: Record<string, unknown>): string | undefined {
  const cnf = payload.cnf;
  if (!cnf || typeof cnf !== 'object') {
    return undefined;
  }

  const jkt = (cnf as { jkt?: unknown }).jkt;
  return typeof jkt === 'string' && jkt.length > 0 ? jkt : undefined;
}

function getMTLSCertificateThumbprintFromCnfClaim(
  payload: Record<string, unknown>
): string | undefined {
  const cnf = payload.cnf;
  if (!cnf || typeof cnf !== 'object' || Array.isArray(cnf)) return undefined;
  const thumbprint = (cnf as Record<string, unknown>)['x5t#S256'];
  return typeof thumbprint === 'string' && thumbprint.length > 0 ? thumbprint : undefined;
}

async function resolveBrowserPublicClientMode(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientMetadata: ClientMetadata
): Promise<BrowserPublicClientMode> {
  if (isValidBrowserPublicClientMode(clientMetadata.browser_public_client_mode)) {
    return clientMetadata.browser_public_client_mode;
  }

  if (isPublicClientMetadata(clientMetadata)) {
    return 'strict';
  }

  const authrimSettings = await getTenantSettings(c.env.AUTHRIM_CONFIG, tenantId, 'tenant');
  const settings = authrimSettings ?? (await getTenantSettings(c.env.SETTINGS, tenantId, 'tenant'));
  const tenantMode = settings?.['tenant.browser_public_client_mode'];
  if (isValidBrowserPublicClientMode(tenantMode)) {
    return tenantMode;
  }

  return TENANT_DEFAULTS['tenant.browser_public_client_mode'];
}

interface TenantRBACClaimsConfig {
  accessToken: string | undefined;
  idToken: string | undefined;
}

async function resolveTenantRBACClaimsConfig(
  env: Env,
  tenantId: string
): Promise<TenantRBACClaimsConfig> {
  const authrimSettings = await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tokens');
  const settings = authrimSettings ?? (await getTenantSettings(env.SETTINGS, tenantId, 'tokens'));
  const accessToken = settings?.['tokens.rbac_access_token_claims'];
  const idToken = settings?.['tokens.rbac_id_token_claims'];

  return {
    accessToken: typeof accessToken === 'string' ? accessToken : env.RBAC_ACCESS_TOKEN_CLAIMS,
    idToken: typeof idToken === 'string' ? idToken : env.RBAC_ID_TOKEN_CLAIMS,
  };
}

function getBrowserRefreshTokenPolicy(clientMetadata: ClientMetadata): BrowserRefreshTokenPolicy {
  return clientMetadata.browser_refresh_token_policy === 'dpop_bound' ? 'dpop_bound' : 'disabled';
}

function formatEpochSecondsAsRfc3339(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ===== RFC 6750 Compliant Error Response Helpers =====
// RFC 6750 Section 3: WWW-Authenticate header MUST be included in 401 responses
// for Bearer token authentication errors

/**
 * Create OAuth error response with proper headers
 * RFC 6749 Section 5.2 + RFC 6750 Section 3 compliant
 *
 * @param c - Hono context
 * @param error - OAuth error code
 * @param errorDescription - Human-readable error description
 * @param status - HTTP status code (default 400)
 * @returns Response with proper headers
 */
function oauthError(
  c: Context<{ Bindings: Env }>,
  error: string,
  errorDescription: string,
  status: 400 | 401 | 403 | 500 | 503 = 400
): Response {
  // Set cache control headers (RFC 6749 Section 5.2)
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  // RFC 6750 Section 3: Add WWW-Authenticate header for 401 responses
  // Include error_description for better diagnostics (RFC 6750 Section 3.1)
  if (status === 401) {
    // Escape backslashes and double quotes in error_description for header safety
    const escapedDescription = errorDescription.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    c.header(
      'WWW-Authenticate',
      `Bearer error="${error}", error_description="${escapedDescription}"`
    );
  }

  return c.json(
    {
      error,
      error_description: errorDescription,
    },
    status
  );
}

async function applyOIDCIdentityMappingToIDTokenClaims(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientId: string,
  clientMetadata: ClientMetadata,
  claims: Record<string, unknown>,
  grantedScopes?: string[]
): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const authCtx = createAuthContextFromHono(c, tenantId);
    const mapped = await applyOIDCIdentityMapping({
      adapter: authCtx.coreAdapter,
      env: c.env,
      tenantId,
      clientId,
      sectorIdentifier: clientMetadata.sector_identifier_uri,
      selector: clientMetadata.identity_mapping,
      destinationSurface: 'id_token',
      grantedScopes,
      claims,
    });
    return { ok: true, claims: mapped.claims };
  } catch (error) {
    getLogger(c)
      .module('TOKEN')
      .error('Failed to apply OIDC identity mapping for ID token', { clientId }, error as Error);
    if (error instanceof OIDCIdentityMappingRuntimeError) {
      return {
        ok: false,
        response: oauthError(
          c,
          'invalid_client',
          'Client identity mapping configuration is invalid',
          400
        ),
      };
    }
    return {
      ok: false,
      response: oauthError(c, 'server_error', 'Failed to apply identity mapping', 500),
    };
  }
}

async function enforceOIDCAttributeReleaseConsentForIDTokenClaims(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientMetadata: ClientMetadata,
  claims: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const subjectId = typeof claims.sub === 'string' ? claims.sub : '';
  if (!subjectId) {
    return { ok: true };
  }

  try {
    await enforceOIDCAttributeReleaseConsent({
      env: c.env,
      tenantId,
      subjectId,
      clientMetadata,
      claims,
      target: 'id_token',
    });
    return { ok: true };
  } catch (error) {
    getLogger(c)
      .module('TOKEN')
      .warn('OIDC ID token claim release consent required', {
        clientId: clientMetadata.client_id,
        reasonCodes:
          error instanceof OIDCAttributeReleaseConsentRequiredError ? error.reasonCodes : [],
      });
    if (error instanceof OIDCAttributeReleaseConsentRequiredError) {
      return {
        ok: false,
        response: oauthError(
          c,
          'consent_required',
          describeOIDCClaimReleaseConsentRequired(error),
          400
        ),
      };
    }
    return {
      ok: false,
      response: oauthError(c, 'server_error', 'Failed to evaluate claim release consent', 500),
    };
  }
}

function describeOIDCClaimReleaseConsentRequired(
  error: OIDCAttributeReleaseConsentRequiredError
): string {
  if (error.reasonCodes.includes('release.attribute_consent.attribute_set_changed')) {
    return 'User consent is required because the ID token claim set has changed';
  }
  if (error.reasonCodes.includes('release.attribute_consent.every_time')) {
    return 'User consent is required for this ID token claim release';
  }
  return 'User consent is required before releasing ID token claims';
}

type DPoPValidationResult = Awaited<ReturnType<typeof validateDPoPProof>>;

type DPoPNoncePolicy = {
  enabled: boolean;
  source: 'client' | 'resource' | 'tenant' | 'default';
};

function generateDPoPNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
}

function getBooleanSetting(record: unknown, key: string): boolean | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getRecordSetting(record: unknown, key: string): Record<string, unknown> | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function resolveDPoPNoncePolicy(
  c: Context<{ Bindings: Env }>,
  options: {
    clientMetadata?: ClientMetadata | null;
    resources?: string[];
  } = {}
): Promise<DPoPNoncePolicy> {
  const clientOverride =
    getBooleanSetting(options.clientMetadata, 'dpop_nonce_enabled') ??
    getBooleanSetting(options.clientMetadata, 'dpop_nonce_required');
  if (clientOverride !== undefined) {
    return { enabled: clientOverride, source: 'client' };
  }

  let settings: Awaited<ReturnType<typeof getSystemSettingsCached>> | null = null;
  try {
    settings = await getSystemSettingsCached(c, c.env);
  } catch {
    settings = null;
  }

  const securitySettings = getRecordSetting(settings, 'security');
  const resourceOverrides =
    getRecordSetting(settings, 'security.dpop_nonce_resource_overrides') ??
    getRecordSetting(securitySettings, 'dpop_nonce_resource_overrides');
  if (resourceOverrides && options.resources) {
    for (const resource of options.resources) {
      const resourceOverride = getBooleanSetting(resourceOverrides, resource);
      if (resourceOverride !== undefined) {
        return { enabled: resourceOverride, source: 'resource' };
      }
    }
  }

  const tenantOverride =
    getBooleanSetting(settings, 'security.dpop_nonce_enabled') ??
    getBooleanSetting(securitySettings, 'dpop_nonce_enabled');
  if (tenantOverride !== undefined) {
    return { enabled: tenantOverride, source: 'tenant' };
  }

  return { enabled: true, source: 'default' };
}

async function dpopValidationErrorResponse(
  c: Context<{ Bindings: Env }>,
  dpopValidation: DPoPValidationResult,
  options: {
    fallbackError?: string;
    fallbackDescription?: string;
    clientMetadata?: ClientMetadata | null;
    resources?: string[];
  } = {}
): Promise<Response> {
  const error = dpopValidation.error || options.fallbackError || 'invalid_dpop_proof';
  const errorDescription =
    dpopValidation.error_description || options.fallbackDescription || 'DPoP validation failed';

  if (error !== 'use_dpop_nonce') {
    return oauthError(c, error, errorDescription, 400);
  }

  const policy = await resolveDPoPNoncePolicy(c, {
    clientMetadata: options.clientMetadata,
    resources: options.resources,
  });
  if (!policy.enabled) {
    return oauthError(c, options.fallbackError || 'invalid_dpop_proof', errorDescription, 400);
  }

  const response = oauthError(c, 'use_dpop_nonce', errorDescription, 400);
  response.headers.set('DPoP-Nonce', generateDPoPNonce());
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

async function isDPoPRequiredForTokenRequest(
  c: Context<{ Bindings: Env }>,
  clientMetadata: ClientMetadata
): Promise<boolean> {
  let fapiRequiresDpop = false;
  try {
    const settings = await getSystemSettingsCached(c, c.env, { failOnError: true });
    if (settings) {
      const fapi = (settings.fapi || {}) as { enabled?: boolean; requireDpop?: boolean };
      fapiRequiresDpop = Boolean(fapi.requireDpop || (fapi.enabled && fapi.requireDpop !== false));
    }
  } catch (error) {
    getLogger(c)
      .module('TOKEN')
      .error('Failed to load FAPI settings for DPoP', {}, error as Error);
    throw new SecurityProfileSettingsUnavailableError();
  }

  const requestPath = new URL(c.req.url).pathname;
  const clientRequiresDpop = isDPoPRequiredForRequest(
    (clientMetadata.dpop_mode as DPoPMode) || 'disabled',
    requestPath,
    Boolean(clientMetadata.dpop_bound_access_tokens)
  );

  return fapiRequiresDpop || clientRequiresDpop;
}

async function resolveClientAssertionValidationOptions(
  c: Context<{ Bindings: Env }>
): Promise<ClientAssertionValidationOptions | undefined> {
  let settings: { fapi?: { enabled?: boolean } } | null;
  try {
    settings = await getSystemSettingsCached(c, c.env, { failOnError: true });
  } catch {
    throw new SecurityProfileSettingsUnavailableError();
  }
  if (settings?.fapi?.enabled !== true) {
    return undefined;
  }

  return {
    audiencePolicy: 'issuer-only',
    issuer: getRequestIssuer(c),
    allowedAlgorithms: [...FAPI2_MESSAGE_SIGNING_ALGS],
    clockSkewSeconds: 60,
  };
}

async function resolveTokenClientAuthenticationPolicy(
  c: Context<{ Bindings: Env }>,
  clientMetadata: ClientMetadata,
  clientAssertion: string | undefined,
  clientAssertionType: string | undefined
): Promise<
  | { ok: true; assertionOptions: ClientAssertionValidationOptions | undefined }
  | { ok: false; response: Response }
> {
  const assertionOptions = await resolveClientAssertionValidationOptions(c);
  if (!assertionOptions) {
    return { ok: true, assertionOptions };
  }

  const grantTypes = clientMetadata.grant_types;
  const isCIBAClient = Array.isArray(grantTypes)
    ? grantTypes.includes('urn:openid:params:grant-type:ciba')
    : grantTypes === 'urn:openid:params:grant-type:ciba';
  const effectiveAssertionOptions = isCIBAClient
    ? { ...assertionOptions, audiencePolicy: 'endpoint-or-issuer' as const }
    : assertionOptions;

  if (
    clientMetadata.token_endpoint_auth_method !== 'private_key_jwt' ||
    !clientAssertion ||
    clientAssertionType !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    return {
      ok: false,
      response: oauthError(
        c,
        'invalid_client',
        'The active FAPI profile requires private_key_jwt client authentication',
        401
      ),
    };
  }

  return { ok: true, assertionOptions: effectiveAssertionOptions };
}

// ===== Module-level Logger for Helper Functions =====
// Used by functions that don't have access to Hono Context
const moduleLogger = createLogger().module('TOKEN');

type AccessTokenScopedPermission = {
  permission: string;
  scope_type: 'org' | 'resource';
  scope_target: string;
};

// ===== Key Caching for Performance Optimization =====
// Per-tenant Map cache for signing keys (avoids expensive RSA key import on every request)
// Security considerations:
// - Private key remains in Worker memory (same security boundary as DO)
// - TTL limits exposure window if key is rotated
// - KV version check detects cross-worker emergency rotations
const signingKeyCache = new Map<
  string,
  {
    privateKey: CryptoKey;
    kid: string;
    timestamp: number;
    version: string;
  }
>();
const KEY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes - safe with 24h rotation overlap
const MAX_TENANT_KEY_CACHE_ENTRIES = 128;

// ===== JWKS (Public Key) Caching for Refresh Token Verification =====
// Per-tenant Map cache for JWKS (avoids KeyManager DO hop on every refresh token request)
//
// ARCHITECTURE OPTIMIZATION (issue #DO-bottleneck):
// - Priority 1: Use PUBLIC_JWK_JSON env variable if available (DO access = 0)
// - Priority 2: Fall back to per-tenant KeyManager DO if env not set
//
// Security considerations:
// - Public keys only (no security risk if exposed)
// - Short TTL ensures timely rotation detection
// - kid mismatch triggers IMMEDIATE re-fetch (supports emergency rotation with overlap=0)
// - Normal rotation (overlap 5-10 min) keeps old keys in JWKS during overlap period
interface CachedJWKS {
  keys: Map<string, CryptoKey>; // kid → CryptoKey
  fetchedAt: number;
  source: 'env' | 'do'; // Track where keys came from
}
const cachedJWKSMap = new Map<string, CachedJWKS>(); // tenantId → CachedJWKS
const JWKS_CACHE_TTL = 0; // Verification keys must reflect emergency revocation immediately.

/**
 * Get verification key from JWKS with caching
 *
 * ARCHITECTURE OPTIMIZATION (DO Bottleneck Fix):
 * 1. Priority 1: Use PUBLIC_JWK_JSON env variable (zero DO access)
 * 2. Priority 2: Fall back to KeyManager DO only if env not configured
 *
 * Performance optimization: Caches imported CryptoKeys to avoid:
 * 1. KeyManager DO hop on every refresh token request (when using DO fallback)
 * 2. Expensive RSA key import (importJWK takes 5-7ms)
 *
 * Security considerations:
 * - Public keys only (no security risk if exposed)
 * - TTL aligned with signing key cache (5 minutes)
 * - kid mismatch triggers IMMEDIATE re-fetch (supports emergency rotation with overlap=0)
 * - Normal rotation (overlap 5-10 min) keeps old keys in JWKS during overlap period
 *
 * Emergency Rotation Support:
 * - When kid mismatch detected, cache is invalidated immediately
 * - If using env-based JWKS, rotation requires redeployment or env update
 * - If using DO-based JWKS, rotation is automatic via KeyManager
 *
 * @param env - Environment bindings
 * @param kid - Key ID from JWT header (optional, uses first key if not specified)
 * @returns CryptoKey for verification
 */
async function getVerificationKeyFromJWKS(
  env: Env,
  tenantId: string,
  kid?: string
): Promise<CryptoKey> {
  const now = Date.now();
  let cachedJWKS = cachedJWKSMap.get(tenantId) ?? null;

  // Check if cache is valid and contains the requested kid
  if (cachedJWKS && now - cachedJWKS.fetchedAt < JWKS_CACHE_TTL) {
    // If kid specified, look for it in cache
    if (kid) {
      const cachedKey = cachedJWKS.keys.get(kid);
      if (cachedKey) {
        return cachedKey;
      }
      // kid not in cache - EMERGENCY ROTATION detected!
      // Immediately invalidate cache and re-fetch
      moduleLogger.warn('kid not found in cache, forcing re-fetch (possible emergency rotation)', {
        kid,
        source: cachedJWKS.source,
        action: 'JWKS',
      });
      cachedJWKS = null; // Force cache invalidation
      cachedJWKSMap.delete(tenantId);
    } else {
      // No kid specified, return first cached key
      const firstKey = cachedJWKS.keys.values().next().value;
      if (firstKey) {
        return firstKey;
      }
    }
  }

  // ===== PRIORITY 1: Use PUBLIC_JWK_JSON environment variable (DO access = 0) =====
  // This eliminates the KeyManager DO bottleneck for verification
  if (env.PUBLIC_JWK_JSON) {
    try {
      const publicJwk = JSON.parse(env.PUBLIC_JWK_JSON) as { kid?: string; [key: string]: unknown };
      const keyKid = publicJwk.kid || 'default';
      const importedKey = (await importJWK(publicJwk, 'RS256')) as CryptoKey;

      // Build single-key cache from env
      const envKeys = new Map<string, CryptoKey>();
      envKeys.set(keyKid, importedKey);

      setBoundedMapEntry(
        cachedJWKSMap,
        tenantId,
        {
          keys: envKeys,
          fetchedAt: now,
          source: 'env',
        },
        MAX_TENANT_KEY_CACHE_ENTRIES
      );

      // If kid is specified and doesn't match env key, we have a problem
      // This means rotation happened but env wasn't updated
      if (kid && kid !== keyKid) {
        moduleLogger.warn(
          'Token kid does not match env PUBLIC_JWK_JSON kid - env needs update or falling back to DO',
          {
            tokenKid: kid,
            envKid: keyKid,
            action: 'JWKS',
          }
        );
        // Fall through to DO fallback below
      } else {
        moduleLogger.debug('Using PUBLIC_JWK_JSON (DO access=0)', { kid: keyKid, action: 'JWKS' });
        return importedKey;
      }
    } catch (err) {
      moduleLogger.error(
        'Failed to parse PUBLIC_JWK_JSON, falling back to KeyManager DO',
        { action: 'JWKS' },
        err as Error
      );
      // Fall through to DO fallback
    }
  }

  // ===== PRIORITY 2: Fall back to KeyManager DO =====
  // Only used when PUBLIC_JWK_JSON is not configured or doesn't match kid
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available and PUBLIC_JWK_JSON not configured');
  }

  moduleLogger.debug('Fetching from KeyManager DO', { kid: kid || 'any', action: 'JWKS' });

  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Use RPC to get all public keys
  const keys = await keyManager.getAllPublicKeysRpc();

  // Import all keys and build cache
  const newKeys = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const keyKid = (jwk as { kid?: string }).kid || 'default';
    try {
      const importedKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
      newKeys.set(keyKid, importedKey);
    } catch (err) {
      moduleLogger.error('Failed to import key', { kid: keyKid, action: 'JWKS' }, err as Error);
    }
  }

  if (newKeys.size === 0) {
    throw new Error('No valid keys in JWKS');
  }

  // Update per-tenant cache
  setBoundedMapEntry(
    cachedJWKSMap,
    tenantId,
    {
      keys: newKeys,
      fetchedAt: now,
      source: 'do',
    },
    MAX_TENANT_KEY_CACHE_ENTRIES
  );

  // Return requested key or first key
  if (kid) {
    const requestedKey = newKeys.get(kid);
    if (requestedKey) {
      return requestedKey;
    }
    // After fetching from DO, kid still not found = token signed with revoked key
    // SECURITY: Do not expose kid value in error to prevent key enumeration
    throw new Error('Signing key not found or has been revoked');
  }

  // Return first key
  return newKeys.values().next().value as CryptoKey;
}

/**
 * Response from AuthCodeStore Durable Object
 */
interface AuthCodeStoreResponse {
  userId: string;
  scope: string;
  redirectUri: string;
  nonce?: string;
  state?: string;
  createdAt?: number;
  claims?: string; // JSON string of claims parameter
  claimsRequestProtected?: boolean;
  authTime?: number;
  acr?: string;
  amr?: string[];
  cHash?: string; // OIDC c_hash for hybrid flows
  dpopJkt?: string; // DPoP JWK thumbprint (RFC 9449)
  sid?: string; // OIDC Session Management: Session ID for RP-Initiated Logout
  authorizationDetails?: string; // RFC 9396: Rich Authorization Requests (JSON string)
  // Present when replay attack is detected (RFC 6749 Section 4.1.2)
  replayAttack?: {
    accessTokenJti?: string;
    refreshTokenJti?: string;
  };
}

/**
 * Get signing key from KeyManager with caching
 * If no active key exists, generates a new one
 *
 * Performance optimization:
 * 1. Caches the imported CryptoKey to avoid expensive RSA key import (5-7ms)
 * 2. Uses kid mismatch trigger: Only fetches from DO when:
 *    - No cache exists (cold start)
 *    - TTL expired (safety refresh)
 *    - kid mismatch (key rotation detected from incoming token)
 *
 * This dramatically reduces DO access under high load where many isolates
 * start simultaneously - each isolate only needs ONE initial DO call,
 * then serves from cache until TTL expires or key rotates.
 *
 * @param env - Environment bindings
 * @param expectedKid - Optional kid from incoming token. If provided and matches cache, skip TTL check.
 */
async function getSigningKeyFromKeyManager(
  env: Env,
  tenantId: string,
  expectedKid?: string,
  algorithm: OIDCSigningAlgorithm = 'RS256'
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();
  const cacheKey = `${tenantId}:${algorithm}`;
  const cached = signingKeyCache.get(cacheKey);

  // Check cache with kid mismatch logic + KV version check
  if (cached) {
    const ttlValid = now - cached.timestamp < KEY_CACHE_TTL;

    // Case 1: expectedKid provided and matches cache → verify KV version before returning
    if (expectedKid && cached.kid === expectedKid) {
      const currentVersion =
        (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';
      if (currentVersion === cached.version) {
        return { privateKey: cached.privateKey, kid: cached.kid };
      }
      // Version mismatch: fall through to refresh
    }

    // Case 2: No expectedKid but TTL valid → verify KV version before returning
    if (!expectedKid && ttlValid) {
      const currentVersion =
        (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';
      if (currentVersion === cached.version) {
        return { privateKey: cached.privateKey, kid: cached.kid };
      }
      // Version mismatch: fall through to refresh
    }

    // Case 3: expectedKid provided but doesn't match → need to fetch new key (key rotation)
    // Case 4: TTL expired → need to refresh cache
    // Both cases fall through to fetch from DO
  }

  // Cache miss: fetch from per-tenant KeyManager DO
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Try to get active key via RPC
  let keyData =
    algorithm === 'RS256'
      ? await keyManager.getActiveKeyWithPrivateRpc()
      : await keyManager.getActiveOIDCSigningKeyWithPrivateRpc(algorithm);

  if (!keyData && algorithm === 'RS256') {
    // No active key, generate and activate one
    moduleLogger.info('No active signing key found, generating new key', {
      action: 'KeyManager',
      tenantId,
    });
    keyData = await keyManager.rotateKeysWithPrivateRpc();
    moduleLogger.info('Generated new signing key', { kid: keyData.kid, action: 'KeyManager' });
  }

  // Import private key (expensive operation: 5-7ms)
  if (!keyData) {
    throw new Error('OIDC signing key is unavailable');
  }
  const privateKey = await importPKCS8(keyData.privatePEM, algorithm);

  // Fetch current version for cache coherence
  const version =
    (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';

  setBoundedMapEntry(
    signingKeyCache,
    cacheKey,
    { privateKey, kid: keyData.kid, timestamp: now, version },
    MAX_TENANT_KEY_CACHE_ENTRIES
  );
  moduleLogger.debug('Signing key cached', {
    kid: keyData.kid,
    ttlMs: KEY_CACHE_TTL,
    action: 'KeyManager',
  });

  return { privateKey, kid: keyData.kid };
}

async function createClientIDToken(
  env: Env,
  tenantId: string,
  clientMetadata: ClientMetadata,
  claims: Omit<IDTokenClaims, 'iat' | 'exp'>,
  expiresIn: number
): Promise<string> {
  const algorithm = resolveIDTokenSigningAlgorithm(clientMetadata);
  const { privateKey, kid } = await getSigningKeyFromKeyManager(
    env,
    tenantId,
    undefined,
    algorithm
  );
  return createIDToken(claims, privateKey, kid, expiresIn, algorithm);
}

async function createClientSDJWTIDToken(
  env: Env,
  tenantId: string,
  clientMetadata: ClientMetadata,
  claims: Omit<IDTokenClaims, 'iat' | 'exp'>,
  expiresIn: number,
  selectiveClaims: string[]
): Promise<string> {
  const algorithm = resolveIDTokenSigningAlgorithm(clientMetadata);
  const { privateKey, kid } = await getSigningKeyFromKeyManager(
    env,
    tenantId,
    undefined,
    algorithm
  );
  return createSDJWTIDTokenFromClaims(
    claims,
    privateKey,
    kid,
    expiresIn,
    selectiveClaims,
    algorithm
  );
}

/**
 * Token Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#TokenEndpoint
 *
 * Exchanges authorization codes for ID tokens and access tokens
 * Also supports refresh token flow (RFC 6749 Section 6)
 */
export async function tokenHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TOKEN');

  // Verify Content-Type is application/x-www-form-urlencoded
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400
    );
  }

  // Parse form data
  let formData: Record<string, string>;
  let parsedBody: Record<string, string | File | (string | File)[]>;
  try {
    parsedBody = await c.req.parseBody();
    formData = Object.fromEntries(
      Object.entries(parsedBody).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : '',
      ])
    );
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Failed to parse request body',
      },
      400
    );
  }

  const grant_type = formData.grant_type;

  try {
    // Route to appropriate handler based on grant_type
    if (grant_type === 'refresh_token') {
      return await handleRefreshTokenGrant(c, formData);
    } else if (grant_type === 'authorization_code') {
      return await handleAuthorizationCodeGrant(c, formData);
    } else if (grant_type === DIRECT_AUTH_FINISH_GRANT_TYPE) {
      return await handleDirectAuthFinishGrant(c, formData);
    } else if (grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      return await handleJWTBearerGrant(c, formData);
    } else if (grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      return await handleDeviceCodeGrant(c, formData);
    } else if (grant_type === 'urn:openid:params:grant-type:ciba') {
      return await handleCIBAGrant(c, formData);
    } else if (grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') {
      // RFC 8693: Token Exchange (Feature Flag controlled)
      // Reuse the initially parsed body so multi-value params are preserved.
      return await handleTokenExchangeGrant(c, formData, parsedBody);
    } else if (grant_type === 'client_credentials') {
      // RFC 6749 Section 4.4: Client Credentials Grant
      return await handleClientCredentialsGrant(c, formData);
    }
  } catch (error) {
    if (error instanceof SecurityProfileSettingsUnavailableError) {
      log.error('Security profile settings unavailable', { grantType: grant_type });
      return oauthError(
        c,
        'temporarily_unavailable',
        'Security profile settings are temporarily unavailable',
        503
      );
    }
    throw error;
  }

  // If grant_type is not supported
  return c.json(
    {
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grant_type}' is not supported`,
    },
    400
  );
}

/**
 * Handle Direct Auth artifact redemption.
 *
 * Direct Auth is a headless authentication initiation layer; token issuance is
 * delegated to the canonical authorization-code issuance path after the
 * Direct Auth artifact binding is verified.
 */
async function handleDirectAuthFinishGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const log = getLogger(c).module('TOKEN');
  const directAuthArtifact = formData.direct_auth_artifact;
  const client_id = formData.client_id;
  const code_verifier = formData.code_verifier;
  const channel = formData.channel;
  const provider_id = formData.provider_id;

  if (!directAuthArtifact || !client_id || !code_verifier || !channel) {
    return oauthError(
      c,
      'invalid_request',
      'direct_auth_artifact, client_id, code_verifier, and channel are required',
      400
    );
  }

  if (!isDirectAuthChannel(channel)) {
    return oauthError(c, 'invalid_request', 'channel must be browser, native, or server', 400);
  }

  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  const challengeStore = await getChallengeStoreByChallengeId(
    c.env,
    directAuthArtifact,
    getTenantIdFromContext(c)
  );
  let artifactData: {
    challenge: string;
    userId: string;
    metadata?: Record<string, unknown>;
  };

  try {
    artifactData = (await challengeStore.consumeChallengeRpc({
      id: `direct_auth:${directAuthArtifact}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_auth_code',
    })) as typeof artifactData;
  } catch (error) {
    log.warn('Direct Auth artifact consume failed', {
      action: 'direct_auth_finish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return oauthError(c, 'invalid_grant', 'Direct Auth artifact is invalid or expired', 400);
  }

  const metadata = artifactData.metadata || {};
  if (metadata.client_id !== client_id) {
    return oauthError(c, 'invalid_grant', 'Direct Auth artifact client binding mismatch', 400);
  }

  if (metadata.channel !== channel) {
    return oauthError(c, 'invalid_grant', 'Direct Auth artifact channel binding mismatch', 400);
  }

  const allowedProviders = new Set<string>();
  for (const key of ['provider_id', 'provider_slug', 'provider']) {
    const value = metadata[key];
    if (typeof value === 'string' && value) {
      allowedProviders.add(value);
    }
  }
  if (allowedProviders.size > 0 && (!provider_id || !allowedProviders.has(provider_id))) {
    return oauthError(c, 'invalid_grant', 'Direct Auth artifact provider binding mismatch', 400);
  }

  const pkceValid = await verifyPKCE(code_verifier, artifactData.challenge);
  if (!pkceValid) {
    return oauthError(c, 'invalid_grant', 'Direct Auth artifact PKCE verification failed', 400);
  }

  return await handleAuthorizationCodeGrant(c, {
    ...formData,
    grant_type: 'authorization_code',
    code: directAuthArtifact,
    redirect_uri: DIRECT_AUTH_GRANT_REDIRECT_URI,
    client_id,
    code_verifier,
  });
}

/**
 * Handle Authorization Code Grant
 * https://openid.net/specs/openid-connect-core-1_0.html#TokenEndpoint
 */
async function handleAuthorizationCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const log = getLogger(c).module('TOKEN');
  const grant_type = formData.grant_type;
  const code = formData.code;
  const redirect_uri = formData.redirect_uri;
  const code_verifier = formData.code_verifier;

  // Extract client credentials from either form data or Authorization header
  // Supports client_secret_post, client_secret_basic, client_secret_jwt, and private_key_jwt
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication (private_key_jwt or client_secret_jwt)
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // Extract client_id from JWT assertion (from 'sub' or 'iss' claim)
    try {
      const assertionPayload = parseToken(client_assertion);

      // Per RFC 7523, the 'sub' claim should contain the client_id
      // If not present, fall back to 'iss' which also commonly contains the client_id
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      } else if (!client_id && assertionPayload.iss) {
        client_id = assertionPayload.iss as string;
      }

      // JWT assertion will be validated later against the client's registered public key
      // For now, we just extract the client_id to proceed with the flow
    } catch {
      return oauthError(c, 'invalid_client', 'Invalid client_assertion JWT format', 401);
    }
  }

  // Check for HTTP Basic authentication (client_secret_basic)
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    // Use Basic auth credentials if form data doesn't provide them
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate grant_type
  const grantTypeValidation = validateGrantType(grant_type);
  if (!grantTypeValidation.valid) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: grantTypeValidation.error,
      },
      400
    );
  }

  // Validate authorization code
  const codeValidation = validateAuthCode(code);
  if (!codeValidation.valid) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: codeValidation.error,
      },
      400
    );
  }

  // Type narrowing: code is guaranteed to be a string at this point
  const validCode: string = code;

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Validate redirect_uri
  const allowHttp = c.env.ENABLE_HTTP_REDIRECT === 'true';
  const redirectUriValidation = validateRedirectUri(redirect_uri, allowHttp);
  if (!redirectUriValidation.valid) {
    return oauthError(c, 'invalid_request', redirectUriValidation.error as string, 400);
  }

  // Fetch client metadata early (needed for FAPI/DPoP checks) - request-level cached
  const clientMetadata = await getClientCached(c, c.env, client_id);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Load TenantProfile for TTL limits (Human Auth / AI Ephemeral Auth two-layer model) - request-level cached
  const tenantId = (clientMetadata.tenant_id as string) || getTenantIdFromContext(c);
  const tenantProfile = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId);

  // DPoP requirement (FAPI 2.0 / sender-constrained tokens) - request-level cached
  let fapiRequiresDpop = false;
  try {
    const settings = await getSystemSettingsCached(c, c.env, { failOnError: true });
    if (settings) {
      const fapi = (settings.fapi || {}) as { enabled?: boolean; requireDpop?: boolean };
      // If FAPI is enabled, default to requiring DPoP unless explicitly disabled
      fapiRequiresDpop = Boolean(fapi.requireDpop || (fapi.enabled && fapi.requireDpop !== false));
    }
  } catch (error) {
    log.error('Failed to load FAPI settings for DPoP', {}, error as Error);
    throw new SecurityProfileSettingsUnavailableError();
  }

  // Client-level DPoP mode (disabled | critical_only | all)
  const clientDpopMode = (clientMetadata.dpop_mode as DPoPMode) || 'disabled';
  const clientDpopBoundTokens = Boolean(clientMetadata.dpop_bound_access_tokens);
  const requestPath = new URL(c.req.url).pathname;

  // Determine if DPoP is required for this specific request
  const clientRequiresDpop = isDPoPRequiredForRequest(
    clientDpopMode,
    requestPath,
    clientDpopBoundTokens
  );
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  const isBrowserPublicClientRequest = isBrowserPublicTokenRequest(c, formData, clientMetadata);
  const isNativePublicClientRequest = isNativePublicTokenRequest(formData, clientMetadata);
  const browserPublicClientMode = isBrowserPublicClientRequest
    ? await resolveBrowserPublicClientMode(c, tenantId, clientMetadata)
    : undefined;

  if (
    isBrowserPublicClientRequest &&
    (browserPublicClientMode === 'strict' || browserPublicClientMode === 'cookie_fallback') &&
    !dpopProof
  ) {
    return oauthError(
      c,
      'invalid_request',
      browserPublicClientMode === 'cookie_fallback'
        ? 'Browser public token requests require DPoP; use the hosted cookie-session finalize path for cookie fallback clients'
        : 'DPoP proof is required for strict browser clients',
      400
    );
  }

  if (isBrowserPublicClientRequest && browserPublicClientMode === 'legacy') {
    return oauthError(
      c,
      'invalid_request',
      'Legacy browser public token mode is no longer supported; use DPoP strict mode or the hosted cookie-session finalize path',
      400
    );
  }

  if (isNativePublicClientRequest && !dpopProof) {
    return oauthError(
      c,
      'invalid_request',
      'DPoP proof is required for native public clients',
      400
    );
  }

  if ((fapiRequiresDpop || clientRequiresDpop) && !dpopProof) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  // Validate DPoP proof early to get jkt for authorization code binding verification
  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined, // No access token yet
      c.env, // Pass full Env for region-aware sharding
      client_id,
      getTenantIdFromContext(c)
    );

    if (!dpopValidation.valid) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'Invalid DPoP proof',
        clientMetadata,
        resources: formData.resource ? [formData.resource] : undefined,
      });
    }

    dpopJkt = dpopValidation.jkt;
  }

  // Authenticate the client before atomically consuming the authorization code. Otherwise an
  // attacker with a leaked code could invalidate it using deliberately bad client credentials.
  const clientAuthenticationPolicy = await resolveTokenClientAuthenticationPolicy(
    c,
    clientMetadata as unknown as ClientMetadata,
    client_assertion,
    client_assertion_type
  );
  if (!clientAuthenticationPolicy.ok) {
    return clientAuthenticationPolicy.response;
  }
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${getRequestIssuer(c)}/token`,
      clientMetadata as unknown as ClientMetadata,
      clientAuthenticationPolicy.assertionOptions
    );

    if (!assertionValidation.valid) {
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(
        c,
        assertionValidation.error || 'invalid_client',
        'Client assertion validation failed',
        401
      );
    }
  } else if (clientMetadata.client_secret_hash) {
    const storedHash = (clientMetadata.client_secret_hash as string) ?? '';
    if (!client_secret || !(await verifyClientSecretHash(client_secret, storedHash))) {
      return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
    }
  } else if (!isPublicClientMetadata(clientMetadata as ClientMetadata)) {
    return oauthError(c, 'invalid_client', 'Client authentication configuration is invalid', 401);
  }

  // Consume authorization code using AuthorizationCodeStore Durable Object
  // This replaces KV-based getAuthCode() with strong consistency guarantees
  // Parse shard index from code to route to the correct DO instance
  const shardInfo = parseShardedAuthCode(validCode);
  let authCodeStoreId: DurableObjectId;
  let authCodeStoreInstanceName: string;
  let currentShardCount: number | undefined;
  let actualShardIndex: number | undefined;

  if (shardInfo) {
    // Get current shard count (KV priority, with caching)
    currentShardCount = await getShardCount(c.env);

    // Remap shard index for scale-down compatibility
    actualShardIndex = remapShardIndex(shardInfo.shardIndex, currentShardCount);

    // Log remapping for monitoring (only when remapped)
    if (actualShardIndex !== shardInfo.shardIndex) {
      log.debug('Remapped auth code shard', {
        originalShard: shardInfo.shardIndex,
        actualShard: actualShardIndex,
        currentShardCount,
        action: 'AuthCode',
      });
    }

    authCodeStoreInstanceName = buildAuthCodeShardInstanceName(
      actualShardIndex,
      getTenantIdFromContext(c)
    );
    authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(authCodeStoreInstanceName);
  } else {
    // Legacy format (no shard prefix) - use tenant-scoped legacy instance
    authCodeStoreInstanceName = buildDOInstanceName('auth-code', getTenantIdFromContext(c));
    authCodeStoreId = c.env.AUTH_CODE_STORE.idFromName(authCodeStoreInstanceName);
  }
  const authCodeStore = c.env.AUTH_CODE_STORE.get(authCodeStoreId);
  log.info('Consuming authorization code', {
    action: 'AuthCode',
    tenantId: getTenantIdFromContext(c),
    clientId: client_id,
    requestedShard: shardInfo?.shardIndex,
    actualShard: actualShardIndex,
    currentShardCount,
    instanceName: authCodeStoreInstanceName,
    codePrefix: shardInfo ? String(shardInfo.shardIndex) : 'legacy',
  });

  let authCodeData;
  try {
    // Use RPC for auth code consumption (atomic single-use guarantee)
    const consumedData = (await authCodeStore.consumeCodeRpc({
      code: validCode,
      tenantId: getTenantIdFromContext(c),
      clientId: client_id,
      codeVerifier: code_verifier,
      expectedAuthorizationServer: 'default',
      expectedSubjectType: 'end_user',
    })) as AuthCodeStoreResponse;

    // RFC 6749 Section 4.1.2: Handle replay attack detection
    // If authorization code was already used, revoke previously issued tokens
    if (consumedData.replayAttack) {
      log.warn('Authorization code replay attack detected, revoking previously issued tokens', {
        action: 'Security',
      });

      const { accessTokenJti, refreshTokenJti } = consumedData.replayAttack;

      // Revoke the access token that was issued when the code was first used
      if (accessTokenJti) {
        try {
          await revokeToken(
            c.env,
            accessTokenJti,
            3600,
            'Authorization code replay attack',
            getTenantIdFromContext(c)
          );
          log.info('Revoked access token', {
            jtiPrefix: accessTokenJti.substring(0, 8),
            action: 'Security',
          });
        } catch (revokeError) {
          log.error('Failed to revoke access token', { action: 'Security' }, revokeError as Error);
        }
      }

      // Revoke the refresh token that was issued when the code was first used
      if (refreshTokenJti) {
        try {
          await revokeToken(
            c.env,
            refreshTokenJti,
            86400 * 30, // 30 days
            'Authorization code replay attack',
            getTenantIdFromContext(c)
          );
          log.info('Revoked refresh token', {
            jtiPrefix: refreshTokenJti.substring(0, 8),
            action: 'Security',
          });
        } catch (revokeError) {
          log.error('Failed to revoke refresh token', { action: 'Security' }, revokeError as Error);
        }
      }

      // Return error to the attacker - use generic message to avoid confirming code existence
      return oauthError(
        c,
        'invalid_grant',
        'The provided authorization grant is invalid, expired, or revoked',
        400
      );
    }

    // Map AuthCodeStore DO response to expected format
    authCodeData = {
      sub: consumedData.userId, // Map userId to sub for JWT claims
      scope: consumedData.scope,
      redirect_uri: consumedData.redirectUri, // Keep for compatibility
      nonce: consumedData.nonce,
      state: consumedData.state,
      auth_time: consumedData.authTime || Math.floor(Date.now() / 1000), // OIDC Core: Time when End-User authentication occurred
      acr: consumedData.acr, // OIDC Core: Authentication Context Class Reference
      amr: Array.isArray(consumedData.amr)
        ? consumedData.amr.filter((method): method is string => typeof method === 'string')
        : undefined, // OIDC Core: Authentication Methods References
      claims: consumedData.claims,
      claimsRequestProtected: consumedData.claimsRequestProtected === true,
      dpopJkt: consumedData.dpopJkt, // DPoP JWK thumbprint for binding verification
      sid: consumedData.sid, // OIDC Session Management: Session ID for RP-Initiated Logout
      authorizationDetails: consumedData.authorizationDetails, // RFC 9396: Rich Authorization Requests
    };
  } catch (error) {
    // RPC throws error for invalid codes (not found, already consumed, PKCE mismatch, client mismatch)
    log.error(
      'AuthCodeStore consume error',
      {
        action: 'AuthCode',
        tenantId: getTenantIdFromContext(c),
        clientId: client_id,
        requestedShard: shardInfo?.shardIndex,
        actualShard: actualShardIndex,
        currentShardCount,
        instanceName: authCodeStoreInstanceName,
      },
      error as Error
    );
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Determine appropriate error type based on error message
    // Security: Use generic message to avoid information leakage
    if (errorMessage.includes('already consumed') || errorMessage.includes('replay')) {
      return oauthError(
        c,
        'invalid_grant',
        'The provided authorization grant is invalid, expired, or revoked',
        400
      );
    }

    return oauthError(c, 'invalid_grant', 'Authorization code is invalid or expired', 400);
  }

  // Verify redirect_uri matches (additional safety check)
  if (authCodeData.redirect_uri !== redirect_uri) {
    return oauthError(
      c,
      'invalid_grant',
      'redirect_uri does not match the one used in authorization request',
      400
    );
  }

  // DPoP Authorization Code Binding verification (RFC 9449)
  // If the authorization code was bound to a DPoP key, verify the same key is used
  if (authCodeData.dpopJkt) {
    // Authorization code is bound to a DPoP key, DPoP proof is required
    if (!dpopProof) {
      log.warn('Authorization code bound to DPoP key but no DPoP proof provided', {
        action: 'DPoP',
      });
      return oauthError(
        c,
        'invalid_grant',
        'DPoP proof required (authorization code is bound to DPoP key)',
        400
      );
    }

    // Verify the DPoP proof's jkt matches the stored jkt
    if (dpopJkt !== authCodeData.dpopJkt) {
      log.warn('DPoP key mismatch', {
        expected: authCodeData.dpopJkt,
        received: dpopJkt,
        action: 'DPoP',
      });
      return oauthError(
        c,
        'invalid_grant',
        'DPoP key mismatch (authorization code is bound to different key)',
        400
      );
    }

    log.debug('Authorization code binding verified successfully', { action: 'DPoP' });
  }

  // Load private key for signing tokens from KeyManager
  // NOTE: Key loading moved BEFORE code deletion to avoid losing code on key loading failure
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

  // DPoP support (RFC 9449)
  // dpopJkt was already validated earlier for authorization code binding verification
  const tokenType: 'Bearer' | 'DPoP' = dpopProof ? 'DPoP' : 'Bearer';

  // Note: For Authorization Code Flow (response_type=code), scope-based claims
  // (profile, email, etc.) should be returned from the UserInfo endpoint, NOT in the ID token.
  // Only response_type=id_token (Implicit Flow) should include these claims in the ID token.
  // See OpenID Connect Core 5.4: "The Claims requested by the profile, email, address, and
  // phone scope values are returned from the UserInfo Endpoint"
  const authCtx = createAuthContextFromHono(c, tenantId);
  const parsedClaimsRequest = parseClaimsRequest(authCodeData.claims);
  if (!parsedClaimsRequest.ok) {
    return oauthError(c, parsedClaimsRequest.error, parsedClaimsRequest.error_description, 400);
  }

  const tokenPIIRequirement = resolveOIDCPIIRequirement({
    scopes: authCodeData.scope,
    claimsRequest: parsedClaimsRequest.request,
    targets: ['userinfo', 'id_token'],
  });
  try {
    const subjectAccount = await findCanonicalRuntimeAccount(
      authCtx.coreAdapter,
      tenantId,
      authCodeData.sub
    );
    if (!subjectAccount && tokenPIIRequirement.requiresPII) {
      const piiAccess = canIssueTokenWithPIIStatus('failed', {
        requiresPII: tokenPIIRequirement.requiresPII,
      });
      if (!piiAccess.ok) {
        return oauthError(c, piiAccess.error, piiAccess.error_description, 400);
      }
    }
  } catch (piiStatusError) {
    log.error(
      'Failed to evaluate subject PII status for token issuance',
      {},
      piiStatusError as Error
    );
    if (tokenPIIRequirement.requiresPII) {
      return oauthError(
        c,
        'temporarily_unavailable',
        'Requested claims require PII that is not currently available',
        400
      );
    }
  }

  // Phase 1 RBAC: Fetch RBAC claims for tokens
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  const tenantRBACClaimsConfig = await resolveTenantRBACClaimsConfig(c.env, tenantId);
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(authCtx.coreAdapter, authCodeData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.accessToken,
        tenantId,
      }),
      getIDTokenRBACClaims(authCtx.coreAdapter, authCodeData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.idToken,
        tenantId,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    log.error('Failed to fetch RBAC claims', {}, rbacError as Error);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  let policyEmbeddingScopedPermissions: AccessTokenScopedPermission[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && authCodeData.scope) {
      const policyEmbedding = await evaluatePermissionEmbeddingForScope(
        authCtx.coreAdapter,
        authCodeData.sub,
        authCodeData.scope,
        { cache: c.env.REBAC_CACHE, tenantId }
      );
      policyEmbeddingPermissions = policyEmbedding.permissions;
      policyEmbeddingScopedPermissions = policyEmbedding.scopedPermissions;
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    log.error('Failed to evaluate policy permissions', {}, policyError as Error);
  }

  // Phase 8.2: ID-level Resource Permissions
  let idLevelPermissions: string[] = [];
  try {
    const idLevelEnabled = await isIdLevelPermissionsEnabled(c.env);
    if (idLevelEnabled) {
      const limits = await getEmbeddingLimits(c.env);
      const allIdPerms = await evaluateIdLevelPermissions(
        authCtx.coreAdapter,
        authCodeData.sub,
        tenantId,
        { cache: c.env.REBAC_CACHE }
      );
      // Apply limits to prevent token bloat
      if (allIdPerms.length > limits.max_resource_permissions) {
        log.warn('ID-level permissions truncated', {
          original: allIdPerms.length,
          truncated: limits.max_resource_permissions,
          action: 'TOKEN_BLOAT',
        });
        idLevelPermissions = allIdPerms.slice(0, limits.max_resource_permissions);
      } else {
        idLevelPermissions = allIdPerms;
      }
    }
  } catch (idLevelError) {
    // Log but don't fail - ID-level permissions are optional
    log.error('Failed to evaluate ID-level permissions', {}, idLevelError as Error);
  }

  // Anonymous user claims (architecture-decisions.md §17)
  let anonymousClaims: { user_type?: string; upgrade_eligible?: boolean } = {};
  try {
    const userAccount = await findCanonicalRuntimeAccount(
      authCtx.coreAdapter,
      tenantId,
      authCodeData.sub
    );
    if (userAccount?.account_type === 'anonymous') {
      anonymousClaims = {
        user_type: 'anonymous',
        upgrade_eligible: true, // Anonymous users can always upgrade
      };
    }
  } catch (anonError) {
    // Log but don't fail - anonymous claims are optional
    log.error('Failed to fetch anonymous user claims', {}, anonError as Error);
  }

  // Phase 8.2: Custom Claims Evaluation
  let customClaims: Record<string, unknown> = {};
  try {
    const customClaimsEnabled = await isCustomClaimsEnabled(c.env);
    if (customClaimsEnabled) {
      const limits = await getEmbeddingLimits(c.env);
      const evaluator = createTokenClaimEvaluator(authCtx.coreAdapter, c.env.REBAC_CACHE, {
        maxCustomClaims: limits.max_custom_claims,
      });

      // Build evaluation context
      const claimContext: TokenClaimEvaluationContext = {
        tenant_id: getTenantIdFromContext(c),
        subject_id: authCodeData.sub,
        client_id: client_id,
        scope: authCodeData.scope || '',
        roles: accessTokenRBACClaims.authrim_roles || [],
        permissions: policyEmbeddingPermissions,
        org_id: accessTokenRBACClaims.authrim_org_id,
        org_type: accessTokenRBACClaims.authrim_org_type,
      };

      // Evaluate for access token
      const result = await evaluator.evaluate(claimContext, 'access');
      customClaims = result.claims_to_add;

      // Log overrides for audit
      if (result.claim_overrides.length > 0) {
        log.info('Claim overrides occurred', {
          overrideCount: result.claim_overrides.length,
          userId: authCodeData.sub,
          action: 'CUSTOM_CLAIMS',
        });
      }
    }
  } catch (customClaimsError) {
    // Log but don't fail - custom claims are optional
    log.error('Failed to evaluate custom claims', {}, customClaimsError as Error);
  }

  const audienceResolution = resolveAccessTokenAudience(c, clientMetadata, {
    resource: formData.resource,
    audience: formData.audience,
    rejectResourceAudienceMismatch: true,
  });
  if (!audienceResolution.ok) {
    return oauthError(c, 'invalid_target', audienceResolution.description, 400);
  }

  // Generate Access Token FIRST (needed for at_hash in ID token)
  const accessTokenClaims: {
    iss: string;
    sub: string;
    aud: AccessTokenAudience;
    scope: string;
    client_id: string;
    claims?: string;
    claims_request_protected?: boolean;
    cnf?: { jkt: string };
    // Phase 1 RBAC claims
    authrim_roles?: string[];
    authrim_org_id?: string;
    authrim_org_type?: string;
    // Phase 2 Policy Embedding (type-level permissions)
    authrim_permissions?: string[];
    authrim_scoped_permissions?: AccessTokenScopedPermission[];
    // Phase 8.2: ID-level Resource Permissions
    authrim_resource_permissions?: string[];
    // Phase 8.2: Custom Claims (dynamic via [key: string]: unknown)
    [key: string]: unknown;
  } = {
    iss: getRequestIssuer(c),
    sub: authCodeData.sub,
    aud: audienceResolution.audience,
    scope: authCodeData.scope,
    client_id: client_id,
    // Phase 1 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
    // Phase 8.2: Add custom claims from rule evaluation
    ...customClaims,
    // Anonymous user claims (architecture-decisions.md §17)
    ...anonymousClaims,
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }
  if (policyEmbeddingScopedPermissions.length > 0) {
    accessTokenClaims.authrim_scoped_permissions = policyEmbeddingScopedPermissions;
  }

  // Phase 8.2: Add ID-level resource permissions
  if (idLevelPermissions.length > 0) {
    accessTokenClaims.authrim_resource_permissions = idLevelPermissions;
  }

  // Add claims parameter if it was requested during authorization
  if (authCodeData.claims) {
    accessTokenClaims.claims = authCodeData.claims;
    accessTokenClaims.claims_request_protected = authCodeData.claimsRequestProtected === true;
  }

  // Add DPoP confirmation (cnf) claim if DPoP is used
  if (dpopJkt) {
    accessTokenClaims.cnf = { jkt: dpopJkt };
  }

  // RFC 9396: Add authorization_details to access token if present
  if (authCodeData.authorizationDetails) {
    try {
      accessTokenClaims.authorization_details = JSON.parse(authCodeData.authorizationDetails);
    } catch {
      log.warn('Failed to parse authorization_details for access token', { action: 'RAR' });
    }
  }

  let accessToken: string;
  let tokenJti: string;
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    tokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Calculate at_hash for ID Token
  // https://openid.net/specs/openid-connect-core-1_0.html#CodeIDToken
  let atHash: string;
  try {
    atHash = await calculateAtHash(accessToken);
  } catch (error) {
    log.error('Failed to calculate at_hash', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to calculate token hash',
      },
      500
    );
  }

  // ===== OIDC Native SSO 1.0 (draft-07) =====
  // Generate device_secret for mobile/desktop SSO scenarios
  // The device_secret is returned only once and must be stored securely by the client
  // (e.g., iOS Keychain, Android Keystore)
  let deviceSecret: string | undefined;
  let dsHash: string | undefined;
  let issuedDeviceSecretEntity: DeviceSecret | undefined;

  // Check if Native SSO is enabled (feature flag + client configuration)
  const nativeSSOGloballyEnabled = await isNativeSSOEnabled(c.env);
  const clientNativeSSOIssuanceEligible = isNativeSSOIssuanceEligible(
    clientMetadata,
    formData.channel
  );

  if (nativeSSOGloballyEnabled && clientNativeSSOIssuanceEligible && authCodeData.sid) {
    try {
      const nativeSSOConfig = await getNativeSSOConfig(c.env);
      const deviceSecretRepo = new DeviceSecretRepository(authCtx.coreAdapter, tenantId);
      const deviceInstallationRepo = new DeviceInstallationRepository(
        authCtx.coreAdapter,
        tenantId
      );

      // Check max device secrets per user (revoke oldest if exceeded)
      const userSecrets = await deviceSecretRepo.findByUserId(authCodeData.sub, tenantId);
      let activeSecrets = userSecrets.filter((s) => s.is_active === 1);

      if (
        nativeSSOConfig.deviceSecretRotationPolicy === 'explicit' &&
        nativeSSOConfig.deviceSecretRotationOverlapSeconds === 0
      ) {
        const rotationCandidates = activeSecrets.filter(
          (secret) => secret.session_id === authCodeData.sid && secret.revoked_at === undefined
        );

        for (const secret of rotationCandidates) {
          await deviceSecretRepo.revoke(secret.id, 'rotation', tenantId);
        }

        if (rotationCandidates.length > 0) {
          const rotatedSecretIds = new Set(rotationCandidates.map((secret) => secret.id));
          activeSecrets = activeSecrets.filter((secret) => !rotatedSecretIds.has(secret.id));
          log.info('Rotated existing device secrets', {
            count: rotationCandidates.length,
            userIdPrefix: authCodeData.sub.substring(0, 8),
            sessionIdPrefix: authCodeData.sid.substring(0, 8),
            action: 'NativeSSO',
          });
        }
      }

      if (activeSecrets.length >= nativeSSOConfig.maxDeviceSecretsPerUser) {
        if (nativeSSOConfig.maxSecretsBehavior === 'revoke_oldest') {
          // Revoke oldest secrets to make room
          const sortedByCreation = activeSecrets.sort((a, b) => a.created_at - b.created_at);
          const toRevoke = sortedByCreation.slice(
            0,
            activeSecrets.length - nativeSSOConfig.maxDeviceSecretsPerUser + 1
          );
          for (const secret of toRevoke) {
            await deviceSecretRepo.revoke(secret.id, 'max_secrets_exceeded', tenantId);
          }
          log.info('Revoked oldest device secrets', {
            count: toRevoke.length,
            userIdPrefix: authCodeData.sub.substring(0, 8),
            action: 'NativeSSO',
          });
        } else {
          // Reject mode: do not issue new device_secret
          log.warn('Max device secrets reached, rejecting new secret', {
            userIdPrefix: authCodeData.sub.substring(0, 8),
            action: 'NativeSSO',
          });
          // Continue without issuing device_secret (not a fatal error)
        }
      }

      // Only create if we have room (after potential revocation) or if revoke_oldest was used
      const canCreate =
        nativeSSOConfig.maxSecretsBehavior === 'revoke_oldest' ||
        activeSecrets.length < nativeSSOConfig.maxDeviceSecretsPerUser;

      if (canCreate) {
        // Create new device secret
        const deviceSecretTTLMs = nativeSSOConfig.deviceSecretTTLDays * 24 * 60 * 60 * 1000;
        const result = await deviceSecretRepo.createSecret({
          user_id: authCodeData.sub,
          session_id: authCodeData.sid,
          client_id,
          trust_group_id: getClientTrustGroup(clientMetadata),
          device_name: normalizeDeviceSecretName(formData.device_name),
          device_platform: normalizeDeviceSecretPlatform(formData.device_platform),
          ttl_ms: deviceSecretTTLMs,
        });

        // Check if creation was successful (result has 'secret' property)
        // CreateDeviceSecretResult has { secret, entity }
        // DeviceSecretValidationResult has { ok: false, reason: ... } or { ok: true, entity: ... }
        if ('secret' in result) {
          deviceSecret = result.secret;
          issuedDeviceSecretEntity = result.entity;

          // Calculate ds_hash (same algorithm as at_hash: SHA-256 left-half base64url)
          dsHash = await calculateDsHash(deviceSecret);
          await deviceInstallationRepo.ensureForDeviceSecret(result.entity);

          log.info('Created device secret', {
            userIdPrefix: authCodeData.sub.substring(0, 8),
            sessionIdPrefix: authCodeData.sid.substring(0, 8),
            expiresInDays: nativeSSOConfig.deviceSecretTTLDays,
            action: 'NativeSSO',
          });
        } else if ('ok' in result && result.ok === false) {
          // Creation failed (likely limit_exceeded)
          log.warn('Device secret creation returned failure', {
            reason: result.reason,
            action: 'NativeSSO',
          });
        }
      }
    } catch (error) {
      // Log error but don't fail the token request - Native SSO is a convenience feature
      log.error('Failed to create device secret', { action: 'NativeSSO' }, error as Error);
      // deviceSecret and dsHash remain undefined
    }
  }

  // Custom Claim Schema: resolve claims for ID Token
  let idTokenCustomClaims: Record<string, unknown> = {};
  try {
    const ccFeatureConfig = await loadFeatureConfig(c.env.AUTHRIM_CONFIG || null);
    if (ccFeatureConfig.enabled) {
      const ccSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
      const ccResolver = createCustomClaimSchemaResolverFromSources({
        schemaDb: ccSources.schemaDb,
        nonPiiDb: ccSources.nonPiiDb,
        piiDb: ccSources.piiDb,
        cache: c.env.AUTHRIM_CONFIG || null,
        featureConfig: ccFeatureConfig,
      });
      const ccScopes = (authCodeData.scope || '').split(' ').filter(Boolean);
      const ccResult = await ccResolver.resolveClaimsForTarget(
        tenantId,
        authCodeData.sub,
        ccScopes,
        'id_token'
      );
      idTokenCustomClaims = ccResult.claims;
    }
  } catch (ccError) {
    log.error('Failed to resolve custom claims for ID token', {}, ccError as Error);
  }

  // Generate ID Token with at_hash and auth_time
  // Phase 1 RBAC: Include RBAC claims in ID Token
  // Note: sid is required for RP-Initiated Logout per OIDC Session Management 1.0
  // Note: ds_hash is included when Native SSO is enabled (OIDC Native SSO 1.0)
  let idTokenClaims: Record<string, unknown> = {
    ...idTokenCustomClaims, // Custom claims (first, so standard claims override on collision)
    iss: getRequestIssuer(c),
    sub: authCodeData.sub,
    aud: client_id,
    nonce: authCodeData.nonce,
    at_hash: atHash, // OIDC spec requirement for code flow
    auth_time: authCodeData.auth_time, // OIDC Core Section 2: Time when End-User authentication occurred
    ...(authCodeData.acr && { acr: authCodeData.acr }),
    ...(authCodeData.amr?.length && { amr: authCodeData.amr }),
    ...(authCodeData.sid && { sid: authCodeData.sid }), // OIDC Session Management: Session ID for RP-Initiated Logout
    ...(dsHash && { ds_hash: dsHash }), // OIDC Native SSO 1.0: Device Secret Hash
    // Phase 1 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
    // Anonymous user claims (architecture-decisions.md §17)
    ...anonymousClaims,
  };

  const shouldEvaluateIdTokenClaims =
    parsedClaimsRequest.request &&
    (Object.keys(parsedClaimsRequest.request.id_token).length > 0 ||
      hasSAORulesForTarget(parsedClaimsRequest.request, 'id_token'));

  if (shouldEvaluateIdTokenClaims && parsedClaimsRequest.request) {
    try {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const user = await loadOIDCClaimsUser(c, tenantId, authCodeData.sub, piiCtx);
      const availableClaims: Record<string, unknown> = {
        ...(user ? buildStandardUserClaims(user) : {}),
        sub: authCodeData.sub,
        auth_time: authCodeData.auth_time,
        ...(authCodeData.acr ? { acr: authCodeData.acr } : {}),
        ...(authCodeData.amr?.length ? { amr: authCodeData.amr } : {}),
      };
      const requestedIdTokenClaims = evaluateClaimsForTarget({
        target: 'id_token',
        claimsRequest: parsedClaimsRequest.request,
        initialClaims: idTokenClaims,
        availableClaims,
        grantedScopes: (authCodeData.scope || '').split(' ').filter(Boolean),
        clientPolicy: clientMetadata,
        includeScopeClaims: false,
        requestIntegrityProtected: authCodeData.claimsRequestProtected === true,
      });
      if (!requestedIdTokenClaims.ok) {
        return oauthError(
          c,
          requestedIdTokenClaims.error,
          requestedIdTokenClaims.error_description,
          400
        );
      }
      idTokenClaims = requestedIdTokenClaims.claims;
    } catch (claimsError) {
      log.error('Failed to evaluate requested ID token claims', {}, claimsError as Error);
      return oauthError(c, 'server_error', 'Failed to evaluate requested ID token claims', 500);
    }
  }

  const mappedIdTokenClaims = await applyOIDCIdentityMappingToIDTokenClaims(
    c,
    tenantId,
    client_id,
    clientMetadata as ClientMetadata,
    idTokenClaims,
    splitScope(authCodeData.scope)
  );
  if (!mappedIdTokenClaims.ok) {
    return mappedIdTokenClaims.response;
  }
  idTokenClaims = mappedIdTokenClaims.claims;

  const idTokenConsent = await enforceOIDCAttributeReleaseConsentForIDTokenClaims(
    c,
    tenantId,
    clientMetadata as ClientMetadata,
    idTokenClaims
  );
  if (!idTokenConsent.ok) {
    return idTokenConsent.response;
  }

  let idToken: string;
  try {
    // Check if client requests SD-JWT ID Token (RFC 9901)
    const useSDJWT =
      clientMetadata.id_token_signed_response_type === 'sd-jwt' && c.env.ENABLE_SD_JWT === 'true';

    if (useSDJWT) {
      // Create SD-JWT ID Token with selective disclosure
      const rawSelectiveClaims = clientMetadata.sd_jwt_selective_claims;
      const selectiveClaims: string[] = Array.isArray(rawSelectiveClaims)
        ? rawSelectiveClaims
        : ['email', 'phone_number', 'address', 'birthdate'];
      idToken = await createClientSDJWTIDToken(
        c.env,
        tenantId,
        clientMetadata as ClientMetadata,
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        expiresIn,
        selectiveClaims
      );
      log.debug('Created SD-JWT ID Token', { clientId: client_id, action: 'SD-JWT' });
    } else {
      // For Authorization Code Flow, ID token should only contain standard claims
      // Scope-based claims (profile, email) are returned from UserInfo endpoint
      idToken = await createClientIDToken(
        c.env,
        tenantId,
        clientMetadata as ClientMetadata,
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        expiresIn
      );
    }

    // JWE: Check if client requires ID token encryption (RFC 7516)
    // Note: SD-JWT can also be encrypted (nested: SD-JWT inside JWE)
    // Note: clientMetadata was already fetched during client authentication above
    if (isIDTokenEncryptionRequired(clientMetadata)) {
      const alg = clientMetadata.id_token_encrypted_response_alg as string;
      const enc = clientMetadata.id_token_encrypted_response_enc as string;

      // Validate encryption algorithms
      try {
        validateJWEOptions(alg, enc);
      } catch (validationError) {
        // Security: Log internal details but return generic message to prevent information leakage
        log.error('Invalid JWE options', { validationError });
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: 'Client encryption configuration is invalid',
          },
          400
        );
      }

      // Get client's public key for encryption
      const publicKey = await getClientPublicKey(clientMetadata, undefined, alg as JWEAlgorithm);
      if (!publicKey) {
        log.error('Client requires encryption but no public key available', {});
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description:
              'Client requires ID token encryption but no public key (jwks or jwks_uri) is configured',
          },
          400
        );
      }

      // Encrypt the signed ID token (nested JWT: JWS inside JWE)
      try {
        idToken = await encryptJWT(idToken, publicKey, {
          alg: alg as JWEAlgorithm,
          enc: enc as JWEEncryption,
          cty: 'JWT', // Content type is JWT (the signed ID token)
          kid: publicKey.kid,
        });
      } catch (encryptError) {
        log.error('Failed to encrypt ID token', {}, encryptError as Error);
        return c.json(
          {
            error: 'server_error',
            error_description: 'Failed to encrypt ID token',
          },
          500
        );
      }
    }
  } catch (error) {
    log.error('Failed to create ID token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Generate Refresh Token
  // https://tools.ietf.org/html/rfc6749#section-6
  const browserRefreshTokenPolicy = getBrowserRefreshTokenPolicy(clientMetadata);
  const shouldIssueRefreshToken =
    !isBrowserPublicClientRequest ||
    (browserRefreshTokenPolicy === 'dpop_bound' && tokenType === 'DPoP' && Boolean(dpopJkt));
  let refreshToken: string | undefined;
  let refreshTokenJti: string | undefined;
  let refreshTokenExpiresIn: number | undefined;

  if (shouldIssueRefreshToken) {
    refreshTokenExpiresIn = await configManager.getRefreshTokenExpiry();

    try {
      const refreshTokenClaims = {
        iss: getRequestIssuer(c),
        sub: authCodeData.sub,
        aud: client_id,
        scope: authCodeData.scope,
        client_id: client_id,
        resource_aud: audienceResolution.audience,
        ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
      };

      // V2/V3: Register with RefreshTokenRotator first to get version
      // V3: Uses sharded DO instances for horizontal scaling
      let rtv: number = 1; // Default version for new family
      let familyResult: Awaited<ReturnType<typeof createRefreshTokenFamily>> | undefined;

      if (c.env.REFRESH_TOKEN_ROTATOR) {
        try {
          familyResult = await createRefreshTokenFamily(c.env, {
            userId: authCodeData.sub,
            clientId: client_id,
            scope: authCodeData.scope,
            ttl: refreshTokenExpiresIn,
            tenantId: getTenantIdFromContext(c),
            resourceAudience: audienceResolution.audience,
          });
          refreshTokenJti = familyResult.jti;
        } catch (error) {
          log.error('Failed to register refresh token family', {}, error as Error);
          return c.json(
            {
              error: 'server_error',
              error_description: 'Failed to register refresh token',
            },
            500
          );
        }
        rtv = familyResult.family.version;

        // V3: Record in the token family index for user-wide revocation support
        // (non-blocking, fire-and-forget for performance)
        void recordTokenFamilyIndex(
          authCtx.coreAdapter,
          getTenantIdFromContext(c),
          refreshTokenJti,
          authCodeData.sub,
          client_id,
          familyResult.resolution.generation,
          refreshTokenExpiresIn
        );
      } else {
        refreshTokenJti = `rt_${crypto.randomUUID()}`;
      }

      // Create JWT with rtv (Refresh Token Version) claim
      const result = await createRefreshToken(
        refreshTokenClaims,
        privateKey,
        keyId,
        refreshTokenExpiresIn,
        refreshTokenJti,
        rtv // V2: Include version for theft detection
      );
      refreshToken = result.token;
      // V2: Family is already registered via RefreshTokenRotator DO above
      // No need to call storeRefreshToken() - it was a V1 artifact
    } catch (error) {
      log.error('Failed to create refresh token', {}, error as Error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create refresh token',
        },
        500
      );
    }
  } else {
    log.debug('Skipped refresh token for browser public client policy', {
      clientId: client_id,
      browserPublicClientMode,
      browserRefreshTokenPolicy,
      tokenType,
      action: 'TokenIssuance',
    });
  }

  // Authorization code has been consumed and marked as used by AuthCodeStore DO
  // Per RFC 6749 Section 4.1.2: Authorization codes are single-use
  // The DO guarantees atomic consumption and replay attack detection
  //
  // RFC 6749 Section 4.1.2: Register issued token JTIs for replay attack revocation
  // "If an authorization code is used more than once, the authorization server
  //  MUST deny the request and SHOULD revoke (when possible) all tokens
  //  previously issued based on that authorization code."
  //
  // This registration enables token revocation when a replay attack is detected.
  // The additional DO hop is acceptable as it's required for OIDC Conformance.
  try {
    await authCodeStore.registerIssuedTokensRpc(validCode, tokenJti, refreshTokenJti);
  } catch (error) {
    // Log but don't fail the request - token issuance succeeded
    // This is a "SHOULD" requirement, not a "MUST"
    log.error(
      'Failed to register token JTIs for replay attack revocation',
      { action: 'RFC6749-4.1.2' },
      error as Error
    );
  }

  // OIDC Session Management: Register session-client association for logout
  // This enables frontchannel/backchannel logout to notify the correct RPs
  log.debug('Session-client check', {
    sidPresent: !!authCodeData.sid,
    dbPresent: !!authCtx.coreAdapter,
    action: 'Logout',
  });
  if (authCodeData.sid) {
    try {
      log.debug('Attempting to register session-client', {
        sid: authCodeData.sid,
        clientId: client_id,
        action: 'Logout',
      });
      const mirrorMode =
        getRuntimeUserStoreSourcesFromHonoContext(c)?.storageProfile.transientAuth
          ?.sessionClientMirror ?? 'async';
      const registrationInput = {
        session_id: authCodeData.sid,
        client_id: client_id,
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
            id: result.id,
            sidPrefix: authCodeData.sid?.substring(0, 25),
            clientIdPrefix: client_id.substring(0, 25),
            action: 'Logout',
          });
        })
        .catch((error) => {
          log.error(
            'Failed to register session-client in DO',
            { action: 'Logout' },
            error as Error
          );
        });
      const mirrorPromise =
        mirrorMode === 'disabled'
          ? Promise.resolve()
          : authCtx.repositories.sessionClient
              .createOrUpdate(registrationInput)
              .then((result) => {
                log.debug('Successfully mirrored session-client', {
                  id: result.id,
                  sidPrefix: authCodeData.sid?.substring(0, 25),
                  clientIdPrefix: client_id.substring(0, 25),
                  action: 'Logout',
                });
              })
              .catch((error) => {
                // Log error but don't fail the token request - logout tracking is non-critical
                log.error('Failed to mirror session-client', { action: 'Logout' }, error as Error);
              });
      const registrationPromise = Promise.all([storeRegistrationPromise, mirrorPromise]).then(
        () => undefined
      );

      if (mirrorMode === 'sync') {
        await registrationPromise;
      } else {
        c.executionCtx?.waitUntil(registrationPromise);
      }
    } catch (error) {
      // Log error but don't fail the token request - logout tracking is non-critical
      log.error('Failed to register session-client', { action: 'Logout' }, error as Error);
    }
  } else {
    log.warn('Skipped session-client registration', {
      sid: authCodeData.sid,
      dbAvailable: !!authCtx.coreAdapter,
      action: 'Logout',
    });
  }

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  const nowEpoch = Math.floor(Date.now() / 1000);
  const refreshTokenExpiryMetadata = buildRefreshTokenExpiryMetadata(
    nowEpoch,
    refreshTokenExpiresIn
  );

  // Build response object
  // Note: device_secret is only included when Native SSO is enabled and successfully generated
  // The device_secret is returned only once and must be securely stored by the client
  const tokenResponse: Record<string, unknown> = {
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    ...(refreshToken && { refresh_token: refreshToken }),
    ...refreshTokenExpiryMetadata,
    scope: authCodeData.scope, // OAuth 2.0 spec: include scope for clarity
  };

  // OIDC Native SSO 1.0: Include device_secret if generated
  if (deviceSecret) {
    tokenResponse.device_secret = deviceSecret;
    if (issuedDeviceSecretEntity) {
      Object.assign(
        tokenResponse,
        buildNativeSSOInstallationMetadata(
          issuedDeviceSecretEntity,
          client_id,
          clientMetadata,
          Date.now()
        )
      );
    }
  }

  // RFC 9396: Include authorization_details if present in the authorization request
  if (authCodeData.authorizationDetails) {
    try {
      tokenResponse.authorization_details = JSON.parse(authCodeData.authorizationDetails);
    } catch {
      // If parsing fails, include as-is (should not happen as it was validated)
      log.warn('Failed to parse authorization_details, including as string', { action: 'RAR' });
    }
  }

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  c.executionCtx.waitUntil(
    Promise.all([
      publishEvent(c, {
        type: TOKEN_EVENTS.ACCESS_ISSUED,
        tenantId,
        data: {
          jti: tokenJti,
          clientId: client_id,
          userId: authCodeData.sub,
          scopes: authCodeData.scope.split(' '),
          expiresAt: nowEpoch + expiresIn,
          grantType: 'authorization_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
      }),
      publishEvent(c, {
        type: TOKEN_EVENTS.REFRESH_ISSUED,
        tenantId,
        data: {
          jti: refreshTokenJti,
          clientId: client_id,
          userId: authCodeData.sub,
          scopes: authCodeData.scope.split(' '),
          grantType: 'authorization_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error(
          'Failed to publish token.refresh.issued event',
          { action: 'Event' },
          err as Error
        );
      }),
      // ID Token issued event (OIDC flows always include ID token)
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId,
        data: {
          clientId: client_id,
          userId: authCodeData.sub,
          grantType: 'authorization_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      }),
    ])
  );

  return c.json(tokenResponse);
}

/**
 * Handle Refresh Token Grant
 * https://tools.ietf.org/html/rfc6749#section-6
 */
async function handleRefreshTokenGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const log = getLogger(c).module('TOKEN');
  const refreshTokenValue = formData.refresh_token;
  const scope = formData.scope; // Optional: requested scope (must be subset of original)

  // Extract client credentials from either form data or Authorization header
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication (private_key_jwt or client_secret_jwt)
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // Extract client_id from JWT assertion
    try {
      const assertionPayload = parseToken(client_assertion);
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      } else if (!client_id && assertionPayload.iss) {
        client_id = assertionPayload.iss as string;
      }
    } catch {
      return oauthError(c, 'invalid_client', 'Invalid client_assertion JWT format', 401);
    }
  }

  // Check for HTTP Basic authentication (client_secret_basic)
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate refresh_token parameter
  if (!refreshTokenValue) {
    return oauthError(c, 'invalid_request', 'refresh_token is required', 400);
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Fetch client metadata to verify client authentication - request-level cached
  const clientMetadata = await getClientCached(c, c.env, client_id);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    // RFC 6749: invalid_client should return 401
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Cast to ClientMetadata for type safety
  const typedClient = clientMetadata as unknown as ClientMetadata;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (
    typedClient.tls_client_certificate_bound_access_tokens !== true &&
    (await isDPoPRequiredForTokenRequest(c, typedClient)) &&
    !dpopProof
  ) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  // Profile-based grant_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §5.2: unauthorized_client - client not allowed to use this grant type
  const tenantId = (clientMetadata.tenant_id as string) || getTenantIdFromContext(c);
  const tenantProfile = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId);
  if (!tenantProfile.allows_refresh_token) {
    return oauthError(
      c,
      'unauthorized_client',
      'refresh_token grant is not allowed for this tenant profile',
      403
    );
  }

  // FAPI 2.0 Security Profile 5.3.2.1-9 prohibits routine refresh-token rotation.
  // Sender-constrained access tokens and confidential-client authentication provide the
  // required protections without making a client lose its session when the rotated response is
  // not received or persisted. Non-FAPI tenants keep Authrim's rotation default.
  let prohibitRefreshTokenRotation = false;
  try {
    const settings = await getSystemSettingsCached(c, c.env, { failOnError: true });
    const fapi = (settings?.fapi || {}) as { enabled?: boolean };
    prohibitRefreshTokenRotation = fapi.enabled === true;
  } catch (error) {
    log.error('Failed to load FAPI refresh-token policy', {}, error as Error);
    throw new SecurityProfileSettingsUnavailableError();
  }

  // Client authentication verification
  // Supports: client_secret_basic, client_secret_post, client_secret_jwt, private_key_jwt
  const clientAuthenticationPolicy = await resolveTokenClientAuthenticationPolicy(
    c,
    typedClient,
    client_assertion,
    client_assertion_type
  );
  if (!clientAuthenticationPolicy.ok) {
    return clientAuthenticationPolicy.response;
  }
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    // private_key_jwt or client_secret_jwt authentication
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${getRequestIssuer(c)}/token`,
      typedClient,
      clientAuthenticationPolicy.assertionOptions
    );

    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(
        c,
        assertionValidation.error || 'invalid_client',
        'Client assertion validation failed',
        401
      );
    }
  } else if (typedClient.client_secret_hash) {
    // client_secret_basic or client_secret_post authentication
    // SV-015: Verify client secret against stored SHA-256 hash
    if (
      !client_secret ||
      !(await verifyClientSecretHash(client_secret, typedClient.client_secret_hash))
    ) {
      return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
    }
  } else if (!isPublicClientMetadata(typedClient)) {
    return oauthError(c, 'invalid_client', 'Client authentication configuration is invalid', 401);
  }
  // Public clients (no client_secret_hash and no client_assertion) are allowed

  let refreshMTLSThumbprint: string | undefined;
  if (typedClient.tls_client_certificate_bound_access_tokens === true) {
    const certificateBinding = await validateClientCertificateBinding(c.req.raw, typedClient);
    if (!certificateBinding.valid || !certificateBinding.thumbprint) {
      return oauthError(c, 'invalid_client', 'Client certificate authentication failed', 401);
    }
    refreshMTLSThumbprint = certificateBinding.thumbprint;
  }

  // Parse refresh token to get JTI (without verification yet)
  let refreshTokenPayload;
  try {
    refreshTokenPayload = parseToken(refreshTokenValue);
  } catch {
    return oauthError(c, 'invalid_grant', 'Invalid refresh token format', 400);
  }

  if (
    refreshMTLSThumbprint &&
    getMTLSCertificateThumbprintFromCnfClaim(refreshTokenPayload) !== refreshMTLSThumbprint
  ) {
    return oauthError(c, 'invalid_grant', 'Refresh token certificate binding mismatch', 400);
  }

  const jti = refreshTokenPayload.jti as string;
  if (!jti) {
    return oauthError(c, 'invalid_grant', 'Refresh token missing JTI', 400);
  }

  // V2: Extract userId (sub) and version (rtv) from JWT for validation
  const userId = refreshTokenPayload.sub as string;
  const version = typeof refreshTokenPayload.rtv === 'number' ? refreshTokenPayload.rtv : 1;

  if (!userId) {
    return oauthError(c, 'invalid_grant', 'Refresh token missing subject', 400);
  }

  // Retrieve refresh token metadata from RefreshTokenRotator DO (V2)
  const refreshTokenData = await getRefreshToken(
    c.env,
    userId,
    version,
    client_id,
    jti,
    getTenantIdFromContext(c)
  );
  if (!refreshTokenData) {
    return oauthError(c, 'invalid_grant', 'Refresh token is invalid or expired', 400);
  }

  // Verify client_id matches
  if (refreshTokenData.client_id !== client_id) {
    return oauthError(c, 'invalid_grant', 'Refresh token was issued to a different client', 400);
  }

  // Load public key for verification using cached JWKS
  // Extract kid from JWT header for key lookup
  let publicKey: CryptoKey;
  let refreshTokenKid: string | undefined;
  try {
    const parts = refreshTokenValue.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const headerBase64url = parts[0];
    const headerBase64 = headerBase64url.replace(/-/g, '+').replace(/_/g, '/');
    const headerJson = JSON.parse(atob(headerBase64)) as { kid?: string; alg?: string };
    refreshTokenKid = headerJson.kid;

    // Use cached JWKS for performance (avoids KeyManager DO hop + RSA import on every request)
    publicKey = await getVerificationKeyFromJWKS(c.env, getTenantIdFromContext(c), refreshTokenKid);
  } catch (err) {
    log.error('Failed to load verification key', {}, err as Error);
    return oauthError(c, 'server_error', 'Failed to load verification key', 500);
  }

  // Verify refresh token signature
  try {
    await verifyToken(refreshTokenValue, publicKey, getRequestIssuer(c), {
      audience: client_id,
    });
  } catch (error) {
    log.error('Refresh token verification failed', {}, error as Error);
    return oauthError(c, 'invalid_grant', 'Refresh token signature verification failed', 400);
  }

  // If scope is requested, validate it's a subset of the original scope
  let grantedScope = refreshTokenData.scope;
  if (scope) {
    const requestedScopes = scope.split(' ');
    const originalScopes = refreshTokenData.scope.split(' ');

    // Check if all requested scopes are in the original scope
    const isSubset = requestedScopes.every((s) => originalScopes.includes(s));
    if (!isSubset) {
      return oauthError(c, 'invalid_scope', 'Requested scope exceeds original scope', 400);
    }
    grantedScope = scope;
  }

  // Load private key for signing new tokens from KeyManager
  // Pass the incoming token's kid as expectedKid for cache optimization:
  // If the cache has a key with matching kid, it can skip TTL check (kid mismatch trigger)
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(
      c.env,
      getTenantIdFromContext(c),
      refreshTokenKid
    );
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);
  const authCtx = createAuthContextFromHono(c, tenantId);

  // Phase 2 RBAC: Fetch fresh RBAC claims for token refresh
  // User's roles/organization may have changed since the original token was issued
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  const tenantRBACClaimsConfig = await resolveTenantRBACClaimsConfig(c.env, tenantId);
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(authCtx.coreAdapter, refreshTokenData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.accessToken,
        tenantId,
      }),
      getIDTokenRBACClaims(authCtx.coreAdapter, refreshTokenData.sub, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.idToken,
        tenantId,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    log.error('Failed to fetch RBAC claims for refresh token', {}, rbacError as Error);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  let policyEmbeddingScopedPermissions: AccessTokenScopedPermission[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && grantedScope) {
      const policyEmbedding = await evaluatePermissionEmbeddingForScope(
        authCtx.coreAdapter,
        refreshTokenData.sub,
        grantedScope,
        { cache: c.env.REBAC_CACHE, tenantId: authCtx.tenantId }
      );
      policyEmbeddingPermissions = policyEmbedding.permissions;
      policyEmbeddingScopedPermissions = policyEmbedding.scopedPermissions;
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    log.error('Failed to evaluate policy permissions for refresh token', {}, policyError as Error);
  }

  // Anonymous user claims for refresh token flow (architecture-decisions.md §17)
  let anonymousClaimsRefresh: { user_type?: string; upgrade_eligible?: boolean } = {};
  try {
    const userAccount = await findCanonicalRuntimeAccount(
      authCtx.coreAdapter,
      tenantId,
      refreshTokenData.sub
    );
    if (userAccount?.account_type === 'anonymous') {
      anonymousClaimsRefresh = {
        user_type: 'anonymous',
        upgrade_eligible: true,
      };
    }
  } catch (anonError) {
    log.error('Failed to fetch anonymous user claims for refresh token', {}, anonError as Error);
  }

  // DPoP support (RFC 9449)
  // Extract and validate DPoP proof if present
  const refreshTokenDpopJkt = getDPoPJktFromCnfClaim(refreshTokenPayload);
  const isBrowserPublicClientRequest = isBrowserPublicTokenRequest(c, formData, typedClient);
  const isNativePublicClientRequest = isNativePublicTokenRequest(formData, typedClient);
  let dpopJkt: string | undefined;
  let tokenType: 'Bearer' | 'DPoP' = 'Bearer';

  if ((isBrowserPublicClientRequest || isNativePublicClientRequest) && !refreshTokenDpopJkt) {
    return oauthError(c, 'invalid_grant', 'Public client refresh tokens must be DPoP-bound', 400);
  }

  if (refreshTokenDpopJkt && !dpopProof) {
    return oauthError(
      c,
      'invalid_request',
      'DPoP proof is required for DPoP-bound refresh tokens',
      400
    );
  }

  if (dpopProof) {
    // Validate DPoP proof (issue #12: DPoP JTI replay protection via DO)
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined, // No access token yet (this is token refresh)
      c.env, // Pass full Env for region-aware sharding
      client_id, // Bind JTI to client_id for additional security
      getTenantIdFromContext(c)
    );

    if (!dpopValidation.valid) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP proof validation failed',
        clientMetadata,
      });
    }

    // DPoP proof is valid, bind access token to the public key
    dpopJkt = dpopValidation.jkt;
    tokenType = 'DPoP';

    // Public clients have no independent client authentication credential, so their refresh
    // token remains bound to the original DPoP key. Confidential clients are already bound by
    // their authenticated client identity and may rotate the DPoP key when refreshing; the new
    // access/refresh tokens are then bound to the newly proven key.
    if (
      isPublicClientMetadata(typedClient) &&
      refreshTokenDpopJkt &&
      dpopJkt !== refreshTokenDpopJkt
    ) {
      return oauthError(
        c,
        'invalid_dpop_proof',
        'DPoP proof JWK does not match refresh token binding',
        400
      );
    }
  }

  const storedRefreshAudience =
    normalizeStoredAccessTokenAudience(refreshTokenData.resource_aud) ??
    normalizeStoredAccessTokenAudience(refreshTokenPayload.resource_aud);
  const refreshAudienceResolution = storedRefreshAudience
    ? resolveAccessTokenAudience(c, clientMetadata, { resource: storedRefreshAudience })
    : resolveAccessTokenAudience(c, clientMetadata);
  if (!refreshAudienceResolution.ok) {
    return oauthError(c, 'invalid_target', refreshAudienceResolution.description, 400);
  }
  const refreshedAccessTokenAudience = refreshAudienceResolution.audience;

  // Generate new Access Token
  let accessToken: string;
  let accessTokenJti: string = '';
  try {
    const accessTokenClaims: {
      iss: string;
      sub: string;
      aud: AccessTokenAudience;
      scope: string;
      client_id: string;
      cnf?: { jkt: string } | { 'x5t#S256': string };
      authrim_permissions?: string[];
      authrim_scoped_permissions?: AccessTokenScopedPermission[];
      [key: string]: unknown;
    } = {
      iss: getRequestIssuer(c),
      sub: refreshTokenData.sub,
      aud: refreshedAccessTokenAudience,
      scope: grantedScope,
      client_id: client_id,
      // Phase 2 RBAC: Add RBAC claims to access token
      ...accessTokenRBACClaims,
      // Anonymous user claims (architecture-decisions.md §17)
      ...anonymousClaimsRefresh,
    };

    // Phase 2 Policy Embedding: Add evaluated permissions
    if (policyEmbeddingPermissions.length > 0) {
      accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
    }
    if (policyEmbeddingScopedPermissions.length > 0) {
      accessTokenClaims.authrim_scoped_permissions = policyEmbeddingScopedPermissions;
    }

    // Add DPoP confirmation (cnf) claim if DPoP is used
    if (dpopJkt) {
      accessTokenClaims.cnf = { jkt: dpopJkt };
    } else if (refreshMTLSThumbprint) {
      accessTokenClaims.cnf = { 'x5t#S256': refreshMTLSThumbprint };
    }

    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (err) {
    log.error('Failed to create access token', {}, err as Error);
    return oauthError(c, 'server_error', 'Failed to create access token', 500);
  }

  // Generate new ID Token (optional for refresh flow, but included for consistency)
  let idToken: string;
  try {
    const atHash = await calculateAtHash(accessToken);
    let idTokenClaims: Record<string, unknown> = {
      iss: getRequestIssuer(c),
      sub: refreshTokenData.sub,
      aud: client_id,
      at_hash: atHash,
      // Phase 2 RBAC: Add RBAC claims to ID token
      ...idTokenRBACClaims,
      // Anonymous user claims (architecture-decisions.md §17)
      ...anonymousClaimsRefresh,
    };

    const mappedIdTokenClaims = await applyOIDCIdentityMappingToIDTokenClaims(
      c,
      tenantId,
      client_id,
      clientMetadata as ClientMetadata,
      idTokenClaims,
      splitScope(grantedScope)
    );
    if (!mappedIdTokenClaims.ok) {
      return mappedIdTokenClaims.response;
    }
    idTokenClaims = mappedIdTokenClaims.claims;

    const idTokenConsent = await enforceOIDCAttributeReleaseConsentForIDTokenClaims(
      c,
      tenantId,
      clientMetadata as ClientMetadata,
      idTokenClaims
    );
    if (!idTokenConsent.ok) {
      return idTokenConsent.response;
    }

    // Check if client requests SD-JWT ID Token (RFC 9901)
    const useSDJWT =
      clientMetadata.id_token_signed_response_type === 'sd-jwt' && c.env.ENABLE_SD_JWT === 'true';

    if (useSDJWT) {
      const rawSelectiveClaims = clientMetadata.sd_jwt_selective_claims;
      const selectiveClaims: string[] = Array.isArray(rawSelectiveClaims)
        ? rawSelectiveClaims
        : ['email', 'phone_number', 'address', 'birthdate'];
      idToken = await createClientSDJWTIDToken(
        c.env,
        tenantId,
        clientMetadata as ClientMetadata,
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        expiresIn,
        selectiveClaims
      );
    } else {
      idToken = await createClientIDToken(
        c.env,
        tenantId,
        clientMetadata as ClientMetadata,
        idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
        expiresIn
      );
    }
  } catch (error) {
    log.error('Failed to create ID token', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to create ID token', 500);
  }

  // Rotation remains enabled by default except for FAPI 2.0 tenants, where routine rotation is
  // explicitly prohibited by the security profile.
  const rotationEnabled =
    !prohibitRefreshTokenRotation && c.env.ENABLE_REFRESH_TOKEN_ROTATION !== 'false';

  let newRefreshToken: string;
  const refreshTokenExpiresIn = await configManager.getRefreshTokenExpiry();

  if (rotationEnabled) {
    // V2: Implement refresh token rotation with version-based theft detection
    if (!c.env.REFRESH_TOKEN_ROTATOR) {
      return oauthError(c, 'server_error', 'Refresh token rotation unavailable', 500);
    }

    const { stub: rotator } = getRefreshTokenRotatorStubByJti(
      c.env,
      client_id,
      jti,
      getTenantIdFromContext(c)
    );
    const tenantId = getTenantIdFromContext(c);

    // V2: Get incoming version from JWT (default to 1 for legacy tokens without rtv)
    const incomingVersion =
      typeof refreshTokenPayload.rtv === 'number' ? refreshTokenPayload.rtv : 1;

    let newRefreshTokenJti: string;
    let newVersion: number;

    try {
      // Use RPC for token rotation (V2/V3)
      const rotateResult = await rotator.rotateRpc({
        incomingVersion,
        incomingJti: jti, // V3: Send full JTI (DO stores and compares full JTIs)
        userId: refreshTokenData.sub,
        clientId: client_id,
        tenantId,
        requestedScope: scope || undefined, // Pass requested scope for validation
      });

      // V3: DO now returns full JTIs with generation/shard prefix
      // No wrapping needed - use the JTI directly from DO
      newRefreshTokenJti = rotateResult.newJti;
      newVersion = rotateResult.newVersion;

      // Create JWT with new version (rtv claim)
      const refreshTokenClaims = {
        iss: getRequestIssuer(c),
        sub: refreshTokenData.sub,
        aud: client_id,
        scope: grantedScope,
        client_id: client_id,
        resource_aud: refreshedAccessTokenAudience,
        ...(dpopJkt
          ? { cnf: { jkt: dpopJkt } }
          : refreshMTLSThumbprint
            ? { cnf: { 'x5t#S256': refreshMTLSThumbprint } }
            : {}),
      };

      // V2: Include rtv (Refresh Token Version) for theft detection
      const result = await createRefreshToken(
        refreshTokenClaims,
        privateKey,
        keyId,
        refreshTokenExpiresIn,
        newRefreshTokenJti,
        newVersion // V2: Include version in JWT
      );
      newRefreshToken = result.token;
    } catch (error) {
      log.error('Failed to rotate refresh token', {}, error as Error);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check for theft detection or version mismatch
      if (
        errorMessage.includes('theft') ||
        errorMessage.includes('revoked') ||
        errorMessage.includes('version mismatch')
      ) {
        log.error('SECURITY: Token theft detected and family revoked', {
          clientId: client_id,
          userId: refreshTokenData.sub,
          incomingVersion,
          action: 'Security',
        });
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Refresh token has been revoked',
          },
          400
        );
      }

      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Token rotation failed',
        },
        400
      );
    }
  } else {
    // A FAPI tenant uses stable refresh tokens by profile requirement. Other tenants may reach
    // this branch only through the explicit environment override.
    newRefreshToken = refreshTokenValue;
    log.debug('Refresh token rotation disabled - returning same token', {
      fapiProfile: prohibitRefreshTokenRotation,
    });
  }

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const eventPromises: Promise<unknown>[] = [
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId,
      data: {
        jti: accessTokenJti,
        clientId: client_id,
        userId: refreshTokenData.sub,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + expiresIn,
        grantType: 'refresh_token',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    }),
  ];
  if (rotationEnabled) {
    eventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.REFRESH_ROTATED,
        tenantId,
        data: {
          clientId: client_id,
          userId: refreshTokenData.sub,
          scopes: grantedScope.split(' '),
          grantType: 'refresh_token',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error(
          'Failed to publish token.refresh.rotated event',
          { action: 'Event' },
          err as Error
        );
      })
    );
  }

  // ID Token issued event (refresh grant can also issue new ID token)
  if (idToken) {
    eventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId,
        data: {
          clientId: client_id,
          userId: refreshTokenData.sub,
          grantType: 'refresh_token',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      })
    );
  }
  c.executionCtx.waitUntil(Promise.all(eventPromises));

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: tokenType, // 'Bearer' or 'DPoP' depending on DPoP usage
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: newRefreshToken,
    ...buildRefreshTokenExpiryMetadata(nowEpoch, refreshTokenExpiresIn),
    scope: grantedScope,
  });
}

/**
 * Verify PKCE code_verifier against code_challenge
 * https://tools.ietf.org/html/rfc7636#section-4.6
 *
 * @param codeVerifier - Code verifier from token request
 * @param codeChallenge - Code challenge from authorization request
 * @returns Promise<boolean> - True if verification succeeds
 */
async function verifyPKCE(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  // Validate code_verifier format (43-128 characters, unreserved characters per RFC 7636)
  // RFC 7636 Section 4.1: code_verifier = 43*128unreserved
  // unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
  const codeVerifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
  if (!codeVerifierPattern.test(codeVerifier)) {
    return false;
  }

  // Hash code_verifier with SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to base64url
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const base64 = btoa(String.fromCharCode(...hashArray));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');

  // Compare with code_challenge
  // SECURITY: Use timing-safe comparison to prevent timing attacks
  return timingSafeEqual(base64url, codeChallenge);
}

/**
 * Handle JWT Bearer Grant (RFC 7523)
 * https://datatracker.ietf.org/doc/html/rfc7523
 *
 * Service-to-service authentication using JWT assertions
 */
async function handleJWTBearerGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const log = getLogger(c).module('TOKEN');
  const assertion = formData.assertion;
  const scope = formData.scope;
  const requestedAudience = formData.audience;
  const requestedResource = formData.resource;

  // Validate assertion parameter
  if (!assertion) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameter: assertion',
      },
      400
    );
  }

  // Parse trusted issuers from environment
  const trustedIssuers = parseTrustedIssuers(c.env.TRUSTED_JWT_ISSUERS);

  if (trustedIssuers.size === 0) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'JWT Bearer grant is not configured (no trusted issuers)',
      },
      500
    );
  }

  // Validate JWT assertion
  const validation = await validateJWTBearerAssertion(
    assertion,
    getRequestIssuer(c),
    trustedIssuers
  );

  if (!validation.valid || !validation.claims) {
    return c.json(
      {
        error: validation.error || 'invalid_grant',
        error_description: validation.error_description || 'JWT assertion validation failed',
      },
      400
    );
  }

  const claims = validation.claims;

  // Determine scope: use requested scope or scope from assertion
  let grantedScope = scope || claims.scope || 'openid';

  // Validate scope against allowed scopes for the issuer
  const trustedIssuer = trustedIssuers.get(claims.iss);
  if (!trustedIssuer) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'JWT assertion issuer is not trusted',
      },
      400
    );
  }
  const trustedIssuerTargetPolicy = trustedIssuer as typeof trustedIssuer & {
    default_resource?: string;
    default_audience?: string;
    allowed_resources?: string[];
  };

  if (trustedIssuer?.allowed_scopes) {
    const requestedScopes = grantedScope.split(' ');
    const hasDisallowedScope = requestedScopes.some(
      (s) => !trustedIssuer.allowed_scopes?.includes(s)
    );

    if (hasDisallowedScope) {
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'Requested scope is not allowed for this issuer',
        },
        400
      );
    }
  }

  const audienceResolution = resolveAccessTokenAudience(
    c,
    {
      client_id: claims.iss,
      tenant_id: getTenantIdFromContext(c),
      default_resource: trustedIssuerTargetPolicy.default_resource,
      default_audience: trustedIssuerTargetPolicy.default_audience,
      allowed_token_exchange_resources: trustedIssuerTargetPolicy.allowed_resources,
    } as ClientMetadata,
    {
      resource: requestedResource ?? claims.resource,
      audience: requestedAudience,
      rejectResourceAudienceMismatch: true,
    }
  );
  if (!audienceResolution.ok) {
    return c.json(
      {
        error: 'invalid_target',
        error_description: audienceResolution.description,
      },
      400
    );
  }

  // Load private key for signing tokens from KeyManager
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();

  // Generate Access Token
  // For JWT Bearer flow, the subject (sub) comes from the assertion
  const accessTokenClaims = {
    iss: getRequestIssuer(c),
    sub: claims.sub, // Subject from JWT assertion
    aud: audienceResolution.audience,
    scope: grantedScope,
    client_id: claims.iss, // Issuer acts as client_id for service accounts
  };

  let accessToken: string;
  let accessTokenJti: string = '';
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // JWT Bearer flow typically does NOT issue ID tokens or refresh tokens
  // It's for service-to-service authentication, not user authentication
  // Only access token is returned

  // Publish token event (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: getTenantIdFromContext(c),
      data: {
        jti: accessTokenJti,
        clientId: claims.iss, // Issuer acts as client_id for service accounts
        userId: claims.sub,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + expiresIn,
        grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    })
  );

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: grantedScope,
  });
}

/**
 * Handle Device Code Grant
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * https://datatracker.ietf.org/doc/html/rfc8628#section-3.4
 */
async function handleDeviceCodeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
) {
  const log = getLogger(c).module('TOKEN');
  const deviceCode = formData.device_code;
  const client_id = formData.client_id;
  const tenantId = getTenantIdFromContext(c);
  const internalHeaders = {
    'Content-Type': 'application/json',
    'X-Authrim-Tenant-Id': tenantId,
  };

  // Validate required parameters
  if (!deviceCode) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'device_code is required',
      },
      400
    );
  }

  if (!client_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'client_id is required',
      },
      400
    );
  }

  // Get device code metadata from DeviceCodeStore
  // Support both region-sharded and legacy global formats
  const parsedDeviceCode = parseDeviceCodeId(deviceCode);
  let deviceCodeStore: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };

  if (parsedDeviceCode) {
    // New region-sharded format: route via embedded shard info
    const { stub } = getDeviceCodeStoreById(c.env, deviceCode, tenantId);
    deviceCodeStore = stub;
  } else {
    // Legacy format: use tenant-scoped global DO
    const deviceCodeStoreId = c.env.DEVICE_CODE_STORE.idFromName(
      buildDOInstanceName('device', tenantId)
    );
    deviceCodeStore = c.env.DEVICE_CODE_STORE.get(deviceCodeStoreId);
  }

  // Update poll time (for rate limiting)
  try {
    await deviceCodeStore.fetch(
      new Request('https://internal/update-poll', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ device_code: deviceCode }),
      })
    );
  } catch (error) {
    log.error('Failed to update poll time', {}, error as Error);
  }

  // Get device code metadata
  const getResponse = await deviceCodeStore.fetch(
    new Request('https://internal/get-by-device-code', {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ device_code: deviceCode }),
    })
  );

  const metadata = (await getResponse.json()) as {
    device_code: string;
    user_code: string;
    client_id: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    sub?: string;
    user_id?: string;
    last_poll_at?: number;
    poll_count?: number;
    created_at: number;
    expires_at: number;
  };

  if (!metadata || !metadata.device_code) {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'Device code has expired or is invalid',
      },
      400
    );
  }

  // Check if device code is for the correct client
  if (metadata.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code does not belong to this client',
      },
      400
    );
  }

  // Check status and return appropriate response
  if (metadata.status === 'pending') {
    // User has not yet approved - check if polling too fast
    const { isDeviceFlowPollingTooFast, DEVICE_FLOW_CONSTANTS } =
      await import('@authrim/ar-lib-core');

    if (isDeviceFlowPollingTooFast(metadata, DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL)) {
      return c.json(
        {
          error: 'slow_down',
          error_description: 'You are polling too frequently. Please slow down.',
        },
        400
      );
    }

    return c.json(
      {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the device',
      },
      400
    );
  }

  if (metadata.status === 'denied') {
    // Delete the device code (it's been denied)
    await deviceCodeStore.fetch(
      new Request('https://internal/delete', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ device_code: deviceCode }),
      })
    );

    return c.json(
      {
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      },
      403
    );
  }

  if (metadata.status === 'expired') {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'Device code has expired',
      },
      400
    );
  }

  // Status is 'approved' - issue tokens
  if (metadata.status !== 'approved' || !metadata.sub) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code is not approved',
      },
      400
    );
  }

  const clientMetadata = await getClientCached(c, c.env, metadata.client_id);
  if (!clientMetadata) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (
    (await isDPoPRequiredForTokenRequest(c, clientMetadata as unknown as ClientMetadata)) &&
    !dpopProof
  ) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      c.req.url,
      undefined,
      c.env,
      metadata.client_id,
      getTenantIdFromContext(c)
    );

    if (!dpopValidation.valid) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP validation failed',
        clientMetadata,
      });
    }
    dpopJkt = dpopValidation.jkt;
  }

  const audienceResolution = resolveAccessTokenAudience(c, clientMetadata);
  if (!audienceResolution.ok) {
    return oauthError(c, 'invalid_target', audienceResolution.description, 400);
  }

  // Atomically reserve the approved device code before issuing tokens. This closes
  // the get-then-delete race where concurrent polls could both observe approved.
  const consumeResponse = await deviceCodeStore.fetch(
    new Request('https://internal/mark-token-issued', {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ device_code: deviceCode }),
    })
  );
  if (!consumeResponse.ok) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Device code has already been used or is not approved',
      },
      400
    );
  }

  // Get private key for signing tokens
  let privateKey: CryptoKey;
  let keyId: string;
  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, tenantId);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing keys',
      },
      500
    );
  }

  // Token expiration (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();
  const authCtx = createAuthContextFromHono(c, getTenantIdFromContext(c));

  // Phase 2 RBAC: Fetch RBAC claims for device flow tokens
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  const tenantRBACClaimsConfig = await resolveTenantRBACClaimsConfig(c.env, authCtx.tenantId);
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(authCtx.coreAdapter, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.accessToken,
        tenantId: authCtx.tenantId,
      }),
      getIDTokenRBACClaims(authCtx.coreAdapter, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.idToken,
        tenantId: authCtx.tenantId,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    log.error('Failed to fetch RBAC claims for device flow', {}, rbacError as Error);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  let policyEmbeddingScopedPermissions: AccessTokenScopedPermission[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && metadata.scope && metadata.sub) {
      const policyEmbedding = await evaluatePermissionEmbeddingForScope(
        authCtx.coreAdapter,
        metadata.sub,
        metadata.scope,
        { cache: c.env.REBAC_CACHE, tenantId: authCtx.tenantId }
      );
      policyEmbeddingPermissions = policyEmbedding.permissions;
      policyEmbeddingScopedPermissions = policyEmbedding.scopedPermissions;
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    log.error('Failed to evaluate policy permissions for device flow', {}, policyError as Error);
  }

  // Generate ID Token
  let idTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: metadata.sub,
    aud: client_id,
    nonce: undefined, // Device flow doesn't use nonce
    auth_time: Math.floor(Date.now() / 1000),
    // Phase 2 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
  };

  const mappedIdTokenClaims = await applyOIDCIdentityMappingToIDTokenClaims(
    c,
    getTenantIdFromContext(c),
    client_id,
    clientMetadata as ClientMetadata,
    idTokenClaims,
    splitScope(metadata.scope)
  );
  if (!mappedIdTokenClaims.ok) {
    return mappedIdTokenClaims.response;
  }
  idTokenClaims = mappedIdTokenClaims.claims;

  const idTokenConsent = await enforceOIDCAttributeReleaseConsentForIDTokenClaims(
    c,
    getTenantIdFromContext(c),
    clientMetadata as ClientMetadata,
    idTokenClaims
  );
  if (!idTokenConsent.ok) {
    return idTokenConsent.response;
  }

  let idToken: string;
  try {
    idToken = await createClientIDToken(
      c.env,
      getTenantIdFromContext(c),
      clientMetadata as ClientMetadata,
      idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
      expiresIn
    );
  } catch (error) {
    log.error('Failed to create ID token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create ID token',
      },
      500
    );
  }

  // Generate Access Token
  const accessTokenClaims: {
    iss: string;
    sub: string | undefined;
    aud: AccessTokenAudience;
    scope: string | undefined;
    client_id: string;
    authrim_permissions?: string[];
    authrim_scoped_permissions?: AccessTokenScopedPermission[];
    [key: string]: unknown;
  } = {
    iss: getRequestIssuer(c),
    sub: metadata.sub,
    aud: audienceResolution.audience,
    scope: metadata.scope,
    client_id,
    // Phase 2 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }
  if (policyEmbeddingScopedPermissions.length > 0) {
    accessTokenClaims.authrim_scoped_permissions = policyEmbeddingScopedPermissions;
  }

  let accessToken: string;
  let accessTokenJti: string = '';
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims,
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Generate Refresh Token with V3 sharding support
  const refreshTokenExpiry = await configManager.getRefreshTokenExpiry();
  let refreshToken: string;
  let refreshJti: string;
  try {
    let familyResult: Awaited<ReturnType<typeof createRefreshTokenFamily>> | undefined;
    if (c.env.REFRESH_TOKEN_ROTATOR) {
      familyResult = await createRefreshTokenFamily(c.env, {
        userId: metadata.sub!,
        clientId: client_id,
        scope: metadata.scope || '',
        ttl: refreshTokenExpiry,
        tenantId: getTenantIdFromContext(c),
        resourceAudience: audienceResolution.audience,
      });
      refreshJti = familyResult.jti;
      void recordTokenFamilyIndex(
        authCtx.coreAdapter,
        getTenantIdFromContext(c),
        refreshJti,
        metadata.sub!,
        client_id,
        familyResult.resolution.generation,
        refreshTokenExpiry
      );
    } else {
      refreshJti = `rt_${crypto.randomUUID()}`;
    }

    const refreshTokenClaims = {
      sub: metadata.sub!,
      scope: metadata.scope,
      client_id,
      ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
    };
    const result = await createRefreshToken(
      refreshTokenClaims,
      privateKey,
      keyId,
      refreshTokenExpiry,
      refreshJti // V3: Pass pre-generated sharded JTI
    );
    refreshToken = result.token;

    if (!familyResult) {
      await storeRefreshToken(
        c.env,
        refreshJti,
        {
          jti: refreshJti,
          client_id,
          sub: metadata.sub!,
          scope: metadata.scope,
          resource_aud: audienceResolution.audience,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + refreshTokenExpiry,
        },
        getTenantIdFromContext(c)
      );
    }
  } catch (error) {
    log.error('Failed to create refresh token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create refresh token',
      },
      500
    );
  }

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const deviceEventPromises: Promise<unknown>[] = [
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: getTenantIdFromContext(c),
      data: {
        jti: accessTokenJti,
        clientId: client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        expiresAt: nowEpoch + expiresIn,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    }),
    publishEvent(c, {
      type: TOKEN_EVENTS.REFRESH_ISSUED,
      tenantId: getTenantIdFromContext(c),
      data: {
        jti: refreshJti,
        clientId: client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.refresh.issued event', { action: 'Event' }, err as Error);
    }),
  ];

  // ID Token issued event (device code grant)
  if (idToken) {
    deviceEventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId: getTenantIdFromContext(c),
        data: {
          clientId: client_id,
          userId: metadata.sub,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      })
    );
  }
  c.executionCtx.waitUntil(Promise.all(deviceEventPromises));

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    ...buildRefreshTokenExpiryMetadata(nowEpoch, refreshTokenExpiry),
    scope: metadata.scope,
  });
}

/**
 * Handle CIBA Grant
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html#token_endpoint
 */
async function handleCIBAGrant(c: Context<{ Bindings: Env }>, formData: Record<string, string>) {
  const log = getLogger(c).module('TOKEN');
  const authReqId = formData.auth_req_id;
  const clientAuth = parseOAuthClientAuthenticationParams({
    clientId: formData.client_id,
    clientSecret: formData.client_secret,
    clientAssertion: formData.client_assertion,
    clientAssertionType: formData.client_assertion_type,
    authorizationHeader: c.req.header('Authorization') ?? undefined,
  });
  if (!clientAuth.ok) {
    return oauthError(c, clientAuth.error, clientAuth.errorDescription, 401);
  }

  const client_id = clientAuth.credentials.clientId;
  const tenantId = getTenantIdFromContext(c);
  const internalHeaders = {
    'Content-Type': 'application/json',
    'X-Authrim-Tenant-Id': tenantId,
  };

  // Validate required parameters
  if (!authReqId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'auth_req_id is required',
      },
      400
    );
  }

  if (!client_id) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'client_id is required',
      },
      400
    );
  }

  const clientMetadata = await getClientCached(c, c.env, client_id);
  if (!clientMetadata) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  const clientAuthentication = await authenticateConfidentialOAuthClient(
    clientMetadata as unknown as ClientMetadata,
    `${getRequestIssuer(c)}/token`,
    clientAuth.credentials
  );

  if (!clientAuthentication.ok) {
    return oauthError(c, clientAuthentication.error, clientAuthentication.errorDescription, 401);
  }

  let mtlsThumbprint: string | undefined;
  if (clientMetadata.tls_client_certificate_bound_access_tokens === true) {
    const certificateBinding = await validateClientCertificateBinding(
      c.req.raw,
      clientMetadata as unknown as ClientMetadata
    );
    if (!certificateBinding.valid || !certificateBinding.thumbprint) {
      log.warn('CIBA client certificate binding failed', {
        reason: certificateBinding.error ?? 'missing_thumbprint',
      });
      return oauthError(c, 'invalid_client', 'Client certificate authentication failed', 401);
    }
    mtlsThumbprint = certificateBinding.thumbprint;
  }

  const grantTypes = clientMetadata.grant_types as string[] | string | undefined;
  if (!grantTypes || !grantTypes.includes('urn:openid:params:grant-type:ciba')) {
    return oauthError(c, 'unauthorized_client', 'Client is not authorized for CIBA grant', 400);
  }

  // Get CIBA request metadata from CIBARequestStore
  // Support both region-sharded and legacy global formats
  const parsedCIBAId = parseCIBARequestId(authReqId);
  let cibaRequestStore: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };

  if (parsedCIBAId) {
    // New region-sharded format: route via embedded shard info
    const { stub } = getCIBARequestStoreById(c.env, authReqId, tenantId);
    cibaRequestStore = stub;
  } else {
    // Legacy format: use tenant-scoped global DO
    const cibaRequestStoreId = c.env.CIBA_REQUEST_STORE.idFromName(
      buildDOInstanceName('ciba', tenantId)
    );
    cibaRequestStore = c.env.CIBA_REQUEST_STORE.get(cibaRequestStoreId);
  }

  // Update poll time (for rate limiting in poll mode)
  try {
    await cibaRequestStore.fetch(
      new Request('https://internal/update-poll', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );
  } catch (error) {
    log.error('Failed to update poll time', {}, error as Error);
  }

  // Get CIBA request metadata
  const getResponse = await cibaRequestStore.fetch(
    new Request('https://internal/get-by-auth-req-id', {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  const metadata = (await getResponse.json()) as {
    auth_req_id: string;
    client_id: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    delivery_mode: 'poll' | 'ping' | 'push';
    interval: number;
    sub?: string;
    user_id?: string;
    nonce?: string;
    authenticated_acr?: string;
    last_poll_at?: number;
    poll_count?: number;
    created_at: number;
    expires_at: number;
    token_issued?: boolean;
  };

  if (!metadata || !metadata.auth_req_id) {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'CIBA request has expired or is invalid',
      },
      400
    );
  }

  // Check if auth_req_id is for the correct client
  if (metadata.client_id !== client_id) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'auth_req_id does not belong to this client',
      },
      400
    );
  }

  // Check if tokens have already been issued (one-time use)
  if (metadata.token_issued) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Tokens have already been issued for this auth_req_id',
      },
      400
    );
  }

  // Check status and return appropriate response
  if (metadata.status === 'pending') {
    // User has not yet approved - check if polling too fast (poll mode only)
    if (metadata.delivery_mode === 'poll') {
      const { isPollingTooFast } = await import('@authrim/ar-lib-core');

      if (isPollingTooFast(metadata)) {
        return c.json(
          {
            error: 'slow_down',
            error_description: 'You are polling too frequently. Please slow down.',
          },
          400
        );
      }
    }

    return c.json(
      {
        error: 'authorization_pending',
        error_description: 'User has not yet authorized the authentication request',
      },
      400
    );
  }

  if (metadata.status === 'denied') {
    // Delete the CIBA request (it's been denied)
    await cibaRequestStore.fetch(
      new Request('https://internal/delete', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );

    return c.json(
      {
        error: 'access_denied',
        error_description: 'User denied the authentication request',
      },
      400
    );
  }

  if (metadata.status === 'expired') {
    return c.json(
      {
        error: 'expired_token',
        error_description: 'CIBA request has expired',
      },
      400
    );
  }

  // Status is 'approved' - issue tokens
  if (metadata.status !== 'approved' || !metadata.sub) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'CIBA request is not approved',
      },
      400
    );
  }

  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (
    clientMetadata.tls_client_certificate_bound_access_tokens !== true &&
    (await isDPoPRequiredForTokenRequest(c, clientMetadata as unknown as ClientMetadata)) &&
    !dpopProof
  ) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      'POST',
      getRequestIssuer(c) + '/token',
      undefined,
      c.env,
      metadata.client_id,
      getTenantIdFromContext(c)
    );

    if (dpopValidation.valid && dpopValidation.jkt) {
      dpopJkt = dpopValidation.jkt;
    } else if (!dpopValidation.valid) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP validation failed',
        clientMetadata,
      });
    }
  }

  const audienceResolution = resolveAccessTokenAudience(c, clientMetadata);
  if (!audienceResolution.ok) {
    return oauthError(c, 'invalid_target', audienceResolution.description, 400);
  }

  // Mark tokens as issued (one-time use enforcement)
  const markIssuedResponse = await cibaRequestStore.fetch(
    new Request('https://internal/mark-token-issued', {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );

  if (!markIssuedResponse.ok) {
    const error = (await markIssuedResponse.json()) as {
      error?: string;
      error_description?: string;
    };
    log.error('Failed to mark tokens as issued', {}, error as Error);
    // If tokens were already issued, return error
    if (error.error_description?.includes('already issued')) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Tokens have already been issued for this auth_req_id',
        },
        400
      );
    }
  }

  const authCtx = createAuthContextFromHono(c, getTenantIdFromContext(c));

  // Verify user exists in canonical runtime account tables without reading PII.
  const userAccount = await findCanonicalRuntimeAccount(
    authCtx.coreAdapter,
    getTenantIdFromContext(c),
    metadata.sub
  );

  if (!userAccount) {
    // Security: Internal error - don't leak user existence
    return c.json(
      {
        error: 'server_error',
        error_description: 'An unexpected error occurred',
      },
      500
    );
  }

  // Get signing key from KeyManager
  const { privateKey, kid } = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));

  // Token expiration times (KV > env > default priority)
  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();
  const refreshExpiresIn = await configManager.getRefreshTokenExpiry();

  // Phase 2 RBAC: Fetch RBAC claims for CIBA flow tokens
  let accessTokenRBACClaims: Awaited<ReturnType<typeof getAccessTokenRBACClaims>> = {};
  let idTokenRBACClaims: Awaited<ReturnType<typeof getIDTokenRBACClaims>> = {};
  const tenantRBACClaimsConfig = await resolveTenantRBACClaimsConfig(c.env, authCtx.tenantId);
  try {
    [accessTokenRBACClaims, idTokenRBACClaims] = await Promise.all([
      getAccessTokenRBACClaims(authCtx.coreAdapter, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.accessToken,
        tenantId: authCtx.tenantId,
      }),
      getIDTokenRBACClaims(authCtx.coreAdapter, metadata.sub!, {
        cache: c.env.REBAC_CACHE,
        claimsConfig: tenantRBACClaimsConfig.idToken,
        tenantId: authCtx.tenantId,
      }),
    ]);
  } catch (rbacError) {
    // Log but don't fail - RBAC claims are optional for backward compatibility
    log.error('Failed to fetch RBAC claims for CIBA flow', {}, rbacError as Error);
  }

  // Phase 2 Policy Embedding: Evaluate permissions from scope if enabled
  let policyEmbeddingPermissions: string[] = [];
  let policyEmbeddingScopedPermissions: AccessTokenScopedPermission[] = [];
  try {
    const policyEmbeddingEnabled = await isPolicyEmbeddingEnabled(c.env);
    if (policyEmbeddingEnabled && metadata.scope && metadata.sub) {
      const policyEmbedding = await evaluatePermissionEmbeddingForScope(
        authCtx.coreAdapter,
        metadata.sub,
        metadata.scope,
        { cache: c.env.REBAC_CACHE, tenantId: authCtx.tenantId }
      );
      policyEmbeddingPermissions = policyEmbedding.permissions;
      policyEmbeddingScopedPermissions = policyEmbedding.scopedPermissions;
    }
  } catch (policyError) {
    // Log but don't fail - policy embedding is optional
    log.error('Failed to evaluate policy permissions for CIBA flow', {}, policyError as Error);
  }

  // Create Access Token FIRST (needed for at_hash in ID token)
  const accessTokenClaims: {
    iss: string;
    sub: string;
    aud: AccessTokenAudience;
    scope: string | undefined;
    client_id: string;
    cnf?: { jkt: string } | { 'x5t#S256': string };
    authrim_permissions?: string[];
    authrim_scoped_permissions?: AccessTokenScopedPermission[];
    [key: string]: unknown;
  } = {
    iss: getRequestIssuer(c),
    sub: metadata.sub!,
    aud: audienceResolution.audience,
    scope: metadata.scope,
    client_id: metadata.client_id,
    ...(dpopJkt
      ? { cnf: { jkt: dpopJkt } }
      : mtlsThumbprint
        ? { cnf: { 'x5t#S256': mtlsThumbprint } }
        : {}),
    // Phase 2 RBAC: Add RBAC claims to access token
    ...accessTokenRBACClaims,
  };

  // Phase 2 Policy Embedding: Add evaluated permissions
  if (policyEmbeddingPermissions.length > 0) {
    accessTokenClaims.authrim_permissions = policyEmbeddingPermissions;
  }
  if (policyEmbeddingScopedPermissions.length > 0) {
    accessTokenClaims.authrim_scoped_permissions = policyEmbeddingScopedPermissions;
  }

  // Generate region-aware JTI for token revocation sharding
  const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
  const { token: accessToken, jti: tokenJti } = await createAccessToken(
    accessTokenClaims,
    privateKey,
    kid,
    expiresIn,
    regionAwareJti
  );

  // Calculate at_hash for ID token
  const atHash = await calculateAtHash(accessToken);

  // Create ID token with at_hash
  let idTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: metadata.sub!,
    aud: metadata.client_id,
    ...(metadata.nonce && { nonce: metadata.nonce }),
    ...(metadata.authenticated_acr && { acr: metadata.authenticated_acr }),
    at_hash: atHash,
    // Phase 2 RBAC: Add RBAC claims to ID token
    ...idTokenRBACClaims,
  };

  const mappedIdTokenClaims = await applyOIDCIdentityMappingToIDTokenClaims(
    c,
    getTenantIdFromContext(c),
    metadata.client_id,
    clientMetadata as ClientMetadata,
    idTokenClaims,
    splitScope(metadata.scope)
  );
  if (!mappedIdTokenClaims.ok) {
    return mappedIdTokenClaims.response;
  }
  idTokenClaims = mappedIdTokenClaims.claims;

  const idTokenConsent = await enforceOIDCAttributeReleaseConsentForIDTokenClaims(
    c,
    getTenantIdFromContext(c),
    clientMetadata as ClientMetadata,
    idTokenClaims
  );
  if (!idTokenConsent.ok) {
    return idTokenConsent.response;
  }

  let idToken = await createClientIDToken(
    c.env,
    getTenantIdFromContext(c),
    clientMetadata as ClientMetadata,
    idTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
    expiresIn
  );

  // Encrypt ID token if required
  if (isIDTokenEncryptionRequired(clientMetadata)) {
    const alg = clientMetadata.id_token_encrypted_response_alg as JWEAlgorithm;
    const enc = clientMetadata.id_token_encrypted_response_enc as JWEEncryption;
    const clientPublicKey = await getClientPublicKey(clientMetadata, undefined, alg);

    if (!clientPublicKey) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Client encryption key not available',
        },
        500
      );
    }

    if (!validateJWEOptions(alg, enc)) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Invalid JWE algorithm or encryption method',
        },
        500
      );
    }

    idToken = await encryptJWT(idToken, clientPublicKey, { alg, enc });
  }

  // Create Refresh Token with canonical family registration
  let refreshTokenJti: string;
  let cibaFamilyResult: Awaited<ReturnType<typeof createRefreshTokenFamily>> | undefined;
  if (c.env.REFRESH_TOKEN_ROTATOR) {
    cibaFamilyResult = await createRefreshTokenFamily(c.env, {
      userId: metadata.sub!,
      clientId: metadata.client_id,
      scope: metadata.scope || '',
      ttl: refreshExpiresIn,
      tenantId: getTenantIdFromContext(c),
      resourceAudience: audienceResolution.audience,
    });
    refreshTokenJti = cibaFamilyResult.jti;
    void recordTokenFamilyIndex(
      authCtx.coreAdapter,
      getTenantIdFromContext(c),
      refreshTokenJti,
      metadata.sub!,
      metadata.client_id,
      cibaFamilyResult.resolution.generation,
      refreshExpiresIn
    );
  } else {
    refreshTokenJti = `rt_${crypto.randomUUID()}`;
  }

  const refreshTokenClaims = {
    iss: getRequestIssuer(c),
    sub: metadata.sub!,
    aud: metadata.client_id,
    client_id: metadata.client_id,
    scope: metadata.scope,
    resource_aud: audienceResolution.audience,
    ...(mtlsThumbprint ? { cnf: { 'x5t#S256': mtlsThumbprint } } : {}),
  };

  const { token: refreshToken } = await createRefreshToken(
    refreshTokenClaims,
    privateKey,
    kid,
    refreshExpiresIn,
    refreshTokenJti // V3: Pass pre-generated sharded JTI
  );

  if (!cibaFamilyResult) {
    await storeRefreshToken(
      c.env,
      refreshTokenJti,
      {
        client_id: metadata.client_id,
        sub: metadata.sub!,
        scope: metadata.scope,
        resource_aud: audienceResolution.audience,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + refreshExpiresIn,
        jti: refreshTokenJti,
      },
      getTenantIdFromContext(c)
    );
  }

  // Keep the issued request as a short-lived tombstone until its original expiry. This lets a
  // replay receive invalid_grant instead of being indistinguishable from an unknown/expired ID.

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const cibaEventPromises: Promise<unknown>[] = [
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: getTenantIdFromContext(c),
      data: {
        jti: tokenJti,
        clientId: metadata.client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        expiresAt: nowEpoch + expiresIn,
        grantType: 'urn:openid:params:grant-type:ciba',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    }),
    publishEvent(c, {
      type: TOKEN_EVENTS.REFRESH_ISSUED,
      tenantId: getTenantIdFromContext(c),
      data: {
        jti: refreshTokenJti,
        clientId: metadata.client_id,
        userId: metadata.sub,
        scopes: metadata.scope?.split(' ') ?? [],
        grantType: 'urn:openid:params:grant-type:ciba',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.refresh.issued event', { action: 'Event' }, err as Error);
    }),
  ];

  // ID Token issued event (CIBA grant)
  if (idToken) {
    cibaEventPromises.push(
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId: getTenantIdFromContext(c),
        data: {
          clientId: metadata.client_id,
          userId: metadata.sub,
          grantType: 'urn:openid:params:grant-type:ciba',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      })
    );
  }
  c.executionCtx.waitUntil(Promise.all(cibaEventPromises));

  // Return token response
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    id_token: idToken,
    refresh_token: refreshToken,
    ...buildRefreshTokenExpiryMetadata(nowEpoch, refreshExpiresIn),
    scope: metadata.scope,
  });
}

/**
 * Record token family in the relational index for user-wide revocation support (V3 Sharding)
 *
 * This is a non-blocking operation that records the token family in the
 * user_token_families table. This enables efficient user-wide token revocation
 * by allowing the admin API to query all token families for a user.
 *
 * Note: This is fire-and-forget for performance. Failure does not affect
 * token issuance, but may impact user-wide revocation functionality.
 */
async function recordTokenFamilyIndex(
  db: DatabaseSource | null | undefined,
  tenantId: string,
  jti: string,
  userId: string,
  clientId: string,
  generation: number,
  ttlSeconds: number
): Promise<void> {
  if (!db) {
    return;
  }

  try {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    await recordRefreshTokenFamilyIndex(db, {
      jti,
      tenantId,
      userId,
      clientId,
      generation,
      expiresAt,
    });
  } catch (error) {
    // Log but don't fail - this is a non-critical operation
    moduleLogger.error('Failed to record token family in index', {}, error as Error);
  }
}

// =============================================================================
// RFC 8693: OAuth 2.0 Token Exchange
// =============================================================================

/**
 * Handle Token Exchange Grant (RFC 8693)
 * https://datatracker.ietf.org/doc/html/rfc8693
 *
 * Token Exchange enables:
 * - Cross-domain SSO (WebKit ITP / Firefox ETP bypass)
 * - Service-to-service delegation
 * - Token scope downgrade
 * - Audience restriction
 */
async function handleTokenExchangeGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>,
  rawBody: Record<string, string | File | (string | File)[]>
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  // Check Feature Flag and settings (hybrid: KV > env > default)
  let tokenExchangeEnabled = c.env.ENABLE_TOKEN_EXCHANGE === 'true';
  // Default: only access_token is allowed
  let allowedSubjectTokenTypes: string[] = ['access_token'];
  // Default parameter limits (DoS prevention)
  let maxResourceParams = 10;
  let maxAudienceParams = 10;
  // ID-JAG (Identity Assertion Authorization Grant) configuration
  // draft-ietf-oauth-identity-assertion-authz-grant
  const idJagConfig: IdJagConfig = { ...DEFAULT_ID_JAG_CONFIG };

  // Parse env variables
  if (c.env.TOKEN_EXCHANGE_ALLOWED_TYPES) {
    allowedSubjectTokenTypes = c.env.TOKEN_EXCHANGE_ALLOWED_TYPES.split(',').map((t) => t.trim());
  }
  if (c.env.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS) {
    const parsed = parseInt(c.env.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
      maxResourceParams = parsed;
    }
  }
  if (c.env.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS) {
    const parsed = parseInt(c.env.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
      maxAudienceParams = parsed;
    }
  }

  // KV takes priority over env - request-level cached
  try {
    const settings = await getSystemSettingsCached(c, c.env);
    if (settings) {
      if (settings.oidc?.tokenExchange?.enabled !== undefined) {
        tokenExchangeEnabled = settings.oidc.tokenExchange.enabled === true;
      }
      if (Array.isArray(settings.oidc?.tokenExchange?.allowedSubjectTokenTypes)) {
        allowedSubjectTokenTypes = settings.oidc.tokenExchange.allowedSubjectTokenTypes as string[];
      }
      if (typeof settings.oidc?.tokenExchange?.maxResourceParams === 'number') {
        const value = settings.oidc.tokenExchange.maxResourceParams;
        if (value >= 1 && value <= 100) {
          maxResourceParams = value;
        }
      }
      if (typeof settings.oidc?.tokenExchange?.maxAudienceParams === 'number') {
        const value = settings.oidc.tokenExchange.maxAudienceParams;
        if (value >= 1 && value <= 100) {
          maxAudienceParams = value;
        }
      }
      // ID-JAG (Identity Assertion Authorization Grant) configuration
      // draft-ietf-oauth-identity-assertion-authz-grant
      const idJagSettings = settings.oidc?.tokenExchange?.idJag;
      if (idJagSettings) {
        if (idJagSettings.enabled === true) {
          idJagConfig.enabled = true;
        }
        if (Array.isArray(idJagSettings.allowedIssuers)) {
          idJagConfig.allowedIssuers = idJagSettings.allowedIssuers;
        }
        if (typeof idJagSettings.maxTokenLifetime === 'number') {
          idJagConfig.maxTokenLifetime = idJagSettings.maxTokenLifetime;
        }
        if (typeof idJagSettings.includeTenantClaim === 'boolean') {
          idJagConfig.includeTenantClaim = idJagSettings.includeTenantClaim;
        }
        if (typeof idJagSettings.requireConfidentialClient === 'boolean') {
          idJagConfig.requireConfidentialClient = idJagSettings.requireConfidentialClient;
        }
      }
    }
  } catch {
    // Ignore KV errors, fall back to env
  }

  // Check env fallback for ID-JAG enabled flag
  if (!idJagConfig.enabled && c.env.ENABLE_ID_JAG === 'true') {
    idJagConfig.enabled = true;
  }

  if (!tokenExchangeEnabled) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: 'Token Exchange is not enabled',
      },
      400
    );
  }

  // Extract parameters
  const subject_token = formData.subject_token;
  const subject_token_type = formData.subject_token_type as
    | TokenTypeURN
    | typeof ELEVATION_GRANT_SUBJECT_TOKEN_TYPE
    | undefined;
  const actor_token = formData.actor_token;
  const actor_token_type = formData.actor_token_type as TokenTypeURN | undefined;
  const requestedScope = formData.scope;
  const requested_token_type = formData.requested_token_type as TokenTypeURN | undefined;
  const isNativeSSORequest =
    subject_token_type === 'urn:ietf:params:oauth:token-type:id_token' &&
    (actor_token_type as string) === DEVICE_SECRET_TOKEN_TYPE;
  const nativeSSOChannel = formData.channel;

  // RFC 8693 §2.1: Multiple resource/audience parameters are allowed
  // Helper to extract string array from raw body (handles single value or array)
  const extractStringArray = (key: string): string[] => {
    const value = rawBody[key];
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    return typeof value === 'string' ? [value] : [];
  };

  const resources = extractStringArray('resource');
  const audiences = extractStringArray('audience');

  // DoS prevention: Limit the number of resource/audience parameters (configurable via Admin API)
  // RFC 8693 doesn't specify a limit, but unrestricted arrays could create oversized JWTs
  if (resources.length > maxResourceParams) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Too many resource parameters (max: ${maxResourceParams})`,
      },
      400
    );
  }

  if (audiences.length > maxAudienceParams) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Too many audience parameters (max: ${maxAudienceParams})`,
      },
      400
    );
  }

  // 1. Validate required parameters
  if (!subject_token) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'subject_token is required',
      },
      400
    );
  }

  if (!subject_token_type) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'subject_token_type is required',
      },
      400
    );
  }

  if (isNativeSSORequest && !actor_token) {
    return nativeSSOError(
      c,
      'invalid_request',
      'actor_token is required for Native SSO token exchange',
      'device_secret_missing',
      400,
      'reauthenticate',
      {
        audit: {
          logger: log,
          clientId: formData.client_id,
          subjectTokenType: subject_token_type,
          actorTokenType: actor_token_type as string | undefined,
          requestedAudiences: audiences,
          requestedResources: resources,
        },
      }
    );
  }

  // Validate subject_token_type against allowed types
  // Map short names to full URNs for comparison
  const tokenTypeMap: Record<string, string> = {
    access_token: 'urn:ietf:params:oauth:token-type:access_token',
    jwt: 'urn:ietf:params:oauth:token-type:jwt',
    id_token: 'urn:ietf:params:oauth:token-type:id_token',
    refresh_token: 'urn:ietf:params:oauth:token-type:refresh_token',
    elevation_grant: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
  };

  // Build allowed URNs from settings
  const allowedURNs = allowedSubjectTokenTypes
    .map((t) => tokenTypeMap[t] || t)
    .filter((t) => t !== undefined);
  if (!allowedURNs.includes(ELEVATION_GRANT_SUBJECT_TOKEN_TYPE)) {
    allowedURNs.push(ELEVATION_GRANT_SUBJECT_TOKEN_TYPE);
  }

  // Check if subject_token_type is allowed
  if (!allowedURNs.includes(subject_token_type)) {
    const allowedTypes = allowedSubjectTokenTypes.join(', ');
    return c.json(
      {
        error: 'invalid_request',
        error_description: `subject_token_type '${subject_token_type}' is not allowed. Allowed types: ${allowedTypes}`,
      },
      400
    );
  }

  // Additional security check: refresh_token is never allowed (even if misconfigured)
  if (subject_token_type === 'urn:ietf:params:oauth:token-type:refresh_token') {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'refresh_token cannot be used as subject_token for security reasons',
      },
      400
    );
  }

  // 2. Client Authentication (supports 4 methods)
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    try {
      const assertionPayload = parseToken(client_assertion);
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      }
    } catch {
      return oauthError(c, 'invalid_client', 'Invalid client_assertion format', 401);
    }
  }

  // Check HTTP Basic authentication
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Fetch client metadata - request-level cached
  const clientMetadata = await getClientCached(c, c.env, client_id!);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Cast to ClientMetadata for type safety
  const typedClient = clientMetadata as unknown as ClientMetadata;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if ((await isDPoPRequiredForTokenRequest(c, typedClient)) && !dpopProof) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  // Profile-based grant_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §5.2: unauthorized_client - client not allowed to use this grant type
  const tenantId = (clientMetadata.tenant_id as string) || getTenantIdFromContext(c);
  const tenantProfile = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId);
  if (!tenantProfile.allows_token_exchange) {
    return oauthError(
      c,
      'unauthorized_client',
      'token_exchange grant is not allowed for this tenant profile',
      403
    );
  }

  const isNativeSSOPublicClientAuthException =
    isNativeSSORequest &&
    !typedClient.client_secret_hash &&
    typedClient.token_endpoint_auth_method === 'none';

  // 3. Authenticate client
  const clientAuthenticationPolicy = await resolveTokenClientAuthenticationPolicy(
    c,
    typedClient,
    client_assertion,
    client_assertion_type
  );
  if (!clientAuthenticationPolicy.ok) {
    return clientAuthenticationPolicy.response;
  }
  if (isNativeSSOPublicClientAuthException) {
    if (nativeSSOChannel !== 'native') {
      return oauthError(
        c,
        'invalid_request',
        'Native SSO public client token exchange requires channel=native',
        400
      );
    }

    if (typedClient.application_type !== 'native') {
      return oauthError(
        c,
        'unauthorized_client',
        'Client is not eligible for Native SSO public client token exchange',
        403
      );
    }

    if (!dpopProof) {
      return nativeSSOError(
        c,
        'invalid_request',
        'DPoP proof is required for Native SSO token exchange',
        'dpop_proof_missing',
        400,
        'reauthenticate',
        {
          audit: {
            logger: log,
            clientId: client_id,
            subjectTokenType: subject_token_type,
            actorTokenType: actor_token_type as string | undefined,
            requestedAudiences: audiences,
            requestedResources: resources,
          },
        }
      );
    }
  } else if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${getRequestIssuer(c)}/token`,
      typedClient,
      clientAuthenticationPolicy.assertionOptions
    );
    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(c, 'invalid_client', 'Client assertion validation failed', 401);
    }
  } else if (typedClient.client_secret_hash) {
    // client_secret_basic or client_secret_post
    // Security: Verify client secret against stored SHA-256 hash
    if (
      !client_secret ||
      !(await verifyClientSecretHash(client_secret, typedClient.client_secret_hash))
    ) {
      return oauthError(c, 'invalid_client', 'Invalid client credentials', 401);
    }
  } else {
    // Public clients (no client_secret_hash, no client_assertion) are NOT allowed to use Token Exchange
    // RFC 8693 allows optional client auth, but for enterprise security, we require authentication.
    // This prevents unauthorized token exchange by public clients.
    return oauthError(
      c,
      'invalid_client',
      'Client authentication is required for Token Exchange',
      401
    );
  }

  // 4. Check if client is allowed to use Token Exchange
  if (!typedClient.token_exchange_allowed) {
    return oauthError(c, 'unauthorized_client', 'Client is not authorized for Token Exchange', 403);
  }

  // Check delegation_mode
  const delegationMode = typedClient.delegation_mode || 'delegation';
  if (delegationMode === 'none') {
    return oauthError(c, 'unauthorized_client', 'Token Exchange is disabled for this client', 403);
  }

  // ===== OIDC Native SSO 1.0 (draft-07) Token Exchange Extension =====
  // Detect Native SSO pattern: id_token + device-secret
  // Note: actor_token_type is compared as string because DEVICE_SECRET_TOKEN_TYPE
  // is a custom URN not included in the standard TokenTypeURN union
  const isElevationGrantSubjectTokenRequest =
    subject_token_type === ELEVATION_GRANT_SUBJECT_TOKEN_TYPE;

  if (isNativeSSORequest) {
    return handleNativeSSOTokenExchange(
      c,
      subject_token,
      actor_token!, // device_secret
      client_id!,
      typedClient,
      requestedScope,
      resources,
      audiences
    );
  }

  // 5. Validate requested_token_type (RFC 8693 §2.2.1)
  // Supported token types: access_token (always), id-jag (when enabled)
  const isIdJagTokenRequest = isIdJagRequest(requested_token_type);

  if (requested_token_type) {
    const isValidAccessToken =
      requested_token_type === 'urn:ietf:params:oauth:token-type:access_token';

    // ID-JAG token type is only valid when ID-JAG is enabled
    if (isIdJagTokenRequest && !idJagConfig.enabled) {
      return oauthError(
        c,
        'invalid_request',
        'ID-JAG token type is not enabled. Enable it via Admin API.',
        400
      );
    }

    // Only access_token and id-jag (when enabled) are supported
    if (!isValidAccessToken && !isIdJagTokenRequest) {
      return oauthError(
        c,
        'invalid_request',
        'Only access_token and id-jag (when enabled) are supported as requested_token_type',
        400
      );
    }
  }

  // ID-JAG specific validations (draft-ietf-oauth-identity-assertion-authz-grant)
  if (isIdJagTokenRequest) {
    // §3.1: subject_token_type MUST be id_token, jwt, or saml2
    if (!isValidIdJagSubjectTokenType(subject_token_type!)) {
      return oauthError(
        c,
        'invalid_request',
        `ID-JAG requires subject_token_type to be id_token, jwt, or saml2. Got: ${subject_token_type}`,
        400
      );
    }

    // §3.2: SHOULD only be supported for confidential clients
    if (
      idJagConfig.requireConfidentialClient &&
      typedClient.token_endpoint_auth_method === 'none'
    ) {
      return oauthError(
        c,
        'invalid_client',
        'ID-JAG tokens can only be issued to confidential clients',
        400
      );
    }
  }

  // 6. Parse and validate subject_token
  let subjectTokenPayload: Record<string, unknown>;
  let subjectTokenHeader;
  try {
    subjectTokenPayload = parseToken(subject_token);
    subjectTokenHeader = parseTokenHeader(subject_token);
  } catch {
    return oauthError(c, 'invalid_request', 'Invalid subject_token format', 400);
  }

  // Get verification key from header (kid is in JWT header, NOT payload)
  const subjectTokenKid = subjectTokenHeader.kid;
  if (!subjectTokenKid) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Subject token is missing kid in header',
      },
      400
    );
  }

  // Performance optimization: Fetch public key and check revocation in parallel
  // These two DO calls are independent and can be executed concurrently
  const subjectJti = subjectTokenPayload.jti as string | undefined;
  const subjectIssuer = subjectTokenPayload.iss as string | undefined;

  // ID-JAG: subject_token comes from external IdP, verify against allowedIssuers
  let originalIssuer: string | undefined;
  if (isIdJagTokenRequest) {
    // Validate subject_token issuer against allowed issuers
    if (!subjectIssuer) {
      return oauthError(c, 'invalid_grant', 'Subject token is missing issuer (iss) claim', 400);
    }

    // SECURITY: Require explicit allowedIssuers configuration for ID-JAG
    // Empty allowedIssuers means no external IdPs are trusted (fail-secure)
    if (idJagConfig.allowedIssuers.length === 0) {
      log.warn('ID-JAG: No allowed issuers configured - rejecting request', {
        subjectIssuer,
        action: 'TokenExchange',
      });
      return oauthError(
        c,
        'invalid_grant',
        'ID-JAG is enabled but no allowed issuers are configured. Configure allowedIssuers via Admin API.',
        400
      );
    }

    // Check if issuer is in the allowed list
    if (!idJagConfig.allowedIssuers.includes(subjectIssuer)) {
      log.warn('ID-JAG: Subject token issuer not in allowed list', {
        subjectIssuer,
        allowedIssuers: idJagConfig.allowedIssuers,
        action: 'TokenExchange',
      });
      return oauthError(
        c,
        'invalid_grant',
        `Subject token issuer '${subjectIssuer}' is not in the allowed issuers list`,
        400
      );
    }

    originalIssuer = subjectIssuer;

    const externalAudiences = [client_id!, ...(typedClient.allowed_subject_token_clients || [])];
    try {
      subjectTokenPayload = (await verifyExternalIdJagSubjectToken({
        token: subject_token,
        issuer: subjectIssuer,
        audiences: [...new Set(externalAudiences)],
      })) as Record<string, unknown>;
      log.info('ID-JAG: Verified external IdP subject token', {
        subjectIssuer,
        subjectTokenKid,
        action: 'TokenExchange',
      });
    } catch (error) {
      log.warn('ID-JAG: External subject token verification failed', {
        subjectIssuer,
        subjectTokenKid,
        reason: error instanceof Error ? error.message : 'unknown_error',
        action: 'TokenExchange',
      });
      return oauthError(c, 'invalid_grant', 'Subject token verification failed', 400);
    }
  }

  // For non-ID-JAG requests or when verifying our own tokens
  const [publicKey, revoked] = await Promise.all([
    // Only fetch our own JWKS for non-ID-JAG requests
    isIdJagTokenRequest
      ? Promise.resolve(null)
      : getVerificationKeyFromJWKS(c.env, getTenantIdFromContext(c), subjectTokenKid),
    subjectJti
      ? isTokenRevoked(c.env, subjectJti, getTenantIdFromContext(c))
      : Promise.resolve(false),
  ]);

  // Verify first-party subject_token signature (aud validated separately).
  // ID-JAG external tokens were verified against the issuer's discovered JWKS above.
  if (!isIdJagTokenRequest && publicKey) {
    try {
      // Verify signature and issuer only; audience is validated in the authorization check below
      await verifyToken(subject_token, publicKey, getRequestIssuer(c), {
        skipAudienceCheck: true, // We validate audience ourselves in Token Exchange
      });
    } catch (error) {
      log.error('Subject token verification failed', {}, error as Error);
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Subject token verification failed',
        },
        400
      );
    }
  }

  // Check subject_token expiration
  const now = Math.floor(Date.now() / 1000);
  const subjectExp = subjectTokenPayload.exp as number | undefined;
  if (subjectExp && subjectExp < now) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Subject token has expired',
      },
      400
    );
  }

  // Check if subject_token is revoked (result already fetched in parallel above)
  if (revoked) {
    return c.json(
      {
        error: 'invalid_grant',
        error_description: 'Subject token has been revoked',
      },
      400
    );
  }

  let elevationGrantContext: Awaited<ReturnType<typeof resolveElevationGrantSubjectToken>> | null =
    null;
  if (isElevationGrantSubjectTokenRequest) {
    try {
      const adminAdapter = requireDedicatedAdminDatabaseAdapter(
        c.env,
        'token-exchange-elevation-grant'
      );
      elevationGrantContext = await resolveElevationGrantSubjectToken({
        adapter: adminAdapter,
        tenantId,
        requestingClientId: client_id!,
        tokenPayload: subjectTokenPayload,
      });
    } catch (error) {
      return oauthError(
        c,
        'invalid_grant',
        error instanceof Error ? error.message : 'Invalid elevation grant subject token',
        400
      );
    }
  }

  // 7. Audience validation (Cross-tenant escalation prevention)
  // This is CRITICAL for security - prevents stealing tokens meant for other clients
  const subjectAud = subjectTokenPayload.aud as string | string[] | undefined;
  const subjectClientId =
    (subjectTokenPayload.client_id as string | undefined) ??
    (subjectTokenPayload.azp as string | undefined);
  const allowedSubjectClients = typedClient.allowed_subject_token_clients || [];
  const subjectAudArray = Array.isArray(subjectAud) ? subjectAud : subjectAud ? [subjectAud] : [];

  // Check 1: Is the requesting client in the subject_token's audience?
  // (client_id must be explicitly in aud, NOT just issuer URL)
  const isClientInAudience = subjectAudArray.includes(client_id!);

  // Check 2: Is the subject_token's issuing client in our allowed list?
  const isAllowedSubjectClient =
    allowedSubjectClients.length > 0 &&
    allowedSubjectClients.includes(subjectClientId || '') &&
    subjectAudArray.includes(subjectClientId || '');

  // SECURITY: Reject if neither condition is met
  // - Client must be explicitly authorized via audience or allowed_subject_token_clients
  // - Issuer URL in aud is NOT sufficient (prevents cross-client token theft)
  if (!isClientInAudience && !isAllowedSubjectClient) {
    return c.json(
      {
        error: 'invalid_target',
        error_description: 'Client is not authorized to exchange this token',
      },
      403
    );
  }

  // 7. Scope handling (RFC 8693 §2.1)
  // Options: inherit from subject_token, explicitly request subset, or let client.allowed_scopes limit
  const subjectScope = subjectTokenPayload.scope as string | undefined;
  const subjectScopes = subjectScope ? subjectScope.split(' ') : [];

  // Track scope source for audit logging
  const scopeSource: 'explicit' | 'inherited' = requestedScope ? 'explicit' : 'inherited';
  const requestedScopes = requestedScope ? requestedScope.split(' ') : subjectScopes;
  const allowedScopes = typedClient.allowed_scopes || [];

  // Intersection: requested ∩ subject ∩ client.allowed_scopes
  // This ensures scope can only be downgraded, never escalated
  let grantedScopes = requestedScopes;
  if (subjectScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => subjectScopes.includes(s));
  }
  if (allowedScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => allowedScopes.includes(s));
  }

  const grantedScope = grantedScopes.join(' ') || 'openid';

  // Detect scope changes for security audit
  const scopeDowngraded = subjectScopes.length > 0 && grantedScopes.length < subjectScopes.length;
  const removedScopes = subjectScopes.filter((s) => !grantedScopes.includes(s));

  // 8. Resource/Audience validation (RFC 8693 §2.1)
  // RFC 8693 allows multiple resource and audience parameters
  // aud claim will be an array combining both
  let targetAudiences: string[] = [];
  let audienceSource:
    | 'audience_param'
    | 'resource_param'
    | 'both'
    | 'default'
    | 'client_default_resource'
    | 'client_default_audience';

  // RFC 8693 §2.1: Each resource MUST be an absolute URI without fragment
  for (const res of resources) {
    try {
      const resourceUrl = new URL(res);
      // Validate: must be absolute URI with http/https scheme
      if (!['http:', 'https:'].includes(resourceUrl.protocol)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `resource '${res}' must be an absolute URI with http or https scheme`,
          },
          400
        );
      }
      // RFC 8693: MUST NOT include a fragment component
      if (resourceUrl.hash) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `resource '${res}' must not include a fragment component`,
          },
          400
        );
      }
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `resource '${res}' must be a valid absolute URI`,
        },
        400
      );
    }
  }

  // Build target audiences array (audiences first, then resources)
  // This follows RFC 8693's logical vs location-based identifier hierarchy
  if (audiences.length > 0 && resources.length > 0) {
    targetAudiences = [...audiences, ...resources];
    audienceSource = 'both';
  } else if (audiences.length > 0) {
    targetAudiences = audiences;
    audienceSource = 'audience_param';
  } else if (resources.length > 0) {
    targetAudiences = resources;
    audienceSource = 'resource_param';
  } else {
    const clientDefault = getClientDefaultResource(typedClient);
    if (!clientDefault.value || !clientDefault.source) {
      return c.json(
        {
          error: 'invalid_target',
          error_description: 'No target resource is configured for this access token',
        },
        400
      );
    }
    targetAudiences = [clientDefault.value];
    audienceSource = clientDefault.source;
  }

  // Validate against allowed resources (all targets must be allowed)
  const allowedResources = typedClient.allowed_token_exchange_resources || [];
  if (allowedResources.length > 0) {
    const disallowedTargets = targetAudiences.filter((t) => !allowedResources.includes(t));
    if (disallowedTargets.length > 0) {
      return c.json(
        {
          error: 'invalid_target',
          error_description: `Requested audience/resource not allowed: ${disallowedTargets.join(', ')}`,
        },
        403
      );
    }
  }

  // 9. Actor token validation (for delegation mode)
  let actClaim: ActClaim | undefined;

  if (delegationMode === 'delegation') {
    // SECURITY: If actor_token is provided, actor_token_type MUST also be provided
    // Otherwise, the actor_token is silently ignored and the client becomes the actor
    if (actor_token && !actor_token_type) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'actor_token_type is required when actor_token is provided',
        },
        400
      );
    }

    if (actor_token && actor_token_type) {
      // Validate actor_token_type (only access_token supported)
      if (actor_token_type !== 'urn:ietf:params:oauth:token-type:access_token') {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Only access_token is supported as actor_token_type',
          },
          400
        );
      }

      // Validate actor_token
      let actorTokenPayload: Record<string, unknown>;
      let actorTokenHeader;
      try {
        actorTokenPayload = parseToken(actor_token);
        actorTokenHeader = parseTokenHeader(actor_token);
      } catch {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Invalid actor_token format',
          },
          400
        );
      }

      // Get kid from header (NOT payload)
      const actorTokenKid = actorTokenHeader.kid;
      if (!actorTokenKid) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token is missing kid in header',
          },
          400
        );
      }

      try {
        const actorPublicKey = await getVerificationKeyFromJWKS(
          c.env,
          getTenantIdFromContext(c),
          actorTokenKid
        );
        // Verify signature and issuer only; audience is validated below
        await verifyToken(actor_token, actorPublicKey, getRequestIssuer(c), {
          skipAudienceCheck: true, // We validate audience ourselves after this
        });
      } catch (error) {
        log.error('Actor token signature verification failed', {}, error as Error);
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token verification failed',
          },
          400
        );
      }

      // Check actor_token expiration
      const actorExp = actorTokenPayload.exp as number | undefined;
      if (actorExp && actorExp < now) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token has expired',
          },
          400
        );
      }

      // Check if actor_token is revoked
      const actorJti = actorTokenPayload.jti as string | undefined;
      if (actorJti) {
        const actorRevoked = await isTokenRevoked(c.env, actorJti, getTenantIdFromContext(c));
        if (actorRevoked) {
          return c.json(
            {
              error: 'invalid_grant',
              error_description: 'Actor token has been revoked',
            },
            400
          );
        }
      }

      // Validate actor_token audience (security: prevent use of tokens meant for other resources)
      // Actor token MUST have an aud claim and it should contain the requesting client_id or the issuer URL
      const actorAud = actorTokenPayload.aud as string | string[] | undefined;
      const actorAudArray = Array.isArray(actorAud) ? actorAud : actorAud ? [actorAud] : [];

      // SECURITY: Reject actor tokens without aud claim
      // Tokens without aud could be used by any client, enabling token theft attacks
      if (actorAudArray.length === 0) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token must have an audience claim',
          },
          400
        );
      }

      const isActorAudValid =
        actorAudArray.includes(client_id!) || actorAudArray.includes(getRequestIssuer(c));

      if (!isActorAudValid) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: 'Actor token audience does not match requesting client',
          },
          400
        );
      }

      // Build act claim with potential nesting (max 2 levels)
      const existingAct = subjectTokenPayload.act as ActClaim | undefined;

      actClaim = {
        sub: actorTokenPayload.sub as string,
        client_id: actorTokenPayload.client_id as string | undefined,
        // Only nest 1 level (prevent infinite chains)
        ...(existingAct && !existingAct.act ? { act: existingAct } : {}),
      };
    } else if (elevationGrantContext) {
      actClaim = elevationGrantContext.actClaim;
    } else {
      // No actor_token, use client as actor
      actClaim = {
        sub: `client:${client_id}`,
        client_id: client_id!,
      };
    }
  }
  // impersonation mode: no act claim

  // 10. Generate new access token
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load signing key',
      },
      500
    );
  }

  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

  // DPoP support
  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env, // Pass full Env for region-aware sharding
      client_id!,
      getTenantIdFromContext(c)
    );
    if (!dpopValidation.valid) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP validation failed',
        clientMetadata: typedClient,
        resources,
      });
    }
    dpopJkt = dpopValidation.jkt;
  }

  // Build access token claims
  const subjectSub = subjectTokenPayload.sub as string;
  // RFC 8693: aud can be a single string or array of strings
  // Use single string if only one audience, array otherwise (for JWT compactness)
  const audClaim = targetAudiences.length === 1 ? targetAudiences[0] : targetAudiences;

  // ID-JAG: Use configured token lifetime if it's shorter than default
  const idJagExpiresIn = isIdJagTokenRequest
    ? Math.min(expiresIn, idJagConfig.maxTokenLifetime)
    : expiresIn;

  const accessTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: subjectSub,
    aud: audClaim,
    scope: grantedScope,
    client_id: client_id,
    // Add act claim for delegation
    ...(actClaim ? { act: actClaim } : {}),
    ...(elevationGrantContext && {
      authorization_details: elevationGrantContext.authorizationDetails,
      authrim_elevation: {
        grant_id: elevationGrantContext.grant.public_grant_id,
        request_id: elevationGrantContext.request.public_request_id,
        investigation_id: elevationGrantContext.request.investigation_id,
        target_subject_type: elevationGrantContext.request.target_subject_type,
        target_subject_id: elevationGrantContext.request.target_subject_id,
        requester_subject_type: elevationGrantContext.request.requester_subject_type,
        requester_subject_id: elevationGrantContext.request.requester_subject_id,
        resource_class: elevationGrantContext.grant.resource_class,
        redaction_level: elevationGrantContext.grant.redaction_level,
      },
    }),
    // Add resource URIs if specified (RFC 8693 §2.2.1)
    ...(resources.length > 0
      ? { resource: resources.length === 1 ? resources[0] : resources }
      : {}),
    // Add DPoP confirmation
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
    // ID-JAG specific claims (draft-ietf-oauth-identity-assertion-authz-grant)
    // original_issuer: The IdP that originally issued the subject_token
    ...(isIdJagTokenRequest && originalIssuer ? { original_issuer: originalIssuer } : {}),
    // Include tenant claim for multi-tenant scenarios
    ...(isIdJagTokenRequest && idJagConfig.includeTenantClaim && tenantId
      ? { tenant: tenantId }
      : {}),
    // Preserve acr/amr from subject_token if present (authentication context)
    ...(isIdJagTokenRequest && subjectTokenPayload.acr ? { acr: subjectTokenPayload.acr } : {}),
    ...(isIdJagTokenRequest && subjectTokenPayload.amr ? { amr: subjectTokenPayload.amr } : {}),
  };

  // Use ID-JAG expires_in if this is an ID-JAG request
  const effectiveExpiresIn = isIdJagTokenRequest ? idJagExpiresIn : expiresIn;

  let accessToken: string;
  let accessTokenJti: string;
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      effectiveExpiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create access token',
      },
      500
    );
  }

  // Token Exchange does NOT issue refresh tokens (stateless by design)

  // Audit log for Token Exchange (helps with security monitoring and debugging)
  // Maps URN to short name for readability
  const tokenTypeShortName: Record<string, string> = {
    'urn:ietf:params:oauth:token-type:access_token': 'access_token',
    'urn:ietf:params:oauth:token-type:jwt': 'jwt',
    'urn:ietf:params:oauth:token-type:id_token': 'id_token',
    [TOKEN_TYPE_ID_JAG]: 'id-jag',
  };
  log.info('Token Exchange Success', {
    clientId: client_id,
    subjectTokenType: tokenTypeShortName[subject_token_type] || subject_token_type,
    subjectSub,
    delegationMode,
    hasActorToken: !!actor_token,
    actorSub: actClaim?.sub,
    elevationGrantId: elevationGrantContext?.grant.public_grant_id,
    targetAudiences,
    audienceSource,
    resourceCount: resources.length,
    audienceCount: audiences.length,
    scopeSource,
    subjectScope: subjectScope || '(none)',
    grantedScope,
    scopeDowngraded,
    ...(removedScopes.length > 0 && { removedScopes }),
    tokenBinding: dpopProof ? 'DPoP' : 'Bearer',
    jti: accessTokenJti,
    // ID-JAG specific logging
    isIdJagRequest: isIdJagTokenRequest,
    ...(isIdJagTokenRequest && { originalIssuer }),
    action: 'TokenExchange',
  });

  // Publish token event (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId,
      data: {
        jti: accessTokenJti,
        clientId: client_id,
        userId: subjectSub,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + effectiveExpiresIn,
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    })
  );

  // Set cache control headers
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  // Determine issued_token_type for response
  // For ID-JAG requests, return the id-jag token type
  const issuedTokenType: TokenTypeURN = isIdJagTokenRequest
    ? TOKEN_TYPE_ID_JAG
    : requested_token_type || 'urn:ietf:params:oauth:token-type:access_token';

  return c.json({
    access_token: accessToken,
    issued_token_type: issuedTokenType,
    token_type: dpopProof ? 'DPoP' : 'Bearer',
    expires_in: effectiveExpiresIn,
    scope: grantedScope,
  });
}

// =============================================================================
// OIDC Native SSO 1.0 (draft-07): Native SSO Token Exchange
// =============================================================================

/**
 * Handle Native SSO Token Exchange (OIDC Native SSO 1.0)
 * https://openid.net/specs/openid-connect-native-sso-1_0.html
 *
 * Native SSO enables seamless SSO between mobile/desktop apps sharing a Keychain.
 * - App A authenticates and receives device_secret
 * - App B uses device_secret + ID Token to get tokens without user interaction
 *
 * Security:
 * - device_secret is validated using SHA-256 hash lookup
 * - ID Token is verified for signature, issuer, expiration
 * - Cross-client SSO requires explicit configuration
 * - Rate limiting protects against brute-force attacks
 */
async function handleNativeSSOTokenExchange(
  c: Context<{ Bindings: Env }>,
  idToken: string,
  deviceSecret: string,
  clientId: string,
  clientMetadata: ClientMetadata,
  requestedScope?: string,
  requestedResources: string[] = [],
  requestedAudiences: string[] = []
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  const tenantId = getTenantIdFromContext(c);
  const failureAudit: NativeSSOFailureAuditContext = {
    logger: log,
    clientId,
    subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
    actorTokenType: DEVICE_SECRET_TOKEN_TYPE,
    requestedAudiences,
    requestedResources,
  };
  const exchangeError = (
    error: string,
    errorDescription: string,
    code: NativeSSOErrorDetailCode,
    status: 400 | 401 | 403 | 429 | 500 = 400,
    userAction: Phase1ErrorDetailUserAction = 'reauthenticate',
    options: {
      retryable?: boolean;
      severity?: Phase1ErrorDetailSeverity;
      retryAfterSeconds?: number;
    } = {}
  ) =>
    nativeSSOError(c, error, errorDescription, code, status, userAction, {
      ...options,
      audit: failureAudit,
    });
  const exchangeInvalidGrant = (errorDescription: string, code: NativeSSOErrorDetailCode) =>
    nativeSSOInvalidGrant(c, errorDescription, code, { audit: failureAudit });

  // 1. Check Native SSO feature flag
  const nativeSSOEnabled = await isNativeSSOEnabled(c.env);
  if (!nativeSSOEnabled) {
    return exchangeError(
      'unsupported_grant_type',
      'Native SSO is not enabled',
      'native_sso_disabled',
      400,
      'contact_support'
    );
  }

  // 2. Check if client supports Native SSO
  const clientNativeSSOEnabled = isNativeSSOClientEnabled(clientMetadata);
  if (!clientNativeSSOEnabled) {
    return exchangeError(
      'unauthorized_client',
      'Client is not configured for Native SSO',
      'native_sso_client_disabled',
      403,
      'contact_support'
    );
  }

  const authCtx = createAuthContextFromHono(c, tenantId);
  const deviceSecretRepo = new DeviceSecretRepository(authCtx.coreAdapter, tenantId);
  const deviceInstallationRepo = new DeviceInstallationRepository(authCtx.coreAdapter, tenantId);
  const nativeSSOConfig = await getNativeSSOConfig(c.env);

  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if (!dpopProof) {
    return exchangeError(
      'invalid_request',
      'DPoP proof is required for Native SSO token exchange',
      'dpop_proof_missing'
    );
  }

  const dpopValidation = await validateDPoPProof(
    dpopProof,
    c.req.method,
    c.req.url,
    undefined,
    c.env,
    clientId,
    getTenantIdFromContext(c)
  );
  if (!dpopValidation.valid) {
    if (dpopValidation.error === 'use_dpop_nonce') {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP validation failed',
        clientMetadata,
        resources: requestedResources,
      });
    }

    return exchangeError(
      'invalid_request',
      dpopValidation.error_description || 'DPoP validation failed',
      'dpop_proof_invalid'
    );
  }
  const dpopJkt = dpopValidation.jkt;
  if (!dpopJkt) {
    return exchangeError(
      'invalid_request',
      'DPoP proof is missing key thumbprint',
      'dpop_proof_invalid'
    );
  }

  // 3b. Rate limiting for brute-force protection (checked BEFORE validation)
  // Use client_id + IP as key since we don't know user_id until validation
  if (c.env.AUTHRIM_CONFIG) {
    const clientIP =
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const rateLimitKey = `native-sso:ratelimit:${clientId}:${clientIP}`;

    try {
      const rateLimitData = await c.env.AUTHRIM_CONFIG.get(rateLimitKey);
      const { maxAttemptsPerMinute, blockDurationMinutes } = nativeSSOConfig.rateLimit;

      if (rateLimitData) {
        const { count, blockedUntil } = JSON.parse(rateLimitData) as {
          count: number;
          blockedUntil?: number;
        };

        // Check if currently blocked
        if (blockedUntil && Date.now() < blockedUntil) {
          const remainingSeconds = Math.ceil((blockedUntil - Date.now()) / 1000);
          log.warn('Rate limit blocked', {
            clientId,
            clientIP,
            remainingSeconds,
            action: 'NativeSSO',
          });
          return exchangeError(
            'slow_down',
            `Too many attempts. Please wait ${remainingSeconds} seconds.`,
            'native_sso_rate_limited',
            429,
            'retry',
            {
              retryable: true,
              severity: 'warning',
              retryAfterSeconds: remainingSeconds,
            }
          );
        }

        // Check if approaching limit
        if (count >= maxAttemptsPerMinute) {
          // Block for the configured duration
          const blockedUntilTime = Date.now() + blockDurationMinutes * 60 * 1000;
          await c.env.AUTHRIM_CONFIG.put(
            rateLimitKey,
            JSON.stringify({ count: count + 1, blockedUntil: blockedUntilTime }),
            { expirationTtl: blockDurationMinutes * 60 + 60 }
          );
          log.warn('Rate limit triggered', {
            clientId,
            clientIP,
            blockDurationMinutes,
            action: 'NativeSSO',
          });
          return exchangeError(
            'slow_down',
            `Too many attempts. Please wait ${blockDurationMinutes} minutes.`,
            'native_sso_rate_limited',
            429,
            'retry',
            {
              retryable: true,
              severity: 'warning',
              retryAfterSeconds: blockDurationMinutes * 60,
            }
          );
        }

        // Increment counter
        await c.env.AUTHRIM_CONFIG.put(rateLimitKey, JSON.stringify({ count: count + 1 }), {
          expirationTtl: 60,
        });
      } else {
        // First attempt in this window
        await c.env.AUTHRIM_CONFIG.put(rateLimitKey, JSON.stringify({ count: 1 }), {
          expirationTtl: 60,
        });
      }
    } catch (error) {
      // Log but don't block on rate limit errors (fail-open for availability)
      log.error('Rate limit check error', { action: 'NativeSSO' }, error as Error);
    }
  }

  // 4. Validate device_secret (this also marks it as used)
  // Pass maxUseCountPerSecret from config for replay attack prevention
  const deviceSecretValidation = await deviceSecretRepo.validateAndUse(deviceSecret, {
    maxUseCount: nativeSSOConfig.maxUseCountPerSecret,
    tenantId,
  });
  if (!deviceSecretValidation.ok) {
    const errorMessages: Record<string, string> = {
      not_found: 'Device secret not found or invalid',
      expired: 'Device secret has expired',
      revoked: 'Device secret has been revoked',
      mismatch: 'Device secret validation failed',
      limit_exceeded: 'Device secret use count exceeded - please re-authenticate',
    };
    return exchangeInvalidGrant(
      errorMessages[deviceSecretValidation.reason] || 'Invalid device secret',
      'device_secret_inactive'
    );
  }

  const validatedDeviceSecret = deviceSecretValidation.entity;
  const deviceSecretUserId = validatedDeviceSecret.user_id;

  // 5. Parse and validate ID Token
  let idTokenPayload: Record<string, unknown>;
  let idTokenHeader;
  try {
    idTokenPayload = parseToken(idToken);
    idTokenHeader = parseTokenHeader(idToken);
  } catch {
    return exchangeInvalidGrant('Invalid ID token format', 'id_token_malformed');
  }

  // Get verification key from header
  const idTokenKid = idTokenHeader.kid;
  if (!idTokenKid) {
    return exchangeInvalidGrant('ID token is missing kid in header', 'id_token_signature_invalid');
  }

  const expectedIssuer = getRequestIssuer(c);
  const idTokenIssuer = idTokenPayload.iss;
  if (typeof idTokenIssuer !== 'string' || idTokenIssuer !== expectedIssuer) {
    return exchangeInvalidGrant('ID token issuer is invalid', 'id_token_issuer_invalid');
  }

  const idTokenAudArray = normalizeNativeSSOAudience(idTokenPayload.aud);
  if (!idTokenAudArray) {
    return exchangeInvalidGrant('ID token audience is invalid', 'id_token_audience_invalid');
  }
  const idTokenClientId =
    typeof idTokenPayload.client_id === 'string' ? idTokenPayload.client_id : undefined;
  if (idTokenClientId && !idTokenAudArray.includes(idTokenClientId)) {
    return exchangeInvalidGrant('ID token audience is invalid', 'id_token_audience_invalid');
  }
  if (!idTokenClientId && !idTokenAudArray.some((audience) => audience !== expectedIssuer)) {
    return exchangeInvalidGrant('ID token audience is invalid', 'id_token_audience_invalid');
  }

  // Verify ID Token signature
  try {
    const publicKey = await getVerificationKeyFromJWKS(c.env, tenantId, idTokenKid);
    await verifyToken(idToken, publicKey, expectedIssuer, {
      skipAudienceCheck: true, // We validate audience ourselves
    });
  } catch (error) {
    log.error('ID token verification failed', { action: 'NativeSSO' }, error as Error);
    return exchangeInvalidGrant('ID token verification failed', 'id_token_signature_invalid');
  }

  // Check ID Token expiration
  const now = Math.floor(Date.now() / 1000);
  const idTokenExp = typeof idTokenPayload.exp === 'number' ? idTokenPayload.exp : undefined;
  if (!idTokenExp || idTokenExp + NATIVE_SSO_ID_TOKEN_CLOCK_SKEW_SECONDS < now) {
    return exchangeInvalidGrant('ID token has expired', 'id_token_expired');
  }

  if (!(await validateNativeSSODeviceSecretBinding(idTokenPayload, deviceSecret))) {
    log.warn('Device secret binding failed', { action: 'NativeSSO' });
    return exchangeInvalidGrant(
      'ID token device secret binding validation failed',
      'device_secret_binding_failed'
    );
  }

  // 5b. ID Token jti replay attack prevention
  // Store used jti in KV to prevent replay attacks
  const idTokenJti = idTokenPayload.jti as string | undefined;
  if (idTokenJti && c.env.AUTHRIM_CONFIG) {
    const jtiKey = `native-sso:jti:${idTokenJti}`;
    const existingJti = await c.env.AUTHRIM_CONFIG.get(jtiKey);

    if (existingJti) {
      log.warn('ID Token replay detected', {
        jtiPrefix: idTokenJti.substring(0, 8),
        action: 'NativeSSO',
      });
      return exchangeInvalidGrant('ID token has already been used', 'id_token_replayed');
    }

    // Store jti with expiration = remaining ID token lifetime + 60s buffer
    // This prevents replay but doesn't waste storage after token expires
    const ttlSeconds = idTokenExp ? Math.max(60, idTokenExp - now + 60) : 3600;
    await c.env.AUTHRIM_CONFIG.put(jtiKey, '1', { expirationTtl: ttlSeconds });
  }

  // 6. Verify user_id matches between ID Token and device_secret
  const idTokenSub = idTokenPayload.sub as string;
  if (typeof idTokenSub !== 'string' || idTokenSub.length === 0) {
    return exchangeInvalidGrant('ID token subject is missing', 'id_token_malformed');
  }

  if (idTokenSub !== deviceSecretUserId) {
    log.warn('User mismatch', {
      idTokenSubPrefix: idTokenSub.substring(0, 8),
      deviceSecretUserPrefix: deviceSecretUserId.substring(0, 8),
      action: 'NativeSSO',
    });
    return exchangeInvalidGrant(
      'ID token subject does not match device secret owner',
      'device_secret_binding_failed'
    );
  }

  // 7. Cross-client SSO check
  const originalClientId =
    idTokenClientId ||
    (idTokenAudArray[0] !== getRequestIssuer(c) ? idTokenAudArray[0] : undefined);

  const isSameClient = originalClientId === clientId || idTokenAudArray.includes(clientId);

  let requestingTrustGroup: string | undefined;
  let originalTrustGroup: string | undefined;
  if (!isSameClient) {
    requestingTrustGroup = getClientTrustGroup(clientMetadata);
    if (originalClientId) {
      try {
        const originalClientMetadata = await getClientCached(c, c.env, originalClientId);
        originalTrustGroup = getClientTrustGroup(originalClientMetadata as ClientMetadata | null);
      } catch {
        // If we can't verify original client, deny cross-client SSO for safety
        log.warn('Failed to verify original client', { originalClientId, action: 'NativeSSO' });
        originalTrustGroup = undefined;
      }
    }

    const crossClientAllowed =
      requestingTrustGroup !== undefined &&
      originalTrustGroup !== undefined &&
      timingSafeEqual(requestingTrustGroup, originalTrustGroup);

    if (!crossClientAllowed) {
      log.warn('Cross-client SSO denied', {
        originalClientId,
        requestingClientId: clientId,
        requestingTrustGroupPresent: requestingTrustGroup !== undefined,
        originalTrustGroupPresent: originalTrustGroup !== undefined,
        action: 'NativeSSO',
      });
      return exchangeError(
        'access_denied',
        'Cross-client Native SSO is not allowed',
        'trust_group_not_allowed',
        403,
        'contact_support'
      );
    }
  }

  let issuedInstallation: DeviceInstallation | null = null;
  try {
    issuedInstallation = await deviceInstallationRepo.ensureForNativeSSOTokenExchange({
      sourceDeviceSecret: validatedDeviceSecret,
      targetClientId: clientId,
      targetTrustGroupId: requestingTrustGroup ?? validatedDeviceSecret.trust_group_id,
      sourceClientId: originalClientId ?? validatedDeviceSecret.client_id,
      sameClient: isSameClient,
      lastSeenAt: now * 1000,
    });
  } catch (error) {
    log.error('Failed to resolve Native SSO installation', { action: 'NativeSSO' }, error as Error);
    return exchangeError(
      'server_error',
      'Failed to resolve Native SSO installation',
      'native_sso_server_error',
      500,
      'retry',
      { retryable: true }
    );
  }
  const issuedInstallationId =
    issuedInstallation?.id ?? getDeviceSecretInstallationId(validatedDeviceSecret);

  // 8. Scope handling
  // Native SSO inherits scope from original ID Token or uses requested scope
  const idTokenScope = idTokenPayload.scope as string | undefined;
  const originalScopes = idTokenScope ? idTokenScope.split(' ') : ['openid'];
  const requestedScopes = requestedScope ? requestedScope.split(' ') : originalScopes;
  const allowedScopes = clientMetadata.allowed_scopes || [];

  // Intersection: requested ∩ original ∩ client.allowed_scopes
  let grantedScopes = requestedScopes;
  if (originalScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => originalScopes.includes(s));
  }
  if (allowedScopes.length > 0) {
    grantedScopes = grantedScopes.filter((s) => allowedScopes.includes(s));
  }

  // Ensure openid is always included for OIDC
  if (!grantedScopes.includes('openid')) {
    grantedScopes.unshift('openid');
  }

  const grantedScope = grantedScopes.join(' ');

  const audienceResolution = resolveAccessTokenAudience(c, clientMetadata, {
    resource: requestedResources,
    audience: requestedAudiences,
  });
  if (!audienceResolution.ok) {
    return oauthError(c, 'invalid_target', audienceResolution.description, 400);
  }
  const accessTokenAudience = audienceResolution.audience;
  const audienceSource = audienceResolution.source;

  // 9. Generate tokens
  let privateKey: CryptoKey;
  let keyId: string;
  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, tenantId);
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key', { action: 'NativeSSO' }, error as Error);
    return exchangeError(
      'server_error',
      'Failed to load signing key',
      'native_sso_server_error',
      500,
      'retry',
      { retryable: true }
    );
  }

  const configManager = createOAuthConfigManager(c.env);
  const expiresIn = await configManager.getTokenExpiry();
  const refreshTokenExpiresIn = await configManager.getRefreshTokenExpiry();

  // Build access token claims
  const accessTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: idTokenSub,
    aud: accessTokenAudience,
    scope: grantedScope,
    client_id: clientId,
    // Include session_id if available from device_secret
    ...(validatedDeviceSecret.session_id && { sid: validatedDeviceSecret.session_id }),
    // Internal self-service device inventory binding.
    authrim_installation_id: issuedInstallationId,
    // Add DPoP confirmation
    cnf: { jkt: dpopJkt },
  };

  let accessToken: string;
  let accessTokenJti: string;
  try {
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', { action: 'NativeSSO' }, error as Error);
    return exchangeError(
      'server_error',
      'Failed to create access token',
      'native_sso_server_error',
      500,
      'retry',
      { retryable: true }
    );
  }

  // Calculate at_hash for new ID Token
  let newAtHash: string;
  try {
    newAtHash = await calculateAtHash(accessToken);
  } catch (error) {
    log.error('Failed to calculate at_hash', { action: 'NativeSSO' }, error as Error);
    return exchangeError(
      'server_error',
      'Failed to calculate token hash',
      'native_sso_server_error',
      500,
      'retry',
      { retryable: true }
    );
  }

  // Build new ID Token claims
  // Extract values first to avoid spread type issues
  const authTime = idTokenPayload.auth_time as number | undefined;
  const acr = idTokenPayload.acr as string | undefined;
  const newIdTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: idTokenSub,
    aud: clientId,
    at_hash: newAtHash,
  };
  // Preserve auth_time from original ID Token
  if (authTime !== undefined) {
    newIdTokenClaims.auth_time = authTime;
  }
  // Preserve acr from original ID Token
  if (acr !== undefined) {
    newIdTokenClaims.acr = acr;
  }
  // Include session_id
  if (validatedDeviceSecret.session_id) {
    newIdTokenClaims.sid = validatedDeviceSecret.session_id;
  }

  try {
    const mapped = await applyOIDCIdentityMapping({
      adapter: authCtx.coreAdapter,
      env: c.env,
      tenantId,
      clientId,
      sectorIdentifier: clientMetadata.sector_identifier_uri,
      selector: clientMetadata.identity_mapping,
      destinationSurface: 'id_token',
      grantedScopes,
      claims: newIdTokenClaims,
    });
    if (mapped.claims !== newIdTokenClaims) {
      Object.keys(newIdTokenClaims).forEach((key) => {
        delete newIdTokenClaims[key];
      });
      Object.assign(newIdTokenClaims, mapped.claims);
    }
  } catch (error) {
    log.error(
      'Failed to apply OIDC identity mapping for Native SSO ID token',
      {
        action: 'NativeSSO',
        clientId,
      },
      error as Error
    );
    return exchangeError(
      error instanceof OIDCIdentityMappingRuntimeError ? 'invalid_client' : 'server_error',
      error instanceof OIDCIdentityMappingRuntimeError
        ? 'Client identity mapping configuration is invalid'
        : 'Failed to apply identity mapping',
      'native_sso_server_error',
      error instanceof OIDCIdentityMappingRuntimeError ? 400 : 500,
      'retry',
      { retryable: !(error instanceof OIDCIdentityMappingRuntimeError) }
    );
  }

  try {
    await enforceOIDCAttributeReleaseConsent({
      env: c.env,
      tenantId,
      subjectId: idTokenSub,
      clientMetadata,
      claims: newIdTokenClaims,
      target: 'id_token',
    });
  } catch (error) {
    log.warn('OIDC Native SSO ID token claim release consent required', {
      action: 'NativeSSO',
      clientId,
      reasonCodes:
        error instanceof OIDCAttributeReleaseConsentRequiredError ? error.reasonCodes : [],
    });
    return exchangeError(
      error instanceof OIDCAttributeReleaseConsentRequiredError
        ? 'consent_required'
        : 'server_error',
      error instanceof OIDCAttributeReleaseConsentRequiredError
        ? 'User consent is required before releasing ID token claims'
        : 'Failed to evaluate claim release consent',
      'native_sso_server_error',
      error instanceof OIDCAttributeReleaseConsentRequiredError ? 400 : 500,
      'retry',
      { retryable: false }
    );
  }

  let newIdToken: string;
  try {
    newIdToken = await createClientIDToken(
      c.env,
      tenantId,
      clientMetadata,
      newIdTokenClaims as Omit<IDTokenClaims, 'iat' | 'exp'>,
      expiresIn
    );
  } catch (error) {
    log.error('Failed to create ID token', { action: 'NativeSSO' }, error as Error);
    return exchangeError(
      'server_error',
      'Failed to create ID token',
      'native_sso_server_error',
      500,
      'retry',
      { retryable: true }
    );
  }

  let refreshToken: string | undefined;
  let refreshTokenJti: string | undefined;
  let refreshTokenExpiryMetadata: RefreshTokenExpiryMetadata | undefined;
  try {
    const tenantProfile = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId);

    if (tenantProfile.allows_refresh_token !== false) {
      const refreshTokenClaims = {
        iss: getRequestIssuer(c),
        sub: idTokenSub,
        aud: clientId,
        scope: grantedScope,
        client_id: clientId,
        resource_aud: accessTokenAudience,
        cnf: { jkt: dpopJkt },
      };

      let rtv: number | undefined;
      let familyResult: Awaited<ReturnType<typeof createRefreshTokenFamily>> | undefined;

      if (c.env.REFRESH_TOKEN_ROTATOR) {
        familyResult = await createRefreshTokenFamily(c.env, {
          userId: idTokenSub,
          clientId,
          scope: grantedScope,
          ttl: refreshTokenExpiresIn,
          tenantId,
          resourceAudience: accessTokenAudience,
        });
        refreshTokenJti = familyResult.jti;
        rtv = familyResult.family.version;
        void recordTokenFamilyIndex(
          authCtx.coreAdapter,
          tenantId,
          refreshTokenJti,
          idTokenSub,
          clientId,
          familyResult.resolution.generation,
          refreshTokenExpiresIn
        );
      } else {
        refreshTokenJti = `rt_${crypto.randomUUID()}`;
      }

      const result = await createRefreshToken(
        refreshTokenClaims,
        privateKey,
        keyId,
        refreshTokenExpiresIn,
        refreshTokenJti,
        rtv
      );
      refreshToken = result.token;

      if (!familyResult) {
        await storeRefreshToken(
          c.env,
          refreshTokenJti,
          {
            jti: refreshTokenJti,
            client_id: clientId,
            sub: idTokenSub,
            scope: grantedScope,
            resource_aud: accessTokenAudience,
            iat: now,
            exp: now + refreshTokenExpiresIn,
          },
          tenantId
        );
      }

      refreshTokenExpiryMetadata = buildRefreshTokenExpiryMetadata(now, refreshTokenExpiresIn);
    }
  } catch (error) {
    log.error('Failed to create refresh token', { action: 'NativeSSO' }, error as Error);
    return exchangeError(
      'server_error',
      'Failed to create refresh token',
      'native_sso_server_error',
      500,
      'retry',
      { retryable: true }
    );
  }

  const installationMetadata = buildNativeSSOInstallationMetadataForIssuedInstallation(
    issuedInstallation,
    validatedDeviceSecret,
    clientId,
    clientMetadata,
    now * 1000
  );

  // 10. Audit log
  log.info('NativeSSO Token Exchange Success', {
    clientId,
    subjectUserId: idTokenSub,
    userIdPrefix: idTokenSub.substring(0, 8),
    sessionIdPrefix: validatedDeviceSecret.session_id?.substring(0, 8),
    deviceSecretIdPrefix: validatedDeviceSecret.id.substring(0, 8),
    deviceSecretUseCount: validatedDeviceSecret.use_count + 1,
    isCrossClient: !isSameClient,
    sourceClientId: originalClientId,
    issuedClientId: clientId,
    originalClientId,
    exchangeMode: isSameClient ? 'same_client' : 'cross_client',
    grantedScope,
    tokenBinding: 'DPoP',
    dpopJkt,
    accessTokenJti: accessTokenJti,
    refreshTokenJti,
    refreshTokenIssued: refreshToken !== undefined,
    audienceSource,
    requestedAudiences,
    requestedResources,
    targetAudiences: accessTokenAudience,
    sourceInstallationId: getDeviceSecretInstallationId(validatedDeviceSecret),
    issuedInstallationId: installationMetadata.installation_id,
    ...(requestingTrustGroup && { trustGroupId: requestingTrustGroup }),
    ...(originalTrustGroup && { originalTrustGroupId: originalTrustGroup }),
    action: 'NativeSSO',
  });

  // Publish token events (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    Promise.all([
      publishEvent(c, {
        type: TOKEN_EVENTS.ACCESS_ISSUED,
        tenantId,
        data: {
          jti: accessTokenJti,
          clientId,
          userId: idTokenSub,
          scopes: grantedScope.split(' '),
          expiresAt: nowEpoch + expiresIn,
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange', // Native SSO uses token-exchange
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
      }),
      // ID Token issued event (Native SSO token exchange)
      publishEvent(c, {
        type: TOKEN_EVENTS.ID_ISSUED,
        tenantId,
        data: {
          clientId,
          userId: idTokenSub,
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        } satisfies TokenEventData,
      }).catch((err: unknown) => {
        log.error('Failed to publish token.id.issued event', { action: 'Event' }, err as Error);
      }),
      ...(refreshToken && refreshTokenJti
        ? [
            publishEvent(c, {
              type: TOKEN_EVENTS.REFRESH_ISSUED,
              tenantId,
              data: {
                jti: refreshTokenJti,
                clientId,
                userId: idTokenSub,
                scopes: grantedScope.split(' '),
                grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
              } satisfies TokenEventData,
            }).catch((err: unknown) => {
              log.error(
                'Failed to publish token.refresh.issued event',
                { action: 'Event' },
                err as Error
              );
            }),
          ]
        : []),
    ])
  );

  // Set cache control headers
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json(
    buildNativeSSOTokenExchangeSuccessResponse({
      accessToken,
      expiresIn,
      idToken: newIdToken,
      installationMetadata,
      refreshToken,
      refreshTokenExpiryMetadata,
      scope: grantedScope,
    })
  );
}

// =============================================================================
// RFC 6749 Section 4.4: Client Credentials Grant
// =============================================================================

/**
 * Handle Client Credentials Grant (RFC 6749 Section 4.4)
 * https://datatracker.ietf.org/doc/html/rfc6749#section-4.4
 *
 * Machine-to-Machine (M2M) authentication where the client is the resource owner.
 * No user authentication required.
 */
async function handleClientCredentialsGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  const requestedAudience = formData.audience;
  const requestedResource = formData.resource;

  if (requestedAudience === ADMIN_API_AUDIENCE) {
    return handleAdminMachineClientCredentialsGrant(c, formData);
  }

  // Check Feature Flag (hybrid: KV > env) - request-level cached
  let clientCredentialsEnabled = c.env.ENABLE_CLIENT_CREDENTIALS === 'true';
  try {
    const settings = await getSystemSettingsCached(c, c.env);
    if (settings) {
      if (settings.oidc?.clientCredentials?.enabled !== undefined) {
        clientCredentialsEnabled = settings.oidc.clientCredentials.enabled === true;
      }
    }
  } catch {
    // Ignore cache errors, fall back to env
  }

  if (!clientCredentialsEnabled) {
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: 'Client Credentials grant is not enabled',
      },
      400
    );
  }

  const requestedScope = formData.scope;

  // 1. Client Authentication (required for client_credentials)
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for JWT-based client authentication
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    try {
      const assertionPayload = parseToken(client_assertion);
      if (!client_id && assertionPayload.sub) {
        client_id = assertionPayload.sub as string;
      }
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client_assertion format',
        },
        401
      );
    }
  }

  // Check HTTP Basic authentication
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error === 'malformed_credentials' || basicAuth.error === 'decode_error') {
    // Basic auth was attempted but malformed
    return oauthError(c, 'invalid_client', 'Invalid Authorization header format', 401);
  }

  // Validate client_id
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  // Fetch client metadata - request-level cached
  const clientMetadata = await getClientCached(c, c.env, client_id!);
  if (!clientMetadata) {
    // Security: Generic message to prevent client_id enumeration
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  // Cast to ClientMetadata for type safety
  const typedClient = clientMetadata as unknown as ClientMetadata;
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  if ((await isDPoPRequiredForTokenRequest(c, typedClient)) && !dpopProof) {
    return oauthError(c, 'invalid_request', 'DPoP proof is required for this request', 400);
  }

  // Profile-based grant_type validation (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §5.2: unauthorized_client - client not allowed to use this grant type
  const tenantId = (clientMetadata.tenant_id as string) || getTenantIdFromContext(c);
  const tenantProfile = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, tenantId);
  if (!tenantProfile.allows_client_credentials) {
    return oauthError(
      c,
      'unauthorized_client',
      'client_credentials grant is not allowed for this tenant profile',
      403
    );
  }

  // 2. Authenticate client (client_credentials REQUIRES authentication)
  const clientAuthenticationPolicy = await resolveTokenClientAuthenticationPolicy(
    c,
    typedClient,
    client_assertion,
    client_assertion_type
  );
  if (!clientAuthenticationPolicy.ok) {
    return clientAuthenticationPolicy.response;
  }
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${getRequestIssuer(c)}/token`,
      typedClient,
      clientAuthenticationPolicy.assertionOptions
    );
    if (!assertionValidation.valid) {
      // Security: Log detailed error but return generic message to prevent information leakage
      log.error('Client assertion validation failed', {
        errorDescription: assertionValidation.error_description,
      });
      return oauthError(c, 'invalid_client', 'Client assertion validation failed', 401);
    }
  } else if (typedClient.client_secret_hash) {
    // client_secret_basic or client_secret_post
    // Security: Verify client secret against stored SHA-256 hash
    if (
      !client_secret ||
      !(await verifyClientSecretHash(client_secret, typedClient.client_secret_hash))
    ) {
      return oauthError(c, 'invalid_client', 'Invalid client credentials', 401);
    }
  } else {
    // Public clients are NOT allowed to use client_credentials
    return oauthError(c, 'invalid_client', 'Client credentials authentication is required', 401);
  }

  // 3. Check if client is allowed to use Client Credentials grant
  if (!typedClient.client_credentials_allowed) {
    return oauthError(
      c,
      'unauthorized_client',
      'Client is not authorized for Client Credentials grant',
      403
    );
  }

  // 4. Scope validation
  const defaultScope = typedClient.default_scope || 'openid';
  const scopes = requestedScope ? requestedScope.split(' ') : defaultScope.split(' ');
  const allowedScopes = typedClient.allowed_scopes || [];

  // If allowed_scopes is defined, filter requested scopes
  let grantedScopes = scopes;
  if (allowedScopes.length > 0) {
    grantedScopes = scopes.filter((s) => allowedScopes.includes(s));
    if (grantedScopes.length === 0) {
      return oauthError(
        c,
        'invalid_scope',
        'None of the requested scopes are allowed for this client',
        400
      );
    }
  }

  const grantedScope = grantedScopes.join(' ');

  // 5. Audience determination
  const audienceResolution = resolveAccessTokenAudience(c, typedClient, {
    resource: requestedResource,
    audience: requestedAudience,
    rejectResourceAudienceMismatch: true,
  });
  if (!audienceResolution.ok) {
    return oauthError(c, 'invalid_target', audienceResolution.description, 400);
  }
  const targetAudience = audienceResolution.audience;

  // 6. Generate access token
  let privateKey: CryptoKey;
  let keyId: string;

  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  const configManager = createOAuthConfigManager(c.env);
  const baseExpiresIn = await configManager.getTokenExpiry();
  // Apply Profile-based TTL limit (Human Auth / AI Ephemeral Auth two-layer model)
  // RFC 6749 §4.2.2: Access token lifetime is controlled by the authorization server
  const expiresIn = Math.min(baseExpiresIn, tenantProfile.max_token_ttl_seconds);

  // DPoP support
  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env, // Pass full Env for region-aware sharding
      client_id!,
      getTenantIdFromContext(c)
    );
    if (!dpopValidation.valid) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP validation failed',
        clientMetadata: typedClient,
        resources: requestedResource ? [requestedResource] : undefined,
      });
    }
    dpopJkt = dpopValidation.jkt;
  }

  // Build access token claims
  // For M2M, subject is the client itself with "client:" prefix for namespace separation
  const accessTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: `client:${client_id}`, // Namespace separation from user subjects
    aud: targetAudience,
    scope: grantedScope,
    client_id: client_id,
    // Add DPoP confirmation
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  };

  let accessToken: string;
  let accessTokenJti: string = '';
  try {
    // Generate region-aware JTI for token revocation sharding
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create access token', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to create access token', 500);
  }

  // Client Credentials does NOT issue refresh tokens (per RFC 6749)

  // Publish token event (non-blocking, use waitUntil to ensure completion)
  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId,
      data: {
        jti: accessTokenJti,
        clientId: client_id!,
        // Client Credentials is M2M - the client is the subject
        userId: `client:${client_id}`,
        scopes: grantedScope.split(' '),
        expiresAt: nowEpoch + expiresIn,
        grantType: 'client_credentials',
      } satisfies TokenEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish token.access.issued event', { action: 'Event' }, err as Error);
    })
  );

  // Set cache control headers
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopProof ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    scope: grantedScope,
  });
}

async function handleAdminMachineClientCredentialsGrant(
  c: Context<{ Bindings: Env }>,
  formData: Record<string, string>
): Promise<Response> {
  const log = getLogger(c).module('TOKEN');
  const clientAssertion = formData.client_assertion;
  const clientAssertionType = formData.client_assertion_type;

  if (
    !clientAssertion ||
    clientAssertionType !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    return oauthError(
      c,
      'invalid_client',
      'Admin API machine access requires private_key_jwt client authentication',
      401
    );
  }

  let assertionPayload: Record<string, unknown>;
  try {
    assertionPayload = parseToken(clientAssertion) as Record<string, unknown>;
  } catch {
    return oauthError(c, 'invalid_client', 'Invalid client_assertion format', 401);
  }

  const clientId =
    formData.client_id ||
    (typeof assertionPayload.sub === 'string' ? assertionPayload.sub : undefined);
  const clientIdValidation = validateClientId(clientId);
  if (!clientIdValidation.valid) {
    return oauthError(c, 'invalid_client', clientIdValidation.error as string, 401);
  }

  const assertionHeader = parseTokenHeader(clientAssertion) as { kid?: unknown; alg?: unknown };
  if (typeof assertionHeader.kid !== 'string' || assertionHeader.kid.length === 0) {
    return oauthError(c, 'invalid_client', 'Admin machine client_assertion must include kid', 401);
  }

  const assertionJti = assertionPayload.jti;
  const assertionIat = assertionPayload.iat;
  const assertionExp = assertionPayload.exp;
  if (typeof assertionHeader.alg !== 'string' || assertionHeader.alg.length === 0) {
    return oauthError(c, 'invalid_client', 'Admin machine client_assertion must include alg', 401);
  }
  if (typeof assertionJti !== 'string' || assertionJti.length === 0) {
    return oauthError(c, 'invalid_client', 'Admin machine client_assertion must include jti', 401);
  }
  if (typeof assertionIat !== 'number') {
    return oauthError(c, 'invalid_client', 'Admin machine client_assertion must include iat', 401);
  }
  if (typeof assertionExp !== 'number') {
    return oauthError(c, 'invalid_client', 'Admin machine client_assertion must include exp', 401);
  }
  const assertionNowEpoch = Math.floor(Date.now() / 1000);
  if (assertionIat > assertionNowEpoch + 60 || assertionExp <= assertionIat) {
    return oauthError(c, 'invalid_client', 'Admin machine client_assertion timing is invalid', 401);
  }
  if (assertionExp - assertionNowEpoch > 300) {
    return oauthError(
      c,
      'invalid_client',
      'Admin machine client_assertion lifetime must be 5 minutes or less',
      401
    );
  }

  let adminAdapter: DatabaseAdapter;
  try {
    adminAdapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-machine-access');
  } catch (error) {
    log.error('Admin machine database is not configured', {}, error as Error);
    return oauthError(c, 'server_error', 'Admin machine access is not configured', 500);
  }

  const machineRepo = new AdminMachineAccessRepository(adminAdapter);
  const machineCredential = await machineRepo.findCredentialForClient(
    clientId!,
    assertionHeader.kid
  );
  if (!machineCredential) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  const { principal, credential } = machineCredential;
  const nowMs = Date.now();
  if (principal.status !== 'active') {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }
  if (credential.status !== 'active' && credential.status !== 'rotating') {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }
  if (assertionHeader.alg !== credential.alg) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }
  if (credential.notBefore !== null && credential.notBefore > nowMs) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }
  if (credential.expiresAt !== null && credential.expiresAt <= nowMs) {
    return oauthError(c, 'invalid_client', 'Client authentication failed', 401);
  }

  let publicJwk: Record<string, unknown>;
  try {
    publicJwk = JSON.parse(credential.publicJwkJson) as Record<string, unknown>;
  } catch {
    log.error('Admin machine credential has invalid public JWK JSON', {
      credentialId: credential.id,
    });
    return oauthError(c, 'server_error', 'Admin machine credential is invalid', 500);
  }

  const assertionValidation = await validateClientAssertion(
    clientAssertion,
    `${getRequestIssuer(c)}/token`,
    {
      client_id: principal.clientId,
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: {
        keys: [
          {
            ...publicJwk,
            kid: credential.kid,
            alg: credential.alg,
          },
        ],
      },
    } as ClientMetadata,
    { acceptIssuerIdAsAudience: false }
  );
  if (!assertionValidation.valid) {
    log.error('Admin machine assertion validation failed', {
      credentialId: credential.id,
      errorDescription: assertionValidation.error_description,
    });
    return oauthError(c, 'invalid_client', 'Client assertion validation failed', 401);
  }

  const jtiRecorded = await machineRepo.recordAssertionJti({
    clientId: principal.clientId,
    credentialId: credential.id,
    jti: assertionJti,
    expiresAt: assertionExp,
  });
  if (!jtiRecorded) {
    return oauthError(c, 'invalid_client', 'Client assertion replay detected', 401);
  }

  const requestedScopes = splitScope(formData.scope);
  if (requestedScopes.length === 0) {
    return oauthError(c, 'invalid_scope', 'Admin API machine access requires scope', 400);
  }

  const principalPermissions = await machineRepo.getPrincipalPermissions(principal.id);
  const credentialPermissions = await machineRepo.getCredentialPermissions(credential.id);
  const allowedPermissions =
    credentialPermissions.length > 0
      ? intersectMachinePermissionSets(principalPermissions, credentialPermissions)
      : principalPermissions;
  const grantedScopes = intersectScopes(requestedScopes, allowedPermissions);
  if (grantedScopes.length === 0) {
    return oauthError(
      c,
      'invalid_scope',
      'None of the requested scopes are allowed for this machine client',
      400
    );
  }

  const principalTenantScopes = await machineRepo.getPrincipalTenantScopes(principal.id);
  const credentialTenantScopes = await machineRepo.getCredentialTenantScopes(credential.id);
  const tenantScope = resolveMachineTenantScope(principalTenantScopes, credentialTenantScopes);

  let privateKey: CryptoKey;
  let keyId: string;
  try {
    const signingKey = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));
    privateKey = signingKey.privateKey;
    keyId = signingKey.kid;
  } catch (error) {
    log.error('Failed to get signing key from KeyManager', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to load signing key', 500);
  }

  const expiresIn = Math.min(principal.tokenTtlSeconds, 900);
  const dpopProof = extractDPoPProof(c.req.raw.headers);
  let dpopJkt: string | undefined;
  if (dpopProof) {
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env,
      principal.clientId,
      getTenantIdFromContext(c)
    );
    if (!dpopValidation.valid || !dpopValidation.jkt) {
      return dpopValidationErrorResponse(c, dpopValidation, {
        fallbackDescription: 'DPoP validation failed',
      });
    }
    dpopJkt = dpopValidation.jkt;
  }
  const accessTokenClaims: Record<string, unknown> = {
    iss: getRequestIssuer(c),
    sub: `machine:${principal.id}`,
    aud: ADMIN_API_AUDIENCE,
    azp: principal.clientId,
    client_id: principal.clientId,
    actor_type: 'machine',
    actor_id: principal.id,
    credential_id: credential.id,
    client_auth_method: 'private_key_jwt',
    credential_strength: 'asymmetric_key',
    sender_constrained: dpopJkt !== undefined,
    scope: grantedScopes.join(' '),
    tenant_scope: tenantScope,
    ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}),
  };

  let accessToken: string;
  let accessTokenJti = '';
  try {
    const { jti: regionAwareJti } = await generateRegionAwareJti(c.env, getTenantIdFromContext(c));
    const result = await createAccessToken(
      accessTokenClaims as Parameters<typeof createAccessToken>[0],
      privateKey,
      keyId,
      expiresIn,
      regionAwareJti
    );
    accessToken = result.token;
    accessTokenJti = result.jti;
  } catch (error) {
    log.error('Failed to create Admin API machine access token', {}, error as Error);
    return oauthError(c, 'server_error', 'Failed to create access token', 500);
  }

  c.executionCtx.waitUntil(
    machineRepo
      .updateCredentialLastUsed({
        credentialId: credential.id,
        ipAddress: c.req.header('CF-Connecting-IP') ?? null,
        userAgent: c.req.header('User-Agent') ?? null,
      })
      .catch((error: unknown) => {
        log.warn('Failed to update Admin machine credential last-used metadata', {
          credentialId: credential.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
  );

  const nowEpoch = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    publishEvent(c, {
      type: TOKEN_EVENTS.ACCESS_ISSUED,
      tenantId: getTenantIdFromContext(c),
      data: {
        jti: accessTokenJti,
        clientId: principal.clientId,
        userId: `machine:${principal.id}`,
        scopes: grantedScopes,
        expiresAt: nowEpoch + expiresIn,
        grantType: 'client_credentials',
      } satisfies TokenEventData,
    }).catch((error: unknown) => {
      log.error('Failed to publish token.access.issued event', {}, error as Error);
    })
  );

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  return c.json({
    access_token: accessToken,
    token_type: dpopJkt ? 'DPoP' : 'Bearer',
    expires_in: expiresIn,
    scope: grantedScopes.join(' '),
  });
}

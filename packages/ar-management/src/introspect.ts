import type { Context } from 'hono';
import type { Env, ClientMetadata } from '@authrim/ar-lib-core';
import type { IntrospectionResponse } from '@authrim/ar-lib-core';
import {
  validateClientId,
  getRefreshToken,
  isTokenRevoked,
  parseToken,
  verifyToken,
  createAuthContextFromHono,
  getTenantIdFromContext,
  validateClientAssertion,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  // Event System
  publishEvent,
  TOKEN_EVENTS,
  type TokenEventData,
  // Shared utilities
  parseBasicAuth,
  getKeyByKid,
  verifyClientSecretHash,
  applyIntrospectionIdentityMapping,
  filterIntrospectionProtocolEnvelopeClaims,
  requireDedicatedAdminDatabaseAdapter,
  createPhase1ErrorDetails,
  getDeviceSecretInstallationId,
  resolveEffectiveSettings,
  resolveAccountDataContextFromHono,
  createAccountAuthContextFromHono,
  findOAuthClientConsentRevocation,
  isOAuthClientConsentGrantWithdrawn,
  predatesOAuthClientConsentRevocation,
  readAccountAuthenticationState,
  tokenNamesAccountSubject,
  tokenRecordsUserGrant,
  accessTokenConsentGrant,
  isAccessTokenConsentWithdrawn,
  externalSubjectIssuer,
  SUBJECT_REFERENCE_CLAIM,
  openSubjectReference,
  type DatabaseAdapter,
  type OAuthClientConsentRevocationState,
} from '@authrim/ar-lib-core';
import { importJWK, decodeProtectedHeader, type CryptoKey } from 'jose';
import { getRequestAwareIssuerUrl } from './request-issuer';
import { findRoutedDeviceSecret } from './device-secret-account';
import {
  evaluateDeviceSecretIntrospectionPolicy,
  type DeviceSecretPolicyErrorCode,
} from './device-secret-policy';

interface IntrospectionValidationSettings {
  strictValidation: boolean;
  expectedAudience: string | null;
  /**
   * The tenant's master switch for extended claims (`tokens.introspection_extended_claims`):
   * off, the Resource Server's profile and identity mapping are not used and the response holds
   * the protocol envelope only.
   */
  extendedClaims: boolean;
}

/**
 * Strict introspection, the audience it expects (an empty audience: the issuer) and whether
 * extended claims are on, as the Settings API resolves them for the tenant. Throws when they
 * cannot be read.
 */
async function introspectionValidationSettings(
  env: Env,
  tenantId: string
): Promise<IntrospectionValidationSettings> {
  const tokens = await resolveEffectiveSettings(env, 'tokens', {
    tenantId,
  });
  const audience = tokens['tokens.introspection_expected_audience'];
  return {
    strictValidation: tokens['tokens.introspection_strict_validation'] === true,
    expectedAudience: typeof audience === 'string' && audience !== '' ? audience : null,
    extendedClaims: tokens['tokens.introspection_extended_claims'] === true,
  };
}

function deviceSecretPolicyErrorResponse(
  c: Context<{ Bindings: Env }>,
  code: DeviceSecretPolicyErrorCode,
  description: string
): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(
    {
      error: 'access_denied',
      error_description: description,
      error_details: createPhase1ErrorDetails(code),
    },
    403
  );
}

function normalizeDeviceSecretPlatform(platform: string | undefined): string {
  return platform && platform.length > 0 ? platform : 'unknown';
}

function normalizeStringClaim(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function isIntrospectionCallerAuthorized(
  callerClientId: string,
  tokenClientId: unknown,
  audiences: string[],
  resources: string[]
): boolean {
  return (
    tokenClientId === callerClientId ||
    audiences.includes(callerClientId) ||
    resources.includes(callerClientId)
  );
}

type IntrospectableTokenUse = 'access' | 'refresh';

function resolveIntrospectableTokenUse(
  tokenPayload: Record<string, unknown>,
  tokenTypeHint: string | undefined
): IntrospectableTokenUse | null {
  if (
    typeof tokenPayload.client_id !== 'string' ||
    tokenPayload.client_id.length === 0 ||
    typeof tokenPayload.jti !== 'string' ||
    tokenPayload.jti.length === 0 ||
    typeof tokenPayload.sub !== 'string' ||
    tokenPayload.sub.length === 0 ||
    typeof tokenPayload.scope !== 'string' ||
    typeof tokenPayload.iat !== 'number' ||
    !Number.isFinite(tokenPayload.iat) ||
    typeof tokenPayload.exp !== 'number' ||
    !Number.isFinite(tokenPayload.exp)
  ) {
    return null;
  }

  const explicitTokenUse = tokenPayload.token_use;
  if (explicitTokenUse !== undefined) {
    return explicitTokenUse === 'access' || explicitTokenUse === 'refresh'
      ? explicitTokenUse
      : null;
  }

  // Compatibility for tokens issued before token_use was introduced. The complete legacy shape
  // excludes ID tokens and other protocol JWTs while allowing existing access/refresh tokens to
  // remain usable until their normal expiry.
  return tokenTypeHint === 'refresh_token' ? 'refresh' : 'access';
}

/** Account route errors meaning the tenant has no account with that ID. */
const NO_ACCOUNT_ROUTE_ERRORS = new Set([
  'account_data_route_not_found',
  'account_data_account_id_invalid',
]);

/**
 * The account route resolver revalidates only active accounts at their destination: a suspended,
 * locked or deleting account fails there.
 */
const INACTIVE_ACCOUNT_ROUTE_ERROR = 'lookup_destination_revalidation_failed';

/**
 * 'active_without_account': an externally asserted subject that was never one of the tenant's
 * accounts (it has no account data to read).
 */
type IntrospectedAccountState = 'active' | 'active_without_account' | 'inactive' | 'unavailable';

/**
 * For a subject with no account route: whether it was ever one of the tenant's accounts. A deleted
 * (or deleting) account keeps its terminal state in its authentication-state Durable Object after
 * its lookup entry is gone; a subject that was never an account has no state there. A subject that
 * cannot name an account at all was never one.
 */
async function readFormerAccountState(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<'never_account' | 'former_account' | 'unavailable'> {
  try {
    const state = await readAccountAuthenticationState(c.env, tenantId, userId);
    return state.lifecycle === null ? 'never_account' : 'former_account';
  } catch (error) {
    if (error instanceof Error && error.message === 'session_revocation_identity_invalid') {
      return 'never_account';
    }
    getLogger(c)
      .module('INTROSPECT')
      .error('Failed to read the authentication state of a routeless subject', {}, error as Error);
    return 'unavailable';
  }
}

/**
 * Whether the user a token was issued to may still use it: read from the user's account databases
 * (the tenant metadata database holds no users). The account must be active, and the user must not
 * have withdrawn the consent the token was granted under (`isWithdrawn`, given the user × client
 * withdrawal state from one keyed read).
 *
 * Fails closed: a token whose account is gone, or not active, is inactive; an account that cannot
 * be resolved or read is 'unavailable', never active.
 */
async function readIntrospectedAccountState(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    userId: string;
    /** The client whose consent the token was granted under. */
    clientId: string;
    /**
     * Whether the subject may be external (asserted by an external issuer): a subject that was
     * never one of the tenant's accounts is then accepted. A deleted account still is not.
     */
    allowsExternalSubject(): boolean;
    isWithdrawn(state: OAuthClientConsentRevocationState): boolean;
    /** The account's core database when the caller has already routed to it. */
    coreAdapter?: DatabaseAdapter;
  }
): Promise<IntrospectedAccountState> {
  const log = getLogger(c).module('INTROSPECT');
  let coreAdapter: DatabaseAdapter;
  if (input.coreAdapter) {
    coreAdapter = input.coreAdapter;
  } else {
    try {
      await resolveAccountDataContextFromHono(c, input.userId);
      coreAdapter = createAccountAuthContextFromHono(c, input.tenantId).coreAdapter;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (NO_ACCOUNT_ROUTE_ERRORS.has(code)) {
        if (!input.allowsExternalSubject()) return 'inactive';
        if (code === 'account_data_account_id_invalid') return 'active_without_account';
        // The lookup entry of a deleted account is removed with it: a subject that was an
        // account stays inactive.
        const former = await readFormerAccountState(c, input.tenantId, input.userId);
        return former === 'never_account'
          ? 'active_without_account'
          : former === 'former_account'
            ? 'inactive'
            : 'unavailable';
      }
      if (code === INACTIVE_ACCOUNT_ROUTE_ERROR) return 'inactive';
      log.warn('Introspected token account route resolution failed', {
        action: 'introspect',
        error: code || 'account_data_route_unavailable',
      });
      return 'unavailable';
    }
  }

  try {
    const [account, withdrawal] = await Promise.all([
      coreAdapter.queryOne<{
        account_lifecycle_state: string;
        directory_publication_state: string;
        subject_lifecycle_state: string | null;
        metadata_json: string | null;
      }>(
        `SELECT account.lifecycle_state AS account_lifecycle_state,
                account.directory_publication_state AS directory_publication_state,
                subject.lifecycle_state AS subject_lifecycle_state,
                account.metadata_json AS metadata_json
           FROM identity_accounts account
           LEFT JOIN identity_subjects subject
             ON subject.id = account.primary_subject_id
            AND subject.tenant_id = account.tenant_id
          WHERE account.tenant_id = ? AND account.legacy_user_id = ?
          LIMIT 1`,
        [input.tenantId, input.userId]
      ),
      findOAuthClientConsentRevocation(coreAdapter, {
        tenantId: input.tenantId,
        userId: input.userId,
        clientId: input.clientId,
      }),
    ]);
    if (!account) return 'inactive';
    // RFC 7009: tokens of suspended or locked users are inactive. The lifecycle state is
    // authoritative; the legacy metadata status is only an additional refusal.
    const status = legacyAccountStatus(account.metadata_json);
    if (
      account.account_lifecycle_state !== 'active' ||
      account.directory_publication_state !== 'active' ||
      account.subject_lifecycle_state !== 'active' ||
      status === 'suspended' ||
      status === 'locked'
    ) {
      return 'inactive';
    }
    return input.isWithdrawn(withdrawal) ? 'inactive' : 'active';
  } catch (error) {
    log.error(
      'Failed to read the introspected token account state',
      { action: 'introspect' },
      error as Error
    );
    return 'unavailable';
  }
}

function legacyAccountStatus(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const metadata = JSON.parse(metadataJson) as { status?: unknown } | null;
    return typeof metadata?.status === 'string' ? metadata.status : null;
  } catch {
    return null;
  }
}

/**
 * The user id a token's sealed subject reference stands for: none when it carries no reference,
 * invalid when the reference does not open for the token's consent client, unavailable when it
 * cannot be opened.
 */
type SubjectAccountReference =
  | { kind: 'none' }
  | { kind: 'resolved'; userId: string }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

async function subjectAccountReference(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  tokenPayload: Record<string, unknown>,
  consentClientId: string
): Promise<SubjectAccountReference> {
  const reference = tokenPayload[SUBJECT_REFERENCE_CLAIM];
  if (typeof reference !== 'string') return { kind: 'none' };
  try {
    const userId = await openSubjectReference(
      c.env,
      { tenantId, clientId: consentClientId },
      reference
    );
    return userId === null ? { kind: 'invalid' } : { kind: 'resolved', userId };
  } catch (error) {
    getLogger(c)
      .module('INTROSPECT')
      .error('Failed to open the subject reference of an introspected token', {}, error as Error);
    return { kind: 'unavailable' };
  }
}

/**
 * Whether a token's subject is not a user account at all: a client or admin principal, or the
 * target of a downstream elevation grant that is not a user (an artifact or a resource). Decided
 * from what the authorization server signed: a token recording a user's grant names an account,
 * whatever its public sub (chosen by identity mapping) looks like.
 */
function namesNonAccountSubject(tokenPayload: Record<string, unknown>): boolean {
  if (!tokenNamesAccountSubject(tokenPayload)) return true;
  if (tokenRecordsUserGrant(tokenPayload)) return false;
  const elevation = tokenPayload.authrim_elevation;
  return (
    typeof elevation === 'object' &&
    elevation !== null &&
    (elevation as { target_subject_type?: unknown }).target_subject_type !== 'user'
  );
}

/** The answer when the token's account cannot be read: refuse rather than answer active=true. */
function accountStateUnavailableResponse(c: Context<{ Bindings: Env }>): Response {
  return c.json({ error: 'server_error', error_description: 'Account state is unavailable' }, 503);
}

/**
 * Token Introspection Endpoint Handler
 * https://tools.ietf.org/html/rfc7662
 *
 * Allows authorized clients to query the authorization server about the state of a token
 */
export async function introspectHandler(c: Context<{ Bindings: Env }>) {
  // Verify Content-Type is application/x-www-form-urlencoded
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  // Parse form data
  let formData: Record<string, string>;
  try {
    const body = await c.req.parseBody();
    formData = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  const token = formData.token;
  const token_type_hint = formData.token_type_hint as
    | 'access_token'
    | 'refresh_token'
    | 'device_secret'
    | undefined;

  // Extract client credentials from either form data or Authorization header
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // P0: Extract client_assertion for private_key_jwt authentication (RFC 7523)
  const client_assertion = formData.client_assertion;
  const client_assertion_type = formData.client_assertion_type;

  // Check for HTTP Basic authentication (client_secret_basic)
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    if (!client_id) client_id = basicAuth.credentials.username;
    if (!client_secret) client_secret = basicAuth.credentials.password;
  } else if (basicAuth.error !== 'missing_header' && basicAuth.error !== 'invalid_scheme') {
    // Basic auth was attempted but malformed
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Validate token parameter
  if (!token) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'token' },
    });
  }

  // Validate client_id (client authentication required for introspection)
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // RFC 7662 Section 2.1: The authorization server first validates the client credentials
  // Fetch client to verify client_secret via Repository
  const tenantId = getTenantIdFromContext(c);
  const issuerUrl = getRequestAwareIssuerUrl(c, tenantId);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const clientRecord = await authCtx.repositories.client.findByClientId(client_id);

  if (!clientRecord) {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  // Cast to ClientMetadata for type safety
  const clientMetadata = clientRecord as unknown as ClientMetadata;

  // =========================================================================
  // Client Authentication (supports multiple methods)
  // Priority: private_key_jwt > client_secret_basic/post
  // RFC 7662: Client authentication is REQUIRED for introspection
  // =========================================================================

  // P0: private_key_jwt authentication (RFC 7523)
  if (
    client_assertion &&
    client_assertion_type === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  ) {
    const assertionValidation = await validateClientAssertion(
      client_assertion,
      `${issuerUrl}/introspect`, // Introspection endpoint URL
      clientMetadata,
      { replayProtection: { env: c.env, tenantId } }
    );

    if (!assertionValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
    // Authentication successful via private_key_jwt
  }
  // client_secret_basic or client_secret_post authentication
  else if (client_secret) {
    // Verify client_secret using timing-safe hash comparison to prevent timing attacks
    if (
      !clientMetadata.client_secret_hash ||
      !(await verifyClientSecretHash(client_secret, clientMetadata.client_secret_hash))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    }
    // Authentication successful via client_secret
  }
  // Public clients can be identified for device_secret policy evaluation, but
  // the policy below denies public-client introspection before any token lookup.
  else if (token_type_hint === 'device_secret' && !clientMetadata.client_secret_hash) {
    // Continue to caller-class policy evaluation.
  }
  // No valid authentication method provided
  else {
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
  }

  if (token_type_hint === 'device_secret') {
    const preliminaryPolicy = evaluateDeviceSecretIntrospectionPolicy(clientMetadata, {
      clientId: client_id,
    });
    if (!preliminaryPolicy.allowed) {
      return deviceSecretPolicyErrorResponse(
        c,
        preliminaryPolicy.code,
        preliminaryPolicy.description
      );
    }

    const tenantId = getTenantIdFromContext(c);
    // Read from its owner's account database, which its route hint names.
    let routedDeviceSecret: Awaited<ReturnType<typeof findRoutedDeviceSecret>>;
    try {
      routedDeviceSecret = await findRoutedDeviceSecret(c.env, tenantId, token);
    } catch (error) {
      getLogger(c)
        .module('INTROSPECT')
        .error('Failed to read the introspected device secret', {}, error as Error);
      return accountStateUnavailableResponse(c);
    }
    const deviceSecret = routedDeviceSecret?.deviceSecret ?? null;
    const nowMs = Date.now();

    if (
      !deviceSecret ||
      deviceSecret.is_active !== 1 ||
      deviceSecret.revoked_at ||
      deviceSecret.expires_at <= nowMs
    ) {
      return c.json<IntrospectionResponse>({ active: false });
    }

    const deviceSecretPolicy = evaluateDeviceSecretIntrospectionPolicy(clientMetadata, {
      clientId: deviceSecret.client_id,
      trustGroupId: deviceSecret.trust_group_id,
    });
    if (!deviceSecretPolicy.allowed) {
      return deviceSecretPolicyErrorResponse(
        c,
        deviceSecretPolicy.code,
        deviceSecretPolicy.description
      );
    }

    const targetClientId = deviceSecret.client_id ?? client_id;
    // The owner must still be active, and a secret issued at or before a withdrawal of its
    // client's consent ends with it (as Native SSO refuses it).
    const ownerState = await readIntrospectedAccountState(c, {
      tenantId,
      userId: deviceSecret.user_id,
      clientId: targetClientId,
      coreAdapter: routedDeviceSecret!.coreAdapter,
      allowsExternalSubject: () => false,
      isWithdrawn: (state) =>
        predatesOAuthClientConsentRevocation(deviceSecret.created_at, state.revokedAt),
    });
    if (ownerState === 'unavailable') return accountStateUnavailableResponse(c);
    if (ownerState === 'inactive') return c.json<IntrospectionResponse>({ active: false });

    const targetClient =
      targetClientId === client_id
        ? clientRecord
        : await authCtx.repositories.client.findByClientId(targetClientId);
    const platform = normalizeDeviceSecretPlatform(deviceSecret.device_platform);
    const displayName = deviceSecret.device_name ?? '';

    return c.json<IntrospectionResponse>({
      active: true,
      token_type: 'device_secret',
      client_id: targetClientId,
      sub: deviceSecret.user_id,
      iss: issuerUrl,
      jti: deviceSecret.id,
      exp: Math.floor(deviceSecret.expires_at / 1000),
      iat: Math.floor(deviceSecret.created_at / 1000),
      installation_id: getDeviceSecretInstallationId(deviceSecret),
      ...(targetClient?.client_name && { app_display_name: targetClient.client_name }),
      platform,
      display_name: displayName,
      ...(displayName.length === 0 && {
        fallback_display_name: platform === 'unknown' ? 'Native device' : `${platform} device`,
      }),
    });
  }

  // Parse token to extract claims (without verification yet)
  let tokenPayload;
  try {
    tokenPayload = parseToken(token);
  } catch {
    // If token format is invalid, return inactive response (per RFC 7662)
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  const jti = tokenPayload.jti as string;
  const sub = tokenPayload.sub as string;
  // RFC 7519: aud can be a string or array of strings
  const audRaw = tokenPayload.aud;
  const audArray = normalizeStringClaim(audRaw);
  const aud = audArray[0]; // Primary audience for response
  const scope = tokenPayload.scope as string;
  const iss = tokenPayload.iss as string;
  const exp = tokenPayload.exp as number;
  const iat = tokenPayload.iat as number;
  // RFC 7519: nbf (not before) claim - token SHOULD NOT be valid before this time
  const nbf = tokenPayload.nbf as number | undefined;
  const tokenClientId =
    typeof tokenPayload.client_id === 'string' ? tokenPayload.client_id : undefined;
  // V2: Extract version for refresh token validation
  const rtv = typeof tokenPayload.rtv === 'number' ? tokenPayload.rtv : 1;
  // RFC 8693: Actor claim for delegation (Token Exchange)
  const act = tokenPayload.act as IntrospectionResponse['act'];
  // RFC 8693: Resource server URI (Token Exchange)
  const resourceArray = normalizeStringClaim(tokenPayload.resource);
  const resource =
    typeof tokenPayload.resource === 'string'
      ? tokenPayload.resource
      : resourceArray.length > 0
        ? resourceArray
        : undefined;
  // P1: RFC 9449: DPoP confirmation claim (cnf.jkt)
  const cnf = tokenPayload.cnf as { jkt: string } | undefined;
  // P2: RFC 7662 recommends including username for human-readable identifier
  // Use preferred_username from token if available, otherwise use sub
  const username = (tokenPayload.preferred_username as string) || sub;
  // RFC 9396: Rich Authorization Requests
  const authorizationDetails = tokenPayload.authorization_details as
    | IntrospectionResponse['authorization_details']
    | undefined;
  const authrimElevation = tokenPayload.authrim_elevation as
    | IntrospectionResponse['authrim_elevation']
    | undefined;

  // Load public key for verification
  // Strategy: Try to match kid from token header with JWKS first, fall back to PUBLIC_JWK_JSON
  let publicKey: CryptoKey | undefined;
  let tokenKid: string | undefined;

  // Extract kid from token header
  try {
    const header = decodeProtectedHeader(token);
    tokenKid = header.kid;
  } catch {
    // If we can't decode the header, continue without kid matching
  }

  // Get matching key with hierarchical caching (memory → KV → DO → env)
  const log = getLogger(c).module('INTROSPECT');
  const matchingKey = await getKeyByKid(c.env, getTenantIdFromContext(c), tokenKid);
  if (matchingKey) {
    try {
      publicKey = (await importJWK(matchingKey, 'RS256')) as CryptoKey;
    } catch (err) {
      log.error('Failed to import public key', { action: 'introspect' }, err as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  } else {
    log.error('No matching key found for token verification', { action: 'introspect' });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Verify token signature
  try {
    // Determine expected audience based on token content
    // For access tokens, aud should be the issuer URL
    // For refresh tokens, aud should be the client_id
    // Use the actual aud from the token to determine verification strategy
    const expectedAud = aud;
    // RFC 7662: Use the current tenant's canonical issuer for issuer validation
    // This prevents accepting tokens from other issuers even if signed with the same key
    const expectedIssuer = issuerUrl;
    if (!expectedIssuer) {
      log.error('ISSUER_URL not configured', { action: 'introspect' });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    await verifyToken(token, publicKey, expectedIssuer, { audience: expectedAud });
  } catch (error) {
    log.error('Token verification failed', { action: 'introspect' }, error as Error);
    // Token signature verification failed, return inactive
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // A valid AS signature does not establish JWT purpose. Authrim signs ID tokens and other
  // protocol artifacts with the same key family, so classify the token before caller
  // authorization or revocation processing. Explicit token_use is authoritative; legacy tokens
  // must satisfy the complete OAuth token shape.
  const introspectedTokenUse = resolveIntrospectableTokenUse(tokenPayload, token_type_hint);
  if (!introspectedTokenUse) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // RFC 7662 requires the authorization server to determine whether the authenticated caller may
  // introspect this token. Token ownership is sufficient; cross-client Resource Servers must be
  // explicitly named by a signed audience or resource claim. Unauthorized callers receive the same
  // inactive response as an invalid token to avoid exposing token metadata or ownership.
  if (!isIntrospectionCallerAuthorized(client_id, tokenClientId, audArray, resourceArray)) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // ========== Strict Validation Mode (KV-controlled) ==========
  // RFC 7662 does not require aud/client_id validation, but strictValidation
  // enables additional security checks for Token Introspection Control Plane Test
  let validationSettings: IntrospectionValidationSettings;
  try {
    validationSettings = await introspectionValidationSettings(c.env, getTenantIdFromContext(c));
  } catch {
    // Unknown settings must not relax validation: refuse instead of answering active=true.
    return c.json(
      { error: 'server_error', error_description: 'Introspection settings are unavailable' },
      503
    );
  }

  if (validationSettings.strictValidation) {
    // 1. Audience validation (RFC 7519: aud can be array)
    const expectedAudience = validationSettings.expectedAudience || issuerUrl || '';
    if (expectedAudience && !audArray.includes(expectedAudience)) {
      // Token audience does not match expected audience
      return c.json<IntrospectionResponse>({
        active: false,
      });
    }

    // 2. Client ID existence validation via Repository
    // Optimization: Skip D1 query if tokenClientId matches the already-authenticated client_id
    // (client_id was already verified in the client authentication step above)
    if (typeof tokenClientId === 'string' && tokenClientId && tokenClientId !== client_id) {
      const clientExists = await authCtx.repositories.client.findByClientId(tokenClientId);

      if (!clientExists) {
        // Client ID in token does not exist in database
        return c.json<IntrospectionResponse>({
          active: false,
        });
      }
    }
  }
  // ========== Strict Validation Mode END ==========

  // Check token timing constraints
  const now = Math.floor(Date.now() / 1000);

  // RFC 7519: Check nbf (not before) - token is not valid before this time
  if (nbf && nbf > now) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // Check if token is expired
  if (exp && exp < now) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // ========== Token Revocation/Existence Check ==========
  // A signed token_use claim determines the authoritative store. For legacy tokens that predate
  // token_use, RFC 7662's advisory token_type_hint selects the compatible lookup path after the
  // complete OAuth token shape has been validated above.

  let refreshFamily: { consentGeneration?: number; createdAt?: number } | null = null;
  if (introspectedTokenUse === 'refresh') {
    // Refresh tokens are active only while their authoritative family entry exists. token_type_hint
    // is advisory; a signed token_use claim takes precedence when present.
    const refreshTokenData = await getRefreshToken(c.env, sub, rtv, tokenClientId!, jti, tenantId);
    if (!refreshTokenData) {
      return c.json<IntrospectionResponse>({
        active: false,
      });
    }
    refreshFamily = {
      consentGeneration: refreshTokenData.family_consent_generation,
      createdAt: refreshTokenData.family_created_at,
    };
  } else {
    const revoked = await isTokenRevoked(c.env, jti, tenantId);
    if (revoked) {
      return c.json<IntrospectionResponse>({
        active: false,
      });
    }
  }
  // ========== Token Revocation/Existence Check END ==========

  // ========== Account State and Consent Check ==========
  // The user's account (in its account databases) must be active, so tokens end as soon as the
  // user is suspended, locked or deleted. A withdrawal of the consent a token was granted under
  // ends it, as the grants that issue tokens refuse it: a refresh family, or an access token, that
  // recorded an earlier consent generation; one recorded before generations was issued at or
  // before the withdrawal (an access token's iat is in whole seconds, so one issued within the
  // second of the withdrawal counts as issued before it). An access token from a Token Exchange
  // records the consent of its subject token, whose client may differ from its own.
  // A downstream elevation token is granted by an approval, not a consent; a client or admin
  // principal, or an elevation target that is not a user, has no account.
  const accessConsent = accessTokenConsentGrant(tokenPayload);
  const consentClientId = (!refreshFamily && accessConsent.clientId) || tokenClientId!;
  const elevationToken =
    typeof tokenPayload.authrim_elevation === 'object' && tokenPayload.authrim_elevation !== null;
  // The account a pairwise or persistent sub stands for, from the sealed reference the token
  // carries (bound to the client whose consent it was granted under).
  const subjectReference = await subjectAccountReference(
    c,
    tenantId,
    tokenPayload,
    consentClientId
  );
  if (subjectReference.kind === 'unavailable') return accountStateUnavailableResponse(c);
  if (subjectReference.kind === 'invalid') {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }
  const nonAccountSubject = namesNonAccountSubject(tokenPayload);
  // The account the token is for: the one a sealed reference names, else the sub.
  const accountUserId = subjectReference.kind === 'resolved' ? subjectReference.userId : sub;
  const accountState = nonAccountSubject
    ? 'active'
    : await readIntrospectedAccountState(c, {
        tenantId,
        userId: accountUserId,
        clientId: consentClientId,
        allowsExternalSubject: () =>
          introspectedTokenUse === 'access' && externalSubjectIssuer(tokenPayload) !== undefined,
        isWithdrawn: (state) =>
          refreshFamily
            ? isOAuthClientConsentGrantWithdrawn(state, {
                generation: refreshFamily.consentGeneration,
                issuedAt: refreshFamily.createdAt,
              })
            : !elevationToken && isAccessTokenConsentWithdrawn(state, tokenPayload),
      });
  if (accountState === 'unavailable') return accountStateUnavailableResponse(c);
  if (accountState === 'inactive') {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }
  // ========== Account State and Consent Check END ==========

  // Token is active, return introspection response
  // P1: Determine token_type based on cnf claim presence (RFC 9449)
  const tokenType: 'Bearer' | 'DPoP' = cnf ? 'DPoP' : 'Bearer';

  let response: Record<string, unknown> = {
    active: true,
    scope,
    client_id: tokenClientId,
    // P2: RFC 7662 recommends including username
    username,
    // P1: RFC 9449 - DPoP-bound tokens have token_type "DPoP"
    token_type: tokenType,
    exp,
    iat,
    // RFC 7519: Include nbf if present
    ...(nbf !== undefined && { nbf }),
    sub,
    aud,
    iss,
    jti,
    // P1: RFC 9449 - Include cnf claim for DPoP-bound tokens
    ...(cnf && { cnf }),
    // RFC 8693: Include actor claim if present (for Token Exchange delegated tokens)
    ...(act && { act }),
    // RFC 8693: Include resource if present (for Token Exchange with resource parameter)
    ...(resource && { resource }),
    // RFC 9396: Include authorization_details if present (RAR)
    ...(authorizationDetails && { authorization_details: authorizationDetails }),
    // Authrim downstream elevation context for high-risk service-side checks
    ...(authrimElevation && { authrim_elevation: authrimElevation }),
  };

  // A Resource Server profile is the only authority for introspection extension claims.
  // The token payload may contain claims released to its original audience; only claims
  // explicitly allowed for the authenticated caller survive this separate boundary.
  // Where the tenant has not turned extended claims on, no profile or mapping is used at all.
  let introspectionProfileAdapter: ReturnType<typeof requireDedicatedAdminDatabaseAdapter> | null =
    null;
  if (validationSettings.extendedClaims) {
    try {
      introspectionProfileAdapter = requireDedicatedAdminDatabaseAdapter(
        c.env,
        'introspection-destination-profile'
      );
    } catch (error) {
      log.error(
        'Failed to apply Resource Server destination profile; returning protocol claims only',
        { action: 'introspection_destination_profile', resourceServerId: client_id },
        error as Error
      );
    }
  }
  if (introspectionProfileAdapter) {
    try {
      response = await applyIntrospectionIdentityMapping({
        coreAdapter: authCtx.coreAdapter,
        adminAdapter: introspectionProfileAdapter,
        env: c.env,
        tenantId,
        resourceServerId: client_id,
        grantedScopes: scope ? scope.split(' ').filter(Boolean) : [],
        claims: { ...tokenPayload, ...response },
        // Custom attributes are read for the account the token is for, never by the public sub
        // (a pairwise identifier may equal another user's id); a subject without an account (a
        // client or admin principal, an external subject) has none.
        subjectAccountId:
          nonAccountSubject || accountState === 'active_without_account' ? null : accountUserId,
      });
    } catch (error) {
      log.error(
        'Resource Server destination profile rejected the introspection response',
        { action: 'introspection_destination_profile', resourceServerId: client_id },
        error as Error
      );
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  } else {
    response = filterIntrospectionProtocolEnvelopeClaims(response);
  }

  // Publish introspection event (non-blocking)
  // Only for active tokens - inactive responses don't need events
  publishEvent(c, {
    type: TOKEN_EVENTS.ACCESS_INTROSPECTED,
    tenantId,
    data: {
      jti,
      clientId: client_id, // Requesting client (not token's client_id)
      userId: sub || undefined,
      scopes: scope ? scope.split(' ') : undefined,
    } satisfies TokenEventData,
  }).catch((err: unknown) => {
    log.error(
      'Failed to publish token.access.introspected event',
      { action: 'publish_event' },
      err as Error
    );
  });

  return c.json(response);
}

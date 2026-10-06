/**
 * OAuth Consent Screen Handler
 * Handles OAuth2/OIDC consent screen display and approval/denial
 *
 * JSON API used by the Login UI, which renders the consent screen:
 * 1. GET /auth/consent?challenge_id=xxx - Returns consent screen data (JSON, with RBAC data)
 * 2. POST /auth/consent with JSON { challenge_id, approved, ... } - Process consent and
 *    return { redirect_url }
 *
 * Phase 2-B: Consent Screen Enhancement
 * - Organization info display
 * - Organization switching (via selected_org_id)
 * - Acting-as (delegation) support
 */

import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type {
  ConsentScreenData,
  ConsentClientInfo,
  ConsentScopeInfo,
  ConsentChallengeMetadata,
  ExtendedConsentScreenData,
  ExtendedConsentEventData,
  ConsentScreenItem,
} from '@authrim/ar-lib-core';
import {
  buildAuthorizeContinuationUrl,
  CONSENT_CONFIRMATION_COOKIE_NAME,
  createAuthorizationRequestContinuation,
} from './authorization-continuation';
import {
  getConsentRBACData,
  getConsentUserInfo,
  getActingAsUserInfo,
  validateActingAsRelationship,
  parseConsentFeatureFlags,
  getRolesInOrganization,
  invalidateConsentCache,
  getChallengeStoreByChallengeId,
  getSessionStoreBySessionId,
  isShardedSessionId,
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getTenantIdFromContext,
  getConsentDefaultExpirationDays,
  getConsentExpirationEnabled,
  getConsentGranularScopes,
  getConsentVersioningEnabled,
  // Event System
  publishEvent,
  CONSENT_EVENTS,
  type ConsentEventData,
  // Consent Versioning
  getCurrentPolicyVersions,
  checkRequiresReconsent,
  recordConsentHistory,
  // Consent Management
  getConsentItemsForScreen,
  processConsentItemDecisions,
  hashIpAddress,
  upsertOAuthClientConsent,
  findOAuthClientConsentRevocation,
  isOAuthClientConsentGenerationChanged,
  parseClaimsRequest,
  // Logger
  getLogger,
  resolveProtocolSettings,
  resolveClientTrustPolicy,
  resolveAccountDataContextFromHono,
  generateSecureRandomString,
  getSessionCookieSameSite,
} from '@authrim/ar-lib-core';
import { redirectWithError } from './authorize';
import type { FAPI2MessageSigningConfig } from './fapi-message-signing';

// Scope descriptions (human-readable)
const SCOPE_DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  openid: {
    title: 'Identity',
    description: 'Access your basic profile information',
  },
  profile: {
    title: 'Profile',
    description: 'Access your full profile (name, picture, etc.)',
  },
  email: {
    title: 'Email',
    description: 'Access your email address',
  },
  phone: {
    title: 'Phone',
    description: 'Access your phone number',
  },
  address: {
    title: 'Address',
    description: 'Access your physical address',
  },
  offline_access: {
    title: 'Offline Access',
    description: 'Maintain access when you are offline',
  },
};

type SessionBoundConsentChallenge = {
  userId: string;
  metadata?: ConsentChallengeMetadata & { session_id?: unknown };
};

async function validateConsentSessionBinding(
  c: Context<{ Bindings: Env }>,
  challenge: SessionBoundConsentChallenge
): Promise<Response | null> {
  const boundSessionId = challenge.metadata?.session_id;
  // Consent is an authenticated browser action. A bearer challenge without an explicit session
  // binding lets any holder approve it, so legacy/unbound challenges must fail closed.
  if (typeof boundSessionId !== 'string' || boundSessionId.length === 0) {
    return c.json(
      {
        error: 'access_denied',
        error_description: 'Consent approval requires the bound authenticated session',
      },
      401
    );
  }

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
        error_description: 'Consent approval requires the bound authenticated session',
      },
      401
    );
  }

  const tenantId = getTenantIdFromContext(c);
  const { stub } = getSessionStoreBySessionId(c.env, boundSessionId, tenantId);
  const session = (await stub.getSessionRpc(boundSessionId)) as {
    userId?: string;
    expiresAt?: number;
  } | null;
  if (
    !session ||
    session.userId !== challenge.userId ||
    typeof session.expiresAt !== 'number' ||
    session.expiresAt <= Date.now()
  ) {
    return c.json(
      {
        error: 'access_denied',
        error_description: 'Consent approval requires the bound authenticated session',
      },
      401
    );
  }

  return null;
}

async function createConsentConfirmationChallenge(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string,
  sessionId: string,
  authorizationRequest: Record<string, unknown>,
  /** A re-authentication /authorize completed before sending the user here; it hands it back. */
  confirmedReauth: unknown,
  /** The user's consent withdrawal generation for the client when the consent was approved. */
  consentGeneration: number
): Promise<{ id: string; browserBinding: string }> {
  const confirmationId = crypto.randomUUID();
  const browserBinding = generateSecureRandomString(32);
  const confirmationStore = await getChallengeStoreByChallengeId(c.env, confirmationId, tenantId);
  await confirmationStore.storeChallengeRpc({
    id: confirmationId,
    tenantId,
    type: 'consent',
    userId,
    challenge: confirmationId,
    ttl: 60,
    metadata: {
      purpose: 'authorize_consent_confirmation',
      sessionId,
      browserBinding,
      authorization_request: authorizationRequest,
      ...(confirmedReauth !== undefined ? { confirmed_reauth: confirmedReauth } : {}),
      consent_generation: consentGeneration,
    },
  });
  return { id: confirmationId, browserBinding };
}

/**
 * Parse scope string to ConsentScopeInfo array
 */
function parseScopesToInfo(scope: string): ConsentScopeInfo[] {
  const requestedScopes = scope.split(' ').filter((s) => s.length > 0);
  return requestedScopes.map((scopeName) => {
    const scopeInfo = SCOPE_DESCRIPTIONS[scopeName];
    return {
      name: scopeName,
      title: scopeInfo?.title || scopeName,
      description: scopeInfo?.description || `Access ${scopeName} data`,
      required: scopeName === 'openid',
    };
  });
}

function splitScopes(scope: string | undefined | null): string[] {
  return (scope ?? '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function collectRequestedClaimNames(claims: unknown): string[] {
  const parsed = parseClaimsRequest(typeof claims === 'string' ? claims : undefined);
  if (!parsed.ok || !parsed.request) return [];
  return Array.from(
    new Set([
      ...Object.keys(parsed.request.userinfo ?? {}),
      ...Object.keys(parsed.request.id_token ?? {}),
    ])
  );
}

/**
 * Get consent screen data for the Login UI
 * GET /auth/consent?challenge_id=xxx
 */
export async function consentGetHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CONSENT');

  try {
    const challenge_id = c.req.query('challenge_id');

    if (!challenge_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        },
        400
      );
    }

    // Retrieve consent challenge from ChallengeStore (RPC)
    // Use challengeId-based sharding
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challenge_id,
      getTenantIdFromContext(c)
    );

    const challengeData = await challengeStore.getChallengeRpc(challenge_id);

    if (!challengeData) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }

    const typedChallengeData = challengeData as {
      id: string;
      type: string;
      userId: string;
      metadata?: ConsentChallengeMetadata;
    };

    if (typedChallengeData.type !== 'consent') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid challenge type',
        },
        400
      );
    }

    const sessionError = await validateConsentSessionBinding(c, typedChallengeData);
    if (sessionError) return sessionError;

    const metadata = typedChallengeData.metadata || {};
    const client_id = metadata.client_id as string;
    const scope = metadata.scope as string;
    const userId = typedChallengeData.userId;

    // Load client metadata via Repository
    const tenantId = getTenantIdFromContext(c);
    const tenantAuthCtx = createAuthContextFromHono(c, tenantId);
    const [client, trustPolicy] = await Promise.all([
      tenantAuthCtx.repositories.client.findByClientId(client_id),
      resolveClientTrustPolicy(tenantAuthCtx.coreAdapter, tenantId, 'oidc_client', client_id),
    ]);

    // Map to clientRow format for compatibility
    const clientRow = client
      ? {
          client_id: client.client_id,
          client_name: client.client_name ?? null,
          logo_uri: client.logo_uri ?? null,
          client_uri: client.client_uri ?? null,
          policy_uri: client.policy_uri ?? null,
          tos_uri: client.tos_uri ?? null,
          // Legacy oauth_clients trust flags are compatibility data, not consent authority.
          is_trusted:
            trustPolicy?.first_party &&
            (trustPolicy.trusted || trustPolicy.skip_authorization_consent)
              ? 1
              : null,
        }
      : null;

    if (!clientRow) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        },
        401
      );
    }

    // Client and trust-policy metadata live in the tenant metadata database, while consent,
    // RBAC, and user material are account-scoped. Resolve the account route before crossing
    // that boundary so tenant metadata D1 is never used as an implicit user-store fallback.
    await resolveAccountDataContextFromHono(c, userId);

    // Parse scopes
    const scopeDetails = parseScopesToInfo(scope);

    // Return full consent screen data with RBAC info
    return handleJsonConsentGet(c, {
      challenge_id,
      userId,
      clientRow,
      scopeDetails,
      metadata,
    });
  } catch (error) {
    log.error('Consent get error', { action: 'get_consent' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve consent data',
      },
      500
    );
  }
}

/**
 * Handle JSON consent GET request with RBAC data
 */
async function handleJsonConsentGet(
  c: Context<{ Bindings: Env }>,
  params: {
    challenge_id: string;
    userId: string;
    clientRow: {
      client_id: string;
      client_name: string | null;
      logo_uri: string | null;
      client_uri: string | null;
      policy_uri: string | null;
      tos_uri: string | null;
      is_trusted: number | null;
    };
    scopeDetails: ConsentScopeInfo[];
    metadata: ConsentChallengeMetadata;
  }
): Promise<Response> {
  const { challenge_id, userId, clientRow, scopeDetails, metadata } = params;
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAccountAuthContextFromHono(c, tenantId);

  // Build client info
  const client: ConsentClientInfo = {
    client_id: clientRow.client_id,
    client_name: clientRow.client_name || clientRow.client_id,
    logo_uri: clientRow.logo_uri || undefined,
    client_uri: clientRow.client_uri || undefined,
    policy_uri: clientRow.policy_uri || undefined,
    tos_uri: clientRow.tos_uri || undefined,
    is_trusted: clientRow.is_trusted === 1,
  };

  // Get user info (PII/Non-PII DB separation)
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const userInfo = await getConsentUserInfo(
    authCtx.coreAdapter,
    userId,
    tenantId,
    piiCtx.defaultPiiAdapter
  );
  if (!userInfo) {
    return c.json(
      {
        error: 'access_denied',
        error_description: 'Authentication required',
      },
      401
    );
  }

  // Get RBAC data (organizations, roles)
  const rbacData = await getConsentRBACData(authCtx.coreAdapter, userId, tenantId);

  // Parse feature flags from environment
  const features = parseConsentFeatureFlags(
    c.env.ENABLE_RBAC_CONSENT_ORG_SELECTOR,
    c.env.ENABLE_RBAC_CONSENT_ACTING_AS,
    c.env.ENABLE_RBAC_CONSENT_SHOW_ROLES
  );

  // Get acting-as info if present in metadata
  let actingAsInfo = null;
  if (metadata.acting_as && features.acting_as_enabled) {
    actingAsInfo = await getActingAsUserInfo(
      authCtx.coreAdapter,
      userId,
      metadata.acting_as,
      tenantId
    );
  }

  // Determine target org and get roles for that org
  const targetOrgId = metadata.org_id || rbacData.primary_org?.id || null;
  let roles = rbacData.roles;

  // If targeting a specific org, get roles for that org
  if (targetOrgId) {
    roles = await getRolesInOrganization(authCtx.coreAdapter, userId, targetOrgId, tenantId);
  }

  // Get consent settings

  // Check versioning and re-consent requirements
  const versioningEnabled = await getConsentVersioningEnabled(c.env);
  const granularScopesEnabled = await getConsentGranularScopes(c.env);

  let versioningInfo:
    | {
        requiresReconsent: boolean;
        changedPolicies: string[];
        currentVersions: {
          privacyPolicy?: { version: string; policyUri?: string };
          termsOfService?: { version: string; policyUri?: string };
        };
      }
    | undefined;

  if (versioningEnabled) {
    // Policy versions are tenant metadata; the user's existing consent (read below) is account data.
    const currentVersions = await getCurrentPolicyVersions(
      createAuthContextFromHono(c, tenantId).coreAdapter,
      tenantId
    );

    // Check if re-consent is needed due to policy changes
    const reconsentCheck = await checkRequiresReconsent(
      authCtx.coreAdapter,
      userId,
      clientRow.client_id,
      tenantId,
      currentVersions
    );

    versioningInfo = {
      requiresReconsent: reconsentCheck.requiresReconsent,
      changedPolicies: reconsentCheck.changedPolicies,
      currentVersions: currentVersions
        ? {
            privacyPolicy: currentVersions.privacyPolicy
              ? {
                  version: currentVersions.privacyPolicy.version,
                  policyUri: currentVersions.privacyPolicy.policyUri,
                }
              : undefined,
            termsOfService: currentVersions.termsOfService
              ? {
                  version: currentVersions.termsOfService.version,
                  policyUri: currentVersions.termsOfService.policyUri,
                }
              : undefined,
          }
        : {},
    };
  }

  // Check consent management items
  let consentItems: ExtendedConsentScreenData['consent_items'];
  let consentManagementEnabled = false;
  let consentLanguage = 'en';

  try {
    // Check if consent management is enabled
    let mgmtEnabled = false;
    if (c.env.KV) {
      try {
        const kvVal = await c.env.KV.get('consent:consent_management_enabled');
        if (kvVal !== null) {
          mgmtEnabled = kvVal === 'true' || kvVal === '1';
        } else {
          const envVal = (c.env as unknown as Record<string, string>).ENABLE_CONSENT_MANAGEMENT;
          mgmtEnabled = envVal === 'true' || envVal === '1';
        }
      } catch {
        const envVal = (c.env as unknown as Record<string, string>).ENABLE_CONSENT_MANAGEMENT;
        mgmtEnabled = envVal === 'true' || envVal === '1';
      }
    } else {
      const envVal = (c.env as unknown as Record<string, string>).ENABLE_CONSENT_MANAGEMENT;
      mgmtEnabled = envVal === 'true' || envVal === '1';
    }

    // Determine language from ui_locales or Accept-Language
    const uiLocales = metadata.ui_locales as string | undefined;
    const acceptLang = c.req.header('Accept-Language');
    consentLanguage = uiLocales?.split(' ')[0] || acceptLang?.split(',')[0]?.split('-')[0] || 'en';

    // Get default language from settings
    let defaultLang = 'en';
    if (c.env.KV) {
      try {
        const kvLang = await c.env.KV.get('consent:default_language');
        if (kvLang) defaultLang = kvLang;
      } catch {
        /* use default */
      }
    }

    consentItems = await getConsentItemsForScreen(
      authCtx.coreAdapter,
      tenantId,
      clientRow.client_id,
      userId,
      consentLanguage,
      defaultLang,
      {
        target_type: 'oidc_client',
        target_id: clientRow.client_id,
        requested_scopes: splitScopes(metadata.scope as string | undefined),
        requested_claims: collectRequestedClaimNames(metadata.claims),
      },
      piiCtx.defaultPiiAdapter
    );
    consentManagementEnabled = mgmtEnabled || (consentItems?.length ?? 0) > 0;
  } catch (err) {
    // Non-blocking: consent management items are optional
  }

  // Build response with extended data
  const responseData: ExtendedConsentScreenData = {
    challenge_id,
    client,
    scopes: scopeDetails,
    user: userInfo,
    organizations: rbacData.organizations,
    primary_org: rbacData.primary_org,
    roles,
    acting_as: actingAsInfo,
    target_org_id: targetOrgId,
    features,
    // Extended consent features
    granular_scopes_enabled: granularScopesEnabled,
    versioning: versioningInfo,
    // Consent management
    consent_items: consentItems,
    consent_management_enabled: consentManagementEnabled,
    consent_language: consentLanguage,
  };

  return c.json(responseData);
}

async function loadConsentScreenItems(
  c: Context<{ Bindings: Env }>,
  params: {
    tenantId: string;
    clientId: string;
    userId: string;
    metadata: ConsentChallengeMetadata;
    language?: string;
    defaultLanguage?: string;
  }
): Promise<ConsentScreenItem[]> {
  const authCtx = createAccountAuthContextFromHono(c, params.tenantId);
  const piiCtx = createPIIContextFromHono(c, params.tenantId);
  return getConsentItemsForScreen(
    authCtx.coreAdapter,
    params.tenantId,
    params.clientId,
    params.userId,
    params.language ?? 'en',
    params.defaultLanguage ?? 'en',
    {
      target_type: 'oidc_client',
      target_id: params.clientId,
      requested_scopes: splitScopes(params.metadata.scope as string | undefined),
      requested_claims: collectRequestedClaimNames(params.metadata.claims),
    },
    piiCtx.defaultPiiAdapter
  );
}

/**
 * Handle consent approval/denial
 * POST /auth/consent
 *
 * JSON body only: { challenge_id, approved, selected_org_id, acting_as_user_id, selected_scopes,
 * acknowledged_policy_versions, consent_item_decisions }. Responds with { redirect_url }.
 */
export async function consentPostHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CONSENT');

  try {
    const contentType = c.req.header('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Content-Type must be application/json',
        },
        400
      );
    }

    const jsonBody = await c.req.json<{
      challenge_id?: string;
      approved?: boolean;
      selected_org_id?: string;
      acting_as_user_id?: string;
      selected_scopes?: string[];
      acknowledged_policy_versions?: { privacy_policy?: string; terms_of_service?: string };
      consent_item_decisions?: Record<string, 'granted' | 'denied'>;
    }>();
    const challenge_id = jsonBody.challenge_id;
    const approved = jsonBody.approved === true;
    const selected_org_id = jsonBody.selected_org_id;
    const acting_as_user_id = jsonBody.acting_as_user_id;
    const selected_scopes = jsonBody.selected_scopes;
    const acknowledged_policy_versions = jsonBody.acknowledged_policy_versions;
    const consent_item_decisions = jsonBody.consent_item_decisions;

    if (!challenge_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        },
        400
      );
    }

    // Verify the current browser session before consuming the bearer challenge. The challenge is
    // routing state, not proof that the stored user approved this operation.
    // Use challengeId-based sharding - must match the shard used during challenge creation
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challenge_id,
      getTenantIdFromContext(c)
    );

    const pendingChallenge = (await challengeStore.getChallengeRpc(
      challenge_id
    )) as SessionBoundConsentChallenge | null;
    if (!pendingChallenge) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }
    const sessionError = await validateConsentSessionBinding(c, pendingChallenge);
    if (sessionError) return sessionError;
    const consentSessionId = pendingChallenge.metadata!.session_id as string;

    // The consent withdrawal generation an approval is given under, read before the challenge is
    // consumed so a failed read leaves the consent screen usable. The consent is recorded only
    // while it is still current, and /authorize issues the code under it.
    let consentGeneration = 0;
    if (approved) {
      const pendingClientId = pendingChallenge.metadata?.client_id;
      if (typeof pendingClientId !== 'string' || pendingClientId.length === 0) {
        return c.json(
          { error: 'invalid_request', error_description: 'Invalid or expired challenge' },
          400
        );
      }
      try {
        await resolveAccountDataContextFromHono(c, pendingChallenge.userId);
        consentGeneration = (
          await findOAuthClientConsentRevocation(
            createAccountAuthContextFromHono(c, getTenantIdFromContext(c)).coreAdapter,
            {
              tenantId: getTenantIdFromContext(c),
              userId: pendingChallenge.userId,
              clientId: pendingClientId,
            }
          )
        ).generation;
      } catch (error) {
        log.error('Failed to read consent withdrawals', { action: 'grant' }, error as Error);
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Consent state is temporarily unavailable',
          },
          503
        );
      }
    }

    let consumedChallengeData: {
      userId: string;
      metadata?: ConsentChallengeMetadata;
    };

    try {
      consumedChallengeData = (await challengeStore.consumeChallengeRpc({
        id: challenge_id,
        tenantId: getTenantIdFromContext(c),
        type: 'consent',
        challenge: challenge_id,
      })) as { userId: string; metadata?: ConsentChallengeMetadata };
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }

    const metadata = consumedChallengeData.metadata || {};
    const userId = consumedChallengeData.userId;

    // If denied, return the error redirect for the Login UI to follow
    // User cancellation uses cancel_uri (Authrim Extension) if available
    if (!approved) {
      const tenantId = getTenantIdFromContext(c);

      // Publish consent.denied event (non-blocking)
      publishEvent(c, {
        type: CONSENT_EVENTS.DENIED,
        tenantId,
        data: {
          userId,
          clientId: metadata.client_id as string,
          scopes: (metadata.scope as string).split(' '),
        } satisfies ConsentEventData,
      }).catch((err) => {
        log.warn('Failed to publish consent.denied event', { action: 'event_publish' });
      });

      const redirectUri = metadata.redirect_uri as string;
      const cancelUri = metadata.cancel_uri as string | undefined;

      const responseMode = metadata.response_mode as string | undefined;
      const isJarm =
        responseMode === 'jwt' ||
        (typeof responseMode === 'string' && responseMode.endsWith('.jwt'));
      if (isJarm) {
        const clientId = metadata.client_id;
        if (typeof clientId !== 'string' || clientId.length === 0) {
          return c.json(
            {
              error: 'server_error',
              error_description: 'Unable to create JWT-secured authorization error response',
            },
            500
          );
        }

        let messageSigning: FAPI2MessageSigningConfig | undefined;
        try {
          const settings = await resolveProtocolSettings(c.env, tenantId, {
            clientId,
            sections: ['fapi'],
          });
          messageSigning = settings.fapi.messageSigning;
        } catch (error) {
          log.error(
            'Failed to load JARM settings for consent denial',
            { action: 'settings_load' },
            error as Error
          );
          return c.json(
            {
              error: 'temporarily_unavailable',
              error_description: 'Security profile settings are temporarily unavailable',
            },
            503
          );
        }

        const response = await redirectWithError(
          c,
          redirectUri,
          'access_denied',
          'User denied the consent request',
          metadata.state as string | undefined,
          {
            responseMode,
            responseType: metadata.response_type,
            clientId,
            messageSigning,
            cancelUri,
            isUserCancellation: true,
          }
        );
        const location = response.headers.get('Location');
        if (location) {
          return c.json({ redirect_url: location });
        }
        return response;
      }

      // Use cancel_uri for user-initiated denial, fallback to redirect_uri
      const targetUri = cancelUri || redirectUri;
      const redirectUrl = new URL(targetUri);
      redirectUrl.searchParams.set('error', 'access_denied');
      redirectUrl.searchParams.set('error_description', 'User denied the consent request');
      // state is always included (same rules as redirect_uri)
      if (metadata.state) {
        redirectUrl.searchParams.set('state', metadata.state as string);
      }

      // The Login UI navigates to the returned URL
      return c.json({ redirect_url: redirectUrl.toString() });
    }

    // Save consent via Adapter (database-agnostic)
    const requestedScope = metadata.scope as string;
    const client_id = metadata.client_id as string;
    const consentId = crypto.randomUUID();
    const now = Date.now();

    // Use selected_org_id if provided, otherwise use metadata.org_id
    const effectiveOrgId = selected_org_id || metadata.org_id || null;

    // Get AuthContext for database access
    const tenantId = getTenantIdFromContext(c);
    await resolveAccountDataContextFromHono(c, userId);
    const authCtx = createAccountAuthContextFromHono(c, tenantId);

    const requestedActingAsUserId =
      acting_as_user_id ||
      (typeof metadata.acting_as === 'string' ? metadata.acting_as : undefined);
    let validatedActingAsUserId: string | undefined;
    if (requestedActingAsUserId) {
      const features = parseConsentFeatureFlags(
        c.env.ENABLE_RBAC_CONSENT_ORG_SELECTOR,
        c.env.ENABLE_RBAC_CONSENT_ACTING_AS,
        c.env.ENABLE_RBAC_CONSENT_SHOW_ROLES
      );
      if (!features.acting_as_enabled) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Acting-as consent is not permitted',
          },
          403
        );
      }

      const relationship = await validateActingAsRelationship(
        authCtx.coreAdapter,
        userId,
        requestedActingAsUserId,
        tenantId
      );
      if (!relationship.valid) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Acting-as consent is not permitted',
          },
          403
        );
      }
      validatedActingAsUserId = requestedActingAsUserId;
    }

    // Get settings for granular scopes and expiration
    const granularScopesEnabled = await getConsentGranularScopes(c.env);
    const expirationEnabled = await getConsentExpirationEnabled(c.env);
    const defaultExpirationDays = await getConsentDefaultExpirationDays(c.env);

    // Determine effective scope (granular scopes or all requested)
    let effectiveScope = requestedScope;
    let selectedScopesJson: string | null = null;

    if (granularScopesEnabled && selected_scopes && selected_scopes.length > 0) {
      // Validate: openid is required and cannot be deselected
      if (!selected_scopes.includes('openid')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'The openid scope is required and cannot be deselected',
          },
          400
        );
      }

      // Filter to only include scopes that were originally requested
      const requestedScopeList = requestedScope.split(' ');
      const validSelectedScopes = selected_scopes.filter((s) => requestedScopeList.includes(s));

      if (validSelectedScopes.length === 0) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'At least one valid scope must be selected',
          },
          400
        );
      }

      effectiveScope = validSelectedScopes.join(' ');
      selectedScopesJson = JSON.stringify(validSelectedScopes);
    }

    const consentItems = await loadConsentScreenItems(c, {
      tenantId,
      clientId: client_id,
      userId,
      metadata,
      language: 'en',
      defaultLanguage: 'en',
    });
    const targets = Object.fromEntries(
      consentItems.map((item) => [
        item.statement_id,
        {
          version_id: item.version_id,
          version: item.version,
          withdrawal_allowed: item.withdrawal_allowed,
        },
      ])
    );
    const submittedConsentItemDecisions = consent_item_decisions ?? {};
    const validConsentItemDecisions = Object.fromEntries(
      consentItems.map((item) => {
        const submittedDecision = submittedConsentItemDecisions[item.statement_id];
        return [
          item.statement_id,
          submittedDecision === 'granted' || submittedDecision === 'denied'
            ? submittedDecision
            : item.checkbox_mode === 'none'
              ? 'granted'
              : 'denied',
        ];
      })
    ) as Record<string, 'granted' | 'denied'>;
    const missingRequiredConsentItems = consentItems.filter(
      (item) =>
        item.is_required &&
        item.enforcement === 'block' &&
        validConsentItemDecisions[item.statement_id] !== 'granted'
    );
    if (missingRequiredConsentItems.length > 0) {
      return c.json(
        {
          error: 'consent_required',
          error_description: 'Required consent items must be granted',
        },
        400
      );
    }

    // Calculate expiration if enabled
    let expiresAt: number | null = null;
    if (expirationEnabled && defaultExpirationDays > 0) {
      expiresAt = now + defaultExpirationDays * 24 * 60 * 60 * 1000;
    }

    // Get policy versions if versioning is enabled
    const privacyPolicyVersion = acknowledged_policy_versions?.privacy_policy || null;
    const tosVersion = acknowledged_policy_versions?.terms_of_service || null;

    try {
      await upsertOAuthClientConsent(authCtx.coreAdapter, {
        consentId,
        userId,
        clientId: client_id,
        tenantId,
        scope: effectiveScope,
        selectedScopesJson,
        grantedAt: now,
        expiresAt,
        privacyPolicyVersion,
        tosVersion,
        now,
        consentGeneration,
      });
    } catch (error) {
      // Withdrawn while the user was approving: nothing was recorded; approve again.
      if (isOAuthClientConsentGenerationChanged(error)) {
        return c.json(
          {
            error: 'consent_withdrawn',
            error_description:
              'Consent for this application changed while it was being approved. Start again.',
          },
          409
        );
      }
      throw error;
    }

    // Invalidate consent cache so next check reflects updated consent
    await invalidateConsentCache(c.env, userId, tenantId, client_id);

    // Process consent item decisions (consent management)
    if (consentItems.length > 0) {
      const hasBlockingConsentItems = consentItems.some(
        (item) => item.is_required && item.enforcement === 'block'
      );
      try {
        const ipAddress = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
        const ipHash = ipAddress
          ? await hashIpAddress(ipAddress, tenantId, c.env.KV ?? null)
          : undefined;

        await processConsentItemDecisions(
          authCtx.coreAdapter,
          tenantId,
          userId,
          validConsentItemDecisions,
          {
            ip_address: ipAddress || undefined,
            user_agent: c.req.header('User-Agent'),
            client_id,
          },
          ipHash,
          targets
        );

        // Publish events for each decision
        for (const [statementId, decision] of Object.entries(validConsentItemDecisions)) {
          const eventType =
            decision === 'granted' ? CONSENT_EVENTS.ITEM_GRANTED : CONSENT_EVENTS.ITEM_DENIED;
          if (eventType) {
            publishEvent(c, {
              type: eventType,
              tenantId,
              data: {
                userId,
                clientId: client_id,
                scopes: effectiveScope.split(' '),
              } satisfies ConsentEventData,
            }).catch((eventErr) => {
              log.warn('Failed to publish consent event', {
                action: 'consent_event',
                eventType,
                statementId,
                decision,
                error: eventErr instanceof Error ? eventErr.message : 'Unknown error',
              });
            });
          }
        }
      } catch (err) {
        log.warn('Failed to process consent item decisions', { action: 'consent_items' });
        if (hasBlockingConsentItems) {
          return c.json(
            {
              error: 'server_error',
              error_description: 'Failed to record required consent items',
            },
            500
          );
        }
      }
    }

    // Check if versioning is enabled for history recording
    const versioningEnabled = await getConsentVersioningEnabled(c.env);

    // Determine if this is a new consent or update
    // (We check by looking at consent_history or by the presence of policy versions)
    const isVersionUpgrade = versioningEnabled && (privacyPolicyVersion || tosVersion);

    // Record consent history for audit trail (GDPR compliance)
    if (versioningEnabled) {
      try {
        await recordConsentHistory(authCtx.coreAdapter, {
          tenantId,
          userId,
          clientId: client_id,
          action: isVersionUpgrade ? 'version_upgraded' : 'granted',
          scopesAfter: effectiveScope.split(' '),
          privacyPolicyVersion: privacyPolicyVersion ?? undefined,
          tosVersion: tosVersion ?? undefined,
          userAgent: c.req.header('User-Agent'),
        });
      } catch (historyError) {
        log.warn('Failed to record consent history', { action: 'record_history' });
        // Non-blocking - don't fail the consent flow
      }
    }

    // Publish consent.granted event (non-blocking)
    publishEvent(c, {
      type: CONSENT_EVENTS.GRANTED,
      tenantId,
      data: {
        userId,
        clientId: client_id,
        scopes: effectiveScope.split(' '),
      } satisfies ConsentEventData,
    }).catch((err) => {
      log.warn('Failed to publish consent.granted event', { action: 'event_publish' });
    });

    // Publish VERSION_UPGRADED event if policy versions were acknowledged
    if (isVersionUpgrade) {
      publishEvent(c, {
        type: CONSENT_EVENTS.VERSION_UPGRADED,
        tenantId,
        data: {
          userId,
          clientId: client_id,
          scopes: effectiveScope.split(' '),
          newPrivacyPolicyVersion: privacyPolicyVersion ?? undefined,
          newTosVersion: tosVersion ?? undefined,
        } satisfies ExtendedConsentEventData,
      }).catch((err) => {
        log.warn('Failed to publish consent.version_upgraded event', { action: 'event_publish' });
      });
    }

    // PII Protection: Don't log userId (can be used for user tracking)
    log.info('Consent granted', { action: 'grant', scope: effectiveScope });

    const authorizationMetadata = metadata as unknown as Record<string, unknown>;
    const authorizationRequest = createAuthorizationRequestContinuation(authorizationMetadata, {
      scope: effectiveScope,
      org_id: effectiveOrgId || undefined,
      acting_as: validatedActingAsUserId,
    });
    const consentConfirmation = await createConsentConfirmationChallenge(
      c,
      tenantId,
      userId,
      consentSessionId,
      authorizationRequest,
      authorizationMetadata.confirmed_reauth,
      consentGeneration
    );
    const redirectUrl = buildAuthorizeContinuationUrl(
      authorizationMetadata,
      consentConfirmation.id,
      c.env.ISSUER_URL || 'https://authrim.local',
      '_consent_confirmation_challenge'
    );

    const response = c.json({ redirect_url: redirectUrl });
    response.headers.append(
      'Set-Cookie',
      `${CONSENT_CONFIRMATION_COOKIE_NAME}=${encodeURIComponent(
        consentConfirmation.browserBinding
      )}; Path=/authorize; HttpOnly; SameSite=${getSessionCookieSameSite(
        c.env
      )}; Secure; Max-Age=120`
    );
    return response;
  } catch (error) {
    log.error('Consent post error', { action: 'post_consent' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process consent',
      },
      500
    );
  }
}

/**
 * OAuth Consent Screen Handler
 * Handles OAuth2/OIDC consent screen display and approval/denial
 *
 * Flow:
 * 1. GET /auth/consent?challenge_id=xxx - Show consent screen
 *    - Accept: application/json -> Returns JSON with RBAC data
 *    - Accept: text/html -> Returns HTML page (fallback)
 * 2. POST /auth/consent with { challenge_id, approved, ... } - Process consent
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
} from '@authrim/ar-lib-core';
import {
  getConsentRBACData,
  getConsentUserInfo,
  getActingAsUserInfo,
  parseConsentFeatureFlags,
  getRolesInOrganization,
  invalidateConsentCache,
  getChallengeStoreByChallengeId,
  createAuthContextFromHono,
  getTenantIdFromContext,
  createOAuthConfigManager,
  // Event System
  publishEvent,
  CONSENT_EVENTS,
  type ConsentEventData,
  // Consent Versioning
  getCurrentPolicyVersions,
  checkRequiresReconsent,
  recordConsentHistory,
  // Logger
  getLogger,
} from '@authrim/ar-lib-core';

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

/**
 * Check if the request accepts JSON
 */
function acceptsJson(c: Context): boolean {
  const accept = c.req.header('Accept') || '';
  return accept.includes('application/json');
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

/**
 * Get consent screen data and show consent UI
 * GET /auth/consent?challenge_id=xxx
 *
 * Returns JSON if Accept: application/json, otherwise HTML
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
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

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

    const metadata = typedChallengeData.metadata || {};
    const client_id = metadata.client_id as string;
    const scope = metadata.scope as string;
    const userId = typedChallengeData.userId;

    // Load client metadata via Repository
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const client = await authCtx.repositories.client.findByClientId(client_id);

    // Map to clientRow format for compatibility
    const clientRow = client
      ? {
          client_id: client.client_id,
          client_name: client.client_name ?? null,
          logo_uri: client.logo_uri ?? null,
          client_uri: client.client_uri ?? null,
          policy_uri: client.policy_uri ?? null,
          tos_uri: client.tos_uri ?? null,
          is_trusted: client.is_trusted ? 1 : null,
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

    // Parse scopes
    const scopeDetails = parseScopesToInfo(scope);

    // If JSON is accepted, return full consent screen data with RBAC info
    if (acceptsJson(c)) {
      return handleJsonConsentGet(c, {
        challenge_id,
        userId,
        clientRow,
        scopeDetails,
        metadata,
      });
    }

    // Otherwise, return HTML (legacy fallback)
    return renderHtmlConsent(c, {
      challenge_id,
      clientRow,
      scopeDetails,
      client_id,
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
  const userInfo = await getConsentUserInfo(c.env.DB, userId, c.env.DB_PII);
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
  const rbacData = await getConsentRBACData(c.env.DB, userId);

  // Parse feature flags from environment
  const features = parseConsentFeatureFlags(
    c.env.RBAC_CONSENT_ORG_SELECTOR,
    c.env.RBAC_CONSENT_ACTING_AS,
    c.env.RBAC_CONSENT_SHOW_ROLES
  );

  // Get acting-as info if present in metadata
  let actingAsInfo = null;
  if (metadata.acting_as && features.acting_as_enabled) {
    actingAsInfo = await getActingAsUserInfo(c.env.DB, userId, metadata.acting_as);
  }

  // Determine target org and get roles for that org
  const targetOrgId = metadata.org_id || rbacData.primary_org?.id || null;
  let roles = rbacData.roles;

  // If targeting a specific org, get roles for that org
  if (targetOrgId) {
    roles = await getRolesInOrganization(c.env.DB, userId, targetOrgId);
  }

  // Get consent settings
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const configManager = createOAuthConfigManager(c.env);

  // Check versioning and re-consent requirements
  const versioningEnabled = await configManager.getConsentVersioningEnabled();
  const granularScopesEnabled = await configManager.getConsentGranularScopes();

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
    // Get current policy versions
    const currentVersions = await getCurrentPolicyVersions(authCtx.coreAdapter, tenantId);

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
  };

  return c.json(responseData);
}

/**
 * Escape HTML special characters to prevent XSS
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
 * Render HTML consent page (legacy fallback)
 * OIDC Dynamic OP conformance: displays logo_uri, policy_uri, tos_uri
 */
function renderHtmlConsent(
  c: Context<{ Bindings: Env }>,
  params: {
    challenge_id: string;
    clientRow: {
      client_id: string;
      client_name: string | null;
      logo_uri: string | null;
      policy_uri: string | null;
      tos_uri: string | null;
    };
    scopeDetails: ConsentScopeInfo[];
    client_id: string;
  }
): Response {
  const { challenge_id, clientRow, scopeDetails, client_id } = params;

  // Build client info section with logo (OIDC Dynamic OP conformance)
  const clientInfoHtml = clientRow.logo_uri
    ? `<div class="client-logo-container">
        <img src="${escapeHtml(clientRow.logo_uri)}" alt="${escapeHtml(clientRow.client_name || 'Client')} logo" class="client-logo" onerror="this.style.display='none'">
      </div>`
    : '';

  // Build links section for policy and ToS
  const linksHtml =
    clientRow.policy_uri || clientRow.tos_uri
      ? `<div class="client-links">
        ${clientRow.policy_uri ? `<a href="${escapeHtml(clientRow.policy_uri)}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>` : ''}
        ${clientRow.tos_uri ? `<a href="${escapeHtml(clientRow.tos_uri)}" target="_blank" rel="noopener noreferrer">Terms of Service</a>` : ''}
      </div>`
      : '';

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Consent Required</title>
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
    .client-logo-container {
      text-align: center;
      margin-bottom: 1rem;
    }
    .client-logo {
      max-width: 120px;
      max-height: 80px;
      object-fit: contain;
    }
    h1 {
      margin: 0 0 0.5rem 0;
      font-size: 1.5rem;
      color: #333;
    }
    .client-name {
      margin: 0 0 1rem 0;
      color: #667eea;
      font-weight: 600;
    }
    .client-links {
      margin-bottom: 1.5rem;
      font-size: 0.8rem;
    }
    .client-links a {
      color: #667eea;
      text-decoration: none;
      margin-right: 1rem;
    }
    .client-links a:hover {
      text-decoration: underline;
    }
    p {
      margin: 0 0 1.5rem 0;
      color: #666;
      line-height: 1.5;
    }
    .scopes {
      list-style: none;
      padding: 0;
      margin: 0 0 1.5rem 0;
    }
    .scope-item {
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      background: #f5f5f5;
      border-radius: 4px;
    }
    .scope-title {
      font-weight: 600;
      color: #333;
    }
    .scope-desc {
      font-size: 0.875rem;
      color: #666;
      margin-top: 0.25rem;
    }
    .button-group {
      display: flex;
      gap: 1rem;
    }
    button {
      flex: 1;
      padding: 0.75rem;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .approve {
      background: #667eea;
      color: white;
    }
    .approve:hover {
      background: #5568d3;
    }
    .deny {
      background: #e0e0e0;
      color: #333;
    }
    .deny:hover {
      background: #d0d0d0;
    }
  </style>
</head>
<body>
  <div class="container">
    ${clientInfoHtml}
    <h1>Consent Required</h1>
    <p class="client-name">${escapeHtml(clientRow.client_name || client_id)}</p>
    ${linksHtml}
    <p>This application is requesting access to:</p>
    <ul class="scopes">
      ${scopeDetails
        .map(
          (s) => `
        <li class="scope-item">
          <div class="scope-title">${escapeHtml(s.title)}</div>
          <div class="scope-desc">${escapeHtml(s.description)}</div>
        </li>
      `
        )
        .join('')}
    </ul>
    <div class="button-group">
      <form method="POST" action="/auth/consent" style="flex: 1;">
        <input type="hidden" name="challenge_id" value="${escapeHtml(challenge_id)}">
        <input type="hidden" name="approved" value="false">
        <button type="submit" class="deny">Deny</button>
      </form>
      <form method="POST" action="/auth/consent" style="flex: 1;">
        <input type="hidden" name="challenge_id" value="${escapeHtml(challenge_id)}">
        <input type="hidden" name="approved" value="true">
        <button type="submit" class="approve">Approve</button>
      </form>
    </div>
  </div>
</body>
</html>`);
}

/**
 * Handle consent approval/denial
 * POST /auth/consent
 *
 * Supports both form data and JSON body:
 * - Form: challenge_id, approved, selected_org_id (optional)
 * - JSON: { challenge_id, approved, selected_org_id, acting_as_user_id, selected_scopes }
 */
export async function consentPostHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CONSENT');

  try {
    // Determine content type and parse body
    const contentType = c.req.header('Content-Type') || '';
    let challenge_id: string | undefined;
    let approved: boolean;
    let selected_org_id: string | undefined;
    let acting_as_user_id: string | undefined;

    let selected_scopes: string[] | undefined;
    let acknowledged_policy_versions:
      | { privacy_policy?: string; terms_of_service?: string }
      | undefined;

    if (contentType.includes('application/json')) {
      // Parse JSON body
      const jsonBody = await c.req.json<{
        challenge_id?: string;
        approved?: boolean;
        selected_org_id?: string;
        acting_as_user_id?: string;
        selected_scopes?: string[];
        acknowledged_policy_versions?: { privacy_policy?: string; terms_of_service?: string };
      }>();
      challenge_id = jsonBody.challenge_id;
      approved = jsonBody.approved === true;
      selected_org_id = jsonBody.selected_org_id;
      acting_as_user_id = jsonBody.acting_as_user_id;
      selected_scopes = jsonBody.selected_scopes;
      acknowledged_policy_versions = jsonBody.acknowledged_policy_versions;
    } else {
      // Parse form data
      const body = await c.req.parseBody();
      challenge_id = typeof body.challenge_id === 'string' ? body.challenge_id : undefined;
      approved = body.approved === 'true';
      selected_org_id = typeof body.selected_org_id === 'string' ? body.selected_org_id : undefined;
      acting_as_user_id =
        typeof body.acting_as_user_id === 'string' ? body.acting_as_user_id : undefined;
      // Form data doesn't support selected_scopes (use JSON for granular consent)
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

    // Consume consent challenge from ChallengeStore (RPC)
    // Use challengeId-based sharding - must match the shard used during challenge creation
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

    let consumedChallengeData: {
      userId: string;
      metadata?: ConsentChallengeMetadata;
    };

    try {
      consumedChallengeData = (await challengeStore.consumeChallengeRpc({
        id: challenge_id,
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

    // If denied, redirect with error
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

      // Use cancel_uri for user-initiated denial, fallback to redirect_uri
      const targetUri = cancelUri || redirectUri;
      const redirectUrl = new URL(targetUri);
      redirectUrl.searchParams.set('error', 'access_denied');
      redirectUrl.searchParams.set('error_description', 'User denied the consent request');
      // state is always included (same rules as redirect_uri)
      if (metadata.state) {
        redirectUrl.searchParams.set('state', metadata.state as string);
      }

      // For JSON requests, return redirect URL instead of redirecting
      if (contentType.includes('application/json')) {
        return c.json({ redirect_url: redirectUrl.toString() });
      }
      return c.redirect(redirectUrl.toString(), 302);
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
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Get settings for granular scopes and expiration
    const configManager = createOAuthConfigManager(c.env);
    const granularScopesEnabled = await configManager.getConsentGranularScopes();
    const expirationEnabled = await configManager.getConsentExpirationEnabled();
    const defaultExpirationDays = await configManager.getConsentDefaultExpirationDays();

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

    // Calculate expiration if enabled
    let expiresAt: number | null = null;
    if (expirationEnabled && defaultExpirationDays > 0) {
      expiresAt = now + defaultExpirationDays * 24 * 60 * 60 * 1000;
    }

    // Get policy versions if versioning is enabled
    const privacyPolicyVersion = acknowledged_policy_versions?.privacy_policy || null;
    const tosVersion = acknowledged_policy_versions?.terms_of_service || null;

    // Insert or update consent with new columns
    await authCtx.coreAdapter.execute(
      `INSERT OR REPLACE INTO oauth_client_consents
       (id, user_id, client_id, scope, selected_scopes, granted_at, expires_at,
        privacy_policy_version, tos_version, consent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT consent_version + 1 FROM oauth_client_consents WHERE user_id = ? AND client_id = ?), 1),
        COALESCE((SELECT created_at FROM oauth_client_consents WHERE user_id = ? AND client_id = ?), ?),
        ?)`,
      [
        consentId,
        userId,
        client_id,
        effectiveScope,
        selectedScopesJson,
        now,
        expiresAt,
        privacyPolicyVersion,
        tosVersion,
        userId,
        client_id,
        userId,
        client_id,
        now,
        now,
      ]
    );

    // Invalidate consent cache so next check reflects updated consent
    await invalidateConsentCache(c.env, userId, client_id);

    // Check if versioning is enabled for history recording
    const versioningEnabled = await configManager.getConsentVersioningEnabled();

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

    // Build query string for internal redirect to /authorize
    const params = new URLSearchParams();
    if (metadata.response_type) params.set('response_type', metadata.response_type as string);
    if (metadata.client_id) params.set('client_id', metadata.client_id as string);
    if (metadata.redirect_uri) params.set('redirect_uri', metadata.redirect_uri as string);
    // Use effective scope (may be reduced if granular scopes is enabled)
    params.set('scope', effectiveScope);
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

    // Add RBAC parameters
    if (effectiveOrgId) {
      params.set('org_id', effectiveOrgId);
    }
    if (acting_as_user_id || metadata.acting_as) {
      params.set('acting_as', acting_as_user_id || (metadata.acting_as as string));
    }

    // Custom Redirect URIs (Authrim Extension)
    if (metadata.error_uri) params.set('error_uri', metadata.error_uri as string);
    if (metadata.cancel_uri) params.set('cancel_uri', metadata.cancel_uri as string);

    // Add flag to indicate consent is confirmed
    params.set('_consent_confirmed', 'true');

    // Redirect to /authorize with original parameters
    const redirectUrl = `/authorize?${params.toString()}`;

    // For JSON requests, return redirect URL instead of redirecting
    if (contentType.includes('application/json')) {
      return c.json({ redirect_url: redirectUrl });
    }
    return c.redirect(redirectUrl, 302);
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

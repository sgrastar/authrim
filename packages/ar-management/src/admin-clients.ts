import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  createAuthContextFromHono,
  D1Adapter,
  createErrorResponse,
  createCompatibilityErrorResponse,
  AR_ERROR_CODES,
  validateAllowedOrigins,
  createAuditLogFromContext,
  scheduleAuditLogFromContext,
  getLogger,
  hashClientSecret,
  publishEvent,
  CLIENT_EVENTS,
  type ClientEventData,
  invalidateClientCache,
  invalidateClientCacheOnDelete,
  putClient,
  buildKVKey,
  getClient,
  getWebOriginRegistry,
  replaceWebOriginRegistry,
  validateWebOriginRegistryPayload,
  invalidateWebOriginRegistryCache,
  type WebOriginRegistryDocument,
  type WebOriginRegistryWritePayload,
  DEFAULT_ASC_ALLOWED_TRANSFORMED_CLAIMS,
  type ClaimReleasePolicy,
} from '@authrim/ar-lib-core';
import {
  parseClientStringArray,
  isCharArrayLike,
  logSanitizedError,
  getErrorDetailsForResponse,
  scheduleAdminAuditLog,
  toMilliseconds,
} from './admin-shared';

type AdminClientApplicationType = 'web' | 'native' | 'spa' | 'service';
type AdminBrowserPublicClientMode = 'strict' | 'cookie_fallback' | 'legacy';
type AdminBrowserRefreshTokenPolicy = 'disabled' | 'dpop_bound';
type AdminClientChannel = 'browser' | 'native' | 'server';

const VALID_DELEGATION_MODES = new Set(['none', 'delegation', 'impersonation']);
const VALID_APPLICATION_TYPES = new Set<AdminClientApplicationType>([
  'web',
  'native',
  'spa',
  'service',
]);
const VALID_BROWSER_PUBLIC_CLIENT_MODES = new Set<AdminBrowserPublicClientMode>([
  'strict',
  'cookie_fallback',
  'legacy',
]);
const VALID_BROWSER_REFRESH_TOKEN_POLICIES = new Set<AdminBrowserRefreshTokenPolicy>([
  'disabled',
  'dpop_bound',
]);
const VALID_CLIENT_CHANNELS = new Set<AdminClientChannel>(['browser', 'native', 'server']);
const VALID_CLAIM_RELEASE_POLICIES = new Set<ClaimReleasePolicy>([
  'scope_required',
  'claims_allowed',
  'forbidden',
]);
const VALID_ASC_TRANSFORMED_CLAIMS = new Set(DEFAULT_ASC_ALLOWED_TRANSFORMED_CLAIMS);
const UNSUPPORTED_LEGACY_CLIENT_FIELDS = new Set([
  'app_suite',
  'trust_group_id',
  'allow_cross_client_native_sso',
]);

function validateOptionalStringArrayField(
  value: unknown,
  field: string
): { ok: true; value: string[] | null | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  if (isCharArrayLike(value)) {
    return {
      ok: false,
      error: `${field} appears malformed. Send full values, not character arrays.`,
    };
  }
  return { ok: true, value };
}

function findUnsupportedLegacyClientField(body: Record<string, unknown>): string | null {
  for (const field of UNSUPPORTED_LEGACY_CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return field;
    }
  }
  return null;
}

function validateOptionalStringField(
  value: unknown,
  field: string
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function validateOptionalEnumField<T extends string>(
  value: unknown,
  field: string,
  validValues: Set<T>
): { ok: true; value: T | null | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null || value === '') {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string' || !validValues.has(value as T)) {
    return {
      ok: false,
      error: `${field} must be one of ${Array.from(validValues).join(', ')}`,
    };
  }
  return { ok: true, value: value as T };
}

function validateOptionalBooleanField(
  value: unknown,
  field: string
): { ok: true; value: boolean | null | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: `${field} must be a boolean or null` };
  }
  return { ok: true, value };
}

function validateOptionalStrictBooleanField(
  value: unknown,
  field: string
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: `${field} must be a boolean` };
  }
  return { ok: true, value };
}

function validateOptionalChannelArrayField(
  value: unknown,
  field: string
): { ok: true; value: AdminClientChannel[] | null | undefined } | { ok: false; error: string } {
  const validation = validateOptionalStringArrayField(value, field);
  if (!validation.ok) {
    return validation;
  }
  if (validation.value === undefined || validation.value === null) {
    return { ok: true, value: validation.value };
  }
  const invalid = validation.value.find(
    (channel) => !VALID_CLIENT_CHANNELS.has(channel as AdminClientChannel)
  );
  if (invalid) {
    return {
      ok: false,
      error: `${field} must contain only browser, native, server`,
    };
  }
  return {
    ok: true,
    value: validation.value as AdminClientChannel[],
  };
}

function validateOptionalClaimsParameterPolicyField(
  value: unknown,
  field: string
):
  | { ok: true; value: Record<string, ClaimReleasePolicy> | null | undefined }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `${field} must be an object or null` };
  }

  const policy: Record<string, ClaimReleasePolicy> = {};
  for (const [claim, policyValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedClaim = claim.trim();
    if (!normalizedClaim) {
      return { ok: false, error: `${field} claim names must be non-empty strings` };
    }
    if (
      typeof policyValue !== 'string' ||
      !VALID_CLAIM_RELEASE_POLICIES.has(policyValue as ClaimReleasePolicy)
    ) {
      return {
        ok: false,
        error: `${field}.${claim} must be one of scope_required, claims_allowed, forbidden`,
      };
    }
    policy[normalizedClaim] = policyValue as ClaimReleasePolicy;
  }

  return { ok: true, value: policy };
}

function validateOptionalAscAllowedTransformedClaimsField(
  value: unknown,
  field: string
): { ok: true; value: string[] | null | undefined } | { ok: false; error: string } {
  const validation = validateOptionalStringArrayField(value, field);
  if (!validation.ok) {
    return validation;
  }
  if (validation.value === undefined || validation.value === null) {
    return { ok: true, value: validation.value };
  }

  const invalid = validation.value.find((claim) => !VALID_ASC_TRANSFORMED_CLAIMS.has(claim));
  if (invalid) {
    return {
      ok: false,
      error: `${field} contains unsupported transformed claim: ${invalid}`,
    };
  }

  return { ok: true, value: validation.value };
}

function parseClaimsParameterPolicyField(
  value: unknown
): Record<string, ClaimReleasePolicy> | null {
  let current = value;
  if (typeof current === 'string') {
    const trimmed = current.trim();
    if (!trimmed) {
      return null;
    }
    try {
      current = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    return null;
  }

  const policy: Record<string, ClaimReleasePolicy> = {};
  for (const [claim, policyValue] of Object.entries(current as Record<string, unknown>)) {
    if (
      typeof policyValue === 'string' &&
      VALID_CLAIM_RELEASE_POLICIES.has(policyValue as ClaimReleasePolicy)
    ) {
      policy[claim] = policyValue as ClaimReleasePolicy;
    }
  }
  return Object.keys(policy).length > 0 ? policy : null;
}

function validateWebOriginRegistryField(
  value: unknown
): { ok: true; value: WebOriginRegistryWritePayload | undefined } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null) {
    return { ok: true, value: { origins: [] } };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'web_origin_registry must be an object or null' };
  }

  const payload = value as { origins?: unknown };
  if (!Array.isArray(payload.origins)) {
    return { ok: false, error: 'web_origin_registry.origins must be an array' };
  }

  for (const originEntry of payload.origins) {
    if (typeof originEntry === 'string') {
      continue;
    }
    if (typeof originEntry !== 'object' || originEntry === null || Array.isArray(originEntry)) {
      return {
        ok: false,
        error: 'web_origin_registry.origins entries must be origin strings or objects',
      };
    }

    const entry = originEntry as {
      origin?: unknown;
      cors?: { allowed?: unknown };
      csp?: { frame_ancestors?: unknown };
      handoff_allowed?: unknown;
      iframe_allowed?: unknown;
      environment?: unknown;
    };
    if (typeof entry.origin !== 'string') {
      return { ok: false, error: 'web_origin_registry origin object requires origin string' };
    }
    if (entry.cors?.allowed !== undefined && typeof entry.cors.allowed !== 'boolean') {
      return { ok: false, error: 'web_origin_registry.cors.allowed must be boolean' };
    }
    if (
      entry.csp?.frame_ancestors !== undefined &&
      (!Array.isArray(entry.csp.frame_ancestors) ||
        entry.csp.frame_ancestors.some((ancestor) => typeof ancestor !== 'string'))
    ) {
      return { ok: false, error: 'web_origin_registry.csp.frame_ancestors must be string[]' };
    }
    if (entry.handoff_allowed !== undefined && typeof entry.handoff_allowed !== 'boolean') {
      return { ok: false, error: 'web_origin_registry.handoff_allowed must be boolean' };
    }
    if (entry.iframe_allowed !== undefined && typeof entry.iframe_allowed !== 'boolean') {
      return { ok: false, error: 'web_origin_registry.iframe_allowed must be boolean' };
    }
    if (
      entry.environment !== undefined &&
      entry.environment !== null &&
      typeof entry.environment !== 'string'
    ) {
      return { ok: false, error: 'web_origin_registry.environment must be string or null' };
    }
  }

  return { ok: true, value: payload as WebOriginRegistryWritePayload };
}

function webOriginRegistryFromAllowedOrigins(
  origins: string[] | undefined
): WebOriginRegistryWritePayload | undefined {
  return origins === undefined ? undefined : { origins };
}

/**
 * Create a new OAuth client.
 * POST /admin/clients
 */
export async function adminClientCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      client_name: string;
      description?: string | null;
      redirect_uris: string[];
      grant_types?: string[];
      response_types?: string[];
      scope?: string;
      logo_uri?: string;
      client_uri?: string;
      policy_uri?: string;
      tos_uri?: string;
      contacts?: string[];
      token_endpoint_auth_method?: string;
      subject_type?: string;
      sector_identifier_uri?: string;
      is_trusted?: boolean;
      skip_consent?: boolean;
      allow_claims_without_scope?: boolean;
      claims_parameter_policy?: Record<string, ClaimReleasePolicy> | null;
      asc_enabled?: boolean;
      asc_protected_request_required?: boolean;
      asc_sao_enabled?: boolean;
      asc_transformed_claims_enabled?: boolean;
      asc_allowed_transformed_claims?: string[] | null;
      // allowed_redirect_origins is retained for custom redirect URI compatibility.
      // web_origin_registry is the source of truth for browser handoff/CORS/iframe metadata.
      allowed_redirect_origins?: string[];
      web_origin_registry?: WebOriginRegistryWritePayload | null;
      require_pkce?: boolean;
      application_type?: string;
      // Admin/API "application_group" maps to the internal trust_group security boundary.
      trust_group?: string | null;
      browser_public_client_mode?: string | null;
      browser_refresh_token_policy?: string | null;
      native_sso_enabled?: boolean | null;
      native_channel_allowed?: boolean | null;
      allowed_channels?: string[] | null;
      device_secret_revoke_enabled?: boolean | null;
      device_secret_revoke_trust_groups?: string[] | null;
      device_secret_introspection_enabled?: boolean | null;
      device_secret_introspection_trust_groups?: string[] | null;
      token_exchange_allowed?: boolean;
      allowed_subject_token_clients?: string[] | null;
      allowed_token_exchange_resources?: string[] | null;
      delegation_mode?: 'none' | 'delegation' | 'impersonation';
      client_credentials_allowed?: boolean;
      allowed_scopes?: string[] | null;
      default_scope?: string | null;
      default_audience?: string | null;
      default_resource?: string | null;
    }>();

    const unsupportedLegacyField = findUnsupportedLegacyClientField(
      body as Record<string, unknown>
    );
    if (unsupportedLegacyField) {
      if (unsupportedLegacyField === 'app_suite') {
        return createCompatibilityErrorResponse('legacy_app_suite_not_supported', 400);
      }

      return c.json(
        {
          error: 'invalid_request',
          error_description: `${unsupportedLegacyField} is not supported in Phase 1 runtime client configuration. Use trust_group for cross-client Native SSO.`,
        },
        400
      );
    }

    if (!body.client_name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_name is required',
        },
        400
      );
    }

    const descriptionValidation = validateOptionalStringField(body.description, 'description');
    if (!descriptionValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: descriptionValidation.error,
        },
        400
      );
    }

    if (
      !body.redirect_uris ||
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length === 0
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'redirect_uris is required and must be a non-empty array',
        },
        400
      );
    }

    for (const uri of body.redirect_uris) {
      try {
        new URL(uri);
      } catch {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid redirect_uri: ${uri}`,
          },
          400
        );
      }
    }

    let validatedAllowedOrigins: string[] | undefined;
    if (body.allowed_redirect_origins !== undefined) {
      if (!Array.isArray(body.allowed_redirect_origins)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'allowed_redirect_origins must be an array of origin strings',
          },
          400
        );
      }
      const originsValidation = validateAllowedOrigins(body.allowed_redirect_origins);
      if (!originsValidation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
          },
          400
        );
      }
      validatedAllowedOrigins = originsValidation.normalizedOrigins;
    }

    const webOriginRegistryValidation = validateWebOriginRegistryField(body.web_origin_registry);
    if (!webOriginRegistryValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: webOriginRegistryValidation.error,
        },
        400
      );
    }
    const webOriginRegistryPayload =
      webOriginRegistryValidation.value ??
      webOriginRegistryFromAllowedOrigins(validatedAllowedOrigins);
    if (webOriginRegistryPayload) {
      const payloadValidation = validateWebOriginRegistryPayload(webOriginRegistryPayload);
      if (!payloadValidation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: payloadValidation.error,
          },
          400
        );
      }
    }

    const allowedSubjectTokenClientsValidation = validateOptionalStringArrayField(
      body.allowed_subject_token_clients,
      'allowed_subject_token_clients'
    );
    if (!allowedSubjectTokenClientsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedSubjectTokenClientsValidation.error,
        },
        400
      );
    }

    const allowedTokenExchangeResourcesValidation = validateOptionalStringArrayField(
      body.allowed_token_exchange_resources,
      'allowed_token_exchange_resources'
    );
    if (!allowedTokenExchangeResourcesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedTokenExchangeResourcesValidation.error,
        },
        400
      );
    }

    const allowedScopesValidation = validateOptionalStringArrayField(
      body.allowed_scopes,
      'allowed_scopes'
    );
    if (!allowedScopesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedScopesValidation.error,
        },
        400
      );
    }

    const claimsParameterPolicyValidation = validateOptionalClaimsParameterPolicyField(
      body.claims_parameter_policy,
      'claims_parameter_policy'
    );
    if (!claimsParameterPolicyValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: claimsParameterPolicyValidation.error,
        },
        400
      );
    }

    const ascEnabledValidation = validateOptionalStrictBooleanField(
      body.asc_enabled,
      'asc_enabled'
    );
    if (!ascEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascEnabledValidation.error,
        },
        400
      );
    }

    const ascProtectedRequestRequiredValidation = validateOptionalStrictBooleanField(
      body.asc_protected_request_required,
      'asc_protected_request_required'
    );
    if (!ascProtectedRequestRequiredValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascProtectedRequestRequiredValidation.error,
        },
        400
      );
    }

    const ascSaoEnabledValidation = validateOptionalStrictBooleanField(
      body.asc_sao_enabled,
      'asc_sao_enabled'
    );
    if (!ascSaoEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascSaoEnabledValidation.error,
        },
        400
      );
    }

    const ascTransformedClaimsEnabledValidation = validateOptionalStrictBooleanField(
      body.asc_transformed_claims_enabled,
      'asc_transformed_claims_enabled'
    );
    if (!ascTransformedClaimsEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascTransformedClaimsEnabledValidation.error,
        },
        400
      );
    }

    const ascAllowedTransformedClaimsValidation = validateOptionalAscAllowedTransformedClaimsField(
      body.asc_allowed_transformed_claims,
      'asc_allowed_transformed_claims'
    );
    if (!ascAllowedTransformedClaimsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascAllowedTransformedClaimsValidation.error,
        },
        400
      );
    }

    const applicationTypeValidation = validateOptionalEnumField(
      body.application_type,
      'application_type',
      VALID_APPLICATION_TYPES
    );
    if (!applicationTypeValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: applicationTypeValidation.error,
        },
        400
      );
    }

    // This is the Admin API translation boundary from public application_group semantics
    // to the current internal trust_group storage fields.
    const trustGroupValidation = validateOptionalStringField(body.trust_group, 'trust_group');
    if (!trustGroupValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: trustGroupValidation.error,
        },
        400
      );
    }

    const browserPublicClientModeValidation = validateOptionalEnumField(
      body.browser_public_client_mode,
      'browser_public_client_mode',
      VALID_BROWSER_PUBLIC_CLIENT_MODES
    );
    if (!browserPublicClientModeValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: browserPublicClientModeValidation.error,
        },
        400
      );
    }

    const browserRefreshTokenPolicyValidation = validateOptionalEnumField(
      body.browser_refresh_token_policy,
      'browser_refresh_token_policy',
      VALID_BROWSER_REFRESH_TOKEN_POLICIES
    );
    if (!browserRefreshTokenPolicyValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: browserRefreshTokenPolicyValidation.error,
        },
        400
      );
    }

    const nativeSsoEnabledValidation = validateOptionalBooleanField(
      body.native_sso_enabled,
      'native_sso_enabled'
    );
    if (!nativeSsoEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: nativeSsoEnabledValidation.error,
        },
        400
      );
    }

    const nativeChannelAllowedValidation = validateOptionalBooleanField(
      body.native_channel_allowed,
      'native_channel_allowed'
    );
    if (!nativeChannelAllowedValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: nativeChannelAllowedValidation.error,
        },
        400
      );
    }

    const allowedChannelsValidation = validateOptionalChannelArrayField(
      body.allowed_channels,
      'allowed_channels'
    );
    if (!allowedChannelsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedChannelsValidation.error,
        },
        400
      );
    }

    const deviceSecretRevokeEnabledValidation = validateOptionalBooleanField(
      body.device_secret_revoke_enabled,
      'device_secret_revoke_enabled'
    );
    if (!deviceSecretRevokeEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretRevokeEnabledValidation.error,
        },
        400
      );
    }

    const deviceSecretRevokeTrustGroupsValidation = validateOptionalStringArrayField(
      body.device_secret_revoke_trust_groups,
      'device_secret_revoke_trust_groups'
    );
    if (!deviceSecretRevokeTrustGroupsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretRevokeTrustGroupsValidation.error,
        },
        400
      );
    }

    const deviceSecretIntrospectionEnabledValidation = validateOptionalBooleanField(
      body.device_secret_introspection_enabled,
      'device_secret_introspection_enabled'
    );
    if (!deviceSecretIntrospectionEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretIntrospectionEnabledValidation.error,
        },
        400
      );
    }

    const deviceSecretIntrospectionTrustGroupsValidation = validateOptionalStringArrayField(
      body.device_secret_introspection_trust_groups,
      'device_secret_introspection_trust_groups'
    );
    if (!deviceSecretIntrospectionTrustGroupsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretIntrospectionTrustGroupsValidation.error,
        },
        400
      );
    }

    const defaultResourceValidation = validateOptionalStringField(
      body.default_resource,
      'default_resource'
    );
    if (!defaultResourceValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: defaultResourceValidation.error,
        },
        400
      );
    }

    if (body.delegation_mode !== undefined && !VALID_DELEGATION_MODES.has(body.delegation_mode)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'delegation_mode must be one of none, delegation, impersonation',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const clientSecret =
      crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const clientSecretHash = await hashClientSecret(clientSecret);

    const client = await authCtx.repositories.client.create({
      client_name: body.client_name,
      description: descriptionValidation.value,
      client_secret_hash: clientSecretHash,
      tenant_id: tenantId,
      application_type: applicationTypeValidation.value ?? 'web',
      trust_group: trustGroupValidation.value,
      browser_public_client_mode: browserPublicClientModeValidation.value,
      browser_refresh_token_policy: browserRefreshTokenPolicyValidation.value ?? 'disabled',
      native_sso_enabled: nativeSsoEnabledValidation.value,
      native_channel_allowed: nativeChannelAllowedValidation.value,
      allowed_channels: allowedChannelsValidation.value,
      device_secret_revoke_enabled: deviceSecretRevokeEnabledValidation.value,
      device_secret_revoke_trust_groups: deviceSecretRevokeTrustGroupsValidation.value,
      device_secret_introspection_enabled: deviceSecretIntrospectionEnabledValidation.value,
      device_secret_introspection_trust_groups:
        deviceSecretIntrospectionTrustGroupsValidation.value,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      scope: body.scope || 'openid profile email',
      logo_uri: body.logo_uri || null,
      client_uri: body.client_uri || null,
      policy_uri: body.policy_uri || null,
      tos_uri: body.tos_uri || null,
      contacts: body.contacts || null,
      token_endpoint_auth_method:
        (body.token_endpoint_auth_method as
          | 'none'
          | 'client_secret_basic'
          | 'client_secret_post'
          | 'client_secret_jwt'
          | 'private_key_jwt') || 'client_secret_basic',
      subject_type: (body.subject_type as 'public' | 'pairwise') || 'public',
      sector_identifier_uri: body.sector_identifier_uri || null,
      is_trusted: body.is_trusted || false,
      skip_consent: body.skip_consent || false,
      allow_claims_without_scope: body.allow_claims_without_scope || false,
      claims_parameter_policy: claimsParameterPolicyValidation.value,
      asc_enabled: ascEnabledValidation.value ?? true,
      asc_protected_request_required: ascProtectedRequestRequiredValidation.value ?? true,
      asc_sao_enabled: ascSaoEnabledValidation.value ?? true,
      asc_transformed_claims_enabled: ascTransformedClaimsEnabledValidation.value ?? true,
      asc_allowed_transformed_claims: ascAllowedTransformedClaimsValidation.value,
      token_exchange_allowed: body.token_exchange_allowed ?? false,
      allowed_subject_token_clients: allowedSubjectTokenClientsValidation.value,
      allowed_token_exchange_resources: allowedTokenExchangeResourcesValidation.value,
      delegation_mode: body.delegation_mode ?? 'delegation',
      client_credentials_allowed: body.client_credentials_allowed ?? false,
      allowed_scopes: allowedScopesValidation.value,
      default_scope: body.default_scope ?? null,
      default_audience: body.default_audience ?? null,
      default_resource: defaultResourceValidation.value,
      allowed_redirect_origins: validatedAllowedOrigins,
      require_pkce: body.require_pkce || false,
    });

    let webOriginRegistry: WebOriginRegistryDocument = { origins: [] };
    if (webOriginRegistryPayload) {
      try {
        webOriginRegistry = await replaceWebOriginRegistry(
          authCtx.coreAdapter,
          tenantId,
          client.client_id,
          webOriginRegistryPayload
        );
        await invalidateWebOriginRegistryCache(c.env, tenantId, client.client_id);
      } catch (error) {
        return c.json(
          {
            error: 'invalid_request',
            error_description:
              error instanceof Error ? error.message : 'Invalid web_origin_registry',
          },
          400
        );
      }
    }

    await putClient(c.env, {
      client_id: client.client_id,
      client_secret_hash: client.client_secret_hash ?? undefined,
      client_name: client.client_name,
      description: client.description ?? undefined,
      application_type: client.application_type ?? undefined,
      trust_group: client.trust_group ?? undefined,
      trust_group_id: client.trust_group_id ?? undefined,
      browser_public_client_mode: client.browser_public_client_mode ?? undefined,
      browser_refresh_token_policy: client.browser_refresh_token_policy,
      native_sso_enabled: client.native_sso_enabled ?? undefined,
      native_channel_allowed: client.native_channel_allowed ?? undefined,
      allowed_channels: client.allowed_channels
        ? (parseClientStringArray(client.allowed_channels, []) as Array<
            'browser' | 'native' | 'server'
          >)
        : undefined,
      device_secret_revoke_enabled: client.device_secret_revoke_enabled ?? undefined,
      device_secret_revoke_trust_groups: client.device_secret_revoke_trust_groups
        ? parseClientStringArray(client.device_secret_revoke_trust_groups, [])
        : undefined,
      device_secret_introspection_enabled: client.device_secret_introspection_enabled ?? undefined,
      device_secret_introspection_trust_groups: client.device_secret_introspection_trust_groups
        ? parseClientStringArray(client.device_secret_introspection_trust_groups, [])
        : undefined,
      redirect_uris: parseClientStringArray(client.redirect_uris, []),
      grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
      response_types: parseClientStringArray(client.response_types, ['code']),
      scope: client.scope ?? undefined,
      logo_uri: client.logo_uri ?? undefined,
      client_uri: client.client_uri ?? undefined,
      policy_uri: client.policy_uri ?? undefined,
      tos_uri: client.tos_uri ?? undefined,
      contacts: client.contacts ? parseClientStringArray(client.contacts, []) : undefined,
      post_logout_redirect_uris: client.post_logout_redirect_uris
        ? parseClientStringArray(client.post_logout_redirect_uris, [])
        : undefined,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      subject_type: client.subject_type ?? undefined,
      sector_identifier_uri: client.sector_identifier_uri ?? undefined,
      jwks: client.jwks ? JSON.parse(client.jwks) : undefined,
      jwks_uri: client.jwks_uri ?? undefined,
      is_trusted: client.is_trusted,
      skip_consent: client.skip_consent,
      allow_claims_without_scope: client.allow_claims_without_scope,
      claims_parameter_policy:
        parseClaimsParameterPolicyField(client.claims_parameter_policy) ?? undefined,
      asc_enabled: client.asc_enabled,
      asc_protected_request_required: client.asc_protected_request_required,
      asc_sao_enabled: client.asc_sao_enabled,
      asc_transformed_claims_enabled: client.asc_transformed_claims_enabled,
      asc_allowed_transformed_claims: client.asc_allowed_transformed_claims
        ? parseClientStringArray(client.asc_allowed_transformed_claims, [])
        : undefined,
      token_exchange_allowed: client.token_exchange_allowed,
      allowed_subject_token_clients: client.allowed_subject_token_clients
        ? parseClientStringArray(client.allowed_subject_token_clients, [])
        : undefined,
      allowed_token_exchange_resources: client.allowed_token_exchange_resources
        ? parseClientStringArray(client.allowed_token_exchange_resources, [])
        : undefined,
      delegation_mode: client.delegation_mode,
      client_credentials_allowed: client.client_credentials_allowed,
      allowed_scopes: client.allowed_scopes
        ? parseClientStringArray(client.allowed_scopes, [])
        : undefined,
      default_scope: client.default_scope ?? undefined,
      default_audience: client.default_audience ?? undefined,
      default_resource: client.default_resource ?? undefined,
      backchannel_token_delivery_mode: client.backchannel_token_delivery_mode ?? undefined,
      backchannel_client_notification_endpoint:
        client.backchannel_client_notification_endpoint ?? undefined,
      backchannel_authentication_request_signing_alg:
        client.backchannel_authentication_request_signing_alg ?? undefined,
      backchannel_user_code_parameter: client.backchannel_user_code_parameter,
      userinfo_signed_response_alg: client.userinfo_signed_response_alg ?? undefined,
      backchannel_logout_uri: client.backchannel_logout_uri ?? undefined,
      backchannel_logout_session_required: client.backchannel_logout_session_required,
      frontchannel_logout_uri: client.frontchannel_logout_uri ?? undefined,
      frontchannel_logout_session_required: client.frontchannel_logout_session_required,
      allowed_redirect_origins: client.allowed_redirect_origins
        ? parseClientStringArray(client.allowed_redirect_origins, [])
        : undefined,
      software_id: client.software_id ?? undefined,
      software_version: client.software_version ?? undefined,
      requestable_scopes: client.requestable_scopes
        ? parseClientStringArray(client.requestable_scopes, [])
        : undefined,
      require_pkce: client.require_pkce,
      tenant_id: client.tenant_id,
      created_at: client.created_at,
      updated_at: client.updated_at,
    });

    const log = getLogger(c).module('ADMIN-CLIENT');
    publishEvent(c, {
      type: CLIENT_EVENTS.CREATED,
      tenantId,
      data: {
        clientId: client.client_id,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      log.error(
        'Failed to publish client.created event',
        { action: 'publish_event' },
        err as Error
      );
    });

    scheduleAuditLogFromContext(c, 'client.created', 'client', client.client_id, {
      client_name: client.client_name,
      grant_types: client.grant_types,
    });
    scheduleAdminAuditLog(c, 'client.created', client.client_id, 'success', {
      client_name: client.client_name,
    });

    return c.json(
      {
        client: {
          client_id: client.client_id,
          client_secret: clientSecret,
          client_name: client.client_name,
          description: client.description,
          application_type: client.application_type,
          trust_group: client.trust_group,
          browser_public_client_mode: client.browser_public_client_mode,
          browser_refresh_token_policy: client.browser_refresh_token_policy,
          native_sso_enabled: client.native_sso_enabled,
          native_channel_allowed: client.native_channel_allowed,
          allowed_channels: client.allowed_channels
            ? parseClientStringArray(client.allowed_channels, [])
            : [],
          device_secret_revoke_enabled: client.device_secret_revoke_enabled,
          device_secret_revoke_trust_groups: client.device_secret_revoke_trust_groups
            ? parseClientStringArray(client.device_secret_revoke_trust_groups, [])
            : [],
          device_secret_introspection_enabled: client.device_secret_introspection_enabled,
          device_secret_introspection_trust_groups: client.device_secret_introspection_trust_groups
            ? parseClientStringArray(client.device_secret_introspection_trust_groups, [])
            : [],
          redirect_uris: parseClientStringArray(client.redirect_uris, []),
          grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
          response_types: parseClientStringArray(client.response_types, ['code']),
          scope: client.scope,
          logo_uri: client.logo_uri,
          client_uri: client.client_uri,
          policy_uri: client.policy_uri,
          tos_uri: client.tos_uri,
          contacts: client.contacts ? parseClientStringArray(client.contacts, []) : [],
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          subject_type: client.subject_type,
          sector_identifier_uri: client.sector_identifier_uri,
          is_trusted: client.is_trusted,
          skip_consent: client.skip_consent,
          allow_claims_without_scope: client.allow_claims_without_scope,
          claims_parameter_policy: parseClaimsParameterPolicyField(client.claims_parameter_policy),
          asc_enabled: client.asc_enabled,
          asc_protected_request_required: client.asc_protected_request_required,
          asc_sao_enabled: client.asc_sao_enabled,
          asc_transformed_claims_enabled: client.asc_transformed_claims_enabled,
          asc_allowed_transformed_claims: client.asc_allowed_transformed_claims
            ? parseClientStringArray(client.asc_allowed_transformed_claims, [])
            : null,
          token_exchange_allowed: client.token_exchange_allowed,
          allowed_subject_token_clients: client.allowed_subject_token_clients
            ? parseClientStringArray(client.allowed_subject_token_clients, [])
            : [],
          allowed_token_exchange_resources: client.allowed_token_exchange_resources
            ? parseClientStringArray(client.allowed_token_exchange_resources, [])
            : [],
          delegation_mode: client.delegation_mode,
          client_credentials_allowed: client.client_credentials_allowed,
          allowed_scopes: client.allowed_scopes
            ? parseClientStringArray(client.allowed_scopes, [])
            : [],
          default_scope: client.default_scope,
          default_audience: client.default_audience,
          default_resource: client.default_resource,
          web_origin_registry: webOriginRegistry,
          require_pkce: client.require_pkce,
          created_at: client.created_at,
          updated_at: client.updated_at,
        },
      },
      201
    );
  } catch (error) {
    logSanitizedError('Admin client create error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create client',
        ...getErrorDetailsForResponse(error, c.env),
      },
      500
    );
  }
}

export async function adminClientsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';
    const authCtx = createAuthContextFromHono(c, tenantId);
    const result = await authCtx.repositories.client.listByTenant(tenantId, {
      page,
      limit,
      search: search || undefined,
    });

    const formattedClients = result.items.map((client) => {
      const { client_secret_hash: _excluded, ...clientWithoutHash } = client;
      return {
        ...clientWithoutHash,
        redirect_uris: parseClientStringArray(client.redirect_uris, []),
        grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
        response_types: parseClientStringArray(client.response_types, ['code']),
        contacts: client.contacts ? parseClientStringArray(client.contacts, []) : [],
        allowed_subject_token_clients: client.allowed_subject_token_clients
          ? parseClientStringArray(client.allowed_subject_token_clients, [])
          : [],
        allowed_token_exchange_resources: client.allowed_token_exchange_resources
          ? parseClientStringArray(client.allowed_token_exchange_resources, [])
          : [],
        allowed_scopes: client.allowed_scopes
          ? parseClientStringArray(client.allowed_scopes, [])
          : [],
        allowed_channels: client.allowed_channels
          ? parseClientStringArray(client.allowed_channels, [])
          : [],
        claims_parameter_policy: parseClaimsParameterPolicyField(client.claims_parameter_policy),
        asc_allowed_transformed_claims: client.asc_allowed_transformed_claims
          ? parseClientStringArray(client.asc_allowed_transformed_claims, [])
          : null,
        created_at: toMilliseconds(client.created_at),
        updated_at: toMilliseconds(client.updated_at),
      };
    });

    return c.json({
      clients: formattedClients,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev,
      },
    });
  } catch (error) {
    console.error('Admin clients list error:', error);
    logSanitizedError('Admin clients list error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve clients',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

export async function adminClientGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const client = await authCtx.repositories.client.findByClientId(clientId);

    if (!client) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const { client_secret_hash: _excluded, ...clientWithoutHash } = client;
    const webOriginRegistry = await getWebOriginRegistry(
      c.env,
      tenantId,
      clientId,
      authCtx.coreAdapter
    );
    const formattedClient = {
      ...clientWithoutHash,
      redirect_uris: parseClientStringArray(client.redirect_uris, []),
      grant_types: parseClientStringArray(client.grant_types, ['authorization_code']),
      response_types: parseClientStringArray(client.response_types, ['code']),
      contacts: client.contacts ? parseClientStringArray(client.contacts, []) : [],
      allowed_subject_token_clients: client.allowed_subject_token_clients
        ? parseClientStringArray(client.allowed_subject_token_clients, [])
        : [],
      allowed_token_exchange_resources: client.allowed_token_exchange_resources
        ? parseClientStringArray(client.allowed_token_exchange_resources, [])
        : [],
      allowed_scopes: client.allowed_scopes
        ? parseClientStringArray(client.allowed_scopes, [])
        : [],
      allowed_channels: client.allowed_channels
        ? parseClientStringArray(client.allowed_channels, [])
        : [],
      claims_parameter_policy: parseClaimsParameterPolicyField(client.claims_parameter_policy),
      asc_allowed_transformed_claims: client.asc_allowed_transformed_claims
        ? parseClientStringArray(client.asc_allowed_transformed_claims, [])
        : null,
      web_origin_registry: webOriginRegistry,
      created_at: toMilliseconds(client.created_at as number),
      updated_at: toMilliseconds(client.updated_at as number),
    };

    return c.json({
      client: formattedClient,
    });
  } catch (error) {
    logSanitizedError('Admin client get error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve client',
      },
      500
    );
  }
}

export async function adminClientUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existingClient = await authCtx.repositories.client.findByClientId(clientId);

    if (!existingClient) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const body = await c.req.json();
    const unsupportedLegacyField = findUnsupportedLegacyClientField(
      body as Record<string, unknown>
    );
    if (unsupportedLegacyField) {
      if (unsupportedLegacyField === 'app_suite') {
        return createCompatibilityErrorResponse('legacy_app_suite_not_supported', 400);
      }

      return c.json(
        {
          error: 'invalid_request',
          error_description: `${unsupportedLegacyField} is not supported in Phase 1 runtime client configuration. Use trust_group for cross-client Native SSO.`,
        },
        400
      );
    }

    const {
      client_name,
      description,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope,
      logo_uri,
      client_uri,
      policy_uri,
      tos_uri,
      is_trusted,
      skip_consent,
      allow_claims_without_scope,
      claims_parameter_policy,
      asc_enabled,
      asc_protected_request_required,
      asc_sao_enabled,
      asc_transformed_claims_enabled,
      asc_allowed_transformed_claims,
      allowed_redirect_origins,
      web_origin_registry,
      require_pkce,
      initiate_login_uri,
      login_ui_url,
      application_type,
      trust_group,
      browser_public_client_mode,
      browser_refresh_token_policy,
      native_sso_enabled,
      native_channel_allowed,
      allowed_channels,
      device_secret_revoke_enabled,
      device_secret_revoke_trust_groups,
      device_secret_introspection_enabled,
      device_secret_introspection_trust_groups,
      token_exchange_allowed,
      allowed_subject_token_clients,
      allowed_token_exchange_resources,
      delegation_mode,
      client_credentials_allowed,
      allowed_scopes,
      default_scope,
      default_audience,
      default_resource,
    } = body;

    const descriptionValidation = validateOptionalStringField(description, 'description');
    if (!descriptionValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: descriptionValidation.error,
        },
        400
      );
    }

    let validatedAllowedOrigins: string[] | undefined;
    if (allowed_redirect_origins !== undefined) {
      if (allowed_redirect_origins === null) {
        validatedAllowedOrigins = [];
      } else if (!Array.isArray(allowed_redirect_origins)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'allowed_redirect_origins must be an array of origin strings',
          },
          400
        );
      } else {
        const originsValidation = validateAllowedOrigins(allowed_redirect_origins);
        if (!originsValidation.valid) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: `Invalid allowed_redirect_origins: ${originsValidation.errors.join(', ')}`,
            },
            400
          );
        }
        validatedAllowedOrigins = originsValidation.normalizedOrigins;
      }
    }

    const webOriginRegistryValidation = validateWebOriginRegistryField(web_origin_registry);
    if (!webOriginRegistryValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: webOriginRegistryValidation.error,
        },
        400
      );
    }
    const webOriginRegistryPayload =
      webOriginRegistryValidation.value ??
      webOriginRegistryFromAllowedOrigins(validatedAllowedOrigins);
    if (webOriginRegistryPayload) {
      const payloadValidation = validateWebOriginRegistryPayload(webOriginRegistryPayload);
      if (!payloadValidation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: payloadValidation.error,
          },
          400
        );
      }
    }

    if (redirect_uris !== undefined) {
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'redirect_uris must be a non-empty array',
          },
          400
        );
      }

      const hasInvalidUri = redirect_uris.some((uri) => {
        if (typeof uri !== 'string') return true;
        try {
          new URL(uri);
          return false;
        } catch {
          return true;
        }
      });

      if (hasInvalidUri) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'redirect_uris must contain valid URI strings',
          },
          400
        );
      }
    }

    if (grant_types !== undefined) {
      if (!Array.isArray(grant_types) || grant_types.some((v) => typeof v !== 'string')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'grant_types must be an array of strings',
          },
          400
        );
      }

      if (isCharArrayLike(grant_types)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description:
              'grant_types appears malformed. Send grant type values like authorization_code, not character arrays.',
          },
          400
        );
      }
    }

    if (response_types !== undefined) {
      if (!Array.isArray(response_types) || response_types.some((v) => typeof v !== 'string')) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'response_types must be an array of strings',
          },
          400
        );
      }

      if (isCharArrayLike(response_types)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description:
              'response_types appears malformed. Send response type values like code, not character arrays.',
          },
          400
        );
      }
    }

    const allowedSubjectTokenClientsValidation = validateOptionalStringArrayField(
      allowed_subject_token_clients,
      'allowed_subject_token_clients'
    );
    if (!allowedSubjectTokenClientsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedSubjectTokenClientsValidation.error,
        },
        400
      );
    }

    const allowedTokenExchangeResourcesValidation = validateOptionalStringArrayField(
      allowed_token_exchange_resources,
      'allowed_token_exchange_resources'
    );
    if (!allowedTokenExchangeResourcesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedTokenExchangeResourcesValidation.error,
        },
        400
      );
    }

    const allowedScopesValidation = validateOptionalStringArrayField(
      allowed_scopes,
      'allowed_scopes'
    );
    if (!allowedScopesValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedScopesValidation.error,
        },
        400
      );
    }

    const claimsParameterPolicyValidation = validateOptionalClaimsParameterPolicyField(
      claims_parameter_policy,
      'claims_parameter_policy'
    );
    if (!claimsParameterPolicyValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: claimsParameterPolicyValidation.error,
        },
        400
      );
    }

    const ascEnabledValidation = validateOptionalStrictBooleanField(asc_enabled, 'asc_enabled');
    if (!ascEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascEnabledValidation.error,
        },
        400
      );
    }

    const ascProtectedRequestRequiredValidation = validateOptionalStrictBooleanField(
      asc_protected_request_required,
      'asc_protected_request_required'
    );
    if (!ascProtectedRequestRequiredValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascProtectedRequestRequiredValidation.error,
        },
        400
      );
    }

    const ascSaoEnabledValidation = validateOptionalStrictBooleanField(
      asc_sao_enabled,
      'asc_sao_enabled'
    );
    if (!ascSaoEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascSaoEnabledValidation.error,
        },
        400
      );
    }

    const ascTransformedClaimsEnabledValidation = validateOptionalStrictBooleanField(
      asc_transformed_claims_enabled,
      'asc_transformed_claims_enabled'
    );
    if (!ascTransformedClaimsEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascTransformedClaimsEnabledValidation.error,
        },
        400
      );
    }

    const ascAllowedTransformedClaimsValidation = validateOptionalAscAllowedTransformedClaimsField(
      asc_allowed_transformed_claims,
      'asc_allowed_transformed_claims'
    );
    if (!ascAllowedTransformedClaimsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: ascAllowedTransformedClaimsValidation.error,
        },
        400
      );
    }

    const applicationTypeValidation = validateOptionalEnumField(
      application_type,
      'application_type',
      VALID_APPLICATION_TYPES
    );
    if (!applicationTypeValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: applicationTypeValidation.error,
        },
        400
      );
    }

    const trustGroupValidation = validateOptionalStringField(trust_group, 'trust_group');
    if (!trustGroupValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: trustGroupValidation.error,
        },
        400
      );
    }

    const browserPublicClientModeValidation = validateOptionalEnumField(
      browser_public_client_mode,
      'browser_public_client_mode',
      VALID_BROWSER_PUBLIC_CLIENT_MODES
    );
    if (!browserPublicClientModeValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: browserPublicClientModeValidation.error,
        },
        400
      );
    }

    const browserRefreshTokenPolicyValidation = validateOptionalEnumField(
      browser_refresh_token_policy,
      'browser_refresh_token_policy',
      VALID_BROWSER_REFRESH_TOKEN_POLICIES
    );
    if (!browserRefreshTokenPolicyValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: browserRefreshTokenPolicyValidation.error,
        },
        400
      );
    }

    const nativeSsoEnabledValidation = validateOptionalBooleanField(
      native_sso_enabled,
      'native_sso_enabled'
    );
    if (!nativeSsoEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: nativeSsoEnabledValidation.error,
        },
        400
      );
    }

    const nativeChannelAllowedValidation = validateOptionalBooleanField(
      native_channel_allowed,
      'native_channel_allowed'
    );
    if (!nativeChannelAllowedValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: nativeChannelAllowedValidation.error,
        },
        400
      );
    }

    const allowedChannelsValidation = validateOptionalChannelArrayField(
      allowed_channels,
      'allowed_channels'
    );
    if (!allowedChannelsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: allowedChannelsValidation.error,
        },
        400
      );
    }

    const deviceSecretRevokeEnabledValidation = validateOptionalBooleanField(
      device_secret_revoke_enabled,
      'device_secret_revoke_enabled'
    );
    if (!deviceSecretRevokeEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretRevokeEnabledValidation.error,
        },
        400
      );
    }

    const deviceSecretRevokeTrustGroupsValidation = validateOptionalStringArrayField(
      device_secret_revoke_trust_groups,
      'device_secret_revoke_trust_groups'
    );
    if (!deviceSecretRevokeTrustGroupsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretRevokeTrustGroupsValidation.error,
        },
        400
      );
    }

    const deviceSecretIntrospectionEnabledValidation = validateOptionalBooleanField(
      device_secret_introspection_enabled,
      'device_secret_introspection_enabled'
    );
    if (!deviceSecretIntrospectionEnabledValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretIntrospectionEnabledValidation.error,
        },
        400
      );
    }

    const deviceSecretIntrospectionTrustGroupsValidation = validateOptionalStringArrayField(
      device_secret_introspection_trust_groups,
      'device_secret_introspection_trust_groups'
    );
    if (!deviceSecretIntrospectionTrustGroupsValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: deviceSecretIntrospectionTrustGroupsValidation.error,
        },
        400
      );
    }

    const defaultResourceValidation = validateOptionalStringField(
      default_resource,
      'default_resource'
    );
    if (!defaultResourceValidation.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: defaultResourceValidation.error,
        },
        400
      );
    }

    if (delegation_mode !== undefined && !VALID_DELEGATION_MODES.has(delegation_mode)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'delegation_mode must be one of none, delegation, impersonation',
        },
        400
      );
    }

    const hasClientUpdates = [
      client_name,
      description,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope,
      logo_uri,
      client_uri,
      policy_uri,
      tos_uri,
      is_trusted,
      skip_consent,
      allow_claims_without_scope,
      claims_parameter_policy,
      asc_enabled,
      asc_protected_request_required,
      asc_sao_enabled,
      asc_transformed_claims_enabled,
      asc_allowed_transformed_claims,
      allowed_redirect_origins,
      require_pkce,
      initiate_login_uri,
      login_ui_url,
      application_type,
      trust_group,
      browser_public_client_mode,
      browser_refresh_token_policy,
      native_sso_enabled,
      native_channel_allowed,
      allowed_channels,
      device_secret_revoke_enabled,
      device_secret_revoke_trust_groups,
      device_secret_introspection_enabled,
      device_secret_introspection_trust_groups,
      token_exchange_allowed,
      allowed_subject_token_clients,
      allowed_token_exchange_resources,
      delegation_mode,
      client_credentials_allowed,
      allowed_scopes,
      default_scope,
      default_audience,
      default_resource,
    ].some((v) => v !== undefined);
    const hasRegistryUpdate = webOriginRegistryPayload !== undefined;
    const hasUpdates = hasClientUpdates || hasRegistryUpdate;

    if (!hasUpdates) {
      return c.json({
        success: true,
        message: 'No changes to update',
      });
    }

    const updatedClient = hasClientUpdates
      ? await authCtx.repositories.client.update(clientId, {
          client_name,
          description: descriptionValidation.value,
          redirect_uris,
          grant_types,
          response_types,
          token_endpoint_auth_method,
          scope,
          logo_uri,
          client_uri,
          policy_uri,
          tos_uri,
          is_trusted,
          skip_consent,
          allow_claims_without_scope,
          claims_parameter_policy: claimsParameterPolicyValidation.value,
          asc_enabled: ascEnabledValidation.value ?? undefined,
          asc_protected_request_required: ascProtectedRequestRequiredValidation.value ?? undefined,
          asc_sao_enabled: ascSaoEnabledValidation.value ?? undefined,
          asc_transformed_claims_enabled: ascTransformedClaimsEnabledValidation.value ?? undefined,
          asc_allowed_transformed_claims: ascAllowedTransformedClaimsValidation.value,
          allowed_redirect_origins: validatedAllowedOrigins,
          require_pkce,
          initiate_login_uri,
          login_ui_url,
          application_type: applicationTypeValidation.value,
          trust_group: trustGroupValidation.value,
          browser_public_client_mode: browserPublicClientModeValidation.value,
          browser_refresh_token_policy: browserRefreshTokenPolicyValidation.value,
          native_sso_enabled: nativeSsoEnabledValidation.value,
          native_channel_allowed: nativeChannelAllowedValidation.value,
          allowed_channels: allowedChannelsValidation.value,
          device_secret_revoke_enabled: deviceSecretRevokeEnabledValidation.value,
          device_secret_revoke_trust_groups: deviceSecretRevokeTrustGroupsValidation.value,
          device_secret_introspection_enabled: deviceSecretIntrospectionEnabledValidation.value,
          device_secret_introspection_trust_groups:
            deviceSecretIntrospectionTrustGroupsValidation.value,
          token_exchange_allowed,
          allowed_subject_token_clients: allowedSubjectTokenClientsValidation.value,
          allowed_token_exchange_resources: allowedTokenExchangeResourcesValidation.value,
          delegation_mode,
          client_credentials_allowed,
          allowed_scopes: allowedScopesValidation.value,
          default_scope,
          default_audience,
          default_resource: defaultResourceValidation.value,
        })
      : existingClient;

    let webOriginRegistry =
      webOriginRegistryPayload !== undefined
        ? undefined
        : await getWebOriginRegistry(c.env, tenantId, clientId, authCtx.coreAdapter);
    if (webOriginRegistryPayload !== undefined) {
      try {
        webOriginRegistry = await replaceWebOriginRegistry(
          authCtx.coreAdapter,
          tenantId,
          clientId,
          webOriginRegistryPayload
        );
        await invalidateWebOriginRegistryCache(c.env, tenantId, clientId);
      } catch (error) {
        return c.json(
          {
            error: 'invalid_request',
            error_description:
              error instanceof Error ? error.message : 'Invalid web_origin_registry',
          },
          400
        );
      }
    }

    const log = getLogger(c).module('ADMIN-CLIENT');
    try {
      await invalidateClientCache(c.env, clientId, tenantId);
    } catch {
      log.warn('Failed to invalidate client cache', { action: 'cache_invalidate', clientId });
    }

    publishEvent(c, {
      type: CLIENT_EVENTS.UPDATED,
      tenantId,
      data: {
        clientId,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      log.error(
        'Failed to publish client.updated event',
        { action: 'publish_event' },
        err as Error
      );
    });

    scheduleAuditLogFromContext(c, 'client.updated', 'client', clientId, {
      client_name: updatedClient?.client_name,
    });
    scheduleAdminAuditLog(c, 'client.updated', clientId, 'success', {
      client_name: updatedClient?.client_name,
    });

    if (updatedClient) {
      const { client_secret_hash: _excluded, ...clientWithoutHash } = updatedClient;
      return c.json({
        success: true,
        client: {
          ...clientWithoutHash,
          redirect_uris: parseClientStringArray(updatedClient.redirect_uris, []),
          grant_types: parseClientStringArray(updatedClient.grant_types, ['authorization_code']),
          response_types: parseClientStringArray(updatedClient.response_types, ['code']),
          contacts: updatedClient.contacts
            ? parseClientStringArray(updatedClient.contacts, [])
            : [],
          allowed_subject_token_clients: updatedClient.allowed_subject_token_clients
            ? parseClientStringArray(updatedClient.allowed_subject_token_clients, [])
            : [],
          allowed_token_exchange_resources: updatedClient.allowed_token_exchange_resources
            ? parseClientStringArray(updatedClient.allowed_token_exchange_resources, [])
            : [],
          allowed_scopes: updatedClient.allowed_scopes
            ? parseClientStringArray(updatedClient.allowed_scopes, [])
            : [],
          allowed_channels: updatedClient.allowed_channels
            ? parseClientStringArray(updatedClient.allowed_channels, [])
            : [],
          claims_parameter_policy: parseClaimsParameterPolicyField(
            updatedClient.claims_parameter_policy
          ),
          asc_allowed_transformed_claims: updatedClient.asc_allowed_transformed_claims
            ? parseClientStringArray(updatedClient.asc_allowed_transformed_claims, [])
            : null,
          device_secret_revoke_trust_groups: updatedClient.device_secret_revoke_trust_groups
            ? parseClientStringArray(updatedClient.device_secret_revoke_trust_groups, [])
            : [],
          device_secret_introspection_trust_groups:
            updatedClient.device_secret_introspection_trust_groups
              ? parseClientStringArray(updatedClient.device_secret_introspection_trust_groups, [])
              : [],
          web_origin_registry: webOriginRegistry,
        },
      });
    }

    return c.json({
      success: true,
      client: updatedClient,
    });
  } catch (error) {
    logSanitizedError('Admin client update error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update client',
      },
      500
    );
  }
}

export async function adminClientDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const clientId = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const exists = await authCtx.repositories.client.exists(clientId);

    if (!exists) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    await authCtx.repositories.client.delete(clientId);

    const log = getLogger(c).module('ADMIN-CLIENT');
    try {
      await invalidateClientCacheOnDelete(c.env, clientId, tenantId);
      await invalidateWebOriginRegistryCache(c.env, tenantId, clientId);
    } catch {
      log.warn('Failed to invalidate client cache on delete', {
        action: 'cache_invalidate',
        clientId,
      });
    }

    publishEvent(c, {
      type: CLIENT_EVENTS.DELETED,
      tenantId,
      data: {
        clientId,
      } satisfies ClientEventData,
    }).catch((err: unknown) => {
      log.error(
        'Failed to publish client.deleted event',
        { action: 'publish_event' },
        err as Error
      );
    });

    scheduleAuditLogFromContext(c, 'client.deleted', 'client', clientId, {});
    scheduleAdminAuditLog(c, 'client.deleted', clientId, 'success');

    return c.json({
      success: true,
      message: 'Client deleted successfully',
    });
  } catch (error) {
    logSanitizedError('Admin client delete error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete client',
      },
      500
    );
  }
}

export async function adminClientsBulkDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{ client_ids: string[] }>();
    const { client_ids } = body;

    if (!client_ids || !Array.isArray(client_ids) || client_ids.length === 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'client_ids array is required',
        },
        400
      );
    }

    if (client_ids.length > 100) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot delete more than 100 clients at once',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const result = await authCtx.repositories.client.bulkDelete(client_ids);
    const log = getLogger(c).module('ADMIN-CLIENT');
    const successfullyDeletedIds = client_ids.filter((id) => !result.failed.includes(id));
    for (const clientId of successfullyDeletedIds) {
      try {
        await c.env.CLIENTS_CACHE.delete(buildKVKey('client', clientId, tenantId));
        await invalidateWebOriginRegistryCache(c.env, tenantId, clientId);
      } catch {
        log.warn('Failed to invalidate client cache', { action: 'cache_invalidate', clientId });
      }
    }

    const errors =
      result.failed.length > 0
        ? result.failed.map((id) => `Failed to delete ${id}: client not found or delete failed`)
        : undefined;

    scheduleAdminAuditLog(c, 'client.bulk_deleted', null, 'success', {
      deleted_count: result.deleted,
      requested_count: client_ids.length,
      failed_count: result.failed.length,
      deleted_ids: successfullyDeletedIds,
      failed_ids: result.failed.length > 0 ? result.failed : undefined,
    });

    return c.json({
      success: true,
      deleted: result.deleted,
      requested: client_ids.length,
      errors,
    });
  } catch (error) {
    logSanitizedError('Admin clients bulk delete error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete clients',
      },
      500
    );
  }
}

export async function adminClientRegenerateSecretHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN-CLIENT');
  const tenantId = getTenantIdFromContext(c);
  const clientId = c.req.param('id')!;

  if (!clientId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req
      .json<{
        revoke_existing_tokens?: boolean;
        grace_period_hours?: number;
      }>()
      .catch(() => ({ revoke_existing_tokens: undefined, grace_period_hours: undefined }));

    const gracePeriodHours = body.grace_period_hours;
    if (gracePeriodHours !== undefined && (gracePeriodHours < 1 || gracePeriodHours > 168)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'grace_period_hours', reason: 'Must be between 1 and 168 hours' },
      });
    }

    const adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const client = await getClient(c.env, tenantId, clientId, adapter);

    if (!client || client.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const newSecret = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const newSecretHash = await hashClientSecret(newSecret);
    const nowTs = Math.floor(Date.now() / 1000);

    if (gracePeriodHours) {
      log.warn('Grace period requested but not supported in current schema', {
        action: 'regenerate_secret',
        clientId,
        gracePeriodHours,
      });
    }

    await adapter.execute(
      `UPDATE oauth_clients SET
        client_secret_hash = ?,
        updated_at = ?
       WHERE tenant_id = ? AND client_id = ?`,
      [newSecretHash, nowTs, tenantId, clientId]
    );

    let revokedTokens = 0;
    if (body.revoke_existing_tokens) {
      const tokenResult = await adapter.execute(
        'UPDATE refresh_tokens SET revoked = 1, revoked_at = ? WHERE tenant_id = ? AND client_id = ? AND revoked = 0',
        [nowTs, tenantId, clientId]
      );
      revokedTokens = tokenResult.rowsAffected;
    }

    try {
      await c.env.CLIENTS_CACHE.delete(buildKVKey('client', clientId, tenantId));
    } catch {
      log.warn('Failed to invalidate client cache after secret regeneration', {
        action: 'cache_invalidate',
        clientId,
      });
    }

    await createAuditLogFromContext(c, 'client.secret_regenerate', 'client', clientId, {
      grace_period_hours: gracePeriodHours,
      revoked_tokens: revokedTokens,
    });
    scheduleAdminAuditLog(c, 'client.secret_regenerated', clientId, 'success', {
      grace_period_hours: gracePeriodHours,
      revoked_tokens: revokedTokens,
    });

    log.info('Client secret regenerated', {
      action: 'client_secret_regenerate',
      clientId,
      gracePeriodHours,
      revokedTokens,
    });

    c.header('Cache-Control', 'no-store');

    return c.json({
      client_id: clientId,
      client_secret: newSecret,
      created_at: new Date(nowTs * 1000).toISOString(),
      revoked_tokens: revokedTokens,
    });
  } catch (error) {
    logSanitizedError('Admin client regenerate secret error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

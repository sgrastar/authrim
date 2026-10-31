/**
 * Admin Info / Metadata API Endpoint
 *
 * GET /api/admin/tenants/:id/info
 *
 * Returns issuer info and all derived endpoint URLs for a given tenant.
 * Used by the admin UI "Info" page to display OIDC/OAuth/SAML/VC/CIBA/Admin API endpoints.
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { AuditProfile, Env, ResidencyProfile } from '@authrim/ar-lib-core';
import {
  createD1Adapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  type UIConfigReadOptions,
  getLogger,
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  loadTenantProfileOverridesFromEnv,
  usesNakedDomainIssuer as usesNakedDomainIssuerCore,
} from '@authrim/ar-lib-core';
import { ensureSupportedTenantId } from './single-tenant-guard';
import { getCanonicalTenantBaseUrl } from './request-issuer';
import { requireTenantResourceAccess } from './admin-tenant-access';
import { settingsUnavailableResponse } from './routes/settings/settings-unavailable';

type AdminInfoEnv = Env & {
  LOGIN_UI_ENABLED?: string;
  ADMIN_UI_ENABLED?: string;
  SAML_ENABLED?: string;
  ASYNC_ENABLED?: string;
  VC_ENABLED?: string;
  PROFILE_REGISTRY_BACKEND?: string;
};

interface ComponentAvailability {
  login_ui: boolean;
  admin_ui: boolean;
  saml: boolean;
  async: boolean;
  vc: boolean;
}

/**
 * GET /api/admin/tenants/:id/info
 *
 * Returns the issuer URL and all derived endpoint URLs for the given tenant.
 * No database writes — read-only, rate-limit friendly.
 */
export async function adminTenantInfoHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('id')!;
  const log = getLogger(c).module('ADMIN-INFO');

  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  const blocked = await ensureSupportedTenantId(c, tenantId);
  if (blocked) {
    return blocked;
  }
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) {
    return accessError;
  }

  try {
    // /api/admin/tenants/:id/info is a tenant-inventory route and therefore
    // deliberately has no request-scoped tenant metadata context. Read the
    // platform tenant directory through the deployment Core binding.
    const adapter = createD1Adapter(c.env.DB, 'tenant-info');

    // Verify tenant exists
    const tenant = await adapter.queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE id = ?',
      [tenantId]
    );

    if (!tenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'tenant' },
      });
    }

    // Build canonical base URL for this tenant. When naked-domain issuer mode is enabled,
    // the primary/default tenant should surface the bare domain instead of the tenant subdomain.
    const issuer = buildTenantBaseUrl(c.env, tenantId);

    const components = getComponentAvailability(c.env);
    // The platform's UI for the entry URLs below (as before); the UI base URL configured for the
    // tenant, validated as the login redirects validate it, for login_ui_base_url. Read strictly:
    // a UI that may be configured is not shown as unset (503 instead).
    let urls: [Awaited<ReturnType<typeof getConfiguredUiUrls>>, string | null];
    try {
      const [platformUrls, tenantUrls] = await Promise.all([
        getConfiguredUiUrls(c.env, issuer, undefined, { strict: true }),
        getConfiguredUiUrls(c.env, issuer, tenantId, { strict: true }),
      ]);
      urls = [platformUrls, tenantUrls.loginUiUrl];
    } catch (error) {
      log.warn('UI settings could not be read', { tenantId, error: String(error) });
      return settingsUnavailableResponse(c);
    }
    const [{ loginUiUrl, adminUiUrl }, tenantLoginUiBaseUrl] = urls;
    const singleTenantMode = !c.env.BASE_DOMAIN;
    const tenantLoginUrl = buildTenantLoginUrl({
      issuer,
      loginUiUrl,
      singleTenantMode,
    });
    const globalLoginUiUrl = !singleTenantMode && loginUiUrl ? `${loginUiUrl}/login` : null;
    const discoverUrl = !singleTenantMode && loginUiUrl ? `${loginUiUrl}/discover` : null;

    // API base URL — same origin as the management API (relative construction)
    // We infer from the issuer since the API runs on the same Worker
    const apiBaseUrl = issuer;

    // Construct all standard endpoint URLs
    const endpoints = buildEndpoints(issuer, apiBaseUrl);
    const runtimeProfiles = await resolveRuntimeProfileInfo(c.env, tenantId, log);

    return c.json({
      tenant_id: tenantId,
      tenant_name: tenant.name,
      issuer,
      components,
      login_ui_url: tenantLoginUrl,
      // The UI base URL configured for this tenant (its own when allowed, else the platform's;
      // null: none). The per-request host choice of the login redirects is not applied.
      login_ui_base_url: tenantLoginUiBaseUrl,
      global_login_ui_url: globalLoginUiUrl,
      discover_url: discoverUrl,
      admin_ui_url: adminUiUrl,
      api_url: apiBaseUrl,
      runtime_profiles: runtimeProfiles.profiles,
      runtime_profiles_error: runtimeProfiles.error,
      ...endpoints,
    });
  } catch (error) {
    log.error('Failed to get tenant info', { tenantId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function resolveRuntimeProfileInfo(
  env: AdminInfoEnv,
  tenantId: string,
  log: { warn: (message: string, data?: Record<string, unknown>) => void }
): Promise<{
  profiles: {
    registry_backend: string;
    effective: {
      audit: { id: string; label: string; inherited: boolean };
      residency: { id: string; label: string; inherited: boolean };
    };
  } | null;
  error: string | null;
}> {
  try {
    const [defaults, overrides] = await Promise.all([
      loadEnvironmentProfileDefaultsFromEnv(env),
      loadTenantProfileOverridesFromEnv(env, tenantId),
    ]);
    const auditProfileId = overrides.auditProfileId ?? defaults.auditProfileId;
    const residencyProfileId = overrides.residencyProfileId ?? defaults.residencyProfileId;
    const registry = createRuntimeProfileRegistryFromEnv(env);
    const [auditProfile, residencyProfile] = await Promise.all([
      registry.get<AuditProfile>('audit', auditProfileId),
      registry.get<ResidencyProfile>('residency', residencyProfileId),
    ]);
    if (!auditProfile) throw new Error(`audit_profile_not_found:${auditProfileId}`);
    if (!residencyProfile) throw new Error(`residency_profile_not_found:${residencyProfileId}`);
    return {
      profiles: {
        registry_backend: env.PROFILE_REGISTRY_BACKEND ?? 'kv',
        effective: {
          audit: {
            id: auditProfile.id,
            label: auditProfile.label,
            inherited: !overrides.auditProfileId,
          },
          residency: {
            id: residencyProfile.id,
            label: residencyProfile.label,
            inherited: !overrides.residencyProfileId,
          },
        },
      },
      error: null,
    };
  } catch (error) {
    log.warn('Failed to resolve runtime profiles for tenant info', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      profiles: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function extractWorkersDevAccountSubdomain(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const parts = hostname.split('.');
    if (
      parts.length >= 4 &&
      parts[parts.length - 2] === 'workers' &&
      parts[parts.length - 1] === 'dev'
    ) {
      return parts.slice(1, -2).join('.');
    }
  } catch {
    // Ignore invalid URLs and keep the configured value.
  }
  return null;
}

function normalizeWorkersDevUrlWithAccountSubdomain(
  value: string | null,
  issuer: string | null
): string | null {
  if (!value || !issuer) {
    return value;
  }

  const accountSubdomain = extractWorkersDevAccountSubdomain(issuer);
  if (!accountSubdomain) {
    return value;
  }

  try {
    const parsed = new URL(value);
    const parts = parsed.hostname.split('.');
    if (parts.length === 3 && parts[1] === 'workers' && parts[2] === 'dev') {
      parsed.hostname = `${parts[0]}.${accountSubdomain}.workers.dev`;
      return stripTrailingSlash(parsed.toString());
    }
  } catch {
    // Ignore invalid URLs and keep the configured value.
  }

  return value;
}

function buildTenantLoginUrl(options: {
  issuer: string;
  loginUiUrl: string | null;
  singleTenantMode: boolean;
}): string {
  const { issuer, loginUiUrl, singleTenantMode } = options;
  if (!singleTenantMode || !loginUiUrl) {
    return `${issuer}/login`;
  }

  const normalizedIssuer = stripTrailingSlash(issuer);
  const normalizedLoginUiUrl = stripTrailingSlash(loginUiUrl);
  const baseUrl =
    normalizedLoginUiUrl === normalizedIssuer ? normalizedIssuer : normalizedLoginUiUrl;
  return `${baseUrl}/login`;
}

/**
 * Build all endpoint URL groups from the issuer URL.
 */
function buildEndpoints(issuer: string, apiBaseUrl: string) {
  return {
    /** Well-known / Discovery URLs */
    well_known: {
      openid_configuration: `${issuer}/.well-known/openid-configuration`,
      oauth_authorization_server: `${issuer}/.well-known/oauth-authorization-server`,
      jwks: `${issuer}/.well-known/jwks.json`,
      webfinger: `${issuer}/.well-known/webfinger`,
    },

    /** OIDC / OAuth 2.0 Core Endpoints */
    oidc: {
      authorization: `${issuer}/authorize`,
      token: `${issuer}/token`,
      userinfo: `${issuer}/userinfo`,
      introspection: `${issuer}/introspect`,
      revocation: `${issuer}/revoke`,
      end_session: `${issuer}/logout`,
    },

    /** OAuth 2.0 Extensions */
    oauth_extensions: {
      device_authorization: `${issuer}/device_authorization`,
      pushed_authorization_request: `${issuer}/par`,
      dynamic_client_registration: `${issuer}/register`,
    },

    /** SAML 2.0 Endpoints */
    saml: {
      sso: `${issuer}/saml/idp/sso`,
      idp_metadata: `${issuer}/saml/idp/metadata`,
      sp_metadata: `${issuer}/saml/sp/metadata`,
      metadata: `${issuer}/saml/sp/metadata`,
      acs: `${issuer}/saml/sp/acs`,
      slo: `${issuer}/saml/sp/slo`,
    },

    /** Verifiable Credentials (OID4VC) Endpoints */
    vc: {
      credential_issuer_metadata: `${issuer}/.well-known/openid-credential-issuer`,
      credential: `${issuer}/vci/credential`,
      batch_credential: `${issuer}/vci/batch_credential`,
      deferred_credential: `${issuer}/vci/deferred`,
      vp_token_request: `${issuer}/vp/authorize`,
    },

    /** CIBA (Client-Initiated Backchannel Authentication) */
    ciba: {
      backchannel_authentication: `${issuer}/bc-authorize`,
    },

    /** SCIM 2.0 (Provisioning) */
    scim: {
      base: `${apiBaseUrl}/scim/v2`,
      users: `${apiBaseUrl}/scim/v2/Users`,
      groups: `${apiBaseUrl}/scim/v2/Groups`,
      service_provider_config: `${apiBaseUrl}/scim/v2/ServiceProviderConfig`,
    },

    /** Admin API (Authrim-specific) */
    admin_api: {
      base: `${apiBaseUrl}/api/admin`,
      users: `${apiBaseUrl}/api/admin/users`,
      clients: `${apiBaseUrl}/api/admin/clients`,
      sessions: `${apiBaseUrl}/api/admin/sessions`,
      audit_logs: `${apiBaseUrl}/api/admin/audit-logs`,
      // The Settings API's catalog of categories (values are read per scope and category).
      settings: `${apiBaseUrl}/api/admin/settings/meta`,
      tenants: `${apiBaseUrl}/api/admin/tenants`,
      custom_claims: `${apiBaseUrl}/api/admin/custom-claims`,
      organizations: `${apiBaseUrl}/api/admin/organizations`,
      roles: `${apiBaseUrl}/api/admin/roles`,
      webhooks: `${apiBaseUrl}/api/admin/webhooks`,
    },
  };
}

/**
 * Build the canonical externally visible base URL for a tenant.
 *
 * In naked-domain issuer mode, only the tenant resolved by naked-domain access
 * (PRIMARY_TENANT_ID or DEFAULT_TENANT_ID) should use https://{BASE_DOMAIN}.
 * Other tenants continue to use subdomain-based URLs.
 */
export function buildTenantBaseUrl(env: Env, tenantId: string): string {
  return getCanonicalTenantBaseUrl(env, tenantId);
}

export function usesNakedDomainIssuer(env: Env, tenantId: string): boolean {
  return usesNakedDomainIssuerCore(env, tenantId);
}

export async function getConfiguredUiUrls(
  env: AdminInfoEnv,
  issuer: string | null = null,
  /** The tenant whose sign-in UI is wanted (its own, else the platform's); none: the platform's. */
  tenantId?: string,
  options?: UIConfigReadOptions
): Promise<{
  loginUiUrl: string | null;
  adminUiUrl: string | null;
}> {
  const components = getComponentAvailability(env);
  // The configured base URL, validated as the login redirects validate it.
  const uiConfig = await getUIConfig(env, tenantId, options);
  const loginUiUrl = uiConfig?.baseUrl ?? null;
  const adminUiUrl = components.admin_ui ? env.ADMIN_UI_URL || null : null;
  return {
    loginUiUrl: normalizeWorkersDevUrlWithAccountSubdomain(loginUiUrl, issuer),
    adminUiUrl: normalizeWorkersDevUrlWithAccountSubdomain(adminUiUrl, issuer),
  };
}

export function getComponentAvailability(env: AdminInfoEnv): ComponentAvailability {
  return {
    login_ui: env.LOGIN_UI_ENABLED !== 'false',
    admin_ui: env.ADMIN_UI_ENABLED !== 'false',
    saml: env.SAML_ENABLED !== 'false',
    async: env.ASYNC_ENABLED !== 'false',
    vc: env.VC_ENABLED !== 'false',
  };
}

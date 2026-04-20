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
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getUIConfig,
  getLogger,
  usesNakedDomainIssuer as usesNakedDomainIssuerCore,
} from '@authrim/ar-lib-core';
import { ensureSupportedTenantId } from './single-tenant-guard';
import { getCanonicalTenantBaseUrl } from './request-issuer';

type AdminInfoEnv = Env & {
  LOGIN_UI_ENABLED?: string;
  ADMIN_UI_ENABLED?: string;
  SAML_ENABLED?: string;
  ASYNC_ENABLED?: string;
  VC_ENABLED?: string;
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

  try {
    const adapter = new D1Adapter({ db: c.env.DB });

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
    const { loginUiUrl, adminUiUrl } = await getConfiguredUiUrls(c.env);
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

    return c.json({
      tenant_id: tenantId,
      tenant_name: tenant.name,
      issuer,
      components,
      login_ui_url: tenantLoginUrl,
      global_login_ui_url: globalLoginUiUrl,
      discover_url: discoverUrl,
      admin_ui_url: adminUiUrl,
      api_url: apiBaseUrl,
      ...endpoints,
    });
  } catch (error) {
    log.error('Failed to get tenant info', { tenantId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
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
      settings: `${apiBaseUrl}/api/admin/settings`,
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

export async function getConfiguredUiUrls(env: AdminInfoEnv): Promise<{
  loginUiUrl: string | null;
  adminUiUrl: string | null;
}> {
  const components = getComponentAvailability(env);
  const uiConfig = await getUIConfig(env);
  return {
    loginUiUrl: uiConfig?.baseUrl ?? null,
    adminUiUrl: components.admin_ui ? env.ADMIN_UI_URL || null : null,
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

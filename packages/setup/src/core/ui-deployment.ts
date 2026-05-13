import type { AuthrimConfig } from './config.js';
import {
  classifyUiApiSite,
  type UiApiSiteClassification,
} from './site-classifier.js';
import { ensureHttps } from './url-config.js';
import type { UiEnvConfig } from './ui-env.js';

export type UiComponent = 'ar-login-ui' | 'ar-admin-ui';
export type AdminUiApiMode = 'same-origin' | 'same-site-cross-origin' | 'cross-site-proxy';

export const DISABLED_API_BACKEND_URL = '__DISABLED__';

export interface ResolveUiDeploymentOptions {
  component: UiComponent;
  config: AuthrimConfig;
  apiBaseUrl?: string;
  loginUiClientId?: string;
}

export interface UiDeploymentSettings {
  apiBaseUrl: string;
  uiUrl: string;
  useRelativeApi: boolean;
  needsProxy: boolean;
  siteClassification: UiApiSiteClassification;
  adminUiApiMode?: AdminUiApiMode;
  uiEnv: UiEnvConfig;
  runtimeApiBackendUrl: string;
  serviceBindingName: string | undefined;
}

export function describeAdminUiApiMode(mode: AdminUiApiMode): string {
  switch (mode) {
    case 'same-origin':
      return 'Admin UI calls Admin API on the same origin with HttpOnly SameSite=Lax cookies.';
    case 'same-site-cross-origin':
      return 'Admin UI calls the same-site Admin API origin directly with credentialed CORS and CSRF checks.';
    case 'cross-site-proxy':
      return 'Admin UI uses the Worker BFF via Service Binding; browser direct cross-site Admin API calls are disabled.';
  }
}

function normalizeUrl(url: string | null | undefined): string | undefined {
  const normalized = ensureHttps(url);
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).origin;
  } catch {
    return undefined;
  }
}

function normalizeHostname(urlOrDomain: string | null | undefined): string | undefined {
  const normalized = ensureHttps(urlOrDomain);
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isWithinBaseDomain(hostname: string, baseDomain?: string): boolean {
  if (!baseDomain) {
    return false;
  }

  return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
}

function getUiConfig(config: AuthrimConfig, component: UiComponent) {
  return component === 'ar-login-ui' ? config.urls?.loginUi : config.urls?.adminUi;
}

function getFallbackUiUrl(env: string, component: UiComponent): string {
  return component === 'ar-login-ui'
    ? `https://${env}-ar-login-ui.workers.dev`
    : `https://${env}-ar-admin-ui.workers.dev`;
}

export function resolveUiDeploymentSettings(
  options: ResolveUiDeploymentOptions
): UiDeploymentSettings {
  const { component, config, loginUiClientId } = options;
  const env = config.environment.prefix;

  const apiBaseUrl =
    normalizeUrl(options.apiBaseUrl) ||
    normalizeUrl(config.urls?.api?.custom) ||
    normalizeUrl(config.urls?.api?.auto) ||
    `https://${env}-ar-router.workers.dev`;
  // Use apiBaseUrl (prefers custom domain over workers.dev) as the runtime backend URL.
  // When a custom domain is set, workers_dev is false (disabled), so the workers.dev
  // URL is unreachable. apiBaseUrl already resolves to the best available URL:
  // custom domain → auto (workers.dev) → fallback.
  const runtimeApiBackendUrl = apiBaseUrl;

  const uiConfig = getUiConfig(config, component);
  const uiUrl = uiConfig?.sameAsApi
    ? apiBaseUrl
    : normalizeUrl(uiConfig?.custom) ||
      normalizeUrl(uiConfig?.auto) ||
      getFallbackUiUrl(env, component);

  const apiOrigin = new URL(apiBaseUrl);
  const uiOrigin = new URL(uiUrl);

  const configuredBaseDomain =
    config.tenant?.multiTenant === true ? normalizeHostname(config.tenant?.baseDomain) : undefined;
  const sameOrigin = apiOrigin.origin === uiOrigin.origin;
  const sameConfiguredSite =
    isWithinBaseDomain(apiOrigin.hostname, configuredBaseDomain) &&
    isWithinBaseDomain(uiOrigin.hostname, configuredBaseDomain);
  const siteClassification = classifyUiApiSite(apiBaseUrl, uiUrl, {
    baseDomain: configuredBaseDomain,
  });

  const adminUiApiMode: AdminUiApiMode | undefined =
    component === 'ar-admin-ui'
      ? siteClassification === 'cross-site'
        ? 'cross-site-proxy'
        : siteClassification
      : undefined;

  // Admin UI uses the new three-mode policy. Login UI keeps its existing policy
  // for now while consuming the shared classifier for follow-up cookie cleanup.
  const needsProxy =
    component === 'ar-admin-ui'
      ? adminUiApiMode === 'cross-site-proxy'
      : !sameOrigin && !sameConfiguredSite;
  const useRelativeApi = sameOrigin || needsProxy;

  const uiEnv: UiEnvConfig = {
    PUBLIC_API_BASE_URL: useRelativeApi ? '' : apiBaseUrl,
    PUBLIC_API_PROXY_BACKEND_URL: needsProxy ? runtimeApiBackendUrl : undefined,
    API_BACKEND_URL: needsProxy ? runtimeApiBackendUrl : DISABLED_API_BACKEND_URL,
  };

  // Set PUBLIC_AUTHRIM_ISSUER for both components so hooks.server.ts can
  // derive the correct X-Authrim-Forwarded-Host for Service Binding requests.
  uiEnv.PUBLIC_AUTHRIM_ISSUER = apiBaseUrl;
  if (component === 'ar-login-ui') {
    uiEnv.PUBLIC_LOGIN_UI_CLIENT_ID = loginUiClientId;
  } else {
    uiEnv.ADMIN_UI_API_MODE = adminUiApiMode;
  }

  return {
    apiBaseUrl,
    uiUrl,
    useRelativeApi,
    needsProxy,
    siteClassification,
    adminUiApiMode,
    uiEnv,
    runtimeApiBackendUrl: needsProxy ? runtimeApiBackendUrl : DISABLED_API_BACKEND_URL,
    serviceBindingName: needsProxy ? 'AR_ROUTER' : undefined,
  };
}

import type { AuthrimConfig } from './config.js';
import { classifyUiApiSite, type UiApiSiteClassification } from './site-classifier.js';
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
  workersDev: boolean;
  routes: Array<{ pattern: string; custom_domain: boolean }>;
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

export function normalizeUiDomainHostname(
  urlOrDomain: string | null | undefined
): string | undefined {
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

function isWorkersDevHostname(hostname: string): boolean {
  return hostname === 'workers.dev' || hostname.endsWith('.workers.dev');
}

export function isImmediateSubdomainOfBaseDomain(hostname: string, baseDomain?: string): boolean {
  if (!baseDomain || !hostname.endsWith(`.${baseDomain}`)) {
    return false;
  }

  const prefix = hostname.slice(0, -baseDomain.length - 1);
  return prefix.length > 0 && !prefix.includes('.');
}

export function isRoutedByMultiTenantRouter(hostname: string, baseDomain?: string): boolean {
  return hostname === baseDomain || isImmediateSubdomainOfBaseDomain(hostname, baseDomain);
}

export function uiCustomDomainRequiresOwnRoute(options: {
  uiDomain?: string | null;
  apiDomain?: string | null;
  baseDomain?: string | null;
  multiTenant?: boolean;
}): boolean {
  const uiHostname = normalizeUiDomainHostname(options.uiDomain);
  if (!uiHostname) {
    return false;
  }

  const apiHostname = normalizeUiDomainHostname(options.apiDomain);
  if (apiHostname && uiHostname === apiHostname) {
    return false;
  }

  const baseDomain =
    options.multiTenant === true ? normalizeUiDomainHostname(options.baseDomain) : undefined;
  if (baseDomain && uiHostname === baseDomain) {
    return false;
  }

  return true;
}

function getUiConfig(config: AuthrimConfig, component: UiComponent) {
  return component === 'ar-login-ui' ? config.urls?.loginUi : config.urls?.adminUi;
}

function getFallbackUiUrl(env: string, component: UiComponent): string {
  return component === 'ar-login-ui'
    ? `https://${env}-ar-login-ui.workers.dev`
    : `https://${env}-ar-admin-ui.workers.dev`;
}

function getCustomDomainRoute(uiConfig: ReturnType<typeof getUiConfig>, baseDomain?: string) {
  if (uiConfig?.sameAsApi || !uiConfig?.custom) {
    return undefined;
  }

  const customUrl = normalizeUrl(uiConfig.custom);
  if (!customUrl) {
    return undefined;
  }

  const hostname = new URL(customUrl).hostname;
  if (hostname === baseDomain) {
    return undefined;
  }

  return { pattern: hostname, custom_domain: true };
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

  const configuredBaseDomain =
    config.tenant?.multiTenant === true
      ? normalizeUiDomainHostname(config.tenant?.baseDomain)
      : undefined;
  const uiConfig = getUiConfig(config, component);
  const uiUrl = uiConfig?.sameAsApi
    ? apiBaseUrl
    : normalizeUrl(uiConfig?.custom) ||
      normalizeUrl(uiConfig?.auto) ||
      getFallbackUiUrl(env, component);
  const customDomainRoute = getCustomDomainRoute(uiConfig, configuredBaseDomain);
  const routes = customDomainRoute ? [customDomainRoute] : [];
  const customUiDomainRoutedByRouter = Boolean(
    !customDomainRoute &&
    !uiConfig?.sameAsApi &&
    uiConfig?.custom &&
    configuredBaseDomain &&
    isRoutedByMultiTenantRouter(
      normalizeUiDomainHostname(uiConfig.custom) ?? '',
      configuredBaseDomain
    )
  );
  const workersDev = routes.length === 0 && !customUiDomainRoutedByRouter && !uiConfig?.sameAsApi;

  const apiOrigin = new URL(apiBaseUrl);
  const uiOrigin = new URL(uiUrl);

  const sameOrigin = apiOrigin.origin === uiOrigin.origin;
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
  // with one extra guard: separate workers.dev UI/API origins still use the BFF
  // even when PSL classification says they are same-site.
  const needsProxy =
    component === 'ar-admin-ui'
      ? adminUiApiMode === 'cross-site-proxy'
      : !sameOrigin &&
        (siteClassification === 'cross-site' ||
          isWorkersDevHostname(apiOrigin.hostname) ||
          isWorkersDevHostname(uiOrigin.hostname));
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

  // Login UI always benefits from an internal router binding for its SSR and same-origin
  // /api proxy calls. Keep Admin UI tied to cross-site BFF mode because AR_ROUTER changes
  // its CSP and proxy behavior.
  const serviceBindingName = component === 'ar-login-ui' || needsProxy ? 'AR_ROUTER' : undefined;

  return {
    apiBaseUrl,
    uiUrl,
    workersDev,
    routes,
    useRelativeApi,
    needsProxy,
    siteClassification,
    adminUiApiMode,
    uiEnv,
    runtimeApiBackendUrl: needsProxy ? runtimeApiBackendUrl : DISABLED_API_BACKEND_URL,
    serviceBindingName,
  };
}

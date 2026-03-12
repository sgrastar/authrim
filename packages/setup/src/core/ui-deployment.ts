import type { AuthrimConfig } from './config.js';
import { ensureHttps } from './url-config.js';
import type { UiEnvConfig } from './ui-env.js';

export type UiComponent = 'ar-login-ui' | 'ar-admin-ui';

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
  uiEnv: UiEnvConfig;
  runtimeApiBackendUrl: string;
  serviceBindingName: string | undefined;
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
    ? `https://${env}-ar-login-ui.pages.dev`
    : `https://${env}-ar-admin-ui.pages.dev`;
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
  const runtimeApiBackendUrl = normalizeUrl(config.urls?.api?.auto) || apiBaseUrl;

  const uiConfig = getUiConfig(config, component);
  const uiUrl = uiConfig?.sameAsApi
    ? apiBaseUrl
    : normalizeUrl(uiConfig?.custom) ||
      normalizeUrl(uiConfig?.auto) ||
      getFallbackUiUrl(env, component);

  const apiOrigin = new URL(apiBaseUrl);
  const uiOrigin = new URL(uiUrl);

  const configuredBaseDomain = normalizeHostname(config.tenant?.baseDomain);
  const sameOrigin = apiOrigin.origin === uiOrigin.origin;
  const sameConfiguredSite =
    isWithinBaseDomain(apiOrigin.hostname, configuredBaseDomain) &&
    isWithinBaseDomain(uiOrigin.hostname, configuredBaseDomain);

  // Use relative same-origin API calls whenever the UI is colocated with the API
  // or when Pages needs to proxy requests to avoid cross-site cookie/CSP issues.
  const needsProxy = !sameOrigin && !sameConfiguredSite;
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
  }

  return {
    apiBaseUrl,
    uiUrl,
    useRelativeApi,
    needsProxy,
    uiEnv,
    runtimeApiBackendUrl: needsProxy ? runtimeApiBackendUrl : DISABLED_API_BACKEND_URL,
    serviceBindingName: needsProxy ? 'AR_ROUTER' : undefined,
  };
}

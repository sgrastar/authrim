import type { AuthrimConfig, UrlsConfig } from './config.js';

export interface BuildUrlsConfigOptions {
  env: string;
  apiDomain?: string | null;
  loginUiDomain?: string | null;
  adminUiDomain?: string | null;
  zoneId?: string | null;
  customDomainBinding?: boolean;
  workersSubdomain?: string | null;
  existingUrls?: Partial<UrlsConfig>;
}

export function ensureHttps(domain: string | null | undefined): string | null {
  if (!domain) return null;
  return domain.startsWith('http://') || domain.startsWith('https://')
    ? domain
    : `https://${domain}`;
}

export function getWorkersDevUrl(workerName: string, workersSubdomain?: string | null): string {
  if (workersSubdomain) {
    return `https://${workerName}.${workersSubdomain}.workers.dev`;
  }
  return `https://${workerName}.workers.dev`;
}

export function getPagesDevUrl(projectName: string): string {
  return `https://${projectName}.pages.dev`;
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface ResolveEnvironmentUrlOptions {
  env: string;
  workersSubdomain?: string | null;
}

export interface DomainRoutingConflict {
  field: 'loginUiDomain' | 'adminUiDomain';
  message: string;
}

export interface ValidateDomainRoutingOptions {
  apiDomain?: string | null;
  loginUiDomain?: string | null;
  adminUiDomain?: string | null;
  multiTenant?: boolean;
  nakedDomain?: boolean;
}

function isMultiTenantConfigured(config?: Partial<AuthrimConfig> | null): boolean {
  return config?.tenant?.multiTenant === true && !!config.tenant.baseDomain?.trim();
}

function normalizeDomainInput(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
  return normalized || null;
}

export function validateDomainRoutingConfig(
  options: ValidateDomainRoutingOptions
): DomainRoutingConflict[] {
  const apiDomain = normalizeDomainInput(options.apiDomain);
  if (!apiDomain || options.multiTenant !== true || options.nakedDomain === true) {
    return [];
  }

  const conflicts: DomainRoutingConflict[] = [];
  const candidateDomains = [
    ['loginUiDomain', normalizeDomainInput(options.loginUiDomain)],
    ['adminUiDomain', normalizeDomainInput(options.adminUiDomain)],
  ] as const;

  for (const [field, candidateDomain] of candidateDomains) {
    if (candidateDomain && candidateDomain === apiDomain) {
      conflicts.push({
        field,
        message:
          'UI custom domain cannot match the API domain in multi-tenant mode unless naked domain is enabled.',
      });
    }
  }

  return conflicts;
}

export function resolveIssuerUrl(
  config: Partial<AuthrimConfig> | null | undefined,
  options: ResolveEnvironmentUrlOptions
): string {
  const tenantName = config?.tenant?.name?.trim() || 'default';
  const baseDomain = config?.tenant?.baseDomain?.trim();

  if (isMultiTenantConfigured(config) && baseDomain) {
    return config?.tenant?.nakedDomain === true
      ? `https://${baseDomain}`
      : `https://${tenantName}.${baseDomain}`;
  }

  const apiUrl = config?.urls?.api?.custom || config?.urls?.api?.auto;
  if (apiUrl) {
    return stripTrailingSlash(apiUrl);
  }

  return getWorkersDevUrl(`${options.env}-ar-router`, options.workersSubdomain);
}

export function resolveSharedLoginUiBaseUrl(
  config: Partial<AuthrimConfig> | null | undefined,
  options: ResolveEnvironmentUrlOptions
): string {
  const loginUiUrl = config?.urls?.loginUi?.custom || config?.urls?.loginUi?.auto;
  if (loginUiUrl) {
    return stripTrailingSlash(loginUiUrl);
  }

  return getPagesDevUrl(`${options.env}-ar-login-ui`);
}

export function resolveLoginUiEntryUrl(
  config: Partial<AuthrimConfig> | null | undefined,
  options: ResolveEnvironmentUrlOptions
): string {
  if (isMultiTenantConfigured(config) || config?.urls?.loginUi?.sameAsApi === true) {
    return `${resolveIssuerUrl(config, options)}/login`;
  }

  return `${resolveSharedLoginUiBaseUrl(config, options)}/login`;
}

export function resolveAdminUiEntryUrl(
  config: Partial<AuthrimConfig> | null | undefined,
  options: ResolveEnvironmentUrlOptions
): string {
  if (config?.urls?.adminUi?.sameAsApi === true) {
    return `${resolveIssuerUrl(config, options)}/admin/info`;
  }

  const adminUiUrl = config?.urls?.adminUi?.custom || config?.urls?.adminUi?.auto;
  const adminBaseUrl = adminUiUrl
    ? stripTrailingSlash(adminUiUrl)
    : getPagesDevUrl(`${options.env}-ar-admin-ui`);
  return `${adminBaseUrl}/admin/info`;
}

export function resolveTenantDiscoverUrl(
  config: Partial<AuthrimConfig> | null | undefined,
  options: ResolveEnvironmentUrlOptions
): string | null {
  if (!isMultiTenantConfigured(config)) {
    return null;
  }

  return `${resolveSharedLoginUiBaseUrl(config, options)}/discover`;
}

export function buildInitialAdminSetupUrl(baseUrl: string, token: string): string {
  return `${stripTrailingSlash(baseUrl)}/admin-init-setup?token=${token}`;
}

export function resolveInitialAdminSetupUrl(
  config: Partial<AuthrimConfig> | null | undefined,
  token: string,
  options: ResolveEnvironmentUrlOptions
): string {
  return buildInitialAdminSetupUrl(resolveIssuerUrl(config, options), token);
}

export function buildUrlsConfig(options: BuildUrlsConfigOptions): UrlsConfig {
  const {
    env,
    apiDomain,
    loginUiDomain,
    adminUiDomain,
    zoneId,
    customDomainBinding,
    workersSubdomain,
    existingUrls,
  } = options;

  const apiCustomUrl = ensureHttps(apiDomain);
  const loginUiCustomUrl = ensureHttps(loginUiDomain);
  const adminUiCustomUrl = ensureHttps(adminUiDomain);

  // If existingUrls.api.auto matches the custom domain, it was incorrectly set — regenerate.
  const existingAutoUrl = existingUrls?.api?.auto;
  const autoUrlIsCustomDomain = existingAutoUrl && apiCustomUrl && existingAutoUrl === apiCustomUrl;
  const resolvedAutoUrl =
    (!autoUrlIsCustomDomain && existingAutoUrl) ||
    getWorkersDevUrl(`${env}-ar-router`, workersSubdomain);

  return {
    api: {
      custom: apiCustomUrl,
      auto: resolvedAutoUrl,
      zoneId: zoneId ?? existingUrls?.api?.zoneId ?? null,
      customDomainBinding: customDomainBinding ?? existingUrls?.api?.customDomainBinding ?? false,
    },
    loginUi: {
      custom: loginUiCustomUrl,
      auto: existingUrls?.loginUi?.auto || getPagesDevUrl(`${env}-ar-login-ui`),
      sameAsApi: apiCustomUrl !== null && loginUiCustomUrl === apiCustomUrl,
    },
    adminUi: {
      custom: adminUiCustomUrl,
      auto: existingUrls?.adminUi?.auto || getPagesDevUrl(`${env}-ar-admin-ui`),
      sameAsApi: apiCustomUrl !== null && adminUiCustomUrl === apiCustomUrl,
    },
  };
}

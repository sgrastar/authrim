import type { UrlsConfig } from './config.js';

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

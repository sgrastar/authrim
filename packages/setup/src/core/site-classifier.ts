import { getDomain } from 'tldts';

export type UiApiSiteClassification = 'same-origin' | 'same-site-cross-origin' | 'cross-site';

export interface SiteClassifierOptions {
  /**
   * Explicit deployment base domain used as a fallback when PSL parsing cannot
   * derive a registrable domain. This must be a bare hostname, not a URL.
   */
  baseDomain?: string | null;
  /**
   * Local development may intentionally run UI and API on different localhost
   * ports. Production callers should leave this disabled.
   */
  allowLocalhostSameSite?: boolean;
}

function parseUrl(value: string): URL {
  return new URL(value);
}

function normalizeHostname(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed;
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isWithinBaseDomain(hostname: string, baseDomain?: string): boolean {
  if (!baseDomain) {
    return false;
  }

  return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
}

export function getSchemefulSite(url: string): string | null {
  const parsed = parseUrl(url);
  const domain = getDomain(parsed.hostname, { allowPrivateDomains: true });
  if (!domain) {
    return null;
  }

  return `${parsed.protocol}//${domain.toLowerCase()}`;
}

export function isSameOrigin(apiUrl: string, uiUrl: string): boolean {
  return parseUrl(apiUrl).origin === parseUrl(uiUrl).origin;
}

export function isSameSite(
  apiUrl: string,
  uiUrl: string,
  options: SiteClassifierOptions = {}
): boolean {
  const api = parseUrl(apiUrl);
  const ui = parseUrl(uiUrl);

  if (api.protocol !== ui.protocol) {
    return false;
  }

  const apiSite = getSchemefulSite(apiUrl);
  const uiSite = getSchemefulSite(uiUrl);
  if (apiSite && uiSite && apiSite === uiSite) {
    return true;
  }

  if (options.allowLocalhostSameSite && isLocalhost(api.hostname) && isLocalhost(ui.hostname)) {
    return api.protocol === ui.protocol;
  }

  const baseDomain = normalizeHostname(options.baseDomain);
  return (
    api.protocol === 'https:' &&
    ui.protocol === 'https:' &&
    isWithinBaseDomain(api.hostname.toLowerCase(), baseDomain) &&
    isWithinBaseDomain(ui.hostname.toLowerCase(), baseDomain)
  );
}

export function classifyUiApiSite(
  apiUrl: string,
  uiUrl: string,
  options: SiteClassifierOptions = {}
): UiApiSiteClassification {
  if (isSameOrigin(apiUrl, uiUrl)) {
    return 'same-origin';
  }

  if (isSameSite(apiUrl, uiUrl, options)) {
    return 'same-site-cross-origin';
  }

  return 'cross-site';
}

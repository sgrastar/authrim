import type { SessionData } from '../durable-objects/SessionStore';

const MAX_USER_AGENT_LENGTH = 512;

export type SessionDeviceType = 'desktop' | 'mobile' | 'tablet';

export interface SessionClientDescription {
  browser: string | null;
  os: string | null;
  deviceType: SessionDeviceType | null;
}

type CloudflareRequest = Request & {
  cf?: {
    country?: unknown;
  };
};

function normalizeCountryCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || normalized === 'XX') return undefined;
  return normalized;
}

/**
 * Capture portable client metadata when a login session is created.
 *
 * User-Agent is available on standard HTTP requests. Country is optional and is
 * read only from Cloudflare's trusted request metadata; it is intentionally not
 * inferred from an IP address or a caller-controlled header.
 */
export function getSessionClientMetadata(
  request: Request | null | undefined
): Pick<SessionData, 'userAgent' | 'countryCode'> {
  if (!request) return {};
  const userAgent = request.headers.get('User-Agent')?.trim().slice(0, MAX_USER_AGENT_LENGTH);
  const countryCode = normalizeCountryCode((request as CloudflareRequest).cf?.country);

  return {
    ...(userAgent ? { userAgent } : {}),
    ...(countryCode ? { countryCode } : {}),
  };
}

/**
 * Convert a User-Agent into stable, non-localized labels for the account API.
 * Unknown or absent values remain null so callers never have to guess.
 */
export function describeSessionClient(userAgent: unknown): SessionClientDescription {
  if (typeof userAgent !== 'string' || !userAgent.trim()) {
    return { browser: null, os: null, deviceType: null };
  }

  const ua = userAgent.trim();

  let browser: string | null = null;
  if (/EdgiOS\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/EdgA?\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser\//i.test(ua)) browser = 'Samsung Internet';
  else if (/CriOS\//i.test(ua)) browser = 'Google Chrome';
  else if (/FxiOS\//i.test(ua)) browser = 'Mozilla Firefox';
  else if (/Firefox\//i.test(ua)) browser = 'Mozilla Firefox';
  else if (/; wv\)/i.test(ua) || (/\bwv\b/i.test(ua) && /Chrome\//i.test(ua))) {
    browser = 'Android WebView';
  } else if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) browser = 'Google Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';

  let os: string | null = null;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\//i.test(ua))) {
    os = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\//i.test(ua)) ? 'iPadOS' : 'iOS';
  } else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let deviceType: SessionDeviceType | null = null;
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    deviceType = 'tablet';
  } else if (/iPhone|iPod|Mobile/i.test(ua)) {
    deviceType = 'mobile';
  } else if (os) {
    deviceType = 'desktop';
  }

  return { browser, os, deviceType };
}

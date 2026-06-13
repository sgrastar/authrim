import type { Env } from '../types/env';
import { isAllowedOrigin, parseAllowedOrigins } from './origin-validator';

export const ADMIN_UI_BFF_MODE_HEADER = 'X-Authrim-Admin-UI-Api-Mode';
export const ADMIN_UI_BFF_MODE_VALUE = 'cross-site-proxy-bff';
export const ADMIN_UI_FORWARDED_ORIGIN_HEADER = 'X-Authrim-Forwarded-Origin';

export function normalizeWebAuthnOrigin(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeOriginPattern(value: string): string | null {
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) {
    return null;
  }

  if (/^https:\/\/\*\./i.test(trimmed)) {
    return trimmed;
  }

  return normalizeWebAuthnOrigin(trimmed);
}

export function getAdminWebAuthnAllowedOrigins(env: Env): string[] {
  const dynamicEnv = env as unknown as Record<string, string | undefined>;
  const values = [dynamicEnv.ADMIN_WEBAUTHN_ALLOWED_ORIGINS, env.ADMIN_UI_URL, env.ISSUER_URL];

  return values
    .flatMap((value) => parseAllowedOrigins(value))
    .map(normalizeOriginPattern)
    .filter((origin): origin is string => origin !== null);
}

export function isAllowedAdminWebAuthnOrigin(env: Env, origin: string | undefined | null): boolean {
  const normalizedOrigin = normalizeWebAuthnOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return isAllowedOrigin(normalizedOrigin, getAdminWebAuthnAllowedOrigins(env));
}

export function resolveAdminWebAuthnBrowserOrigin(input: {
  env: Env;
  originHeader?: string;
  bffModeHeader?: string;
  forwardedOriginHeader?: string;
}): string | null {
  const requestOrigin = normalizeWebAuthnOrigin(input.originHeader);
  const isAdminUiBff = input.bffModeHeader === ADMIN_UI_BFF_MODE_VALUE;
  const forwardedOrigin = normalizeWebAuthnOrigin(input.forwardedOriginHeader);
  const browserOrigin = isAdminUiBff ? (forwardedOrigin ?? requestOrigin) : requestOrigin;

  if (!browserOrigin || !isAllowedAdminWebAuthnOrigin(input.env, browserOrigin)) {
    return null;
  }

  return browserOrigin;
}

export function getAdminWebAuthnRpIdForOrigin(origin: string): string | null {
  const normalizedOrigin = normalizeWebAuthnOrigin(origin);
  if (!normalizedOrigin) {
    return null;
  }

  return new URL(normalizedOrigin).hostname.toLowerCase();
}

export function normalizeWebAuthnRpId(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || /[/*?#@]/u.test(trimmed) || trimmed.includes(':')) {
    return null;
  }

  try {
    const parsed = new URL(`https://${trimmed}`);
    return parsed.hostname === trimmed ? parsed.hostname : null;
  } catch {
    return null;
  }
}

export function adminWebAuthnOriginMatchesRpId(
  origin: string,
  rpId: string | undefined | null
): boolean {
  const expectedRpId = getAdminWebAuthnRpIdForOrigin(origin);
  const normalizedRpId = normalizeWebAuthnRpId(rpId);

  return expectedRpId !== null && normalizedRpId !== null && expectedRpId === normalizedRpId;
}

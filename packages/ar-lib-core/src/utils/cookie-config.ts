/**
 * Cookie Configuration Utility
 *
 * Determines the appropriate SameSite attribute for cookies based on
 * the relationship between API and UI origins.
 *
 * Security considerations:
 * - SameSite=Lax: More secure, prevents CSRF, but only works for same-origin
 * - SameSite=None: Required for cross-origin, but increases CSRF attack surface
 *
 * This utility allows the setup tool to configure the appropriate value
 * based on the deployment architecture.
 */

import type { Env } from '../types/env';

export type CookieSameSite = 'Strict' | 'Lax' | 'None';

/**
 * Determines if two URLs share the same origin (scheme + host + port)
 *
 * @param url1 - First URL to compare
 * @param url2 - Second URL to compare
 * @returns true if same origin, false otherwise
 */
export function isSameOrigin(url1: string | undefined, url2: string | undefined): boolean {
  if (!url1 || !url2) {
    return false;
  }

  try {
    const origin1 = new URL(url1).origin;
    const origin2 = new URL(url2).origin;
    return origin1 === origin2;
  } catch {
    // Invalid URL - assume different origins for safety
    return false;
  }
}

/**
 * Get the SameSite attribute for session cookies
 *
 * Decision logic:
 * 1. If COOKIE_SAME_SITE env var is set, use that value (explicit override)
 * 2. If ISSUER_URL and UI_URL are same origin, use 'Lax' (more secure)
 * 3. Otherwise, use 'None' (required for cross-origin)
 *
 * @param env - Environment bindings
 * @returns The appropriate SameSite value
 */
export function getSessionCookieSameSite(env: Env): CookieSameSite {
  // Explicit override from environment variable
  const explicitValue = env.COOKIE_SAME_SITE as CookieSameSite | undefined;
  if (explicitValue && ['Strict', 'Lax', 'None'].includes(explicitValue)) {
    return explicitValue;
  }

  // Dynamic detection: compare ISSUER_URL with UI_URL
  if (isSameOrigin(env.ISSUER_URL, env.UI_URL)) {
    return 'Lax';
  }

  // Default to None for cross-origin compatibility
  return 'None';
}

/**
 * Get the SameSite attribute for admin session cookies
 *
 * Decision logic:
 * 1. If ADMIN_COOKIE_SAME_SITE env var is set, use that value (explicit override)
 * 2. If COOKIE_SAME_SITE env var is set, use that value (general override)
 * 3. If ISSUER_URL and ADMIN_UI_URL are same origin, use 'Lax' (more secure)
 * 4. If ISSUER_URL and UI_URL are same origin (admin via same UI), use 'Lax'
 * 5. Otherwise, use 'None' (required for cross-origin)
 *
 * @param env - Environment bindings
 * @returns The appropriate SameSite value
 */
export function getAdminCookieSameSite(env: Env): CookieSameSite {
  // Explicit override for admin cookies
  const adminExplicit = env.ADMIN_COOKIE_SAME_SITE as CookieSameSite | undefined;
  if (adminExplicit && ['Strict', 'Lax', 'None'].includes(adminExplicit)) {
    return adminExplicit;
  }

  // General override from environment variable
  const explicitValue = env.COOKIE_SAME_SITE as CookieSameSite | undefined;
  if (explicitValue && ['Strict', 'Lax', 'None'].includes(explicitValue)) {
    return explicitValue;
  }

  // Dynamic detection: compare ISSUER_URL with ADMIN_UI_URL
  const adminUiUrl = env.ADMIN_UI_URL;
  if (adminUiUrl && isSameOrigin(env.ISSUER_URL, adminUiUrl)) {
    return 'Lax';
  }

  // Fallback: check if admin is served via same UI_URL
  if (isSameOrigin(env.ISSUER_URL, env.UI_URL)) {
    return 'Lax';
  }

  // Default to None for cross-origin compatibility
  return 'None';
}

/**
 * Get the SameSite attribute for browser state cookies (OIDC Session Management)
 *
 * Browser state cookies are used for OIDC Session Management iframe communication.
 * These often need SameSite=None to work with RPs embedding check_session_iframe.
 *
 * Decision logic:
 * 1. If BROWSER_STATE_COOKIE_SAME_SITE env var is set, use that value
 * 2. Default to 'None' because OIDC Session Management typically requires cross-origin iframe
 *
 * @param env - Environment bindings
 * @returns The appropriate SameSite value
 */
export function getBrowserStateCookieSameSite(env: Env): CookieSameSite {
  // Explicit override for browser state cookies
  const explicitValue = env.BROWSER_STATE_COOKIE_SAME_SITE as CookieSameSite | undefined;
  if (explicitValue && ['Strict', 'Lax', 'None'].includes(explicitValue)) {
    return explicitValue;
  }

  // Default to None for OIDC Session Management iframe compatibility
  // This is typically needed for check_session_iframe to work across origins
  return 'None';
}

/**
 * Build cookie options with the appropriate SameSite attribute
 *
 * @param env - Environment bindings
 * @param type - Cookie type: 'session', 'admin', or 'browserState'
 * @param overrides - Optional overrides for cookie options
 * @returns Cookie options object
 */
export function getCookieOptions(
  env: Env,
  type: 'session' | 'admin' | 'browserState',
  overrides: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    maxAge?: number;
  } = {}
): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: CookieSameSite;
  maxAge?: number;
} {
  let sameSite: CookieSameSite;

  switch (type) {
    case 'admin':
      sameSite = getAdminCookieSameSite(env);
      break;
    case 'browserState':
      sameSite = getBrowserStateCookieSameSite(env);
      break;
    case 'session':
    default:
      sameSite = getSessionCookieSameSite(env);
  }

  return {
    path: overrides.path ?? '/',
    httpOnly: overrides.httpOnly ?? (type !== 'browserState'), // browserState needs JS access
    secure: true, // Always true - SameSite=None requires Secure
    sameSite,
    ...(overrides.maxAge !== undefined && { maxAge: overrides.maxAge }),
  };
}

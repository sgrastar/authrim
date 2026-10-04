/**
 * A tenant's security floor for its apps: requirements the tenant sets for every app, which an
 * app's own setting (client scope) can add to but not take away. Each is on when either the
 * tenant or the app turns it on.
 *
 * - `security.pkce_required`: an authorization code request must carry PKCE (S256).
 * - `security.https_redirect_only`: redirect URIs are HTTPS, except a native app's loopback
 *   (RFC 8252). Off, a web app may also use http on a loopback host (development).
 * - `security.dpop_bound_access_tokens`: the token endpoint requires a DPoP proof, so access
 *   tokens are DPoP-bound (RFC 9449).
 * - `security.require_encrypted_request_object`: a request object must be encrypted (JWE).
 *
 * Read strictly: when the settings cannot be read this throws, so a request is refused rather
 * than allowed under requirements the tenant may have set.
 */

import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

export interface AppSecurityRequirements {
  pkceRequired: boolean;
  httpsRedirectOnly: boolean;
  dpopBoundAccessTokens: boolean;
  requireEncryptedRequestObject: boolean;
}

const POLICY_KEYS: Record<keyof AppSecurityRequirements, string> = {
  pkceRequired: 'security.pkce_required',
  httpsRedirectOnly: 'security.https_redirect_only',
  dpopBoundAccessTokens: 'security.dpop_bound_access_tokens',
  requireEncryptedRequestObject: 'security.require_encrypted_request_object',
};

export async function resolveAppSecurityRequirements(
  env: EffectiveSettingsEnv,
  tenantId: string,
  clientId?: string
): Promise<AppSecurityRequirements> {
  const [tenant, app] = await Promise.all([
    resolveEffectiveSettings(env, 'security', { tenantId }),
    clientId ? resolveEffectiveSettings(env, 'security', { tenantId, clientId }) : null,
  ]);
  const on = (key: string) => tenant[key] === true || app?.[key] === true;
  return {
    pkceRequired: on(POLICY_KEYS.pkceRequired),
    // Secure unless set off: only an explicit false allows a web app's http loopback.
    httpsRedirectOnly:
      tenant[POLICY_KEYS.httpsRedirectOnly] !== false ||
      app?.[POLICY_KEYS.httpsRedirectOnly] === true,
    dpopBoundAccessTokens: on(POLICY_KEYS.dpopBoundAccessTokens),
    requireEncryptedRequestObject: on(POLICY_KEYS.requireEncryptedRequestObject),
  };
}

/**
 * Whether a redirect URI's scheme and host are allowed: HTTPS always; http only on a loopback
 * host (localhost, 127.0.0.1, [::1]), and only for a native app or when the tenant allows it for
 * web apps (`security.https_redirect_only` off). Other checks (fragments, registration) are the
 * caller's.
 */
export function redirectUriSchemeAllowed(
  redirectUri: string,
  options: { nativeApp: boolean; httpsRedirectOnly: boolean }
): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return loopback && (options.nativeApp || !options.httpsRedirectOnly);
}

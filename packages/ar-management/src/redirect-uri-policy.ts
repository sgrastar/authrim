/**
 * The tenant's redirect URI policy at registration (security.https_redirect_only), as authorize
 * applies it: http only on a loopback host, for a native app (RFC 8252) or when the tenant (or
 * the app) allows it for web apps.
 */

import {
  redirectUriSchemeAllowed,
  resolveAppSecurityRequirements,
  type Env,
} from '@authrim/ar-lib-core';

/**
 * The first redirect URI the policy refuses, or null. Reads the settings strictly: it throws
 * when they cannot be read, so a registration is not accepted against a policy not known.
 */
export async function redirectUriRefusedByPolicy(
  env: Env,
  tenantId: string,
  input: {
    redirectUris: readonly string[] | undefined;
    applicationType: unknown;
    clientId?: string;
  }
): Promise<string | null> {
  // By the parsed scheme (URL schemes are case-insensitive: HTTP://LOCALHOST is http).
  const httpUris = (input.redirectUris ?? []).filter((uri) => {
    try {
      return new URL(uri).protocol === 'http:';
    } catch {
      return false;
    }
  });
  if (httpUris.length === 0) return null;
  const nativeApp = input.applicationType === 'native';
  const { httpsRedirectOnly } = await resolveAppSecurityRequirements(env, tenantId, input.clientId);
  return (
    httpUris.find((uri) => !redirectUriSchemeAllowed(uri, { nativeApp, httpsRedirectOnly })) ?? null
  );
}

export const REDIRECT_URI_POLICY_DESCRIPTION =
  'http redirect_uris are allowed only on a loopback host for a native app (application_type native), unless the tenant allows them for web apps (security.https_redirect_only)';

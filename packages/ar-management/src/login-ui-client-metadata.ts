/**
 * The OAuth client of the built-in Login UI, as @authrim/setup registers it for the initial
 * tenant (packages/setup/src/core/login-ui-client.ts and browser-client-metadata.ts). A test in
 * the setup package pins the two definitions equal; change them together.
 *
 * Pure: no environment and no I/O, so both sides can import it.
 */

export const LOGIN_UI_CLIENT_NAME = 'Login UI';
export const LOGIN_UI_CLIENT_DESCRIPTION =
  'System-managed public OAuth client used by the built-in Authrim Login UI.';

/** The client id the Login UI sends when `PUBLIC_LOGIN_UI_CLIENT_ID` is not set at its build. */
export const DEFAULT_LOGIN_UI_CLIENT_ID = 'login-ui';

/** Paths on the Login UI origin that the client may redirect back to. */
export const LOGIN_UI_CALLBACK_PATHS = [
  '/callback',
  '/reauth/callback',
  '/device/callback',
  '/ciba/callback',
] as const;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isValidLoginUiClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value);
}

export function buildLoginUiRedirectUris(loginUiOrigin: string): string[] {
  const base = loginUiOrigin.replace(/\/$/, '');
  return LOGIN_UI_CALLBACK_PATHS.map((path) => `${base}${path}`);
}

export interface LoginUiClientMetadata {
  client_name: string;
  description: string;
  redirect_uris: string[];
  grant_types: ['authorization_code'];
  response_types: ['code'];
  scope: string;
  is_trusted: true;
  skip_consent: true;
  token_endpoint_auth_method: 'none';
  require_pkce: true;
  browser_public_client_mode: 'cookie_fallback';
  browser_refresh_token_policy: 'disabled';
  web_origin_registry: {
    origins: Array<{
      origin: string;
      cors: { allowed: true };
      handoff_allowed: true;
      iframe_allowed: false;
    }>;
  };
}

/** `loginUiOrigin` must be a normalized origin (scheme, host and port only). */
export function buildLoginUiClientMetadata(loginUiOrigin: string): LoginUiClientMetadata {
  return {
    client_name: LOGIN_UI_CLIENT_NAME,
    description: LOGIN_UI_CLIENT_DESCRIPTION,
    redirect_uris: buildLoginUiRedirectUris(loginUiOrigin),
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid profile email',
    is_trusted: true,
    skip_consent: true,
    token_endpoint_auth_method: 'none',
    require_pkce: true,
    browser_public_client_mode: 'cookie_fallback',
    browser_refresh_token_policy: 'disabled',
    web_origin_registry: {
      origins: [
        {
          origin: loginUiOrigin,
          cors: { allowed: true },
          handoff_allowed: true,
          iframe_allowed: false,
        },
      ],
    },
  };
}

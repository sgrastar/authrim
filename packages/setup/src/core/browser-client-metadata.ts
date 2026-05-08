export type BrowserClientSessionProfile =
  | 'managed_browser_session'
  | 'cookie_session'
  | 'token_session';

export interface BrowserClientMetadataOptions {
  clientName: string;
  redirectUris: string[];
  sessionProfile: BrowserClientSessionProfile;
  allowedRedirectOrigins?: string[];
  scope?: string;
  trusted?: boolean;
  skipConsent?: boolean;
}

export interface BrowserClientMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: ['authorization_code'];
  response_types: ['code'];
  scope: string;
  is_trusted: boolean;
  skip_consent: boolean;
  token_endpoint_auth_method: 'none';
  require_pkce: true;
  browser_public_client_mode: 'strict' | 'cookie_fallback';
  browser_refresh_token_policy: 'disabled' | 'dpop_bound';
  dpop_bound_access_tokens?: true;
  allowed_redirect_origins?: string[];
  web_origin_registry?: {
    origins: Array<{
      origin: string;
      cors: { allowed: true };
      handoff_allowed: true;
      iframe_allowed: false;
    }>;
  };
}

function originFromUri(uri: string): string | null {
  try {
    return new URL(uri).origin.toLowerCase();
  } catch {
    return null;
  }
}

function deriveWebOrigins(redirectUris: string[], allowedRedirectOrigins?: string[]): string[] {
  const origins = new Set<string>();
  for (const uri of redirectUris) {
    const origin = originFromUri(uri);
    if (origin) {
      origins.add(origin);
    }
  }
  for (const origin of allowedRedirectOrigins ?? []) {
    const normalized = originFromUri(origin);
    if (normalized) {
      origins.add(normalized);
    }
  }
  return [...origins];
}

export function buildBrowserClientMetadata(
  options: BrowserClientMetadataOptions
): BrowserClientMetadata {
  const tokenSession = options.sessionProfile === 'token_session';
  const metadata: BrowserClientMetadata = {
    client_name: options.clientName,
    redirect_uris: options.redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: options.scope ?? 'openid profile email',
    is_trusted: options.trusted ?? true,
    skip_consent: options.skipConsent ?? true,
    token_endpoint_auth_method: 'none',
    require_pkce: true,
    // Public setup names use cookie_session/managed_browser_session; the current
    // Authrim metadata enum still stores that browser-safe mode as cookie_fallback.
    browser_public_client_mode: tokenSession ? 'strict' : 'cookie_fallback',
    browser_refresh_token_policy: tokenSession ? 'dpop_bound' : 'disabled',
  };

  if (tokenSession) {
    metadata.dpop_bound_access_tokens = true;
  }

  if (options.allowedRedirectOrigins && options.allowedRedirectOrigins.length > 0) {
    metadata.allowed_redirect_origins = options.allowedRedirectOrigins;
  }

  const webOrigins = deriveWebOrigins(options.redirectUris, options.allowedRedirectOrigins);
  if (webOrigins.length > 0) {
    metadata.web_origin_registry = {
      origins: webOrigins.map((origin) => ({
        origin,
        cors: { allowed: true },
        handoff_allowed: true,
        iframe_allowed: false,
      })),
    };
  }

  return metadata;
}

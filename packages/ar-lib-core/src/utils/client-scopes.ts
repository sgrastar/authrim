/**
 * The scopes a client may request.
 *
 * One definition for every endpoint that checks a requested scope against the client
 * (/authorize, /device_authorization), so they cannot drift apart.
 */

/** What a client may request when nothing narrower is registered for it. */
export const DEFAULT_CLIENT_AUTHORIZATION_SCOPES = ['openid', 'profile', 'email'] as const;

/** The scopes of a space-separated scope string, without empty entries. */
export function parseScopeList(scope: string | undefined | null): string[] {
  return (scope ?? '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * The scopes the client may request: its `requestable_scopes` whitelist (DCR), else its
 * `allowed_scopes`, else the scopes it registered in `scope`, else the OIDC defaults.
 */
export function getClientAllowedScopes(clientMetadata: {
  allowed_scopes?: string[] | null;
  requestable_scopes?: string[] | null;
  scope?: string | null;
}): string[] {
  if (
    Array.isArray(clientMetadata.requestable_scopes) &&
    clientMetadata.requestable_scopes.length
  ) {
    return clientMetadata.requestable_scopes;
  }
  if (Array.isArray(clientMetadata.allowed_scopes) && clientMetadata.allowed_scopes.length) {
    return clientMetadata.allowed_scopes;
  }
  const registeredScopes = parseScopeList(clientMetadata.scope);
  return registeredScopes.length > 0 ? registeredScopes : [...DEFAULT_CLIENT_AUTHORIZATION_SCOPES];
}

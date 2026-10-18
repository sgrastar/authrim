/**
 * The request side of POST /device_authorization (RFC 8628 section 3.1): reading the form, who the
 * client is, and which scope it gets. Every refusal is an RFC 6749 section 5.2 error (`error`,
 * `error_description`, nothing else), so no internal error code or setting name reaches the caller.
 *
 * Known limit: whether a client exists may be told from the response time. An unregistered
 * client skips the secret check, and a private_key_jwt client that registered a jwks_uri has its
 * key set fetched before the signature can fail. This is the same level as /bc-authorize. Evening
 * it out (JWKS caching and uniform timing) belongs to the shared client authentication code, so
 * it is not done here.
 */

import type { Context } from 'hono';
import type { ClientMetadata, Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_CLIENT_AUTHORIZATION_SCOPES,
  authenticateConfidentialOAuthClient,
  getClientAllowedScopes,
  isDeviceCodePublicClient,
  parseOAuthClientAuthenticationParams,
  parseScopeList,
  readRequestTextWithLimit,
  validateRegisteredClientAuthenticationMethod,
  validateScope,
  type ParsedOAuthClientAuthentication,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';

/** Largest request body accepted (a private_key_jwt assertion is the biggest legitimate field). */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_CLIENT_SECRET_LENGTH = 1024;
const MAX_CLIENT_ASSERTION_LENGTH = 16 * 1024;
const MAX_CLIENT_ASSERTION_TYPE_LENGTH = 256;
/** The whole scope parameter; one scope may be 256 characters (validateScope). */
const MAX_SCOPE_LENGTH = 2048;

export interface DeviceAuthorizationForm {
  clientAuth: ParsedOAuthClientAuthentication;
  clientId: string;
  /** The scope parameter as sent; undefined when absent or blank. */
  scope: string | undefined;
}

/** An RFC 6749 section 5.2 error: never cached, 401 names the scheme the client used. */
export function deviceAuthorizationError(
  c: Context<{ Bindings: Env }>,
  error: string,
  description: string,
  status: 400 | 401 | 429 | 500 | 503,
  headers: Record<string, string> = {}
): Response {
  const responseHeaders: Record<string, string> = {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...headers,
  };
  if (status === 401 && /^basic\s/iu.test(c.req.header('Authorization') ?? '')) {
    // RFC 6749 section 5.2: the challenge matches the scheme the client authenticated with
    responseHeaders['WWW-Authenticate'] = 'Basic realm="authrim", charset="UTF-8"';
  }
  return c.json({ error, error_description: description }, status, responseHeaders);
}

export function invalidClientResponse(c: Context<{ Bindings: Env }>): Response {
  // One answer for a client that does not exist and one that failed to authenticate
  return deviceAuthorizationError(c, 'invalid_client', 'Client authentication failed.', 401);
}

const invalidRequest = (c: Context<{ Bindings: Env }>, description: string) =>
  deviceAuthorizationError(c, 'invalid_request', description, 400);

/**
 * Read the form: application/x-www-form-urlencoded only, at most 64 KiB (counted as it is read),
 * each parameter at most once and of a sane size. A body that cannot be read is the caller's mistake (400), never a 500.
 */
export async function readDeviceAuthorizationForm(
  c: Context<{ Bindings: Env }>
): Promise<{ ok: true; form: DeviceAuthorizationForm } | { ok: false; response: Response }> {
  const fail = (description: string) => ({
    ok: false as const,
    response: invalidRequest(c, description),
  });

  const mediaType = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    return fail('Content-Type must be application/x-www-form-urlencoded.');
  }
  // The size is limited as the body is read, not by what Content-Length declares: a request with
  // no Content-Length (chunked), or one that declares less than it sends, is cut off at the limit
  // too, and nothing past it is ever parsed.
  let text: string;
  try {
    text = await readRequestTextWithLimit(c.req.raw, MAX_BODY_BYTES);
  } catch {
    return fail('The request body is too large or could not be read.');
  }
  const body = new URLSearchParams(text);

  const read = (
    name: string,
    maxLength: number
  ): { ok: true; value: string | undefined } | { ok: false } => {
    const values = body.getAll(name);
    if (values.length === 0) return { ok: true, value: undefined };
    // A repeated parameter is refused (RFC 6749 section 3.1)
    if (values.length > 1 || values[0].length > maxLength) return { ok: false };
    return { ok: true, value: values[0] };
  };
  const clientId = read('client_id', MAX_CLIENT_ID_LENGTH);
  const clientSecret = read('client_secret', MAX_CLIENT_SECRET_LENGTH);
  const clientAssertion = read('client_assertion', MAX_CLIENT_ASSERTION_LENGTH);
  const clientAssertionType = read('client_assertion_type', MAX_CLIENT_ASSERTION_TYPE_LENGTH);
  const scope = read('scope', MAX_SCOPE_LENGTH);
  if (
    !clientId.ok ||
    !clientSecret.ok ||
    !clientAssertion.ok ||
    !clientAssertionType.ok ||
    !scope.ok
  ) {
    return fail('A parameter is repeated or too long.');
  }

  const clientAuth = parseOAuthClientAuthenticationParams({
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    clientAssertion: clientAssertion.value,
    clientAssertionType: clientAssertionType.value,
    authorizationHeader: c.req.header('Authorization') ?? undefined,
  });
  if (!clientAuth.ok) {
    return { ok: false, response: invalidClientResponse(c) };
  }
  // The client_id from the body or the Authorization header (client_secret_basic)
  const resolvedClientId = clientAuth.credentials.clientId;
  if (!resolvedClientId) {
    return fail('client_id is required.');
  }
  if (resolvedClientId.length > MAX_CLIENT_ID_LENGTH) {
    return fail('A parameter is repeated or too long.');
  }

  return {
    ok: true,
    form: {
      clientAuth: clientAuth.credentials,
      clientId: resolvedClientId,
      scope: scope.value?.trim() ? scope.value : undefined,
    },
  };
}

/**
 * RFC 8628 section 3.1: a client that is confidential, or was issued credentials, authenticates
 * as it does at the token endpoint (client_secret_basic, client_secret_post, private_key_jwt,
 * the range CIBA accepts). A public client sends its client_id only, and presenting credentials it
 * has not registered is refused like at the token endpoint.
 */
export async function authenticateDeviceClient(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  client: ClientMetadata,
  credentials: ParsedOAuthClientAuthentication
): Promise<boolean> {
  if (isDeviceCodePublicClient(client)) {
    return validateRegisteredClientAuthenticationMethod(client, credentials.presentation).valid;
  }

  const issuer = getRequestIssuer(c, tenantId);
  const result = await authenticateConfidentialOAuthClient(
    client,
    `${issuer}/device_authorization`,
    credentials,
    {
      issuer,
      // Assertions built for the token endpoint are accepted here too, as at /bc-authorize
      additionalAudiences: [`${issuer}/token`],
      replayProtection: { env: c.env, tenantId },
    }
  );
  return result.ok;
}

/**
 * The scope the code is issued for. A scope sent must be well formed and within what the client
 * may request (the same check as /authorize); it is stored once per scope, single-spaced. With no
 * scope sent, the code gets the OpenID Connect default, narrowed to what the client may request
 * (RFC 6749 section 3.3 allows a default); a client that may request none of it must send a scope.
 */
export function resolveDeviceScope(
  client: ClientMetadata,
  requested: string | undefined
): { ok: true; scope: string } | { ok: false; description: string } {
  const allowed = new Set(getClientAllowedScopes(client));

  if (requested === undefined) {
    const defaults = DEFAULT_CLIENT_AUTHORIZATION_SCOPES.filter((scope) => allowed.has(scope));
    return defaults.length > 0
      ? { ok: true, scope: defaults.join(' ') }
      : { ok: false, description: 'A scope is required for this client.' };
  }

  const scopes = [...new Set(parseScopeList(requested))];
  // Device flow clients need not be OpenID Connect clients: `openid` is not required
  if (scopes.length === 0 || !validateScope(scopes.join(' '), { requireOpenid: false }).valid) {
    return { ok: false, description: 'The requested scope is invalid.' };
  }
  if (scopes.some((scope) => !allowed.has(scope))) {
    return { ok: false, description: 'The requested scope is not allowed for this client.' };
  }
  return { ok: true, scope: scopes.join(' ') };
}

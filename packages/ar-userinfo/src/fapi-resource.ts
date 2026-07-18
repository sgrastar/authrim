import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { introspectTokenFromContext } from '@authrim/ar-lib-core';

/**
 * Minimal OAuth protected resource used for FAPI interoperability checks.
 * It deliberately returns no end-user data and accepts only M2M access tokens.
 */
export async function fapiResourceHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestUrl = new URL(c.req.url);
  requestUrl.search = '';
  requestUrl.hash = '';
  const introspection = await introspectTokenFromContext(c, {
    audience: requestUrl.toString(),
  });
  if (!introspection.valid || !introspection.claims) {
    const error = introspection.error;
    if (error?.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
    return c.json(
      {
        error: error?.error ?? 'invalid_token',
        error_description: error?.error_description ?? 'The access token is invalid',
      },
      (error?.statusCode ?? 401) as 400 | 401 | 403
    );
  }

  const sub = typeof introspection.claims.sub === 'string' ? introspection.claims.sub : '';
  const clientId =
    typeof introspection.claims.client_id === 'string' ? introspection.claims.client_id : '';
  if (!sub.startsWith('client:') || !clientId || sub !== `client:${clientId}`) {
    c.header('WWW-Authenticate', 'Bearer error="insufficient_scope"');
    return c.json(
      {
        error: 'insufficient_scope',
        error_description: 'A client credentials access token is required',
      },
      403
    );
  }

  const interactionId = c.req.header('X-FAPI-Interaction-ID');
  if (interactionId) c.header('X-FAPI-Interaction-ID', interactionId);
  c.header('Date', new Date().toUTCString());
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    sub,
    client_id: clientId,
    scope: typeof introspection.claims.scope === 'string' ? introspection.claims.scope : '',
  });
}

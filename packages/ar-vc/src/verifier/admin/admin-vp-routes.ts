/**
 * Wallet endpoints of the administrator presentation.
 *
 * - GET  /vp/admin/request/:id  the signed request object (application/oauth-authz-req+jwt)
 * - POST /vp/admin/response     the wallet response (direct_post, form-encoded)
 *
 * Errors are the OpenID4VP / OAuth error responses a wallet expects; nothing in them says which
 * check failed beyond the error code the admin sees in the console.
 */

import type { Context } from 'hono';
import { getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';
import type { Env } from '../../types';
import { ShardConfigUnavailableError } from '../../utils/configured-shard';
import { acceptAdminResponse, getAdminRequestObject } from './admin-vp-service';

const MAX_FORM_BYTES = 48 * 1024;

function oauthError(c: Context<{ Bindings: Env }>, status: 400 | 404 | 503, error: string) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error }, status);
}

export async function adminVPRequestObjectRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const requestId = c.req.param('id') ?? '';
  try {
    const requestObject = await getAdminRequestObject(c.env, tenantId, requestId);
    if (!requestObject) return oauthError(c, 404, 'invalid_request_uri');
    return new Response(requestObject, {
      status: 200,
      headers: {
        'Content-Type': 'application/oauth-authz-req+jwt',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ShardConfigUnavailableError) {
      return oauthError(c, 503, 'temporarily_unavailable');
    }
    getLogger(c)
      .module('VC-ADMIN-VP')
      .error('Request object failed', {}, error as Error);
    return oauthError(c, 503, 'temporarily_unavailable');
  }
}

export async function adminVPResponseRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-ADMIN-VP');
  const contentType = c.req.header('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return oauthError(c, 400, 'invalid_request');
  }
  const length = Number(c.req.header('Content-Length') ?? '0');
  if (length > MAX_FORM_BYTES) return oauthError(c, 400, 'invalid_request');
  let form: Record<string, string | File>;
  try {
    const raw = await c.req.text();
    if (raw.length > MAX_FORM_BYTES) return oauthError(c, 400, 'invalid_request');
    form = Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return oauthError(c, 400, 'invalid_request');
  }
  const vpToken = form.vp_token;
  const state = form.state;
  if (typeof vpToken !== 'string' || !vpToken || typeof state !== 'string' || !state) {
    return oauthError(c, 400, 'invalid_request');
  }

  const tenantId = getTenantIdFromContext(c);
  try {
    const outcome = await acceptAdminResponse(c.env, tenantId, state, vpToken);
    c.header('Cache-Control', 'no-store');
    switch (outcome.kind) {
      case 'verified':
        // No redirect_uri: the admin returns to the console, which is waiting for the result.
        return c.json({}, 200);
      case 'refused':
        return c.json({ error: 'access_denied', error_description: outcome.error }, 400);
      case 'unknown':
        return oauthError(c, 400, 'invalid_request');
      case 'replayed':
        return oauthError(c, 400, 'invalid_request');
      default:
        return oauthError(c, 503, 'temporarily_unavailable');
    }
  } catch (error) {
    if (!(error instanceof ShardConfigUnavailableError)) {
      log.error('Admin presentation response failed', {}, error as Error);
    }
    return oauthError(c, 503, 'temporarily_unavailable');
  }
}

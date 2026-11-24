/**
 * Wallet endpoints of the login by HAIP presentation.
 *
 * - GET  /vp/login/request/:id  the signed request object (application/oauth-authz-req+jwt)
 * - POST /vp/login/response     the wallet response (direct_post.jwt: form field `response`)
 *
 * Errors are the OpenID4VP / OAuth error responses a wallet expects; nothing in them says which
 * check failed. A same-device login answers with the `redirect_uri` the wallet opens next.
 */

import type { Context } from 'hono';
import { getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';
import type { Env } from '../../types';
import { ShardConfigUnavailableError } from '../../utils/configured-shard';
import { acceptHaipLoginResponse, getHaipLoginRequestObject } from './haip-login-service';

const MAX_FORM_BYTES = 80 * 1024;

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

function oauthError(c: Context<{ Bindings: Env }>, status: 400 | 404 | 503, error: string) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error }, status);
}

export async function haipLoginRequestObjectRoute(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const requestId = c.req.param('id') ?? '';
  try {
    const requestObject = await getHaipLoginRequestObject(c.env, tenantId, requestId);
    if (!requestObject) return oauthError(c, 404, 'invalid_request_uri');
    return new Response(requestObject, {
      status: 200,
      headers: { 'Content-Type': 'application/oauth-authz-req+jwt', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (!(error instanceof ShardConfigUnavailableError)) {
      getLogger(c)
        .module('VC-HAIP-LOGIN')
        .error('Request object failed', {}, error as Error);
    }
    return oauthError(c, 503, 'temporarily_unavailable');
  }
}

export async function haipLoginResponseRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC-HAIP-LOGIN');
  const contentType = c.req.header('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return oauthError(c, 400, 'invalid_request');
  }
  const length = Number(c.req.header('Content-Length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_FORM_BYTES) {
    return oauthError(c, 400, 'invalid_request');
  }
  let response: string | undefined;
  try {
    const raw = await readBounded(c.req.raw.body, MAX_FORM_BYTES);
    if (raw === null) return oauthError(c, 400, 'invalid_request');
    response = new URLSearchParams(raw).get('response') ?? undefined;
  } catch {
    return oauthError(c, 400, 'invalid_request');
  }
  if (!response) return oauthError(c, 400, 'invalid_request');

  const tenantId = getTenantIdFromContext(c);
  try {
    const outcome = await acceptHaipLoginResponse(c.env, tenantId, response);
    c.header('Cache-Control', 'no-store');
    switch (outcome.kind) {
      case 'verified':
        // Same device: the wallet opens this address next; cross device: the console is polling.
        return c.json(outcome.redirectUri ? { redirect_uri: outcome.redirectUri } : {}, 200);
      case 'refused':
        return c.json({ error: 'access_denied' }, 400);
      case 'unknown':
      case 'replayed':
        return oauthError(c, 400, 'invalid_request');
      default:
        return oauthError(c, 503, 'temporarily_unavailable');
    }
  } catch (error) {
    if (!(error instanceof ShardConfigUnavailableError)) {
      log.error('Login response failed', {}, error as Error);
    }
    return oauthError(c, 503, 'temporarily_unavailable');
  }
}

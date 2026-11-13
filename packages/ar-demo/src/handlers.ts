import {
  AdminApiError,
  buildJoinLink,
  createInvitation,
  createTenant,
  getProvisioningStatus,
} from './admin-api';
import type { Config } from './config';
import { hmacSha256Hex, newTenantId, newTicket, sha256Hex, TICKET_PATTERN } from './crypto';
import { startPage, waitPage, pickLang, type Lang } from './html';
import { logError, logEvent } from './log';
import * as registry from './registry';
import { errorResponse, htmlResponse, jsonResponse } from './respond';
import { verifyTurnstile } from './turnstile';
import type { Deps, Env } from './types';

export const COOKIE_NAME = '__Host-demo_ticket';
const COOKIE_MAX_AGE_SECONDS = 1800;
const MAX_FORM_BYTES = 8192;
const ID_ATTEMPTS = 3;

function ticketCookie(value: string, maxAge: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

const clearCookie = () => ticketCookie('', 0);

function readTicket(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === COOKIE_NAME) {
      const value = part.slice(index + 1).trim();
      return TICKET_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

/** Reads the body as a stream, counting bytes; null (reader cancelled) as soon as it exceeds the cap. */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
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
  return new TextDecoder().decode(bytes);
}

export function langOf(request: Request): Lang {
  return pickLang(request.headers.get('Accept-Language'));
}

export function handleStartPage(request: Request, config: Config): Response {
  return htmlResponse(startPage(langOf(request), config));
}

export function handleWaitPage(request: Request, config: Config): Response {
  return htmlResponse(waitPage(langOf(request), config));
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

export async function handleStart(
  request: Request,
  env: Env,
  config: Config,
  deps: Deps
): Promise<Response> {
  const lang = langOf(request);

  // a. Origin and content type, before anything is read or sent anywhere.
  if (request.headers.get('Origin') !== config.portalOrigin) {
    return errorResponse(lang, 'forbidden', 403);
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(contentType)) {
    return errorResponse(lang, 'bad_request', 415);
  }
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_FORM_BYTES) return errorResponse(lang, 'bad_request', 413);
  const text = await readBoundedText(request, MAX_FORM_BYTES);
  if (text === null) return errorResponse(lang, 'bad_request', 413);
  const token = new URLSearchParams(text).get('cf-turnstile-response') ?? '';

  // The client address: without it neither the limit nor the Turnstile check means anything.
  const rawIp = request.headers.get('CF-Connecting-IP');
  if (!rawIp && !config.development) return errorResponse(lang, 'bad_request', 400);

  // b. Turnstile.
  const human = await verifyTurnstile(deps, {
    secret: config.turnstileSecret,
    token,
    remoteIp: rawIp,
    portalHost: config.portalHost,
  });
  if (!human) return errorResponse(lang, 'verification', 403);

  // c-e. One INSERT decides the per-IP limit and the capacity together.
  const ipHash = await hmacSha256Hex(config.ipHashSecret, rawIp ?? 'development-no-ip');
  const ticket = newTicket();
  const ticketHash = await sha256Hex(ticket);
  const nowSeconds = Math.floor(deps.now() / 1000);
  let tenantId = '';
  let inserted = false;
  for (let attempt = 0; attempt < ID_ATTEMPTS && !inserted; attempt += 1) {
    tenantId = newTenantId();
    try {
      inserted = await registry.tryInsertStart(env.DB, {
        id: tenantId,
        ticketHash,
        ipHash,
        nowSeconds,
        expiresAt: nowSeconds + config.tenantTtlHours * 3600,
        maxActive: config.maxActiveTenants,
        maxPerIp: config.maxStartsPerIpPerDay,
      });
      if (!inserted) break; // refused by the limits, not by a clash of ids
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === ID_ATTEMPTS - 1) {
        logError('registry_insert_failed');
        return errorResponse(lang, 'failed', 503);
      }
    }
  }
  if (!inserted) {
    let perIp = false;
    try {
      perIp = await registry.ipLimitReached(
        env.DB,
        ipHash,
        nowSeconds,
        config.maxStartsPerIpPerDay
      );
    } catch {
      // the message falls back to the capacity one
    }
    logEvent('start_refused', { detail: perIp ? 'ip_limit' : 'capacity' });
    return perIp ? errorResponse(lang, 'ip_limit', 429) : errorResponse(lang, 'capacity', 503);
  }

  // f. Create the tenant. A failed row stays (and counts) until the cleanup removes the tenant.
  try {
    await createTenant(config, deps, tenantId);
  } catch (error) {
    await failRow(env, deps, tenantId, ['provisioning'], 'create_tenant', error);
    return errorResponse(lang, 'failed', 502);
  }
  logEvent('tenant_requested', { tenantId });

  // g.
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/wait',
      'Set-Cookie': ticketCookie(ticket, COOKIE_MAX_AGE_SECONDS),
    },
  });
}

function describe(error: unknown): { status?: number; error: string } {
  if (error instanceof AdminApiError) {
    return {
      ...(error.status !== undefined ? { status: error.status } : {}),
      error: error.code ?? error.kind,
    };
  }
  return { error: 'unexpected' };
}

async function failRow(
  env: Env,
  deps: Deps,
  tenantId: string,
  from: Array<'provisioning' | 'inviting'>,
  op: string,
  error: unknown
): Promise<void> {
  logError('upstream_failure', { tenantId, op, ...describe(error) });
  try {
    await registry.transition(env.DB, tenantId, from, 'failed', Math.floor(deps.now() / 1000));
  } catch {
    logError('registry_update_failed', { tenantId, op });
  }
}

export async function handleStatus(
  request: Request,
  env: Env,
  config: Config,
  deps: Deps
): Promise<Response> {
  const ticket = readTicket(request);
  if (!ticket) return jsonResponse({ error: 'not_found' }, 404);
  const row = await registry.findByTicketHash(env.DB, await sha256Hex(ticket));
  if (!row) return jsonResponse({ error: 'not_found' }, 404);

  switch (row.state) {
    case 'handed_off':
      return jsonResponse({ state: 'handed_off' });
    case 'failed':
    case 'deleting':
    case 'deleted':
      return jsonResponse({ state: 'failed' });
    case 'inviting':
      return jsonResponse({ state: 'provisioning' });
    default:
      break;
  }

  const nowSeconds = Math.floor(deps.now() / 1000);
  // At most one question to the Admin API per interval and row.
  if (!(await registry.acquirePoll(env.DB, row.id, nowSeconds))) {
    return jsonResponse({ state: 'provisioning' });
  }

  let status;
  try {
    status = await getProvisioningStatus(config, deps, row.id);
  } catch (error) {
    if (error instanceof AdminApiError && error.kind === 'config') {
      await failRow(env, deps, row.id, ['provisioning'], 'poll', error);
      return jsonResponse({ state: 'failed' });
    }
    // Anything else is treated as temporary: the visitor's page asks again.
    logError('poll_failed', { tenantId: row.id, ...describe(error) });
    return jsonResponse({ state: 'provisioning' });
  }

  if (status === 'blocked' || status === 'canceled') {
    await failRow(
      env,
      deps,
      row.id,
      ['provisioning'],
      'poll',
      new AdminApiError('upstream', undefined, status)
    );
    return jsonResponse({ state: 'failed' });
  }
  if (status !== 'succeeded') return jsonResponse({ state: 'provisioning' });

  // The hand-off: only the caller that moves provisioning -> inviting continues.
  const claimed = await registry.transition(
    env.DB,
    row.id,
    ['provisioning'],
    'inviting',
    nowSeconds
  );
  if (!claimed) return jsonResponse({ state: 'provisioning' });

  let join: string | null;
  try {
    const invitation = await createInvitation(config, deps, row.id);
    join = buildJoinLink(config, invitation);
    if (!join) {
      await failRow(
        env,
        deps,
        row.id,
        ['inviting'],
        'join_url',
        new AdminApiError('invalid_response', undefined, 'join_url')
      );
      return jsonResponse({ state: 'failed' });
    }
  } catch (error) {
    await failRow(env, deps, row.id, ['inviting'], 'invitation', error);
    return jsonResponse({ state: 'failed' });
  }

  try {
    await registry.transition(env.DB, row.id, ['inviting'], 'handed_off', nowSeconds);
  } catch {
    // The code exists only in this response: the visitor still gets it.
    logError('registry_update_failed', { tenantId: row.id, op: 'handed_off' });
  }
  logEvent('handed_off', { tenantId: row.id });
  return jsonResponse({ state: 'ready', join }, 200, { 'Set-Cookie': clearCookie() });
}

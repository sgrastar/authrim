import {
  AdminApiError,
  buildJoinLink,
  createInvitation,
  createTenant,
  getProvisioningStatus,
  joinExpiresInSeconds,
} from './admin-api';
import type { Config } from './config';
import { hmacSha256Hex, newTenantId, newTicket, sha256Hex, TICKET_PATTERN } from './crypto';
import { gatePage, startPage, type Lang } from './html';
import { chooseLang, langCookie } from './i18n';
import { logError, logEvent } from './log';
import * as registry from './registry';
import { errorResponse, htmlResponse, jsonResponse } from './respond';
import { verifyTurnstile } from './turnstile';
import type { Deps, Env, RegistryRow } from './types';

export const COOKIE_NAME = '__Host-demo_ticket';
const TICKET_LIFETIME_SECONDS = 1800;
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
  return chooseLang(request).lang;
}

/** A page in the chosen language; a valid `?lang=` is remembered in a cookie of its own. */
function localizedPage(
  request: Request,
  config: Config,
  render: (lang: Lang, config: Config) => string
): Response {
  const { lang, remember } = chooseLang(request);
  const extra: HeadersInit = remember
    ? { 'Set-Cookie': langCookie(lang, !config.development) }
    : {};
  return htmlResponse(render(lang, config), 200, extra);
}

export function handleStartPage(request: Request, config: Config): Response {
  return localizedPage(request, config, startPage);
}

export function handleWaitPage(request: Request, config: Config): Response {
  return localizedPage(request, config, gatePage);
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

  // f. Nothing is sent to the core here: the row is queued, and the first GET /status creates the
  // tenant (the core answers the creation only after its deferred provisioning work, about 16 s,
  // which the visitor now spends on the waiting page instead of a frozen start page).
  logEvent('start_queued', { tenantId });

  // g.
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/wait',
      'Set-Cookie': ticketCookie(ticket, TICKET_LIFETIME_SECONDS),
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

/** The visitor-facing progress of a row that is not finished: `state` stays `provisioning`. */
function progress(stage: 'provisioning' | 'inviting'): Response {
  return jsonResponse({ state: 'provisioning', stage });
}

/**
 * A creation call that ended without any answer from the core (it timed out or the connection
 * broke): the tenant may or may not exist, so the row is neither failed nor accepted. Once the
 * lease has run out, a later request repeats the same idempotent call.
 */
function outcomeUnknown(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    error.status === undefined &&
    (error.kind === 'timeout' || error.kind === 'upstream')
  );
}

/**
 * The request that won the creation claim makes the (long) creation call, then records the
 * acceptance. 'failed': the row was failed. 'unknown': no answer, the row waits for its lease.
 */
async function createFor(
  env: Env,
  config: Config,
  deps: Deps,
  row: RegistryRow
): Promise<'accepted' | 'failed' | 'unknown'> {
  // A failed row stays (and counts) until the cleanup deals with it. The cleanup deletes a tenant
  // only when the core accepted this creation (recorded below) or the tenant still carries the
  // portal's own name and description.
  if (row.create_started_at !== null) logEvent('create_reclaimed', { tenantId: row.id });
  try {
    await createTenant(config, deps, row.id);
  } catch (error) {
    if (outcomeUnknown(error)) {
      logError('upstream_failure', { tenantId: row.id, op: 'create_tenant', ...describe(error) });
      return 'unknown';
    }
    await failRow(env, deps, row.id, ['provisioning'], 'create_tenant', error);
    return 'failed';
  }
  let accepted = false;
  try {
    accepted = await registry.markCreateAccepted(env.DB, row.id, Math.floor(deps.now() / 1000));
  } catch {
    // handled below
  }
  if (!accepted) {
    logError('registry_update_failed', { tenantId: row.id, op: 'create_accepted' });
    // Same as a failed creation: the row is reclaimed after the short `failed` grace. If this write
    // fails too, the row stays `provisioning` and a later request repeats the idempotent call.
    try {
      await registry.transition(
        env.DB,
        row.id,
        ['provisioning'],
        'failed',
        Math.floor(deps.now() / 1000)
      );
    } catch {
      // the lease and the abandoned-row rule cover it
    }
    return 'failed';
  }
  logEvent('tenant_requested', { tenantId: row.id });
  return 'accepted';
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

  // The cookie's Max-Age is only a hint the client controls: the lifetime is enforced here.
  const currentSeconds = Math.floor(deps.now() / 1000);
  if (
    row.state !== 'handed_off' &&
    (currentSeconds >= row.created_at + TICKET_LIFETIME_SECONDS || currentSeconds >= row.expires_at)
  ) {
    if (row.state === 'provisioning') {
      try {
        await registry.transition(env.DB, row.id, ['provisioning'], 'failed', currentSeconds);
      } catch {
        logError('registry_update_failed', { tenantId: row.id, op: 'ticket_expired' });
      }
    }
    return jsonResponse({ state: 'failed' }, 200, { 'Set-Cookie': clearCookie() });
  }

  switch (row.state) {
    case 'handed_off':
      return jsonResponse({ state: 'handed_off' });
    case 'failed':
    case 'deleting':
    case 'deleted':
      return jsonResponse({ state: 'failed' });
    case 'inviting':
      return progress('inviting');
    default:
      break;
  }

  const nowSeconds = Math.floor(deps.now() / 1000);

  // Not yet confirmed by the core: either nobody tried (queued) or the creation is in flight or its
  // claimant died. Exactly one request wins the claim and makes the call; every other request just
  // reports the stage at once (it never waits for the claimant).
  if (row.create_accepted_at === null) {
    if (!(await registry.claimCreate(env.DB, row.id, nowSeconds))) {
      if (await registry.failExhaustedCreate(env.DB, row.id, nowSeconds)) {
        logError('create_exhausted', { tenantId: row.id });
        return jsonResponse({ state: 'failed' });
      }
      return progress('provisioning');
    }
    const created = await createFor(env, config, deps, row);
    if (created === 'failed') return jsonResponse({ state: 'failed' });
    if (created === 'unknown') return progress('provisioning');
  }

  // At most one question to the Admin API per interval and row.
  if (!(await registry.acquirePoll(env.DB, row.id, Math.floor(deps.now() / 1000)))) {
    return progress('provisioning');
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
    return progress('provisioning');
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
  if (status !== 'succeeded') return progress('provisioning');

  // The hand-off: only the caller that moves provisioning -> inviting continues.
  const claimed = await registry.transition(
    env.DB,
    row.id,
    ['provisioning'],
    'inviting',
    Math.floor(deps.now() / 1000)
  );
  if (!claimed) return progress('inviting');

  let join: string | null;
  let joinExpiresIn: number;
  try {
    const invitation = await createInvitation(config, deps, row.id);
    joinExpiresIn = joinExpiresInSeconds(invitation, deps.now());
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
    await registry.transition(
      env.DB,
      row.id,
      ['inviting'],
      'handed_off',
      Math.floor(deps.now() / 1000)
    );
  } catch {
    // The code exists only in this response: the visitor still gets it.
    logError('registry_update_failed', { tenantId: row.id, op: 'handed_off' });
  }
  logEvent('handed_off', { tenantId: row.id });
  return jsonResponse(
    { state: 'ready', stage: 'ready', join, join_expires_in: joinExpiresIn },
    200,
    { 'Set-Cookie': clearCookie() }
  );
}

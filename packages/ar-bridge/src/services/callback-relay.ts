/**
 * Relaying a provider's form post from the platform issuer host to the tenant's custom domain.
 *
 * The redirect URI registered at a provider names the tenant's platform issuer host
 * (`buildIssuerUrl`), while a tenant with a primary custom domain starts every sign-in there: the
 * browser's state cookie (and, for a link or a lite sign-in, its session and lite transaction
 * cookies) are the custom domain's. A provider that answers by query is canonicalized there by a
 * redirect; one that answers by a cross-site form post (`response_mode=form_post`: Sign in with
 * Apple) cannot be, so the request context middleware lets that post through and the callback
 * relays it here:
 *
 * 1. On the platform issuer host, the posted answer is kept server-side under a one-time handle
 *    (random, short-lived), bound to its sign-in's state and provider, only for a sign-in still
 *    waiting for its answer, and one at a time per state (repeated posts keep no more). The browser is sent on (303, a top-level GET) to the same callback on
 *    the custom domain with the handle. Nothing else is done on this host: no state is consumed,
 *    no code exchanged, no cookie read or set.
 * 2. On the custom domain, the handle is taken once, and only by the browser that started the
 *    sign-in: its state cookie for the kept state must be presented first (another browser cannot
 *    even spend the handle). The callback then goes on as for any answer, with every check it makes
 *    there (the state cookie again, the stored state, for a link the session and user, for a lite
 *    sign-in its transaction).
 *
 * The handle carries no session and is useless without the starting browser's cookie, as a code
 * and state in a query-mode answer are; the answer itself (code, ID token, Apple's `user`) never
 * goes into a URL. No re-registration of redirect URIs is needed.
 */

import type { Context } from 'hono';
import type {
  Challenge,
  ConsumeChallengeRequest,
  ConsumeChallengeResponse,
  Env,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core';
import { getChallengeStoreForLease } from '@authrim/ar-lib-core';
import { getCookie } from 'hono/cookie';
import { getAuthStateCookieName, matchesAuthStateCookie } from '../utils/state';

/** The challenge store calls this module makes (the sharded stub is untyped). */
interface RelayStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<unknown>;
  claimChallengeRpc(request: StoreChallengeRequest): Promise<{ claimed: boolean }>;
  getChallengeRpc(id: string): Promise<Challenge | null>;
  consumeChallengeRpc(request: ConsumeChallengeRequest): Promise<ConsumeChallengeResponse>;
  deleteChallengeRpc(id: string): Promise<unknown>;
}

/** The query parameter naming a relayed answer on the custom domain's callback. */
export const CALLBACK_RELAY_PARAM = 'relay';

/** How long the browser has to follow the relay (one redirect). */
export const CALLBACK_RELAY_TTL_SECONDS = 120;

const RELAY_TYPE = 'external_idp_callback_relay';
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** The answer a provider posts, as the callback reads it. */
export interface RelayedCallbackParams {
  code?: string;
  idToken?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  issuer?: string;
  responseJwt?: string;
  user?: string;
}

/** The longest value kept for each answer parameter (a longer one is no provider's answer). */
const MAX_LENGTHS: Record<keyof RelayedCallbackParams, number> = {
  code: 4096,
  idToken: 16384,
  state: 512,
  error: 256,
  errorDescription: 2048,
  issuer: 2048,
  responseJwt: 32768,
  user: 8192,
};

function relayId(handle: string): string {
  return `callback_relay:${handle}`;
}

/**
 * The instance holding `key` (a state's lease, a handle's answer): one of the fixed lease
 * partitions, never the configurable challenge shard count, so that the post and the browser that
 * follows it reach the same instance even while that count changes.
 */
function relayStore(env: Env, key: string, tenantId: string): RelayStore {
  const stub: unknown = getChallengeStoreForLease(env, key, tenantId);
  return stub as RelayStore;
}

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The answer's parameters that are set, or null when one is longer than any provider sends. */
export function boundedRelayParams(params: RelayedCallbackParams): RelayedCallbackParams | null {
  const kept: RelayedCallbackParams = {};
  for (const key of Object.keys(MAX_LENGTHS) as (keyof RelayedCallbackParams)[]) {
    const value = params[key];
    if (typeof value !== 'string' || value === '') continue;
    if (value.length > MAX_LENGTHS[key]) return null;
    kept[key] = value;
  }
  return kept;
}

/**
 * Keeps a provider's posted answer for the sign-in `state` names and returns the handle to it;
 * null when an answer is already kept for that state (one at a time: posts repeated with a state
 * a start gave out keep no more than one answer). The caller has checked that the state is a
 * sign-in of `providerKey`'s provider still waiting.
 */
export async function keepRelayedCallback(
  env: Env,
  input: {
    tenantId: string;
    /** The provider as the callback path names it (its slug or ID). */
    providerKey: string;
    state: string;
    params: RelayedCallbackParams;
  }
): Promise<string | null> {
  const stateKey = await sha256Hex(input.state);
  const lease = relayStore(env, stateKey, input.tenantId);
  const handle = randomHandle();
  const { claimed } = await lease.claimChallengeRpc({
    id: `callback_relay_state:${stateKey}`,
    tenantId: input.tenantId,
    type: RELAY_TYPE,
    userId: '',
    challenge: handle,
    ttl: CALLBACK_RELAY_TTL_SECONDS,
  });
  if (!claimed) return null;
  const store = relayStore(env, handle, input.tenantId);
  await store.storeChallengeRpc({
    id: relayId(handle),
    tenantId: input.tenantId,
    type: RELAY_TYPE,
    userId: '',
    challenge: input.state,
    ttl: CALLBACK_RELAY_TTL_SECONDS,
    metadata: { provider: input.providerKey, params: input.params },
  });
  return handle;
}

/**
 * Where the browser goes on to: the provider's callback on the tenant's canonical origin, on the
 * `/auth/external/` path its state cookie is scoped to (whichever of the two paths was posted to).
 */
export function relayedCallbackUrl(providerKey: string, canonicalOrigin: string, handle: string) {
  const target = new URL(
    `/auth/external/${encodeURIComponent(providerKey)}/callback`,
    canonicalOrigin
  );
  target.searchParams.set(CALLBACK_RELAY_PARAM, handle);
  return target.toString();
}

function readParams(value: unknown): RelayedCallbackParams | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const params: RelayedCallbackParams = {};
  for (const key of Object.keys(MAX_LENGTHS) as (keyof RelayedCallbackParams)[]) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'string') return null;
    params[key] = entry;
  }
  return params;
}

/**
 * The answer `handle` names, taken once by the browser that started its sign-in (its state
 * cookie for the kept state), for the provider the callback path names. Null otherwise: unknown,
 * expired, already taken, another provider's, or brought by a browser without that cookie (which
 * leaves it for the right one).
 */
export async function takeRelayedCallback(
  c: Context<{ Bindings: Env }>,
  input: { tenantId: string; providerKey: string; handle: string }
): Promise<RelayedCallbackParams | null> {
  if (!HANDLE_PATTERN.test(input.handle)) return null;
  try {
    const id = relayId(input.handle);
    const store = relayStore(c.env, input.handle, input.tenantId);
    const kept = await store.getChallengeRpc(id);
    if (
      !kept ||
      kept.type !== RELAY_TYPE ||
      kept.tenantId !== input.tenantId ||
      kept.consumed ||
      kept.expiresAt <= Date.now() ||
      kept.metadata?.provider !== input.providerKey
    ) {
      return null;
    }
    const state = kept.challenge;
    if (!matchesAuthStateCookie(state, getCookie(c, await getAuthStateCookieName(state)))) {
      return null;
    }
    const consumed = await store.consumeChallengeRpc({
      id,
      tenantId: input.tenantId,
      type: RELAY_TYPE,
      challenge: state,
    });
    // The answer (an ID token, Apple's name and email) is not kept once it is taken.
    await store.deleteChallengeRpc(id).catch(() => undefined);
    const params = readParams(consumed.metadata?.params);
    // (A JARM answer carries its state inside its response, from which it was read.)
    if (!params || (params.state !== undefined && params.state !== state)) return null;
    return params;
  } catch {
    return null;
  }
}

/**
 * Stopping a SAML sign-in and going back to the service provider (SP).
 *
 * The Login UI runtime ends the Flow interaction of a SAML request when the person cancels
 * (ar-auth `POST /api/v1/login/interactions/:id/cancel`), and answers a path of the SAML IdP
 * (`/saml/idp/login-cancel`). The IdP is what answers the SP, with a failure Response to the
 * request's ACS, once the stored AuthnRequest is used up.
 *
 * The two parts share the interaction row only. The cancel writes, into the interaction's context
 * (`context_json.login_cancel`), the hash of a random one-time token, in the same write that ends
 * the interaction (state `failed`); the token itself goes only on the path it answers. The IdP acts
 * only for an interaction that is `failed`, whose context holds that hash, with a token that
 * matches, and uses the grant up (compare-and-set on the context) before it touches the stored
 * request. A bare request id, a live interaction, an interaction that failed another way, a wrong
 * or repeated token, an old grant: nothing is answered.
 *
 * Whoever started the interaction must also be the browser the IdP sent to sign in. The IdP puts a
 * random nonce on the login URL (`saml_login_nonce`) and keeps only its hash in the stored
 * AuthnRequest (`context.loginNonceHash`); the Flow start keeps the hash of the nonce the browser
 * presents (`saml_login_nonce_hash` in the interaction's context). The stored request is used up
 * only if the two hashes are equal (a conditional consume), so an interaction started from a
 * request id alone can neither be offered a cancel nor use one.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { timingSafeEqual } from '../utils/crypto';

/** The IdP endpoint that answers the SP for a cancelled sign-in. */
export const SAML_LOGIN_CANCEL_PATH = '/saml/idp/login-cancel';

/** The context key the grant is kept under. */
export const SAML_LOGIN_CANCEL_CONTEXT_KEY = 'login_cancel';

/** The nonce the IdP puts on the login URL (32 random bytes, base64url). */
const NONCE = /^[A-Za-z0-9_-]{32,128}$/u;
/** The longest a cancel grant lasts, whatever the stored request's own lifetime. */
export const SAML_LOGIN_CANCEL_MAX_AGE_MS = 10 * 60 * 1000;

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const INTERACTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Whether a value has the form of a login nonce. */
export function isSAMLLoginNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

/** A new login nonce, and the hash (SHA-256, hex) that is all that is ever stored of it. */
export async function createSAMLLoginNonce(): Promise<{ nonce: string; hash: string }> {
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { nonce, hash: await sha256Hex(nonce) };
}

/** The stored form of a login nonce. */
export function hashSAMLLoginNonce(nonce: string): Promise<string> {
  return sha256Hex(nonce);
}

/** A new one-time token, and the value to keep for it in the interaction's context. */
export async function createSAMLLoginCancelGrant(
  nowMs: number = Date.now()
): Promise<{ token: string; context: { token_hash: string; created_at_ms: number } }> {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, context: { token_hash: await sha256Hex(token), created_at_ms: nowMs } };
}

/** The relative path that answers the SP for a cancelled interaction (the origin is the browser's). */
export function buildSAMLLoginCancelPath(input: { interactionId: string; token: string }): string {
  const params = new URLSearchParams({
    interaction_id: input.interactionId,
    token: input.token,
  });
  return `${SAML_LOGIN_CANCEL_PATH}?${params.toString()}`;
}

/** What the IdP needs to answer the SP, taken from the interaction the token was checked against. */
export interface ClaimedSAMLLoginCancel {
  spEntityId: string;
  requestId: string;
  /** The hash of the nonce the interaction was started with: the stored request must hold it. */
  loginNonceHash: string;
}

/**
 * Uses up the cancel grant of an interaction for `token`, or answers null when there is none to
 * use: no such interaction in the tenant, not ended by a cancel (state `failed` with a grant),
 * not a SAML request's, a token that does not match, or a grant already used. Only one of two
 * concurrent callers gets the grant.
 */
export async function claimSAMLLoginCancel(
  db: DatabaseAdapter,
  tenantId: string,
  input: { interactionId: string; token: string },
  options: { nowMs?: number; maxAgeMs?: number } = {}
): Promise<ClaimedSAMLLoginCancel | null> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = Math.min(
    options.maxAgeMs ?? SAML_LOGIN_CANCEL_MAX_AGE_MS,
    SAML_LOGIN_CANCEL_MAX_AGE_MS
  );
  if (!INTERACTION_ID.test(input.interactionId) || !TOKEN.test(input.token)) return null;
  const row = await db.queryOne<{
    state: string | null;
    saml_sp_id: string | null;
    context_json: string | null;
  }>(
    `SELECT state, saml_sp_id, context_json FROM flow_interactions WHERE tenant_id = ? AND id = ?`,
    [tenantId, input.interactionId]
  );
  if (!row || row.state !== 'failed' || !row.saml_sp_id || !row.context_json) return null;
  let context: unknown;
  try {
    context = JSON.parse(row.context_json);
  } catch {
    return null;
  }
  if (!isRecord(context)) return null;
  const grant = context[SAML_LOGIN_CANCEL_CONTEXT_KEY];
  const requestId = context.saml_request_id;
  if (
    !isRecord(grant) ||
    typeof grant.token_hash !== 'string' ||
    grant.consumed_at_ms !== undefined ||
    typeof requestId !== 'string' ||
    !requestId ||
    typeof context.saml_login_nonce_hash !== 'string' ||
    !context.saml_login_nonce_hash ||
    typeof grant.created_at_ms !== 'number' ||
    nowMs - grant.created_at_ms > maxAgeMs ||
    grant.created_at_ms > nowMs + 60_000
  ) {
    return null;
  }
  if (!timingSafeEqual(grant.token_hash, await sha256Hex(input.token))) return null;

  const used = JSON.stringify({
    ...context,
    [SAML_LOGIN_CANCEL_CONTEXT_KEY]: { ...grant, consumed_at_ms: nowMs },
  });
  const result = await db.execute(
    `UPDATE flow_interactions SET context_json = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ? AND state = 'failed' AND context_json = ?`,
    [used, Math.floor(nowMs / 1000), tenantId, input.interactionId, row.context_json]
  );
  if ((result.rowsAffected ?? 0) !== 1) return null;
  return {
    spEntityId: row.saml_sp_id,
    requestId,
    loginNonceHash: context.saml_login_nonce_hash,
  };
}

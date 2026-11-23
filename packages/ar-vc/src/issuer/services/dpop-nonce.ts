/**
 * Server-provided DPoP nonces for the Credential Endpoint (RFC 9449 section 8; design D-C).
 *
 * Stateless: a nonce is a time window and an HMAC of (purpose, tenant, window) under the issuer's
 * server secret, so nothing is stored and any instance can check one. A nonce is accepted for its
 * own window and the one after it, which bounds a proof's life to a few minutes; the proof's own
 * `jti` and `iat` checks keep each proof single-use.
 */

import type { Env } from '../../types';

const WINDOW_SECONDS = 120;
const PURPOSE = 'vci-credential-dpop-nonce-v1';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function mac(secret: string, tenantId: string, window: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(`${PURPOSE}\n${tenantId}\n${window}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)));
}

function windowOf(nowMs: number): number {
  return Math.floor(nowMs / 1000 / WINDOW_SECONDS);
}

/** A fresh nonce, or null when the issuer has no server secret to derive one from. */
export async function issueCredentialDpopNonce(
  env: Env,
  tenantId: string,
  nowMs: number = Date.now()
): Promise<string | null> {
  const secret = env.VC_TRANSACTION_CODE_HMAC_SECRET;
  if (!secret) return null;
  const window = windowOf(nowMs);
  return `${window}.${await mac(secret, tenantId, window)}`;
}

/** Whether `nonce` was issued by this issuer for the tenant, in the current or the previous window. */
export async function verifyCredentialDpopNonce(
  env: Env,
  tenantId: string,
  nonce: unknown,
  nowMs: number = Date.now()
): Promise<boolean> {
  const secret = env.VC_TRANSACTION_CODE_HMAC_SECRET;
  if (!secret || typeof nonce !== 'string' || nonce.length > 128) return false;
  const [windowText, tag, ...rest] = nonce.split('.');
  if (rest.length > 0 || !/^\d{1,12}$/u.test(windowText ?? '') || !tag) return false;
  const window = Number(windowText);
  const current = windowOf(nowMs);
  if (window !== current && window !== current - 1) return false;
  const expected = await mac(secret, tenantId, window);
  if (expected.length !== tag.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ tag.charCodeAt(index);
  }
  return diff === 0;
}

/** The `nonce` claim of a DPoP proof (not verified here; the proof is validated separately). */
export function readDpopProofNonce(proof: string): string | undefined {
  try {
    const part = proof.split('.')[1] ?? '';
    const padded = part.replace(/-/gu, '+').replace(/_/gu, '/');
    const payload = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      nonce?: unknown;
    };
    return typeof payload.nonce === 'string' ? payload.nonce : undefined;
  } catch {
    return undefined;
  }
}

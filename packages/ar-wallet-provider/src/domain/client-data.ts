/**
 * The assertion client data of the wallet provider contract, and the JWK checks that go with it.
 */

import { fromBase64Url, sha256, toBase64Url, utf8 } from './bytes';

export type Purpose = 'wallet-attestation' | 'key-attestation';

export interface PublicP256Jwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/**
 * Accepts a public P-256 JWK (extra members tolerated except private ones) and returns the minimal
 * form, or null.
 */
export function normalizeJwk(value: unknown): PublicP256Jwk | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth']) if (priv in jwk) return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  const x = fromBase64Url(jwk.x);
  const y = fromBase64Url(jwk.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** Whether the point is on the curve; WebCrypto import decides. */
export async function isOnCurve(jwk: PublicP256Jwk): Promise<boolean> {
  try {
    await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
    return true;
  } catch {
    return false;
  }
}

/** RFC 7638 thumbprint, base64url. */
export async function jwkThumbprint(jwk: PublicP256Jwk): Promise<string> {
  return toBase64Url(
    await sha256(utf8(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))
  );
}

/** 1..512 printable ASCII (the contract's nonce and challenge alphabet), no control characters. */
export function isPrintableToken(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

export async function buildClientData(input: {
  purpose: Purpose;
  challenge: string;
  jwk: PublicP256Jwk;
  nonce?: string;
}): Promise<string> {
  const thumbprint = await jwkThumbprint(input.jwk);
  const base = `authrim-wallet-provider/v1\n${input.purpose}\n${input.challenge}\n${thumbprint}`;
  return input.purpose === 'key-attestation' ? `${base}\n${input.nonce ?? ''}` : base;
}

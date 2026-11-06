/**
 * JWK thumbprint (RFC 7638) of a public key, base64url-encoded SHA-256.
 *
 * Only the required members are hashed, in lexicographic order, so the value is stable no matter
 * which extra members the key carries.
 */
export async function calculateJwkThumbprint(jwk: {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}): Promise<string> {
  let canonical: Record<string, string | undefined>;
  switch (jwk.kty) {
    case 'EC':
      canonical = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
      break;
    case 'OKP':
      canonical = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
      break;
    case 'RSA':
      canonical = { e: jwk.e, kty: jwk.kty, n: jwk.n };
      break;
    default:
      throw new Error('unsupported_jwk_type');
  }
  if (Object.values(canonical).some((value) => typeof value !== 'string' || value === '')) {
    throw new Error('invalid_jwk');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)))
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

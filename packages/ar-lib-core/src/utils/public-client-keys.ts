/** Public-only RP key registration. Never strip private members from mutation input. */
import type { JWKS } from '../types/jwk';
import { CLIENT_ASSERTION_SIGNING_ALGS } from '../constants';

const PRIVATE_MEMBERS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
const PUBLIC_MEMBERS = new Set([
  'kty',
  'kid',
  'use',
  'key_ops',
  'alg',
  'n',
  'e',
  'crv',
  'x',
  'y',
  'x5c',
  'x5t',
  'x5t#S256',
  'ext',
]);
export function keyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const encoded = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 8192 &&
  value.length % 4 !== 1 &&
  /^[A-Za-z0-9_-]+$/.test(value);

export function publicSigningAlgorithm(key: Record<string, unknown>): string | undefined {
  if (key.use !== undefined && key.use !== 'sig') return undefined;
  if (Array.isArray(key.key_ops) && !key.key_ops.includes('verify')) return undefined;
  const alg = key.alg ?? (key.kty === 'RSA' ? 'RS256' : key.kty === 'EC' ? 'ES256' : 'EdDSA');
  if (typeof alg !== 'string' || !CLIENT_ASSERTION_SIGNING_ALGS.some((item) => item === alg))
    return undefined;
  if (key.kty === 'RSA' && (alg === 'RS256' || alg === 'PS256')) return alg;
  if (key.kty === 'EC' && key.crv === 'P-256' && alg === 'ES256') return alg;
  if (key.kty === 'OKP' && key.crv === 'Ed25519' && alg === 'EdDSA') return alg;
  return undefined;
}

/** Structural validation shared by the editor and the Admin handler; crypto import follows there. */
export function publicClientJwksProblem(
  value: unknown,
  signingAlg?: string | null
): string | undefined {
  if (
    !keyRecord(value) ||
    Object.keys(value).some((key) => key !== 'keys') ||
    !Array.isArray(value.keys)
  )
    return 'Provide a public JWKS object containing keys';
  if (
    value.keys.length < 1 ||
    value.keys.length > 20 ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536
  )
    return 'JWKS must contain 1 to 20 public keys and fit within 64 KiB';
  const ids = new Set<string>();
  let signing = 0;
  for (const key of value.keys) {
    if (!keyRecord(key)) return 'Each JWKS key must be an object';
    if (key.kty === 'oct' || Object.keys(key).some((member) => PRIVATE_MEMBERS.has(member)))
      return 'Private and symmetric key material is forbidden; register public keys only';
    if (Object.keys(key).some((member) => !PUBLIC_MEMBERS.has(member)))
      return 'Unsupported public JWK member';
    if (typeof key.kid !== 'string' || !key.kid.trim() || key.kid.length > 128 || ids.has(key.kid))
      return 'Each public key needs a unique kid of at most 128 characters';
    ids.add(key.kid);
    for (const member of ['n', 'e', 'x', 'y', 'x5t', 'x5t#S256']) {
      if (key[member] !== undefined && !encoded(key[member])) return 'Invalid public JWK member';
    }
    if (key.ext !== undefined && typeof key.ext !== 'boolean') return 'Invalid JWK ext';
    if (
      key.x5c !== undefined &&
      (!Array.isArray(key.x5c) ||
        key.x5c.length > 10 ||
        key.x5c.some(
          (certificate) =>
            typeof certificate !== 'string' ||
            certificate.length > 16384 ||
            !/^[A-Za-z0-9+/]+=*$/.test(certificate)
        ))
    )
      return 'Invalid JWK certificate chain';
    if (key.use !== undefined && key.use !== 'sig' && key.use !== 'enc') return 'Invalid JWK use';
    if (
      key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) ||
        key.key_ops.length === 0 ||
        key.key_ops.some(
          (op: unknown) => typeof op !== 'string' || !['verify', 'encrypt', 'wrapKey'].includes(op)
        ))
    )
      return 'Only public JWK operations are allowed';
    if (key.kty === 'RSA') {
      if (!encoded(key.n) || !encoded(key.e)) return 'Invalid RSA public key';
      const modulus = atob(key.n.replace(/-/g, '+').replace(/_/g, '/'));
      const first = modulus.charCodeAt(0);
      const bits = (modulus.length - 1) * 8 + (32 - Math.clz32(first));
      if (bits < 2048 || bits > 8192) return 'RSA keys must be 2048 to 8192 bits';
    } else if (key.kty === 'EC') {
      if (
        key.crv !== 'P-256' ||
        !encoded(key.x) ||
        !encoded(key.y) ||
        key.x.length !== 43 ||
        key.y.length !== 43
      )
        return 'Use an EC P-256 public key';
    } else if (key.kty === 'OKP') {
      if (key.crv !== 'Ed25519' || !encoded(key.x) || key.x.length !== 43)
        return 'Use an Ed25519 public key';
    } else return 'Supported key types are RSA, EC P-256 and Ed25519';
    const alg = publicSigningAlgorithm(key);
    if (key.use !== 'enc' && !alg) return 'Unsupported signing algorithm or key/algorithm mismatch';
    if (
      key.use === 'enc' &&
      key.alg !== undefined &&
      (typeof key.alg !== 'string' ||
        !['RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES', 'ECDH-ES+A256KW'].includes(key.alg))
    )
      return 'Unsupported encryption algorithm';
    if (
      alg &&
      (!signingAlg ||
        alg === signingAlg ||
        (key.alg === undefined &&
          publicSigningAlgorithm({ ...key, alg: signingAlg }) !== undefined))
    )
      signing++;
  }
  if (signingAlg !== undefined && signing === 0)
    return 'private_key_jwt needs a usable public signing key for its algorithm';
  return undefined;
}

/** Typed structural read after the same public-only validation used at registration. */
export function isPublicClientJwks(value: unknown): value is JWKS {
  return publicClientJwksProblem(value) === undefined;
}

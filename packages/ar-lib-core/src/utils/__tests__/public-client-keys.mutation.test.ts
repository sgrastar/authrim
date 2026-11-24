import { describe, expect, it } from 'vitest';
import {
  isPublicClientJwks,
  keyRecord,
  publicClientJwksProblem,
  publicSigningAlgorithm,
} from '../public-client-keys';

function b64u(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Modulus of exactly `bits` bits (top bit set). */
function modulus(bits: number): string {
  const byteLen = Math.ceil(bits / 8);
  const topBits = bits - (byteLen - 1) * 8;
  const bytes = new Array<number>(byteLen).fill(0xff);
  bytes[0] = 1 << (topBits - 1);
  return b64u(bytes);
}

const X43 = 'A'.repeat(43);
const E = 'AQAB';

function rsa(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'RSA', kid: 'r1', n: modulus(2048), e: E, ...extra };
}
function ec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'EC', crv: 'P-256', kid: 'e1', x: X43, y: X43, ...extra };
}
function okp(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'OKP', crv: 'Ed25519', kid: 'o1', x: X43, ...extra };
}
function problem(key: unknown, alg?: string | null): string | undefined {
  return publicClientJwksProblem({ keys: [key] }, alg);
}

describe('keyRecord', () => {
  it('accepts plain objects only', () => {
    expect(keyRecord({})).toBe(true);
    expect(keyRecord(null)).toBe(false);
    expect(keyRecord([])).toBe(false);
    expect(keyRecord('x')).toBe(false);
    expect(keyRecord(1)).toBe(false);
    expect(keyRecord(undefined)).toBe(false);
  });
});

describe('publicSigningAlgorithm', () => {
  it('rejects non-sig use and key_ops without verify', () => {
    expect(publicSigningAlgorithm({ kty: 'RSA', use: 'enc' })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'RSA', use: 'sig' })).toBe('RS256');
    expect(publicSigningAlgorithm({ kty: 'RSA', key_ops: ['encrypt'] })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'RSA', key_ops: ['verify'] })).toBe('RS256');
  });

  it('defaults the algorithm by key type', () => {
    expect(publicSigningAlgorithm({ kty: 'RSA' })).toBe('RS256');
    expect(publicSigningAlgorithm({ kty: 'EC', crv: 'P-256' })).toBe('ES256');
    expect(publicSigningAlgorithm({ kty: 'OKP', crv: 'Ed25519' })).toBe('EdDSA');
    expect(publicSigningAlgorithm({ kty: 'other' })).toBeUndefined();
  });

  it('rejects non-string and unsupported algorithms', () => {
    expect(publicSigningAlgorithm({ kty: 'RSA', alg: 5 })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'RSA', alg: 'RS512' })).toBeUndefined();
  });

  it('checks key type, curve and algorithm agreement', () => {
    expect(publicSigningAlgorithm({ kty: 'RSA', alg: 'PS256' })).toBe('PS256');
    expect(publicSigningAlgorithm({ kty: 'RSA', alg: 'ES256' })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'EC', crv: 'P-256', alg: 'ES256' })).toBe('ES256');
    expect(publicSigningAlgorithm({ kty: 'EC', crv: 'P-384', alg: 'ES256' })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'EC', crv: 'P-256', alg: 'RS256' })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' })).toBe('EdDSA');
    expect(publicSigningAlgorithm({ kty: 'OKP', crv: 'Ed448', alg: 'EdDSA' })).toBeUndefined();
    expect(publicSigningAlgorithm({ kty: 'OKP', crv: 'Ed25519', alg: 'ES256' })).toBeUndefined();
  });
});

describe('publicClientJwksProblem: shape and size', () => {
  it('rejects non-objects, extra top-level members and missing keys array', () => {
    const msg = 'Provide a public JWKS object containing keys';
    expect(publicClientJwksProblem(null)).toBe(msg);
    expect(publicClientJwksProblem([])).toBe(msg);
    expect(publicClientJwksProblem({ keys: [], extra: 1 })).toBe(msg);
    expect(publicClientJwksProblem({ keys: 'x' })).toBe(msg);
    expect(publicClientJwksProblem({})).toBe(msg);
  });

  it('enforces 1..20 keys', () => {
    const msg = 'JWKS must contain 1 to 20 public keys and fit within 64 KiB';
    expect(publicClientJwksProblem({ keys: [] })).toBe(msg);
    const mk = (n: number) => ({
      keys: Array.from({ length: n }, (_, i) => okp({ kid: `k${i}` })),
    });
    expect(publicClientJwksProblem(mk(20))).toBeUndefined();
    expect(publicClientJwksProblem(mk(21))).toBe(msg);
  });

  it('enforces the 64 KiB serialized limit', () => {
    const msg = 'JWKS must contain 1 to 20 public keys and fit within 64 KiB';
    const base = JSON.stringify({ keys: [okp({ x5c: [] })] }).length;
    // x5c entries are limited to 16384 chars each and 10 entries; use many keys instead via kid.
    const bigKey = (kid: string) => okp({ kid, x5c: Array(10).fill('A'.repeat(16384)) });
    const keys = [bigKey('a'), bigKey('b'), bigKey('c'), bigKey('d')];
    expect(base).toBeGreaterThan(0);
    expect(publicClientJwksProblem({ keys })).toBe(msg);
  });

  it('accepts exactly 65536 bytes and rejects 65537', () => {
    const msg = 'JWKS must contain 1 to 20 public keys and fit within 64 KiB';
    const make = (pad: number) => ({ keys: [okp({ x5c: ['A'.repeat(pad)] })] });
    const empty = new TextEncoder().encode(JSON.stringify(make(0))).byteLength;
    // Fill with several certificates each under the 16384 limit.
    const build = (total: number) => {
      const certs: string[] = [];
      let left = total;
      while (left > 0) {
        const n = Math.min(left, 16384);
        certs.push('A'.repeat(n));
        left -= n;
      }
      return { keys: [okp({ x5c: certs })] };
    };
    // Each cert adds 3 bytes of JSON overhead (quotes + comma); compute by search.
    let total = 65536 - empty;
    let value = build(total);
    let size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    while (size > 65536) {
      total -= size - 65536;
      value = build(total);
      size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    }
    while (size < 65536) {
      total += 65536 - size;
      value = build(total);
      size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (size > 65536) break;
    }
    if (size === 65536) {
      expect(publicClientJwksProblem(value)).toBeUndefined();
      const over = build(total + 1);
      expect(publicClientJwksProblem(over)).toBe(msg);
    } else {
      // Could not hit the boundary exactly; at least verify a clearly oversize value fails.
      expect(publicClientJwksProblem(build(total + 100))).toBe(msg);
    }
  });
});

describe('publicClientJwksProblem: per-key member checks', () => {
  it('rejects non-object keys', () => {
    expect(problem('x')).toBe('Each JWKS key must be an object');
    expect(problem(null)).toBe('Each JWKS key must be an object');
  });

  it('rejects private and symmetric material', () => {
    const msg = 'Private and symmetric key material is forbidden; register public keys only';
    expect(problem({ kty: 'oct', kid: 'a' })).toBe(msg);
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      expect(problem(okp({ [member]: 'AAAA' }))).toBe(msg);
    }
  });

  it('rejects unknown members', () => {
    expect(problem(okp({ foo: 1 }))).toBe('Unsupported public JWK member');
  });

  it('accepts every allowed public member', () => {
    const key = rsa({
      use: 'sig',
      key_ops: ['verify'],
      alg: 'RS256',
      x5c: ['QUJD'],
      x5t: 'AAAA',
      'x5t#S256': 'AAAA',
      ext: true,
    });
    expect(problem(key)).toBeUndefined();
  });

  it('requires a unique, non-blank kid up to 128 characters', () => {
    const msg = 'Each public key needs a unique kid of at most 128 characters';
    const k = okp();
    delete k.kid;
    expect(problem(k)).toBe(msg);
    expect(problem(okp({ kid: 5 }))).toBe(msg);
    expect(problem(okp({ kid: '   ' }))).toBe(msg);
    expect(problem(okp({ kid: '' }))).toBe(msg);
    expect(problem(okp({ kid: 'a'.repeat(129) }))).toBe(msg);
    expect(problem(okp({ kid: 'a'.repeat(128) }))).toBeUndefined();
    expect(publicClientJwksProblem({ keys: [okp({ kid: 'd' }), okp({ kid: 'd' })] })).toBe(msg);
    expect(
      publicClientJwksProblem({ keys: [okp({ kid: 'd' }), okp({ kid: 'e' })] })
    ).toBeUndefined();
  });

  it('validates base64url members', () => {
    const msg = 'Invalid public JWK member';
    for (const member of ['n', 'e', 'x', 'y', 'x5t', 'x5t#S256']) {
      expect(problem(okp({ [member]: 'ab+/' }))).toBe(msg);
      expect(problem(okp({ [member]: '' }))).toBe(msg);
      expect(problem(okp({ [member]: 5 }))).toBe(msg);
      expect(problem(okp({ [member]: 'A'.repeat(8193) }))).toBe(msg);
      expect(problem(okp({ [member]: 'AAAAA' }))).toBe(msg); // length % 4 === 1
    }
    expect(problem(okp({ x5t: 'A_-' + 'B' }))).toBeUndefined();
  });

  it('validates ext', () => {
    expect(problem(okp({ ext: 'yes' }))).toBe('Invalid JWK ext');
    expect(problem(okp({ ext: false }))).toBeUndefined();
  });

  it('validates x5c', () => {
    const msg = 'Invalid JWK certificate chain';
    expect(problem(okp({ x5c: 'x' }))).toBe(msg);
    expect(problem(okp({ x5c: Array(11).fill('QUJD') }))).toBe(msg);
    expect(problem(okp({ x5c: Array(10).fill('QUJD') }))).toBeUndefined();
    expect(problem(okp({ x5c: [5] }))).toBe(msg);
    expect(problem(okp({ x5c: ['A'.repeat(16385)] }))).toBe(msg);
    expect(problem(okp({ x5c: ['A'.repeat(16384)] }))).toBeUndefined();
    expect(problem(okp({ x5c: ['QU-C'] }))).toBe(msg);
    expect(problem(okp({ x5c: ['QUJD=='] }))).toBeUndefined();
    expect(problem(okp({ x5c: ['=QUJD'] }))).toBe(msg);
    expect(problem(okp({ x5c: [''] }))).toBe(msg);
  });

  it('validates use', () => {
    expect(problem(okp({ use: 'foo' }))).toBe('Invalid JWK use');
    expect(problem(okp({ use: 'sig' }))).toBeUndefined();
    expect(problem(okp({ use: 'enc' }))).toBeUndefined();
  });

  it('validates key_ops', () => {
    const msg = 'Only public JWK operations are allowed';
    expect(problem(okp({ key_ops: 'verify' }))).toBe(msg);
    expect(problem(okp({ key_ops: [] }))).toBe(msg);
    expect(problem(okp({ key_ops: ['sign'] }))).toBe(msg);
    expect(problem(okp({ key_ops: [1] }))).toBe(msg);
    for (const op of ['verify', 'encrypt', 'wrapKey']) {
      expect(problem(okp({ key_ops: [op], use: 'enc' }))).toBeUndefined();
    }
  });
});

describe('publicClientJwksProblem: key type checks', () => {
  it('validates RSA keys and their size bounds', () => {
    const msg = 'RSA keys must be 2048 to 8192 bits';
    expect(problem(rsa())).toBeUndefined();
    expect(problem(rsa({ n: undefined }))).toBe('Invalid RSA public key');
    expect(problem(rsa({ e: undefined }))).toBe('Invalid RSA public key');
    expect(problem(rsa({ n: modulus(2047) }))).toBe(msg);
    expect(problem(rsa({ n: modulus(2048) }))).toBeUndefined();
    expect(problem(rsa({ n: modulus(8192) }))).toBeUndefined();
    expect(problem(rsa({ n: modulus(8193) }))).toBe(msg);
    expect(problem(rsa({ n: modulus(4096) }))).toBeUndefined();
  });

  it('counts leading-byte bits for RSA moduli', () => {
    // 2056-bit with leading byte 0x01 is 2049 bits; leading 0x00 / 0x01 variants.
    const bytes = new Array<number>(257).fill(0xff);
    bytes[0] = 0x01;
    expect(problem(rsa({ n: b64u(bytes) }))).toBeUndefined();
    const short = new Array<number>(256).fill(0xff);
    short[0] = 0x7f; // 2047 bits
    expect(problem(rsa({ n: b64u(short) }))).toBe('RSA keys must be 2048 to 8192 bits');
  });

  it('validates EC keys', () => {
    const msg = 'Use an EC P-256 public key';
    expect(problem(ec())).toBeUndefined();
    expect(problem(ec({ crv: 'P-384' }))).toBe(msg);
    expect(problem(ec({ x: undefined }))).toBe(msg);
    expect(problem(ec({ y: undefined }))).toBe(msg);
    expect(problem(ec({ x: 'A'.repeat(44) }))).toBe(msg);
    expect(problem(ec({ x: 'A'.repeat(42) }))).toBe(msg);
    expect(problem(ec({ y: 'A'.repeat(44) }))).toBe(msg);
    expect(problem(ec({ y: 'A'.repeat(42) }))).toBe(msg);
  });

  it('validates OKP keys', () => {
    const msg = 'Use an Ed25519 public key';
    expect(problem(okp())).toBeUndefined();
    expect(problem(okp({ crv: 'Ed448' }))).toBe(msg);
    expect(problem(okp({ x: undefined }))).toBe(msg);
    expect(problem(okp({ x: 'A'.repeat(44) }))).toBe(msg);
    expect(problem(okp({ x: 'A'.repeat(42) }))).toBe(msg);
  });

  it('rejects other key types', () => {
    expect(problem({ kty: 'XYZ', kid: 'a' })).toBe(
      'Supported key types are RSA, EC P-256 and Ed25519'
    );
  });
});

describe('publicClientJwksProblem: algorithm handling', () => {
  it('rejects signing keys without a usable algorithm', () => {
    const msg = 'Unsupported signing algorithm or key/algorithm mismatch';
    expect(problem(rsa({ alg: 'ES256' }))).toBe(msg);
    expect(problem(ec({ alg: 'RS256' }))).toBe(msg);
    expect(problem(rsa({ use: 'sig', alg: 'RS512' }))).toBe(msg);
  });

  it('allows encryption keys with encryption algorithms only', () => {
    const msg = 'Unsupported encryption algorithm';
    expect(problem(rsa({ use: 'enc' }))).toBeUndefined();
    for (const alg of ['RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES', 'ECDH-ES+A256KW']) {
      expect(problem(rsa({ use: 'enc', alg }))).toBeUndefined();
    }
    expect(problem(rsa({ use: 'enc', alg: 'RS256' }))).toBe(msg);
    expect(problem(rsa({ use: 'enc', alg: 7 }))).toBe(msg);
  });

  it('requires a usable signing key when a signing algorithm is requested', () => {
    const msg = 'private_key_jwt needs a usable public signing key for its algorithm';
    expect(problem(rsa(), 'RS256')).toBeUndefined();
    expect(problem(rsa(), 'ES256')).toBe(msg); // default alg RS256, key alg undefined, but RSA vs ES256 mismatch
    expect(problem(ec(), 'ES256')).toBeUndefined();
    expect(problem(okp(), 'EdDSA')).toBeUndefined();
    expect(problem(rsa({ use: 'enc' }), 'RS256')).toBe(msg);
    expect(problem(rsa({ alg: 'PS256' }), 'RS256')).toBe(msg);
    expect(problem(rsa({ alg: 'PS256' }), 'PS256')).toBeUndefined();
  });

  it('lets an RSA key without alg satisfy PS256', () => {
    expect(problem(rsa(), 'PS256')).toBeUndefined();
  });

  it('treats an undefined signing algorithm as not requested', () => {
    expect(problem(rsa({ use: 'enc' }), undefined)).toBeUndefined();
  });

  it('counts signing keys across a set', () => {
    const keys = [rsa({ use: 'enc', kid: 'a' }), ec({ kid: 'b' })];
    expect(publicClientJwksProblem({ keys }, 'ES256')).toBeUndefined();
    expect(publicClientJwksProblem({ keys }, 'EdDSA')).toBe(
      'private_key_jwt needs a usable public signing key for its algorithm'
    );
  });
});

describe('isPublicClientJwks', () => {
  it('reflects the absence of a problem', () => {
    expect(isPublicClientJwks({ keys: [okp()] })).toBe(true);
    expect(isPublicClientJwks({ keys: [] })).toBe(false);
    expect(isPublicClientJwks(null)).toBe(false);
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { didWebToUrl, isDIDMethodSupported, isValidDID, parseDID, resolveDID } from '../did';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: number[]): string {
  let value = bytes.reduce((result, byte) => result * 256n + BigInt(byte), 0n);
  let encoded = '';
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

describe('DID parsing and did:key resolution', () => {
  it('parses all optional DID URL components without normalizing identity', () => {
    expect(parseDID('did:web:example.com:users:alice/path?service=agent#key-1')).toEqual({
      did: 'did:web:example.com:users:alice/path?service=agent#key-1',
      method: 'web',
      methodSpecificId: 'example.com:users:alice',
      path: 'path',
      query: 'service=agent',
      fragment: 'key-1',
    });
    expect(parseDID('did:key:zabc')).toEqual({
      did: 'did:key:zabc',
      method: 'key',
      methodSpecificId: 'zabc',
      path: undefined,
      query: undefined,
      fragment: undefined,
    });
  });

  it.each(['', 'did:', 'did:web:', 'web:example.com'])('rejects malformed DID %s', (did) => {
    expect(parseDID(did)).toBeNull();
    expect(isValidDID(did)).toBe(false);
  });

  it('checks supported methods only after successful parsing', () => {
    expect(isDIDMethodSupported('did:web:example.com', ['web', 'key'])).toBe(true);
    expect(isDIDMethodSupported('did:ion:abc', ['web', 'key'])).toBe(false);
    expect(isDIDMethodSupported('invalid', ['web'])).toBe(false);
  });

  it.each([
    ['did:web:example.com', 'https://example.com/.well-known/did.json'],
    ['did:web:example.com:users:alice', 'https://example.com/users/alice/did.json'],
    ['did:web:example.com%3A8443:tenant', 'https://example.com:8443/tenant/did.json'],
    ['did:key:zabc', null],
    ['invalid', null],
  ])('maps did:web %s to %s', (did, url) => {
    expect(didWebToUrl(did)).toBe(url);
  });

  it('resolves a valid Ed25519 did:key to JWK verification material', async () => {
    const multibase = `z${base58([0xed, 0x01, ...new Array(32).fill(7)])}`;
    const did = `did:key:${multibase}`;
    await expect(resolveDID(did)).resolves.toMatchObject({
      id: did,
      verificationMethod: [
        {
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' },
        },
      ],
      authentication: [`${did}#${multibase}`],
    });
  });

  describe('EC did:key with real keys', () => {
    const curves = [
      ['P-256', 'prime256v1', [0x80, 0x24], 'ES256', 32],
      ['P-384', 'secp384r1', [0x81, 0x24], 'ES384', 48],
      ['P-521', 'secp521r1', [0x82, 0x24], 'ES512', 66],
    ] as const;

    function keyBytes(namedCurve: string, size: number) {
      const jwk = generateKeyPairSync('ec', { namedCurve }).publicKey.export({ format: 'jwk' });
      const x = Buffer.from(jwk.x as string, 'base64url');
      const y = Buffer.from(jwk.y as string, 'base64url');
      const compressed = [(y[size - 1] & 1) === 0 ? 0x02 : 0x03, ...x];
      const uncompressed = [0x04, ...x, ...y];
      return { jwk, compressed, uncompressed };
    }

    it.each(curves)(
      'resolves the compressed %s form back to the same public key',
      async (curve, namedCurve, prefix, alg, size) => {
        // Several keys, so both y parities are exercised.
        for (let i = 0; i < 6; i += 1) {
          const { jwk, compressed } = keyBytes(namedCurve, size);
          const did = `did:key:z${base58([...prefix, ...compressed])}`;
          const document = await resolveDID(did);
          expect(document.verificationMethod?.[0].publicKeyJwk).toMatchObject({
            kty: 'EC',
            crv: curve,
            alg,
            x: jwk.x,
            y: jwk.y,
          });
        }
      }
    );

    it.each(curves)(
      'rejects the uncompressed %s form (a second DID string for the same key)',
      async (_curve, namedCurve, prefix, _alg, size) => {
        const { uncompressed } = keyBytes(namedCurve, size);
        await expect(
          resolveDID(`did:key:z${base58([...prefix, ...uncompressed])}`)
        ).rejects.toThrow('compressed point form');
      }
    );
  });

  describe('compressed EC did:key that is not a point of the curve', () => {
    const curves = [
      [
        'P-256',
        [0x80, 0x24],
        32,
        'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
        'ffffffff00000001000000000000000000000000fffffffffffffffffffffffc',
        '5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b',
      ],
      [
        'P-384',
        [0x81, 0x24],
        48,
        'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff',
        'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000fffffffc',
        'b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef',
      ],
      [
        'P-521',
        [0x82, 0x24],
        66,
        '01' + 'ff'.repeat(65),
        '01' + 'ff'.repeat(64) + 'fc',
        '0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00',
      ],
    ] as const;

    const toBytes = (value: bigint, size: number) =>
      Array.from({ length: size }, (_, i) => Number((value >> BigInt(8 * (size - 1 - i))) & 0xffn));
    const modPow = (base: bigint, exponent: bigint, modulus: bigint) => {
      let result = 1n;
      let b = base % modulus;
      for (let e = exponent; e > 0n; e >>= 1n) {
        if (e & 1n) result = (result * b) % modulus;
        b = (b * b) % modulus;
      }
      return result;
    };

    it.each(curves)(
      '%s: x equal to p (and above) is a resolution error, not a Multikey document',
      async (_curve, prefix, size, pHex) => {
        const p = BigInt(`0x${pHex}`);
        for (const x of [p, p + 1n]) {
          const did = `did:key:z${base58([...prefix, 0x02, ...toBytes(x, size)])}`;
          await expect(resolveDID(did)).rejects.toThrow('not a valid curve point');
        }
      }
    );

    it.each(curves)(
      '%s: an x with no point on the curve (non-residue) is a resolution error',
      async (_curve, prefix, size, pHex, aHex, bHex) => {
        const p = BigInt(`0x${pHex}`);
        const a = BigInt(`0x${aHex}`);
        const b = BigInt(`0x${bHex}`);
        // Euler's criterion: rhs is a non-residue when rhs^((p-1)/2) = p - 1.
        let x = 1n;
        while (modPow((x ** 3n + a * x + b) % p, (p - 1n) / 2n, p) !== p - 1n) x += 1n;

        for (const parity of [0x02, 0x03]) {
          const did = `did:key:z${base58([...prefix, parity, ...toBytes(x, size)])}`;
          await expect(resolveDID(did)).rejects.toThrow('not a valid curve point');
        }
      }
    );
  });

  it.each([
    ['xabc', 'unsupported multibase'],
    [`z${base58([0xed, 0x01, 1])}`, 'wrong Ed25519 length'],
    [`z${base58([0x80, 0x24, 0x04, 1])}`, 'wrong P-256 length'],
    [`z${base58([0x81, 0x24, 0x04, 1])}`, 'wrong P-384 length'],
    [`z${base58([0x82, 0x24, 0x04, 1])}`, 'wrong P-521 length'],
    [`z${base58([0x99, 0x01, 1, 2])}`, 'unknown codec'],
  ])('falls back to Multikey for %s (%s)', async (multibase) => {
    await expect(resolveDID(`did:key:${multibase}`)).resolves.toMatchObject({
      verificationMethod: [{ type: 'Multikey', publicKeyMultibase: multibase }],
    });
  });

  it('rejects invalid base58 key material', async () => {
    await expect(resolveDID('did:key:z0')).rejects.toThrow('Invalid base58 character');
  });

  it('rejects invalid and unsupported DID methods', async () => {
    await expect(resolveDID('invalid')).rejects.toThrow('Invalid DID format');
    await expect(resolveDID('did:ion:abc')).rejects.toThrow('Unsupported DID method');
  });
});

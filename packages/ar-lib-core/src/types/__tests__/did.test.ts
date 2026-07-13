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

  it.each([
    [0x80, 0x24, 65, 'P-256', 'ES256'],
    [0x81, 0x24, 97, 'P-384', 'ES384'],
    [0x82, 0x24, 133, 'P-521', 'ES512'],
  ])('resolves uncompressed multicodec %#/%#', async (first, second, length, curve, alg) => {
    const key = [first, second, 0x04, ...new Array(length - 1).fill(1)];
    const multibase = `z${base58(key)}`;
    await expect(resolveDID(`did:key:${multibase}`)).resolves.toMatchObject({
      verificationMethod: [
        {
          type: 'JsonWebKey2020',
          publicKeyJwk: { kty: 'EC', crv: curve, alg, use: 'sig' },
        },
      ],
    });
  });

  it('decompresses a syntactically valid compressed P-256 point', async () => {
    const multibase = `z${base58([0x80, 0x24, 0x02, ...new Array(32).fill(1)])}`;
    await expect(resolveDID(`did:key:${multibase}`)).resolves.toMatchObject({
      verificationMethod: [
        { publicKeyJwk: { kty: 'EC', crv: 'P-256', x: expect.any(String), y: expect.any(String) } },
      ],
    });
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

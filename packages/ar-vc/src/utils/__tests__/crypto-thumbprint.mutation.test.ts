/**
 * Crypto helpers and JWK thumbprints against independent computations and published vectors.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateRandomString,
  generateSecureNonce,
  hashTransactionCode,
  hmacSha256Base64url,
  sha256Base64url,
} from '../crypto';
import { calculateJwkThumbprint } from '../jwk-thumbprint';

afterEach(() => {
  vi.restoreAllMocks();
});

function fillWith(bytes: number[]) {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    array.set(bytes.slice(0, array.length));
    return array;
  }) as never);
}

const urlSafe = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return urlSafe(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
  );
}

const SECRET = 's'.repeat(32);

describe('random values', () => {
  it('writes every byte of the nonce as two hex digits', async () => {
    fillWith([0x0a, 0x00, 0xff, 0x10]);
    expect(await generateSecureNonce(4)).toBe('0a00ff10');
  });

  it('defaults to 32 random bytes', async () => {
    expect(await generateSecureNonce()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encodes random strings as url-safe base64 without padding', () => {
    fillWith([0xfb, 0xef, 0xff]);
    expect(generateRandomString(3)).toBe('--__');
    for (const length of [1, 2, 31, 32]) {
      expect(generateRandomString(length)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(generateRandomString(1)).toHaveLength(2);
    expect(generateRandomString(2)).toHaveLength(3);
    expect(generateRandomString()).toHaveLength(43);
  });
});

describe('sha256Base64url', () => {
  it('matches published digests, url-safe and unpadded', async () => {
    expect(await sha256Base64url('')).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    expect(await sha256Base64url('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('transaction code HMAC', () => {
  it('equals an independent HMAC-SHA256 in url-safe base64', async () => {
    for (const data of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(await hmacSha256Base64url(SECRET, data)).toBe(await hmac(SECRET, data));
    }
  });

  it('reaches both url-safe substitutions', async () => {
    const seen = new Set<string>();
    for (let index = 0; index < 300; index += 1) {
      const value = await hmacSha256Base64url(SECRET, `data-${index}`);
      expect(value).toBe(await hmac(SECRET, `data-${index}`));
      if (value.includes('-')) seen.add('-');
      if (value.includes('_')) seen.add('_');
    }
    expect([...seen].sort()).toEqual(['-', '_']);
  });

  it('demands a secret of at least 32 bytes', async () => {
    const message = 'VC transaction-code HMAC secret must contain at least 32 bytes';
    await expect(hmacSha256Base64url(undefined, 'x')).rejects.toThrow(message);
    await expect(hmacSha256Base64url('s'.repeat(31), 'x')).rejects.toThrow(message);
    await expect(hmacSha256Base64url('é'.repeat(15), 'x')).rejects.toThrow(message);
    await expect(hmacSha256Base64url('é'.repeat(16), 'x')).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(hmacSha256Base64url(SECRET, 'x')).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('binds a code to tenant, offer and secret with NUL separators', async () => {
    expect(await hashTransactionCode(SECRET, 'tenant', 'offer', '123456')).toBe(
      await hmac(SECRET, 'tenant\u0000offer\u0000123456')
    );
    const base = await hashTransactionCode(SECRET, 'tenant', 'offer', '123456');
    expect(await hashTransactionCode(SECRET, 'tenant', 'offer', '123457')).not.toBe(base);
    expect(await hashTransactionCode(SECRET, 'tenan', 'toffer', '123456')).not.toBe(base);
    expect(await hashTransactionCode('t'.repeat(32), 'tenant', 'offer', '123456')).not.toBe(base);
  });
});

describe('calculateJwkThumbprint', () => {
  it('matches the RFC 7638 RSA example', async () => {
    expect(
      await calculateJwkThumbprint({
        kty: 'RSA',
        n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
        e: 'AQAB',
      })
    ).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('matches the RFC 8037 Ed25519 example and ignores extra members', async () => {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    expect(await calculateJwkThumbprint(jwk)).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
    expect(await calculateJwkThumbprint({ ...jwk, y: 'ignored', n: 'ignored' })).toBe(
      'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k'
    );
  });

  it('hashes the EC members in lexicographic order', async () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' };
    const expected = urlSafe(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode('{"crv":"P-256","kty":"EC","x":"AAA","y":"BBB"}')
        )
      )
    );
    expect(await calculateJwkThumbprint(jwk)).toBe(expected);
  });

  it('refuses unsupported key types and missing or empty members', async () => {
    await expect(calculateJwkThumbprint({ kty: 'oct' })).rejects.toThrow('unsupported_jwk_type');
    await expect(calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: 'a' })).rejects.toThrow(
      'invalid_jwk'
    );
    await expect(
      calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: 'a', y: '' })
    ).rejects.toThrow('invalid_jwk');
    await expect(calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519' })).rejects.toThrow(
      'invalid_jwk'
    );
    await expect(calculateJwkThumbprint({ kty: 'OKP', crv: '', x: 'a' })).rejects.toThrow(
      'invalid_jwk'
    );
    await expect(calculateJwkThumbprint({ kty: 'RSA', n: 'n' })).rejects.toThrow('invalid_jwk');
  });
});

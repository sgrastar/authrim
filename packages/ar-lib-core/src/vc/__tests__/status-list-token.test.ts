/**
 * Token Status List reading (draft-14): token checks, bit layout, format separation and caching.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';
import {
  checkCredentialStatus,
  clearAllStatusListCaches,
  fetchDecodedStatusList,
  getCredentialStatusValue,
} from '../status-list';
import { encodeStatusListBytes, writeStatusEntry } from '../status-list-codec';

const mockSafeFetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.mock('../../utils/url-security', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  safeFetchJson: async (...args: unknown[]) => (await mockSafeFetch(...args)).json() as unknown,
  readResponseTextWithLimit: async (response: Response) => response.text(),
  isInternalUrl: () => false,
}));

const ISSUER = 'https://issuer.example.com/t1';
const URI = `${ISSUER}/vci/status-lists/list-1`;
const NOW_S = 1_800_000_000;

describe('Token Status List reading', () => {
  let privateKey: CryptoKey;
  let publicJwk: JWK;
  const keyResolver = async () => publicJwk;

  async function tslList(entries: Record<number, number> = {}, bits = 2): Promise<string> {
    const bytes = new Uint8Array(64);
    for (const [index, value] of Object.entries(entries)) {
      writeStatusEntry(bytes, Number(index), bits, 'lsb', value);
    }
    return encodeStatusListBytes(bytes, 'ietf_tsl_v1');
  }

  async function token(
    overrides: {
      header?: Record<string, unknown>;
      payload?: Record<string, unknown>;
      lst?: string;
    } = {}
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      iss: ISSUER,
      sub: URI,
      iat: NOW_S,
      exp: NOW_S + 86400,
      ttl: 300,
      status_list: { bits: 2, lst: overrides.lst ?? (await tslList({ 1: 1, 2: 2 })) },
      ...overrides.payload,
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', typ: 'statuslist+jwt', kid: 'k1', ...overrides.header })
      .sign(privateKey);
  }

  function serve(jwt: string, contentType = 'application/statuslist+jwt') {
    mockSafeFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': contentType }),
      text: async () => jwt,
    });
  }

  const options = { format: 'ietf_tsl_v1' as const, expectedIssuer: ISSUER, keyResolver };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearAllStatusListCaches();
    vi.useFakeTimers({ now: NOW_S * 1000 });
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads status 0, 1 and 2 from a verified token', async () => {
    serve(await token());
    expect(await getCredentialStatusValue(URI, 0, options)).toBe(0);
    expect(await getCredentialStatusValue(URI, 1, options)).toBe(1);
    expect(await getCredentialStatusValue(URI, 2, options)).toBe(2);
    expect(await checkCredentialStatus(URI, 0, options)).toBe(true);
    // Only status 0 is valid: invalid (1) and suspended (2) are both refused.
    expect(await checkCredentialStatus(URI, 1, options)).toBe(false);
    expect(await checkCredentialStatus(URI, 2, options)).toBe(false);
  });

  it('carries bits, issuer, subject and expiry with the decoded list', async () => {
    serve(await token());
    expect(await fetchDecodedStatusList(URI, options)).toMatchObject({
      format: 'ietf_tsl_v1',
      bits: 2,
      issuer: ISSUER,
      subject: URI,
      expiresAtMs: (NOW_S + 86400) * 1000,
      ttlMs: 300_000,
    });
  });

  it('does not treat the HTTP content type as a substitute for the token checks', async () => {
    serve(await token({ header: { typ: 'JWT' } }), 'application/statuslist+jwt');
    await expect(getCredentialStatusValue(URI, 0, options)).rejects.toThrow('type mismatch');
    clearAllStatusListCaches();
    serve(await token(), 'text/plain');
    expect(await getCredentialStatusValue(URI, 0, options)).toBe(0);
  });

  it('treats a W3C-format response as an error when the credential declared a Token Status List', async () => {
    mockSafeFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ credentialSubject: { encodedList: 'AAAA' } }),
    });
    await expect(getCredentialStatusValue(URI, 0, options)).rejects.toThrow();
  });

  it.each([
    ['a sub that is not the referenced URI', { payload: { sub: `${URI}-other` } }, 'subject'],
    ['a missing sub', { payload: { sub: undefined } }, 'subject'],
    ['a missing iat', { payload: { iat: undefined } }, 'iat'],
    ['a string iat', { payload: { iat: 'now' } }, 'iat'],
    ['a zero ttl', { payload: { ttl: 0 } }, 'ttl'],
    ['a negative ttl', { payload: { ttl: -5 } }, 'ttl'],
    ['a string ttl', { payload: { ttl: '300' } }, 'ttl'],
    ['bits 3', { payload: { status_list: { bits: 3, lst: 'x' } } }, 'status_list'],
    ['a missing status_list', { payload: { status_list: undefined } }, 'status_list'],
    ['a non-string lst', { payload: { status_list: { bits: 2, lst: 1 } } }, 'status_list'],
    ['a different issuer', { payload: { iss: 'https://evil.example.net' } }, 'issuer'],
    ['a missing issuer', { payload: { iss: undefined } }, 'issuer'],
    ['an expired token', { payload: { exp: NOW_S - 10 } }, 'expired'],
  ])('rejects %s', async (_label, overrides, message) => {
    serve(await token(overrides));
    await expect(getCredentialStatusValue(URI, 0, options)).rejects.toThrow(message);
  });

  it('rejects a gzip-compressed list (unknown compression for this format)', async () => {
    const gzip = await encodeStatusListBytes(new Uint8Array(64), 'w3c_bitstring_v1');
    serve(await token({ lst: gzip }));
    await expect(getCredentialStatusValue(URI, 0, options)).rejects.toThrow('compression');
  });

  it('rejects a token signed by another key', async () => {
    serve(await token());
    const other = await generateKeyPair('ES256', { extractable: true });
    await expect(
      getCredentialStatusValue(URI, 0, {
        ...options,
        keyResolver: async () => exportJWK(other.publicKey),
      })
    ).rejects.toThrow('signature verification failed');
  });

  it('treats an index outside the list as invalid', async () => {
    serve(await token());
    // 64 bytes at 2 bits = 256 entries
    expect(await checkCredentialStatus(URI, 255, options)).toBe(true);
    expect(await checkCredentialStatus(URI, 256, options)).toBe(false);
    await expect(getCredentialStatusValue(URI, 256, options)).rejects.toThrow('out of bounds');
  });

  describe('cache', () => {
    it('serves a second read from the cache', async () => {
      serve(await token());
      await getCredentialStatusValue(URI, 0, options);
      await getCredentialStatusValue(URI, 1, options);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    });

    it('re-checks the expected issuer on every cache hit', async () => {
      serve(await token());
      await getCredentialStatusValue(URI, 0, options);
      await expect(
        getCredentialStatusValue(URI, 0, {
          ...options,
          expectedIssuer: 'https://other.example.com',
        })
      ).rejects.toThrow('issuer');
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps formats apart: a cached Token Status List never answers a W3C read', async () => {
      const legacyEncodedList = await encodeStatusListBytes(new Uint8Array(4), 'w3c_bitstring_v1');
      serve(await token());
      await getCredentialStatusValue(URI, 0, options);
      mockSafeFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ credentialSubject: { encodedList: legacyEncodedList } }),
      });
      await getCredentialStatusValue(URI, 0, { verifySignature: false });
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('never answers a verified read from an entry cached without verification', async () => {
      serve(await token());
      await getCredentialStatusValue(URI, 0, { ...options, verifySignature: false });
      await getCredentialStatusValue(URI, 0, options);
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('expires after the token ttl', async () => {
      serve(await token({ payload: { ttl: 60 } }));
      await getCredentialStatusValue(URI, 0, options);
      vi.setSystemTime((NOW_S + 59) * 1000);
      await getCredentialStatusValue(URI, 0, options);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
      vi.setSystemTime((NOW_S + 61) * 1000);
      await getCredentialStatusValue(URI, 0, options);
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('expires at the token exp when that comes before the ttl', async () => {
      serve(await token({ payload: { ttl: 3000, exp: NOW_S + 30 } }));
      await getCredentialStatusValue(URI, 0, { ...options, cacheTtlMs: 3_600_000 });
      vi.setSystemTime((NOW_S + 31) * 1000);
      serve(await token({ payload: { iat: NOW_S + 31, exp: NOW_S + 400, ttl: 300 } }));
      await getCredentialStatusValue(URI, 0, { ...options, cacheTtlMs: 3_600_000 });
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * Status List 2021 Tests
 *
 * Tests for credential status verification using Status List 2021.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { JWK } from 'jose';
import {
  fetchStatusList,
  getStatusAtIndex,
  checkCredentialStatus,
  clearStatusListCache,
  clearAllStatusListCaches,
  StatusValue,
} from '../status-list';
import type { StatusListKeyResolver } from '../status-list';

// Mock safeFetch from url-security module
const mockSafeFetch = vi.fn();
vi.mock('../../utils/url-security', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  isInternalUrl: () => false,
}));

describe('Status List 2021', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStatusListCache();
  });

  afterEach(() => {
    clearStatusListCache();
  });

  describe('getStatusAtIndex', () => {
    it('should get status at index with 1 bit per status', () => {
      // Bitstring: 10110000 (0xB0) - indexes 0,2,3 are revoked
      const bitstring = new Uint8Array([0b10110000]);

      expect(getStatusAtIndex(bitstring, 0, 1)).toBe(1); // revoked
      expect(getStatusAtIndex(bitstring, 1, 1)).toBe(0); // valid
      expect(getStatusAtIndex(bitstring, 2, 1)).toBe(1); // revoked
      expect(getStatusAtIndex(bitstring, 3, 1)).toBe(1); // revoked
      expect(getStatusAtIndex(bitstring, 4, 1)).toBe(0); // valid
      expect(getStatusAtIndex(bitstring, 5, 1)).toBe(0); // valid
      expect(getStatusAtIndex(bitstring, 6, 1)).toBe(0); // valid
      expect(getStatusAtIndex(bitstring, 7, 1)).toBe(0); // valid
    });

    it('should get status at index with 2 bits per status', () => {
      // Bitstring: 01 10 00 11 (0x63) - 4 statuses per byte
      const bitstring = new Uint8Array([0b01100011]);

      expect(getStatusAtIndex(bitstring, 0, 2)).toBe(0b01); // status 1
      expect(getStatusAtIndex(bitstring, 1, 2)).toBe(0b10); // status 2
      expect(getStatusAtIndex(bitstring, 2, 2)).toBe(0b00); // status 0
      expect(getStatusAtIndex(bitstring, 3, 2)).toBe(0b11); // status 3
    });

    it('should handle multi-byte bitstrings', () => {
      // 2 bytes = 16 statuses with 1 bit each
      const bitstring = new Uint8Array([0b11111111, 0b00000000]);

      // First byte - all revoked
      for (let i = 0; i < 8; i++) {
        expect(getStatusAtIndex(bitstring, i, 1)).toBe(1);
      }

      // Second byte - all valid
      for (let i = 8; i < 16; i++) {
        expect(getStatusAtIndex(bitstring, i, 1)).toBe(0);
      }
    });

    it('should throw on out of bounds index', () => {
      const bitstring = new Uint8Array([0b10110000]);

      expect(() => getStatusAtIndex(bitstring, 8, 1)).toThrow('out of bounds');
      expect(() => getStatusAtIndex(bitstring, 100, 1)).toThrow('out of bounds');
    });

    it('should throw on invalid bitsPerStatus', () => {
      const bitstring = new Uint8Array([0b10110000]);

      expect(() => getStatusAtIndex(bitstring, 0, 3)).toThrow(
        'bitsPerStatus must be 1, 2, 4, or 8'
      );
      expect(() => getStatusAtIndex(bitstring, 0, 5)).toThrow(
        'bitsPerStatus must be 1, 2, 4, or 8'
      );
    });
  });

  describe('fetchStatusList', () => {
    it('should fetch and parse JSON-LD status list credential', async () => {
      // Create a simple uncompressed bitstring (for testing)
      const bitstring = new Uint8Array([0b10000000]); // First credential is revoked
      const encodedList = btoa(String.fromCharCode(...bitstring));

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          type: ['VerifiableCredential', 'StatusList2021Credential'],
          issuer: 'did:web:issuer.example',
          validFrom: '2024-01-01T00:00:00Z',
          credentialSubject: {
            id: 'https://issuer.example/status/1#list',
            type: 'StatusList2021',
            statusPurpose: 'revocation',
            encodedList,
          },
        }),
      });

      // JSON-LD format doesn't have JWT signature, so skip verification
      const result = await fetchStatusList('https://issuer.example/status/1', {
        verifySignature: false,
      });

      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://issuer.example/status/1',
        expect.objectContaining({
          headers: { Accept: 'application/statuslist+jwt, application/jwt' },
          requireHttps: true,
          timeoutMs: 10000,
        })
      );
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should cache status list results', async () => {
      const bitstring = new Uint8Array([0b00000000]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      mockSafeFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          credentialSubject: {
            type: 'StatusList2021',
            encodedList,
          },
        }),
      });

      // First fetch (skip JWT signature verification for JSON-LD)
      await fetchStatusList('https://issuer.example/status/1', { verifySignature: false });
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);

      // Second fetch - should use cache
      await fetchStatusList('https://issuer.example/status/1', { verifySignature: false });
      expect(mockSafeFetch).toHaveBeenCalledTimes(1); // Still 1

      // Force refresh
      await fetchStatusList('https://issuer.example/status/1', {
        forceRefresh: true,
        verifySignature: false,
      });
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw on HTTP error', async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        fetchStatusList('https://issuer.example/status/notfound', { verifySignature: false })
      ).rejects.toThrow('Failed to fetch status list: HTTP 404');
    });
  });

  describe('checkCredentialStatus', () => {
    it('should return true for valid (non-revoked) credential', async () => {
      // First bit is 0 (valid)
      const bitstring = new Uint8Array([0b01111111]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          credentialSubject: {
            type: 'StatusList2021',
            encodedList,
          },
        }),
      });

      // JSON-LD format - skip JWT signature verification
      const isValid = await checkCredentialStatus('https://issuer.example/status/1', 0, {
        verifySignature: false,
      });
      expect(isValid).toBe(true);
    });

    it('should return false for revoked credential', async () => {
      // First bit is 1 (revoked)
      const bitstring = new Uint8Array([0b10000000]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          credentialSubject: {
            type: 'StatusList2021',
            encodedList,
          },
        }),
      });

      // JSON-LD format - skip JWT signature verification
      const isValid = await checkCredentialStatus('https://issuer.example/status/1', 0, {
        verifySignature: false,
      });
      expect(isValid).toBe(false);
    });

    it('should check specific index in status list', async () => {
      // Indexes 0, 2, 4 are revoked (10101000)
      const bitstring = new Uint8Array([0b10101000]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      mockSafeFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          credentialSubject: {
            type: 'StatusList2021',
            encodedList,
          },
        }),
      });

      // Clear cache between each call (JSON-LD format, skip signature verification)
      clearStatusListCache();
      expect(
        await checkCredentialStatus('https://issuer.example/status/1', 0, {
          verifySignature: false,
        })
      ).toBe(false); // revoked

      clearStatusListCache();
      expect(
        await checkCredentialStatus('https://issuer.example/status/1', 1, {
          verifySignature: false,
        })
      ).toBe(true); // valid

      clearStatusListCache();
      expect(
        await checkCredentialStatus('https://issuer.example/status/1', 2, {
          verifySignature: false,
        })
      ).toBe(false); // revoked

      clearStatusListCache();
      expect(
        await checkCredentialStatus('https://issuer.example/status/1', 3, {
          verifySignature: false,
        })
      ).toBe(true); // valid
    });
  });

  describe('StatusValue enum', () => {
    it('should have correct values', () => {
      expect(StatusValue.VALID).toBe(0);
      expect(StatusValue.INVALID).toBe(1);
    });
  });

  describe('JWT Signature Verification', () => {
    /**
     * Helper: Create a signed Status List JWT
     */
    async function createStatusListJWT(
      bitstring: Uint8Array,
      keyPair: CryptoKeyPair,
      kid: string,
      issuer: string
    ): Promise<string> {
      const encodedList = btoa(String.fromCharCode(...bitstring));
      const publicJwk = await exportJWK(keyPair.publicKey);

      const jwt = await new SignJWT({
        iss: issuer,
        sub: `${issuer}/status/1`,
        vc: {
          '@context': [
            'https://www.w3.org/2018/credentials/v1',
            'https://w3id.org/vc/status-list/2021/v1',
          ],
          type: ['VerifiableCredential', 'BitstringStatusListCredential'],
          credentialSubject: {
            id: `${issuer}/status/1#list`,
            type: 'BitstringStatusList',
            statusPurpose: 'revocation',
            encodedList,
          },
        },
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'statuslist+jwt', kid })
        .sign(keyPair.privateKey);

      return jwt;
    }

    it('should verify valid JWT signature with custom key resolver', async () => {
      const keyPair = await generateKeyPair('ES256', { extractable: true });
      const publicJwk = await exportJWK(keyPair.publicKey);
      const issuer = 'https://issuer.example.com';

      // Create signed JWT with index 0 = valid (0b01111111)
      const bitstring = new Uint8Array([0b01111111]);
      const jwt = await createStatusListJWT(bitstring, keyPair, 'key-1', issuer);

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/statuslist+jwt' }),
        text: async () => jwt,
      });

      // Create key resolver that returns the public key
      const keyResolver: StatusListKeyResolver = async () => publicJwk;

      const isValid = await checkCredentialStatus(`${issuer}/status/1`, 0, {
        verifySignature: true,
        keyResolver,
      });

      expect(isValid).toBe(true);
    });

    it('should reject JWT with invalid signature', async () => {
      // Create two different key pairs
      const signingKeyPair = await generateKeyPair('ES256', { extractable: true });
      const wrongKeyPair = await generateKeyPair('ES256', { extractable: true });
      const wrongPublicJwk = await exportJWK(wrongKeyPair.publicKey);
      const issuer = 'https://issuer.example.com';

      // Sign with one key, verify with another
      const bitstring = new Uint8Array([0b01111111]);
      const jwt = await createStatusListJWT(bitstring, signingKeyPair, 'key-1', issuer);

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/statuslist+jwt' }),
        text: async () => jwt,
      });

      // Key resolver returns the WRONG public key
      const keyResolver: StatusListKeyResolver = async () => wrongPublicJwk;

      await expect(
        checkCredentialStatus(`${issuer}/status/1`, 0, {
          verifySignature: true,
          keyResolver,
        })
      ).rejects.toThrow('signature verification failed');
    });

    it('should skip signature verification when verifySignature=false', async () => {
      // Create an unsigned/invalid JWT (just structure, no valid signature)
      const bitstring = new Uint8Array([0b01111111]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      // Manually create a fake JWT without proper signature
      const header = btoa(JSON.stringify({ alg: 'ES256', typ: 'statuslist+jwt' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/[=]/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: 'https://issuer.example.com',
          vc: {
            credentialSubject: {
              encodedList,
            },
          },
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/[=]/g, '');
      const fakeJwt = `${header}.${payload}.INVALID_SIGNATURE`;

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/statuslist+jwt' }),
        text: async () => fakeJwt,
      });

      // Should work when signature verification is disabled
      const isValid = await checkCredentialStatus('https://issuer.example.com/status/1', 0, {
        verifySignature: false,
      });

      expect(isValid).toBe(true);
    });

    it('should reject JWT missing issuer claim', async () => {
      const keyPair = await generateKeyPair('ES256', { extractable: true });
      const bitstring = new Uint8Array([0b01111111]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      // Create JWT without iss or sub
      const jwt = await new SignJWT({
        vc: {
          credentialSubject: {
            encodedList,
          },
        },
      })
        .setProtectedHeader({ alg: 'ES256' })
        .sign(keyPair.privateKey);

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/statuslist+jwt' }),
        text: async () => jwt,
      });

      await expect(
        checkCredentialStatus('https://issuer.example.com/status/1', 0, {
          verifySignature: true,
        })
      ).rejects.toThrow('missing issuer');
    });

    it('should use IETF status_list format with signature verification', async () => {
      const keyPair = await generateKeyPair('ES256', { extractable: true });
      const publicJwk = await exportJWK(keyPair.publicKey);
      const issuer = 'https://issuer.example.com';

      // Create uncompressed bitstring (index 0 = valid)
      const bitstring = new Uint8Array([0b01111111]);
      const encodedList = btoa(String.fromCharCode(...bitstring))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/[=]/g, '');

      // Create JWT with IETF format (status_list.lst)
      const jwt = await new SignJWT({
        iss: issuer,
        sub: `${issuer}/status/1`,
        status_list: {
          bits: 1,
          lst: encodedList,
        },
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'statuslist+jwt', kid: 'key-1' })
        .sign(keyPair.privateKey);

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/statuslist+jwt' }),
        text: async () => jwt,
      });

      const keyResolver: StatusListKeyResolver = async () => publicJwk;

      const isValid = await checkCredentialStatus(`${issuer}/status/1`, 0, {
        verifySignature: true,
        keyResolver,
      });

      expect(isValid).toBe(true);
    });
  });

  describe('Cache Management', () => {
    it('should clear all caches with clearAllStatusListCaches', async () => {
      const bitstring = new Uint8Array([0b01111111]);
      const encodedList = btoa(String.fromCharCode(...bitstring));

      mockSafeFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          credentialSubject: {
            type: 'StatusList2021',
            encodedList,
          },
        }),
      });

      // First fetch (populates cache)
      await fetchStatusList('https://issuer.example/status/1', { verifySignature: false });
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);

      // Second fetch (should use cache)
      await fetchStatusList('https://issuer.example/status/1', { verifySignature: false });
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);

      // Clear all caches
      clearAllStatusListCaches();

      // Third fetch (should fetch again)
      await fetchStatusList('https://issuer.example/status/1', { verifySignature: false });
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });
  });
});

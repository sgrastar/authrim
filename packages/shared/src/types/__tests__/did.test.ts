/**
 * DID Utilities Tests
 *
 * Tests for DID parsing and validation utilities (Phase 9).
 */

import { describe, it, expect } from 'vitest';
import { parseDID, isValidDID, isDIDMethodSupported, didWebToUrl } from '../did';

describe('DID Utilities', () => {
  describe('parseDID', () => {
    it('should parse valid did:web', () => {
      const result = parseDID('did:web:example.com');

      expect(result).not.toBeNull();
      expect(result!.did).toBe('did:web:example.com');
      expect(result!.method).toBe('web');
      expect(result!.methodSpecificId).toBe('example.com');
    });

    it('should parse did:web with path', () => {
      const result = parseDID('did:web:example.com:users:alice');

      expect(result).not.toBeNull();
      expect(result!.method).toBe('web');
      expect(result!.methodSpecificId).toBe('example.com:users:alice');
    });

    it('should parse did:key', () => {
      const result = parseDID('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');

      expect(result).not.toBeNull();
      expect(result!.method).toBe('key');
      expect(result!.methodSpecificId).toBe('z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    });

    it('should parse DID with fragment', () => {
      const result = parseDID('did:web:example.com#key-1');

      expect(result).not.toBeNull();
      expect(result!.fragment).toBe('key-1');
    });

    it('should parse DID with query', () => {
      const result = parseDID('did:web:example.com?service=files');

      expect(result).not.toBeNull();
      expect(result!.query).toBe('service=files');
    });

    it('should parse DID with path, query and fragment', () => {
      const result = parseDID('did:web:example.com/path/to/doc?query=value#fragment');

      expect(result).not.toBeNull();
      expect(result!.path).toBe('path/to/doc');
      expect(result!.query).toBe('query=value');
      expect(result!.fragment).toBe('fragment');
    });

    it('should return null for invalid DID', () => {
      expect(parseDID('not-a-did')).toBeNull();
      expect(parseDID('')).toBeNull();
      expect(parseDID('did:')).toBeNull();
      expect(parseDID('did:web')).toBeNull();
    });

    it('should handle various DID methods', () => {
      expect(parseDID('did:ion:abc123')?.method).toBe('ion');
      expect(parseDID('did:ethr:0x123')?.method).toBe('ethr');
      expect(parseDID('did:pkh:eip155:1:0x123')?.method).toBe('pkh');
    });
  });

  describe('isValidDID', () => {
    it('should return true for valid DIDs', () => {
      expect(isValidDID('did:web:example.com')).toBe(true);
      expect(isValidDID('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe(true);
      expect(isValidDID('did:web:example.com#key-1')).toBe(true);
    });

    it('should return false for invalid DIDs', () => {
      expect(isValidDID('not-a-did')).toBe(false);
      expect(isValidDID('')).toBe(false);
      expect(isValidDID('did:')).toBe(false);
    });
  });

  describe('isDIDMethodSupported', () => {
    it('should return true for supported methods', () => {
      const supportedMethods = ['web', 'key'] as const;

      expect(isDIDMethodSupported('did:web:example.com', [...supportedMethods])).toBe(true);
      expect(isDIDMethodSupported('did:key:z6Mk...', [...supportedMethods])).toBe(true);
    });

    it('should return false for unsupported methods', () => {
      const supportedMethods = ['web', 'key'] as const;

      expect(isDIDMethodSupported('did:ion:abc', [...supportedMethods])).toBe(false);
      expect(isDIDMethodSupported('did:ethr:0x123', [...supportedMethods])).toBe(false);
    });

    it('should return false for invalid DIDs', () => {
      expect(isDIDMethodSupported('not-a-did', ['web', 'key'])).toBe(false);
    });
  });

  describe('didWebToUrl', () => {
    it('should convert simple did:web to URL', () => {
      const url = didWebToUrl('did:web:example.com');

      expect(url).toBe('https://example.com/.well-known/did.json');
    });

    it('should convert did:web with path to URL', () => {
      const url = didWebToUrl('did:web:example.com:users:alice');

      expect(url).toBe('https://example.com/users/alice/did.json');
    });

    it('should handle percent-encoded paths', () => {
      // Colons in path segments are percent-encoded
      const url = didWebToUrl('did:web:example.com:path%3Awith%3Acolons');

      // After decoding, colons become path separators
      expect(url).toBe('https://example.com/path/with/colons/did.json');
    });

    it('should handle subdomains', () => {
      const url = didWebToUrl('did:web:api.example.com');

      expect(url).toBe('https://api.example.com/.well-known/did.json');
    });

    it('should handle deep paths', () => {
      const url = didWebToUrl('did:web:example.com:a:b:c');

      expect(url).toBe('https://example.com/a/b/c/did.json');
    });

    it('should return null for non-web DIDs', () => {
      expect(didWebToUrl('did:key:z6Mk...')).toBeNull();
      expect(didWebToUrl('did:ion:abc')).toBeNull();
    });

    it('should return null for invalid DIDs', () => {
      expect(didWebToUrl('not-a-did')).toBeNull();
      expect(didWebToUrl('')).toBeNull();
    });
  });
});

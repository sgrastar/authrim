import { describe, it, expect } from 'vitest';
import {
  validateClientId,
  validateRedirectUri,
  validateScope,
  validateState,
  validateNonce,
  validateGrantType,
  validateResponseType,
  validateAuthCode,
  validateToken,
} from '../../src/utils/validation';

describe('Validation Utilities', () => {
  describe('validateClientId', () => {
    it('should accept valid client ID', () => {
      const result = validateClientId('test-client-123');
      expect(result.valid).toBe(true);
    });

    it('should accept client ID with underscores', () => {
      const result = validateClientId('test_client_123');
      expect(result.valid).toBe(true);
    });

    it('should reject missing client ID', () => {
      const result = validateClientId(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject empty client ID', () => {
      const result = validateClientId('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject client ID that is too long', () => {
      const result = validateClientId('a'.repeat(257));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject client ID with invalid characters', () => {
      const result = validateClientId('test@client');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });
  });

  describe('validateRedirectUri', () => {
    it('should accept valid HTTPS URL', () => {
      const result = validateRedirectUri('https://example.com/callback');
      expect(result.valid).toBe(true);
    });

    it('should accept localhost HTTP URL when allowed', () => {
      const result = validateRedirectUri('http://localhost:3000/callback', true);
      expect(result.valid).toBe(true);
    });

    it('should accept 127.0.0.1 HTTP URL when allowed', () => {
      const result = validateRedirectUri('http://127.0.0.1:3000/callback', true);
      expect(result.valid).toBe(true);
    });

    it('should reject missing redirect URI', () => {
      const result = validateRedirectUri(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject invalid URL', () => {
      const result = validateRedirectUri('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a valid URL');
    });

    it('should reject HTTP URL by default', () => {
      const result = validateRedirectUri('http://example.com/callback');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('HTTPS');
    });

    it('should reject HTTP URL for non-localhost', () => {
      const result = validateRedirectUri('http://example.com/callback', true);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('HTTPS');
    });

    it('should reject unsupported protocol', () => {
      const result = validateRedirectUri('ftp://example.com/callback');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not supported');
    });
  });

  describe('validateScope', () => {
    it('should accept valid scope with openid', () => {
      const result = validateScope('openid profile');
      expect(result.valid).toBe(true);
    });

    it('should accept only openid scope', () => {
      const result = validateScope('openid');
      expect(result.valid).toBe(true);
    });

    it('should accept all standard scopes', () => {
      const result = validateScope('openid profile email address phone');
      expect(result.valid).toBe(true);
    });

    it('should reject missing scope', () => {
      const result = validateScope(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject empty scope', () => {
      const result = validateScope('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject scope without openid', () => {
      const result = validateScope('profile email');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('openid');
    });

    it('should reject invalid scope values', () => {
      const result = validateScope('openid invalid-scope');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid scope');
    });

    it('should handle multiple spaces between scopes', () => {
      const result = validateScope('openid  profile   email');
      expect(result.valid).toBe(true);
    });
  });

  describe('validateState', () => {
    it('should accept valid state', () => {
      const result = validateState('random-state-123');
      expect(result.valid).toBe(true);
    });

    it('should accept missing state (optional)', () => {
      const result = validateState(undefined);
      expect(result.valid).toBe(true);
    });

    it('should reject empty state if provided', () => {
      const result = validateState('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject state that is too long', () => {
      const result = validateState('a'.repeat(513));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });
  });

  describe('validateNonce', () => {
    it('should accept valid nonce', () => {
      const result = validateNonce('random-nonce-456');
      expect(result.valid).toBe(true);
    });

    it('should accept missing nonce (optional)', () => {
      const result = validateNonce(undefined);
      expect(result.valid).toBe(true);
    });

    it('should reject empty nonce if provided', () => {
      const result = validateNonce('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject nonce that is too long', () => {
      const result = validateNonce('a'.repeat(513));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });
  });

  describe('validateGrantType', () => {
    it('should accept authorization_code grant type', () => {
      const result = validateGrantType('authorization_code');
      expect(result.valid).toBe(true);
    });

    it('should reject missing grant type', () => {
      const result = validateGrantType(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject unsupported grant type', () => {
      const result = validateGrantType('implicit');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported');
    });

    it('should reject client_credentials grant type', () => {
      const result = validateGrantType('client_credentials');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported');
    });
  });

  describe('validateResponseType', () => {
    it('should accept code response type', () => {
      const result = validateResponseType('code');
      expect(result.valid).toBe(true);
    });

    it('should reject missing response type', () => {
      const result = validateResponseType(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject unsupported response type', () => {
      const result = validateResponseType('token');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported');
    });

    it('should reject id_token response type', () => {
      const result = validateResponseType('id_token');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported');
    });
  });

  describe('validateAuthCode', () => {
    it('should accept valid UUID v4 code', () => {
      const result = validateAuthCode('550e8400-e29b-41d4-a716-446655440000');
      expect(result.valid).toBe(true);
    });

    it('should reject missing code', () => {
      const result = validateAuthCode(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject empty code', () => {
      const result = validateAuthCode('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject invalid UUID format', () => {
      const result = validateAuthCode('not-a-uuid');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid');
    });

    it('should reject UUID v1 format', () => {
      const result = validateAuthCode('550e8400-e29b-11d4-a716-446655440000');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid');
    });
  });

  describe('validateToken', () => {
    it('should accept valid JWT format', () => {
      const result = validateToken(
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
      );
      expect(result.valid).toBe(true);
    });

    it('should accept token with long parts', () => {
      const header = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
      const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0';
      const signature = 'a'.repeat(100);
      const result = validateToken(`${header}.${payload}.${signature}`);
      expect(result.valid).toBe(true);
    });

    it('should reject missing token', () => {
      const result = validateToken(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject token with only 2 parts', () => {
      const result = validateToken('header.payload');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('3 parts');
    });

    it('should reject token with 4 parts', () => {
      const result = validateToken('header.payload.signature.extra');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('3 parts');
    });

    it('should reject token with invalid base64url characters', () => {
      const result = validateToken('header+with/special.payload.signature');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not valid base64url');
    });
  });
});

/**
 * Logout Validation Utilities Tests
 *
 * Tests for OpenID Connect RP-Initiated Logout 1.0 validation:
 * - validatePostLogoutRedirectUri: URI matching with normalization
 * - validateLogoutParameters: Parameter combination validation
 */

import { describe, it, expect } from 'vitest';
import { validatePostLogoutRedirectUri, validateLogoutParameters } from '../logout-validation';

describe('Logout Validation Utilities', () => {
  describe('validatePostLogoutRedirectUri', () => {
    describe('Basic Validation', () => {
      it('should accept undefined URI (optional parameter)', () => {
        const result = validatePostLogoutRedirectUri(undefined, ['https://example.com/callback']);
        expect(result.valid).toBe(true);
      });

      it('should accept exactly matching registered URI', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should reject unregistered URI', () => {
        const result = validatePostLogoutRedirectUri('https://malicious.com/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should reject invalid URL format', () => {
        const result = validatePostLogoutRedirectUri('not-a-valid-url', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not a valid URL');
      });
    });

    describe('Protocol Validation', () => {
      it('should accept HTTPS URI', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should accept http://localhost', () => {
        const result = validatePostLogoutRedirectUri('http://localhost/callback', [
          'http://localhost/callback',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should accept http://127.0.0.1', () => {
        const result = validatePostLogoutRedirectUri('http://127.0.0.1/callback', [
          'http://127.0.0.1/callback',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should reject HTTP on non-localhost', () => {
        const result = validatePostLogoutRedirectUri('http://example.com/callback', [
          'http://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('HTTPS');
      });
    });

    describe('Query Parameter Handling', () => {
      it('should accept URI with matching query parameters', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback?state=123', [
          'https://example.com/callback?state=123',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should reject URI with additional query parameters', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback?extra=param', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should reject URI with different query parameters', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback?state=456', [
          'https://example.com/callback?state=123',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should reject URI missing expected query parameters', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback', [
          'https://example.com/callback?state=123',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });
    });

    describe('Exact Match with Encoding Normalization', () => {
      it('should require exact match including trailing slash', () => {
        // Trailing slash difference should NOT match
        const result = validatePostLogoutRedirectUri('https://example.com/callback/', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should match when trailing slash is identical', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback/', [
          'https://example.com/callback/',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should match with normalized URL encoding', () => {
        // URL encoding normalization: %2F should normalize to /
        const result = validatePostLogoutRedirectUri('https://example.com/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should match encoded and unencoded equivalent paths', () => {
        // Both should normalize to the same URL via URL.href
        const result = validatePostLogoutRedirectUri('https://example.com/path%20with%20spaces', [
          'https://example.com/path%20with%20spaces',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should not match different paths', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/other', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should not match different hosts', () => {
        const result = validatePostLogoutRedirectUri('https://other.example.com/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should not match different ports', () => {
        const result = validatePostLogoutRedirectUri('https://example.com:8080/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should normalize default HTTPS port', () => {
        // https://example.com:443/ should normalize to https://example.com/
        const result = validatePostLogoutRedirectUri('https://example.com:443/callback', [
          'https://example.com/callback',
        ]);
        expect(result.valid).toBe(true);
      });
    });

    describe('Multiple Registered URIs', () => {
      it('should accept URI matching one of multiple registered URIs', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/logout', [
          'https://example.com/callback',
          'https://example.com/logout',
          'https://example.com/signout',
        ]);
        expect(result.valid).toBe(true);
      });

      it('should reject URI not matching any registered URI', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/other', [
          'https://example.com/callback',
          'https://example.com/logout',
        ]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });

      it('should handle empty registered URIs array', () => {
        const result = validatePostLogoutRedirectUri('https://example.com/callback', []);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not registered');
      });
    });
  });

  describe('validateLogoutParameters', () => {
    it('should accept both parameters present', () => {
      const result = validateLogoutParameters('https://example.com/logout', 'valid.id.token', true);
      expect(result.valid).toBe(true);
    });

    it('should accept neither parameter present', () => {
      const result = validateLogoutParameters(undefined, undefined, true);
      expect(result.valid).toBe(true);
    });

    it('should accept id_token_hint alone', () => {
      const result = validateLogoutParameters(undefined, 'valid.id.token', true);
      expect(result.valid).toBe(true);
    });

    it('should reject post_logout_redirect_uri without id_token_hint when required', () => {
      const result = validateLogoutParameters('https://example.com/logout', undefined, true);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id_token_hint is required');
    });

    it('should accept post_logout_redirect_uri without id_token_hint when not required', () => {
      const result = validateLogoutParameters('https://example.com/logout', undefined, false);
      expect(result.valid).toBe(true);
    });

    it('should default to requiring id_token_hint', () => {
      // Default behavior (no third parameter)
      const result = validateLogoutParameters('https://example.com/logout', undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id_token_hint is required');
    });
  });
});

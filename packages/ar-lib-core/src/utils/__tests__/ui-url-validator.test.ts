/**
 * UI URL Validator Tests
 *
 * Tests for:
 * - validateUIBaseUrl: UI base URL security validation
 * - parseAllowedOriginsEnv: Environment variable parsing
 * - Audit logging functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateUIBaseUrl,
  parseAllowedOriginsEnv,
  logUIConfigChange,
  logUIConfigValidationFailure,
} from '../ui-url-validator';

describe('UI URL Validator', () => {
  describe('validateUIBaseUrl', () => {
    const issuerUrl = 'https://auth.example.com';
    const allowedOrigins = ['https://login.example.com', 'https://ui.example.com'];

    describe('empty/undefined input', () => {
      it('should return valid for undefined URL', () => {
        const result = validateUIBaseUrl(undefined, issuerUrl, []);
        expect(result.valid).toBe(true);
        expect(result.normalizedUrl).toBeUndefined();
      });

      it('should return valid for null URL', () => {
        const result = validateUIBaseUrl(null, issuerUrl, []);
        expect(result.valid).toBe(true);
      });

      it('should return valid for empty string URL', () => {
        const result = validateUIBaseUrl('', issuerUrl, []);
        expect(result.valid).toBe(true);
      });

      it('should return valid for whitespace-only URL', () => {
        const result = validateUIBaseUrl('   ', issuerUrl, []);
        expect(result.valid).toBe(true);
      });
    });

    describe('same-origin validation', () => {
      it('should allow URL with same origin as ISSUER_URL', () => {
        const result = validateUIBaseUrl('https://auth.example.com/login', issuerUrl, []);

        expect(result.valid).toBe(true);
        expect(result.normalizedUrl).toBe('https://auth.example.com/login');
        expect(result.allowedReason).toBe('same_origin');
      });

      it('should allow different path on same origin', () => {
        const result = validateUIBaseUrl('https://auth.example.com/ui/v2/login', issuerUrl, []);

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('same_origin');
      });

      it('should be case-insensitive for origin comparison', () => {
        const result = validateUIBaseUrl('HTTPS://AUTH.EXAMPLE.COM/login', issuerUrl, []);

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('same_origin');
      });

      it('should handle port differences (different origin)', () => {
        const result = validateUIBaseUrl('https://auth.example.com:8443/login', issuerUrl, []);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Origin not allowed');
      });
    });

    describe('allowlist validation', () => {
      it('should allow URL when origin is in ALLOWED_ORIGINS', () => {
        const result = validateUIBaseUrl(
          'https://login.example.com/auth',
          issuerUrl,
          allowedOrigins
        );

        expect(result.valid).toBe(true);
        expect(result.normalizedUrl).toBe('https://login.example.com/auth');
        expect(result.allowedReason).toBe('pre_registered');
      });

      it('should allow any path on pre-registered origin', () => {
        const result = validateUIBaseUrl(
          'https://ui.example.com/deep/nested/path',
          issuerUrl,
          allowedOrigins
        );

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('pre_registered');
      });

      it('should reject URL when origin is not in allowed list', () => {
        const result = validateUIBaseUrl('https://evil.com/phishing', issuerUrl, allowedOrigins);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Origin not allowed');
        expect(result.error).toContain('https://evil.com');
      });

      it('should be case-insensitive for allowlist comparison', () => {
        const result = validateUIBaseUrl('https://LOGIN.EXAMPLE.COM/auth', issuerUrl, [
          'https://login.example.com',
        ]);

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('pre_registered');
      });
    });

    describe('security validation', () => {
      it('should reject http:// URLs (except localhost)', () => {
        const result = validateUIBaseUrl('http://auth.example.com/login', issuerUrl, []);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('HTTPS is required');
      });

      it('should allow http://localhost', () => {
        const result = validateUIBaseUrl(
          'http://localhost:3000/login',
          'http://localhost:3000',
          []
        );

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('localhost');
      });

      it('should allow http://127.0.0.1', () => {
        const result = validateUIBaseUrl(
          'http://127.0.0.1:8080/login',
          'http://127.0.0.1:8080',
          []
        );

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('localhost');
      });

      it('should reject URLs with fragment identifiers', () => {
        const result = validateUIBaseUrl('https://auth.example.com/login#token=xyz', issuerUrl, []);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Fragment identifiers');
      });

      it('should allow URLs with empty fragment', () => {
        const result = validateUIBaseUrl('https://auth.example.com/login#', issuerUrl, []);

        expect(result.valid).toBe(true);
      });

      it('should reject invalid URLs', () => {
        const result = validateUIBaseUrl('not-a-valid-url', issuerUrl, []);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid URL format');
      });

      it('should reject javascript: URLs', () => {
        const result = validateUIBaseUrl('javascript:alert(1)', issuerUrl, []);

        expect(result.valid).toBe(false);
      });

      it('should reject data: URLs', () => {
        const result = validateUIBaseUrl('data:text/html,<script>alert(1)</script>', issuerUrl, []);

        expect(result.valid).toBe(false);
      });
    });

    describe('ISSUER_URL edge cases', () => {
      it('should handle undefined ISSUER_URL', () => {
        const result = validateUIBaseUrl(
          'https://login.example.com/auth',
          undefined,
          allowedOrigins
        );

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('pre_registered');
      });

      it('should handle invalid ISSUER_URL gracefully', () => {
        let warnSpy: ReturnType<typeof vi.spyOn>;
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = validateUIBaseUrl(
          'https://login.example.com/auth',
          'not-a-url',
          allowedOrigins
        );

        expect(result.valid).toBe(true);
        expect(result.allowedReason).toBe('pre_registered');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ISSUER_URL is invalid'));

        warnSpy.mockRestore();
      });
    });

    describe('trailing slash normalization', () => {
      it('should remove trailing slash from normalized URL', () => {
        const result = validateUIBaseUrl('https://auth.example.com/login/', issuerUrl, []);

        expect(result.valid).toBe(true);
        expect(result.normalizedUrl).toBe('https://auth.example.com/login');
      });
    });
  });

  describe('parseAllowedOriginsEnv', () => {
    it('should parse comma-separated origins', () => {
      const result = parseAllowedOriginsEnv('https://app1.example.com, https://app2.example.com');

      expect(result).toEqual(['https://app1.example.com', 'https://app2.example.com']);
    });

    it('should return empty array for undefined', () => {
      const result = parseAllowedOriginsEnv(undefined);
      expect(result).toEqual([]);
    });

    it('should return empty array for empty string', () => {
      const result = parseAllowedOriginsEnv('');
      expect(result).toEqual([]);
    });

    it('should trim whitespace', () => {
      const result = parseAllowedOriginsEnv(
        '  https://app1.example.com  ,  https://app2.example.com  '
      );

      expect(result).toEqual(['https://app1.example.com', 'https://app2.example.com']);
    });

    it('should filter empty entries', () => {
      const result = parseAllowedOriginsEnv('https://app1.example.com,,https://app2.example.com,');

      expect(result).toEqual(['https://app1.example.com', 'https://app2.example.com']);
    });
  });

  describe('Open Redirect Prevention', () => {
    const issuerUrl = 'https://legitimate-auth.com';

    it('should prevent redirect to external domain', () => {
      const result = validateUIBaseUrl('https://evil-site.com/phishing', issuerUrl, []);

      expect(result.valid).toBe(false);
    });

    it('should prevent redirect via subdomain confusion', () => {
      const result = validateUIBaseUrl('https://evil.legitimate-auth.com/phishing', issuerUrl, []);

      expect(result.valid).toBe(false);
    });

    it('should prevent redirect via protocol downgrade', () => {
      const result = validateUIBaseUrl('http://legitimate-auth.com/mitm', issuerUrl, []);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('HTTPS is required');
    });

    it('should prevent redirect via port confusion', () => {
      const result = validateUIBaseUrl('https://legitimate-auth.com:8443/evil', issuerUrl, []);

      expect(result.valid).toBe(false);
    });

    it('should prevent fragment-based attacks', () => {
      const result = validateUIBaseUrl(
        'https://legitimate-auth.com/ok#evil=https://attacker.com',
        issuerUrl,
        []
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Fragment');
    });
  });

  describe('Audit Logging', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should log config changes with admin ID', () => {
      logUIConfigChange('update', 'admin-123', {
        field: 'baseUrl',
        oldValue: 'https://old.example.com',
        newValue: 'https://new.example.com',
      });

      // Structured logger outputs JSON format
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"message":"UI config change"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"adminId":"admin-123"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"UPDATE"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"field":"baseUrl"'));
    });

    it('should log config changes with unknown admin', () => {
      logUIConfigChange('delete', undefined, {
        field: 'ui',
        oldValue: '{}',
        newValue: null,
      });

      // Structured logger outputs JSON format
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"adminId":"unknown"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"DELETE"'));
    });

    it('should log validation failures', () => {
      logUIConfigValidationFailure('admin-456', 'https://evil.com', 'Origin not allowed');

      // Structured logger outputs JSON format
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"message":"UI config validation rejected"')
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"adminId":"admin-456"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"url":"https://evil.com"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"error":"Origin not allowed"'));
    });
  });

  describe('CORS Alignment', () => {
    // Verify that UI URL validation uses the same ALLOWED_ORIGINS as CORS
    it('should accept URLs from ALLOWED_ORIGINS (same as CORS whitelist)', () => {
      // These are the origins that would be in ALLOWED_ORIGINS env var
      const corsAllowedOrigins = ['https://app.example.com', 'https://dashboard.example.com'];

      // UI URL validation should accept the same origins
      const result1 = validateUIBaseUrl(
        'https://app.example.com/login',
        'https://api.example.com',
        corsAllowedOrigins
      );
      expect(result1.valid).toBe(true);

      const result2 = validateUIBaseUrl(
        'https://dashboard.example.com/auth',
        'https://api.example.com',
        corsAllowedOrigins
      );
      expect(result2.valid).toBe(true);

      // Origins not in CORS whitelist should be rejected
      const result3 = validateUIBaseUrl(
        'https://unauthorized.example.com/login',
        'https://api.example.com',
        corsAllowedOrigins
      );
      expect(result3.valid).toBe(false);
    });
  });
});

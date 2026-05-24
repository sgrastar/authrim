/**
 * Diagnostic Security Utilities Tests
 *
 * Tests for diagnostic logging security utilities:
 * - Token hashing (SHA-256)
 * - Header filtering (allowlist)
 * - Body extraction (schema-aware)
 * - PII detection and redaction
 */

import { describe, it, expect } from 'vitest';
import {
  hashToken,
  filterSafeHeaders,
  parseSafeHeadersAllowlist,
  extractBodySummary,
  sanitizeQueryParams,
  containsPII,
  redactPII,
  DEFAULT_SAFE_HEADERS,
  SENSITIVE_HEADERS,
} from '../diagnostic-security';

describe('Diagnostic Security Utilities', () => {
  describe('hashToken', () => {
    it('should produce a SHA-256 hash prefix', async () => {
      const token = 'test-token-12345';
      const hash = await hashToken(token, 12);

      expect(hash).toHaveLength(12);
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });

    it('should produce consistent hashes for the same token', async () => {
      const token = 'my-access-token';
      const hash1 = await hashToken(token, 12);
      const hash2 = await hashToken(token, 12);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', async () => {
      const token1 = 'token-1';
      const token2 = 'token-2';

      const hash1 = await hashToken(token1, 12);
      const hash2 = await hashToken(token2, 12);

      expect(hash1).not.toBe(hash2);
    });

    it('should respect prefix length parameter', async () => {
      const token = 'test-token';

      const hash8 = await hashToken(token, 8);
      const hash16 = await hashToken(token, 16);
      const hash32 = await hashToken(token, 32);

      expect(hash8).toHaveLength(8);
      expect(hash16).toHaveLength(16);
      expect(hash32).toHaveLength(32);
    });

    it('should enforce minimum prefix length of 8', async () => {
      const token = 'test-token';
      const hash = await hashToken(token, 4); // Request 4, should get 8

      expect(hash.length).toBeGreaterThanOrEqual(8);
    });

    it('should enforce maximum prefix length of 64', async () => {
      const token = 'test-token';
      const hash = await hashToken(token, 100); // Request 100, should get 64

      expect(hash.length).toBeLessThanOrEqual(64);
    });
  });

  describe('filterSafeHeaders', () => {
    it('should filter headers using allowlist', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        'user-agent': 'Test/1.0',
        cookie: 'session=xyz',
      });

      const filtered = filterSafeHeaders(headers);

      expect(filtered['content-type']).toBe('application/json');
      expect(filtered['user-agent']).toBe('Test/1.0');
      expect(filtered['authorization']).toBeUndefined();
      expect(filtered['cookie']).toBeUndefined();
    });

    it('should work with plain object headers', () => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
        'X-Correlation-ID': 'req-123',
      };

      const filtered = filterSafeHeaders(headers);

      // Keys are normalized to lowercase
      expect(filtered['content-type']).toBe('application/json');
      expect(filtered['x-correlation-id']).toBe('req-123');
      expect(filtered['authorization']).toBeUndefined();
    });

    it('should respect custom allowlist', () => {
      const headers = new Headers({
        'content-type': 'application/json',
        'x-custom-header': 'value',
      });

      const filtered = filterSafeHeaders(headers, ['x-custom-header']);

      expect(filtered['x-custom-header']).toBe('value');
      expect(filtered['content-type']).toBeUndefined();
    });

    it('should never include sensitive headers even if in allowlist', () => {
      const headers = new Headers({
        authorization: 'Bearer secret-token',
      });

      // Try to bypass by adding to allowlist
      const filtered = filterSafeHeaders(headers, ['authorization']);

      expect(filtered['authorization']).toBeUndefined();
    });
  });

  describe('parseSafeHeadersAllowlist', () => {
    it('should parse comma-separated header list', () => {
      const headerString = 'content-type,accept,user-agent';
      const parsed = parseSafeHeadersAllowlist(headerString);

      expect(parsed).toEqual(['content-type', 'accept', 'user-agent']);
    });

    it('should handle whitespace', () => {
      const headerString = ' content-type , accept , user-agent ';
      const parsed = parseSafeHeadersAllowlist(headerString);

      expect(parsed).toEqual(['content-type', 'accept', 'user-agent']);
    });

    it('should convert to lowercase', () => {
      const headerString = 'Content-Type,Accept,User-Agent';
      const parsed = parseSafeHeadersAllowlist(headerString);

      expect(parsed).toEqual(['content-type', 'accept', 'user-agent']);
    });

    it('should filter empty entries', () => {
      const headerString = 'content-type,,accept,';
      const parsed = parseSafeHeadersAllowlist(headerString);

      expect(parsed).toEqual(['content-type', 'accept']);
    });
  });

  describe('extractBodySummary', () => {
    it('should extract safe fields from token endpoint', () => {
      const body = {
        grant_type: 'authorization_code',
        code: 'secret-code-12345',
        code_verifier: 'secret-code-verifier',
        client_secret: 'super-secret',
        redirect_uri: 'https://example.com/callback',
      };

      const summary = extractBodySummary(body, 'application/json', '/token');

      expect(summary?.grant_type).toBe('authorization_code');
      expect(summary?.redirect_uri).toBe('https://example.com/callback');
      expect(summary?.client_secret).toBeUndefined();
      expect(summary?.code).toBeUndefined();
      expect(summary?.code_verifier).toBeUndefined();
      expect(summary?.code_present).toBe(true);
    });

    it('should extract safe fields from authorize endpoint', () => {
      const body = {
        response_type: 'code',
        client_id: 'client-123',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile',
        state: 'random-state',
        nonce: 'random-nonce',
      };

      const summary = extractBodySummary(body, 'application/json', '/authorize');

      expect(summary?.response_type).toBe('code');
      expect(summary?.client_id).toBe('client-123');
      expect(summary?.scope).toBe('openid profile');
      expect(summary?.state).toBe('random-state');
      expect(summary?.nonce).toBe('random-nonce');
    });

    it('should extract generic safe fields for unknown paths', () => {
      const body = {
        type: 'request',
        status: 'success',
        error: 'invalid_request',
        secret_field: 'should-not-be-included',
      };

      const summary = extractBodySummary(body, 'application/json', '/unknown');

      expect(summary?.type).toBe('request');
      expect(summary?.status).toBe('success');
      expect(summary?.error).toBe('invalid_request');
      expect(summary?.secret_field).toBeUndefined();
    });

    it('should return undefined for non-object bodies', () => {
      expect(extractBodySummary(null, 'application/json')).toBeUndefined();
      expect(extractBodySummary('string', 'application/json')).toBeUndefined();
      expect(extractBodySummary(123, 'application/json')).toBeUndefined();
    });
  });

  describe('sanitizeQueryParams', () => {
    it('should extract safe OAuth query parameters', () => {
      const query = {
        response_type: 'code',
        client_id: 'client-123',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
        state: 'xyz',
        code: 'secret-code-12345',
      };

      const sanitized = sanitizeQueryParams(query);

      expect(sanitized.response_type).toBe('code');
      expect(sanitized.client_id).toBe('client-123');
      expect(sanitized.scope).toBe('openid');
      expect(sanitized.code).toBeUndefined();
      expect(sanitized.code_hash).toBeUndefined();
      expect(sanitized.code_present).toBe('true');
    });

    it('should exclude sensitive parameters', () => {
      const query = {
        access_token: 'secret-token',
        id_token: 'secret-id-token',
        client_id: 'client-123',
      };

      const sanitized = sanitizeQueryParams(query);

      expect(sanitized.client_id).toBe('client-123');
      expect(sanitized.access_token).toBeUndefined();
      expect(sanitized.id_token).toBeUndefined();
    });
  });

  describe('containsPII', () => {
    it('should detect email addresses', () => {
      expect(containsPII('user@example.com')).toBe(true);
      expect(containsPII('Contact: test.user@domain.co.uk')).toBe(true);
      expect(containsPII('no email here')).toBe(false);
    });

    it('should detect phone numbers', () => {
      expect(containsPII('123-456-7890')).toBe(true);
      expect(containsPII('Call 555.123.4567')).toBe(true);
      expect(containsPII('1234567890')).toBe(true);
      expect(containsPII('no phone')).toBe(false);
    });

    it('should detect credit card numbers', () => {
      expect(containsPII('4111-1111-1111-1111')).toBe(true);
      expect(containsPII('4111 1111 1111 1111')).toBe(true);
      expect(containsPII('no card')).toBe(false);
    });

    it('should detect SSN', () => {
      expect(containsPII('123-45-6789')).toBe(true);
      expect(containsPII('no ssn')).toBe(false);
    });
  });

  describe('redactPII', () => {
    it('should redact email addresses', () => {
      const text = 'Contact user@example.com for details';
      const redacted = redactPII(text);

      expect(redacted).toBe('Contact [EMAIL_REDACTED] for details');
      expect(redacted).not.toContain('user@example.com');
    });

    it('should redact phone numbers', () => {
      const text = 'Call 123-456-7890 for support';
      const redacted = redactPII(text);

      expect(redacted).toBe('Call [PHONE_REDACTED] for support');
      expect(redacted).not.toContain('123-456-7890');
    });

    it('should redact credit card numbers', () => {
      const text = 'Card: 4111-1111-1111-1111';
      const redacted = redactPII(text);

      expect(redacted).toBe('Card: [CC_REDACTED]');
      expect(redacted).not.toContain('4111-1111-1111-1111');
    });

    it('should redact Amex-style credit card numbers', () => {
      const text = 'Card: 3782-822463-10005';
      const redacted = redactPII(text);

      expect(redacted).toBe('Card: [CC_REDACTED]');
      expect(redacted).not.toContain('3782-822463-10005');
    });

    it('should redact SSN', () => {
      const text = 'SSN: 123-45-6789';
      const redacted = redactPII(text);

      expect(redacted).toBe('SSN: [SSN_REDACTED]');
      expect(redacted).not.toContain('123-45-6789');
    });

    it('should redact multiple PII types', () => {
      const text = 'Email: user@example.com, Phone: 123-456-7890';
      const redacted = redactPII(text);

      expect(redacted).toBe('Email: [EMAIL_REDACTED], Phone: [PHONE_REDACTED]');
    });

    it('should redact compact JWT-like values', () => {
      const text = 'token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature';
      const redacted = redactPII(text);

      expect(redacted).toBe('token [JWT_REDACTED]');
    });

    it('should leave non-PII text unchanged', () => {
      const text = 'This is a safe message';
      const redacted = redactPII(text);

      expect(redacted).toBe(text);
    });
  });

  describe('Security Constants', () => {
    it('should have comprehensive safe headers list', () => {
      expect(DEFAULT_SAFE_HEADERS).toContain('content-type');
      expect(DEFAULT_SAFE_HEADERS).toContain('accept');
      expect(DEFAULT_SAFE_HEADERS).toContain('user-agent');
      expect(DEFAULT_SAFE_HEADERS).toContain('x-correlation-id');
      expect(DEFAULT_SAFE_HEADERS).toContain('x-diagnostic-session-id');
    });

    it('should have comprehensive sensitive headers list', () => {
      expect(SENSITIVE_HEADERS).toContain('authorization');
      expect(SENSITIVE_HEADERS).toContain('cookie');
      expect(SENSITIVE_HEADERS).toContain('set-cookie');
      expect(SENSITIVE_HEADERS).toContain('x-api-key');
    });

    it('should not have overlap between safe and sensitive headers', () => {
      const safeSet = new Set(DEFAULT_SAFE_HEADERS.map((h) => h.toLowerCase()));
      const sensitiveSet = new Set(SENSITIVE_HEADERS.map((h) => h.toLowerCase()));

      for (const safe of safeSet) {
        expect(sensitiveSet.has(safe)).toBe(false);
      }
    });
  });
});

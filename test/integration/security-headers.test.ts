/**
 * Tests for Security Headers and CORS Configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Env } from '../../src/types/env';
import app from '../../src/index';

// Mock environment
const mockEnv: Env = {
  ISSUER_URL: 'https://id.example.com',
  TOKEN_EXPIRY: '3600',
  REFRESH_TOKEN_EXPIRY: '2592000',
  CODE_EXPIRY: '120',
  STATE_EXPIRY: '300',
  NONCE_EXPIRY: '300',
  ALLOW_HTTP_REDIRECT: 'true',
  PRIVATE_KEY_PEM: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj
MzEfYyjiWA4R4/M2bS1+fWIcPm15j9xYdzxJlnxTzJEUm7DbBj2VmthqQx8e9D4b
kqKs3K0FkN8Zvu0gqt+4AKLqJcgNv5m8H8bVh5jPQvGIxlqvK5iYVcKlNKN7wCNl
vHJjLHSJGlBSTJKZcvCpjmq0DYdPvEpLWrT7aGXYKh0qCXUJVnqJFvPPqMRjNM5f
X9BEPQYcF4gRrKNOmJFBqO8vjL0kZxFNGHN3I3vvJ0dLWMvwsLJFQrLU9lzUCGLG
wTbXFa0lLCPdFLFmRY6BV3G0J3VJXqhJLMN4kgmZ0bU5G7zJ0KjHPfVCLv5hqwTn
n3+pAgMBAAECggEAWCE7qdP9VDlKc7ej3vLdVQU3zDRGzPK4jlw0hH6fvKPdNxKp
-----END PRIVATE KEY-----`,
  PUBLIC_JWK_JSON: JSON.stringify({
    kty: 'RSA',
    n: 'u1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tfn1iHD5teY_cWHc8SZZ8U8yRFJuw2wY9lZrYakMfHvQ-G5KirNytBZDfGb7tIKrfuACi6iXIDb-ZvB_G1YeYz0LxiMZaryuYmFXCpTSje8AjZbxyYyx0iRpQUkySm',
    e: 'AQAB',
    alg: 'RS256',
    use: 'sig',
    kid: 'test-key-id',
  }),
  KEY_ID: 'test-key-id',
  AUTH_CODES: {} as KVNamespace,
  STATE_STORE: {} as KVNamespace,
  NONCE_STORE: {} as KVNamespace,
  CLIENTS: {} as KVNamespace,
  REVOKED_TOKENS: {} as KVNamespace,
  REFRESH_TOKENS: {} as KVNamespace,
};

// Mock KV storage
const mockKVStore = new Map<string, string>();

// Mock KV namespace
const createMockKV = (): KVNamespace => {
  return {
    get: async (key: string) => mockKVStore.get(key) || null,
    put: async (key: string, value: string) => {
      mockKVStore.set(key, value);
    },
    delete: async (key: string) => {
      mockKVStore.delete(key);
    },
  } as unknown as KVNamespace;
};

describe('Security Headers', () => {
  beforeEach(() => {
    mockKVStore.clear();

    // Setup mock KV namespaces
    mockEnv.AUTH_CODES = createMockKV();
    mockEnv.STATE_STORE = createMockKV();
    mockEnv.NONCE_STORE = createMockKV();
    mockEnv.CLIENTS = createMockKV();
    mockEnv.REVOKED_TOKENS = createMockKV();
    mockEnv.REFRESH_TOKENS = createMockKV();
  });

  describe('Content Security Policy (CSP)', () => {
    it('should include Content-Security-Policy header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toBeDefined();
      expect(csp).toBeTruthy();
    });

    it('should have restrictive default-src', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("default-src 'self'");
    });

    it('should allow inline scripts and styles (for UI)', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("script-src");
      expect(csp).toContain("'unsafe-inline'");
      expect(csp).toContain("style-src");
    });

    it('should block object-src', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("object-src 'none'");
    });

    it('should block frame-src', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("frame-src 'none'");
    });
  });

  describe('Strict-Transport-Security (HSTS)', () => {
    it('should include HSTS header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const hsts = res.headers.get('Strict-Transport-Security');
      expect(hsts).toBeDefined();
      expect(hsts).toBeTruthy();
    });

    it('should have long max-age (2 years)', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const hsts = res.headers.get('Strict-Transport-Security');
      expect(hsts).toContain('max-age=63072000'); // 2 years in seconds
    });

    it('should include subdomains', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const hsts = res.headers.get('Strict-Transport-Security');
      expect(hsts).toContain('includeSubDomains');
    });

    it('should include preload directive', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const hsts = res.headers.get('Strict-Transport-Security');
      expect(hsts).toContain('preload');
    });
  });

  describe('X-Frame-Options', () => {
    it('should include X-Frame-Options header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const xfo = res.headers.get('X-Frame-Options');
      expect(xfo).toBeDefined();
    });

    it('should deny framing', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const xfo = res.headers.get('X-Frame-Options');
      expect(xfo).toBe('DENY');
    });
  });

  describe('X-Content-Type-Options', () => {
    it('should include X-Content-Type-Options header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const xcto = res.headers.get('X-Content-Type-Options');
      expect(xcto).toBeDefined();
    });

    it('should be set to nosniff', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const xcto = res.headers.get('X-Content-Type-Options');
      expect(xcto).toBe('nosniff');
    });
  });

  describe('Referrer-Policy', () => {
    it('should include Referrer-Policy header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const rp = res.headers.get('Referrer-Policy');
      expect(rp).toBeDefined();
    });

    it('should use strict-origin-when-cross-origin', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const rp = res.headers.get('Referrer-Policy');
      expect(rp).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('Permissions-Policy', () => {
    it('should include Permissions-Policy header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const pp = res.headers.get('Permissions-Policy');
      expect(pp).toBeDefined();
    });

    it('should block camera access', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const pp = res.headers.get('Permissions-Policy');
      expect(pp).toContain('camera=()');
    });

    it('should block microphone access', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const pp = res.headers.get('Permissions-Policy');
      expect(pp).toContain('microphone=()');
    });

    it('should block geolocation access', async () => {
      const res = await app.request('/health', {
        method: 'GET',
      }, mockEnv);

      const pp = res.headers.get('Permissions-Policy');
      expect(pp).toContain('geolocation=()');
    });
  });

  describe('Security Headers on All Endpoints', () => {
    it('should include security headers on discovery endpoint', async () => {
      const res = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, mockEnv);

      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Strict-Transport-Security')).toBeDefined();
    });

    it('should include security headers on JWKS endpoint', async () => {
      const res = await app.request('/.well-known/jwks.json', {
        method: 'GET',
      }, mockEnv);

      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Strict-Transport-Security')).toBeDefined();
    });

    it('should include security headers on authorize endpoint', async () => {
      const res = await app.request('/authorize?response_type=code&client_id=test&redirect_uri=https://example.com/callback&scope=openid', {
        method: 'GET',
      }, mockEnv);

      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Strict-Transport-Security')).toBeDefined();
    });

    it('should include security headers on error responses', async () => {
      const res = await app.request('/nonexistent', {
        method: 'GET',
      }, mockEnv);

      expect(res.status).toBe(404);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });
  });
});

describe('CORS Configuration', () => {
  beforeEach(() => {
    mockKVStore.clear();

    // Setup mock KV namespaces
    mockEnv.AUTH_CODES = createMockKV();
    mockEnv.STATE_STORE = createMockKV();
    mockEnv.NONCE_STORE = createMockKV();
    mockEnv.CLIENTS = createMockKV();
    mockEnv.REVOKED_TOKENS = createMockKV();
  });

  describe('CORS Headers', () => {
    it('should include Access-Control-Allow-Origin header', async () => {
      const res = await app.request('/health', {
        method: 'GET',
        headers: {
          'Origin': 'https://example.com',
        },
      }, mockEnv);

      const acao = res.headers.get('Access-Control-Allow-Origin');
      expect(acao).toBeDefined();
    });

    it('should allow all origins', async () => {
      const res = await app.request('/health', {
        method: 'GET',
        headers: {
          'Origin': 'https://example.com',
        },
      }, mockEnv);

      const acao = res.headers.get('Access-Control-Allow-Origin');
      expect(acao).toBe('*');
    });

    it('should include Access-Control-Allow-Methods header', async () => {
      const res = await app.request('/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'POST',
        },
      }, mockEnv);

      const acam = res.headers.get('Access-Control-Allow-Methods');
      expect(acam).toBeDefined();
      expect(acam).toContain('GET');
      expect(acam).toContain('POST');
      expect(acam).toContain('OPTIONS');
    });

    it('should include Access-Control-Allow-Headers header', async () => {
      const res = await app.request('/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      }, mockEnv);

      const acah = res.headers.get('Access-Control-Allow-Headers');
      expect(acah).toBeDefined();
      expect(acah).toContain('Content-Type');
      expect(acah).toContain('Authorization');
    });

    it('should expose rate limit headers', async () => {
      const res = await app.request('/health', {
        method: 'GET',
        headers: {
          'Origin': 'https://example.com',
        },
      }, mockEnv);

      const aceh = res.headers.get('Access-Control-Expose-Headers');
      expect(aceh).toBeDefined();
      expect(aceh).toContain('X-RateLimit-Limit');
      expect(aceh).toContain('X-RateLimit-Remaining');
      expect(aceh).toContain('X-RateLimit-Reset');
    });

    it('should include Access-Control-Max-Age header', async () => {
      const res = await app.request('/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'POST',
        },
      }, mockEnv);

      const acma = res.headers.get('Access-Control-Max-Age');
      expect(acma).toBeDefined();
      expect(acma).toBe('86400'); // 24 hours
    });

    it('should allow credentials', async () => {
      const res = await app.request('/health', {
        method: 'GET',
        headers: {
          'Origin': 'https://example.com',
        },
      }, mockEnv);

      const acac = res.headers.get('Access-Control-Allow-Credentials');
      expect(acac).toBe('true');
    });
  });

  describe('Preflight Requests', () => {
    it('should handle OPTIONS preflight requests', async () => {
      const res = await app.request('/.well-known/openid-configuration', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'GET',
        },
      }, mockEnv);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeDefined();
      expect(res.headers.get('Access-Control-Allow-Methods')).toBeDefined();
    });

    it('should handle preflight for POST requests', async () => {
      const res = await app.request('/token', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      }, mockEnv);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });
  });

  describe('CORS on API Endpoints', () => {
    it('should include CORS headers on discovery endpoint', async () => {
      const res = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
        headers: {
          'Origin': 'https://example.com',
        },
      }, mockEnv);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should include CORS headers on JWKS endpoint', async () => {
      const res = await app.request('/.well-known/jwks.json', {
        method: 'GET',
        headers: {
          'Origin': 'https://example.com',
        },
      }, mockEnv);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should include CORS headers on token endpoint', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: {
          'Origin': 'https://example.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=authorization_code&code=test&client_id=test&redirect_uri=https://example.com/callback',
      }, mockEnv);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});

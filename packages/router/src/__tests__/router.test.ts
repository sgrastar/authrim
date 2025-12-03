/**
 * Router Worker Smoke Tests
 *
 * Tests that verify:
 * 1. Path routing to correct workers (service bindings)
 * 2. Security headers applied to non-excluded paths
 * 3. CSP exclusion for /authorize and /session/check
 * 4. CORS configuration
 * 5. 404 handling
 * 6. Health check endpoint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../index';

// Mock fetcher that tracks which service binding was called
const createMockFetcher = (name: string) => ({
  fetch: vi.fn(async (request: Request) => {
    return new Response(JSON.stringify({ worker: name, path: new URL(request.url).pathname }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

// Create mock environment with service bindings
const createMockEnv = () => ({
  OP_DISCOVERY: createMockFetcher('OP_DISCOVERY'),
  OP_AUTH: createMockFetcher('OP_AUTH'),
  OP_TOKEN: createMockFetcher('OP_TOKEN'),
  OP_USERINFO: createMockFetcher('OP_USERINFO'),
  OP_MANAGEMENT: createMockFetcher('OP_MANAGEMENT'),
  OP_ASYNC: createMockFetcher('OP_ASYNC'),
  OP_SAML: createMockFetcher('OP_SAML'),
});

describe('Router Worker', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const req = new Request('https://example.com/api/health');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('authrim-router');
    });
  });

  describe('Path Routing', () => {
    describe('OP_DISCOVERY routes', () => {
      it('should route /.well-known/openid-configuration to OP_DISCOVERY', async () => {
        const req = new Request('https://example.com/.well-known/openid-configuration');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_DISCOVERY.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /.well-known/jwks.json to OP_DISCOVERY', async () => {
        const req = new Request('https://example.com/.well-known/jwks.json');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_DISCOVERY.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_AUTH routes', () => {
      it('should route GET /authorize to OP_AUTH', async () => {
        const req = new Request('https://example.com/authorize?client_id=test');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /authorize to OP_AUTH', async () => {
        const req = new Request('https://example.com/authorize', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /authorize/confirm to OP_AUTH', async () => {
        const req = new Request('https://example.com/authorize/confirm');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /as/par to OP_AUTH', async () => {
        const req = new Request('https://example.com/as/par', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/auth/* to OP_AUTH', async () => {
        const req = new Request('https://example.com/api/auth/passkey/register');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/sessions/* to OP_AUTH', async () => {
        const req = new Request('https://example.com/api/sessions/status');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /session/check to OP_AUTH', async () => {
        const req = new Request('https://example.com/session/check');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /logout to OP_AUTH', async () => {
        const req = new Request('https://example.com/logout');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /logout/backchannel to OP_AUTH', async () => {
        const req = new Request('https://example.com/logout/backchannel', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_TOKEN routes', () => {
      it('should route POST /token to OP_TOKEN', async () => {
        const req = new Request('https://example.com/token', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_TOKEN.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_USERINFO routes', () => {
      it('should route GET /userinfo to OP_USERINFO', async () => {
        const req = new Request('https://example.com/userinfo');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_USERINFO.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /userinfo to OP_USERINFO', async () => {
        const req = new Request('https://example.com/userinfo', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_USERINFO.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_ASYNC routes', () => {
      it('should route POST /device_authorization to OP_ASYNC', async () => {
        const req = new Request('https://example.com/device_authorization', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_ASYNC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /device to OP_ASYNC', async () => {
        const req = new Request('https://example.com/device');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_ASYNC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/device/* to OP_ASYNC', async () => {
        const req = new Request('https://example.com/api/device/verify');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_ASYNC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /bc-authorize to OP_ASYNC', async () => {
        const req = new Request('https://example.com/bc-authorize', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_ASYNC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/ciba/* to OP_ASYNC', async () => {
        const req = new Request('https://example.com/api/ciba/approve');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_ASYNC.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_MANAGEMENT routes', () => {
      it('should route POST /register to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/register', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /introspect to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/introspect', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /revoke to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/revoke', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/admin/* to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/api/admin/clients');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/avatars/* to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/api/avatars/user123.png');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /scim/v2/* to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/scim/v2/Users');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_SAML routes', () => {
      it('should route /saml/idp/* to OP_SAML', async () => {
        const req = new Request('https://example.com/saml/idp/metadata');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /saml/sp/* to OP_SAML', async () => {
        const req = new Request('https://example.com/saml/sp/acs');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Security Headers', () => {
    it('should apply secure headers to regular endpoints', async () => {
      const req = new Request('https://example.com/api/health');
      const res = await app.fetch(req, mockEnv);

      // Check for security headers
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    });

    it('should apply secure headers to /token endpoint', async () => {
      const req = new Request('https://example.com/token', { method: 'POST' });
      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('should NOT apply CSP to /authorize (allows nonce-based CSP)', async () => {
      const req = new Request('https://example.com/authorize?client_id=test');
      const res = await app.fetch(req, mockEnv);

      // CSP should be absent (op-auth handles its own CSP with nonces)
      expect(res.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('should NOT apply CSP to /authorize/* paths', async () => {
      const req = new Request('https://example.com/authorize/confirm');
      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('Content-Security-Policy')).toBeNull();
    });

    it('should NOT apply CSP to /session/check (iframe embedding)', async () => {
      const req = new Request('https://example.com/session/check');
      const res = await app.fetch(req, mockEnv);

      // session/check needs custom headers for iframe support
      expect(res.headers.get('Content-Security-Policy')).toBeNull();
      expect(res.headers.get('X-Frame-Options')).toBeNull();
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers with request origin when no whitelist configured', async () => {
      const req = new Request('https://example.com/api/health', {
        headers: { Origin: 'https://app.example.com' },
      });
      const res = await app.fetch(req, mockEnv);

      // When ALLOWED_ORIGINS is not set, returns the request origin (not '*')
      // This is more secure per CORS spec
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      // Credentials should be disabled when no whitelist is configured
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });

    it('should allow whitelisted origin with credentials when ALLOWED_ORIGINS is set', async () => {
      const envWithOrigins = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
      };
      const req = new Request('https://example.com/api/health', {
        headers: { Origin: 'https://app.example.com' },
      });
      const res = await app.fetch(req, envWithOrigins);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('should reject non-whitelisted origin when ALLOWED_ORIGINS is set', async () => {
      const envWithOrigins = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://app.example.com',
      };
      const req = new Request('https://example.com/api/health', {
        headers: { Origin: 'https://evil.example.com' },
      });
      const res = await app.fetch(req, envWithOrigins);

      // Non-whitelisted origin should not get CORS headers
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should handle OPTIONS preflight requests', async () => {
      const req = new Request('https://example.com/token', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, Authorization',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });

    it('should expose rate limit and ETag headers', async () => {
      const req = new Request('https://example.com/api/health', {
        headers: { Origin: 'https://app.example.com' },
      });
      const res = await app.fetch(req, mockEnv);

      const exposeHeaders = res.headers.get('Access-Control-Expose-Headers');
      expect(exposeHeaders).toContain('X-RateLimit-Limit');
      expect(exposeHeaders).toContain('ETag');
      expect(exposeHeaders).toContain('Location');
    });
  });

  describe('404 Handling', () => {
    it('should return 404 for unknown paths', async () => {
      const req = new Request('https://example.com/unknown/path');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    });

    it('should return helpful hint in 404 response', async () => {
      const req = new Request('https://example.com/nonexistent');
      const res = await app.fetch(req, mockEnv);

      const body = (await res.json()) as { hint: string };
      expect(body.hint).toContain('Authrim Router');
    });
  });

  describe('Request Forwarding', () => {
    it('should forward full URL to service binding', async () => {
      const req = new Request('https://example.com/.well-known/openid-configuration');
      await app.fetch(req, mockEnv);

      const forwardedRequest = mockEnv.OP_DISCOVERY.fetch.mock.calls[0][0];
      expect(forwardedRequest.url).toBe('https://example.com/.well-known/openid-configuration');
    });

    it('should forward query parameters', async () => {
      const req = new Request(
        'https://example.com/authorize?client_id=test&response_type=code&redirect_uri=https://app.example.com/callback'
      );
      await app.fetch(req, mockEnv);

      const forwardedRequest = mockEnv.OP_AUTH.fetch.mock.calls[0][0];
      const url = new URL(forwardedRequest.url);
      expect(url.searchParams.get('client_id')).toBe('test');
      expect(url.searchParams.get('response_type')).toBe('code');
    });

    it('should forward request method', async () => {
      const req = new Request('https://example.com/token', {
        method: 'POST',
        body: 'grant_type=authorization_code',
      });
      await app.fetch(req, mockEnv);

      const forwardedRequest = mockEnv.OP_TOKEN.fetch.mock.calls[0][0];
      expect(forwardedRequest.method).toBe('POST');
    });

    it('should forward request headers', async () => {
      const req = new Request('https://example.com/userinfo', {
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      });
      await app.fetch(req, mockEnv);

      const forwardedRequest = mockEnv.OP_USERINFO.fetch.mock.calls[0][0];
      expect(forwardedRequest.headers.get('Authorization')).toBe('Bearer test-token');
    });
  });
});

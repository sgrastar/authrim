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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  OP_VC: createMockFetcher('OP_VC'),
  OP_AUTH: createMockFetcher('OP_AUTH'),
  OP_TOKEN: createMockFetcher('OP_TOKEN'),
  OP_USERINFO: createMockFetcher('OP_USERINFO'),
  OP_MANAGEMENT: createMockFetcher('OP_MANAGEMENT'),
  OP_ASYNC: createMockFetcher('OP_ASYNC'),
  OP_SAML: createMockFetcher('OP_SAML'),
  EXTERNAL_IDP: createMockFetcher('EXTERNAL_IDP'),
});

describe('Router Worker', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  describe('HTTPS Redirect', () => {
    it('redirects external HTTP requests before routing to service bindings', async () => {
      const req = new Request('http://first.example.com/login');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(308);
      expect(res.headers.get('Location')).toBe('https://first.example.com/login');
      expect(mockEnv.OP_AUTH.fetch).not.toHaveBeenCalled();
    });

    it('allows loopback HTTP requests for local development', async () => {
      const req = new Request('http://localhost/api/health');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
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

      it('should route /.well-known/webfinger to OP_DISCOVERY', async () => {
        const req = new Request('https://example.com/.well-known/webfinger');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_DISCOVERY.fetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('OP_VC routes', () => {
      it('should route /.well-known/openid-credential-issuer to OP_VC', async () => {
        const req = new Request('https://example.com/.well-known/openid-credential-issuer');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_VC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /vci/* to OP_VC', async () => {
        const req = new Request('https://example.com/vci/credential', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_VC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /vp/* to OP_VC', async () => {
        const req = new Request('https://example.com/vp/authorize', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_VC.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /did/* to OP_VC', async () => {
        const req = new Request('https://example.com/did/resolve/did:web:example.com');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_VC.fetch).toHaveBeenCalledTimes(1);
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

      it('should route /flow/confirm to OP_AUTH', async () => {
        const req = new Request('https://example.com/flow/confirm');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /flow/login to OP_AUTH', async () => {
        const req = new Request('https://example.com/flow/login');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route POST /par to OP_AUTH', async () => {
        const req = new Request('https://example.com/par', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/auth/* to OP_AUTH', async () => {
        const req = new Request('https://example.com/api/auth/passkey/register');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /auth/* browser protocol helpers to OP_AUTH', async () => {
        const req = new Request('https://example.com/auth/login-challenge?challenge_id=test');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /auth/consent browser protocol helpers to OP_AUTH', async () => {
        const env = { ...mockEnv, ALLOWED_ORIGINS: 'https://example.com' };

        await app.fetch(new Request('https://example.com/auth/consent?challenge_id=test'), env);
        await app.fetch(
          new Request('https://example.com/auth/consent', {
            method: 'POST',
            headers: {
              Origin: 'https://example.com',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ challenge_id: 'test', approved: true }),
          }),
          env
        );

        expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(2);
      });

      it('should route /api/v1/registration-fields to OP_AUTH', async () => {
        const req = new Request('https://example.com/api/v1/registration-fields');
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

      it('should route /api/protected/customer-profiles/* to OP_USERINFO', async () => {
        const req = new Request('https://example.com/api/protected/customer-profiles/user-123');
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

      it('should return 404 when OP_ASYNC is not bound', async () => {
        const req = new Request('https://example.com/device_authorization', { method: 'POST' });
        const env = { ...mockEnv, OP_ASYNC: undefined };
        const res = await app.fetch(req, env);

        expect(res.status).toBe(404);
      });
    });

    describe('OP_MANAGEMENT routes', () => {
      it('should route POST /register to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/register', { method: 'POST' });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route GET /clients/:client_id to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/clients/client-123');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route PUT /clients/:client_id to OP_MANAGEMENT without router CSRF rejection', async () => {
        const req = new Request('https://example.com/clients/client-123', {
          method: 'PUT',
          headers: {
            Origin: 'https://foreign.example.test',
            Authorization: 'Bearer reg-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ client_name: 'Updated smoke client' }),
        });

        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route DELETE /clients/:client_id to OP_MANAGEMENT without router CSRF rejection', async () => {
        const req = new Request('https://example.com/clients/client-123', {
          method: 'DELETE',
          headers: {
            Origin: 'https://foreign.example.test',
            Authorization: 'Bearer reg-token',
          },
        });

        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/auth/discovery/grant/verify to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/api/auth/discovery/grant/verify', {
          method: 'POST',
        });
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

      it('should route /api/approval-artifacts/* to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/api/approval-artifacts/apc_123/portal');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/approval-receipts/* to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/api/approval-receipts/adr_123');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /auth/step-up/* to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/auth/step-up/start', {
          method: 'POST',
          headers: {
            Origin: 'https://app.example.test',
            Authorization: 'Bearer actor-token',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem-123',
          },
          body: JSON.stringify({ step_up_token: 'stu_123' }),
        });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route self-service /me/devices to OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/me/devices?limit=50', {
          headers: {
            Origin: 'https://app.example.test',
            Authorization: 'Bearer user-token',
          },
        });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route self-service /me/devices/:id mutations without router CSRF rejection', async () => {
        const req = new Request('https://example.com/me/devices/ins_123', {
          method: 'PATCH',
          headers: {
            Origin: 'https://app.example.test',
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ display_name: 'My iPhone' }),
        });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
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

      it.each([
        '/idp/profile/SAML2/POST/SSO',
        '/idp/profile/SAML2/Redirect/SSO',
        '/idp/profile/SAML2/POST/SLO',
        '/idp/profile/SAML2/Redirect/SLO',
      ])('should route %s to OP_SAML', async (path) => {
        const req = new Request(`https://example.com${path}`);
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
      });

      it('should not route Shibboleth 1.0 SSO profile to OP_SAML', async () => {
        const req = new Request('https://example.com/idp/profile/Shibboleth/SSO');
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).not.toHaveBeenCalled();
      });

      it('should route /api/admin/saml-providers to OP_SAML instead of OP_MANAGEMENT', async () => {
        const req = new Request('https://example.com/api/admin/saml-providers', {
          headers: { 'X-Tenant-Id': 'default' },
        });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
        expect(mockEnv.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
      });

      it('should route /api/admin/saml-attribute-presets to OP_SAML', async () => {
        const req = new Request('https://example.com/api/admin/saml-attribute-presets', {
          headers: { 'X-Tenant-Id': 'default' },
        });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
      });

      it('should route /api/admin/saml-settings to OP_SAML', async () => {
        const req = new Request('https://example.com/api/admin/saml-settings', {
          headers: { 'X-Tenant-Id': 'default' },
        });
        await app.fetch(req, mockEnv);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
        expect(mockEnv.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
      });

      it('should route /api/admin/saml-metadata/preview to OP_SAML', async () => {
        const envWithAdminOrigin = {
          ...mockEnv,
          ALLOWED_ORIGINS: 'https://admin.example.com',
        };
        const req = new Request('https://example.com/api/admin/saml-metadata/preview', {
          method: 'POST',
          headers: { Origin: 'https://admin.example.com', 'X-Tenant-Id': 'default' },
        });
        await app.fetch(req, envWithAdminOrigin);

        expect(mockEnv.OP_SAML.fetch).toHaveBeenCalledTimes(1);
      });

      it('should return 404 when OP_SAML is not bound', async () => {
        const req = new Request('https://example.com/saml/sp/metadata');
        const env = { ...mockEnv, OP_SAML: undefined };
        const res = await app.fetch(req, env);

        expect(res.status).toBe(404);
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

    it('should NOT apply CSP to /flow/* paths', async () => {
      const req = new Request('https://example.com/flow/confirm');
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

    it('should allow step-up and delegated-write request headers in preflight', async () => {
      const req = new Request('https://example.com/auth/step-up/actions/action_123/complete', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'Content-Type, Authorization, Idempotency-Key, Authrim-Step-Up-Receipt',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(204);
      const allowHeaders = res.headers.get('Access-Control-Allow-Headers');
      expect(allowHeaders).toContain('Idempotency-Key');
      expect(allowHeaders).toContain('Authrim-Step-Up-Receipt');
      expect(allowHeaders).not.toContain('X-Session-Id');
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

    it('should allow exact Admin UI origin with credentials for Admin API preflight', async () => {
      const envWithAdminOrigin = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://admin.example.com',
      };
      const req = new Request('https://api.example.com/api/admin/clients', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://admin.example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type, X-Tenant-Id',
        },
      });

      const res = await app.fetch(req, envWithAdminOrigin);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example.com');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      const allowHeaders = res.headers.get('Access-Control-Allow-Headers');
      expect(allowHeaders).toContain('X-Tenant-Id');
      expect(allowHeaders).not.toContain('X-Session-Id');
    });

    it('should not allow unrelated origins for Admin API credentialed CORS', async () => {
      const envWithAdminOrigin = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://admin.example.com',
      };
      const req = new Request('https://api.example.com/api/admin/clients', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type, X-Tenant-Id',
        },
      });

      const res = await app.fetch(req, envWithAdminOrigin);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });
  });

  describe('Bearer Token Transport', () => {
    it('should reject query access_token on canonical Authrim endpoints', async () => {
      const req = new Request('https://example.com/userinfo?access_token=leaked-token');
      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_details?.code).toBe('bearer_token_transport_unsupported');
      expect(mockEnv.OP_USERINFO.fetch).not.toHaveBeenCalled();
    });

    it('should reject form access_token on canonical Authrim endpoints', async () => {
      const req = new Request('https://example.com/userinfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'access_token=leaked-token',
      });
      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as {
        error: string;
        error_details?: { code?: string };
      };

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_details?.code).toBe('bearer_token_transport_unsupported');
      expect(mockEnv.OP_USERINFO.fetch).not.toHaveBeenCalled();
    });

    it('should not apply query access_token rejection to external IdP callbacks', async () => {
      const req = new Request(
        'https://example.com/auth/external/github/callback?access_token=provider-token'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(mockEnv.EXTERNAL_IDP.fetch).toHaveBeenCalledTimes(1);
    });

    it('should route legacy api external IdP callbacks to the bridge', async () => {
      const req = new Request('https://example.com/api/external/github/callback?code=code');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(mockEnv.EXTERNAL_IDP.fetch).toHaveBeenCalledTimes(1);
    });

    it('should route handoff finalize to external IdP bridge', async () => {
      const env = { ...mockEnv, ALLOWED_ORIGINS: 'https://example.com' };
      const req = new Request('https://example.com/handoff/finalize', {
        method: 'POST',
        headers: { Origin: 'https://example.com' },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockEnv.EXTERNAL_IDP.fetch).toHaveBeenCalledTimes(1);
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

    it('should forward original host hints to service bindings', async () => {
      const req = new Request('https://first.multi-tenant.authrim.com/token', {
        method: 'POST',
        body: 'grant_type=client_credentials',
      });
      await app.fetch(req, mockEnv);

      const forwardedRequest = mockEnv.OP_TOKEN.fetch.mock.calls[0][0];
      expect(forwardedRequest.headers.get('X-Authrim-Forwarded-Host')).toBe(
        'first.multi-tenant.authrim.com'
      );
      expect(forwardedRequest.headers.get('X-Forwarded-Host')).toBe(
        'first.multi-tenant.authrim.com'
      );
    });

    it('should overwrite spoofed forwarded host hints at the router boundary', async () => {
      const req = new Request('https://first.multi-tenant.authrim.com/token', {
        method: 'POST',
        headers: {
          'X-Authrim-Forwarded-Host': 'attacker.example.com',
          'X-Forwarded-Host': 'attacker.example.com',
        },
        body: 'grant_type=client_credentials',
      });
      await app.fetch(req, mockEnv);

      const forwardedRequest = mockEnv.OP_TOKEN.fetch.mock.calls[0][0];
      expect(forwardedRequest.headers.get('X-Authrim-Forwarded-Host')).toBe(
        'first.multi-tenant.authrim.com'
      );
      expect(forwardedRequest.headers.get('X-Forwarded-Host')).toBe(
        'first.multi-tenant.authrim.com'
      );
    });

    it('should allow POST from tenant subdomain origin in multi-tenant mode', async () => {
      const mtEnv = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'acme',
      };
      const req = new Request('https://acme.example.com/login', {
        method: 'POST',
        headers: {
          Host: 'acme.example.com',
          Origin: 'https://acme.example.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'email=user%40example.com',
      });

      const res = await app.fetch(req, mtEnv);

      // Should NOT return 403 csrf_validation_failed
      expect(res.status).not.toBe(403);
    });

    it('should block POST from a foreign origin in multi-tenant mode', async () => {
      const mtEnv = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'acme',
      };
      const req = new Request('https://acme.example.com/login', {
        method: 'POST',
        headers: {
          Host: 'acme.example.com',
          Origin: 'https://evil.attacker.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'email=user%40example.com',
      });

      const res = await app.fetch(req, mtEnv);
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(403);
      expect(body.error).toBe('csrf_validation_failed');
    });

    it('should allow state-changing Admin API requests from exact Admin UI origin', async () => {
      const envWithAdminOrigin = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://admin.example.com',
      };
      const req = new Request('https://api.example.com/api/admin/clients', {
        method: 'POST',
        headers: {
          Origin: 'https://admin.example.com',
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'first',
        },
        body: JSON.stringify({ client_name: 'Test Client' }),
      });

      const res = await app.fetch(req, envWithAdminOrigin);

      expect(res.status).toBe(200);
      expect(mockEnv.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
      const forwardedRequest = mockEnv.OP_MANAGEMENT.fetch.mock.calls[0][0];
      expect(new URL(forwardedRequest.url).pathname).toBe('/api/admin/clients');
      expect(forwardedRequest.headers.get('X-Tenant-Id')).toBe('first');
    });

    it('should block state-changing Admin API requests from unrelated origins', async () => {
      const envWithAdminOrigin = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://admin.example.com',
      };
      const req = new Request('https://api.example.com/api/admin/clients', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ client_name: 'Test Client' }),
      });

      const res = await app.fetch(req, envWithAdminOrigin);
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(403);
      expect(body.error).toBe('csrf_validation_failed');
      expect(mockEnv.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    it('should bypass router CSRF for initial admin setup API and forward the request', async () => {
      const envWithOrigins = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://login.example.com',
      };
      const req = new Request('https://example.com/api/admin-init-setup/initialize', {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          setup_token: 'token',
          email: 'admin@example.com',
          csrf_token: 'csrf',
        }),
      });

      const res = await app.fetch(req, envWithOrigins);

      expect(res.status).toBe(200);
      expect(mockEnv.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
      const forwardedRequest = mockEnv.OP_AUTH.fetch.mock.calls[0][0];
      expect(new URL(forwardedRequest.url).pathname).toBe('/api/admin-init-setup/initialize');
    });

    it('should proxy login-ui redirects without following them server-side', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: {
            Location: 'https://first.example.com/login',
          },
        })
      );

      const envWithLoginUi = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'first',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://login-ui.example.com',
      };

      const req = new Request('https://example.com/discover?/resolve', {
        method: 'POST',
        headers: {
          Host: 'example.com',
          Origin: 'https://example.com',
          Referer: 'https://example.com/discover',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'mode=tenant_code&value=first',
      });

      const res = await app.fetch(req, envWithLoginUi);

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('https://first.example.com/login');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const proxiedRequest = fetchMock.mock.calls[0]?.[0];
      expect(proxiedRequest).toBeInstanceOf(Request);
      expect((proxiedRequest as Request).redirect).toBe('manual');
    });

    it('should proxy login UI through service binding when configured', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const envWithLoginUi = {
        ...mockEnv,
        ALLOWED_ORIGINS: 'https://first.example.com',
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'first',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
      };

      const req = new Request('https://first.example.com/login?client_id=test');
      const res = await app.fetch(req, envWithLoginUi);

      expect(res.status).toBe(200);
      expect(loginUiWorker.fetch).toHaveBeenCalledTimes(1);

      const proxiedRequest = loginUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).origin).toBe(
        'https://phase9-ar-login-ui.example.workers.dev'
      );
      expect(new URL(proxiedRequest.url).pathname).toBe('/login');
      expect(new URL(proxiedRequest.url).search).toBe('?client_id=test');
      expect(proxiedRequest.headers.get('X-Authrim-Original-Host')).toBe('first.example.com');
    });

    it('should proxy tenant root requests to Login UI when configured', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const envWithLoginUi = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
      };

      const req = new Request('https://first.example.com/');
      const res = await app.fetch(req, envWithLoginUi);

      expect(res.status).toBe(200);
      expect(loginUiWorker.fetch).toHaveBeenCalledTimes(1);

      const proxiedRequest = loginUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).origin).toBe(
        'https://phase9-ar-login-ui.example.workers.dev'
      );
      expect(new URL(proxiedRequest.url).pathname).toBe('/');
      expect(proxiedRequest.headers.get('X-Authrim-Original-Host')).toBe('first.example.com');
    });

    it('should proxy naked-domain root requests to Login UI when Login UI shares the API host', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithLoginUiOnApiHost = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        ADMIN_UI_URL: 'https://admin.example.com',
        LOGIN_UI_URL: 'https://example.com',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const req = new Request('https://example.com/');
      const res = await app.fetch(req, envWithLoginUiOnApiHost);

      expect(res.status).toBe(200);
      expect(loginUiWorker.fetch).toHaveBeenCalledTimes(1);
      expect(adminUiWorker.fetch).not.toHaveBeenCalled();

      const proxiedRequest = loginUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).pathname).toBe('/');
      expect(proxiedRequest.headers.get('X-Authrim-Original-Host')).toBe('example.com');
    });

    it('should proxy admin UI through service binding when configured', async () => {
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithAdminUi = {
        ...mockEnv,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const req = new Request('https://admin.example.com/admin/info');
      const res = await app.fetch(req, envWithAdminUi);

      expect(res.status).toBe(200);
      expect(adminUiWorker.fetch).toHaveBeenCalledTimes(1);

      const proxiedRequest = adminUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).origin).toBe(
        'https://phase9-ar-admin-ui.example.workers.dev'
      );
      expect(new URL(proxiedRequest.url).pathname).toBe('/admin/info');
      expect(proxiedRequest.headers.get('X-Authrim-Original-Host')).toBe('admin.example.com');
    });

    it('should return explicit 404 responses when UI proxies are not enabled', async () => {
      const adminResponse = await app.fetch(
        new Request('https://admin.example.com/admin/info'),
        mockEnv
      );
      const adminBody = (await adminResponse.json()) as Record<string, string>;
      expect(adminResponse.status).toBe(404);
      expect(adminBody.message).toBe('Admin UI proxy is not enabled');
      expect(adminBody.hint).toContain('ENABLE_ADMIN_UI_PROXY=true');

      const setupResponse = await app.fetch(
        new Request('https://admin.example.com/setup/complete'),
        mockEnv
      );
      const setupBody = (await setupResponse.json()) as Record<string, string>;
      expect(setupResponse.status).toBe(404);
      expect(setupBody.message).toBe('Admin UI proxy is not enabled');

      const adminRootResponse = await app.fetch(
        new Request('https://admin.example.com/admin'),
        mockEnv
      );
      const adminRootBody = (await adminRootResponse.json()) as Record<string, string>;
      expect(adminRootResponse.status).toBe(404);
      expect(adminRootBody.message).toBe('Admin UI proxy is not enabled');

      const loginSubpathResponse = await app.fetch(
        new Request('https://first.example.com/login/reset-password'),
        mockEnv
      );
      const loginSubpathBody = (await loginSubpathResponse.json()) as Record<string, string>;
      expect(loginSubpathResponse.status).toBe(404);
      expect(loginSubpathBody.message).toBe('Login UI proxy is not enabled');

      const geoResponse = await app.fetch(
        new Request('https://admin.example.com/geo/world.json'),
        mockEnv
      );
      const geoBody = (await geoResponse.json()) as Record<string, string>;
      expect(geoResponse.status).toBe(404);
      expect(geoBody.message).toBe('Admin UI proxy is not enabled');
    });

    it('should rewrite Origin and Referer when proxying state-changing Login UI requests', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const envWithLoginUi = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'first',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
      };

      const req = new Request('https://first.example.com/signup', {
        method: 'POST',
        headers: {
          Host: 'first.example.com',
          Origin: 'https://first.example.com',
          Referer: 'https://first.example.com/signup?client_id=test',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'email=user%40example.com',
      });
      const res = await app.fetch(req, envWithLoginUi);

      expect(res.status).toBe(200);
      const proxiedRequest = loginUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).origin).toBe(
        'https://phase9-ar-login-ui.example.workers.dev'
      );
      expect(proxiedRequest.headers.get('Origin')).toBe(
        'https://phase9-ar-login-ui.example.workers.dev'
      );
      expect(proxiedRequest.headers.get('Referer')).toBe(
        'https://phase9-ar-login-ui.example.workers.dev/signup?client_id=test'
      );
    });

    it('should proxy Login UI static assets through the dedicated namespace', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithLoginAssetProxy = {
        ...mockEnv,
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const req = new Request('https://example.com/_authrim_login/immutable/chunk.js');
      const res = await app.fetch(req, envWithLoginAssetProxy);
      const body = (await res.json()) as { worker: string };

      expect(res.status).toBe(200);
      expect(body.worker).toBe('LOGIN_UI_WORKER');
      expect(loginUiWorker.fetch).toHaveBeenCalledTimes(1);
      expect(adminUiWorker.fetch).not.toHaveBeenCalled();
      expect(new URL(loginUiWorker.fetch.mock.calls[0][0].url).origin).toBe(
        'https://phase9-ar-login-ui.example.workers.dev'
      );
      expect(new URL(loginUiWorker.fetch.mock.calls[0][0].url).pathname).toBe(
        '/_authrim_login/immutable/chunk.js'
      );
    });

    it('should proxy Admin UI static assets through the dedicated namespace', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithAdminAssetProxy = {
        ...mockEnv,
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const req = new Request('https://example.com/_authrim_admin/immutable/chunk.js');
      const res = await app.fetch(req, envWithAdminAssetProxy);
      const body = (await res.json()) as { worker: string };

      expect(res.status).toBe(200);
      expect(body.worker).toBe('ADMIN_UI_WORKER');
      expect(adminUiWorker.fetch).toHaveBeenCalledTimes(1);
      expect(loginUiWorker.fetch).not.toHaveBeenCalled();
      expect(new URL(adminUiWorker.fetch.mock.calls[0][0].url).origin).toBe(
        'https://phase9-ar-admin-ui.example.workers.dev'
      );
      expect(new URL(adminUiWorker.fetch.mock.calls[0][0].url).pathname).toBe(
        '/_authrim_admin/immutable/chunk.js'
      );
    });

    it('should not proxy /_app assets to Authrim UI workers', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithUis = {
        ...mockEnv,
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const res = await app.fetch(
        new Request('https://example.com/_app/immutable/missing.js'),
        envWithUis
      );
      const body = (await res.json()) as Record<string, string>;

      expect(res.status).toBe(404);
      expect(body.message).toBe('The requested resource was not found');
      expect(loginUiWorker.fetch).not.toHaveBeenCalled();
      expect(adminUiWorker.fetch).not.toHaveBeenCalled();
    });

    it('should keep admin root requests on Admin UI when both UI proxies are configured', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithUis = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        ADMIN_UI_URL: 'https://admin.example.com',
        LOGIN_UI_URL: 'https://example.com',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const req = new Request('https://admin.example.com/');
      const res = await app.fetch(req, envWithUis);

      expect(res.status).toBe(200);
      expect(adminUiWorker.fetch).toHaveBeenCalledTimes(1);
      expect(loginUiWorker.fetch).not.toHaveBeenCalled();

      const proxiedRequest = adminUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).pathname).toBe('/');
      expect(proxiedRequest.headers.get('X-Authrim-Original-Host')).toBe('admin.example.com');
    });

    it('should prefer Login UI at root when API, Admin UI, and Login UI share one host', async () => {
      const loginUiWorker = createMockFetcher('LOGIN_UI_WORKER');
      const adminUiWorker = createMockFetcher('ADMIN_UI_WORKER');
      const envWithSharedHostUis = {
        ...mockEnv,
        BASE_DOMAIN: 'example.com',
        ADMIN_UI_URL: 'https://example.com',
        LOGIN_UI_URL: 'https://example.com',
        ENABLE_LOGIN_UI_PROXY: 'true',
        AR_LOGIN_UI_URL: 'https://phase9-ar-login-ui.example.workers.dev',
        LOGIN_UI_WORKER: loginUiWorker,
        ENABLE_ADMIN_UI_PROXY: 'true',
        AR_ADMIN_UI_URL: 'https://phase9-ar-admin-ui.example.workers.dev',
        ADMIN_UI_WORKER: adminUiWorker,
      };

      const req = new Request('https://example.com/');
      const res = await app.fetch(req, envWithSharedHostUis);

      expect(res.status).toBe(200);
      expect(loginUiWorker.fetch).toHaveBeenCalledTimes(1);
      expect(adminUiWorker.fetch).not.toHaveBeenCalled();

      const proxiedRequest = loginUiWorker.fetch.mock.calls[0][0];
      expect(new URL(proxiedRequest.url).pathname).toBe('/');
      expect(proxiedRequest.headers.get('X-Authrim-Original-Host')).toBe('example.com');
    });

    it('should return API metadata at root when no UI proxy is enabled', async () => {
      const res = await app.fetch(new Request('https://api.example.com/'), mockEnv);
      const body = (await res.json()) as {
        name: string;
        endpoints: Record<string, string>;
      };

      expect(res.status).toBe(200);
      expect(body.name).toBe('Authrim OIDC Provider');
      expect(body.endpoints).toMatchObject({
        discovery: '/.well-known/openid-configuration',
        authorize: '/authorize',
        token: '/token',
        userinfo: '/userinfo',
      });
    });

    it('should convert service binding failures into router server_error responses', async () => {
      const envWithFailingToken = {
        ...mockEnv,
        OP_TOKEN: {
          fetch: vi.fn(async () => {
            throw new Error('token worker unavailable');
          }),
        },
      };

      const res = await app.fetch(
        new Request('https://example.com/token', {
          method: 'POST',
          body: 'grant_type=client_credentials',
        }),
        envWithFailingToken
      );
      const body = (await res.json()) as Record<string, string>;

      expect(res.status).toBe(500);
      expect(body.error).toBe('server_error');
      expect(body.error_description).toBe('An unexpected error occurred in the router');
    });
  });
});

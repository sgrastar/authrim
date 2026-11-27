/**
 * Mutation-driven tests: security headers path exclusions and CORS origin handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../index';
import {
  createMockEnv,
  createMockFetcher,
  createMockKV,
  isolateGlobalCaches,
  type MockEnv,
} from './helpers/router-env';

describe('security headers', () => {
  let env: MockEnv;
  let restore: () => void;
  beforeEach(() => {
    restore = isolateGlobalCaches();
    env = createMockEnv();
  });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it('applies the full header set to a regular API path', async () => {
    const res = await app.fetch(new Request('https://example.com/api/health'), env);
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "media-src 'self'",
      "frame-src 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload'
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  const skipped = [
    '/authorize',
    '/authorize/x',
    '/oauth/admin-agent/authorize',
    '/session/check',
    '/logout',
    '/some/frontchannel-logout',
    '/logged-out',
    '/logout-complete',
    '/admin-init-setup',
    '/admin-init-setup/x',
    '/api/ciba/test',
    '/saml/idp/metadata',
    '/idp/profile/SAML2/POST/SSO',
    '/idp/profile/SAML2/Redirect/SSO',
    '/idp/profile/SAML2/POST/SLO',
    '/idp/profile/SAML2/Redirect/SLO',
    '/setup/x',
    '/admin/x',
    '/discover/x',
    '/invite/x',
    '/login/x',
    '/signup/x',
    '/consent/x',
    '/device/x',
    '/ciba/x',
    '/reauth/x',
    '/verify-email-code/x',
    '/error/x',
    '/api/set-language/x',
    '/callback/x',
    '/statements/x',
    '/_authrim_login/x',
    '/_authrim_admin/x',
    '/',
  ];

  it.each(skipped)('leaves headers to the owning worker for %s', async (path) => {
    const res = await app.fetch(new Request(`https://example.com${path}`), env);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  describe('UI proxy paths', () => {
    const proxied = () => ({
      ...env,
      ENABLE_LOGIN_UI_PROXY: 'true',
      AR_LOGIN_UI_URL: 'https://ui.example.workers.dev',
      LOGIN_UI_WORKER: {
        fetch: vi.fn(
          async () =>
            new Response('ui', {
              headers: { 'Content-Security-Policy': "default-src 'self' cdn.example" },
            })
        ),
      },
    });

    it('does not overwrite a CSP set by the proxied Login UI Worker', async () => {
      const res = await app.fetch(new Request('https://example.com/login/x'), proxied());
      expect(res.headers.get('content-security-policy')).toBe("default-src 'self' cdn.example");
      expect(res.headers.get('x-frame-options')).toBeNull();
    });

    it('adds no router headers to its own 404 when the UI proxy is disabled', async () => {
      const res = await app.fetch(new Request('https://example.com/login/x'), env);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-security-policy')).toBeNull();
    });

    it('still applies router headers to the normal fallback response', async () => {
      const res = await app.fetch(new Request('https://example.com/no/such/path'), proxied());
      expect(res.status).toBe(404);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    });
  });

  const notSkipped = [
    '/authorized',
    '/oauth/admin-agent/authorized',
    '/session/checkx',
    '/logouts',
    '/logged-outx',
    '/logout-completed',
    '/idp/profile/SAML2/POST/SSOx',
    '/idp/profile/SAML2/x',
    '/statements',
    '/foo/api/ciba/test',
    '/sampl/x',
    '/saml',
  ];

  it.each(notSkipped)('still applies headers to the lookalike path %s', async (path) => {
    const res = await app.fetch(new Request(`https://example.com${path}`), env);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  describe('account page prefix', () => {
    const settings = (tenant: string, enabled: boolean) =>
      createMockKV({
        [`settings:tenant:${tenant}:self-service`]: JSON.stringify({
          'self-service.account_page_enabled': enabled,
          'self-service.account_page_path': '/my-acct',
        }),
      });
    const base = () => ({
      ...env,
      ENABLE_LOGIN_UI_PROXY: 'true',
      AR_LOGIN_UI_URL: 'https://ui.example.workers.dev',
      LOGIN_UI_WORKER: createMockFetcher('LOGIN_UI_WORKER'),
    });

    it('is left to the Login UI when the account page is enabled', async () => {
      const e = { ...base(), DEFAULT_TENANT_ID: 'hdr-on', SETTINGS: settings('hdr-on', true) };
      const res = await app.fetch(new Request('https://example.com/my-acct/x'), e);
      expect(res.headers.get('x-frame-options')).toBeNull();
    });

    it('keeps headers when the account page is disabled', async () => {
      const e = { ...base(), DEFAULT_TENANT_ID: 'hdr-off', SETTINGS: settings('hdr-off', false) };
      const res = await app.fetch(new Request('https://example.com/my-acct/x'), e);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('keeps headers when the Login UI path proxy is off', async () => {
      const e = {
        ...base(),
        ENABLE_LOGIN_UI_PROXY: 'false',
        DEFAULT_TENANT_ID: 'hdr-noproxy',
        SETTINGS: settings('hdr-noproxy', true),
      };
      const res = await app.fetch(new Request('https://example.com/my-acct/x'), e);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('keeps headers when AR_LOGIN_UI_URL is missing', async () => {
      const e = {
        ...base(),
        AR_LOGIN_UI_URL: undefined,
        DEFAULT_TENANT_ID: 'hdr-nourl',
        SETTINGS: settings('hdr-nourl', true),
      };
      const res = await app.fetch(new Request('https://example.com/my-acct/x'), e);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('accepts ENABLE_LOGIN_UI_PATH_PROXY as the enabling flag', async () => {
      const e = {
        ...base(),
        ENABLE_LOGIN_UI_PROXY: undefined,
        ENABLE_LOGIN_UI_PATH_PROXY: 'true',
        DEFAULT_TENANT_ID: 'hdr-path',
        SETTINGS: settings('hdr-path', true),
      };
      const res = await app.fetch(new Request('https://example.com/my-acct'), e);
      expect(res.headers.get('x-frame-options')).toBeNull();
    });

    it('keeps headers for paths merely sharing the prefix text', async () => {
      const e = { ...base(), DEFAULT_TENANT_ID: 'hdr-pre', SETTINGS: settings('hdr-pre', true) };
      const res = await app.fetch(new Request('https://example.com/my-acctx'), e);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });
  });
});

describe('CORS', () => {
  let env: MockEnv;
  let restore: () => void;
  beforeEach(() => {
    restore = isolateGlobalCaches();
    env = createMockEnv();
  });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  const preflight = (origin: string, host = 'example.com') =>
    new Request(`https://${host}/api/health`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });

  it('advertises the exact method, header and max-age contract on preflight', async () => {
    const res = await app.fetch(preflight('https://rp.example'), env);
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    );
    expect(res.headers.get('access-control-allow-headers')?.split(',')).toEqual([
      'Content-Type',
      'Authorization',
      'DPoP',
      'If-Match',
      'If-None-Match',
      'X-Tenant-Id',
      'X-Diagnostic-Session-Id',
      'X-Authrim-Human-Verification-Action',
      'X-Authrim-Interaction-Id',
      'Idempotency-Key',
      'Authrim-Step-Up-Receipt',
    ]);
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rp.example');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('exposes rate limit, ETag and Location headers', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/health', { headers: { Origin: 'https://rp.example' } }),
      env
    );
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,ETag,Location'
    );
  });

  it('treats a blank allowlist as unset (reflect, no credentials)', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/health', { headers: { Origin: 'https://rp.example' } }),
      { ...env, ALLOWED_ORIGINS: ' , ' }
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rp.example');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('enables credentials only with a non-empty allowlist', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/health', { headers: { Origin: 'https://ok.example' } }),
      { ...env, ALLOWED_ORIGINS: 'https://ok.example' }
    );
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not send CORS headers on /mcp (owner worker handles them)', async () => {
    const res = await app.fetch(
      new Request('https://example.com/mcp', {
        method: 'POST',
        headers: { Origin: 'https://rp.example' },
      }),
      env
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  describe('tenant KV allowlist', () => {
    const key = (t: string) => `settings:tenant:${t}:tenant`;
    const get = async (e: Record<string, unknown>, origin: string, host = 'example.com') =>
      (
        await app.fetch(
          new Request(`https://${host}/api/health`, { headers: { Origin: origin, Host: host } }),
          e
        )
      ).headers.get('access-control-allow-origin');

    it('prefers SETTINGS over AUTHRIM_CONFIG and over the env fallback', async () => {
      const e = {
        ...env,
        DEFAULT_TENANT_ID: 'cors-a',
        ALLOWED_ORIGINS: 'https://env.example',
        SETTINGS: createMockKV({
          [key('cors-a')]: JSON.stringify({ 'tenant.allowed_origins': 'https://settings.example' }),
        }),
        AUTHRIM_CONFIG: createMockKV({
          [key('cors-a')]: JSON.stringify({ 'tenant.allowed_origins': 'https://config.example' }),
        }),
      };
      expect(await get(e, 'https://settings.example')).toBe('https://settings.example');
      expect(await get(e, 'https://config.example')).toBeNull();
      expect(await get(e, 'https://env.example')).toBeNull();
    });

    it('falls back to AUTHRIM_CONFIG when SETTINGS has no entry', async () => {
      const e = {
        ...env,
        DEFAULT_TENANT_ID: 'cors-b',
        SETTINGS: createMockKV(),
        AUTHRIM_CONFIG: createMockKV({
          [key('cors-b')]: JSON.stringify({ 'tenant.allowed_origins': 'https://config.example' }),
        }),
      };
      expect(await get(e, 'https://config.example')).toBe('https://config.example');
      expect(await get(e, 'https://other.example')).toBeNull();
    });

    it('uses the tenant of the request host in multi-tenant mode', async () => {
      const e = {
        ...env,
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'cors-default',
        AUTHRIM_CONFIG: createMockKV({
          [key('acme')]: JSON.stringify({ 'tenant.allowed_origins': 'https://acme.example' }),
          [key('cors-default')]: JSON.stringify({
            'tenant.allowed_origins': 'https://default.example',
          }),
        }),
      };
      expect(await get(e, 'https://acme.example', 'acme.example.com')).toBe('https://acme.example');
      expect(await get(e, 'https://default.example', 'acme.example.com')).toBeNull();
    });

    it('uses the default tenant when the host does not resolve to a tenant', async () => {
      const e = {
        ...env,
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'cors-fallback',
        AUTHRIM_CONFIG: createMockKV({
          [key('cors-fallback')]: JSON.stringify({
            'tenant.allowed_origins': 'https://default.example',
          }),
        }),
      };
      expect(await get(e, 'https://default.example', 'unrelated.test')).toBe(
        'https://default.example'
      );
    });

    it.each([
      ['an empty string', JSON.stringify({ 'tenant.allowed_origins': '' })],
      ['a non-string value', JSON.stringify({ 'tenant.allowed_origins': ['https://a.example'] })],
      ['invalid JSON', '{not json'],
    ])('ignores %s and uses the env fallback', async (_name, raw) => {
      const e = {
        ...env,
        DEFAULT_TENANT_ID: 'cors-c',
        ALLOWED_ORIGINS: 'https://env.example',
        AUTHRIM_CONFIG: createMockKV({ [key('cors-c')]: raw }),
      };
      expect(await get(e, 'https://env.example')).toBe('https://env.example');
      expect(await get(e, 'https://other.example')).toBeNull();
    });

    it('survives a failing KV read', async () => {
      const e = {
        ...env,
        DEFAULT_TENANT_ID: 'cors-d',
        ALLOWED_ORIGINS: 'https://env.example',
        AUTHRIM_CONFIG: {
          get: vi.fn(async () => {
            throw new Error('kv down');
          }),
        },
      };
      expect(await get(e, 'https://env.example')).toBe('https://env.example');
    });

    it('supports wildcard allowlist entries', async () => {
      const e = { ...env, ALLOWED_ORIGINS: 'https://*.wild.example' };
      expect(await get(e, 'https://a.wild.example')).toBe('https://a.wild.example');
      expect(await get(e, 'https://wild.example.evil.test')).toBeNull();
    });
  });
});

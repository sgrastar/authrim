import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminExternalProvidersDiscoverOidcHandler,
  adminExternalProvidersListHandler,
  adminExternalProvidersRegisterHandler,
} from '../external-providers';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/discover', adminExternalProvidersDiscoverOidcHandler);
  return app;
}

function createProxyApp() {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    await next();
  });
  app.get('/providers', adminExternalProvidersListHandler);
  app.post('/providers/:id/register', adminExternalProvidersRegisterHandler);
  return app;
}

describe('external provider discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects discovered OIDC endpoints that are not HTTPS and external-safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              issuer: 'https://issuer.example/',
              authorization_endpoint: 'https://127.0.0.1/authorize',
              token_endpoint: 'https://issuer.example/token',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const res = await createApp().request(
      '/discover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://issuer.example' }),
      },
      {} as Env
    );
    const payload = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(payload.error).toContain('Invalid OIDC configuration');
  });

  it('returns only sanitized safe OIDC metadata fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              issuer: 'https://issuer.example/',
              authorization_endpoint: 'https://issuer.example/authorize',
              token_endpoint: 'https://issuer.example/token',
              jwks_uri: 'https://issuer.example/jwks.json',
              malicious_html: '<script>alert(1)</script>',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const res = await createApp().request(
      '/discover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://issuer.example' }),
      },
      {} as Env
    );
    const payload = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(payload).toEqual({
      issuer: 'https://issuer.example/',
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
      jwks_uri: 'https://issuer.example/jwks.json',
    });
  });

  it('resolves an acct resource with WebFinger before fetching OIDC discovery', async () => {
    const resource = 'acct:alice@example.com';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          subject: resource,
          links: [
            {
              rel: 'http://openid.net/specs/connect/1.0/issuer',
              href: 'https://issuer.example',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/authorize',
          token_endpoint: 'https://issuer.example/token',
          jwks_uri: 'https://issuer.example/jwks.json',
        })
      );
    vi.stubGlobal('fetch', fetch);

    const res = await createApp().request(
      '/discover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource }),
      },
      {} as Env
    );
    const payload = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://example.com/.well-known/webfinger?resource=acct%3Aalice%40example.com'
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://issuer.example/.well-known/openid-configuration'
    );
    expect(payload.discovery_source).toEqual({
      method: 'webfinger',
      resource,
      webfinger_endpoint: 'https://example.com/.well-known/webfinger',
    });
  });

  it('rejects a WebFinger response whose subject does not match the requested resource', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          subject: 'acct:mallory@example.com',
          links: [
            {
              rel: 'http://openid.net/specs/connect/1.0/issuer',
              href: 'https://issuer.example',
            },
          ],
        })
      )
    );

    const res = await createApp().request(
      '/discover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'acct:alice@example.com' }),
      },
      {} as Env
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to resolve a valid OIDC issuer with WebFinger',
    });
  });
});

describe('external provider service-binding proxy', () => {
  it('forwards the public issuer host and bearer token to ar-bridge', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ providers: [] }, { status: 200 })
    );
    const response = await createProxyApp().request(
      'https://tenant-1.conformance.authrim.com/providers',
      { headers: { Authorization: 'Bearer machine-access-token' } },
      { EXTERNAL_IDP: { fetch } } as unknown as Env
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://external-idp/api/admin/external-providers',
      expect.objectContaining({
        method: 'GET',
        headers: expect.any(Headers),
      })
    );
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    const headers = request.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer machine-access-token');
    expect(headers.get('X-Tenant-Id')).toBe('tenant-1');
    expect(headers.get('X-Authrim-Forwarded-Host')).toBe('tenant-1.conformance.authrim.com');
    expect(headers.get('X-Forwarded-Proto')).toBe('https');
  });

  it('proxies dynamic registration to the provider-specific bridge route', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ registered: true, provider: { id: 'provider/1' } }, { status: 200 })
    );
    const response = await createProxyApp().request(
      'https://tenant-1.conformance.authrim.com/providers/provider%2F1/register',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer machine-access-token',
          'Content-Type': 'application/json',
          'X-Diagnostic-Session-Id': 'oidf-module-1',
        },
        body: '{}',
      },
      { EXTERNAL_IDP: { fetch } } as unknown as Env
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://external-idp/api/admin/external-providers/provider%2F1/register',
      expect.objectContaining({ method: 'POST', body: '{}' })
    );
    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('X-Diagnostic-Session-Id')).toBe('oidf-module-1');
  });
});

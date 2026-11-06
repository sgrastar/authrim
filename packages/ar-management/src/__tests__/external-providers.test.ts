import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stepUp = vi.hoisted(() => ({ gate: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp.gate,
  refuseAdminFreshAuth: vi.fn(),
}));
import type { Env } from '@authrim/ar-lib-core';
import {
  adminExternalProvidersDiscoverOidcHandler,
  adminExternalProvidersListHandler,
  adminExternalProvidersRegisterHandler,
  adminExternalProvidersCreateHandler,
  adminExternalProvidersUpdateHandler,
  adminExternalProvidersDeleteHandler,
  adminExternalTokenRefreshConfigGetHandler,
  adminExternalTokenRefreshConfigUpdateHandler,
  adminExternalTokenRefreshRunHandler,
  adminExternalTokenRefreshRunsListHandler,
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
  app.post('/providers', adminExternalProvidersCreateHandler);
  app.put('/providers/:id', adminExternalProvidersUpdateHandler);
  app.delete('/providers/:id', adminExternalProvidersDeleteHandler);
  app.get('/refresh/config', adminExternalTokenRefreshConfigGetHandler);
  app.put('/refresh/config', adminExternalTokenRefreshConfigUpdateHandler);
  app.get('/refresh/runs', adminExternalTokenRefreshRunsListHandler);
  app.post('/refresh/run', adminExternalTokenRefreshRunHandler);
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
      { EXTERNAL_IDP_ADMIN: { fetch } } as unknown as Env
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
      { EXTERNAL_IDP_ADMIN: { fetch } } as unknown as Env
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

describe('external IdP admin binding', () => {
  const req = (method: string, path: string, env: unknown) =>
    createProxyApp().request(
      `https://tenant-1.example.com${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'PUT' ? '{}' : undefined,
      },
      env as Env
    );

  it('never uses the plain EXTERNAL_IDP binding for admin calls (503 when only it is bound)', async () => {
    const fetch = vi.fn();
    for (const [method, path] of [
      ['GET', '/providers'],
      ['GET', '/refresh/config'],
      ['GET', '/refresh/runs'],
      ['PUT', '/refresh/config'],
      ['POST', '/refresh/run'],
    ]) {
      const response = await req(method, path, { EXTERNAL_IDP: { fetch } });
      expect(response.status).toBe(503);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the empty list / default config only when both bindings are absent', async () => {
    expect(await (await req('GET', '/providers', {})).json()).toEqual({ providers: [] });
    expect((await req('GET', '/refresh/runs', {})).status).toBe(200);
    expect((await req('GET', '/refresh/config', {})).status).toBe(200);
    expect((await req('POST', '/refresh/run', {})).status).toBe(503);
  });

  it('routes token-refresh config and run through the admin binding', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    expect((await req('PUT', '/refresh/config', { EXTERNAL_IDP_ADMIN: { fetch } })).status).toBe(
      200
    );
    expect((await req('POST', '/refresh/run', { EXTERNAL_IDP_ADMIN: { fetch } })).status).toBe(200);
    expect((fetch.mock.calls as unknown[][]).map(([url]) => url)).toEqual([
      'https://external-idp/api/admin/external-token-refresh/config',
      'https://external-idp/api/admin/external-token-refresh/run',
    ]);
  });
});

describe('external provider trust changes need step-up', () => {
  beforeEach(() => {
    stepUp.gate.mockReset();
    stepUp.gate.mockResolvedValue(null);
  });
  const secretBody = JSON.stringify({
    name: 'IdP',
    client_id: 'abc',
    client_secret: 'very-secret',
  });
  const digest = async (value: string) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
  const refusal = () =>
    new Response(JSON.stringify({ error: 'step_up_required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  const call = (
    method: string,
    path: string,
    body: string | undefined,
    fetch: ReturnType<typeof vi.fn>
  ) =>
    createProxyApp().request(
      `https://tenant-1.example.com${path}`,
      { method, headers: { 'Content-Type': 'application/json' }, body },
      { EXTERNAL_IDP_ADMIN: { fetch } }
    );
  const okFetch = () => vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
  const forwardedMethods = (fetch: ReturnType<typeof vi.fn>) =>
    (fetch.mock.calls as unknown[][]).map(([input, init]) =>
      input instanceof Request ? input.method : ((init as RequestInit | undefined)?.method ?? 'GET')
    );

  it.each([
    ['POST', '/providers', secretBody, 'create', null],
    ['PUT', '/providers/p1', secretBody, 'update', 'p1'],
    ['POST', '/providers/p1/register', secretBody, 'register', 'p1'],
    ['DELETE', '/providers/p1', undefined, 'delete', 'p1'],
  ])(
    '%s %s is gated, with the body bound only as a digest',
    async (method, path, body, action, id) => {
      const fetch = okFetch();
      const response = await call(method, path, body, fetch);

      expect(response.status).toBe(200);
      expect(stepUp.gate).toHaveBeenCalledTimes(1);
      const descriptor = (stepUp.gate.mock.calls as unknown[][])[0]?.[1];
      expect(descriptor).toEqual({
        operation: 'federation.trust.update',
        targetTenantId: 'tenant-1',
        targetIds: id ? [id] : [],
        params: {
          action,
          provider_id: id,
          body_sha256: body === undefined ? null : await digest(body),
        },
      });
      expect(JSON.stringify(descriptor)).not.toContain('very-secret');
    }
  );

  it.each([
    ['POST', '/providers', secretBody],
    ['PUT', '/providers/p1', secretBody],
    ['POST', '/providers/p1/register', secretBody],
    ['DELETE', '/providers/p1', undefined],
  ])('%s %s is not forwarded when step-up is refused', async (method, path, body) => {
    stepUp.gate.mockResolvedValueOnce(refusal());
    const fetch = okFetch();
    const response = await call(method, path, body, fetch);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'step_up_required' });
    // At most the existence check (a GET) reached the bridge, never the write.
    expect(forwardedMethods(fetch).filter((m) => m !== 'GET')).toEqual([]);
  });

  it.each([
    ['POST', '/providers', '[]'],
    ['PUT', '/providers/p1', 'not json'],
  ])('%s %s with a body that is not a JSON object never reaches the gate', async (m, p, b) => {
    const fetch = okFetch();
    const response = await call(m, p, b, fetch);
    expect(response.status).toBe(400);
    expect(stepUp.gate).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', '/providers/missing', secretBody],
    ['POST', '/providers/missing/register', undefined],
    ['DELETE', '/providers/missing', undefined],
  ])('%s %s for a provider the bridge does not have never reaches the gate', async (m, p, b) => {
    const fetch = vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 }));
    const response = await call(m, p, b, fetch);
    expect(response.status).toBe(404);
    expect(stepUp.gate).not.toHaveBeenCalled();
    expect(forwardedMethods(fetch)).toEqual(['GET']);
  });

  it('does not spend a receipt when the body is too large to read', async () => {
    const fetch = okFetch();
    const response = await call('POST', '/providers', 'x'.repeat(300 * 1024), fetch);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(stepUp.gate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

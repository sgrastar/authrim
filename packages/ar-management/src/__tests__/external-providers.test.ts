import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { adminExternalProvidersDiscoverOidcHandler } from '../external-providers';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/discover', adminExternalProvidersDiscoverOidcHandler);
  return app;
}

describe('external provider discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects discovered OIDC endpoints that are not HTTPS and external-safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
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
      vi.fn(async () =>
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
});

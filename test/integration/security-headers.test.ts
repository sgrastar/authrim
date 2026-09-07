import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import app from '../../packages/ar-discovery/src/index';

const ORIGIN = 'https://id.example.com';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        c.set('requestId' as never, 'security-headers-integration' as never);
        c.set('tenantId' as never, 'default' as never);
        c.set(
          'logger' as never,
          actual.createLogger({
            requestId: 'security-headers-integration',
            tenantId: 'default',
          }) as never
        );
        c.set('startTime' as never, Date.now() as never);
        await next();
      },
  };
});

function env(): Env {
  return { ISSUER_URL: ORIGIN } as Env;
}

function expectApiSecurityHeaders(response: Response): void {
  const csp = response.headers.get('Content-Security-Policy') ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-src 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(response.headers.get('Strict-Transport-Security')).toBe(
    'max-age=63072000; includeSubDomains; preload'
  );
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
}

describe('repository API security headers and CORS', () => {
  it.each(['/api/health', '/.well-known/openid-configuration', '/.well-known/unknown'])(
    'applies the API security-header contract to %s',
    async (path) => {
      const response = await app.fetch(new Request(`${ORIGIN}${path}`), env());
      expectApiSecurityHeaders(response);
    }
  );

  it('uses public read-only CORS without credential sharing', async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/.well-known/openid-configuration`, {
        headers: { Origin: 'https://client.example' },
      }),
      env()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('limits preflight methods to discovery-safe reads', async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/.well-known/openid-configuration`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://client.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      }),
      env()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const context = c as unknown as { set(key: string, value: unknown): void };
        context.set('requestId', 'index-app-test');
        context.set('tenantId', 'default');
        context.set('logger', actual.createLogger({ requestId: 'index-app-test' }));
        context.set('startTime', Date.now());
        await next();
      },
  };
});

import app, { SAML_DR_READ_ONLY_SURFACES, SAML_DR_WRITER_SURFACES } from '../index';

function env(extra: Record<string, unknown> = {}): Env {
  return { ISSUER_URL: 'https://auth.example.com', ...extra } as unknown as Env;
}

describe('discovery app', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('answers the liveness alias with a fixed shape and a current timestamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
    const response = await app.fetch(new Request('https://auth.example.com/api/health'), env());
    expect(response.status).toBe(200);
    const body = await response.json<{ status: string; service: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('op-discovery');
    expect(body.timestamp).toBe('2026-11-01T00:00:00.000Z');
  });

  it('answers an unexpected failure with a generic 500 and logs it under the discovery module', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const failing = {
      get ISSUER_URL(): string {
        throw new Error('env exploded');
      },
    } as unknown as Env;
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/webfinger'),
      failing
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    });
    const entry = logged.join('\n');
    expect(entry).toContain('Unhandled error in discovery service');
    expect(entry).toContain('"module":"DISCOVERY"');
    expect(entry).toContain('env exploded');
  });

  it('allows a cross-origin preflight for the headers discovery clients send', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/openid-configuration', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://rp.example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type, Authorization',
        },
      }),
      env()
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('sends the content security policy of a JSON-only service', async () => {
    const response = await app.fetch(new Request('https://auth.example.com/api/health'), env());
    const policy = response.headers.get('Content-Security-Policy') ?? '';
    expect(
      policy
        .split(';')
        .map((directive) => directive.trim())
        .sort()
    ).toEqual(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "media-src 'self'",
        "frame-src 'none'",
      ].sort()
    );
  });

  it('declares its SAML disaster-recovery surfaces', () => {
    expect(SAML_DR_WRITER_SURFACES).toEqual(['fetch']);
    expect(SAML_DR_READ_ONLY_SURFACES).toEqual(['rpc:TenantHostEntrypoint.resolveTenantForHost']);
  });
});

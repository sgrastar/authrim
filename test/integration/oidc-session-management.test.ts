import { describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import type { Env, OIDCProviderMetadata } from '@authrim/ar-lib-core';
import {
  calculateSessionState,
  createLogger,
  extractOrigin,
  validateSessionState,
} from '@authrim/ar-lib-core';
import discoveryApp from '../../packages/ar-discovery/src/index';
import { checkSessionIframeHandler } from '../../packages/ar-auth/src/session-management';

const ISSUER = 'https://id.example.com';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        c.set('requestId' as never, 'session-management-integration' as never);
        c.set('tenantId' as never, 'default' as never);
        c.set(
          'logger' as never,
          actual.createLogger({
            requestId: 'session-management-integration',
            tenantId: 'default',
          }) as never
        );
        c.set('startTime' as never, Date.now() as never);
        await next();
      },
  };
});

function env(): Env {
  return { ISSUER_URL: ISSUER } as Env;
}

function sessionApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, 'default' as never);
    c.set(
      'logger' as never,
      createLogger({ requestId: 'session-iframe-integration', tenantId: 'default' }) as never
    );
    await next();
  });
  app.get('/session/check', checkSessionIframeHandler);
  return app;
}

describe('OIDC Session Management', () => {
  it('publishes the iframe endpoint with issuer-bound discovery metadata', async () => {
    const response = await discoveryApp.fetch(
      new Request(`${ISSUER}/.well-known/openid-configuration`),
      env()
    );
    const metadata = (await response.json()) as OIDCProviderMetadata;

    expect(response.status).toBe(200);
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(metadata.check_session_iframe).toBe(`${ISSUER}/session/check`);
  });

  it('serves a nonce-protected, non-cacheable iframe that supports RP framing', async () => {
    const response = await sessionApp().fetch(new Request(`${ISSUER}/session/check`), env());
    const html = await response.text();
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('X-Frame-Options')).toBe('ALLOWALL');
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain('frame-ancestors *');
    expect(csp).not.toContain('unsafe-inline');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('postMessage');
    expect(html).toContain('authrim_browser_state');
  });

  it('binds session_state to client, origin, and session identifier', async () => {
    const clientId = 'session-client';
    const origin = extractOrigin('https://client.example/callback');
    const sessionId = 'session-123';
    const sessionState = await calculateSessionState(clientId, origin, sessionId);

    expect(sessionState.split('.')).toHaveLength(2);
    await expect(validateSessionState(sessionState, clientId, origin, sessionId)).resolves.toBe(
      true
    );
    await expect(
      validateSessionState(sessionState, 'other-client', origin, sessionId)
    ).resolves.toBe(false);
    await expect(
      validateSessionState(sessionState, clientId, 'https://other.example', sessionId)
    ).resolves.toBe(false);
    await expect(
      validateSessionState(sessionState, clientId, origin, 'other-session')
    ).resolves.toBe(false);
  });

  it('uses a fresh salt while remaining verifiable', async () => {
    const first = await calculateSessionState('client', 'https://client.example', 'session');
    const second = await calculateSessionState('client', 'https://client.example', 'session');

    expect(first).not.toBe(second);
    await expect(
      validateSessionState(first, 'client', 'https://client.example', 'session')
    ).resolves.toBe(true);
    await expect(
      validateSessionState(second, 'client', 'https://client.example', 'session')
    ).resolves.toBe(true);
  });
});

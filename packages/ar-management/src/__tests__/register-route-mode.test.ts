/**
 * Ordinary registration and the restricted Admin Agent registration share one implementation. Which
 * one a request gets is fixed by the route that matched, never read back from the request path: a
 * spelling the router accepts for the agent route (`/oauth/admin-agent/%72egister`) must not be
 * handled as ordinary registration, which sits behind the Initial Access Token check on `/register`
 * only.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { initialAccessTokenMiddleware } from '@authrim/ar-lib-core';
import { app as managementApp } from '../index';
import { adminAgentRegisterHandler, registerHandler } from '../register';

/** The registration wiring of the management Worker (index.ts), without the rest of the Worker. */
function wiring() {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'default');
    await next();
  });
  app.use('/register', initialAccessTokenMiddleware());
  app.post('/register', registerHandler);
  app.post('/oauth/admin-agent/register', adminAgentRegisterHandler);
  return app;
}

const env = { DEFAULT_TENANT_ID: 'default', DCR_ENABLED: 'true' } as unknown as Env;
const post = (path: string) =>
  wiring().request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:57939/callback/session'],
        client_name: 'Codex',
        token_endpoint_auth_method: 'none',
      }),
    },
    env
  );

describe('which registration a request gets', () => {
  it('requires the Initial Access Token on ordinary registration', async () => {
    const res = await post('/register');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('applies the agent feature switch to the agent route', async () => {
    const res = await post('/oauth/admin-agent/register');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error_description: 'Agent access is disabled for this tenant',
    });
  });

  it.each([
    '/oauth/admin-agent/%72egister',
    '/oauth/%61dmin-agent/register',
    '/%6fauth/admin-agent/%72%65gister',
  ])(
    'treats %s as the agent route, with the agent checks, not as ordinary registration',
    async (path) => {
      const res = await post(path);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error_description: 'Agent access is disabled for this tenant',
      });
    }
  );

  it('mounts each handler on its own route in the real management app', () => {
    const handlers = (method: string, path: string) =>
      managementApp.routes
        .filter((route) => route.method === method && route.path === path)
        .map((route) => route.handler);
    expect(handlers('POST', '/register')).toContain(registerHandler);
    expect(handlers('POST', '/register')).not.toContain(adminAgentRegisterHandler);
    expect(handlers('POST', '/oauth/admin-agent/register')).toContain(adminAgentRegisterHandler);
    expect(handlers('POST', '/oauth/admin-agent/register')).not.toContain(registerHandler);
  });
});

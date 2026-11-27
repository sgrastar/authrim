/**
 * Router: the public Check API routes (POST /api/check, POST /api/check/batch,
 * GET /api/check/subscribe) forward to POLICY_SERVICE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';

const createMockFetcher = (name: string) => ({
  fetch: vi.fn(async (request: Request) => {
    return new Response(
      JSON.stringify({
        worker: name,
        path: new URL(request.url).pathname,
        method: request.method,
        body: request.method === 'GET' ? null : await request.text(),
        authorization: request.headers.get('Authorization'),
        forwardedHost: request.headers.get('X-Authrim-Forwarded-Host'),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }),
});

const createMockEnv = () => ({
  OP_DISCOVERY: createMockFetcher('OP_DISCOVERY'),
  OP_AUTH: createMockFetcher('OP_AUTH'),
  OP_TOKEN: createMockFetcher('OP_TOKEN'),
  OP_USERINFO: createMockFetcher('OP_USERINFO'),
  OP_MANAGEMENT: createMockFetcher('OP_MANAGEMENT'),
  OP_CONTROL: createMockFetcher('OP_CONTROL'),
  EXTERNAL_IDP: createMockFetcher('EXTERNAL_IDP'),
  POLICY_SERVICE: createMockFetcher('POLICY_SERVICE'),
});

describe('Router: Check API', () => {
  let env: ReturnType<typeof createMockEnv>;
  let originalCaches: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCaches = (globalThis as { caches?: unknown }).caches;
    delete (globalThis as { caches?: unknown }).caches;
    env = createMockEnv();
  });

  afterEach(() => {
    if (originalCaches === undefined) delete (globalThis as { caches?: unknown }).caches;
    else (globalThis as { caches?: unknown }).caches = originalCaches;
  });

  it.each(['/api/check', '/api/check/batch'])(
    'forwards POST %s with its bearer token and body to POLICY_SERVICE',
    async (path) => {
      const body = JSON.stringify({ permission: 'documents:read' });
      const res = await app.fetch(
        new Request(`https://tenant-a.example.com${path}`, {
          method: 'POST',
          headers: { Authorization: 'Bearer chk_key', 'Content-Type': 'application/json' },
          body,
        }),
        env
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        worker: 'POLICY_SERVICE',
        path,
        method: 'POST',
        body,
        authorization: 'Bearer chk_key',
        forwardedHost: 'tenant-a.example.com',
      });
      expect(env.POLICY_SERVICE.fetch).toHaveBeenCalledOnce();
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    }
  );

  it('forwards GET /api/check/subscribe with its Authorization header to POLICY_SERVICE', async () => {
    const res = await app.fetch(
      new Request('https://tenant-a.example.com/api/check/subscribe', {
        headers: { Upgrade: 'websocket', Authorization: 'Bearer chk_key' },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      worker: 'POLICY_SERVICE',
      path: '/api/check/subscribe',
      authorization: 'Bearer chk_key',
    });
  });

  it.each(['/api/check/subscribe', '/api/check'])(
    'refuses a credential in the token query parameter on %s',
    async (path) => {
      const res = await app.fetch(
        new Request(`https://tenant-a.example.com${path}?token=chk_key`, {
          method: path === '/api/check' ? 'POST' : 'GET',
          headers: { Upgrade: 'websocket', 'Content-Type': 'application/json' },
          ...(path === '/api/check' && { body: '{}' }),
        }),
        env
      );
      expect(res.status).toBe(400);
      expect(env.POLICY_SERVICE.fetch).not.toHaveBeenCalled();
    }
  );

  it('is not a browser form post: the router CSRF check does not refuse a cross-site Origin', async () => {
    const res = await app.fetch(
      new Request('https://tenant-a.example.com/api/check', {
        method: 'POST',
        headers: { Origin: 'https://other-site.test', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env
    );
    // ar-policy authenticates (401 without a bearer token); the router only forwards.
    expect(res.status).toBe(200);
    expect(env.POLICY_SERVICE.fetch).toHaveBeenCalledOnce();
  });

  it('refuses a token in the query string instead of the Authorization header', async () => {
    const res = await app.fetch(
      new Request('https://tenant-a.example.com/api/check?access_token=leaked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(env.POLICY_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it('answers 404 when the policy service is not bound', async () => {
    const { POLICY_SERVICE: _unbound, ...withoutPolicy } = env;
    const res = await app.fetch(
      new Request('https://tenant-a.example.com/api/check', {
        method: 'POST',
        headers: { Authorization: 'Bearer chk_key', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      withoutPolicy
    );
    expect(res.status).toBe(404);
  });
});

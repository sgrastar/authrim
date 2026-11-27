/**
 * Mutation-driven tests: error response contracts, env parsing, edge fallback behaviour and
 * small routing guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app, { LoginUiBackendEntrypoint } from '../index';
import {
  createMockCache,
  createMockEnv,
  createMockFetcher,
  createMockKV,
  isolateGlobalCaches,
  type MockEnv,
} from './helpers/router-env';

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

const NO_CACHE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const headersOf = (res: Response) => ({
  'cache-control': res.headers.get('cache-control'),
  pragma: res.headers.get('pragma'),
});
const form = (body: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
});

describe('bearer token and body size rejections', () => {
  it('rejects a query access_token with the documented body and no-cache headers', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/userinfo?access_token=abc'),
      env
    );
    expect(res.status).toBe(400);
    expect(headersOf(res)).toEqual(NO_CACHE);
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description:
        'Bearer tokens must be sent in the Authorization header for this endpoint.',
      error_details: { code: 'bearer_token_transport_unsupported' },
    });
    expect(env.OP_USERINFO.fetch).not.toHaveBeenCalled();
  });

  it('rejects a form access_token field the same way', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/token', form('access_token=abc&x=1')),
      env
    );
    expect(res.status).toBe(400);
    expect(headersOf(res)).toEqual(NO_CACHE);
  });

  it('rejects an oversized form with 413, the documented body and no-cache headers', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/token', form(`a=${'x'.repeat(5000)}`)),
      { ...env, ROUTER_FORM_BODY_MAX_BYTES: '4096' }
    );
    expect(res.status).toBe(413);
    expect(headersOf(res)).toEqual(NO_CACHE);
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Request body exceeds the maximum allowed size for this endpoint.',
      error_details: { code: 'request_body_too_large' },
    });
  });

  const LIMIT = 256 * 1024;
  const sized = (bytes: number) => form(`a=${'x'.repeat(bytes - 2)}`);

  it.each([undefined, '', 'abc', 'NaN'])(
    'applies the 256 KiB default for the unusable limit %j',
    async (limit) => {
      const e = { ...env, ROUTER_FORM_BODY_MAX_BYTES: limit };
      const under = await app.fetch(
        new Request('https://id.example.com/token', sized(LIMIT - 10)),
        e
      );
      expect(under.status).toBe(200);
      const over = await app.fetch(
        new Request('https://id.example.com/token', sized(LIMIT + 10)),
        e
      );
      expect(over.status).toBe(413);
    }
  );

  it('does not inspect paths outside the bearer canonical list', async () => {
    const res = await app.fetch(
      new Request('https://id.example.com/api/health?access_token=abc'),
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('configured URL parsing', () => {
  it('ignores a malformed LOGIN_UI_URL instead of failing', async () => {
    const res = await app.fetch(new Request('https://id.example.com/api/health'), {
      ...env,
      LOGIN_UI_URL: 'not a url',
      ADMIN_UI_URL: '::::',
    });
    expect(res.status).toBe(200);
  });

  it('ignores a malformed ADMIN_UI_URL on the root route', async () => {
    const res = await app.fetch(new Request('https://id.example.com/'), {
      ...env,
      ADMIN_UI_URL: '::::',
    });
    expect(await res.json()).toMatchObject({ name: 'Authrim OIDC Provider' });
  });
});

describe('authentication methods on HEAD', () => {
  it('never caches a HEAD request', async () => {
    const cache = createMockCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const res = await app.fetch(
      new Request('https://first.example.com/api/auth/authentication-methods', { method: 'HEAD' }),
      { ...env, BASE_DOMAIN: 'example.com', SETTINGS: createMockKV() }
    );
    expect(res.headers.get('X-Authrim-Router-Authentication-Methods-Cache')).toBe('bypass');
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe('trusted entrypoint header normalisation', () => {
  it('rewrites comma separated host hints to the bare request host', async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const entry = new LoginUiBackendEntrypoint(ctx, env as never);
    await entry.fetch(
      new Request('https://id.example.com/api/user/consents', {
        headers: {
          'X-Authrim-Ui-Proxy': 'login-ui',
          'X-Authrim-Forwarded-Host': 'id.example.com, x.test',
          'X-Authrim-Original-Host': 'id.example.com, y.test',
        },
      })
    );
    const forwarded = env.OP_MANAGEMENT.fetch.mock.calls[0][0];
    expect(forwarded.headers.get('X-Authrim-Original-Host')).toBe('id.example.com');
    expect(forwarded.headers.get('X-Authrim-Forwarded-Host')).toBe('id.example.com');
    expect(forwarded.headers.get('X-Authrim-Ui-Proxy')).toBe('login-ui');
  });

  it('answers 403 with the documented body', async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const res = await new LoginUiBackendEntrypoint(ctx, env as never).fetch(
      new Request('https://id.example.com/api/health')
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'access_denied',
      error_description: 'Trusted Login UI service-binding request required.',
    });
  });
});

describe('Login UI edge entrypoint fallbacks', () => {
  const setup = (edge: {
    ping: () => Promise<string>;
    handle: (r: Request, c: unknown) => Promise<Response>;
  }) => {
    const plain = createMockFetcher('LOGIN_UI_WORKER');
    const e = {
      ...env,
      ALLOWED_ORIGINS: 'https://id.example.com',
      ENABLE_LOGIN_UI_PROXY: 'true',
      AR_LOGIN_UI_URL: 'https://login-ui.example.workers.dev',
      LOGIN_UI_WORKER: plain,
      LOGIN_UI_EDGE: edge,
    };
    return { plain, e };
  };
  const failing = () => ({
    ping: vi.fn(async () => 'ok'),
    handle: vi.fn(async () => {
      throw new Error('edge failed');
    }),
  });

  it.each(['GET', 'HEAD'])('retries a failed %s the plain way, without a body', async (method) => {
    const edge = failing();
    const { plain, e } = setup(edge);
    const res = await app.fetch(
      new Request('https://id.example.com/login?x=1', { method, headers: { 'X-Keep': '1' } }),
      e
    );
    expect(res.status).toBe(200);
    const retry = plain.fetch.mock.calls[0][0];
    expect(retry.method).toBe(method);
    expect(retry.url).toBe('https://login-ui.example.workers.dev/login?x=1');
    expect(retry.headers.get('X-Keep')).toBe('1');
    expect(retry.redirect).toBe('manual');
    expect(retry.body).toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('does not send a failed %s again', async (method) => {
    const edge = failing();
    const { plain, e } = setup(edge);
    const res = await app.fetch(
      new Request('https://id.example.com/login', {
        method,
        headers: {
          Origin: 'https://id.example.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'a=1',
      }),
      e
    );
    expect(res.status).toBe(500);
    expect(plain.fetch).not.toHaveBeenCalled();
  });

  it('asks the entrypoint again on the request after a failure', async () => {
    const edge = failing();
    const { e } = setup(edge);
    await app.fetch(new Request('https://id.example.com/login'), e);
    await app.fetch(new Request('https://id.example.com/login'), e);
    expect(edge.ping).toHaveBeenCalledTimes(2);
    expect(edge.handle).toHaveBeenCalledTimes(2);
  });

  it('uses the plain binding while the entrypoint does not answer ok', async () => {
    const handle = vi.fn(async () => new Response('edge'));
    const { plain, e } = setup({ ping: async () => 'not-ok', handle });
    const res = await app.fetch(new Request('https://id.example.com/login'), e);
    expect(handle).not.toHaveBeenCalled();
    expect(plain.fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('passes the unrewritten request context to the entrypoint', async () => {
    const handle = vi.fn(async (_r: Request, _c: unknown) => new Response('edge'));
    const { plain, e } = setup({ ping: async () => 'ok', handle });
    await app.fetch(
      new Request('https://id.example.com/login', {
        headers: { 'CF-Connecting-IP': '203.0.113.9' },
      }),
      e
    );
    expect(plain.fetch).not.toHaveBeenCalled();
    expect(handle.mock.calls[0][1]).toEqual({
      originVerified: null,
      clientIp: '203.0.113.9',
      publicOrigin: 'https://id.example.com',
    });
  });
});

describe('small routing guards', () => {
  it('serves health probes', async () => {
    const live = await app.fetch(new Request('https://id.example.com/health/live'), env);
    expect(await live.json()).toMatchObject({ status: 'ok' });
    const ready = await app.fetch(new Request('https://id.example.com/health/ready'), env);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: {} });
  });

  it('forwards the initial admin setup page and API to OP_AUTH only', async () => {
    const page = await app.fetch(new Request('https://id.example.com/admin-init-setup'), env);
    expect(await page.json()).toMatchObject({ worker: 'OP_AUTH', path: '/admin-init-setup' });
    // Valid same-origin Origin: CSRF passes, so only the GET-only route decides.
    const post = await app.fetch(
      new Request('https://id.example.com/admin-init-setup', {
        method: 'POST',
        headers: { Origin: 'https://id.example.com' },
      }),
      { ...env, ALLOWED_ORIGINS: 'https://id.example.com' }
    );
    expect(post.status).toBe(404);
    expect(env.OP_AUTH.fetch).toHaveBeenCalledTimes(1);
  });

  it('answers 404 JSON with a hint for unknown paths', async () => {
    const res = await app.fetch(new Request('https://id.example.com/no/such/path'), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers 500 JSON when a handler throws', async () => {
    env.OP_DISCOVERY.fetch.mockRejectedValueOnce(new Error('boom'));
    const res = await app.fetch(
      new Request('https://id.example.com/.well-known/openid-configuration'),
      env
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'server_error',
      error_description: 'An unexpected error occurred in the router',
    });
  });
});

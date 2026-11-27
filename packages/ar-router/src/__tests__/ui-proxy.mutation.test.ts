/**
 * Mutation-driven tests: Admin UI / Login UI proxying, path validation, Origin/Referer
 * handling and the root route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../index';
import {
  createMockEnv,
  createMockFetcher,
  isolateGlobalCaches,
  type MockEnv,
} from './helpers/router-env';

let env: MockEnv;
let login: ReturnType<typeof createMockFetcher>;
let admin: ReturnType<typeof createMockFetcher>;
let restore: () => void;

beforeEach(() => {
  restore = isolateGlobalCaches();
  env = createMockEnv();
  login = createMockFetcher('LOGIN_UI_WORKER');
  admin = createMockFetcher('ADMIN_UI_WORKER');
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LOGIN_URL = 'https://login-ui.example.workers.dev';
const ADMIN_URL = 'https://admin-ui.example.workers.dev';

const uiEnv = (extra: Record<string, unknown> = {}) => ({
  ...env,
  ALLOWED_ORIGINS: 'https://id.example.com,https://rp.example',
  ENABLE_LOGIN_UI_PROXY: 'true',
  AR_LOGIN_UI_URL: LOGIN_URL,
  LOGIN_UI_WORKER: login,
  ENABLE_ADMIN_UI_PROXY: 'true',
  AR_ADMIN_UI_URL: ADMIN_URL,
  ADMIN_UI_WORKER: admin,
  ...extra,
});

const req = (
  e: Record<string, unknown>,
  path: string,
  init?: RequestInit,
  origin = 'https://id.example.com'
) => app.fetch(new Request(`${origin}${path}`, init), e);
const sent = (f: ReturnType<typeof createMockFetcher>, i = 0) => f.fetch.mock.calls[i][0];

describe('Admin UI proxy', () => {
  it.each([
    '/admin/dashboard/users',
    '/setup/complete',
    '/geo/world.json',
    '/_authrim_admin/app.js',
  ])('proxies %s to the Admin UI Worker with query preserved', async (path) => {
    const res = await req(uiEnv(), `${path}?x=1`);
    expect(res.status).toBe(200);
    const r = sent(admin);
    expect(r.url).toBe(`${ADMIN_URL}${path}?x=1`);
    expect(login.fetch).not.toHaveBeenCalled();
  });

  it('proxies the exact /admin path', async () => {
    await req(uiEnv(), '/admin');
    expect(new URL(sent(admin).url).pathname).toBe('/admin');
  });

  it.each([
    ['disabled', { ENABLE_ADMIN_UI_PROXY: 'false' }],
    ['unset', { ENABLE_ADMIN_UI_PROXY: undefined }],
    ['without a target URL', { AR_ADMIN_UI_URL: undefined }],
  ])('answers 404 when the Admin UI proxy is %s', async (_label, extra) => {
    for (const path of ['/admin', '/admin/x', '/setup/x', '/geo/x', '/_authrim_admin/x']) {
      const res = await req(uiEnv(extra), path);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: 'not_found',
        message: 'Admin UI proxy is not enabled',
      });
    }
    expect(admin.fetch).not.toHaveBeenCalled();
  });

  it('does not proxy non-GET /geo requests', async () => {
    // A valid same-origin Origin, so CSRF passes and the route table decides.
    const res = await req(uiEnv(), '/geo/x', {
      method: 'POST',
      headers: { Origin: 'https://id.example.com' },
    });
    expect(admin.fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it('uses plain fetch when no Admin UI Worker binding exists', async () => {
    const plain = vi.fn(async () => new Response('plain'));
    vi.stubGlobal('fetch', plain);
    const res = await req(uiEnv({ ADMIN_UI_WORKER: undefined }), '/admin/x');
    expect(await res.text()).toBe('plain');
    expect((plain.mock.calls[0] as unknown as [Request])[0].url).toBe(`${ADMIN_URL}/admin/x`);
  });
});

describe('Login UI proxy', () => {
  it.each(['/login', '/login/x', '/signup', '/consent/y', '/_authrim_login/app.js'])(
    'proxies %s',
    async (path) => {
      const res = await req(uiEnv(), `${path}?a=b`);
      expect(res.status).toBe(200);
      expect(sent(login).url).toBe(`${LOGIN_URL}${path}?a=b`);
      expect(admin.fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['disabled', { ENABLE_LOGIN_UI_PROXY: 'false' }],
    ['without a target URL', { AR_LOGIN_UI_URL: undefined }],
  ])('answers 404 when the proxy is %s', async (_label, extra) => {
    for (const path of ['/login', '/login/x', '/_authrim_login/x']) {
      const res = await req(uiEnv(extra), path);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: 'not_found',
        message: 'Login UI proxy is not enabled',
      });
    }
    expect(login.fetch).not.toHaveBeenCalled();
  });

  it('rejects paths with characters outside the allowed set', async () => {
    for (const path of ['/login/a|b', '/login/|x/y', '/login/a^b']) {
      const res = await req(uiEnv(), path);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        message: 'Invalid UI proxy path',
      });
    }
    expect(login.fetch).not.toHaveBeenCalled();
  });

  it('allows the documented path punctuation', async () => {
    const res = await req(uiEnv(), "/login/a.b_c~d!e$f&g'h(i)j*k+l,m;n=o:p@q%2Fr-s");
    expect(res.status).toBe(200);
  });

  it('keeps the configured host for a hostile-looking path', async () => {
    await req(uiEnv(), '/login/..%2f..%2fx');
    expect(new URL(sent(login).url).origin).toBe(LOGIN_URL);
  });

  it('sets the original host, drops spoofed internal headers, and marks shared hosts only when shared', async () => {
    await req(uiEnv(), '/login', {
      headers: {
        'X-Authrim-Original-Host': 'spoof.test',
        'X-Authrim-Shared-Login-Host': 'true',
        'x-authrim-edge-context': '{"v":1}',
      },
    });
    const r = sent(login);
    expect(r.headers.get('X-Authrim-Original-Host')).toBe('id.example.com');
    expect(r.headers.get('X-Authrim-Shared-Login-Host')).toBeNull();
    expect(r.headers.get('x-authrim-edge-context')).toBeNull();
    expect(r.redirect).toBe('manual');
  });

  it('forwards method, body and headers of a POST', async () => {
    await req(uiEnv(), '/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://id.example.com',
      },
      body: 'a=1',
    });
    const r = sent(login);
    expect(r.method).toBe('POST');
    expect(await r.text()).toBe('a=1');
    expect(r.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
  });

  it('sends a bodiless GET without a body', async () => {
    await req(uiEnv(), '/login');
    const r = sent(login);
    expect(r.method).toBe('GET');
    expect(r.body).toBeNull();
  });

  describe('Origin and Referer', () => {
    it('leaves an absent Origin absent and a cross-origin Origin unchanged', async () => {
      await req(uiEnv(), '/login', {
        method: 'POST',
        body: 'a=1',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://rp.example',
        },
      });
      expect(sent(login).headers.get('origin')).toBe('https://rp.example');
    });

    it('does not invent an Origin for requests without one', async () => {
      await req(uiEnv(), '/login', {
        method: 'POST',
        body: 'a=1',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://id.example.com/login',
        },
      });
      expect(sent(login).headers.has('origin')).toBe(false);
    });

    it('rewrites a same-origin Referer to the UI origin and keeps path and query', async () => {
      await req(uiEnv(), '/login', {
        headers: { Referer: 'https://id.example.com/login?next=%2Fa' },
      });
      expect(sent(login).headers.get('referer')).toBe(`${LOGIN_URL}/login?next=%2Fa`);
    });

    it('leaves a cross-origin Referer unchanged', async () => {
      await req(uiEnv(), '/login', { headers: { Referer: 'https://rp.example/page' } });
      expect(sent(login).headers.get('referer')).toBe('https://rp.example/page');
    });

    it('leaves requests without a Referer without one', async () => {
      await req(uiEnv(), '/login');
      expect(sent(login).headers.has('referer')).toBe(false);
    });
  });
});

describe('Login UI host (dedicated mode)', () => {
  const dedicated = (extra: Record<string, unknown> = {}) =>
    uiEnv({ LOGIN_UI_URL: 'https://login.example.com', LOGIN_UI_HOST_MODE: 'dedicated', ...extra });
  const onLoginHost = (e: Record<string, unknown>, path = '/api/health', init?: RequestInit) =>
    req(e, path, init, 'https://login.example.com');

  it('proxies every path on the Login UI host and marks it shared', async () => {
    const res = await onLoginHost(dedicated(), '/anything/here?q=1');
    expect(res.status).toBe(200);
    const r = sent(login);
    expect(r.url).toBe(`${LOGIN_URL}/anything/here?q=1`);
    expect(r.headers.get('X-Authrim-Shared-Login-Host')).toBe('true');
    expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['shared host mode', { LOGIN_UI_HOST_MODE: 'shared' }],
    [
      'only the path-proxy flag',
      { ENABLE_LOGIN_UI_PROXY: undefined, ENABLE_LOGIN_UI_PATH_PROXY: 'true' },
    ],
    ['no target URL', { AR_LOGIN_UI_URL: undefined }],
  ])('does not take over the host with %s', async (_label, extra) => {
    const res = await onLoginHost(dedicated(extra), '/api/health');
    expect(login.fetch).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ service: 'authrim-router' });
  });

  it('does not take over other hosts', async () => {
    const res = await req(dedicated(), '/api/health');
    expect(login.fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

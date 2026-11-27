/**
 * Mutation-driven tests: the root route (Admin UI custom domain, Login UI, fast redirect,
 * API info) and cookie detection.
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
});

const rootEnv = (extra: Record<string, unknown> = {}) => ({
  ...env,
  BASE_DOMAIN: 'example.com',
  ENABLE_LOGIN_UI_PROXY: 'true',
  AR_LOGIN_UI_URL: 'https://login-ui.example.workers.dev',
  LOGIN_UI_WORKER: login,
  ENABLE_ADMIN_UI_PROXY: 'true',
  AR_ADMIN_UI_URL: 'https://admin-ui.example.workers.dev',
  ADMIN_UI_WORKER: admin,
  ...extra,
});
const root = (e: Record<string, unknown>, host: string, init: RequestInit = {}, search = '') =>
  app.fetch(
    new Request(`https://${host}/${search}`, {
      ...init,
      headers: { Host: host, ...(init.headers as object) },
    }),
    e
  );

describe('root route on the Admin UI host', () => {
  it('derives the admin host from BASE_DOMAIN', async () => {
    const res = await root(rootEnv(), 'admin.example.com');
    expect(res.status).toBe(200);
    expect(new URL(admin.fetch.mock.calls[0][0].url).pathname).toBe('/');
    expect(login.fetch).not.toHaveBeenCalled();
  });

  it('prefers the configured ADMIN_UI_URL host over the derived one', async () => {
    const e = rootEnv({ ADMIN_UI_URL: 'https://console.custom.test' });
    await root(e, 'console.custom.test');
    expect(admin.fetch).toHaveBeenCalledTimes(1);
    admin.fetch.mockClear();
    await root(e, 'admin.example.com');
    expect(admin.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the Admin UI proxy is off', { ENABLE_ADMIN_UI_PROXY: 'false' }],
    ['no Admin UI target URL', { AR_ADMIN_UI_URL: undefined }],
  ])('is not proxied when %s', async (_label, extra) => {
    const res = await root(
      rootEnv({ ...extra, ENABLE_LOGIN_UI_PROXY: undefined }),
      'admin.example.com'
    );
    expect(admin.fetch).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ name: 'Authrim OIDC Provider' });
  });

  it('is not the admin host when no admin host can be derived', async () => {
    const e = rootEnv({ BASE_DOMAIN: undefined, ENABLE_LOGIN_UI_PROXY: undefined });
    const res = await root(e, 'admin.example.com');
    expect(admin.fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('lets the Login UI win when both UIs share the host', async () => {
    const e = rootEnv({
      ADMIN_UI_URL: 'https://both.custom.test',
      LOGIN_UI_URL: 'https://both.custom.test',
    });
    await root(e, 'both.custom.test');
    expect(admin.fetch).not.toHaveBeenCalled();
    expect(login.fetch).toHaveBeenCalledTimes(1);
  });

  it('serves the Admin UI on a shared host when the Login UI proxy is off', async () => {
    const e = rootEnv({
      ADMIN_UI_URL: 'https://both.custom.test',
      LOGIN_UI_URL: 'https://both.custom.test',
      ENABLE_LOGIN_UI_PROXY: undefined,
    });
    await root(e, 'both.custom.test');
    expect(admin.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('root route for the Login UI', () => {
  it('redirects an anonymous tenant host to /login with 303', async () => {
    const res = await root(rootEnv(), 'acme.example.com');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login');
    expect(login.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a query string', 'acme.example.com', {}, '?x=1'],
    ['the base domain itself', 'example.com', {}, ''],
    ['a foreign host', 'id.other.test', {}, ''],
    ['a session cookie', 'acme.example.com', { headers: { Cookie: 'authrim_session=abc' } }, ''],
    [
      'a mixed-case session cookie among others',
      'acme.example.com',
      { headers: { Cookie: 'a=b; Authrim_Session=abc' } },
      '',
    ],
  ])('proxies to the Login UI root for %s', async (_label, host, init, search) => {
    const res = await root(rootEnv(), host, init, search);
    expect(res.status).toBe(200);
    const r = login.fetch.mock.calls[0][0];
    expect(new URL(r.url).pathname).toBe('/');
    expect(new URL(r.url).search).toBe(search);
  });

  it.each([
    'authrim_sessions=abc',
    'xauthrim_session=abc',
    'other=authrim_session=abc',
    'authrim_session',
  ])('does not mistake the cookie %j for a session', async (cookie) => {
    const res = await root(rootEnv(), 'acme.example.com', { headers: { Cookie: cookie } });
    expect(res.status).toBe(303);
  });

  it('returns the API info when only the path proxy flag is on', async () => {
    const e = rootEnv({ ENABLE_LOGIN_UI_PROXY: undefined, ENABLE_LOGIN_UI_PATH_PROXY: 'true' });
    expect(await (await root(e, 'acme.example.com')).json()).toMatchObject({
      name: 'Authrim OIDC Provider',
    });
    expect(login.fetch).not.toHaveBeenCalled();
  });

  it('returns the API info without a Login UI target URL', async () => {
    const res = await root(rootEnv({ AR_LOGIN_UI_URL: undefined }), 'acme.example.com');
    expect(await res.json()).toMatchObject({ name: 'Authrim OIDC Provider' });
  });

  it('describes the provider endpoints in the API info', async () => {
    const res = await root(rootEnv({ ENABLE_LOGIN_UI_PROXY: undefined }), 'acme.example.com');
    expect(await res.json()).toEqual({
      name: 'Authrim OIDC Provider',
      version: '1.0.0',
      endpoints: {
        discovery: '/.well-known/openid-configuration',
        authorize: '/authorize',
        token: '/token',
        userinfo: '/userinfo',
      },
    });
  });
});

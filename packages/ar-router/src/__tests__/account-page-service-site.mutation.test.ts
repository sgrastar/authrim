/**
 * Mutation-driven tests: account page prefix routing, service-site fallback, settings caching
 * and the W3C passkey-endpoints publication gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../index';
import {
  createMockEnv,
  createMockFetcher,
  createMockKV,
  isolateGlobalCaches,
  type MockEnv,
} from './helpers/router-env';

let env: MockEnv;
let ui: ReturnType<typeof createMockFetcher>;
let restore: () => void;
let seq = 0;
const tenant = () => `acct-${++seq}`;

beforeEach(() => {
  restore = isolateGlobalCaches();
  env = createMockEnv();
  ui = createMockFetcher('LOGIN_UI_WORKER');
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const proxyEnv = (t: string, selfService?: unknown, extra: Record<string, unknown> = {}) => ({
  ...env,
  DEFAULT_TENANT_ID: t,
  ENABLE_LOGIN_UI_PROXY: 'true',
  AR_LOGIN_UI_URL: 'https://ui.example.workers.dev',
  LOGIN_UI_WORKER: ui,
  SETTINGS: createMockKV(
    selfService === undefined
      ? {}
      : { [`settings:tenant:${t}:self-service`]: JSON.stringify(selfService) }
  ),
  ...extra,
});

const get = (e: Record<string, unknown>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://example.com${path}`, init), e);
const uiPaths = () => ui.fetch.mock.calls.map((c) => new URL(c[0].url).pathname);

describe('account page prefix routing', () => {
  it('serves /account by default and maps the suffix and query', async () => {
    const e = proxyEnv(tenant());
    expect((await get(e, '/account')).status).toBe(200);
    await get(e, '/account/security/keys?tab=1');
    expect(uiPaths()).toEqual(['/account', '/account/security/keys']);
    expect(new URL(ui.fetch.mock.calls[1][0].url).search).toBe('?tab=1');
  });

  it('serves a configured prefix under the internal /account route', async () => {
    const e = proxyEnv(tenant(), {
      'self-service.account_page_enabled': true,
      'self-service.account_page_path': '/my-space',
    });
    await get(e, '/my-space');
    await get(e, '/my-space/a/b');
    expect(uiPaths()).toEqual(['/account', '/account/a/b']);
    // The default prefix is no longer the account page.
    expect((await get(e, '/account')).status).toBe(404);
  });

  it('trims a configured prefix and serves the trimmed path', async () => {
    const e = proxyEnv(tenant(), {
      'self-service.account_page_enabled': true,
      'self-service.account_page_path': ' /my-account ',
    });
    expect((await get(e, '/my-account')).status).toBe(200);
    expect((await get(e, '/my-account/x')).status).toBe(200);
    expect(uiPaths()).toEqual(['/account', '/account/x']);
    expect((await get(e, '/account')).status).toBe(404);
  });

  it('does not treat a longer sibling path as the account page', async () => {
    const e = proxyEnv(tenant());
    expect((await get(e, '/accountant')).status).toBe(404);
    expect(ui.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a reserved path', '/login'],
    ['a protocol-relative path', '//evil.example'],
    ['a path with a query', '/a?b=1'],
    ['a path with a fragment', '/a#b'],
    ['the bare root', '/'],
    ['a non-string', 42],
  ])('falls back to /account for %s', async (_label, bad) => {
    const e = proxyEnv(tenant(), {
      'self-service.account_page_enabled': true,
      'self-service.account_page_path': bad,
    });
    expect((await get(e, '/account/x')).status).toBe(200);
    expect(uiPaths()).toEqual(['/account/x']);
  });

  it('stays disabled when the setting is false and defaults on for non-boolean values', async () => {
    const off = proxyEnv(tenant(), { 'self-service.account_page_enabled': false });
    expect((await get(off, '/account')).status).toBe(404);
    const odd = proxyEnv(tenant(), { 'self-service.account_page_enabled': 'false' });
    expect((await get(odd, '/account')).status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['an array', '[1]'],
    ['a scalar', '"x"'],
    ['null', 'null'],
  ])('uses defaults for %s settings', async (_label, raw) => {
    const t = tenant();
    const e = proxyEnv(t, undefined, {
      SETTINGS: createMockKV({ [`settings:tenant:${t}:self-service`]: raw }),
    });
    expect((await get(e, '/account')).status).toBe(200);
  });

  it('uses defaults when the KV read fails', async () => {
    const e = proxyEnv(tenant(), undefined, {
      SETTINGS: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
      },
    });
    expect((await get(e, '/account')).status).toBe(200);
  });

  it('reads AUTHRIM_CONFIG when there is no SETTINGS binding', async () => {
    const t = tenant();
    const e = proxyEnv(t, undefined, {
      SETTINGS: undefined,
      AUTHRIM_CONFIG: createMockKV({
        [`settings:tenant:${t}:self-service`]: JSON.stringify({
          'self-service.account_page_path': '/from-config',
        }),
      }),
    });
    await get(e, '/from-config');
    expect(uiPaths()).toEqual(['/account']);
  });

  it('prefers SETTINGS over AUTHRIM_CONFIG', async () => {
    const t = tenant();
    const e = proxyEnv(
      t,
      { 'self-service.account_page_path': '/from-settings' },
      {
        AUTHRIM_CONFIG: createMockKV({
          [`settings:tenant:${t}:self-service`]: JSON.stringify({
            'self-service.account_page_path': '/from-config',
          }),
        }),
      }
    );
    expect((await get(e, '/from-settings')).status).toBe(200);
    expect((await get(e, '/from-config')).status).toBe(404);
  });

  it('answers 404 when the Login UI proxy is not enabled', async () => {
    const e = proxyEnv(tenant(), undefined, { ENABLE_LOGIN_UI_PROXY: undefined });
    const res = await get(e, '/account');
    expect(res.status).toBe(404);
    expect(ui.fetch).not.toHaveBeenCalled();
  });

  it('caches the settings for five seconds only', async () => {
    const t = tenant();
    const e = proxyEnv(t);
    const kv = e.SETTINGS;
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(5_000_000);
    await get(e, '/account');
    now.mockReturnValue(5_004_900);
    await get(e, '/account');
    const reads = () =>
      kv.get.mock.calls.filter((c) => String(c[0]).endsWith(':self-service')).length;
    expect(reads()).toBe(1);
    now.mockReturnValue(5_005_100);
    await get(e, '/account');
    expect(reads()).toBe(2);
  });

  it('re-reads exactly when the cached entry expires', async () => {
    const e = proxyEnv(tenant());
    const kv = e.SETTINGS;
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(7_000_000);
    await get(e, '/account');
    now.mockReturnValue(7_005_000);
    await get(e, '/account');
    expect(kv.get.mock.calls.filter((c) => String(c[0]).endsWith(':self-service')).length).toBe(2);
  });
});

describe('service site fallback', () => {
  const siteEnv = (t: string, record: unknown, extra: Record<string, unknown> = {}) => ({
    ...env,
    DEFAULT_TENANT_ID: t,
    SERVICE_SITE: createMockFetcher('SERVICE_SITE'),
    SETTINGS: createMockKV({ [`settings:tenant:${t}:service-site`]: JSON.stringify(record) }),
    ...extra,
  });

  it('forwards unknown paths only when explicitly enabled with a literal true', async () => {
    const on = siteEnv(tenant(), { 'service-site.fallback_enabled': true });
    const res = await get(on, '/some/page');
    expect(await res.json()).toMatchObject({ worker: 'SERVICE_SITE', path: '/some/page' });
    for (const value of ['true', 1, null, false]) {
      const e = siteEnv(tenant(), { 'service-site.fallback_enabled': value });
      expect((await get(e, '/some/page')).status).toBe(404);
      expect(e.SERVICE_SITE.fetch).not.toHaveBeenCalled();
    }
  });

  it('serves the root from the service site when enabled', async () => {
    const e = siteEnv(tenant(), { 'service-site.fallback_enabled': true });
    expect(await (await get(e, '/')).json()).toMatchObject({ worker: 'SERVICE_SITE' });
  });

  it('ignores a binding without a fetch function', async () => {
    const e = siteEnv(tenant(), { 'service-site.fallback_enabled': true }, { SERVICE_SITE: {} });
    expect((await get(e, '/some/page')).status).toBe(404);
    const root = await get(e, '/');
    expect(await root.json()).toMatchObject({ name: 'Authrim OIDC Provider' });
  });

  it('resolves a custom binding name (trimmed) instead of SERVICE_SITE', async () => {
    const custom = createMockFetcher('MY_SITE');
    const e = siteEnv(
      tenant(),
      { 'service-site.fallback_enabled': true },
      { SERVICE_SITE_BINDING: '  MY_SITE ', MY_SITE: custom }
    );
    const res = await get(e, '/some/page');
    expect(await res.json()).toMatchObject({ worker: 'MY_SITE' });
    expect(e.SERVICE_SITE.fetch).not.toHaveBeenCalled();
  });

  it('falls back to SERVICE_SITE when the binding name is blank', async () => {
    const e = siteEnv(
      tenant(),
      { 'service-site.fallback_enabled': true },
      { SERVICE_SITE_BINDING: '   ' }
    );
    expect(await (await get(e, '/some/page')).json()).toMatchObject({ worker: 'SERVICE_SITE' });
  });

  it('never reads settings when no service site is bound', async () => {
    const t = tenant();
    const kv = createMockKV();
    const e = { ...env, DEFAULT_TENANT_ID: t, SETTINGS: kv };
    expect((await get(e, '/nope')).status).toBe(404);
    expect(kv.get.mock.calls.filter((c) => String(c[0]).endsWith(':service-site'))).toHaveLength(0);
  });

  it('reads AUTHRIM_CONFIG when SETTINGS is absent, and survives KV failure', async () => {
    const t = tenant();
    const fromConfig = siteEnv(
      t,
      {},
      {
        SETTINGS: undefined,
        AUTHRIM_CONFIG: createMockKV({
          [`settings:tenant:${t}:service-site`]: JSON.stringify({
            'service-site.fallback_enabled': true,
          }),
        }),
      }
    );
    expect((await get(fromConfig, '/some/page')).status).toBe(200);
    const broken = siteEnv(
      tenant(),
      {},
      {
        SETTINGS: {
          get: vi.fn(async () => {
            throw new Error('kv down');
          }),
        },
      }
    );
    expect((await get(broken, '/some/page')).status).toBe(404);
  });

  it('caches the fallback decision for five seconds', async () => {
    const t = tenant();
    const e = siteEnv(t, { 'service-site.fallback_enabled': true });
    const kv = e.SETTINGS;
    const reads = () =>
      kv.get.mock.calls.filter((c) => String(c[0]).endsWith(':service-site')).length;
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(9_000_000);
    await get(e, '/p');
    now.mockReturnValue(9_004_900);
    await get(e, '/p');
    expect(reads()).toBe(1);
    now.mockReturnValue(9_005_000);
    await get(e, '/p');
    expect(reads()).toBe(2);
  });

  it('keeps Authrim reserved routes ahead of the fallback', async () => {
    const e = siteEnv(tenant(), { 'service-site.fallback_enabled': true });
    expect((await get(e, '/api/health')).status).toBe(200);
    expect(await (await get(e, '/api/health')).json()).toMatchObject({ service: 'authrim-router' });
  });
});

describe('passkey endpoints publication', () => {
  const key = (e: Record<string, unknown>) => get(e, '/.well-known/passkey-endpoints');

  it('is published from OP_DISCOVERY when the account page is served here', async () => {
    const e = proxyEnv(tenant());
    const res = await key(e);
    expect(await res.json()).toMatchObject({ worker: 'OP_DISCOVERY' });
  });

  it.each([
    ['the proxy is off', { ENABLE_LOGIN_UI_PROXY: undefined }],
    ['AR_LOGIN_UI_URL is missing', { AR_LOGIN_UI_URL: undefined }],
  ])('is a no-store 404 when %s', async (_label, extra) => {
    const res = await key(proxyEnv(tenant(), undefined, extra));
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      error: 'not_found',
      message: 'The requested resource was not found',
    });
    expect(env.OP_DISCOVERY.fetch).not.toHaveBeenCalled();
  });

  it('is a no-store 404 when the account page is disabled', async () => {
    const res = await key(proxyEnv(tenant(), { 'self-service.account_page_enabled': false }));
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('accepts the path-proxy flag as the enabling flag', async () => {
    const e = proxyEnv(tenant(), undefined, {
      ENABLE_LOGIN_UI_PROXY: undefined,
      ENABLE_LOGIN_UI_PATH_PROXY: 'true',
    });
    expect((await key(e)).status).toBe(200);
  });
});

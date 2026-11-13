/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- runs wait.js in a stub browser */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../index';
import { loadConfig } from '../config';
import { esc, pickLang, WAIT_JS } from '../html';
import { CSP } from '../respond';
import {
  CONSOLE,
  createTestDb,
  createUpstream,
  makeEnv,
  PORTAL,
  type TestDb,
  type Upstream,
} from './helpers';
import type { Env } from '../types';

let testDb: TestDb;
let upstream: Upstream;
let env: Env;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  testDb = createTestDb();
  upstream = createUpstream();
  env = await makeEnv(testDb);
});

const get = (path: string, init: RequestInit = {}) =>
  handleRequest(new Request(`${PORTAL}${path}`, init), env, upstream.deps);

const REQUIRED_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

describe('security headers on every response', () => {
  const cases: Array<[string, string, RequestInit?]> = [
    ['start page', '/'],
    ['wait page', '/wait'],
    ['status without a cookie', '/status'],
    ['healthz', '/healthz'],
    ['site.css', '/assets/site.css'],
    ['wait.js', '/assets/wait.js'],
    ['unknown path', '/nope'],
    ['wrong method', '/', { method: 'DELETE' }],
    ['start without origin', '/start', { method: 'POST' }],
  ];
  it.each(cases)('%s', async (_name, path, init) => {
    const response = await get(path, init);
    for (const [name, value] of Object.entries(REQUIRED_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
  });

  it('applies them to a response made while the config is invalid', async () => {
    const response = await handleRequest(
      new Request(`${PORTAL}/`),
      await makeEnv(testDb, { TURNSTILE_SECRET_KEY: undefined }),
      upstream.deps
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-security-policy')).toBe(CSP);
  });

  it('uses the specified policy', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
  });

  it('marks HTML and JSON no-store', async () => {
    for (const path of ['/', '/wait', '/status', '/nope']) {
      expect((await get(path)).headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('routing', () => {
  it('answers healthz, 404 and 405', async () => {
    const health = await get('/healthz');
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect((await get('/admin')).status).toBe(404);
    const wrong = await get('/start');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await get('/', { method })).status).toBe(405);
    }
    expect((await get('/status', { method: 'POST' })).status).toBe(405);
  });

  it('answers HEAD without a body', async () => {
    const response = await get('/', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('renders the start page even when the demo is full', async () => {
    env = await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '1' });
    testDb.sqlite.exec(
      "INSERT INTO demo_tenants (id,ticket_hash,ip_hash,state,created_at,expires_at,updated_at) VALUES ('demo-aaaaaaaaaa','h','i','failed',1,2,1)"
    );
    const response = await get('/');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('cf-turnstile');
    expect(html).toContain('data-sitekey="site-key-1"');
    expect(html).toContain('action="/start"');
    expect(html).toContain('12');
    const lower = html.toLowerCase();
    for (const inline of ['<style', 'style=', 'onclick=']) expect(lower).not.toContain(inline);
    expect(lower.split('<script').length).toBe(lower.split('<script src=').length);
  });

  it('serves the wait page with no inline script and the console origin in a meta tag', async () => {
    const html = await (await get('/wait')).text();
    expect(html).toContain('<script src="/assets/wait.js" defer></script>');
    expect(html).toContain(`<meta name="console-origin" content="${CONSOLE}">`);
    // Every script element loads a file: none carries code of its own.
    const lower = html.toLowerCase();
    expect(lower.split('<script').length).toBe(lower.split('<script src=').length);
  });

  it('serves wait.js as JavaScript that checks the console origin before navigating', async () => {
    const response = await get('/assets/wait.js');
    expect(response.headers.get('content-type')).toContain('javascript');
    const code = await response.text();
    expect(code).toBe(WAIT_JS);
    expect(code).toContain("join.indexOf(origin + '/admin/join#') === 0");
    expect(code).toContain('location.replace(join)');
    expect(code).toContain('2000');
    expect(code).toContain('180000');
    expect(code).not.toMatch(/innerHTML|eval\(|document\.write/);
  });
});

describe('wait.js behaviour', () => {
  async function run(join: unknown, state = 'ready') {
    const replaced: string[] = [];
    const attrs: Record<string, string> = { 'data-failed': 'FAILED', 'data-handed': 'HANDED' };
    const box = {
      textContent: '',
      getAttribute: (name: string) => attrs[name] ?? null,
    };
    const document = {
      querySelector: () => ({ getAttribute: () => CONSOLE }),
      getElementById: (id: string) =>
        id === 'status' ? box : { removeAttribute: () => undefined },
    };
    const fetchMock = async () => ({ status: 200, ok: true, json: async () => ({ state, join }) });
    new Function('document', 'location', 'fetch', 'setTimeout', 'Date', WAIT_JS)(
      document,
      { replace: (url: string) => replaced.push(url) },
      fetchMock,
      () => undefined,
      Date
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { replaced, text: box.textContent };
  }

  it('navigates only to the console join page', async () => {
    const ok = `${CONSOLE}/admin/join#code=a&email=b`;
    expect((await run(ok)).replaced).toEqual([ok]);
    for (const bad of [
      'https://evil.example/admin/join#code=a',
      `${CONSOLE}.evil.example/admin/join#x`,
      `${CONSOLE}/admin/join`,
      `${CONSOLE}/other#x`,
      'javascript:alert(1)',
      42,
      undefined,
    ]) {
      const result = await run(bad);
      expect(result.replaced).toEqual([]);
      expect(result.text).toBe('FAILED');
    }
  });
});

describe('escaping', () => {
  it('escapes the five HTML characters', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });

  it('escapes config values in the pages', async () => {
    env = await makeEnv(testDb, { TURNSTILE_SITE_KEY: '"><script>alert(1)</script>' });
    const html = await (await get('/')).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('data-sitekey="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});

describe('language', () => {
  it('picks ja only when Japanese is preferred', () => {
    expect(pickLang(null)).toBe('en');
    expect(pickLang('ja')).toBe('ja');
    expect(pickLang('ja-JP,ja;q=0.9,en;q=0.8')).toBe('ja');
    expect(pickLang('en-US,en;q=0.9,ja;q=0.8')).toBe('en');
    expect(pickLang('en;q=0.5,ja;q=0.9')).toBe('ja');
    expect(pickLang('fr,de')).toBe('en');
  });

  it('renders Japanese copy', async () => {
    const html = await (await get('/', { headers: { 'Accept-Language': 'ja' } })).text();
    expect(html).toContain('lang="ja"');
    expect(html).toContain('デモ環境');
  });
});

describe('configuration', () => {
  const valid = () => makeEnv(testDb);
  const problemsFor = async (overrides: Partial<Record<keyof Env, unknown>>) => {
    const result = loadConfig(await makeEnv(testDb, overrides));
    return result.ok ? [] : result.problems;
  };

  it('accepts the valid environment with defaults', async () => {
    const result = loadConfig(await valid());
    expect(result).toMatchObject({
      ok: true,
      config: { maxActiveTenants: 50, maxStartsPerIpPerDay: 3, tenantTtlHours: 12 },
    });
    const bare = await makeEnv(testDb, {
      MAX_ACTIVE_TENANTS: undefined,
      MAX_STARTS_PER_IP_PER_DAY: undefined,
      TENANT_TTL_HOURS: undefined,
    });
    expect(loadConfig(bare)).toMatchObject({
      ok: true,
      config: { maxActiveTenants: 50, maxStartsPerIpPerDay: 3, tenantTtlHours: 12 },
    });
  });

  it.each([
    ['http origin', { ADMIN_API_ORIGIN: 'http://api.demo-test.example' }, 'ADMIN_API_ORIGIN'],
    [
      'origin with a path',
      { CONSOLE_ORIGIN: 'https://console.demo-test.example/admin' },
      'CONSOLE_ORIGIN',
    ],
    ['origin with a slash', { PORTAL_ORIGIN: 'https://start.demo-test.example/' }, 'PORTAL_ORIGIN'],
    ['no origin', { ADMIN_API_ORIGIN: undefined }, 'ADMIN_API_ORIGIN'],
    [
      'loopback http outside development',
      { ADMIN_API_ORIGIN: 'http://localhost:8787' },
      'ADMIN_API_ORIGIN',
    ],
    ['missing secret', { TURNSTILE_SECRET_KEY: undefined }, 'TURNSTILE_SECRET_KEY'],
    ['missing client id', { MACHINE_CLIENT_ID: '' }, 'MACHINE_CLIENT_ID'],
    ['missing key id', { MACHINE_KEY_ID: undefined }, 'MACHINE_KEY_ID'],
    ['short ip secret', { IP_HASH_SECRET: 'short' }, 'IP_HASH_SECRET'],
    ['jwk not JSON', { MACHINE_PRIVATE_JWK: 'nope' }, 'MACHINE_PRIVATE_JWK'],
    [
      'jwk of another type',
      { MACHINE_PRIVATE_JWK: JSON.stringify({ kty: 'RSA', n: 'a', e: 'b', d: 'c' }) },
      'MACHINE_PRIVATE_JWK',
    ],
    [
      'jwk of another curve',
      { MACHINE_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b', d: 'c' }) },
      'MACHINE_PRIVATE_JWK',
    ],
    [
      'public jwk only',
      { MACHINE_PRIVATE_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }) },
      'MACHINE_PRIVATE_JWK',
    ],
    ['non-numeric limit', { MAX_ACTIVE_TENANTS: 'lots' }, 'MAX_ACTIVE_TENANTS'],
    ['fractional limit', { TENANT_TTL_HOURS: '1.5' }, 'TENANT_TTL_HOURS'],
  ])('rejects %s', async (_name, overrides, problem) => {
    expect(await problemsFor(overrides as Partial<Record<keyof Env, unknown>>)).toContain(problem);
  });

  it('allows loopback http only in development', async () => {
    const result = loadConfig(
      await makeEnv(testDb, {
        ENVIRONMENT: 'development',
        ADMIN_API_ORIGIN: 'http://localhost:8787',
        PORTAL_ORIGIN: 'http://127.0.0.1:8788',
      })
    );
    expect(result.ok).toBe(true);
    const nonLoopback = await problemsFor({
      ENVIRONMENT: 'development',
      ADMIN_API_ORIGIN: 'http://api.demo-test.example',
    });
    expect(nonLoopback).toContain('ADMIN_API_ORIGIN');
  });

  it('clamps numeric limits into their ranges', async () => {
    const result = loadConfig(
      await makeEnv(testDb, {
        MAX_ACTIVE_TENANTS: '9999',
        MAX_STARTS_PER_IP_PER_DAY: '0',
        TENANT_TTL_HOURS: '100',
      })
    );
    expect(result).toMatchObject({
      ok: true,
      config: { maxActiveTenants: 500, maxStartsPerIpPerDay: 1, tenantTtlHours: 24 },
    });
    const low = loadConfig(
      await makeEnv(testDb, { MAX_ACTIVE_TENANTS: '-5', TENANT_TTL_HOURS: '0' })
    );
    expect(low).toMatchObject({ ok: true, config: { maxActiveTenants: 1, tenantTtlHours: 1 } });
  });

  it('answers 503 with a generic page and never names a value', async () => {
    const bad = await makeEnv(testDb, { MACHINE_PRIVATE_JWK: 'super-secret-not-json' });
    for (const path of ['/', '/wait', '/status']) {
      const response = await handleRequest(new Request(`${PORTAL}${path}`), bad, upstream.deps);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain('super-secret-not-json');
      expect(text).not.toContain('MACHINE_PRIVATE_JWK');
    }
    const start = await handleRequest(
      new Request(`${PORTAL}/start`, { method: 'POST', headers: { Origin: PORTAL } }),
      bad,
      upstream.deps
    );
    expect(start.status).toBe(503);
    expect(upstream.calls).toHaveLength(0);
    expect((await handleRequest(new Request(`${PORTAL}/healthz`), bad, upstream.deps)).status).toBe(
      200
    );
  });
});

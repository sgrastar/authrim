/**
 * Mutation-driven tests: router-side Cache API handling for public authentication methods.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../index';
import {
  createMockCache,
  createMockEnv,
  createMockKV,
  isolateGlobalCaches,
  type MockEnv,
} from './helpers/router-env';

const STATUS = 'X-Authrim-Router-Authentication-Methods-Cache';
const URL_ = 'https://first.example.com/api/auth/authentication-methods';

let env: MockEnv;
let cache: ReturnType<typeof createMockCache>;
let restore: () => void;
beforeEach(() => {
  restore = isolateGlobalCaches();
  env = createMockEnv();
  cache = createMockCache();
  (globalThis as { caches?: unknown }).caches = { default: cache };
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const withCache = (extra: Record<string, unknown> = {}) => ({
  ...env,
  BASE_DOMAIN: 'example.com',
  SETTINGS: createMockKV(),
  ...extra,
});

const jsonResponse = (headers: Record<string, string> = {}, status = 200) =>
  new Response('{"ok":true}', {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const status = async (e: Record<string, unknown>, init?: RequestInit, url = URL_) =>
  (await app.fetch(new Request(url, init), e)).headers.get(STATUS);

describe('router cache TTL configuration', () => {
  const storedMaxAge = () => [...cache.store.values()][0]?.headers.get('Cache-Control');

  it('defaults to one day', async () => {
    await status(withCache());
    expect(storedMaxAge()).toBe('public, max-age=86400');
  });

  it('honours the router TTL and truncates fractions', async () => {
    await status(withCache({ AUTHENTICATION_METHODS_ROUTER_CACHE_TTL: '3600.9' }));
    expect(storedMaxAge()).toBe('public, max-age=3600');
  });

  it('falls back to the edge TTL when the router TTL is unset', async () => {
    await status(withCache({ AUTHENTICATION_METHODS_EDGE_CACHE_TTL: '600' }));
    expect(storedMaxAge()).toBe('public, max-age=600');
  });

  it('prefers the router TTL over the edge TTL', async () => {
    await status(
      withCache({
        AUTHENTICATION_METHODS_ROUTER_CACHE_TTL: '120',
        AUTHENTICATION_METHODS_EDGE_CACHE_TTL: '600',
      })
    );
    expect(storedMaxAge()).toBe('public, max-age=120');
  });

  it('clamps to a seven day maximum', async () => {
    await status(withCache({ AUTHENTICATION_METHODS_ROUTER_CACHE_TTL: '99999999' }));
    expect(storedMaxAge()).toBe('public, max-age=604800');
  });

  it.each(['abc', '', 'Infinity', 'NaN'])('ignores the unusable TTL %j', async (ttl) => {
    await status(withCache({ AUTHENTICATION_METHODS_ROUTER_CACHE_TTL: ttl }));
    expect(storedMaxAge()).toBe('public, max-age=86400');
  });

  it.each(['0', '-5'])('disables caching for TTL %s', async (ttl) => {
    const e = withCache({ AUTHENTICATION_METHODS_ROUTER_CACHE_TTL: ttl });
    expect(await status(e)).toBe('bypass');
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('accepts the minimum positive TTL', async () => {
    const e = withCache({ AUTHENTICATION_METHODS_ROUTER_CACHE_TTL: '1' });
    expect(await status(e)).toBe('miss');
    expect(storedMaxAge()).toBe('public, max-age=1');
  });
});

describe('cache eligibility', () => {
  it.each([
    ['Authorization', { Authorization: 'Bearer x' }],
    ['Cache-Control: no-cache', { 'Cache-Control': 'no-cache' }],
    ['Cache-Control: no-store', { 'Cache-Control': 'max-age=0, No-Store' }],
    ['Cache-Control: NO-CACHE', { 'Cache-Control': 'NO-CACHE' }],
    ['Pragma: no-cache', { Pragma: 'No-Cache' }],
  ])('bypasses the cache for %s', async (_label, headers) => {
    const e = withCache();
    expect(await status(e, { headers })).toBe('bypass');
    expect(cache.match).not.toHaveBeenCalled();
    expect(env.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
  });

  it('still caches with unrelated Cache-Control and Pragma values', async () => {
    const e = withCache();
    expect(await status(e, { headers: { 'Cache-Control': 'max-age=5', Pragma: 'other' } })).toBe(
      'miss'
    );
  });

  it('bypasses without a SETTINGS binding', async () => {
    expect(await status({ ...env, BASE_DOMAIN: 'example.com' })).toBe('bypass');
    expect(cache.match).not.toHaveBeenCalled();
  });

  it('bypasses when no tenant can be derived from the host', async () => {
    expect(
      await status(withCache(), undefined, 'https://unrelated.test/api/auth/authentication-methods')
    ).toBe('bypass');
    expect(cache.match).not.toHaveBeenCalled();
  });

  it('bypasses when the Cache API is unavailable', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    expect(await status(withCache())).toBe('bypass');
    expect(env.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('cacheable upstream responses', () => {
  const upstream = (res: Response) => env.OP_MANAGEMENT.fetch.mockResolvedValueOnce(res);

  it('stores a plain 200 JSON response (case-insensitive content type)', async () => {
    upstream(jsonResponse({ 'Content-Type': 'Application/JSON; charset=utf-8' }));
    expect(await status(withCache())).toBe('miss');
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a non-200 status', () => jsonResponse({}, 404)],
    ['a 201 status', () => jsonResponse({}, 201)],
    ['a non-JSON body', () => jsonResponse({ 'Content-Type': 'text/html' })],
    ['a Set-Cookie header', () => jsonResponse({ 'Set-Cookie': 'a=b' })],
    ['Cache-Control: no-store', () => jsonResponse({ 'Cache-Control': 'No-Store' })],
    ['Cache-Control: private', () => jsonResponse({ 'Cache-Control': 'PRIVATE, max-age=5' })],
  ])('does not store %s', async (_label, make) => {
    upstream(make());
    expect(await status(withCache())).toBe('bypass');
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('stores a response whose Cache-Control is otherwise public', async () => {
    upstream(jsonResponse({ 'Cache-Control': 'public, max-age=10' }));
    expect(await status(withCache())).toBe('miss');
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it('serves the same body from the cache on the second request', async () => {
    upstream(jsonResponse());
    const e = withCache();
    const first = await app.fetch(new Request(URL_), e);
    expect(first.headers.get(STATUS)).toBe('miss');
    expect(await first.json()).toEqual({ ok: true });
    const second = await app.fetch(new Request(URL_), e);
    expect(second.headers.get(STATUS)).toBe('hit');
    expect(await second.json()).toEqual({ ok: true });
    expect(env.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('cache key and failure handling', () => {
  it('keys by tenant, host, path, query, revision and response shape', async () => {
    const e = withCache({
      SETTINGS: createMockKV({
        'cache:authentication-methods:v1:revision:tenant:first': 'rev-9',
      }),
    });
    await status(e, undefined, `${URL_}?client_id=a`);
    const key = new URL([...cache.store.keys()][0]);
    expect(key.origin).toBe('https://authrim-router.internal');
    expect(key.pathname).toMatch(/^\/cache\/authentication-methods\/v3\/shape-\d+$/);
    expect(key.searchParams.get('tenant')).toBe('first');
    expect(key.searchParams.get('host')).toBe('first.example.com');
    expect(key.searchParams.get('path')).toBe('/api/auth/authentication-methods');
    expect(key.searchParams.get('query')).toBe('?client_id=a');
    expect(key.searchParams.get('revision')).toContain('rev-9');
  });

  it('serves from upstream when the cache lookup throws', async () => {
    cache.match.mockRejectedValueOnce(new Error('cache down'));
    expect(await status(withCache())).toBe('bypass');
    expect(env.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('serves from upstream when the revision read throws', async () => {
    const e = withCache({
      SETTINGS: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
      },
    });
    expect(await status(e)).toBe('bypass');
    expect(env.OP_MANAGEMENT.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not fail the request when storing fails', async () => {
    cache.put.mockRejectedValueOnce(new Error('quota'));
    const res = await app.fetch(new Request(URL_), withCache());
    expect(res.status).toBe(200);
    expect(res.headers.get(STATUS)).toBe('miss');
  });

  it('hands the store to waitUntil when an execution context exists', async () => {
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    await app.fetch(new Request(URL_), withCache(), ctx);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it('awaits the store itself when there is no execution context', async () => {
    let finished = false;
    cache.put.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 15));
      finished = true;
    });
    await app.fetch(new Request(URL_), withCache());
    expect(finished).toBe(true);
  });

  it('does not wait for the store when waitUntil owns it', async () => {
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cache.put.mockImplementationOnce(async () => {
      await gate;
      finished = true;
    });
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    await app.fetch(new Request(URL_), withCache(), ctx);
    expect(finished).toBe(false);
    release();
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(finished).toBe(true);
  });
});

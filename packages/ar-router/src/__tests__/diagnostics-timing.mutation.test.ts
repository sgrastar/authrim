/**
 * Mutation-driven tests: header-gated Server-Timing diagnostics.
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

/** Make performance.now() return the given readings in order, then keep the last one. */
function scriptClock(rawReadings: number[]) {
  // A non-zero base makes `now - start` distinguishable from `now + start`.
  const readings = rawReadings.map((n) => n + 1000);
  const queue = [...readings];
  let last = readings[readings.length - 1];
  vi.spyOn(performance, 'now').mockImplementation(() => {
    if (queue.length > 0) last = queue.shift() as number;
    return last;
  });
}

const interactions = (headers: Record<string, string>) =>
  new Request('https://id.example.com/api/v1/login/interactions/start', { headers });

describe('service binding diagnostics gating', () => {
  it.each(['true', '1', 'yes', 'TRUE', ' Yes '])('is enabled by %j', async (flag) => {
    const res = await app.fetch(interactions({ 'X-Diagnostic-Session-Id': 'sess-1' }), {
      ...env,
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: flag,
    });
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('sess-1');
    expect(res.headers.get('Server-Timing')).toContain('router_total;dur=');
  });

  it.each([undefined, 'false', '0', '', 'no', 'enabled'])('is off for %j', async (flag) => {
    const res = await app.fetch(interactions({ 'X-Diagnostic-Session-Id': 'sess-1' }), {
      ...env,
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: flag,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toBeNull();
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });

  it.each([undefined, '', '   '])('does nothing without a usable session id (%j)', async (id) => {
    const headers: Record<string, string> = {};
    if (id !== undefined) headers['X-Diagnostic-Session-Id'] = id;
    const res = await app.fetch(interactions(headers), {
      ...env,
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
    });
    expect(res.headers.get('Server-Timing')).toBeNull();
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
  });

  it('sanitizes the echoed session id', async () => {
    const res = await app.fetch(
      interactions({ 'X-Diagnostic-Session-Id': '  ab c/d<e>.f:g_h-i  ' }),
      { ...env, AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true' }
    );
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('ab_c_d_e_.f:g_h-i');
  });

  it('caps the echoed session id at 128 characters', async () => {
    const res = await app.fetch(interactions({ 'X-Diagnostic-Session-Id': 'a'.repeat(300) }), {
      ...env,
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
    });
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('a'.repeat(128));
  });
});

describe('service binding diagnostics output', () => {
  it('reports rounded span durations, preserving the upstream response', async () => {
    env.OP_AUTH.fetch.mockResolvedValueOnce(
      new Response('payload', {
        status: 201,
        statusText: 'Created',
        headers: { 'Server-Timing': 'upstream;dur=1.0', 'X-Up': 'yes' },
      })
    );
    // total start, prepare start/end, fetch start/end, total end
    scriptClock([0, 0, 2.26, 10, 14.04, 20]);
    const res = await app.fetch(interactions({ 'X-Diagnostic-Session-Id': 's' }), {
      ...env,
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
    });
    expect(res.status).toBe(201);
    expect(res.statusText).toBe('Created');
    expect(await res.text()).toBe('payload');
    expect(res.headers.get('X-Up')).toBe('yes');
    expect(res.headers.get('Server-Timing')).toBe(
      'upstream;dur=1.0, router_prepare_request;dur=2.3, router_service_fetch;dur=4.0, router_total;dur=20.0'
    );
  });

  it('sets Server-Timing alone when the upstream sent none', async () => {
    scriptClock([0, 0, 1, 2, 3, 4]);
    const res = await app.fetch(interactions({ 'X-Diagnostic-Session-Id': 's' }), {
      ...env,
      AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
    });
    expect(res.headers.get('Server-Timing')).toBe(
      'router_prepare_request;dur=1.0, router_service_fetch;dur=1.0, router_total;dur=4.0'
    );
  });

  it('forwards the original request to OP_AUTH with the public host', async () => {
    await app.fetch(interactions({ 'X-Diagnostic-Session-Id': 's' }), env);
    const forwarded = env.OP_AUTH.fetch.mock.calls[0][0];
    expect(new URL(forwarded.url).pathname).toBe('/api/v1/login/interactions/start');
    expect(forwarded.headers.get('Host')).toBe('id.example.com');
  });
});

describe('authentication methods diagnostics', () => {
  const cacheEnv = () => ({
    ...env,
    BASE_DOMAIN: 'example.com',
    SETTINGS: createMockKV(),
    AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true',
  });
  const req = () =>
    new Request('https://first.example.com/api/auth/authentication-methods', {
      headers: { 'X-Diagnostic-Session-Id': 'am-1' },
    });

  it('reports every span of a cache miss', async () => {
    (globalThis as { caches?: unknown }).caches = { default: createMockCache() };
    scriptClock([0, 0, 1, 10, 12.04, 20, 23, 30, 35, 40, 41.6, 100]);
    const res = await app.fetch(req(), cacheEnv());
    expect(res.headers.get('X-Authrim-Router-Authentication-Methods-Cache')).toBe('miss');
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('am-1');
    expect(res.headers.get('Server-Timing')).toBe(
      [
        'router_prepare_request;dur=1.0',
        'router_revision_read;dur=2.0',
        'router_cache_match;dur=3.0',
        'router_service_fetch;dur=5.0',
        'router_cache_put;dur=1.6',
        'router_total;dur=100.0',
      ].join(', ')
    );
  });

  it('reports the spans of a cache hit without touching upstream', async () => {
    (globalThis as { caches?: unknown }).caches = { default: createMockCache() };
    const e = cacheEnv();
    await app.fetch(req(), e);
    env.OP_MANAGEMENT.fetch.mockClear();
    scriptClock([0, 0, 1, 2, 4, 5, 8, 20]);
    const res = await app.fetch(req(), e);
    expect(res.headers.get('X-Authrim-Router-Authentication-Methods-Cache')).toBe('hit');
    expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    expect(res.headers.get('Server-Timing')).toBe(
      'router_prepare_request;dur=1.0, router_revision_read;dur=2.0, router_cache_match;dur=3.0, router_total;dur=20.0'
    );
  });

  it('reports a bypass without cache spans', async () => {
    scriptClock([0, 0, 1, 3, 7, 9]);
    const res = await app.fetch(req(), cacheEnv());
    expect(res.headers.get('X-Authrim-Router-Authentication-Methods-Cache')).toBe('bypass');
    expect(res.headers.get('Server-Timing')).toBe(
      'router_prepare_request;dur=1.0, router_service_fetch;dur=4.0, router_total;dur=9.0'
    );
  });

  it('adds no diagnostics when the flag is off', async () => {
    const res = await app.fetch(req(), { ...cacheEnv(), AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'no' });
    expect(res.headers.get('Server-Timing')).toBeNull();
    expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBeNull();
    expect(res.headers.get('X-Authrim-Router-Authentication-Methods-Cache')).toBe('bypass');
  });

  it('adds no diagnostics without a session id', async () => {
    const res = await app.fetch(
      new Request('https://first.example.com/api/auth/authentication-methods'),
      cacheEnv()
    );
    expect(res.headers.get('Server-Timing')).toBeNull();
  });
});

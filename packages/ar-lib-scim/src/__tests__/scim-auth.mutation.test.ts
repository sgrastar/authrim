/**
 * SCIM auth middleware - mutation-hardening tests
 *
 * Pins rate-limit arithmetic, tenant resolution, token validation branches, log payloads
 * and token administration helpers. Time is controlled with fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';

const logSink = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const getLoggerModule = vi.fn((_name: string) => logSink);
const createLoggerModule = vi.fn((_name: string) => logSink);

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({ module: getLoggerModule }),
    createLogger: () => ({ module: createLoggerModule }),
  };
});

import {
  generateScimToken,
  listScimTokens,
  revokeScimToken,
  scimAuthMiddleware,
} from '../middleware/scim-auth';

const NOW_MS = Date.parse('2026-01-01T00:00:00Z');
const NOW_S = NOW_MS / 1000;

type Record_ = { count: number; resetAt: number };

function createKV() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _options?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((name) => !options?.prefix || name.startsWith(options.prefix))
        .map((name) => ({ name })),
    })),
  };
  return { kv: kv as unknown as KVNamespace, mock: kv, store };
}

function createLimiter(status: Record<string, Record_ | null> = {}, current = 1) {
  const limiter = {
    getStatusRpc: vi.fn(async (key: string) => status[key] ?? null),
    incrementRpc: vi.fn(async () => ({ current })),
    resetRpc: vi.fn(async () => true),
  };
  const idFromName = vi.fn((name: string) => ({ name }));
  const binding = { idFromName, get: vi.fn(() => limiter) } as unknown as Env['RATE_LIMITER'];
  return { limiter, idFromName, binding };
}

function createEnv(overrides: Partial<Env> = {}) {
  const { kv, mock, store } = createKV();
  const env = {
    INITIAL_ACCESS_TOKENS: kv,
    ENABLE_SCIM_AUTH_RATE_LIMIT: 'false',
    ...overrides,
  } as Env;
  return { env, kv: mock, store };
}

function createApp(tenantId?: string) {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    if (tenantId !== undefined) {
      c.set('tenantId', tenantId);
    }
    await next();
  });
  app.use('*', scimAuthMiddleware);
  app.get('/Users', (c) => c.json({ ok: true }));
  return app;
}

async function sha256Hex(value: string): Promise<string> {
  return createHash('sha256').update(value).digest('hex');
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { headers: { Authorization: `Bearer ${token}`, ...extra } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tenant resolution', () => {
  it('trims the tenant id taken from the request context', async () => {
    const { env } = createEnv({ BASE_DOMAIN: 'example.com' });
    const { token } = await generateScimToken(env, { tenantId: 'tenant-a' });
    const res = await createApp('  tenant-a \n').request('/Users', bearer(token), env);
    expect(res.status).toBe(200);
  });

  it('falls back to the default tenant when the context tenant is blank (single tenant)', async () => {
    const { env } = createEnv({ DEFAULT_TENANT_ID: 'solo' });
    const { token } = await generateScimToken(env);
    const res = await createApp('   ').request('/Users', bearer(token), env);
    expect(res.status).toBe(200);
  });

  it('refuses a blank context tenant in multi-tenant mode', async () => {
    const { env } = createEnv({ BASE_DOMAIN: 'example.com' });
    const res = await createApp('   ').request('/Users', bearer('x'), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '403',
      detail: 'Tenant context is required',
    });
    expect(logSink.warn).toHaveBeenCalledWith('Auth attempt failed', {
      event: 'scim_auth_attempt',
      clientIP: 'unknown',
      success: false,
      reason: 'missing_tenant_context',
    });
  });

  it('uses the configured default tenant when there is no context tenant', async () => {
    const { env } = createEnv({ DEFAULT_TENANT_ID: 'solo' });
    const { token } = await generateScimToken(env, { tenantId: 'solo' });
    const res = await createApp().request('/Users', bearer(token), env);
    expect(res.status).toBe(200);
  });

  it('uses the built-in default tenant when none is configured', async () => {
    const { env, store } = createEnv();
    const { token, tokenHash } = await generateScimToken(env);
    expect([...store.keys()]).toEqual([`scim:default:${tokenHash}`]);
    const res = await createApp().request('/Users', bearer(token), env);
    expect(res.status).toBe(200);
  });

  it('works with a context that has no get()', async () => {
    const { env } = createEnv();
    const { token } = await generateScimToken(env);
    const set = vi.fn();
    const next = vi.fn(async () => undefined);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const c = {
      env,
      req: { header: (name: string) => headers[name] },
      header: vi.fn(),
      set,
      json: vi.fn(),
    } as unknown as Context<{ Bindings: Env }>;
    await scimAuthMiddleware(c, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('scimTokenRef', await sha256Hex(token));
  });

  it('uses the SCIM-AUTH logger module', async () => {
    const { env } = createEnv();
    await createApp('default').request('/Users', {}, env);
    expect(getLoggerModule).toHaveBeenCalledWith('SCIM-AUTH');
  });
});

describe('client IP', () => {
  async function ipUsed(headers: Record<string, string>): Promise<string> {
    const { binding, idFromName } = createLimiter();
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      SCIM_AUTH_FAILURE_DELAY_MS: '1',
      RATE_LIMITER: binding,
    });
    await createApp('default').request('/Users', { headers }, env);
    return (idFromName.mock.calls[0] as string[])[0];
  }

  it('prefers CF-Connecting-IP', async () => {
    expect(
      await ipUsed({
        'CF-Connecting-IP': '192.0.2.1',
        'X-Forwarded-For': '203.0.113.9',
        'X-Real-IP': '198.51.100.1',
      })
    ).toBe('scim-auth:192.0.2.1');
  });

  it('uses the first trimmed X-Forwarded-For address', async () => {
    expect(await ipUsed({ 'X-Forwarded-For': '  203.0.113.9 , 198.51.100.1' })).toBe(
      'scim-auth:203.0.113.9'
    );
  });

  it('falls back to X-Real-IP, then unknown', async () => {
    expect(await ipUsed({ 'X-Forwarded-For': ' ', 'X-Real-IP': '198.51.100.1' })).toBe(
      'scim-auth:198.51.100.1'
    );
    expect(await ipUsed({})).toBe('scim-auth:unknown');
  });
});

describe('rate limit check', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_MS });
  });

  async function run(status: Record<string, Record_ | null>, envOverrides: Partial<Env> = {}) {
    const limiter = createLimiter(status);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      SCIM_AUTH_MAX_FAILED_ATTEMPTS: '3',
      SCIM_AUTH_FAILURE_DELAY_MS: '1',
      RATE_LIMITER: limiter.binding,
      ...envOverrides,
    });
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const promise = createApp('default').request('/Users', bearer(token), env);
    await vi.advanceTimersByTimeAsync(10);
    return { res: await promise, ...limiter };
  }

  it('refuses with the remaining lockout time while locked out', async () => {
    const { res, limiter } = await run({ 'unknown:lockout': { count: 1, resetAt: NOW_S + 120 } });
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBe('120');
    expect(await res.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'Too many failed authentication attempts. Please try again in 120 seconds.',
    });
    expect(limiter.getStatusRpc).toHaveBeenCalledTimes(1);
    expect(logSink.warn).toHaveBeenCalledWith('Auth attempt failed', {
      event: 'scim_auth_attempt',
      clientIP: 'unknown',
      success: false,
      reason: 'rate_limited',
      retryAfter: 120,
    });
  });

  it('ignores a lockout that ends exactly now', async () => {
    const { res } = await run({ 'unknown:lockout': { count: 1, resetAt: NOW_S } });
    expect(res.status).toBe(200);
  });

  it('ignores a lockout that has ended', async () => {
    const { res } = await run({ 'unknown:lockout': { count: 1, resetAt: NOW_S - 5 } });
    expect(res.status).toBe(200);
  });

  it('allows failures below the limit', async () => {
    const { res } = await run({ unknown: { count: 2, resetAt: NOW_S + 100 } });
    expect(res.status).toBe(200);
  });

  it('refuses when the failure count reaches the limit, telling when the window ends', async () => {
    const { res } = await run({ unknown: { count: 3, resetAt: NOW_S + 50 } });
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBe('50');
  });

  it('refuses when the failure count is above the limit', async () => {
    const { res } = await run({ unknown: { count: 9, resetAt: NOW_S + 70 } });
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBe('70');
  });

  it('does not count failures from a window that ends exactly now', async () => {
    const { res } = await run({ unknown: { count: 3, resetAt: NOW_S } });
    expect(res.status).toBe(200);
  });

  it('does not count failures from a window that has ended', async () => {
    const { res } = await run({ unknown: { count: 3, resetAt: NOW_S - 1 } });
    expect(res.status).toBe(200);
  });

  it('uses the default limit of five failed attempts', async () => {
    const four = await run(
      { unknown: { count: 4, resetAt: NOW_S + 10 } },
      { SCIM_AUTH_MAX_FAILED_ATTEMPTS: undefined }
    );
    expect(four.res.status).toBe(200);
    const five = await run(
      { unknown: { count: 5, resetAt: NOW_S + 10 } },
      { SCIM_AUTH_MAX_FAILED_ATTEMPTS: undefined }
    );
    expect(five.res.status).toBe(401);
  });

  it('refuses authentication when the limiter is not configured', async () => {
    const { env } = createEnv({ ENABLE_SCIM_AUTH_RATE_LIMIT: 'true' });
    const res = await createApp('default').request('/Users', bearer('x'), env);
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toMatchObject({
      detail: 'Too many failed authentication attempts. Please try again in 60 seconds.',
    });
    expect(logSink.error).toHaveBeenCalledWith(
      'RATE_LIMITER binding is not configured; refusing SCIM authentication',
      {}
    );
  });

  it('refuses authentication when the limiter fails', async () => {
    const limiter = createLimiter();
    const failure = new Error('do down');
    limiter.limiter.getStatusRpc.mockRejectedValue(failure);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      RATE_LIMITER: limiter.binding,
    });
    const res = await createApp('default').request('/Users', bearer('x'), env);
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(logSink.error).toHaveBeenCalledWith('Rate limit check error', {}, failure);
  });

  it('does not consult the limiter when rate limiting is disabled', async () => {
    const limiter = createLimiter({ 'unknown:lockout': { count: 1, resetAt: NOW_S + 500 } });
    const { env } = createEnv({ RATE_LIMITER: limiter.binding });
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const res = await createApp('default').request('/Users', bearer(token), env);
    expect(res.status).toBe(200);
    expect(limiter.limiter.getStatusRpc).not.toHaveBeenCalled();
    expect(limiter.limiter.resetRpc).not.toHaveBeenCalled();
  });
});

describe('failure recording and delay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_MS });
    // A fixed, already-resolved digest keeps the delay timer registration independent of the
    // platform's asynchronous hashing, so the fake clock never races it.
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
  });

  afterEach(() => {
    vi.mocked(crypto.subtle.digest).mockRestore();
  });

  async function settledAfter(
    envOverrides: Partial<Env>,
    status: Record<string, Record_ | null>,
    delays: number[],
    request: RequestInit = {}
  ) {
    const limiter = createLimiter(status);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      RATE_LIMITER: limiter.binding,
      ...envOverrides,
    });
    let settled = false;
    const promise = Promise.resolve(createApp('default').request('/Users', request, env)).then(
      (res) => {
        settled = true;
        return res;
      }
    );
    // Let the token hash settle so that the delay timer is registered before time moves.
    for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(0);
    const states: boolean[] = [];
    for (const step of delays) {
      await vi.advanceTimersByTimeAsync(step);
      states.push(settled);
    }
    return { states, response: await promise, ...limiter };
  }

  it('waits the configured base delay after a first failure', async () => {
    const { states, response } = await settledAfter(
      { SCIM_AUTH_FAILURE_DELAY_MS: '100', SCIM_AUTH_MAX_FAILED_ATTEMPTS: '10' },
      {},
      [99, 1]
    );
    expect(states).toEqual([false, true]);
    expect(response.status).toBe(401);
  });

  it('uses a 200 ms base delay by default', async () => {
    const { states } = await settledAfter({}, {}, [199, 1]);
    expect(states).toEqual([false, true]);
  });

  it('backs off by a factor of 1.5 per earlier failure', async () => {
    const { states } = await settledAfter(
      { SCIM_AUTH_FAILURE_DELAY_MS: '100', SCIM_AUTH_MAX_FAILED_ATTEMPTS: '10' },
      { unknown: { count: 2, resetAt: NOW_S + 100 } },
      [224, 1]
    );
    expect(states).toEqual([false, true]);
  });

  it.each([
    ['an invalid authorization format', { headers: { Authorization: 'Basic abc' } }],
    ['an unknown token', { headers: { Authorization: 'Bearer unknown-token' } }],
  ])('backs off for %s as for a missing header', async (_label, request) => {
    const { states, response } = await settledAfter(
      { SCIM_AUTH_FAILURE_DELAY_MS: '100', SCIM_AUTH_MAX_FAILED_ATTEMPTS: '10' },
      { unknown: { count: 2, resetAt: NOW_S + 100 } },
      [224, 1],
      request
    );
    expect(states).toEqual([false, true]);
    expect(response.status).toBe(401);
  });

  it('caps the delay at two seconds', async () => {
    const { states } = await settledAfter(
      { SCIM_AUTH_FAILURE_DELAY_MS: '1000', SCIM_AUTH_MAX_FAILED_ATTEMPTS: '10' },
      { unknown: { count: 3, resetAt: NOW_S + 100 } },
      [1999, 1]
    );
    expect(states).toEqual([false, true]);
  });

  it('applies no delay when rate limiting is disabled', async () => {
    const { states, response } = await settledAfter(
      { ENABLE_SCIM_AUTH_RATE_LIMIT: 'false', SCIM_AUTH_FAILURE_DELAY_MS: '500' },
      {},
      [0]
    );
    expect(states).toEqual([true]);
    expect(response.status).toBe(401);
  });

  it('records a failure with the configured window and limit', async () => {
    const { limiter, idFromName } = await settledAfter(
      {
        SCIM_AUTH_FAILURE_DELAY_MS: '1',
        SCIM_AUTH_MAX_FAILED_ATTEMPTS: '4',
        SCIM_AUTH_WINDOW_SECONDS: '30',
        SCIM_AUTH_LOCKOUT_SECONDS: '600',
      },
      {},
      [5],
      { headers: { 'CF-Connecting-IP': '192.0.2.4' } }
    );
    expect(idFromName.mock.calls).toEqual([['scim-auth:192.0.2.4'], ['scim-auth:192.0.2.4']]);
    expect(limiter.incrementRpc.mock.calls).toEqual([
      ['192.0.2.4', { windowSeconds: 30, maxRequests: 4 }],
    ]);
  });

  it('uses the default window of 300 seconds and records a lockout of 900 seconds', async () => {
    const limiter = createLimiter({}, 5);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      SCIM_AUTH_FAILURE_DELAY_MS: '1',
      RATE_LIMITER: limiter.binding,
    });
    const promise = createApp('default').request('/Users', {}, env);
    await vi.advanceTimersByTimeAsync(5);
    await promise;
    expect(limiter.limiter.incrementRpc.mock.calls).toEqual([
      ['unknown', { windowSeconds: 300, maxRequests: 5 }],
      ['unknown:lockout', { windowSeconds: 900, maxRequests: 0 }],
    ]);
  });

  it('does not lock out below the limit', async () => {
    const limiter = createLimiter({}, 4);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      SCIM_AUTH_FAILURE_DELAY_MS: '1',
      RATE_LIMITER: limiter.binding,
    });
    const promise = createApp('default').request('/Users', {}, env);
    await vi.advanceTimersByTimeAsync(5);
    await promise;
    expect(limiter.limiter.incrementRpc).toHaveBeenCalledTimes(1);
  });

  it('records nothing when rate limiting is disabled', async () => {
    const { limiter } = await settledAfter({ ENABLE_SCIM_AUTH_RATE_LIMIT: 'false' }, {}, [0]);
    expect(limiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('logs and still answers when recording the failure fails', async () => {
    const limiter = createLimiter();
    const failure = new Error('increment failed');
    limiter.limiter.incrementRpc.mockRejectedValue(failure);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      SCIM_AUTH_FAILURE_DELAY_MS: '1',
      RATE_LIMITER: limiter.binding,
    });
    const promise = createApp('default').request('/Users', {}, env);
    await vi.advanceTimersByTimeAsync(5);
    expect((await promise).status).toBe(401);
    expect(logSink.error).toHaveBeenCalledWith('Failed to record failed attempt', {}, failure);
  });

  it('clears both counters for the client after a successful login', async () => {
    const limiter = createLimiter();
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      RATE_LIMITER: limiter.binding,
    });
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const res = await createApp('default').request(
      '/Users',
      bearer(token, { 'CF-Connecting-IP': '192.0.2.8' }),
      env
    );
    expect(res.status).toBe(200);
    expect(limiter.idFromName.mock.calls).toEqual([
      ['scim-auth:192.0.2.8'],
      ['scim-auth:192.0.2.8'],
    ]);
    expect(limiter.limiter.resetRpc.mock.calls).toEqual([['192.0.2.8'], ['192.0.2.8:lockout']]);
  });

  it('logs and continues when clearing the counters fails', async () => {
    const limiter = createLimiter();
    const failure = new Error('reset failed');
    limiter.limiter.resetRpc.mockRejectedValue(failure);
    const { env } = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      RATE_LIMITER: limiter.binding,
    });
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const res = await createApp('default').request('/Users', bearer(token), env);
    expect(res.status).toBe(200);
    expect(logSink.error).toHaveBeenCalledWith(
      'Failed to clear SCIM authentication attempts',
      {},
      failure
    );
  });
});

describe('authorization header handling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_MS });
  });

  async function refuse(headers: Record<string, string>) {
    const { env } = createEnv();
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, value.replace('<token>', token)])
    );
    const res = await createApp('default').request('/Users', { headers: resolved }, env);
    return { res, body: await res.json() };
  }

  it('reports a missing header', async () => {
    const { res, body } = await refuse({});
    expect(res.status).toBe(401);
    expect(body).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'Authentication failed',
    });
    expect(logSink.warn).toHaveBeenCalledWith('Auth attempt failed', {
      event: 'scim_auth_attempt',
      clientIP: 'unknown',
      success: false,
      reason: 'missing_auth_header',
    });
  });

  it.each([
    ['another scheme', 'Basic <token>'],
    ['extra parts', 'Bearer <token> extra'],
    ['no token', 'Bearer'],
  ])('rejects %s as an invalid format', async (_label, header) => {
    const { res, body } = await refuse({ Authorization: header });
    expect(res.status).toBe(401);
    expect(body).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail: 'Authentication failed',
    });
    expect(logSink.warn).toHaveBeenCalledWith('Auth attempt failed', {
      event: 'scim_auth_attempt',
      clientIP: 'unknown',
      success: false,
      reason: 'invalid_auth_format',
    });
  });

  it('logs an unknown token as invalid_token and a good one as success', async () => {
    const { env } = createEnv();
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const bad = await createApp('default').request('/Users', bearer('nope'), env);
    expect(bad.status).toBe(401);
    expect(logSink.warn).toHaveBeenCalledWith('Auth attempt failed', {
      event: 'scim_auth_attempt',
      clientIP: 'unknown',
      success: false,
      reason: 'invalid_token',
    });
    expect(logSink.info).not.toHaveBeenCalled();
    const good = await createApp('default').request('/Users', bearer(token), env);
    expect(good.status).toBe(200);
    expect(logSink.info).toHaveBeenCalledWith('Auth attempt succeeded', {
      event: 'scim_auth_attempt',
      clientIP: 'unknown',
      success: true,
    });
  });

  it('answers 500 when a later handler throws', async () => {
    const { env } = createEnv();
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const failure = new Error('downstream');
    const json = vi.fn((body: unknown, status: number) => ({ body, status }));
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const c = {
      env,
      req: { header: (name: string) => headers[name] },
      get: (key: string) => (key === 'tenantId' ? 'default' : undefined),
      set: vi.fn(),
      header: vi.fn(),
      json,
    } as unknown as Context<{ Bindings: Env }>;
    const result = await scimAuthMiddleware(c, async () => {
      throw failure;
    });
    expect(result).toEqual({
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '500',
        detail: 'Internal server error during authentication',
      },
      status: 500,
    });
    expect(logSink.error).toHaveBeenCalledWith('Validation error', {}, failure);
  });
});

describe('stored token validation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_MS });
  });

  async function authenticate(
    data: Record<string, unknown> | string,
    tenantId = 'tenant-a',
    requestTenant = 'tenant-a'
  ) {
    const { env, kv } = createEnv({ BASE_DOMAIN: 'example.com' });
    const token = 'plain-token';
    const hash = await sha256Hex(token);
    await kv.put(
      `scim:${tenantId}:${hash}`,
      typeof data === 'string' ? data : JSON.stringify(data)
    );
    return createApp(requestTenant).request('/Users', bearer(token), env);
  }

  it('accepts a stored token bound to the tenant', async () => {
    expect((await authenticate({ tenantId: 'tenant-a' })).status).toBe(200);
  });

  it('rejects a token whose stored tenant differs from its key', async () => {
    const res = await authenticate({ tenantId: 'tenant-b' });
    expect(res.status).toBe(401);
    expect(logSink.warn).toHaveBeenCalledWith('SCIM token tenant mismatch', {
      tokenTenantId: 'tenant-b',
      requestTenantId: 'tenant-a',
    });
  });

  it('rejects a stored token without a tenant', async () => {
    expect((await authenticate({ enabled: true })).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expiresAt = new Date(NOW_MS - 1).toISOString();
    expect((await authenticate({ tenantId: 'tenant-a', expiresAt })).status).toBe(401);
  });

  it('accepts a token that expires exactly now', async () => {
    const expiresAt = new Date(NOW_MS).toISOString();
    expect((await authenticate({ tenantId: 'tenant-a', expiresAt })).status).toBe(200);
  });

  it('accepts a token that expires in the future', async () => {
    const expiresAt = new Date(NOW_MS + 1000).toISOString();
    expect((await authenticate({ tenantId: 'tenant-a', expiresAt })).status).toBe(200);
  });

  it('accepts a token with a null expiry', async () => {
    expect((await authenticate({ tenantId: 'tenant-a', expiresAt: null })).status).toBe(200);
  });

  it('rejects a disabled token', async () => {
    expect((await authenticate({ tenantId: 'tenant-a', enabled: false })).status).toBe(401);
  });

  it('accepts an explicitly enabled token', async () => {
    expect((await authenticate({ tenantId: 'tenant-a', enabled: true })).status).toBe(200);
  });

  it('rejects unparseable stored data and logs it', async () => {
    const res = await authenticate('{not json');
    expect(res.status).toBe(401);
    expect(logSink.error).toHaveBeenCalledWith(
      'Token validation error',
      {},
      expect.any(SyntaxError)
    );
  });

  it('rejects a token when the key-value store is missing', async () => {
    const env = { ENABLE_SCIM_AUTH_RATE_LIMIT: 'false', DEFAULT_TENANT_ID: 'default' } as Env;
    const res = await createApp('default').request('/Users', bearer('abc'), env);
    expect(res.status).toBe(401);
  });

  it('looks tokens up under a tenant-scoped SHA-256 key', async () => {
    const { env, kv } = createEnv();
    await createApp('default').request('/Users', bearer('abc'), env);
    expect(kv.get).toHaveBeenCalledWith(`scim:default:${await sha256Hex('abc')}`);
  });
});

describe('generateScimToken', () => {
  it('produces a 64 character hex token and its SHA-256 hash, with leading zeros kept', async () => {
    const { env } = createEnv();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        bytes.forEach((_, index) => (bytes[index] = index));
        return array;
      }
    );
    const result = await generateScimToken(env, { tenantId: 'default' });
    expect(result.token).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(result.tokenHash).toBe(await sha256Hex(result.token));
    expect(result.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('zero-pads every hash byte', async () => {
    const { env } = createEnv();
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      vi.spyOn(crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView | null>(array: T): T => {
          const bytes = array as unknown as Uint8Array;
          bytes.fill(seed);
          return array;
        }
      );
      const { token, tokenHash } = await generateScimToken(env, { tenantId: 'default' });
      expect(tokenHash).toBe(await sha256Hex(token));
      expect(tokenHash).toHaveLength(64);
      for (let index = 0; index < 64; index += 2) {
        seen.add(Number.parseInt(tokenHash.slice(index, index + 2), 16));
      }
    }
    expect([...seen].some((value) => value < 16)).toBe(true);
  });

  it('stores defaults for a token without options', async () => {
    vi.useFakeTimers({ now: NOW_MS });
    const { env, kv } = createEnv();
    const { tokenHash } = await generateScimToken(env, { tenantId: 'default' });
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = kv.put.mock.calls[0];
    expect(key).toBe(`scim:default:${tokenHash}`);
    expect(JSON.parse(value)).toEqual({
      description: 'SCIM provisioning token',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      enabled: true,
      type: 'scim',
      tenantId: 'default',
    });
    expect(options).toStrictEqual({ expirationTtl: undefined });
  });

  it('stores the description, enabled flag and expiry that were asked for', async () => {
    vi.useFakeTimers({ now: NOW_MS });
    const { env, kv } = createEnv();
    await generateScimToken(env, {
      tenantId: 'default',
      description: 'Okta',
      enabled: false,
      expiresInDays: 7,
    });
    const [, value, options] = kv.put.mock.calls[0];
    expect(JSON.parse(value)).toMatchObject({
      description: 'Okta',
      enabled: false,
      expiresAt: '2026-01-08T00:00:00.000Z',
    });
    expect(options).toStrictEqual({ expirationTtl: 7 * 24 * 60 * 60 });
  });

  it('treats an empty description as the default', async () => {
    const { env, kv } = createEnv();
    await generateScimToken(env, { tenantId: 'default', description: '' });
    expect((JSON.parse(kv.put.mock.calls[0][1]) as { description: string }).description).toBe(
      'SCIM provisioning token'
    );
  });

  it('trims the tenant id it stores the token under', async () => {
    const { env, store } = createEnv({ BASE_DOMAIN: 'example.com' });
    const { tokenHash } = await generateScimToken(env, { tenantId: ' tenant-a ' });
    expect([...store.keys()]).toEqual([`scim:tenant-a:${tokenHash}`]);
  });

  it('requires a tenant in multi-tenant mode', async () => {
    const { env } = createEnv({ BASE_DOMAIN: 'example.com' });
    await expect(generateScimToken(env)).rejects.toThrow(
      'SCIM token generation requires tenantId in multi-tenant mode'
    );
    await expect(generateScimToken(env, { tenantId: '  ' })).rejects.toThrow(
      'SCIM token generation requires tenantId in multi-tenant mode'
    );
  });

  it('uses the configured default tenant in single-tenant mode', async () => {
    const { env, store } = createEnv({ DEFAULT_TENANT_ID: 'solo' });
    const { tokenHash } = await generateScimToken(env);
    expect([...store.keys()]).toEqual([`scim:solo:${tokenHash}`]);
  });
});

describe('revokeScimToken and listScimTokens', () => {
  it('revokes a token and reports success', async () => {
    const { env, store } = createEnv({ BASE_DOMAIN: 'example.com' });
    const { tokenHash } = await generateScimToken(env, { tenantId: 'tenant-a' });
    expect(await revokeScimToken(env, tokenHash, { tenantId: ' tenant-a ' })).toBe(true);
    expect(store.size).toBe(0);
  });

  it('revokes under the default tenant in single-tenant mode', async () => {
    const { env, kv } = createEnv();
    expect(await revokeScimToken(env, 'abc')).toBe(true);
    expect(kv.delete).toHaveBeenCalledWith('scim:default:abc');
  });

  it('refuses to revoke without a tenant in multi-tenant mode', async () => {
    const { env, kv } = createEnv({ BASE_DOMAIN: 'example.com' });
    expect(await revokeScimToken(env, 'abc')).toBe(false);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('reports false and logs when the store fails', async () => {
    const { env, kv } = createEnv();
    const failure = new Error('kv down');
    kv.delete.mockRejectedValue(failure);
    const log = { error: vi.fn() };
    expect(await revokeScimToken(env, 'abc', {}, log as never)).toBe(false);
    expect(log.error).toHaveBeenCalledWith('Token revocation error', {}, failure);
  });

  it('uses the SCIM-AUTH logger when none is given', async () => {
    const { env, kv } = createEnv();
    const failure = new Error('kv down');
    kv.delete.mockRejectedValue(failure);
    expect(await revokeScimToken(env, 'abc')).toBe(false);
    expect(createLoggerModule).toHaveBeenCalledWith('SCIM-AUTH');
    expect(logSink.error).toHaveBeenCalledWith('Token revocation error', {}, failure);
  });

  it('lists the tenant tokens with their metadata', async () => {
    vi.useFakeTimers({ now: NOW_MS });
    const { env } = createEnv({ BASE_DOMAIN: 'example.com' });
    const a = await generateScimToken(env, {
      tenantId: 'tenant-a',
      description: 'Okta',
      expiresInDays: 1,
    });
    await generateScimToken(env, { tenantId: 'tenant-b' });
    expect(await listScimTokens(env, { tenantId: ' tenant-a ' })).toEqual([
      {
        tokenHash: a.tokenHash,
        description: 'Okta',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        enabled: true,
        tenantId: 'tenant-a',
      },
    ]);
  });

  it('lists nothing without a tenant in multi-tenant mode', async () => {
    const { env, kv } = createEnv({ BASE_DOMAIN: 'example.com' });
    expect(await listScimTokens(env)).toEqual([]);
    expect(kv.list).not.toHaveBeenCalled();
  });

  it('lists nothing when there is no key-value store', async () => {
    const env = { ENABLE_SCIM_AUTH_RATE_LIMIT: 'false' } as Env;
    expect(await listScimTokens(env)).toEqual([]);
    expect(logSink.error).not.toHaveBeenCalled();
  });

  it('skips keys whose value has gone and lists under the default tenant', async () => {
    const { env, kv, store } = createEnv();
    store.set('scim:default:gone', 'x');
    kv.get.mockResolvedValueOnce(null);
    expect(await listScimTokens(env)).toEqual([]);
    expect(kv.list).toHaveBeenCalledWith({ prefix: 'scim:default:' });
  });

  it('logs and returns what it has when listing fails', async () => {
    const { env, kv } = createEnv();
    const failure = new Error('list failed');
    kv.list.mockRejectedValue(failure);
    const log = { error: vi.fn() };
    expect(await listScimTokens(env, {}, log as never)).toEqual([]);
    expect(log.error).toHaveBeenCalledWith('List tokens error', {}, failure);
  });

  it('uses the SCIM-AUTH logger when none is given', async () => {
    const { env, kv } = createEnv();
    kv.list.mockRejectedValue(new Error('list failed'));
    await listScimTokens(env);
    expect(createLoggerModule).toHaveBeenCalledWith('SCIM-AUTH');
  });
});

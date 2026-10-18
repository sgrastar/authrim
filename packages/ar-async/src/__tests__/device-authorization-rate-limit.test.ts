/**
 * POST /device_authorization: the rate limits. A per-IP budget (the `moderate` profile) is spent
 * before the body is read; a per-client budget (the `lenient` profile) is spent once the client
 * has authenticated. Both are counted by the real RateLimiterCounter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRateLimitConfigCache, getRateLimitProfileAsync } from '@authrim/ar-lib-core';
import {
  SECRET,
  deviceClients,
  harness,
  registerClient,
  registerSecretClient,
  silentLogger,
} from './device-authorization-harness';

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  const shared = globalThis as unknown as {
    __deviceClients: Map<string, Record<string, unknown>>;
    __deviceLogger: unknown;
  };
  return {
    ...actual,
    getClientCached: async (_c: unknown, _env: unknown, id: string) =>
      shared.__deviceClients.get(id) ?? null,
    getLogger: () => shared.__deviceLogger,
  };
});

beforeEach(async () => {
  deviceClients.clear();
  clearRateLimitConfigCache();
  silentLogger.error.mockClear();
  await registerClient('tv', { token_endpoint_auth_method: 'none' });
  await registerClient('tv-2', { token_endpoint_auth_method: 'none' });
});

/** Saves platform rate limits in the Settings KV and reads them once, as a request would. */
async function configure(limits: Record<string, number>) {
  const settings = {
    get: vi.fn(async (key: string) =>
      key === 'settings:platform:rate-limit' ? JSON.stringify(limits) : null
    ),
  };
  const h = harness({ SETTINGS: settings });
  const refreshes: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => refreshes.push(promise) };
  for (const profile of ['moderate', 'lenient'] as const) {
    await getRateLimitProfileAsync(h.env as never, profile, ctx as never);
  }
  await Promise.all(refreshes);
  return h;
}

const nextRetryAfter = (response: Response) => Number(response.headers.get('Retry-After'));

describe('the per-IP budget', () => {
  it('lets 60 requests per minute through by default, then answers 429', async () => {
    const h = harness();
    for (let i = 0; i < 60; i++) {
      expect((await h.post({ client_id: 'tv' })).response.status).toBe(200);
    }
    const { response, body } = await h.post({ client_id: 'tv' });

    expect(response.status).toBe(429);
    expect(body).toEqual({ error: 'rate_limit_exceeded', error_description: expect.any(String) });
    expect(nextRetryAfter(response)).toBeGreaterThan(0);
    expect(nextRetryAfter(response)).toBeLessThanOrEqual(60);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(h.stored).toHaveLength(60);
  });

  it('puts the budget left on a request that passes', async () => {
    const { response } = await harness().post({ client_id: 'tv' });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('59');
  });

  it('follows the saved platform limit (rate_limit.moderate)', async () => {
    const h = await configure({ 'rate_limit.moderate': 2 });
    expect((await h.post({ client_id: 'tv' })).response.status).toBe(200);
    expect((await h.post({ client_id: 'tv' })).response.status).toBe(200);
    const { response } = await h.post({ client_id: 'tv' });
    expect(response.status).toBe(429);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('2');
  });

  it('is counted per address: another address has its own budget', async () => {
    const h = await configure({ 'rate_limit.moderate': 1 });
    expect((await h.post({ client_id: 'tv' }, { ip: '198.51.100.1' })).response.status).toBe(200);
    expect((await h.post({ client_id: 'tv' }, { ip: '198.51.100.1' })).response.status).toBe(429);
    expect((await h.post({ client_id: 'tv' }, { ip: '198.51.100.2' })).response.status).toBe(200);
  });

  it('is shared by all clients behind one address', async () => {
    const h = await configure({ 'rate_limit.moderate': 2 });
    expect((await h.post({ client_id: 'tv' })).response.status).toBe(200);
    expect((await h.post({ client_id: 'tv-2' })).response.status).toBe(200);
    expect((await h.post({ client_id: 'tv' })).response.status).toBe(429);
    expect((await h.post({ client_id: 'tv-2' })).response.status).toBe(429);
  });

  it('is spent before the body is read, and by requests that fail', async () => {
    const h = await configure({ 'rate_limit.moderate': 2 });
    // two requests with no client_id and one with an unknown client use up the address
    expect((await h.post({})).response.status).toBe(400);
    expect((await h.post({ client_id: 'nobody' })).response.status).toBe(401);
    const over = await h.post('not a form', { headers: { 'Content-Type': 'application/json' } });
    expect(over.response.status).toBe(429);
    expect(h.stored).toHaveLength(0);
  });

  it('is a separate budget from the tenant-wide counters of other endpoints', async () => {
    const h = harness();
    await h.post({ client_id: 'tv' });
    expect(h.limiter.names.every((name) => name.includes('device_authorization'))).toBe(true);
    expect(h.limiter.names[0]).toBe(
      'tenant:default:rate-limit:device_authorization:ip:203.0.113.9'
    );
  });
});

describe('the per-client budget', () => {
  it('lets 300 requests per minute of one client through by default, then answers 429', async () => {
    const h = harness();
    // a different address for each request, so only the client budget counts
    for (let i = 0; i < 300; i++) {
      const ip = `10.${Math.floor(i / 200)}.${i % 200}.1`;
      expect((await h.post({ client_id: 'tv' }, { ip })).response.status).toBe(200);
    }
    const { response, body } = await h.post({ client_id: 'tv' }, { ip: '192.0.2.77' });

    expect(response.status).toBe(429);
    expect(body.error).toBe('rate_limit_exceeded');
    expect(nextRetryAfter(response)).toBeGreaterThan(0);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(h.stored).toHaveLength(300);
  });

  it('follows the saved platform limit (rate_limit.lenient) and counts each client on its own', async () => {
    const h = await configure({ 'rate_limit.lenient': 2 });
    const from = (n: number) => ({ ip: `198.51.100.${n}` });
    expect((await h.post({ client_id: 'tv' }, from(1))).response.status).toBe(200);
    expect((await h.post({ client_id: 'tv' }, from(2))).response.status).toBe(200);
    // another address does not help the client
    expect((await h.post({ client_id: 'tv' }, from(3))).response.status).toBe(429);
    // another client is not affected
    expect((await h.post({ client_id: 'tv-2' }, from(3))).response.status).toBe(200);
  });

  it('is not spent by requests that do not authenticate', async () => {
    await registerSecretClient('app');
    const h = await configure({ 'rate_limit.lenient': 1 });
    for (let i = 0; i < 5; i++) {
      const result = await h.post(
        { client_id: 'app', client_secret: 'wrong' },
        { ip: `198.51.100.${i + 1}` }
      );
      expect(result.response.status).toBe(401);
    }
    // the client's one request is still there
    const ok = await h.post({ client_id: 'app', client_secret: SECRET }, { ip: '198.51.100.50' });
    expect(ok.response.status).toBe(200);
    const over = await h.post({ client_id: 'app', client_secret: SECRET }, { ip: '198.51.100.51' });
    expect(over.response.status).toBe(429);
  });

  it('is spent by an authenticated client whose request is then refused for its scope', async () => {
    const h = await configure({ 'rate_limit.lenient': 1 });
    const refused = await h.post({ client_id: 'tv', scope: 'admin' }, { ip: '198.51.100.1' });
    expect(refused.response.status).toBe(400);
    // a client cannot try scopes for free: its budget is gone
    const over = await h.post({ client_id: 'tv' }, { ip: '198.51.100.2' });
    expect(over.response.status).toBe(429);
  });

  it('keys the budget by tenant and client', async () => {
    const h = harness();
    await h.post({ client_id: 'tv' });
    expect(h.limiter.names).toContain(
      'tenant:default:rate-limit:device_authorization_client:client:tv'
    );
  });
});

describe('when the limiter cannot answer', () => {
  it('refuses with 503 and retry advice, and issues nothing, when the counter is not bound', async () => {
    const h = harness({ RATE_LIMITER: undefined });
    const { response, body } = await h.post({ client_id: 'tv' });

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'temporarily_unavailable',
      error_description: expect.any(String),
    });
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(h.stored).toHaveLength(0);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('refuses with 503 when the counter fails', async () => {
    const h = harness({
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: () => ({
          incrementRpc: async () => {
            throw new Error('Durable Object overloaded');
          },
        }),
      },
    });
    const { response, body } = await h.post({ client_id: 'tv' });
    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain('overloaded');
    expect(h.stored).toHaveLength(0);
  });

  it('refuses with 503 when only the per-client counter fails', async () => {
    const real = harness().limiter.namespace;
    const h = harness({
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: (id: string) => {
          if (id.includes('device_authorization_client')) {
            return {
              incrementRpc: async () => {
                throw new Error('down');
              },
            };
          }
          return real.get(id);
        },
      },
    });
    const { response } = await h.post({ client_id: 'tv' });
    expect(response.status).toBe(503);
    expect(h.stored).toHaveLength(0);
  });
});

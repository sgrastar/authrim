import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { RateLimiterCounter } from '../RateLimiterCounter';
import { UserCodeRateLimiter } from '../UserCodeRateLimiter';
import type { Env } from '../../types/env';

class MemoryDurableStorage {
  readonly values = new Map<string, unknown>();
  readonly alarms: number[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarms.push(timestamp);
  }
}

function createState(storage = new MemoryDurableStorage()): DurableObjectState {
  return {
    id: { toString: () => 'rate-limiter', equals: () => false },
    storage,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    waitUntil: () => undefined,
  } as unknown as DurableObjectState;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('RateLimiterCounter security behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('atomically denies requests above the configured limit and preserves the decision after restart', async () => {
    const storage = new MemoryDurableStorage();
    const limiter = new RateLimiterCounter(createState(storage), {} as Env);

    await expect(
      limiter.incrementRpc('203.0.113.10', { windowSeconds: 60, maxRequests: 2 })
    ).resolves.toMatchObject({ allowed: true, current: 1, retryAfter: 0 });
    await expect(
      limiter.incrementRpc('203.0.113.10', { windowSeconds: 60, maxRequests: 2 })
    ).resolves.toMatchObject({ allowed: true, current: 2 });
    await expect(
      limiter.incrementRpc('203.0.113.10', { windowSeconds: 60, maxRequests: 2 })
    ).resolves.toMatchObject({ allowed: false, current: 3, retryAfter: 60 });

    const restarted = new RateLimiterCounter(createState(storage), {} as Env);
    await expect(
      restarted.incrementRpc('203.0.113.10', { windowSeconds: 60, maxRequests: 2 })
    ).resolves.toMatchObject({ allowed: false, current: 4, retryAfter: 60 });
  });

  it('starts a fresh window after expiry without affecting another client', async () => {
    const limiter = new RateLimiterCounter(createState(), {} as Env);
    await limiter.incrementRpc('client-a', { windowSeconds: 10, maxRequests: 1 });
    await limiter.incrementRpc('client-b', { windowSeconds: 30, maxRequests: 1 });

    vi.advanceTimersByTime(11_000);

    await expect(limiter.getStatusRpc('client-a')).resolves.toBeNull();
    await expect(
      limiter.incrementRpc('client-a', { windowSeconds: 10, maxRequests: 1 })
    ).resolves.toMatchObject({ allowed: true, current: 1 });
    await expect(limiter.getStatusRpc('client-b')).resolves.toMatchObject({ count: 1 });
  });

  it('returns rate-limit headers and exposes no internal details for malformed JSON', async () => {
    const limiter = new RateLimiterCounter(createState(), {} as Env);
    await limiter.fetch(
      post('/increment', {
        clientIP: 'client-a',
        config: { windowSeconds: 60, maxRequests: 1 },
      })
    );
    const denied = await limiter.fetch(
      post('/increment', {
        clientIP: 'client-a',
        config: { windowSeconds: 60, maxRequests: 1 },
      })
    );

    expect(denied.status).toBe(429);
    expect(denied.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(denied.headers.get('retry-after')).toBe('60');

    const malformed = await limiter.fetch(
      new Request('https://internal/increment', { method: 'POST', body: '{' })
    );
    expect(malformed.status).toBe(500);
    await expect(malformed.json()).resolves.toEqual({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });
});

describe('UserCodeRateLimiter brute-force persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks the fifth failure and keeps the block across Durable Object restarts', async () => {
    const storage = new MemoryDurableStorage();
    const limiter = new UserCodeRateLimiter(createState(storage), {} as Env);

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await limiter.fetch(post('/record-failure', { ip: '198.51.100.4' }))).status).toBe(
        200
      );
    }

    const blocked = await limiter.fetch(post('/check', { ip: '198.51.100.4' }));
    await expect(blocked.json()).resolves.toEqual({ blocked: true, retry_after: 3600 });

    const restarted = new UserCodeRateLimiter(createState(storage), {} as Env);
    const stillBlocked = await restarted.fetch(post('/check', { ip: '198.51.100.4' }));
    await expect(stillBlocked.json()).resolves.toEqual({ blocked: true, retry_after: 3600 });
  });

  it('resets only the successful client and persists the reset', async () => {
    const storage = new MemoryDurableStorage();
    const limiter = new UserCodeRateLimiter(createState(storage), {} as Env);
    for (const ip of ['client-a', 'client-b']) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await limiter.fetch(post('/record-failure', { ip }));
      }
    }

    await limiter.fetch(post('/reset', { ip: 'client-a' }));
    const restarted = new UserCodeRateLimiter(createState(storage), {} as Env);

    await expect(
      (await restarted.fetch(post('/check', { ip: 'client-a' }))).json()
    ).resolves.toEqual({ blocked: false });
    await expect(
      (await restarted.fetch(post('/check', { ip: 'client-b' }))).json()
    ).resolves.toMatchObject({ blocked: true });
  });

  it('removes expired attempts on alarm and does not disclose JSON parser errors', async () => {
    const storage = new MemoryDurableStorage();
    const limiter = new UserCodeRateLimiter(createState(storage), {} as Env);
    await limiter.fetch(post('/record-failure', { ip: 'client-a' }));
    vi.advanceTimersByTime(61 * 60 * 1000);
    await limiter.alarm();

    const restarted = new UserCodeRateLimiter(createState(storage), {} as Env);
    await expect(
      (await restarted.fetch(post('/check', { ip: 'client-a' }))).json()
    ).resolves.toEqual({ blocked: false });

    const malformed = await restarted.fetch(
      new Request('https://internal/check', { method: 'POST', body: '{' })
    );
    expect(malformed.status).toBe(500);
    await expect(malformed.json()).resolves.toEqual({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });
});

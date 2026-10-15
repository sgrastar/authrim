/**
 * The per-IP user code limit under parallel requests, with the REAL UserCodeRateLimiter and a
 * store lookup the test can hold pending. The limiter reserves a guess BEFORE the lookup, so a
 * burst cannot all pass a check before the first failure is recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DeviceCodeMetadata, Env } from '@authrim/ar-lib-core';
import { realUserCodeLimiter, type RealUserCodeLimiter } from './real-user-code-limiter';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  getClient: vi.fn(),
  storeFetch: vi.fn(),
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    module: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    isMockAuthEnabled: vi.fn().mockResolvedValue(false),
    getLogger: () => mocks.logger,
    getClient: mocks.getClient,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
  };
});

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { deviceLookupApiHandler } from '../device-lookup-api';

const IP = '203.0.113.9';
const TTL_MS = 30_000;

const pending: DeviceCodeMetadata = {
  tenant_id: 'tenant-a',
  device_code: 'device-1',
  user_code: 'WDJB-MJHT',
  client_id: 'client-1',
  scope: 'openid',
  status: 'pending',
  created_at: 1,
  expires_at: Date.now() + 3_600_000,
  poll_count: 0,
};

let limiter: RealUserCodeLimiter;
/** The lookups that reached the store, each held until the test answers it. */
let held: Array<{ userCode: string; answer: (metadata: DeviceCodeMetadata | null) => void }>;

function envWith(namespace: RealUserCodeLimiter['namespace']): Env {
  return {
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-store'),
      get: vi.fn().mockReturnValue({ fetch: mocks.storeFetch }),
    },
    USER_CODE_RATE_LIMITER: namespace,
  } as unknown as Env;
}

function lookup(userCode: string, ip = IP): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/lookup', deviceLookupApiHandler);
  return Promise.resolve(
    app.request(
      'http://localhost/lookup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ user_code: userCode }),
      },
      envWith(limiter.namespace)
    )
  );
}

/** Let every request that can run reach the point where it waits on the held store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function failures(count: number, ip = IP) {
  for (let guess = 0; guess < count; guess++) {
    const request = lookup(`MISS${guess}`, ip);
    await settle();
    held.at(-1)!.answer(null);
    expect((await request).status).toBe(404);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  limiter = realUserCodeLimiter();
  held = [];
  mocks.authenticatedUser.mockResolvedValue({ userId: 'user-1', sub: 'subject-1', email: 'u@x.y' });
  mocks.getClient.mockResolvedValue({ client_id: 'client-1', client_name: 'Acme TV' });
  mocks.storeFetch.mockImplementation(
    (request: Request) =>
      new Promise<Response>((resolve) => {
        void request
          .clone()
          .json()
          .then((parsed: unknown) => {
            const body = parsed as { user_code: string };
            held.push({
              userCode: body.user_code,
              answer: (metadata) => resolve(Response.json(metadata)),
            });
          });
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parallel guesses from one IP', () => {
  it('(a) with 4 failures, two parallel requests let only one reach the store', async () => {
    await failures(4);
    held = [];

    const first = lookup('AAAA-AAAA');
    const second = lookup('BBBB-BBBB');
    await settle();

    // one holds the last slot; the other is refused before any code is read
    expect(held).toHaveLength(1);
    const refused = await Promise.race([first, second]);
    expect(refused.status).toBe(429);

    held[0].answer(null);
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([404, 429]);
    expect(limiter.failuresOf(IP)).toBe(5);
    // and now the IP is blocked outright
    expect((await lookup('CCCC-CCCC')).status).toBe(429);
    expect(held).toHaveLength(1);
  });

  it('(b) a burst of 20 from a clean IP lets exactly 5 reach the store', async () => {
    const burst = Array.from({ length: 20 }, (_, index) => lookup(`BURST${index}`));
    await settle();

    expect(held).toHaveLength(5);
    for (const request of held) request.answer(null);
    const statuses = (await Promise.all(burst)).map((response) => response.status);

    expect(statuses.filter((status) => status === 404)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    expect(limiter.failuresOf(IP)).toBe(5);
  });

  it('keeps the budget per IP', async () => {
    const burst = Array.from({ length: 8 }, (_, index) => lookup(`BURST${index}`, IP));
    const other = lookup('OTHER-CODE', '198.51.100.4');
    await settle();

    expect(held).toHaveLength(6); // 5 of the burst and the other address's one
    for (const request of held) request.answer(null);
    const statuses = (await Promise.all([...burst, other])).map((r) => r.status);
    expect(statuses.filter((s) => s === 404)).toHaveLength(6);
  });

  it('(c) a request that finds a pending code gives its slot back and does not count', async () => {
    await failures(4);
    held = [];

    const found = lookup('WDJB-MJHT');
    await settle();
    expect(held).toHaveLength(1);
    // the slot is taken while the store is read
    const blockedWhileHeld = await lookup('AAAA-AAAA');
    expect(blockedWhileHeld.status).toBe(429);

    held[0].answer(pending);
    expect((await found).status).toBe(200);
    expect(limiter.failuresOf(IP)).toBe(4);

    // the slot is free again and can be used for a guess
    const next = lookup('BBBB-BBBB');
    await settle();
    expect(held).toHaveLength(2);
    held[1].answer(null);
    expect((await next).status).toBe(404);
    expect(limiter.failuresOf(IP)).toBe(5);
  });

  it('gives the slot back for malformed input and for a store that cannot answer', async () => {
    await failures(4);
    held = [];

    // malformed: refused before the store, slot released
    expect((await lookup('abc')).status).toBe(400);
    // the store errors: 503, slot released, nothing counted
    mocks.storeFetch.mockImplementationOnce(async () => new Response('boom', { status: 500 }));
    expect((await lookup('AAAA-AAAA')).status).toBe(503);
    expect(limiter.failuresOf(IP)).toBe(4);

    const last = lookup('BBBB-BBBB');
    await settle();
    expect(held).toHaveLength(1);
    held[0].answer(null);
    expect((await last).status).toBe(404);
  });

  it('(d) a reservation nobody settles expires after 30 seconds and frees its slot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    await failures(4);
    held = [];

    // a request whose worker never settles: the lookup is held and never answered
    void lookup('LOST-CODE');
    await settle();
    expect(held).toHaveLength(1);
    expect((await lookup('AAAA-AAAA')).status).toBe(429);

    vi.setSystemTime(Date.now() + TTL_MS - 1);
    expect((await lookup('AAAA-AAAA')).status).toBe(429);
    vi.setSystemTime(Date.now() + 2);

    const after = lookup('BBBB-BBBB');
    await settle();
    expect(held).toHaveLength(2);
    held[1].answer(null);
    expect((await after).status).toBe(404);
    // the lapsed reservation never became a failure
    expect(limiter.failuresOf(IP)).toBe(5);
  });

  describe('a request that stalls longer than its reservation lasts', () => {
    const stalled = async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
      await failures(4);
      held = [];
      const slow = lookup('SLOW-CODE');
      await settle();
      expect(held).toHaveLength(1);
      vi.setSystemTime(Date.now() + TTL_MS + 1);
      return { slow };
    };

    it('gets no answer about the code it looked up: not found-pending, not absent', async () => {
      const { slow } = await stalled();

      held[0].answer(pending);
      const response = await slow;

      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toContain('temporarily_unavailable');
      expect(text).not.toContain('Acme TV');
      expect(text).not.toContain('client_id');
      expect(text).not.toContain('invalid_code');
    });

    it('4 failures + stalled A + B takes the 5th failure: A is refused, not told "no such code"', async () => {
      const { slow } = await stalled();

      // B uses the slot A's lapse freed and takes the 5th failure
      const fast = lookup('BBBB-BBBB');
      await settle();
      expect(held).toHaveLength(2);
      held[1].answer(null);
      expect((await fast).status).toBe(404);
      expect(limiter.failuresOf(IP)).toBe(5);

      // A's lookup ends now: it finds nothing, but must not say so
      held[0].answer(null);
      const response = await slow;
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('invalid_code');
      // a lapse is not a free guess: the miss still counts
      expect(limiter.failuresOf(IP)).toBe(6);
    });

    it.each([false, true])(
      'leaves the budget in the same state whether the stalled lookup found a code or nothing (B takes the 5th failure first: %s)',
      async (bTakesFifth) => {
        async function scenario(answer: DeviceCodeMetadata | null) {
          limiter = realUserCodeLimiter();
          held = [];
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
          await failures(4);
          held = [];
          const slow = lookup('SLOW-CODE');
          await settle();
          vi.setSystemTime(Date.now() + TTL_MS + 1);
          if (bTakesFifth) {
            const fast = lookup('BBBB-BBBB');
            await settle();
            held[1].answer(null);
            await fast;
          }
          held[0].answer(answer);
          const slowResponse = await slow;

          // what the next request sees, and what the limiter itself says
          const heldBefore = held.length;
          const next = lookup('NEXT-CODE');
          await settle();
          if (held.length > heldBefore) held.at(-1)!.answer(null);
          const nextResponse = await next;
          const reserve = await limiter.namespace.get('x').fetch(
            new Request('https://internal/reserve', {
              method: 'POST',
              body: JSON.stringify({ ip: IP }),
            })
          );
          return {
            slow: [slowResponse.status, await slowResponse.text()],
            failures: limiter.failuresOf(IP),
            next: [nextResponse.status, await nextResponse.text()],
            reserve: await reserve.json(),
          };
        }

        const found = await scenario(pending);
        const absent = await scenario(null);

        expect(found).toEqual(absent);
        // and the lapse itself cost exactly one failure
        expect(found.failures).toBe(bTakesFifth ? 6 : 5);
        expect(found.slow[0]).toBe(503);
      }
    );

    it('a lookup that ends within the TTL is answered as before', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
      const quick = lookup('WDJB-MJHT');
      await settle();
      vi.setSystemTime(Date.now() + TTL_MS - 1000);
      held[0].answer(pending);
      expect((await quick).status).toBe(200);
    });
  });

  it('reserves a guess only after the request body is read', async () => {
    let send!: (chunk: string) => void;
    let end!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
        end = () => controller.close();
      },
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'tenant-a');
      await next();
    });
    app.post('/lookup', deviceLookupApiHandler);
    const request = Promise.resolve(
      app.request(
        new Request('http://localhost/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
          body,
          duplex: 'half',
        } as RequestInit),
        undefined,
        envWith(limiter.namespace)
      )
    );
    await settle();
    // the body has not arrived: nothing is reserved, nothing is looked up
    expect(limiter.calls).toEqual([]);
    expect(held).toHaveLength(0);

    send('{"user_code":"MISS-CODE"}');
    end();
    await settle();
    expect(limiter.calls).toEqual(['/reserve']);
    held[0].answer(null);
    expect((await request).status).toBe(404);
  });

  it('(e) codes that do not exist, one after the other, count and block after 5', async () => {
    await failures(5);
    expect(limiter.failuresOf(IP)).toBe(5);
    const blocked = await lookup('AAAA-AAAA');
    expect(blocked.status).toBe(429);
    expect(held).toHaveLength(5);
  });
});

describe('the Durable Object protocol', () => {
  const call = (path: string, body: Record<string, unknown>) =>
    limiter.namespace
      .get('x')
      .fetch(
        new Request(`https://internal${path}`, { method: 'POST', body: JSON.stringify(body) })
      );
  const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

  it('speaks only reserve, record-failure with a reservation id, and release', async () => {
    expect((await call('/check', { ip: IP })).status).toBe(404);
    // a failure with no reservation id is refused and counts nothing
    expect((await call('/record-failure', { ip: IP })).status).toBe(400);
    expect(limiter.failuresOf(IP)).toBe(0);
  });

  it('a failure recorded without a reservation (a restarted limiter) still counts once', async () => {
    // the reservation id of a guess made before a restart is unknown to the new object
    for (let guess = 0; guess < 5; guess++) {
      await call('/record-failure', { ip: IP, reservation_id: `before-restart-${guess}` });
    }
    expect(limiter.failuresOf(IP)).toBe(5);
    expect(await json(await call('/reserve', { ip: IP }))).toMatchObject({ blocked: true });
  });

  it('a failure with a reservation id replaces the reservation, once', async () => {
    const reserved = await json(await call('/reserve', { ip: IP }));
    expect(reserved).toMatchObject({ blocked: false, reservation_id: expect.any(String) });
    await call('/record-failure', { ip: IP, reservation_id: reserved.reservation_id });
    expect(limiter.failuresOf(IP)).toBe(1);

    // four more reservations fill the budget (1 failure + 4 in flight), the fifth is refused
    for (let slot = 0; slot < 4; slot++) {
      expect(await json(await call('/reserve', { ip: IP }))).toMatchObject({ blocked: false });
    }
    expect(await json(await call('/reserve', { ip: IP }))).toMatchObject({ blocked: true });
  });

  it('release frees the slot and counts nothing; releasing twice is harmless', async () => {
    const ids: string[] = [];
    for (let slot = 0; slot < 5; slot++) {
      ids.push((await json(await call('/reserve', { ip: IP }))).reservation_id as string);
    }
    expect(await json(await call('/reserve', { ip: IP }))).toMatchObject({ blocked: true });

    await call('/release', { ip: IP, reservation_id: ids[0] });
    await call('/release', { ip: IP, reservation_id: ids[0] });
    expect(limiter.failuresOf(IP)).toBe(0);
    expect(await json(await call('/reserve', { ip: IP }))).toMatchObject({ blocked: false });
    expect(await json(await call('/reserve', { ip: IP }))).toMatchObject({ blocked: true });
  });

  it('a refused reservation says how long to wait: the block, or the earliest reservation', async () => {
    for (let slot = 0; slot < 5; slot++) await call('/reserve', { ip: IP });
    const inFlight = await json(await call('/reserve', { ip: IP }));
    expect(inFlight.retry_after).toBeGreaterThanOrEqual(1);
    expect(inFlight.retry_after).toBeLessThanOrEqual(30);

    const other = '198.51.100.7';
    for (let guess = 0; guess < 5; guess++) {
      await call('/record-failure', { ip: other, reservation_id: `lost-${guess}` });
    }
    const blocked = await json(await call('/reserve', { ip: other }));
    expect(blocked.retry_after).toBeGreaterThan(30);
  });

  describe('a reservation id settles once', () => {
    const reserve = async (ip = IP) =>
      (await json(await call('/reserve', { ip }))).reservation_id as string;

    it('recording the same id twice counts one failure', async () => {
      const id = await reserve();
      const first = await json(await call('/record-failure', { ip: IP, reservation_id: id }));
      const second = await json(await call('/record-failure', { ip: IP, reservation_id: id }));

      expect(limiter.failuresOf(IP)).toBe(1);
      expect(first).toMatchObject({ settled: true, expired: false, outcome: 'failure' });
      expect(second).toEqual(first);
    });

    it('release then record counts nothing, and record then release does not refund', async () => {
      const released = await reserve();
      await call('/release', { ip: IP, reservation_id: released });
      const late = await json(await call('/record-failure', { ip: IP, reservation_id: released }));
      expect(limiter.failuresOf(IP)).toBe(0);
      expect(late).toMatchObject({ outcome: 'released' });

      const recorded = await reserve();
      await call('/record-failure', { ip: IP, reservation_id: recorded });
      await call('/release', { ip: IP, reservation_id: recorded });
      expect(limiter.failuresOf(IP)).toBe(1);
    });

    it('an unknown id (lapsed, or lost in a restart) counts once, and says it had expired', async () => {
      const first = await json(
        await call('/record-failure', { ip: IP, reservation_id: 'never-issued' })
      );
      const second = await json(
        await call('/record-failure', { ip: IP, reservation_id: 'never-issued' })
      );

      expect(first).toMatchObject({ settled: true, expired: true });
      expect(second).toEqual(first);
      expect(limiter.failuresOf(IP)).toBe(1);
    });

    it('a lapsed reservation reports expired and still counts', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
      const id = await reserve();
      vi.setSystemTime(Date.now() + TTL_MS + 1);

      const answer = await json(await call('/record-failure', { ip: IP, reservation_id: id }));

      expect(answer).toMatchObject({ expired: true });
      expect(limiter.failuresOf(IP)).toBe(1);
    });

    it('an id presented by another IP is ignored and does not consume the reservation', async () => {
      const id = await reserve();

      const wrong = await json(
        await call('/record-failure', { ip: '198.51.100.9', reservation_id: id })
      );
      const wrongRelease = await json(
        await call('/release', { ip: '198.51.100.9', reservation_id: id })
      );

      expect(wrong).toMatchObject({ ignored: true });
      expect(wrongRelease).toMatchObject({ ignored: true });
      expect(limiter.failuresOf('198.51.100.9')).toBe(0);
      expect(limiter.failuresOf(IP)).toBe(0);
      // still held by its owner, who can settle it
      const owner = await json(await call('/record-failure', { ip: IP, reservation_id: id }));
      expect(owner).toMatchObject({ settled: true, expired: false });
      expect(limiter.failuresOf(IP)).toBe(1);
    });

    it('a lapsed or unknown reservation counts one failure however it is settled, and once', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
      const lapsed = await reserve();
      vi.setSystemTime(Date.now() + TTL_MS + 1);

      // released: the lookup found a code, but the budget shows the same as for a miss
      const released = await json(await call('/release', { ip: IP, reservation_id: lapsed }));
      expect(released).toMatchObject({ settled: true, expired: true, outcome: 'released' });
      expect(limiter.failuresOf(IP)).toBe(1);

      // settled again, in either way: still one failure
      await call('/release', { ip: IP, reservation_id: lapsed });
      await call('/record-failure', { ip: IP, reservation_id: lapsed });
      expect(limiter.failuresOf(IP)).toBe(1);

      // an unknown id (lost in a restart) released counts one as well, once
      await call('/release', { ip: IP, reservation_id: 'unknown' });
      await call('/release', { ip: IP, reservation_id: 'unknown' });
      expect(limiter.failuresOf(IP)).toBe(2);
    });

    it('a live reservation released still counts nothing', async () => {
      const id = await reserve();
      await call('/release', { ip: IP, reservation_id: id });
      expect(limiter.failuresOf(IP)).toBe(0);
    });

    it('forgets settled ids after 10 minutes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
      const id = await reserve();
      await call('/record-failure', { ip: IP, reservation_id: id });
      vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);

      await call('/record-failure', { ip: IP, reservation_id: id });

      // an id this old is just an unknown id again, and unknown ids count
      expect(limiter.failuresOf(IP)).toBe(2);
    });
  });
});

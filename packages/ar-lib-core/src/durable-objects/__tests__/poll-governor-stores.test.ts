/**
 * The poll governor in the REAL DeviceCodeStore and CIBARequestStore (RFC 8628 section 3.5, CIBA
 * Core section 11): a poll is evaluated against the previous one and recorded in one state
 * change, `slow_down` raises the stored interval, and the poll count is capped.
 *
 * Time is faked; the stores run over an in-memory storage as in device-ciba-stores.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CIBARequestMetadata, DeviceCodeMetadata } from '../../types/oidc';
import {
  CIBA_POLL_LIMITS,
  DEVICE_POLL_LIMITS,
  maxPollCountFor,
  type PollRpcResult,
} from '../../utils/poll-governor';
import { CIBARequestStore } from '../CIBARequestStore';
import { DeviceCodeStore } from '../DeviceCodeStore';
import { MemoryStorage, durableState, storeRequest } from './store-test-support';

vi.mock('../../utils/audit-log', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));

const runtimeEnv = {} as never;
const OWNER = 'client-1';
const OTHER = 'client-2';

type AnyRecord = Record<string, unknown>;
type Store = { fetch(request: Request): Promise<Response> };

interface Driver {
  name: string;
  recordKey: string;
  limits: typeof DEVICE_POLL_LIMITS;
  create(): Promise<{ store: Store; storage: MemoryStorage }>;
  seed(store: Store, overrides?: AnyRecord): Promise<void>;
  poll(store: Store, clientId?: string): Promise<PollRpcResult<AnyRecord>>;
  approve(store: Store): Promise<void>;
  deny(store: Store): Promise<void>;
  remove(store: Store): Promise<void>;
}

function deviceRecord(overrides: AnyRecord = {}): DeviceCodeMetadata {
  const now = Date.now();
  return {
    tenant_id: 'tenant-a',
    device_code: 'device-1',
    user_code: 'ABCD-EFGH',
    client_id: OWNER,
    scope: 'openid',
    status: 'pending',
    created_at: now,
    expires_at: now + 600_000,
    poll_count: 0,
    interval: 5,
    ...overrides,
  } as DeviceCodeMetadata;
}

function cibaRecord(overrides: AnyRecord = {}): CIBARequestMetadata {
  const now = Date.now();
  return {
    tenant_id: 'tenant-a',
    auth_req_id: 'request-1',
    user_code: 'CIBA-123',
    client_id: OWNER,
    scope: 'openid',
    login_hint: 'user@example.com',
    status: 'pending',
    delivery_mode: 'poll',
    created_at: now,
    expires_at: now + 600_000,
    interval: 5,
    poll_count: 0,
    ...overrides,
  } as CIBARequestMetadata;
}

async function rpc(store: Store, path: string, body: unknown): Promise<Response> {
  return store.fetch(storeRequest(path, body));
}

const deviceDriver: Driver = {
  name: 'device flow',
  recordKey: 'd:device-1',
  limits: DEVICE_POLL_LIMITS,
  async create() {
    const harness = durableState();
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
    await harness.initialized();
    return { store, storage: harness.storage };
  },
  async seed(store, overrides) {
    expect((await rpc(store, '/store', deviceRecord(overrides))).status).toBe(200);
  },
  async poll(store, clientId = OWNER) {
    const response = await rpc(store, '/poll', { device_code: 'device-1', client_id: clientId });
    expect(response.status).toBe(200);
    return (await response.json()) as PollRpcResult<AnyRecord>;
  },
  async approve(store) {
    await rpc(store, '/approve', { user_code: 'ABCD-EFGH', user_id: 'u1', sub: 'u1' });
  },
  async deny(store) {
    await rpc(store, '/deny', { user_code: 'ABCD-EFGH' });
  },
  async remove(store) {
    await rpc(store, '/delete', { device_code: 'device-1' });
  },
};

const cibaDriver: Driver = {
  name: 'CIBA poll mode',
  recordKey: 'r:request-1',
  limits: CIBA_POLL_LIMITS,
  async create() {
    const harness = durableState();
    const store = new CIBARequestStore(harness.state, runtimeEnv);
    await harness.initialized();
    return { store, storage: harness.storage };
  },
  async seed(store, overrides) {
    expect((await rpc(store, '/store', cibaRecord(overrides))).status).toBe(200);
  },
  async poll(store, clientId = OWNER) {
    const response = await rpc(store, '/poll', { auth_req_id: 'request-1', client_id: clientId });
    expect(response.status).toBe(200);
    return (await response.json()) as PollRpcResult<AnyRecord>;
  },
  async approve(store) {
    await rpc(store, '/approve', { auth_req_id: 'request-1', user_id: 'u1', sub: 'u1' });
  },
  async deny(store) {
    await rpc(store, '/deny', { auth_req_id: 'request-1' });
  },
  async remove(store) {
    await rpc(store, '/delete', { auth_req_id: 'request-1' });
  },
};

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function ok(result: PollRpcResult<AnyRecord>): { too_fast: boolean; metadata: AnyRecord } {
  if (result.result !== 'ok') throw new Error(`expected ok, got ${result.result}`);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each([deviceDriver, cibaDriver])('poll governor: $name', (driver) => {
  it('answers the first poll of a pending request as not too fast, and records it', async () => {
    const { store, storage } = await driver.create();
    await driver.seed(store);

    const first = ok(await driver.poll(store));

    expect(first.too_fast).toBe(false);
    expect(first.metadata).toMatchObject({ status: 'pending', poll_count: 1, interval: 5 });
    expect(first.metadata.last_poll_at).toBe(Date.now());
    expect(storage.values.get(driver.recordKey)).toMatchObject({
      poll_count: 1,
      last_poll_at: Date.now(),
    });
  });

  it('answers a second poll inside the interval as too fast and raises the interval by 5 s', async () => {
    const { store, storage } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);

    advance(1_000);
    const second = ok(await driver.poll(store));

    expect(second.too_fast).toBe(true);
    // The too-fast poll is counted and restarts the clock
    expect(second.metadata).toMatchObject({
      poll_count: 2,
      last_poll_at: Date.now(),
      interval: 10,
      base_interval: 5,
    });
    expect(storage.values.get(driver.recordKey)).toMatchObject({ interval: 10, poll_count: 2 });
  });

  it('answers a poll after the raised interval as pending again, and leaves the interval alone', async () => {
    const { store } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);
    advance(1_000);
    await driver.poll(store); // too fast: interval is now 10

    // 9 s after the last poll is still inside the new interval
    advance(9_000);
    const early = ok(await driver.poll(store));
    expect(early.too_fast).toBe(true);
    expect(early.metadata.interval).toBe(15);

    advance(15_000);
    const compliant = ok(await driver.poll(store));
    expect(compliant.too_fast).toBe(false);
    expect(compliant.metadata).toMatchObject({ interval: 15, base_interval: 5, poll_count: 4 });
  });

  it('does not call a poll that is a little early too fast (clock jitter)', async () => {
    const { store } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);

    advance(4_750); // 250 ms early
    const jittered = ok(await driver.poll(store));

    expect(jittered.too_fast).toBe(false);
    expect(jittered.metadata.interval).toBe(5);
  });

  it('calls a poll just beyond the tolerance too fast', async () => {
    const { store } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);

    advance(4_749);

    expect(ok(await driver.poll(store)).too_fast).toBe(true);
  });

  it('caps the raised interval at the maximum however often the client polls early', async () => {
    const { store, storage } = await driver.create();
    await driver.seed(store);
    // 30 polls one second apart: far fewer than the poll cap, far more than the 11 raises that
    // reach the maximum
    for (let poll = 0; poll < 30; poll++) {
      await driver.poll(store);
      advance(1_000);
    }

    expect(storage.values.get(driver.recordKey)).toMatchObject({
      interval: driver.limits.maxInterval,
      base_interval: 5,
      poll_count: 30,
    });
  });

  it('never lowers an interval that is already above the maximum', async () => {
    const { store } = await driver.create();
    await driver.seed(store, { interval: 70 });
    await driver.poll(store);
    advance(1_000);

    expect(ok(await driver.poll(store)).metadata.interval).toBe(70);
  });

  it('raises a stored interval just under the maximum only up to the maximum', async () => {
    const { store } = await driver.create();
    await driver.seed(store, { interval: 58 });
    await driver.poll(store);
    advance(1_000);

    expect(ok(await driver.poll(store)).metadata.interval).toBe(60);
  });

  it('works for a record stored before the interval was kept: the constant applies', async () => {
    const { store, storage } = await driver.create();
    await driver.seed(store, { interval: undefined });
    expect(storage.values.get(driver.recordKey)).not.toHaveProperty('interval');

    expect(ok(await driver.poll(store)).too_fast).toBe(false);
    advance(1_000);
    const second = ok(await driver.poll(store));

    expect(second.too_fast).toBe(true);
    expect(second.metadata).toMatchObject({ interval: 10, base_interval: 5 });
  });

  it('records a poll of an approved request, but it is never too fast and never changes the interval', async () => {
    const { store } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);
    await driver.approve(store);

    advance(100);
    const polled = ok(await driver.poll(store));

    expect(polled.too_fast).toBe(false);
    expect(polled.metadata).toMatchObject({ status: 'approved', interval: 5, poll_count: 2 });
  });

  it('records a poll of a denied request, but it is never too fast and never changes the interval', async () => {
    const { store } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);
    await driver.deny(store);

    advance(100);
    const polled = ok(await driver.poll(store));

    expect(polled.too_fast).toBe(false);
    expect(polled.metadata).toMatchObject({ status: 'denied', interval: 5 });
  });

  it('answers an expired request as gone, and deletes it', async () => {
    const { store, storage } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);

    advance(600_001);

    expect(await driver.poll(store)).toEqual({ result: 'not_found' });
    expect(storage.values.has(driver.recordKey)).toBe(false);
  });

  it('answers a request that does not exist as gone', async () => {
    const { store } = await driver.create();

    expect(await driver.poll(store)).toEqual({ result: 'not_found' });
  });

  it('does not touch the request when another client polls it', async () => {
    const { store, storage } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);
    advance(1_000);
    const before = structuredClone(storage.values.get(driver.recordKey));

    // Twice, and fast: neither may move last_poll_at, poll_count or the interval
    expect(await driver.poll(store, OTHER)).toEqual({ result: 'client_mismatch' });
    advance(100);
    expect(await driver.poll(store, OTHER)).toEqual({ result: 'client_mismatch' });

    expect(storage.values.get(driver.recordKey)).toEqual(before);
  });

  it('judges the owner by its own polls, not by a stranger polling in between', async () => {
    const { store } = await driver.create();
    await driver.seed(store);
    await driver.poll(store);
    advance(5_000);
    await driver.poll(store, OTHER);

    expect(ok(await driver.poll(store)).too_fast).toBe(false);
  });

  it('answers a body without both identifiers as gone', async () => {
    const { store } = await driver.create();
    await driver.seed(store);

    for (const body of [{}, { client_id: OWNER }, { device_code: 1, auth_req_id: 1 }]) {
      const response = await rpc(store, '/poll', body);
      expect(await response.json()).toEqual({ result: 'not_found' });
    }
  });

  describe('poll cap', () => {
    // 600 s at 5 s: 120 polls, plus the margin of 10
    const CAP_600 = 130;

    it('computes the cap from the lifetime and the starting interval', () => {
      const base = { created_at: 0, expires_at: 600_000, interval: 5 };
      expect(maxPollCountFor(base, driver.limits)).toBe(CAP_600);
      // 1800 s at 5 s needs 360 polls
      expect(maxPollCountFor({ ...base, expires_at: 1_800_000 }, driver.limits)).toBe(370);
      // The constant is the floor for a short lifetime
      expect(maxPollCountFor({ ...base, expires_at: 60_000 }, driver.limits)).toBe(120);
      // Raising the interval does not shrink it: the starting interval counts
      expect(
        maxPollCountFor(
          { ...base, expires_at: 1_800_000, interval: 60, base_interval: 5 },
          driver.limits
        )
      ).toBe(370);
    });

    it('cuts a request off when a poll goes over the cap, and deletes it', async () => {
      const { store, storage } = await driver.create();
      await driver.seed(store, { poll_count: CAP_600 - 1 });

      expect(ok(await driver.poll(store)).metadata.poll_count).toBe(CAP_600);
      advance(5_000);
      expect(await driver.poll(store)).toEqual({ result: 'poll_limit_exceeded' });
      expect(storage.values.has(driver.recordKey)).toBe(false);
      expect(await driver.poll(store)).toEqual({ result: 'not_found' });
    });

    it('cuts off a client that ignores slow_down', async () => {
      const { store, storage } = await driver.create();
      await driver.seed(store);
      let result: PollRpcResult<AnyRecord> = { result: 'not_found' };
      let polls = 0;
      while (polls < 200) {
        result = await driver.poll(store);
        polls++;
        if (result.result !== 'ok') break;
        advance(1_000);
      }

      expect(result).toEqual({ result: 'poll_limit_exceeded' });
      expect(polls).toBe(CAP_600 + 1);
      expect(storage.values.has(driver.recordKey)).toBe(false);
    });

    it.each([
      ['600 s', 600_000],
      ['1800 s', 1_800_000],
    ])(
      'never cuts off a client that waits the interval for the whole %s lifetime',
      async (_label, lifetimeMs) => {
        const { store } = await driver.create();
        await driver.seed(store, { expires_at: Date.now() + lifetimeMs });
        const start = Date.now();

        let polls = 0;
        while (Date.now() - start < lifetimeMs) {
          const polled = ok(await driver.poll(store));
          expect(polled.too_fast).toBe(false);
          polls++;
          advance(5_000);
        }

        expect(polls).toBe(lifetimeMs / 5_000);
        expect(polls).toBeLessThanOrEqual(
          maxPollCountFor(
            { created_at: start, expires_at: start + lifetimeMs, interval: 5 },
            driver.limits
          )
        );
      }
    );

    it('never cuts off a client that obeys a slow_down it gets late in a 1800 s lifetime', async () => {
      const lifetimeMs = 1_800_000;
      const { store } = await driver.create();
      await driver.seed(store, { expires_at: Date.now() + lifetimeMs });
      const start = Date.now();

      // The client waits its interval and adds 5 s on slow_down (RFC 8628 section 3.5). One poll
      // arrives a second early, 1700 s in, as a retry after a network stall might.
      let clientInterval = 5_000;
      let polls = 0;
      let stalled = false;
      while (Date.now() - start < lifetimeMs) {
        const polled = await driver.poll(store);
        expect(polled.result, `poll ${polls + 1}`).toBe('ok');
        polls++;
        if (ok(polled).too_fast) clientInterval += 5_000;
        const early = !stalled && Date.now() - start >= 1_700_000;
        if (early) stalled = true;
        advance(early ? 1_000 : clientInterval);
      }

      expect(stalled).toBe(true);
      // More than a cap computed from the raised interval would allow (190), within the real one
      expect(polls).toBeGreaterThan(190);
    });

    it('does not cut off an approved request however many times it was polled', async () => {
      const { store } = await driver.create();
      await driver.seed(store, { poll_count: 5_000 });
      await driver.approve(store);

      expect(ok(await driver.poll(store)).metadata.status).toBe('approved');
    });
  });

  describe('against approve, deny and delete', () => {
    it('keeps the approval and the poll when they arrive together', async () => {
      const { store, storage } = await driver.create();
      await driver.seed(store);
      // Each write is applied at once but its promise settles later, which gives a change that
      // is not queued behind the others the room to read the old record meanwhile.
      let release!: () => void;
      storage.holdPuts = new Promise<void>((resolve) => {
        release = resolve;
      });

      const poll = driver.poll(store);
      const approval = driver.approve(store);
      await vi.advanceTimersByTimeAsync(0);
      storage.holdPuts = null;
      release();
      const [polled] = await Promise.all([poll, approval]);

      expect(polled.result).toBe('ok');
      // Neither change overwrote the other
      expect(storage.values.get(driver.recordKey)).toMatchObject({
        status: 'approved',
        poll_count: 1,
        last_poll_at: Date.now(),
      });
    });

    it('does not bring back a request deleted while a poll is saving', async () => {
      const { store, storage } = await driver.create();
      await driver.seed(store);
      let release!: () => void;
      storage.holdPuts = new Promise<void>((resolve) => {
        release = resolve;
      });

      const poll = driver.poll(store);
      const removal = driver.remove(store);
      await vi.advanceTimersByTimeAsync(0);
      storage.holdPuts = null;
      release();
      await Promise.all([poll, removal]);

      expect(storage.values.has(driver.recordKey)).toBe(false);
    });
  });
});

describe('poll governor: CIBA ping and push requests', () => {
  it.each(['ping', 'push'])(
    'records the polls of a %s request, but they are never too fast, never raise the interval and never hit the cap',
    async (deliveryMode) => {
      const { store, storage } = await cibaDriver.create();
      await cibaDriver.seed(store, { delivery_mode: deliveryMode, poll_count: 10_000 });

      let lastPoll = ok(await cibaDriver.poll(store));
      for (let poll = 0; poll < 50; poll++) {
        advance(100);
        lastPoll = ok(await cibaDriver.poll(store));
        expect(lastPoll.too_fast).toBe(false);
      }

      expect(lastPoll.metadata).toMatchObject({ interval: 5, poll_count: 10_051 });
      expect(lastPoll.metadata).not.toHaveProperty('base_interval');
      expect(storage.values.get(cibaDriver.recordKey)).toMatchObject({ poll_count: 10_051 });
    }
  );
});

describe('poll governor: CIBA request with the tenant maximum interval', () => {
  it('stores the maximum with the request and caps slow_down at it, however often the client polls early', async () => {
    const { store, storage } = await cibaDriver.create();
    await cibaDriver.seed(store, { max_interval: 12 });
    expect(storage.values.get(cibaDriver.recordKey)).toMatchObject({ max_interval: 12 });

    for (let poll = 0; poll < 20; poll++) {
      await cibaDriver.poll(store);
      advance(1_000);
    }

    expect(storage.values.get(cibaDriver.recordKey)).toMatchObject({
      interval: 12,
      base_interval: 5,
      poll_count: 20,
      max_interval: 12,
    });
  });

  it('allows an interval above the constant when the tenant maximum is higher', async () => {
    const { store } = await cibaDriver.create();
    await cibaDriver.seed(store, { interval: 60, max_interval: 120 });
    await cibaDriver.poll(store);
    advance(1_000);

    expect(ok(await cibaDriver.poll(store)).metadata.interval).toBe(65);
  });

  it('keeps the constant for a request stored without a maximum', async () => {
    const { store, storage } = await cibaDriver.create();
    await cibaDriver.seed(store, { interval: 58 });
    expect(storage.values.get(cibaDriver.recordKey)).not.toHaveProperty('max_interval');
    await cibaDriver.poll(store);
    advance(1_000);

    expect(ok(await cibaDriver.poll(store)).metadata.interval).toBe(60);
  });
});

describe('the deprecated /update-poll route', () => {
  it('still records a poll for a caller deployed before /poll existed', async () => {
    const device = await deviceDriver.create();
    await deviceDriver.seed(device.store);
    expect((await rpc(device.store, '/update-poll', { device_code: 'device-1' })).status).toBe(200);
    expect(device.storage.values.get('d:device-1')).toMatchObject({ poll_count: 1 });

    const ciba = await cibaDriver.create();
    await cibaDriver.seed(ciba.store);
    expect((await rpc(ciba.store, '/update-poll', { auth_req_id: 'request-1' })).status).toBe(200);
    expect(ciba.storage.values.get('r:request-1')).toMatchObject({ poll_count: 1 });
  });
});

describe('DeviceCodeStore user code uniqueness', () => {
  async function conflict(store: Store, overrides: AnyRecord): Promise<Response> {
    return rpc(store, '/store', deviceRecord(overrides));
  }

  it('rejects a user code another live device code holds, and keeps the first', async () => {
    const { store, storage } = await deviceDriver.create();
    await deviceDriver.seed(store);

    const response = await conflict(store, { device_code: 'device-2', client_id: OTHER });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'user_code_conflict' });
    expect(storage.values.has('d:device-2')).toBe(false);
    expect(storage.values.get('u:ABCD-EFGH')).toBe('device-1');
    const holder = await rpc(store, '/get-by-user-code', { user_code: 'ABCD-EFGH' });
    expect(await holder.json()).toMatchObject({ device_code: 'device-1', client_id: OWNER });
  });

  it('lets a second code with another user code in', async () => {
    const { store } = await deviceDriver.create();
    await deviceDriver.seed(store);

    expect(
      (await conflict(store, { device_code: 'device-2', user_code: 'WXYZ-2345' })).status
    ).toBe(200);
  });

  it('accepts the same device code stored again', async () => {
    const { store } = await deviceDriver.create();
    await deviceDriver.seed(store);

    expect((await conflict(store, {})).status).toBe(200);
  });

  it('takes a user code back once the holder has expired', async () => {
    const { store, storage } = await deviceDriver.create();
    await deviceDriver.seed(store);
    advance(600_001);

    expect((await conflict(store, { device_code: 'device-2' })).status).toBe(200);
    expect(storage.values.get('u:ABCD-EFGH')).toBe('device-2');
    expect(storage.values.has('d:device-1')).toBe(false);
  });

  it('takes a user code back once the holder was deleted', async () => {
    const { store } = await deviceDriver.create();
    await deviceDriver.seed(store);
    await deviceDriver.remove(store);

    expect((await conflict(store, { device_code: 'device-2' })).status).toBe(200);
  });

  it('ignores a mapping whose device code is gone', async () => {
    const { store, storage } = await deviceDriver.create();
    storage.values.set('u:ABCD-EFGH', 'ghost-device');

    expect((await conflict(store, { device_code: 'device-2' })).status).toBe(200);
    expect(storage.values.get('u:ABCD-EFGH')).toBe('device-2');
  });

  it('lets only one of two simultaneous stores of the same user code in', async () => {
    const { store } = await deviceDriver.create();

    const responses = await Promise.all([
      conflict(store, { device_code: 'device-1' }),
      conflict(store, { device_code: 'device-2' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });
});

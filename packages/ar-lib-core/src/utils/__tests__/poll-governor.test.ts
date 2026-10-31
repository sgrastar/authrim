import { describe, expect, it } from 'vitest';
import {
  CIBA_POLL_LIMITS,
  DEVICE_POLL_LIMITS,
  POLL_COUNT_MARGIN,
  currentPollInterval,
  evaluatePoll,
  MIN_SLOW_DOWN_INCREMENT,
  configuredPollCount,
  maxPollCountFor,
  maxPollInterval,
  slowDownIncrementFor,
  type PollGovernedRecord,
} from '../poll-governor';
import { CIBA_CONSTANTS } from '../ciba';
import { DEVICE_FLOW_CONSTANTS } from '../device-flow';

const NOW = 1_800_000_000_000;

function record(overrides: Partial<PollGovernedRecord> = {}): PollGovernedRecord {
  return { created_at: NOW, expires_at: NOW + 600_000, interval: 5, ...overrides };
}

describe('poll limits come from the existing constants', () => {
  it('device', () => {
    expect(DEVICE_POLL_LIMITS).toEqual({
      defaultInterval: DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL,
      maxInterval: DEVICE_FLOW_CONSTANTS.MAX_INTERVAL,
      slowDownIncrement: DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT,
      maxPollCount: DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT,
    });
  });

  it('CIBA', () => {
    expect(CIBA_POLL_LIMITS).toEqual({
      defaultInterval: CIBA_CONSTANTS.DEFAULT_INTERVAL,
      maxInterval: CIBA_CONSTANTS.MAX_INTERVAL,
      slowDownIncrement: CIBA_CONSTANTS.SLOW_DOWN_INCREMENT,
      maxPollCount: CIBA_CONSTANTS.MAX_POLL_COUNT,
    });
  });

  it('raise the interval by at least 5 seconds, as both specifications require', () => {
    expect(DEVICE_POLL_LIMITS.slowDownIncrement).toBeGreaterThanOrEqual(5);
    expect(CIBA_POLL_LIMITS.slowDownIncrement).toBeGreaterThanOrEqual(5);
  });
});

describe('currentPollInterval', () => {
  it('uses the stored interval, else the default', () => {
    expect(currentPollInterval(record({ interval: 20 }), DEVICE_POLL_LIMITS)).toBe(20);
    expect(currentPollInterval(record({ interval: undefined }), DEVICE_POLL_LIMITS)).toBe(5);
  });

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number])(
    'ignores an unusable stored interval (%s)',
    (interval) => {
      expect(currentPollInterval(record({ interval }), DEVICE_POLL_LIMITS)).toBe(5);
    }
  );
});

describe('maxPollCountFor', () => {
  it('is the larger of the constant and the polls a compliant client needs, plus the margin', () => {
    expect(maxPollCountFor(record(), DEVICE_POLL_LIMITS)).toBe(120 + POLL_COUNT_MARGIN);
    expect(maxPollCountFor(record({ expires_at: NOW + 1_800_000 }), DEVICE_POLL_LIMITS)).toBe(
      360 + POLL_COUNT_MARGIN
    );
    expect(maxPollCountFor(record({ expires_at: NOW + 30_000 }), DEVICE_POLL_LIMITS)).toBe(120);
  });

  it('uses the interval the request started with, not the raised one', () => {
    const raised = record({ expires_at: NOW + 1_800_000, interval: 30, base_interval: 5 });

    expect(maxPollCountFor(raised, DEVICE_POLL_LIMITS)).toBe(360 + POLL_COUNT_MARGIN);
  });

  it('is not undone by a zero-length or negative lifetime', () => {
    expect(maxPollCountFor(record({ expires_at: NOW - 1 }), DEVICE_POLL_LIMITS)).toBe(120);
  });
});

describe('evaluatePoll', () => {
  it('never calls the first poll too fast', () => {
    const result = evaluatePoll(record(), NOW, DEVICE_POLL_LIMITS, true);

    expect(result.tooFast).toBe(false);
    expect(result.next).toMatchObject({ last_poll_at: NOW, poll_count: 1, interval: 5 });
    expect(result.next).not.toHaveProperty('base_interval');
  });

  it('compares with the previous poll, then records this one', () => {
    const previous = record({ last_poll_at: NOW - 1_000, poll_count: 3 });

    const result = evaluatePoll(previous, NOW, DEVICE_POLL_LIMITS, true);

    expect(result.tooFast).toBe(true);
    expect(result.next).toMatchObject({
      last_poll_at: NOW,
      poll_count: 4,
      interval: 10,
      base_interval: 5,
    });
    // The input is not changed
    expect(previous).toMatchObject({ last_poll_at: NOW - 1_000, poll_count: 3, interval: 5 });
  });

  it('draws the line at the interval less the tolerance', () => {
    const at = (gap: number) =>
      evaluatePoll(record({ last_poll_at: NOW - gap }), NOW, DEVICE_POLL_LIMITS, true).tooFast;

    expect(at(5_000)).toBe(false);
    // 250 ms early is within the tolerance, one millisecond more is not
    expect(at(4_750)).toBe(false);
    expect(at(4_749)).toBe(true);
  });

  it('keeps the first starting interval through later raises', () => {
    const second = evaluatePoll(
      record({ last_poll_at: NOW - 1_000, interval: 10, base_interval: 5 }),
      NOW,
      DEVICE_POLL_LIMITS,
      true
    );

    expect(second.next).toMatchObject({ interval: 15, base_interval: 5 });
  });

  it('records a poll that is not governed, but it is never too fast, never raises the interval and is never checked against the cap', () => {
    const result = evaluatePoll(
      record({ last_poll_at: NOW - 1, poll_count: 10_000 }),
      NOW,
      DEVICE_POLL_LIMITS,
      false
    );

    expect(result).toMatchObject({ tooFast: false, limitExceeded: false });
    expect(result.next).toMatchObject({ last_poll_at: NOW, poll_count: 10_001, interval: 5 });
  });

  it('flags the poll that goes over the cap and leaves the record alone', () => {
    const atCap = record({ poll_count: 130 });

    const result = evaluatePoll(atCap, NOW, DEVICE_POLL_LIMITS, true);

    expect(result.limitExceeded).toBe(true);
    expect(result.next).toBe(atCap);
  });
});

describe('a request that carries its own maximum interval', () => {
  it('is raised by slow_down no higher than that maximum', () => {
    const near = record({ last_poll_at: NOW - 1_000, interval: 8, max_interval: 10 });

    const result = evaluatePoll(near, NOW, CIBA_POLL_LIMITS, true);

    expect(result.tooFast).toBe(true);
    // 8 + 5 would be 13: the tenant's maximum is 10, below the constant 60
    expect(result.next.interval).toBe(10);
  });

  it('can be raised past the constant when the tenant allows more', () => {
    const wide = record({ last_poll_at: NOW - 1_000, interval: 58, max_interval: 120 });

    expect(evaluatePoll(wide, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(63);
  });

  it('does not lower an interval that is already above its maximum', () => {
    const above = record({ last_poll_at: NOW - 1_000, interval: 30, max_interval: 10 });

    expect(evaluatePoll(above, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(30);
  });

  it('is ignored when it is not a usable number, and the limit applies', () => {
    for (const max_interval of [0, -1, Number.NaN, '10' as unknown as number]) {
      const bad = record({ last_poll_at: NOW - 1_000, interval: 58, max_interval });
      expect(evaluatePoll(bad, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(60);
    }
  });

  it('behaves as before on a record stored without it', () => {
    const legacy = record({ last_poll_at: NOW - 1_000, interval: 58 });

    expect(maxPollInterval(legacy, CIBA_POLL_LIMITS)).toBe(CIBA_CONSTANTS.MAX_INTERVAL);
    expect(evaluatePoll(legacy, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(60);
  });

  it('does not change the poll cap', () => {
    const a = record({ max_interval: 10 });
    const b = record();
    expect(maxPollCountFor(a, CIBA_POLL_LIMITS)).toBe(maxPollCountFor(b, CIBA_POLL_LIMITS));
  });
});

describe('a request that carries its own slow_down increment', () => {
  it('is raised by that increment', () => {
    const polled = record({ last_poll_at: NOW - 1_000, interval: 5, slow_down_increment: 12 });

    const result = evaluatePoll(polled, NOW, CIBA_POLL_LIMITS, true);

    expect(result.tooFast).toBe(true);
    expect(result.next.interval).toBe(17);
    expect(result.next.base_interval).toBe(5);
  });

  it('is still held to the maximum interval', () => {
    const near = record({
      last_poll_at: NOW - 1_000,
      interval: 50,
      slow_down_increment: 30,
      max_interval: 60,
    });

    expect(evaluatePoll(near, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(60);
  });

  it('is never below the 5 seconds both specifications require, whatever the record holds', () => {
    expect(MIN_SLOW_DOWN_INCREMENT).toBe(5);
    for (const slow_down_increment of [1, 4, 4.9]) {
      const low = record({ last_poll_at: NOW - 1_000, interval: 5, slow_down_increment });
      expect(slowDownIncrementFor(low, CIBA_POLL_LIMITS), String(slow_down_increment)).toBe(5);
      expect(evaluatePoll(low, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(10);
    }
  });

  it('is ignored when it is not a usable number, and the limit applies', () => {
    for (const slow_down_increment of [0, -1, Number.NaN, '12' as unknown as number]) {
      const bad = record({ last_poll_at: NOW - 1_000, interval: 5, slow_down_increment });
      expect(evaluatePoll(bad, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(10);
    }
  });

  it('behaves as before on a record stored without it', () => {
    const legacy = record({ last_poll_at: NOW - 1_000, interval: 5 });

    expect(slowDownIncrementFor(legacy, CIBA_POLL_LIMITS)).toBe(CIBA_CONSTANTS.SLOW_DOWN_INCREMENT);
    expect(evaluatePoll(legacy, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(10);
  });

  it('leaves a device code stored without it on the constant', () => {
    const device = record({ last_poll_at: NOW - 1_000, interval: 5 });

    expect(slowDownIncrementFor(device, DEVICE_POLL_LIMITS)).toBe(
      DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT
    );
    expect(evaluatePoll(device, NOW, DEVICE_POLL_LIMITS, true).next.interval).toBe(10);
  });
});

describe('a request that carries its own poll count', () => {
  it('uses it as the configured count', () => {
    expect(configuredPollCount(record({ max_poll_count: 40 }), CIBA_POLL_LIMITS)).toBe(40);
    expect(configuredPollCount(record(), CIBA_POLL_LIMITS)).toBe(CIBA_CONSTANTS.MAX_POLL_COUNT);
  });

  it('is a floor: the polls a client that follows the interval needs raise the cap', () => {
    // 600 s at 5 s is 120 polls: a configured 10 must not cut a compliant client off at 10
    const short = record({ max_poll_count: 10 });
    expect(maxPollCountFor(short, CIBA_POLL_LIMITS)).toBe(120 + POLL_COUNT_MARGIN);
    expect(
      evaluatePoll({ ...short, poll_count: 100 }, NOW, CIBA_POLL_LIMITS, true).limitExceeded
    ).toBe(false);
  });

  it('is the cap when it is higher than what the lifetime needs', () => {
    const long = record({ max_poll_count: 300 });
    expect(maxPollCountFor(long, CIBA_POLL_LIMITS)).toBe(300);
    expect(
      evaluatePoll({ ...long, poll_count: 299 }, NOW, CIBA_POLL_LIMITS, true).limitExceeded
    ).toBe(false);
    expect(
      evaluatePoll({ ...long, poll_count: 300 }, NOW, CIBA_POLL_LIMITS, true).limitExceeded
    ).toBe(true);
  });

  it('rises with a longer lifetime, which uses the interval the request started with', () => {
    const lifetime = record({
      expires_at: NOW + 3_600_000,
      max_poll_count: 100,
      interval: 30,
      base_interval: 5,
    });
    expect(maxPollCountFor(lifetime, CIBA_POLL_LIMITS)).toBe(720 + POLL_COUNT_MARGIN);
  });

  it('is ignored when it is not a usable number, and the limit applies', () => {
    for (const max_poll_count of [0, -1, Number.NaN, '40' as unknown as number]) {
      expect(maxPollCountFor(record({ max_poll_count }), CIBA_POLL_LIMITS)).toBe(
        maxPollCountFor(record(), CIBA_POLL_LIMITS)
      );
    }
  });

  it('behaves as before on a record stored without it', () => {
    expect(maxPollCountFor(record({ poll_count: 50 }), CIBA_POLL_LIMITS)).toBe(
      120 + POLL_COUNT_MARGIN
    );
  });

  it('does not govern a poll that is not governed', () => {
    const over = record({ max_poll_count: 10, expires_at: NOW + 20_000, poll_count: 500 });
    expect(evaluatePoll(over, NOW, CIBA_POLL_LIMITS, false).limitExceeded).toBe(false);
  });
});

describe('values a record holds are held to the ranges of their settings', () => {
  const bad = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '12' as unknown as number,
    null as unknown as number,
    12.5,
    -1,
    0,
  ];

  it.each([...bad, 9, 501, 1_000_000_000])(
    'falls back to the constant poll count for max_poll_count = %s',
    (max_poll_count) => {
      expect(configuredPollCount(record({ max_poll_count }), CIBA_POLL_LIMITS)).toBe(
        CIBA_CONSTANTS.MAX_POLL_COUNT
      );
      // the cap is the one of a record without the field
      expect(maxPollCountFor(record({ max_poll_count }), CIBA_POLL_LIMITS)).toBe(
        maxPollCountFor(record(), CIBA_POLL_LIMITS)
      );
    }
  );

  it('does not let a huge count lift the cap', () => {
    const corrupt = record({ max_poll_count: 1_000_000_000, poll_count: 130 });
    expect(evaluatePoll(corrupt, NOW, CIBA_POLL_LIMITS, true).limitExceeded).toBe(true);
  });

  it.each([10, 40, 500])('honours max_poll_count = %s', (max_poll_count) => {
    expect(configuredPollCount(record({ max_poll_count }), CIBA_POLL_LIMITS)).toBe(max_poll_count);
  });

  it('still raises the cap to what the lifetime needs after validation', () => {
    // a valid 10 and a corrupt 9: both end at the lifetime-derived 130
    expect(maxPollCountFor(record({ max_poll_count: 10 }), CIBA_POLL_LIMITS)).toBe(130);
    expect(maxPollCountFor(record({ max_poll_count: 9 }), CIBA_POLL_LIMITS)).toBe(130);
    expect(maxPollCountFor(record({ max_poll_count: 300 }), CIBA_POLL_LIMITS)).toBe(300);
  });

  it.each([...bad, 4, 31, 1_000])(
    'falls back to the constant increment for slow_down_increment = %s',
    (slow_down_increment) => {
      expect(slowDownIncrementFor(record({ slow_down_increment }), CIBA_POLL_LIMITS)).toBe(
        CIBA_CONSTANTS.SLOW_DOWN_INCREMENT
      );
    }
  );

  it.each([5, 12, 30])('honours slow_down_increment = %s', (slow_down_increment) => {
    expect(slowDownIncrementFor(record({ slow_down_increment }), CIBA_POLL_LIMITS)).toBe(
      slow_down_increment
    );
  });

  it.each([...bad, 4, 301, 1_000_000])(
    'falls back to the constant maximum interval for max_interval = %s',
    (max_interval) => {
      expect(maxPollInterval(record({ max_interval }), CIBA_POLL_LIMITS)).toBe(
        CIBA_CONSTANTS.MAX_INTERVAL
      );
    }
  );

  it.each([5, 10, 120, 300])('honours max_interval = %s', (max_interval) => {
    expect(maxPollInterval(record({ max_interval }), CIBA_POLL_LIMITS)).toBe(max_interval);
  });

  it('does not let a huge maximum interval stretch slow_down', () => {
    const corrupt = record({ last_poll_at: NOW - 1_000, interval: 58, max_interval: 1e9 });
    expect(evaluatePoll(corrupt, NOW, CIBA_POLL_LIMITS, true).next.interval).toBe(60);
  });

  it.each([...bad, 301, 1e9])(
    'falls back to the default interval for interval and base_interval = %s',
    (value) => {
      expect(currentPollInterval(record({ interval: value }), CIBA_POLL_LIMITS)).toBe(
        CIBA_CONSTANTS.DEFAULT_INTERVAL
      );
      // an unusable base_interval does not shrink the cap's divisor to nothing or stretch it
      const corrupt = record({ interval: 5, base_interval: value });
      expect(maxPollCountFor(corrupt, CIBA_POLL_LIMITS)).toBe(
        maxPollCountFor(record({ interval: 5 }), CIBA_POLL_LIMITS)
      );
    }
  );

  it('honours a whole interval up to 300 seconds', () => {
    expect(currentPollInterval(record({ interval: 300 }), CIBA_POLL_LIMITS)).toBe(300);
    expect(currentPollInterval(record({ interval: 17 }), CIBA_POLL_LIMITS)).toBe(17);
  });
});

describe('a device code that carries the tenant device flow limits', () => {
  it('is raised by its own increment, no higher than its own maximum interval', () => {
    const polled = record({
      last_poll_at: NOW - 1_000,
      interval: 5,
      slow_down_increment: 12,
      max_interval: 14,
    });

    const first = evaluatePoll(polled, NOW, DEVICE_POLL_LIMITS, true);
    expect(first.next.interval).toBe(14);
    expect(first.next.base_interval).toBe(5);
    const again = evaluatePoll(
      { ...first.next, last_poll_at: NOW },
      NOW + 1_000,
      DEVICE_POLL_LIMITS,
      true
    );
    expect(again.next.interval).toBe(14);
  });

  it('can be raised above the constant maximum when its own maximum is higher', () => {
    const polled = record({ last_poll_at: NOW - 1_000, interval: 60, max_interval: 120 });

    expect(evaluatePoll(polled, NOW, DEVICE_POLL_LIMITS, true).next.interval).toBe(65);
  });

  it('is held to a lower maximum than the constant', () => {
    const polled = record({ last_poll_at: NOW - 1_000, interval: 5, max_interval: 8 });

    expect(maxPollInterval(polled, DEVICE_POLL_LIMITS)).toBe(8);
    expect(evaluatePoll(polled, NOW, DEVICE_POLL_LIMITS, true).next.interval).toBe(8);
  });

  it('never raises the interval by less than the 5 seconds RFC 8628 requires', () => {
    for (const slow_down_increment of [1, 4]) {
      const low = record({ last_poll_at: NOW - 1_000, interval: 5, slow_down_increment });
      expect(evaluatePoll(low, NOW, DEVICE_POLL_LIMITS, true).next.interval).toBe(10);
    }
  });

  it('caps the polls at the larger of its configured count and what the lifetime needs', () => {
    // 600 s at 5 s needs 120 polls (cap 130)
    expect(maxPollCountFor(record({ max_poll_count: 10 }), DEVICE_POLL_LIMITS)).toBe(
      120 + POLL_COUNT_MARGIN
    );
    expect(maxPollCountFor(record({ max_poll_count: 300 }), DEVICE_POLL_LIMITS)).toBe(300);
    // a longer lifetime at the interval the code started with
    expect(
      maxPollCountFor(
        record({
          expires_at: NOW + 1_800_000,
          max_poll_count: 120,
          interval: 30,
          base_interval: 5,
        }),
        DEVICE_POLL_LIMITS
      )
    ).toBe(360 + POLL_COUNT_MARGIN);
    expect(
      evaluatePoll(record({ max_poll_count: 300, poll_count: 300 }), NOW, DEVICE_POLL_LIMITS, true)
        .limitExceeded
    ).toBe(true);
  });

  it('ignores corrupt values and keeps the constants', () => {
    const corrupt = record({
      last_poll_at: NOW - 1_000,
      interval: 5,
      max_interval: 1e9,
      slow_down_increment: 2.5,
      max_poll_count: 1_000_000_000,
    });

    expect(maxPollInterval(corrupt, DEVICE_POLL_LIMITS)).toBe(DEVICE_FLOW_CONSTANTS.MAX_INTERVAL);
    expect(configuredPollCount(corrupt, DEVICE_POLL_LIMITS)).toBe(
      DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT
    );
    expect(evaluatePoll(corrupt, NOW, DEVICE_POLL_LIMITS, true).next.interval).toBe(10);
  });

  it('behaves as before for a code stored without any of the fields (a legacy code)', () => {
    const legacy = record({ last_poll_at: NOW - 1_000 });
    delete legacy.interval;

    expect(currentPollInterval(legacy, DEVICE_POLL_LIMITS)).toBe(
      DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL
    );
    expect(maxPollCountFor(legacy, DEVICE_POLL_LIMITS)).toBe(120 + POLL_COUNT_MARGIN);
    expect(evaluatePoll(legacy, NOW, DEVICE_POLL_LIMITS, true).next.interval).toBe(10);
  });
});

/**
 * A standard client (RFC 8628 section 3.5, CIBA Core section 11): it waits its own interval
 * between polls and raises that wait by exactly 5 seconds after `slow_down`, whatever increment
 * the server uses. This replays it against the governor with a fake clock.
 */
function simulateStandardClient(
  limits: typeof DEVICE_POLL_LIMITS,
  options: {
    lifetimeSeconds: number;
    slowDownIncrement?: number;
    /** Seconds after the first poll at which the client polls early once, then keeps its schedule. */
    earlyPollAfter?: number;
  }
) {
  const lifetimeMs = options.lifetimeSeconds * 1000;
  let stored: PollGovernedRecord = {
    created_at: NOW,
    expires_at: NOW + lifetimeMs,
    interval: limits.defaultInterval,
    ...(options.slowDownIncrement === undefined
      ? {}
      : { slow_down_increment: options.slowDownIncrement }),
  };
  let wait = limits.defaultInterval;
  const slowDownTimes: number[] = [];
  let polls = 0;
  let cutOff = false;
  let now = NOW;
  let next = NOW; // the first poll is at the start
  let early = options.earlyPollAfter !== undefined;

  while (next < NOW + lifetimeMs) {
    now = next;
    const result = evaluatePoll(stored, now, limits, true);
    polls++;
    if (result.limitExceeded) {
      cutOff = true;
      break;
    }
    stored = result.next;
    if (result.tooFast) {
      slowDownTimes.push((now - NOW) / 1000);
      wait += 5;
    }
    if (early) {
      // One poll earlier than the wait, right after the first
      early = false;
      next = now + options.earlyPollAfter! * 1000;
    } else {
      next = now + wait * 1000;
    }
  }
  return {
    slowDownTimes,
    polls,
    cutOff,
    clientWait: wait,
    serverInterval: currentPollInterval(stored, limits),
  };
}

describe.each([
  ['device', DEVICE_POLL_LIMITS, 600],
  ['CIBA', CIBA_POLL_LIMITS, 300],
])('a standard client (+5 s per slow_down) against the %s governor', (_name, limits, lifetime) => {
  it('never needs slow_down when it follows the interval, whatever the increment', () => {
    for (const slowDownIncrement of [undefined, 5, 30]) {
      const result = simulateStandardClient(limits, {
        lifetimeSeconds: lifetime,
        slowDownIncrement,
      });
      expect(result.slowDownTimes, String(slowDownIncrement)).toEqual([]);
      expect(result.cutOff).toBe(false);
    }
  });

  it('with the default increment of 5 is told slow_down once after an early poll, and converges', () => {
    const result = simulateStandardClient(limits, { lifetimeSeconds: lifetime, earlyPollAfter: 1 });

    // the early poll at 1 s; the client then waits 10 s as the server does
    expect(result.slowDownTimes).toEqual([1]);
    expect(result.clientWait).toBe(10);
    expect(result.serverInterval).toBe(10);
    expect(result.cutOff).toBe(false);
    // 1 s early poll, then every 10 s to the end of the lifetime
    expect(result.polls).toBe(2 + Math.ceil((lifetime - 11) / 10));
  });

  it('with an increment of 5 set explicitly behaves the same as the default', () => {
    expect(
      simulateStandardClient(limits, {
        lifetimeSeconds: lifetime,
        earlyPollAfter: 1,
        slowDownIncrement: 5,
      })
    ).toEqual(simulateStandardClient(limits, { lifetimeSeconds: lifetime, earlyPollAfter: 1 }));
  });

  it('with an increment of 30 is told slow_down again and again until its wait reaches the server interval', () => {
    const result = simulateStandardClient(limits, {
      lifetimeSeconds: 3600,
      earlyPollAfter: 1,
      slowDownIncrement: 30,
    });

    // one early poll leaves the server at 35 s and the client at 10 s; the server then sits at
    // its 60 s maximum while the client's wait grows 10, 15, ... 60 s: eleven slow_downs in all
    expect(result.slowDownTimes).toHaveLength(11);
    expect(result.slowDownTimes[0]).toBe(1);
    expect(result.slowDownTimes.at(-1)).toBe(1 + (10 + 15 + 20 + 25 + 30 + 35 + 40 + 45 + 50 + 55));
    expect(result.clientWait).toBe(60);
    expect(result.serverInterval).toBe(60);
    expect(result.cutOff).toBe(false);
  });

  it('with an increment of 30 may still be told slow_down when the lifetime ends', () => {
    // 326 s pass before the client has caught up: a request that lives 300 s (the CIBA default) ends first
    const result = simulateStandardClient(limits, {
      lifetimeSeconds: 300,
      earlyPollAfter: 1,
      slowDownIncrement: 30,
    });

    // slow_down at 1, 11, 26, 46, 71, 101, 136, 176, 221 and 271 s; the next poll would be at 326 s
    expect(result.slowDownTimes).toEqual([1, 11, 26, 46, 71, 101, 136, 176, 221, 271]);
    expect(result.clientWait).toBe(55);
    expect(result.serverInterval).toBe(60);
  });

  it('is not cut off by the poll cap, with the default count, however often it is slowed', () => {
    for (const slowDownIncrement of [undefined, 30]) {
      const result = simulateStandardClient(limits, {
        lifetimeSeconds: lifetime,
        earlyPollAfter: 1,
        slowDownIncrement,
      });
      expect(result.cutOff, String(slowDownIncrement)).toBe(false);
      expect(result.polls).toBeLessThan(
        maxPollCountFor({ created_at: NOW, expires_at: NOW + lifetime * 1000, interval: 5 }, limits)
      );
    }
  });
});

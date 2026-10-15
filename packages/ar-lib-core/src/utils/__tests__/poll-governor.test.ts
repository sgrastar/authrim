import { describe, expect, it } from 'vitest';
import {
  CIBA_POLL_LIMITS,
  DEVICE_POLL_LIMITS,
  POLL_COUNT_MARGIN,
  currentPollInterval,
  evaluatePoll,
  maxPollCountFor,
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

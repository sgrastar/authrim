/**
 * Poll governor shared by the device flow (RFC 8628 section 3.5) and CIBA poll mode (CIBA Core
 * section 11).
 *
 * One poll of a pending request is decided in this order, inside the Durable Object that owns the
 * request, so the check and the bookkeeping are one storage operation:
 *
 * 1. Load the record. A record that is missing or expired ends the flow (`expired_token`).
 * 2. `tooFast` is evaluated against the PREVIOUS `last_poll_at`:
 *    `last_poll_at != null && now - last_poll_at < interval * 1000 - POLL_EARLY_TOLERANCE_MS`.
 *    The first poll is never too fast.
 * 3. The poll is recorded: `last_poll_at = now`, `poll_count + 1`. A too-fast poll counts too, and
 *    it restarts the interval clock, so a client that keeps polling too early stays "too fast".
 * 4. When the poll was too fast the interval is raised by `slowDownIncrement` (at least 5 seconds
 *    in both specs, see {@link MIN_SLOW_DOWN_INCREMENT}) for this and all later requests, up to
 *    `maxInterval`. A request can carry its own increment, maximum interval and poll count, see
 *    {@link PollGovernedRecord}.
 * 5. The token endpoint answers `slow_down` if `tooFast`, otherwise by the request status
 *    (`authorization_pending`, approved, denied, expired).
 *
 * Every poll is recorded (`last_poll_at`, `poll_count + 1`), whatever the request status. Only a
 * GOVERNED poll (a pending request, and for CIBA a poll-mode one) can be too fast, raise the
 * interval, or go over the poll cap; see {@link maxPollCountFor}. A request that goes over the cap
 * is dropped and answers `expired_token`.
 */

import { CIBA_CONSTANTS } from './ciba';
import { DEVICE_FLOW_CONSTANTS } from './device-flow';
import { CIBA_SETTINGS_META } from '../types/settings/ciba';
import { isWithinSettingRange } from '../services/setting-range';

/**
 * What a record may hold for the values it carries, the ranges the Settings API allows for the
 * setting the value was taken from (one definition: the CIBA settings metadata). A value outside
 * them (a hand-edited or corrupt record) is not used and the limit applies instead.
 */
const RECORD_RANGES = {
  maxInterval: CIBA_SETTINGS_META['ciba.max_interval'],
  slowDownIncrement: CIBA_SETTINGS_META['ciba.slow_down_increment'],
  maxPollCount: CIBA_SETTINGS_META['ciba.max_poll_count'],
};
/** The longest polling interval a record may hold, in seconds: the highest `ciba.max_interval`. */
const RECORD_INTERVAL_CEILING = CIBA_SETTINGS_META['ciba.max_interval'].max as number;

/** The fields of a stored request that the governor reads or writes. */
export interface PollGovernedRecord {
  created_at: number;
  expires_at: number;
  last_poll_at?: number;
  poll_count?: number;
  /**
   * The polling interval in seconds that applies now, raised by `slow_down`. Absent on requests
   * stored before the interval was kept per request: the default then applies.
   */
  interval?: number;
  /** The interval the request started with; written the first time `slow_down` raises it. */
  base_interval?: number;
  /**
   * The highest interval `slow_down` can raise this request to, in seconds: the tenant's
   * `ciba.max_interval` as it was when the request was made. Absent on requests stored before it
   * was kept (and on device codes): {@link PollLimits.maxInterval} then applies.
   */
  max_interval?: number;
  /**
   * What one `slow_down` adds to this request's interval, in seconds: the tenant's
   * `ciba.slow_down_increment` as it was when the request was made. Absent on requests stored
   * before it was kept (and on device codes): {@link PollLimits.slowDownIncrement} then applies.
   * Never below {@link MIN_SLOW_DOWN_INCREMENT}.
   */
  slow_down_increment?: number;
  /**
   * The configured poll count of this request: the tenant's `ciba.max_poll_count` as it was when
   * the request was made. It is a floor, see {@link maxPollCountFor}. Absent on requests stored
   * before it was kept (and on device codes): {@link PollLimits.maxPollCount} then applies.
   */
  max_poll_count?: number;
}

export interface PollLimits {
  /** Interval for a record that holds none (seconds). */
  defaultInterval: number;
  /** The interval `slow_down` can raise to (seconds). */
  maxInterval: number;
  /** What one `slow_down` adds to the interval (seconds). */
  slowDownIncrement: number;
  /** The least number of polls a request may take before it is cut off. */
  maxPollCount: number;
}

/**
 * How much earlier than the interval a poll may arrive without being "too fast". A client that
 * polls on a fixed schedule reaches the server a few milliseconds early about half the time;
 * without this, such a compliant client would be told `slow_down`, lengthen its wait, and be told
 * again, until it sits at the maximum interval.
 */
export const POLL_EARLY_TOLERANCE_MS = 250;

/** The least `slow_down` increment in seconds: RFC 8628 section 3.5 and CIBA Core section 11. */
export const MIN_SLOW_DOWN_INCREMENT = 5;

/** Polls allowed on top of the number a client that follows the interval needs. */
export const POLL_COUNT_MARGIN = 10;

export const DEVICE_POLL_LIMITS: PollLimits = {
  defaultInterval: DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL,
  maxInterval: DEVICE_FLOW_CONSTANTS.MAX_INTERVAL,
  slowDownIncrement: DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT,
  maxPollCount: DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT,
};

export const CIBA_POLL_LIMITS: PollLimits = {
  defaultInterval: CIBA_CONSTANTS.DEFAULT_INTERVAL,
  maxInterval: CIBA_CONSTANTS.MAX_INTERVAL,
  slowDownIncrement: CIBA_CONSTANTS.SLOW_DOWN_INCREMENT,
  maxPollCount: CIBA_CONSTANTS.MAX_POLL_COUNT,
};

/** A polling interval a record holds: a whole number of seconds, 1 up to the ceiling. */
function intervalSeconds(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= RECORD_INTERVAL_CEILING
    ? value
    : null;
}

/** A value a record holds for a setting: whole and inside the setting's range, else null. */
function recordValue(value: unknown, range: (typeof RECORD_RANGES)[keyof typeof RECORD_RANGES]) {
  return isWithinSettingRange(value, range) ? value : null;
}

/** The highest interval (seconds) `slow_down` can raise a record to: its own, else the limit. */
export function maxPollInterval(record: PollGovernedRecord, limits: PollLimits): number {
  return recordValue(record.max_interval, RECORD_RANGES.maxInterval) ?? limits.maxInterval;
}

/**
 * What one `slow_down` adds to a record's interval (seconds): its own, else the limit; never below
 * the 5 seconds both specs require, whatever the record holds.
 */
export function slowDownIncrementFor(record: PollGovernedRecord, limits: PollLimits): number {
  return Math.max(
    MIN_SLOW_DOWN_INCREMENT,
    recordValue(record.slow_down_increment, RECORD_RANGES.slowDownIncrement) ??
      limits.slowDownIncrement
  );
}

/** The poll count a record is configured with: its own, else the limit (see maxPollCountFor). */
export function configuredPollCount(record: PollGovernedRecord, limits: PollLimits): number {
  return recordValue(record.max_poll_count, RECORD_RANGES.maxPollCount) ?? limits.maxPollCount;
}

/** The interval (seconds) a record is polled at now: the stored one, else the default. */
export function currentPollInterval(record: PollGovernedRecord, limits: PollLimits): number {
  return intervalSeconds(record.interval) ?? limits.defaultInterval;
}

/**
 * The most polls a request may take: the larger of the configured count (the request's own, else
 * the limit's) and the polls a client that follows the interval needs for the whole lifetime, plus
 * a margin. The configured count is a floor: a long lifetime or a short interval raises the cap,
 * so a client that follows the interval is never cut off.
 *
 * The lifetime is divided by the interval the request STARTED with, not the raised one. A
 * compliant client can be told `slow_down` by clock jitter late in the lifetime; dividing by the
 * raised interval would then shrink the cap below the polls it has already made legitimately. The
 * starting interval is also the largest number of polls any client that obeys `slow_down` can
 * make, because every `slow_down` only lengthens its wait.
 */
export function maxPollCountFor(record: PollGovernedRecord, limits: PollLimits): number {
  const startInterval =
    intervalSeconds(record.base_interval) ?? currentPollInterval(record, limits);
  const lifetimeSeconds = Math.max(0, (record.expires_at - record.created_at) / 1000);
  return Math.max(
    configuredPollCount(record, limits),
    Math.ceil(lifetimeSeconds / startInterval) + POLL_COUNT_MARGIN
  );
}

export interface PollEvaluation<T extends PollGovernedRecord> {
  /** The poll came before the interval ran out. Always false when the poll is not governed. */
  tooFast: boolean;
  /** This poll goes over the cap: the request is to be dropped. */
  limitExceeded: boolean;
  /** The record with this poll recorded (and the interval raised when it was too fast). */
  next: T;
}

/**
 * Decide one poll. Pure: the caller loads the record, checks that it is live and belongs to the
 * client, and stores `next` when `limitExceeded` is false.
 *
 * @param governed - false for a poll the governor does not rate-limit (the request is no longer
 *   pending, or it is not a poll-mode request). Such a poll is still recorded (`last_poll_at`,
 *   `poll_count + 1`) like any other, but it can never be `tooFast`, never raises the interval,
 *   and is never checked against the cap.
 */
export function evaluatePoll<T extends PollGovernedRecord>(
  record: T,
  now: number,
  limits: PollLimits,
  governed: boolean
): PollEvaluation<T> {
  const interval = currentPollInterval(record, limits);
  const pollCount = (record.poll_count || 0) + 1;
  const tooFast =
    governed &&
    typeof record.last_poll_at === 'number' &&
    now - record.last_poll_at < interval * 1000 - POLL_EARLY_TOLERANCE_MS;

  if (governed && pollCount > maxPollCountFor(record, limits)) {
    return { tooFast, limitExceeded: true, next: record };
  }

  const updates: Partial<PollGovernedRecord> = { last_poll_at: now, poll_count: pollCount };
  if (tooFast) {
    // Never lower an interval that is already above the cap.
    updates.interval = Math.min(
      interval + slowDownIncrementFor(record, limits),
      Math.max(maxPollInterval(record, limits), interval)
    );
    updates.base_interval = intervalSeconds(record.base_interval) ?? interval;
  }
  const next: T = { ...record, ...updates };
  return { tooFast, limitExceeded: false, next };
}

/** What the `/poll` RPC of the request stores answers. */
export type PollRpcResult<T> =
  | { result: 'ok'; too_fast: boolean; metadata: T }
  /** No such request, or it has expired (and is gone). */
  | { result: 'not_found' }
  /** The request belongs to another client. Nothing was recorded. */
  | { result: 'client_mismatch' }
  /** The poll count went over the cap; the request was deleted. */
  | { result: 'poll_limit_exceeded' };

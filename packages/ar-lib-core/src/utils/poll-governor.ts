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
 *    in both specs) for this and all later requests, up to `maxInterval`.
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

function positiveSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The interval (seconds) a record is polled at now: the stored one, else the default. */
export function currentPollInterval(record: PollGovernedRecord, limits: PollLimits): number {
  return positiveSeconds(record.interval) ?? limits.defaultInterval;
}

/**
 * The most polls a request may take: the larger of the configured count and the polls a client
 * that follows the interval needs for the whole lifetime, plus a margin.
 *
 * The lifetime is divided by the interval the request STARTED with, not the raised one. A
 * compliant client can be told `slow_down` by clock jitter late in the lifetime; dividing by the
 * raised interval would then shrink the cap below the polls it has already made legitimately. The
 * starting interval is also the largest number of polls any client that obeys `slow_down` can
 * make, because every `slow_down` only lengthens its wait.
 */
export function maxPollCountFor(record: PollGovernedRecord, limits: PollLimits): number {
  const startInterval =
    positiveSeconds(record.base_interval) ?? currentPollInterval(record, limits);
  const lifetimeSeconds = Math.max(0, (record.expires_at - record.created_at) / 1000);
  return Math.max(
    limits.maxPollCount,
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
      interval + limits.slowDownIncrement,
      Math.max(limits.maxInterval, interval)
    );
    updates.base_interval = positiveSeconds(record.base_interval) ?? interval;
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

/**
 * Shared guards for the device flow user code APIs (POST /api/devices/lookup and
 * POST /api/devices/verify): the per-IP user code rate limit and the device code lookup.
 *
 * Both fail closed. A user code is short enough to guess, so without a working rate limiter the
 * APIs refuse to read codes at all (503 temporarily_unavailable), and a store that cannot answer is
 * never reported as "no such code" (that would also count a failure against an innocent user).
 */

import type { Context } from 'hono';
import type { Env, DeviceCodeMetadata } from '@authrim/ar-lib-core';
import { buildDOKey, buildDOInstanceName, getLogger } from '@authrim/ar-lib-core';

export const USER_CODE_GUARD_UNAVAILABLE = {
  success: false,
  error: 'temporarily_unavailable',
  error_description: 'Device code verification is temporarily unavailable. Try again.',
} as const;

/**
 * How a reservation was settled. `lapsed`: the 30 seconds ran out (or the limiter lost the
 * reservation) before the lookup finished, so its slot may already be spent by others; the
 * limiter has counted it as one failure whatever was found. `failed`: the limiter could not be
 * reached or its answer was not exactly what a settle returns.
 */
export type SettleOutcome = 'ok' | 'lapsed' | 'failed';

export type UserCodeRateLimit =
  | { status: 'unavailable' }
  | { status: 'blocked'; retryAfter: number }
  | {
      status: 'allowed';
      /**
       * Settles the reservation as a failed guess: a code that is confirmed not to exist counts
       * against the budget (also when the reservation had lapsed: a lapse is not a free guess).
       */
      recordFailure(): Promise<SettleOutcome>;
      /**
       * Settles the reservation without counting: the lookup found a code, the input was
       * malformed, or the store could not answer. A reservation that had lapsed is counted as one
       * failure anyway (what the lookup found must not show in the budget). A no-op once the
       * reservation is settled.
       */
      release(): Promise<SettleOutcome>;
    };

function clientIpOf(c: Context<{ Bindings: Env }>): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
}

/**
 * Reserve one guess of the per-IP user code budget (UserCodeRateLimiter Durable Object).
 *
 * The limiter decides in one step whether `failures + guesses in flight` is still below the
 * limit and, if so, holds a short-lived reservation for this request. A burst of parallel
 * requests therefore cannot all pass a check before the first failure is recorded: at most the
 * remaining budget reaches the store. The caller settles the reservation right after the lookup
 * with `recordFailure()` (the code does not exist) or `release()` (anything else); a reservation
 * nobody settles expires on its own.
 *
 * A missing USER_CODE_RATE_LIMITER binding is tolerated only where mock authentication is enabled,
 * which is never the case in production (ENVIRONMENT=production always disables it).
 */
export async function checkUserCodeRateLimit(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  options: { mockAuthEnabled: boolean }
): Promise<UserCodeRateLimit> {
  const log = getLogger(c).module('DEVICE');
  const namespace = c.env.USER_CODE_RATE_LIMITER;
  if (!namespace) {
    if (options.mockAuthEnabled) {
      return {
        status: 'allowed',
        recordFailure: async () => 'ok',
        release: async () => 'ok',
      };
    }
    log.error('USER_CODE_RATE_LIMITER is not bound; refusing user code verification', {});
    return { status: 'unavailable' };
  }

  const clientIp = clientIpOf(c);
  const call = (path: string, extra: Record<string, unknown> = {}) =>
    namespace.get(namespace.idFromName(buildDOKey('rate-limit', 'user-code', tenantId))).fetch(
      new Request(`https://internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: clientIp, ...extra }),
      })
    );

  type Answer = {
    blocked?: unknown;
    retry_after?: unknown;
    reservation_id?: unknown;
  };
  let result: Answer;
  let reservationId = '';
  try {
    const response = await call('/reserve');
    if (!response.ok) {
      throw new Error(`User code rate limiter reserve returned ${response.status}`);
    }
    result = await response.json<Answer>();
    if (!result || typeof result.blocked !== 'boolean') {
      throw new Error('User code rate limiter returned an unexpected body');
    }
    if (!result.blocked) {
      if (typeof result.reservation_id !== 'string') {
        throw new Error('User code rate limiter allowed a guess without a reservation');
      }
      reservationId = result.reservation_id;
    }
  } catch (error) {
    log.error('User code rate limiter check failed', {}, error as Error);
    return { status: 'unavailable' };
  }

  if (result.blocked) {
    const retryAfter = typeof result.retry_after === 'number' ? result.retry_after : 0;
    return { status: 'blocked', retryAfter: retryAfter > 0 ? retryAfter : 3600 };
  }

  /**
   * Asks the limiter to settle the reservation and reads its answer strictly: `ok` only for
   * `settled === true`, `expired === false` and the outcome of this very call; `lapsed` only for
   * `settled === true`, `expired === true` and that outcome; anything else (missing, of another
   * type, contradictory) is `failed`, and the caller discloses nothing. A lapsed reservation is
   * counted by the limiter as one failure whatever was found, so it does not reveal the result.
   */
  const settle = async (path: '/record-failure' | '/release'): Promise<SettleOutcome> => {
    const expectedOutcome = path === '/release' ? 'released' : 'failure';
    try {
      const response = await call(path, { reservation_id: reservationId });
      if (!response.ok) {
        throw new Error(`User code rate limiter returned ${response.status}`);
      }
      const answer = await response.json<{
        settled?: unknown;
        expired?: unknown;
        outcome?: unknown;
      }>();
      const unexpected = () => {
        log.error('User code rate limiter answered a settle with an unexpected body', {});
        return 'failed' as const;
      };
      if (answer.settled !== true || answer.outcome !== expectedOutcome) return unexpected();
      if (answer.expired === false) return 'ok';
      return answer.expired === true ? 'lapsed' : unexpected();
    } catch (error) {
      log.error('User code rate limiter could not settle a guess', {}, error as Error);
      return 'failed';
    }
  };

  // The first settle wins; later ones return its outcome
  let outcome: Promise<SettleOutcome> | undefined;
  return {
    status: 'allowed',
    recordFailure() {
      outcome ??= settle('/record-failure');
      return outcome;
    },
    release() {
      outcome ??= settle('/release');
      return outcome;
    },
  };
}

export function userCodeBlockedResponse(c: Context<{ Bindings: Env }>, retryAfter: number) {
  return c.json(
    {
      success: false,
      error: 'slow_down',
      error_description: `Too many failed attempts. Please try again in ${retryAfter} seconds.`,
    },
    429
  );
}

export type DeviceCodeLookup =
  | { status: 'found'; metadata: DeviceCodeMetadata }
  | { status: 'absent' }
  | { status: 'unavailable' };

/**
 * Read a device code by its user code. Only a store that answered "no such code" (a JSON null)
 * is `absent`; an error status, a thrown fetch or an unreadable body is `unavailable`.
 */
export async function lookUpDeviceCodeByUserCode(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userCode: string
): Promise<DeviceCodeLookup> {
  try {
    const store = c.env.DEVICE_CODE_STORE.get(
      c.env.DEVICE_CODE_STORE.idFromName(buildDOInstanceName('device', tenantId))
    );
    const response = await store.fetch(
      new Request('https://internal/get-by-user-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenantId },
        body: JSON.stringify({ user_code: userCode }),
      })
    );
    if (!response.ok) {
      throw new Error(`Device code store returned ${response.status}`);
    }
    const metadata = await response.json<DeviceCodeMetadata | null>();
    return metadata ? { status: 'found', metadata } : { status: 'absent' };
  } catch (error) {
    getLogger(c)
      .module('DEVICE')
      .error('Device code store lookup failed', {}, error as Error);
    return { status: 'unavailable' };
  }
}

/**
 * Look a user code up and settle the rate limit reservation in the same step.
 *
 * The result of a lookup is disclosed only when the reservation was still live when it ended:
 * - a code that does not exist is recorded as a failure (`absent`), and a failure that cannot be
 *   recorded, or a reservation that lapsed in the meantime (the failure is still counted), answers
 *   `unavailable` instead, so a stalled request gets no free guess;
 * - anything else frees the reservation, and `unavailable` is answered when the release shows the
 *   reservation had lapsed (the limiter then counts one failure just the same, so the budget does
 *   not tell a stalled request whether it found a code) or cannot be confirmed.
 * Settling here, not at the end of the request, keeps a slot in flight only while the store is
 * being read.
 */
export async function lookUpAndSettle(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userCode: string,
  rateLimit: Extract<UserCodeRateLimit, { status: 'allowed' }>
): Promise<DeviceCodeLookup> {
  const lookup = await lookUpDeviceCodeByUserCode(c, tenantId, userCode);
  if (lookup.status === 'unavailable') {
    await rateLimit.release();
    return lookup;
  }
  const outcome =
    lookup.status === 'absent' ? await rateLimit.recordFailure() : await rateLimit.release();
  return outcome === 'ok' ? lookup : { status: 'unavailable' };
}

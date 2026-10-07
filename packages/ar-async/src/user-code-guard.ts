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

export type UserCodeRateLimit =
  | { status: 'unavailable' }
  | { status: 'blocked'; retryAfter: number }
  | {
      status: 'allowed';
      /** Counts a code that is confirmed not to exist. False when it could not be counted. */
      recordFailure(): Promise<boolean>;
      /** Clears the counter after a successful decision (best effort). */
      reset(): Promise<void>;
    };

function clientIpOf(c: Context<{ Bindings: Env }>): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
}

/**
 * Check the per-IP user code rate limit (UserCodeRateLimiter Durable Object).
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
      return { status: 'allowed', recordFailure: async () => true, reset: async () => {} };
    }
    log.error('USER_CODE_RATE_LIMITER is not bound; refusing user code verification', {});
    return { status: 'unavailable' };
  }

  const clientIp = clientIpOf(c);
  const call = (path: string) =>
    namespace.get(namespace.idFromName(buildDOKey('rate-limit', 'user-code', tenantId))).fetch(
      new Request(`https://internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: clientIp }),
      })
    );

  let result: { blocked?: unknown; retry_after?: unknown };
  try {
    const response = await call('/check');
    if (!response.ok) {
      throw new Error(`User code rate limiter check returned ${response.status}`);
    }
    result = (await response.json()) as { blocked?: unknown; retry_after?: unknown };
    if (!result || typeof result.blocked !== 'boolean') {
      throw new Error('User code rate limiter check returned an unexpected body');
    }
  } catch (error) {
    log.error('User code rate limiter check failed', {}, error as Error);
    return { status: 'unavailable' };
  }

  if (result.blocked) {
    const retryAfter = typeof result.retry_after === 'number' ? result.retry_after : 0;
    return { status: 'blocked', retryAfter: retryAfter > 0 ? retryAfter : 3600 };
  }

  return {
    status: 'allowed',
    async recordFailure() {
      try {
        const response = await call('/record-failure');
        if (!response.ok) {
          throw new Error(`User code rate limiter returned ${response.status}`);
        }
        return true;
      } catch (error) {
        log.error('User code rate limiter could not record a failure', {}, error as Error);
        return false;
      }
    },
    async reset() {
      await call('/reset').catch(() => {
        /* Ignore: the decision is already made */
      });
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
    const metadata = (await response.json()) as DeviceCodeMetadata | null;
    return metadata ? { status: 'found', metadata } : { status: 'absent' };
  } catch (error) {
    getLogger(c)
      .module('DEVICE')
      .error('Device code store lookup failed', {}, error as Error);
    return { status: 'unavailable' };
  }
}

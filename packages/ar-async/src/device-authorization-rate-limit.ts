/**
 * Rate limits of POST /device_authorization. Every call issues a device code and a user code and
 * writes them to the DeviceCodeStore, so an unlimited caller could fill the store and use up the
 * user code space of a tenant.
 *
 * Two budgets, both shared through the RateLimiterCounter Durable Object (atomic; with no counter
 * the endpoint refuses, like the user code APIs):
 * - per IP address, spent before the body is read: the `moderate` profile (60 per minute by
 *   default). Several devices behind one address (a school, an office) share it.
 * - per client, spent once the client is known and authenticated: the `lenient` profile (300
 *   per minute by default), for all devices of one application.
 * Both profiles are the platform's: `rate_limit.moderate` / `rate_limit.lenient` (and their
 * `_window_seconds`) in the Settings API, else the RATE_LIMIT_* variables, else these defaults.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  checkRateLimit,
  getClientIP,
  getCloudProvider,
  getLogger,
  getRateLimitProfileAsync,
} from '@authrim/ar-lib-core';
import { deviceAuthorizationError } from './device-authorization-request';

type Budget = 'ip' | 'client';

const BUDGETS = {
  ip: { profile: 'moderate', endpointClass: 'device_authorization' },
  client: { profile: 'lenient', endpointClass: 'device_authorization_client' },
} as const;

/**
 * Spend one request of a budget. Returns the refusal to send (429 over the limit, 503 when the
 * limiter cannot answer), or the headers to put on the answer.
 */
async function spend(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  budget: Budget,
  subject: string
): Promise<{ refusal: Response } | { headers: Record<string, string> }> {
  const log = getLogger(c).module('DEVICE');
  const { profile, endpointClass } = BUDGETS[budget];
  try {
    let executionCtx: Context['executionCtx'] | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const limits = await getRateLimitProfileAsync(c.env, profile, executionCtx);
    const result = await checkRateLimit(
      c.env,
      subject,
      { ...limits, endpointClass, requireAtomic: true },
      tenantId
    );
    const headers = {
      'X-RateLimit-Limit': String(limits.maxRequests),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(result.resetAt),
    };
    if (result.allowed) return { headers };

    const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
    log.warn('Device authorization rate limit exceeded', { action: 'rate_limit', budget });
    return {
      refusal: deviceAuthorizationError(
        c,
        'rate_limit_exceeded',
        'Too many requests. Try again later.',
        429,
        { ...headers, 'Retry-After': String(retryAfter) }
      ),
    };
  } catch (error) {
    // Fail closed: a limit that cannot be checked is not skipped
    log.error('Device authorization rate limiter failed', { action: 'rate_limit' }, error as Error);
    return {
      refusal: deviceAuthorizationError(
        c,
        'temporarily_unavailable',
        'The service is temporarily unavailable. Try again later.',
        503,
        { 'Retry-After': '5' }
      ),
    };
  }
}

/** The per-IP budget. Spent first, so a flood costs no body parsing or client lookup. */
export async function spendIpBudget(c: Context<{ Bindings: Env }>, tenantId: string) {
  const provider = await getCloudProvider(c.env);
  return spend(c, tenantId, 'ip', `ip:${getClientIP(c, provider).slice(0, 64)}`);
}

/** The per-client budget, for a client that exists and has authenticated. */
export function spendClientBudget(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientId: string
) {
  return spend(c, tenantId, 'client', `client:${clientId}`);
}

/**
 * The REAL UserCodeRateLimiter Durable Object over an in-memory storage, as a namespace binding.
 * A stub that always answers `blocked: false` hides every problem with how failures are counted,
 * so tests that are about the per-IP failure budget use this one.
 */
import type { DurableObjectState } from '@cloudflare/workers-types';
import { UserCodeRateLimiter } from '@authrim/ar-lib-core/durable-objects/UserCodeRateLimiter';

export interface RealUserCodeLimiter {
  /** The binding to put in `env.USER_CODE_RATE_LIMITER`. */
  namespace: {
    idFromName: (name: string) => string;
    get: (id: string) => { fetch: (request: Request) => Promise<Response> };
  };
  /** The paths the limiter was called with, in order. */
  calls: string[];
  /** The failures recorded for an IP so far. */
  failuresOf: (ip: string) => number;
}

export function realUserCodeLimiter(): RealUserCodeLimiter {
  const values = new Map<string, unknown>();
  const state = {
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
      setAlarm: async () => {},
    },
  } as unknown as DurableObjectState;
  const limiter = new UserCodeRateLimiter(state, {} as never);
  const calls: string[] = [];
  return {
    namespace: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          calls.push(new URL(request.url).pathname);
          return limiter.fetch(request);
        },
      }),
    },
    calls,
    failuresOf: (ip) => {
      const stored = values.get('state') as
        | { attempts: Array<{ ip: string; failureCount: number }> }
        | undefined;
      return stored?.attempts.find((attempt) => attempt.ip === ip)?.failureCount ?? 0;
    },
  };
}

/** What the limiter answers to a settle of a live reservation, for tests that stub the limiter. */
export function settledAnswer(path: string): Response {
  return Response.json({
    success: true,
    settled: true,
    expired: false,
    outcome: path === '/release' ? 'released' : 'failure',
  });
}

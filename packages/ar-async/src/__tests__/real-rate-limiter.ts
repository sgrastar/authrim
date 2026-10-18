/**
 * The REAL RateLimiterCounter Durable Object over an in-memory storage, as the `RATE_LIMITER`
 * namespace binding: one counter per name, like `idFromName` gives one object per rate limit key.
 * A stub that always allows hides how the keys are built, so tests of the limits use this one.
 */
import type { DurableObjectState } from '@cloudflare/workers-types';
import { RateLimiterCounter } from '@authrim/ar-lib-core/durable-objects/RateLimiterCounter';

export interface RealRateLimiter {
  /** The binding to put in `env.RATE_LIMITER`. */
  namespace: {
    idFromName: (name: string) => string;
    get: (id: string) => {
      incrementRpc: (key: string, config: unknown) => Promise<unknown>;
    };
  };
  /** The names (rate limit keys) the limiter was asked about, in order. */
  names: string[];
}

export function realRateLimiter(): RealRateLimiter {
  const counters = new Map<string, RateLimiterCounter>();
  const names: string[] = [];
  const counterOf = (name: string): RateLimiterCounter => {
    let counter = counters.get(name);
    if (!counter) {
      const values = new Map<string, unknown>();
      const state = {
        storage: {
          get: async (key: string) => structuredClone(values.get(key)),
          put: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
          },
        },
      } as unknown as DurableObjectState;
      counter = new RateLimiterCounter(state, {} as never);
      counters.set(name, counter);
    }
    return counter;
  };
  return {
    namespace: {
      idFromName: (name) => name,
      get: (id) => ({
        incrementRpc: (key, config) => {
          names.push(id);
          return counterOf(id).incrementRpc(key, config as never);
        },
      }),
    },
    names,
  };
}

/**
 * `c.req.raw` and `c.req.header` of a form POST with this body, for tests that hand the handler a
 * hand-made context.
 */
export function formRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    if (value !== undefined) form.append(name, String(value));
  }
  const raw = new Request('https://auth.example.com/device_authorization', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form.toString(),
  });
  return { raw, header: (name: string): string | undefined => raw.headers.get(name) ?? undefined };
}

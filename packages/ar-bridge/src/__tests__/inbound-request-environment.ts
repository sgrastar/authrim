import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

/** The storage/routing seams in these receiver tests are mocked; execute inside a request. */
export async function withRequestEnvironment<T>(run: (env: Env) => Promise<T>): Promise<T> {
  const app = new Hono<{ Bindings: Env }>();
  let outcome: { value: T } | { error: unknown } | undefined;
  app.get('/synthetic', async (c) => {
    try {
      outcome = { value: await run(c.env) };
    } catch (error) {
      outcome = { error };
    }
    return c.text('done');
  });
  await app.request('/synthetic');
  if (!outcome) throw new Error('Synthetic request did not execute');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

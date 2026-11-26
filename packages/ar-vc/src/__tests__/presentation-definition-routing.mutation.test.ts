/** The real worker app routes GET /vp/pd/:id (the target of presentation_definition_uri). */

import type { ExecutionContext } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ storeById: vi.fn(), shard: vi.fn(), limited: [] as string[] }));

// The tenant runtime registry and plugin loading are not under test: the middlewares that
// consult them are bypassed, everything else of the app (routing, rate limit, route) is real.
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getRateLimitProfileAsync: async () => ({}),
  rateLimitMiddleware:
    (config: { endpointClass: string }) => (_c: unknown, next: () => Promise<void>) => {
      h.limited.push(config.endpointClass);
      return next();
    },
  pluginContextMiddleware: () => (_c: unknown, next: () => Promise<void>) => next(),
  requestContextMiddleware:
    () => (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
      c.set('tenantId', 'default');
      return next();
    },
}));
vi.mock('../utils/vp-request-sharding', () => ({ getVPRequestStoreById: h.storeById }));
vi.mock('../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/configured-shard')>()),
  isConfiguredShard: h.shard,
}));

import worker from '../index';

const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;
const env = { ENABLE_RATE_LIMIT: 'false', ISSUER_URL: 'https://verifier.example.com' } as never;
const definition = { id: 'pd-1', input_descriptors: [{ id: 'd' }] };

beforeEach(() => {
  h.limited.length = 0;
  const stub = {
    fetch: vi.fn(async () =>
      Response.json({
        id: 'vp_1',
        status: 'pending',
        expiresAt: Date.now() + 60_000,
        presentationDefinition: definition,
      })
    ),
  };
  h.storeById.mockReset().mockReturnValue({ stub, resolution: { shard: 1 } });
  h.shard.mockReset().mockResolvedValue(true);
});

describe('GET /vp/pd/:id through the worker app', () => {
  it('serves the stored definition uncached', async () => {
    const response = await worker.fetch(
      new Request('https://verifier.example.com/vp/pd/vp_1'),
      env,
      context
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(definition);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // The route sits behind its own rate limit bucket.
    expect(h.limited).toEqual(['vp_presentation_definition']);
    expect(h.storeById).toHaveBeenCalledWith(expect.anything(), 'vp_1', expect.any(String));
  });

  it('answers 404 for a request that is not available', async () => {
    h.storeById.mockReturnValue({
      stub: { fetch: vi.fn(async () => new Response('{}', { status: 404 })) },
      resolution: { shard: 1 },
    });
    const response = await worker.fetch(
      new Request('https://verifier.example.com/vp/pd/vp_1'),
      env,
      context
    );
    expect(response.status).toBe(404);
  });
});

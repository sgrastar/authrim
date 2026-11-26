/**
 * GET /vp/pd/:id: serves the stored presentation definition to a wallet, with the same
 * availability as the request object (pending and unexpired only).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return { logger, storeById: vi.fn(), shard: vi.fn() };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    createErrorResponse: (c: { json: (b: unknown, s: number) => Response }, code: string) =>
      c.json({ code }, code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND ? 404 : 500),
  };
});
vi.mock('../../../utils/vp-request-sharding', () => ({ getVPRequestStoreById: h.storeById }));
vi.mock('../../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/configured-shard')>()),
  isConfiguredShard: h.shard,
}));

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { ShardConfigUnavailableError } from '../../../utils/configured-shard';
import { vpPresentationDefinitionRoute } from '../presentation-definition';

const NOW_MS = 1_800_000_000_000;
const definition = { id: 'pd-1', input_descriptors: [{ id: 'd' }] };
let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>> };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  stub = { fetch: vi.fn(async () => Response.json({})) };
  h.storeById.mockReset().mockReturnValue({ stub, resolution: { shard: 1 } });
  h.shard.mockReset().mockResolvedValue(true);
  h.logger.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

const stored = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    id: 'vp_1',
    status: 'pending',
    expiresAt: NOW_MS + 1000,
    presentationDefinition: definition,
    ...overrides,
  });

async function get(id = 'vp_1') {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/vp/pd/:id', vpPresentationDefinitionRoute);
  const response = await app.request(`https://verifier.example.com/vp/pd/${id}`, {}, {} as Env);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('vpPresentationDefinitionRoute', () => {
  it('returns the stored definition itself, uncached, from the request in this tenant', async () => {
    stub.fetch.mockResolvedValue(stored());
    const result = await get('vp_1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(definition);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect(h.storeById).toHaveBeenCalledWith(expect.anything(), 'vp_1', 'tenant-1');
    expect(stub.fetch.mock.calls[0][0].url).toBe('https://internal/get?id=vp_1&tenant_id=tenant-1');
  });

  it.each([
    ['not pending', { status: 'verified' }],
    ['expired at the exact instant', { expiresAt: NOW_MS }],
    ['expired', { expiresAt: NOW_MS - 1 }],
    ['without a definition (DCQL request)', { presentationDefinition: undefined }],
  ])('answers not found for a request that is %s', async (_name, overrides) => {
    stub.fetch.mockResolvedValue(stored(overrides));
    expect(await get()).toMatchObject({
      status: 404,
      body: { code: AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND },
    });
  });

  it('answers not found for an unknown request or a shard this tenant does not use', async () => {
    stub.fetch.mockResolvedValue(new Response('no', { status: 404 }));
    expect((await get()).status).toBe(404);
    h.shard.mockResolvedValue(false);
    stub.fetch.mockClear();
    expect((await get()).status).toBe(404);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('answers an internal error, not not-found, when the store answers 500', async () => {
    stub.fetch.mockResolvedValue(new Response('boom', { status: 500 }));
    expect(await get()).toMatchObject({
      status: 500,
      body: { code: AR_ERROR_CODES.INTERNAL_ERROR },
    });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('answers an internal error, not not-found, when the lookup throws', async () => {
    stub.fetch.mockRejectedValue(new Error('boom'));
    expect(await get()).toMatchObject({
      status: 500,
      body: { code: AR_ERROR_CODES.INTERNAL_ERROR },
    });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('answers an internal error when the shard configuration is unavailable', async () => {
    h.shard.mockRejectedValue(new ShardConfigUnavailableError('unavailable'));
    expect(await get()).toMatchObject({
      status: 500,
      body: { code: AR_ERROR_CODES.INTERNAL_ERROR },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

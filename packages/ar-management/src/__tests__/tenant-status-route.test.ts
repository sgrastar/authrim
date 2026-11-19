import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { rateLimitConfigs } = vi.hoisted(() => ({
  rateLimitConfigs: [] as Array<Record<string, unknown>>,
}));

// The limiter itself needs its storage; here it only records what it was asked to enforce.
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getRateLimitProfileAsync: async () => ({ maxRequests: 60, windowSeconds: 60 }),
    rateLimitMiddleware: (config: Record<string, unknown>) => {
      rateLimitConfigs.push(config);
      return async (_c: unknown, next: () => Promise<void>) => next();
    },
  };
});

import worker from '../index';
import { TENANT_STATUS_PATH } from '../tenant-status';

function database(lifecycle: string) {
  const first = vi.fn(async () => ({ lifecycle_state: lifecycle }));
  const bind = vi.fn(() => ({ first }));
  return { db: { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database, bind };
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe('GET /api/auth/tenant-status on the management worker', () => {
  beforeEach(() => {
    rateLimitConfigs.length = 0;
  });

  it('answers on the host of a tenant that no longer resolves', async () => {
    const { db, bind } = database('deleted');
    const response = await worker.fetch(
      new Request(`https://gone.example.com${TENANT_STATUS_PATH}`, {
        headers: { Host: 'gone.example.com' },
      }),
      { BASE_DOMAIN: 'example.com', DB: db } as unknown as Env,
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'deleted',
      host: 'gone.example.com',
    });
    expect(bind).toHaveBeenCalledWith('gone');
  });

  // What the limiter does with this is the limiter's own tests; its failure is in tenant-status.test.ts.
  it('asks for a public-read limit keyed by client alone', async () => {
    await worker.fetch(
      new Request(`https://gone.example.com${TENANT_STATUS_PATH}`, {
        headers: { Host: 'gone.example.com' },
      }),
      { BASE_DOMAIN: 'example.com', DB: database('active').db } as unknown as Env,
      context
    );

    expect(rateLimitConfigs).toHaveLength(1);
    expect(rateLimitConfigs[0]).toMatchObject({
      keyScope: 'global',
      endpointClass: 'publicRead',
      endpoints: [TENANT_STATUS_PATH],
    });
  });

  it('does not answer other methods', async () => {
    const { db, bind } = database('deleted');
    const response = await worker.fetch(
      new Request(`https://gone.example.com${TENANT_STATUS_PATH}`, {
        method: 'POST',
        headers: { Host: 'gone.example.com' },
      }),
      { BASE_DOMAIN: 'example.com', DB: db } as unknown as Env,
      context
    );

    expect(response.status).not.toBe(200);
    expect(bind).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { updateRegionShards } from '../routes/settings/region-shards';

function context(options: { body?: unknown; parameter?: string; useAuthrimConfig?: boolean }) {
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => values.set(key, value)),
    delete: vi.fn(async (key: string) => values.delete(key)),
  };
  return {
    context: {
      env: options.useAuthrimConfig ? { AUTHRIM_CONFIG: kv } : { SETTINGS: kv },
      req: {
        json: vi.fn().mockResolvedValue(options.body),
        param: vi.fn().mockReturnValue(options.parameter),
      },
      get: vi.fn().mockReturnValue(undefined),
      json: vi.fn((payload: unknown, status = 200) => ({ payload, status })),
    } as unknown as Context<{ Bindings: Env }>,
    kv,
    values,
  };
}

describe('region numeric settings', () => {
  it('rejects fractional region shard counts before tenant/config resolution', async () => {
    const { context: c, kv } = context({
      body: { totalShards: 1.5, regionDistribution: { wnam: 100 } },
      useAuthrimConfig: true,
    });

    const response = await updateRegionShards(c);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('rejects region shard counts that are not a multiple of active regions', async () => {
    const { context: c, kv } = context({
      body: { totalShards: 4, regionDistribution: { apac: 33, enam: 33, weur: 34 } },
      useAuthrimConfig: true,
    });

    const response = await updateRegionShards(c);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

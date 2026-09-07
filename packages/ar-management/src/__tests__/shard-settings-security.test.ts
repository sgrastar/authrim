import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getSessionShards, updateSessionShards } from '../routes/settings/session-shards';
import { updateRevocationShards } from '../routes/settings/revocation-shards';

function contextFor(options: {
  kv?: Map<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const kv = options.kv;
  const binding = kv
    ? {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => kv.set(key, value)),
        delete: vi.fn(async (key: string) => kv.delete(key)),
      }
    : undefined;
  return {
    env: { AUTHRIM_CONFIG: binding, ...options.env },
    req: { json: vi.fn().mockResolvedValue(options.body ?? {}) },
    json: vi.fn((payload: unknown, status = 200) => ({ payload, status })),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('session shard settings validation', () => {
  it('ignores corrupted KV and falls back to a valid environment value', async () => {
    const context = contextFor({
      kv: new Map([['session_shards', 'not-a-number']]),
      env: { AUTHRIM_SESSION_SHARDS: '32' },
    });

    await expect(getSessionShards(context)).resolves.toMatchObject({
      status: 200,
      payload: { current: 32, source: 'env', kv_value: null, env_value: 32 },
    });
  });

  it.each(['0', '257', '1.5', '-2', ' 16 '])(
    'does not use invalid environment shard count %s',
    async (value) => {
      const context = contextFor({ env: { AUTHRIM_SESSION_SHARDS: value } });
      const result = (await getSessionShards(context)) as unknown as {
        payload: { current: number; source: string; default_value: number };
      };
      expect(result.payload.current).toBe(result.payload.default_value);
      expect(result.payload.source).toBe('default');
    }
  );

  it('persists only integer shard counts in the supported range', async () => {
    const kv = new Map<string, string>();
    const valid = contextFor({ kv, body: { shards: 64 } });
    await expect(updateSessionShards(valid)).resolves.toMatchObject({
      status: 200,
      payload: { success: true, shards: 64 },
    });
    expect(kv.get('session_shards')).toBe('64');

    const invalid = contextFor({ kv, body: { shards: 1.5 } });
    const before = new Map(kv);
    const result = await updateSessionShards(invalid);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(kv).toEqual(before);
  });
});

describe('revocation shard settings validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([1.5, 0, 257, '16'])(
    'rejects invalid shard count %s without any KV write',
    async (shards) => {
      const kv = new Map<string, string>();
      const context = contextFor({ kv, body: { shards } });

      await expect(updateRevocationShards(context)).resolves.toMatchObject({
        status: 400,
        payload: {
          error: 'invalid_shard_count',
          error_description: 'Shard count must be an integer between 1 and 256',
        },
      });
      expect(kv.size).toBe(0);
    }
  );
});

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { isReplayJtiRecorded, recordReplayJti } from '../jti-replay-guard';

/** The tenant's residency jurisdiction, as its region shard configuration gives it. */
let residency: { jurisdiction: 'eu' | null } | undefined;
vi.mock('../region-sharding', () => ({
  getRegionShardConfig: vi.fn(async () => ({ residency })),
}));

/** The DPoPJTIStore's check and check-and-store, in memory. */
const recorded = new Map<string, number>();
let failWith: number | null = null;
let invalidRequest = false;
const fetch = vi.fn(async (url: string, init: RequestInit) => {
  if (failWith !== null) return new Response('{}', { status: failWith });
  if (invalidRequest) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const body = JSON.parse(init.body as string) as { jti: string; ttl?: number };
  const path = new URL(url).pathname;
  if (path === '/check') {
    return Response.json({ exists: recorded.has(body.jti) });
  }
  if (recorded.has(body.jti)) {
    return Response.json({ error: 'replay_detected' }, { status: 400 });
  }
  recorded.set(body.jti, body.ttl ?? 0);
  return Response.json({ success: true }, { status: 201 });
});

const instances: string[] = [];
const namespace = (prefix: string) => ({
  idFromName: (name: string) => `${prefix}${name}`,
  get: (id: string) => {
    instances.push(id);
    return { fetch };
  },
});
const env = {
  DPOP_JTI_STORE: {
    ...namespace(''),
    jurisdiction: (name: string) => namespace(`${name}/`),
  },
} as unknown as Env;
const runtimeKey = (key: string) => `sha256:${createHash('sha256').update(key).digest('hex')}`;
const input = { tenantId: 'default', shardKey: 'client-a', jti: 'native-sso-id-token:abc' };

describe('jti replay guard', () => {
  beforeEach(() => {
    recorded.clear();
    failWith = null;
    invalidRequest = false;
    instances.length = 0;
    residency = undefined;
    fetch.mockClear();
  });

  it('records a jti once and reports the second presentation as a replay', async () => {
    expect(await isReplayJtiRecorded(env, input)).toBe(false);
    expect(await recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 })).toBe('recorded');
    expect(await isReplayJtiRecorded(env, input)).toBe(true);
    expect(await recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 })).toBe('replayed');
  });

  it('lets only one of concurrent presentations record the jti', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 })
      )
    );
    expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1);
  });

  it('sends every field the store requires, with a whole positive TTL', async () => {
    await recordReplayJti(env, { ...input, issuedAt: 1700000000, ttlSeconds: 0.2 });
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
      jti: input.jti,
      client_id: 'client-a',
      iat: 1700000000,
      ttl: 1,
    });
  });

  it('throws when the store cannot answer, never treating it as a first use', async () => {
    failWith = 500;
    await expect(isReplayJtiRecorded(env, input)).rejects.toThrow(
      'jti_replay_store_unavailable:500'
    );
    await expect(recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 })).rejects.toThrow(
      'jti_replay_store_unavailable:500'
    );
  });

  it('does not take a refused request for a replay', async () => {
    invalidRequest = true;
    await expect(recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 })).rejects.toThrow(
      'jti_replay_store_unavailable:400'
    );
  });

  it('reaches one fixed instance per shard key, whatever the region shard configuration', async () => {
    await recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 });
    await isReplayJtiRecorded(env, input);
    await isReplayJtiRecorded(env, { ...input, shardKey: 'another-key' });

    expect(instances[0]).toMatch(/^tenant:default:jti-replay:\d+$/);
    expect(instances[1]).toBe(instances[0]);
    expect(Number(instances[0].split(':').at(-1))).toBeLessThan(32);
  });

  it('keeps the records of a tenant with a residency jurisdiction inside it', async () => {
    residency = { jurisdiction: 'eu' };
    await recordReplayJti(env, { ...input, issuedAt: 1, ttlSeconds: 120 });

    expect(instances[0]).toMatch(/^eu\/tenant:default:jti-replay:\d+$/);
  });
  it('uses the runtime store outside Cloudflare, never a Durable Object', async () => {
    const replayGuard = {
      record: vi.fn(async () => 'replayed' as const),
      isRecorded: vi.fn(async () => true),
    };
    const runtimeEnv = { AUTH_RUNTIME_PORTS: { replayGuard } } as unknown as Env;

    expect(await isReplayJtiRecorded(runtimeEnv, input)).toBe(true);
    expect(await recordReplayJti(runtimeEnv, { ...input, issuedAt: 1, ttlSeconds: 359.2 })).toBe(
      'replayed'
    );
    expect(replayGuard.isRecorded).toHaveBeenCalledWith({
      tenantId: 'default',
      key: runtimeKey(input.jti),
    });
    expect(replayGuard.record).toHaveBeenCalledWith({
      tenantId: 'default',
      key: runtimeKey(input.jti),
      ttlSeconds: 360,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws when a runtime has ports but no replay store', async () => {
    const runtimeEnv = { AUTH_RUNTIME_PORTS: {} } as unknown as Env;

    await expect(isReplayJtiRecorded(runtimeEnv, input)).rejects.toThrow(
      'auth_runtime_replay_guard_unavailable'
    );
    await expect(
      recordReplayJti(runtimeEnv, { ...input, issuedAt: 1, ttlSeconds: 60 })
    ).rejects.toThrow('auth_runtime_replay_guard_unavailable');
  });
});

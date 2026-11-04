import { describe, expect, it } from 'vitest';
import { KV_MIN_TTL_SECONDS, kvTtlSeconds } from '../kv-ttl';

describe('kvTtlSeconds', () => {
  it.each([
    [30, KV_MIN_TTL_SECONDS],
    [0, KV_MIN_TTL_SECONDS],
    [-5, KV_MIN_TTL_SECONDS],
    [59.1, KV_MIN_TTL_SECONDS],
    [60, 60],
    [60.2, 61],
    [3600, 3600],
    [Number.NaN, KV_MIN_TTL_SECONDS],
    [Number.POSITIVE_INFINITY, KV_MIN_TTL_SECONDS],
  ])('turns %s seconds into a TTL KV accepts (%s)', (seconds, expected) => {
    expect(kvTtlSeconds(seconds)).toBe(expected);
  });
});

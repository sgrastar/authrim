import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { getChallengeStoreForLease } from '../challenge-sharding';

function env(shards: string | null) {
  const idFromName = vi.fn((name: string) => ({ name }));
  return {
    env: {
      CHALLENGE_STORE: { idFromName, get: vi.fn((id: unknown) => id) },
      AUTHRIM_CONFIG: { get: vi.fn(async () => shards) },
    } as unknown as Env,
    idFromName,
  };
}

describe('getChallengeStoreForLease', () => {
  it('places a lease by its key alone, whatever the challenge shard count', () => {
    const four = env('4');
    const eight = env('8');

    getChallengeStoreForLease(four.env, 'login-method-removal:user-1', 'tenant-a');
    getChallengeStoreForLease(eight.env, 'login-method-removal:user-1', 'tenant-a');

    const name = four.idFromName.mock.calls[0][0];
    expect(name).toMatch(/^tenant:tenant-a:challenge:lease-\d+$/);
    expect(eight.idFromName.mock.calls[0][0]).toBe(name);
  });

  it('keeps tenants apart', () => {
    const { env: e, idFromName } = env(null);

    getChallengeStoreForLease(e, 'login-method-removal:user-1', 'tenant-a');
    getChallengeStoreForLease(e, 'login-method-removal:user-1', 'tenant-b');

    expect(idFromName.mock.calls[0][0]).not.toBe(idFromName.mock.calls[1][0]);
  });
});

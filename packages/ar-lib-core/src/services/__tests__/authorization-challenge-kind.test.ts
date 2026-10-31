import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';

const { getChallengeRpc } = vi.hoisted(() => ({ getChallengeRpc: vi.fn() }));

vi.mock('../../utils/challenge-sharding', () => ({
  getChallengeStoreByChallengeId: vi.fn(async () => ({ getChallengeRpc })),
}));

import { readAuthorizationChallengeKind } from '../authorization-challenge-kind';

describe('readAuthorizationChallengeKind', () => {
  it.each([
    [{ tenantId: 't', type: 'reauth' }, 'reauth'],
    [{ tenantId: 't', type: 'login' }, 'login'],
    // Another tenant's challenge, another kind, none, or an unreadable store name no challenge.
    [{ tenantId: 'other', type: 'reauth' }, null],
    [{ tenantId: 't', type: 'direct_auth_code' }, null],
    [null, null],
  ])('reads %j as %s', async (challenge, expected) => {
    getChallengeRpc.mockResolvedValueOnce(challenge);
    await expect(readAuthorizationChallengeKind({} as Env, 't', 'c')).resolves.toBe(expected);
  });

  it('names no challenge when the store cannot be read', async () => {
    getChallengeRpc.mockRejectedValueOnce(new Error('unavailable'));
    await expect(readAuthorizationChallengeKind({} as Env, 't', 'c')).resolves.toBeNull();
  });
});

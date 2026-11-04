import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Challenge, Env } from '@authrim/ar-lib-core';

const { mockGetChallengeStoreByChallengeId } = vi.hoisted(() => ({
  mockGetChallengeStoreByChallengeId: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: mockGetChallengeStoreByChallengeId,
  };
});

import { issueApprovalOtpChallenge, verifyApprovalOtpChallenge } from '../approval-otp';

function createMockEnv() {
  let challenge: Challenge | null = null;

  const challengeStore = {
    storeChallengeRpc: vi.fn(
      async (request: {
        id: string;
        tenantId: string;
        type: Challenge['type'];
        userId: string;
        challenge: string;
        ttl: number;
        email?: string;
        metadata?: Record<string, unknown>;
      }) => {
        challenge = {
          id: request.id,
          tenantId: request.tenantId,
          type: request.type,
          userId: request.userId,
          challenge: request.challenge,
          email: request.email,
          metadata: request.metadata,
          createdAt: Date.now(),
          expiresAt: Date.now() + request.ttl * 1000,
          consumed: false,
        };
        return { success: true };
      }
    ),
    getChallengeRpc: vi.fn(async () => challenge),
    consumeChallengeRpc: vi.fn(
      async (request: {
        id: string;
        tenantId: string;
        type: Challenge['type'];
        challenge?: string;
      }) => {
        if (
          !challenge ||
          challenge.id !== request.id ||
          challenge.type !== request.type ||
          challenge.consumed
        ) {
          throw new Error('Challenge not found or already consumed');
        }
        if (challenge.tenantId !== request.tenantId) {
          throw new Error('Challenge tenant mismatch');
        }
        if (request.challenge && request.challenge !== challenge.challenge) {
          throw new Error('Challenge value mismatch');
        }
        challenge = {
          ...challenge,
          consumed: true,
        };
        return {
          challenge: challenge.challenge,
          userId: challenge.userId,
          email: challenge.email,
          metadata: challenge.metadata,
        };
      }
    ),
  };

  mockGetChallengeStoreByChallengeId.mockResolvedValue(challengeStore);

  // The RATE_LIMITER Durable Object: an atomic count per key.
  const counts = new Map<string, number>();
  const limiter = {
    failing: false,
    incrementRpc: vi.fn(async (key: string, config: { maxRequests: number }) => {
      if (limiter.failing) throw new Error('limiter unavailable');
      const current = (counts.get(key) ?? 0) + 1;
      counts.set(key, current);
      return {
        allowed: current <= config.maxRequests,
        current,
        limit: config.maxRequests,
        resetAt: 0,
        retryAfter: 0,
      };
    }),
  };

  const env = {
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => limiter,
    },
    OTP_HMAC_SECRET: 'approval-otp-secret',
    ISSUER_URL: 'https://issuer.example.com',
  } as unknown as Env;

  return {
    env,
    limiter,
    challengeStore,
    getChallenge: () => challenge,
  };
}

describe('approval otp challenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not consume the OTP after a single invalid attempt', async () => {
    const { env, challengeStore, getChallenge } = createMockEnv();
    const issued = await issueApprovalOtpChallenge(env, {
      tenantId: 'tenant-a',
      artifactId: 'apc_1',
      method: 'email_otp',
      target: 'person@example.com',
      approverSubjectId: 'customer-1',
    });

    await expect(
      verifyApprovalOtpChallenge(env, {
        tenantId: 'tenant-a',
        artifactId: 'apc_1',
        code: '000000',
        target: 'person@example.com',
      })
    ).rejects.toThrow('Invalid approval OTP code');

    expect(challengeStore.getChallengeRpc).toHaveBeenCalled();
    expect(challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(getChallenge()?.consumed).toBe(false);

    const verification = await verifyApprovalOtpChallenge(env, {
      tenantId: 'tenant-a',
      artifactId: 'apc_1',
      code: issued.code,
      target: 'person@example.com',
    });

    expect(verification.verifiedAt).toEqual(expect.any(Number));
    expect(challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(getChallenge()?.consumed).toBe(true);
  });

  it('consumes the OTP after too many invalid attempts', async () => {
    const { env, challengeStore, getChallenge } = createMockEnv();
    await issueApprovalOtpChallenge(env, {
      tenantId: 'tenant-a',
      artifactId: 'apc_2',
      method: 'sms_otp',
      target: '+819012345678',
      approverSubjectId: 'customer-2',
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        verifyApprovalOtpChallenge(env, {
          tenantId: 'tenant-a',
          artifactId: 'apc_2',
          code: '111111',
          target: '+819012345678',
        })
      ).rejects.toThrow('Invalid approval OTP code');
    }

    expect(challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(getChallenge()?.consumed).toBe(true);
  });

  it('refuses even the right code when the attempt cannot be counted', async () => {
    const { env, limiter, getChallenge } = createMockEnv();
    const issued = await issueApprovalOtpChallenge(env, {
      tenantId: 'tenant-a',
      artifactId: 'apc_3',
      method: 'email_otp',
      target: 'person@example.com',
      approverSubjectId: 'customer-3',
    });
    limiter.failing = true;

    await expect(
      verifyApprovalOtpChallenge(env, {
        tenantId: 'tenant-a',
        artifactId: 'apc_3',
        code: issued.code,
        target: 'person@example.com',
      })
    ).rejects.toThrow('limiter unavailable');
    expect(getChallenge()?.consumed).toBe(false);
  });

  it('counts parallel guesses, so they cannot exceed the attempts allowed', async () => {
    const { env, challengeStore, getChallenge } = createMockEnv();
    const issued = await issueApprovalOtpChallenge(env, {
      tenantId: 'tenant-a',
      artifactId: 'apc_4',
      method: 'email_otp',
      target: 'person@example.com',
      approverSubjectId: 'customer-4',
    });

    const guesses = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        verifyApprovalOtpChallenge(env, {
          tenantId: 'tenant-a',
          artifactId: 'apc_4',
          code: '000000',
          target: 'person@example.com',
        })
      )
    );
    expect(guesses.every((guess) => guess.status === 'rejected')).toBe(true);
    expect(getChallenge()?.consumed).toBe(true);
    expect(challengeStore.consumeChallengeRpc).toHaveBeenCalled();

    await expect(
      verifyApprovalOtpChallenge(env, {
        tenantId: 'tenant-a',
        artifactId: 'apc_4',
        code: issued.code,
        target: 'person@example.com',
      })
    ).rejects.toThrow('Invalid approval OTP challenge');
  });
});

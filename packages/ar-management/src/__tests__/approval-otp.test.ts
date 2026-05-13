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
  const kvStore = new Map<string, string>();
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

  const env = {
    AUTHRIM_CONFIG: {
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
    },
    OTP_HMAC_SECRET: 'approval-otp-secret',
    ISSUER_URL: 'https://issuer.example.com',
  } as unknown as Env;

  return {
    env,
    kvStore,
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
});

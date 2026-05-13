import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import type {
  Challenge,
  ConsumeChallengeRequest,
  StoreChallengeRequest,
} from '../../durable-objects/ChallengeStore';
import {
  completeStepUpAction,
  consumeStepUpReceipt,
  issueStepUpToken,
  resendStepUpAction,
  resolveStepUpPolicy,
  startStepUpAction,
  StepUpFlowError,
  StepUpPolicyError,
} from '../step-up';

class InMemoryChallengeStore {
  readonly challenges = new Map<string, Challenge>();

  async storeChallengeRpc(request: StoreChallengeRequest): Promise<{ success: boolean }> {
    const now = Date.now();
    this.challenges.set(request.id, {
      id: request.id,
      tenantId: request.tenantId,
      type: request.type,
      userId: request.userId,
      challenge: request.challenge,
      email: request.email,
      redirectUri: request.redirectUri,
      metadata: request.metadata,
      createdAt: now,
      expiresAt: now + request.ttl * 1000,
      consumed: false,
    });
    return { success: true };
  }

  async getChallengeRpc(id: string): Promise<Challenge | null> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      return null;
    }
    return challenge;
  }

  async consumeChallengeRpc(request: ConsumeChallengeRequest) {
    const challenge = await this.getChallengeRpc(request.id);
    if (!challenge || challenge.consumed) {
      throw new Error('Challenge not found or already consumed');
    }
    if (challenge.type !== request.type) {
      throw new Error('Challenge type mismatch');
    }
    if (challenge.tenantId !== request.tenantId) {
      throw new Error('Challenge tenant mismatch');
    }
    if (request.challenge && challenge.challenge !== request.challenge) {
      throw new Error('Challenge value mismatch');
    }
    challenge.consumed = true;
    this.challenges.set(request.id, challenge);
    return {
      challenge: challenge.challenge,
      userId: challenge.userId,
      email: challenge.email,
      redirectUri: challenge.redirectUri,
      metadata: challenge.metadata,
    };
  }

  async deleteChallengeRpc(id: string): Promise<{ deleted: boolean }> {
    const deleted = this.challenges.delete(id);
    return { deleted };
  }
}

function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(data));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: Array.from(store.keys())
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
    }),
  } as unknown as KVNamespace;
}

function createEnv(settings: Record<string, string> = {}) {
  const challengeStore = new InMemoryChallengeStore();
  const env = {
    DEFAULT_TENANT_ID: 'default',
    AUTHRIM_CONFIG: createMockKV(settings),
    SETTINGS: createMockKV(),
    CHALLENGE_STORE: {
      idFromName: (name: string) => name,
      get: () => challengeStore,
    },
  } as unknown as Env;
  return { env, challengeStore };
}

describe('Step-Up service', () => {
  beforeEach(() => {
    // Challenge IDs are sharded through a cached helper; use a default shard count in every test.
  });

  it('resolves default and tenant-overridden policy values', async () => {
    const { env } = createEnv({
      'settings:tenant:tenant-a:step-up': JSON.stringify({
        step_up_attempt_limit: 2,
        step_up_resend_cooldown_seconds: 30,
      }),
    });

    const policy = await resolveStepUpPolicy(env, 'tenant-a');

    expect(policy).toMatchObject({
      stepUpTokenTtlSeconds: 300,
      stepUpActionTtlSeconds: 600,
      stepUpReceiptTtlSeconds: 300,
      stepUpAttemptLimit: 2,
      stepUpResendCooldownSeconds: 30,
      stepUpMaxResends: 3,
    });
  });

  it('rejects non-positive tenant policy values', async () => {
    const { env } = createEnv({
      'settings:tenant:tenant-a:step-up': JSON.stringify({
        step_up_token_ttl_seconds: 0,
      }),
    });

    await expect(resolveStepUpPolicy(env, 'tenant-a')).rejects.toBeInstanceOf(StepUpPolicyError);
  });

  it('starts and reuses a pending action for the same actor, subject, and operation', async () => {
    const { env } = createEnv();
    const requirement = await issueStepUpToken(env, {
      tenantId: 'tenant-a',
      actorId: 'actor-1',
      subjectId: 'user-1',
      operationHash: 'op-hash-1',
      idempotencyKey: 'idem-1',
      acceptableMethods: { methods: ['portal_confirm'] },
    });

    const first = await startStepUpAction(env, {
      stepUpToken: requirement.step_up_token,
      tenantId: 'tenant-a',
      preferredMethod: { method: 'portal_confirm' },
    });
    const second = await startStepUpAction(env, {
      stepUpToken: requirement.step_up_token,
      tenantId: 'tenant-a',
      preferredMethod: { method: 'portal_confirm' },
    });

    expect(first.action_id).toMatch(/^sua_/);
    expect(first.next_action).toMatchObject({
      type: 'confirmation',
      method: 'portal_confirm',
      category: 'confirmation',
    });
    expect(second.action_id).toBe(first.action_id);
  });

  it('returns preferred_method_unavailable when a syntactically valid method is outside policy', async () => {
    const { env } = createEnv();
    const requirement = await issueStepUpToken(env, {
      tenantId: 'tenant-a',
      actorId: 'actor-1',
      subjectId: 'user-1',
      operationHash: 'op-hash-1',
      acceptableMethods: { methods: ['portal_confirm'] },
    });

    await expect(
      startStepUpAction(env, {
        stepUpToken: requirement.step_up_token,
        tenantId: 'tenant-a',
        preferredMethod: { method: 'email_otp' },
      })
    ).rejects.toMatchObject({
      error: 'preferred_method_unavailable',
      detailCode: 'preferred_method_unavailable',
      httpStatus: 403,
      stepUp: expect.objectContaining({
        step_up_token: requirement.step_up_token,
      }),
    });
  });

  it('issues a single-use receipt after successful completion', async () => {
    const { env } = createEnv();
    const binding = {
      tenantId: 'tenant-a',
      actorId: 'actor-1',
      subjectId: 'user-1',
      operationHash: 'op-hash-1',
      idempotencyKey: 'idem-1',
    };
    const requirement = await issueStepUpToken(env, {
      ...binding,
      acceptableMethods: { methods: ['portal_confirm'] },
    });
    const action = await startStepUpAction(env, {
      stepUpToken: requirement.step_up_token,
      tenantId: 'tenant-a',
    });

    const completed = await completeStepUpAction(env, {
      actionId: action.action_id,
      tenantId: 'tenant-a',
      method: 'portal_confirm',
      input: { confirmed: true },
    });

    expect(completed.next_action).toBeUndefined();
    expect(completed.step_up_receipt).toMatch(/^sur_/);
    await expect(
      consumeStepUpReceipt(env, {
        ...binding,
        receipt: completed.step_up_receipt!,
      })
    ).resolves.toMatchObject({
      action_id: action.action_id,
      method: 'portal_confirm',
    });
    await expect(
      consumeStepUpReceipt(env, {
        ...binding,
        receipt: completed.step_up_receipt!,
      })
    ).rejects.toMatchObject({
      error: 'step_up_required',
      detailCode: 'step_up_required',
    });
  });

  it('tracks invalid input attempts and returns retryable machine-readable state', async () => {
    const { env } = createEnv({
      'settings:tenant:tenant-a:step-up': JSON.stringify({
        step_up_attempt_limit: 2,
      }),
    });
    const requirement = await issueStepUpToken(env, {
      tenantId: 'tenant-a',
      actorId: 'actor-1',
      subjectId: 'user-1',
      operationHash: 'op-hash-1',
      acceptableMethods: { methods: ['portal_confirm'] },
    });
    const action = await startStepUpAction(env, {
      stepUpToken: requirement.step_up_token,
      tenantId: 'tenant-a',
    });

    await expect(
      completeStepUpAction(env, {
        actionId: action.action_id,
        tenantId: 'tenant-a',
        method: 'portal_confirm',
        input: { confirmed: false },
      })
    ).rejects.toMatchObject({
      error: 'invalid_step_up_input',
      detailCode: 'invalid_step_up_input',
      inputState: expect.objectContaining({
        field: 'confirmed',
        attempts_remaining: 1,
        max_attempts: 2,
      }),
    });
  });

  it('enforces resend cooldown with Retry-After metadata', async () => {
    const { env } = createEnv({
      'settings:tenant:tenant-a:step-up': JSON.stringify({
        step_up_resend_cooldown_seconds: 60,
      }),
    });
    const requirement = await issueStepUpToken(env, {
      tenantId: 'tenant-a',
      actorId: 'actor-1',
      subjectId: 'user-1',
      operationHash: 'op-hash-1',
      acceptableMethods: { methods: ['email_otp'] },
    });
    const action = await startStepUpAction(env, {
      stepUpToken: requirement.step_up_token,
      tenantId: 'tenant-a',
      preferredMethod: { method: 'email_otp' },
    });

    await resendStepUpAction(env, { actionId: action.action_id, tenantId: 'tenant-a' });
    await expect(
      resendStepUpAction(env, { actionId: action.action_id, tenantId: 'tenant-a' })
    ).rejects.toMatchObject({
      error: 'resend_limit_exceeded',
      detailCode: 'resend_limit_exceeded',
      httpStatus: 429,
      retryAfterSeconds: expect.any(Number),
    });
  });
});

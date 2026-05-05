import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type {
  Challenge,
  ConsumeChallengeRequest,
  Env,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core';
import {
  consumeStepUpReceipt,
  issueStepUpToken,
} from '@authrim/ar-lib-core';
import { stepUpRouter } from '../routes/step-up';

class InMemoryChallengeStore {
  readonly challenges = new Map<string, Challenge>();

  async storeChallengeRpc(request: StoreChallengeRequest): Promise<{ success: boolean }> {
    const now = Date.now();
    this.challenges.set(request.id, {
      id: request.id,
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

function createIdempotencyD1(): D1Database {
  const entries = new Map<string, Record<string, unknown>>();
  return {
    prepare: (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind: (...bound: unknown[]) => {
          params = bound;
          return statement;
        },
        first: async () => {
          if (sql.includes('FROM idempotency_keys')) {
            const id = String(params[0]);
            const now = Number(params[1]);
            const entry = entries.get(id);
            if (entry && Number(entry.expires_at) > now) {
              return entry;
            }
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.trim().startsWith('UPDATE idempotency_keys')) {
            const id = String(params[3]);
            const entry = entries.get(id);
            if (!entry) {
              return { success: true, meta: { changes: 0 } };
            }
            entries.set(id, {
              ...entry,
              response_status: params[0],
              response_body: params[1],
              expires_at: params[2],
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.trim().startsWith('INSERT INTO idempotency_keys')) {
            const id = String(params[0]);
            if (entries.has(id)) {
              throw new Error('UNIQUE constraint failed: idempotency_keys.id');
            }
            entries.set(id, {
              id: params[0],
              tenant_id: params[1],
              actor_id: params[2],
              method: params[3],
              path: params[4],
              resource_id: params[5],
              idempotency_key: params[6],
              body_hash: params[7],
              response_status: params[8],
              response_body: params[9],
              created_at: params[10],
              expires_at: params[11],
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
    batch: async () => [],
  } as unknown as D1Database;
}

function createEnv(settings: Record<string, string> = {}) {
  const challengeStore = new InMemoryChallengeStore();
  const env = {
    DEFAULT_TENANT_ID: 'default',
    DB: createIdempotencyD1(),
    AUTHRIM_CONFIG: createMockKV(settings),
    SETTINGS: createMockKV(),
    CHALLENGE_STORE: {
      idFromName: (name: string) => name,
      get: () => challengeStore,
    },
  } as unknown as Env;
  return { env, challengeStore };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/auth/step-up', stepUpRouter);
  return app;
}

const binding = {
  tenantId: 'tenant-a',
  actorId: 'actor-1',
  subjectId: 'user-1',
  operationHash: 'op-hash-1',
  idempotencyKey: 'delegated-write-key-1',
};

describe('/auth/step-up router', () => {
  it('rejects an empty preferred_method shape with no-store headers', async () => {
    const { env } = createEnv();
    const requirement = await issueStepUpToken(env, {
      ...binding,
      acceptableMethods: { methods: ['portal_confirm'] },
    });

    const response = await createApp().request(
      '/auth/step-up/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step_up_token: requirement.step_up_token,
          preferred_method: {},
        }),
      },
      env
    );
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload).toMatchObject({
      error: 'invalid_request',
      error_description: 'preferred_method must include category or method',
    });
  });

  it('returns preferred_method_unavailable with the latest step_up object', async () => {
    const { env } = createEnv();
    const requirement = await issueStepUpToken(env, {
      ...binding,
      acceptableMethods: { methods: ['portal_confirm'] },
    });

    const response = await createApp().request(
      '/auth/step-up/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step_up_token: requirement.step_up_token,
          preferred_method: { method: 'email_otp' },
        }),
      },
      env
    );
    const payload = await response.json() as {
      error: string;
      error_details?: { code?: string };
      step_up?: { step_up_token?: string };
    };

    expect(response.status).toBe(403);
    expect(payload.error).toBe('preferred_method_unavailable');
    expect(payload.error_details?.code).toBe('preferred_method_unavailable');
    expect(payload.step_up?.step_up_token).toBe(requirement.step_up_token);
    expect('error_uri' in payload).toBe(false);
  });

  it('requires Idempotency-Key on complete', async () => {
    const { env } = createEnv();
    const requirement = await issueStepUpToken(env, {
      ...binding,
      acceptableMethods: { methods: ['portal_confirm'] },
    });
    const start = await createApp().request(
      '/auth/step-up/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_up_token: requirement.step_up_token }),
      },
      env
    );
    const startPayload = await start.json() as { action_id: string };

    const response = await createApp().request(
      `/auth/step-up/actions/${startPayload.action_id}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'portal_confirm',
          input: { confirmed: true },
        }),
      },
      env
    );
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload.error).toBe('invalid_request');
    expect(payload.error_description).toBe('Idempotency-Key header is required');
  });

  it('returns a single-use receipt after successful completion', async () => {
    const { env } = createEnv();
    const requirement = await issueStepUpToken(env, {
      ...binding,
      acceptableMethods: { methods: ['portal_confirm'] },
    });
    const start = await createApp().request(
      '/auth/step-up/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_up_token: requirement.step_up_token }),
      },
      env
    );
    const startPayload = await start.json() as { action_id: string };

    const response = await createApp().request(
      `/auth/step-up/actions/${startPayload.action_id}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'complete-key-1',
        },
        body: JSON.stringify({
          method: 'portal_confirm',
          input: { confirmed: true },
        }),
      },
      env
    );
    const payload = await response.json() as {
      step_up_receipt?: string;
      next_action?: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.step_up_receipt).toMatch(/^sur_/);
    expect(payload.next_action).toBeUndefined();
    await expect(
      consumeStepUpReceipt(env, {
        ...binding,
        receipt: payload.step_up_receipt!,
      })
    ).resolves.toMatchObject({
      action_id: startPayload.action_id,
    });
    await expect(
      consumeStepUpReceipt(env, {
        ...binding,
        receipt: payload.step_up_receipt!,
      })
    ).rejects.toMatchObject({
      error: 'step_up_required',
    });
  });

  it('returns Retry-After for resend cooldown', async () => {
    const { env } = createEnv({
      'settings:tenant:tenant-a:step-up': JSON.stringify({
        step_up_resend_cooldown_seconds: 60,
      }),
    });
    const requirement = await issueStepUpToken(env, {
      ...binding,
      acceptableMethods: { methods: ['email_otp'] },
    });
    const start = await createApp().request(
      '/auth/step-up/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step_up_token: requirement.step_up_token,
          preferred_method: { method: 'email_otp' },
        }),
      },
      env
    );
    const startPayload = await start.json() as { action_id: string };

    const first = await createApp().request(
      `/auth/step-up/actions/${startPayload.action_id}/resend`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'resend-key-1' },
      },
      env
    );
    const second = await createApp().request(
      `/auth/step-up/actions/${startPayload.action_id}/resend`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'resend-key-2' },
      },
      env
    );
    const payload = await second.json() as {
      error: string;
      error_details?: { code?: string };
      input_state?: { retry_after_seconds?: number };
    };

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('60');
    expect(payload.error).toBe('resend_limit_exceeded');
    expect(payload.error_details?.code).toBe('resend_limit_exceeded');
    expect(payload.input_state?.retry_after_seconds).toBe(60);
  });
});

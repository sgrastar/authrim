import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type {
  Challenge,
  ConsumeChallengeRequest,
  Env,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core';
import {
  completeStepUpAction,
  createStepUpOperationHash,
  issueStepUpToken,
  startStepUpAction,
} from '@authrim/ar-lib-core';

/**
 * Actor–subject authorization for the customer-profile delegated-write route, exercised with the
 * DEFAULT actor validator and DEFAULT profile updater (only token introspection and the user store
 * are stubbed). Step-up runs through the real library against an in-memory challenge store.
 */

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  syncUser: vi.fn(),
  introspectTokenFromContext: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mocks.introspectTokenFromContext,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
  };
});

import {
  createCustomerProfileDelegatedWriteOperation,
  createProtectedCustomerProfileRouter,
} from '../protected-customer-profile';

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
    if (!challenge || challenge.consumed || challenge.type !== request.type) {
      throw new Error('Challenge not found or already consumed');
    }
    challenge.consumed = true;
    return {
      challenge: challenge.challenge,
      userId: challenge.userId,
      metadata: challenge.metadata,
    };
  }
}

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [] }),
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
            const entry = entries.get(String(params[0]));
            if (entry && Number(entry.expires_at) > Number(params[1])) {
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
              body_hash: params[7],
              response_status: params[8],
              response_body: params[9],
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

function createEnv() {
  const challengeStore = new InMemoryChallengeStore();
  const env = {
    DEFAULT_TENANT_ID: 'tenant-a',
    ISSUER_URL: 'https://tenant.example.com',
    DB: createIdempotencyD1(),
    AUTHRIM_CONFIG: createMockKV(),
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
  const tenantMetadataDb = createIdempotencyD1();
  app.use('*', async (c, next) => {
    (c as any).set('tenantId', 'tenant-a');
    (c as any).set('tenantMetadataContext', { tenantId: 'tenant-a', coreDb: tenantMetadataDb });
    await next();
  });
  app.route('/api/protected/customer-profiles', createProtectedCustomerProfileRouter());
  return app;
}

function projection(id: string) {
  return {
    id,
    tenant_id: 'tenant-a',
    email: `${id}@example.com`,
    email_verified: 1,
    name: `Name ${id}`,
    phone_number: '+819012345678',
    phone_number_verified: 1,
    address_json: JSON.stringify({ formatted: '1 Test Street', country: 'JP' }),
    active: 1,
    account_type: 'end_user',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

/** An ordinary issuer-audience user access token for `sub`. */
function signInAs(sub: string) {
  mocks.introspectTokenFromContext.mockResolvedValue({
    valid: true,
    claims: { sub, aud: 'https://tenant.example.com', client_id: 'rp-1', scope: 'openid' },
  });
}

/** Mints a receipt bound to (actor, subject, operation) through the real step-up flow. */
async function mintReceipt(input: {
  env: Env;
  actorId: string;
  subjectUserId: string;
  idempotencyKey: string;
  bodyInput: Record<string, unknown>;
}): Promise<string> {
  const operationHash = await createStepUpOperationHash(
    createCustomerProfileDelegatedWriteOperation({
      subjectUserId: input.subjectUserId,
      input: input.bodyInput,
    })
  );
  const requirement = await issueStepUpToken(input.env, {
    tenantId: 'tenant-a',
    actorId: input.actorId,
    subjectId: input.subjectUserId,
    operationHash,
    idempotencyKey: input.idempotencyKey,
  });
  const action = await startStepUpAction(input.env, {
    stepUpToken: requirement.step_up_token,
    tenantId: 'tenant-a',
  });
  const completed = await completeStepUpAction(input.env, {
    actionId: action.action_id,
    tenantId: 'tenant-a',
    method: 'portal_confirm',
    input: { confirmed: true },
  });
  if (!completed.step_up_receipt) {
    throw new Error('expected a step-up receipt');
  }
  return completed.step_up_receipt;
}

function patch(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  input: { userId: string; idempotencyKey: string; body: unknown; receipt?: string }
) {
  return app.request(
    `http://localhost/api/protected/customer-profiles/users/${encodeURIComponent(input.userId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer user-access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
        ...(input.receipt ? { 'Authrim-Step-Up-Receipt': input.receipt } : {}),
      },
      body: JSON.stringify(input.body),
    },
    env
  );
}

describe('customer profile delegated write: actor–subject authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({ tenantId: 'tenant-a' });
    mocks.findById.mockImplementation(async (id: string) =>
      id === 'user-404' ? null : projection(id)
    );
    mocks.syncUser.mockResolvedValue(undefined);
  });

  securityRegressionIt(
    'refuses a PATCH on another user before issuing any step-up token',
    async () => {
      const { env, challengeStore } = createEnv();
      signInAs('user-attacker');
      const response = await patch(createApp(), env, {
        userId: 'user-victim',
        idempotencyKey: 'cross-user-no-receipt',
        body: { input: { email: 'attacker@example.com' } },
      });

      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({ error: 'access_denied' });
      expect(payload).not.toHaveProperty('step_up');
      expect(challengeStore.challenges.size).toBe(0);
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.syncUser).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt(
    'refuses a PATCH on another user even with a receipt minted for that target',
    async () => {
      const { env } = createEnv();
      const input = { email: 'attacker@example.com' };
      const receipt = await mintReceipt({
        env,
        actorId: 'user-attacker',
        subjectUserId: 'user-victim',
        idempotencyKey: 'cross-user-with-receipt',
        bodyInput: input,
      });
      signInAs('user-attacker');
      const response = await patch(createApp(), env, {
        userId: 'user-victim',
        idempotencyKey: 'cross-user-with-receipt',
        body: { input },
        receipt,
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ error: 'access_denied' });
      expect(text).not.toContain('user-victim@example.com');
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.syncUser).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt(
    'answers a cross-user PATCH identically whether or not the target exists',
    async () => {
      const { env } = createEnv();
      signInAs('user-attacker');
      const app = createApp();
      const existing = await patch(app, env, {
        userId: 'user-victim',
        idempotencyKey: 'probe-existing',
        body: { input: { name: 'x' } },
      });
      const missing = await patch(app, env, {
        userId: 'user-404',
        idempotencyKey: 'probe-missing',
        body: { input: { name: 'x' } },
      });

      expect(existing.status).toBe(403);
      expect(missing.status).toBe(403);
      await expect(missing.json()).resolves.toEqual(await existing.json());
      expect(mocks.findById).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt.each([
    ['a mapped sub with a sealed account reference', { authrim_subject_ref: 'sr1.iv.ciphertext' }],
    ['an externally asserted subject', { authrim_subject_issuer: 'https://external.example' }],
    ['a delegated token', { act: { sub: 'user-attacker' } }],
    ['a subject-principal claim', { authrim_subject_principal: 'client' }],
  ])('refuses a token whose sub equals the target but is %s', async (_label, extraClaims) => {
    const { env, challengeStore } = createEnv();
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-victim',
        aud: 'https://tenant.example.com',
        client_id: 'rp-1',
        token_use: 'access_token',
        jti: 'jti-1',
        ...extraClaims,
      },
    });
    const response = await patch(createApp(), env, {
      userId: 'user-victim',
      idempotencyKey: `mapped-sub-${Object.keys(extraClaims)[0]}`,
      body: { input: { email: 'attacker@example.com' } },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
    expect(challengeStore.challenges.size).toBe(0);
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  securityRegressionIt('refuses a client principal whose sub is used as the path id', async () => {
    const { env, challengeStore } = createEnv();
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: { sub: 'client:rp-1', client_id: 'rp-1', token_use: 'access_token', jti: 'j' },
    });
    const response = await patch(createApp(), env, {
      userId: 'client:rp-1',
      idempotencyKey: 'client-principal',
      body: { input: { name: 'x' } },
    });

    expect(response.status).toBe(403);
    expect(challengeStore.challenges.size).toBe(0);
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  // Covers the authorization path only: a retry that reuses the Idempotency-Key of the
  // step_up_required response is answered from the idempotency cache, which predates this check.
  securityRegressionIt('lets a user update their own profile with a receipt for it', async () => {
    const { env } = createEnv();
    const app = createApp();
    const input = { name: 'Self Updated' };
    signInAs('user-self');

    const challenge = await patch(app, env, {
      userId: 'user-self',
      idempotencyKey: 'self-update',
      body: { input },
    });
    expect(challenge.status).toBe(403);
    await expect(challenge.json()).resolves.toMatchObject({ error: 'step_up_required' });

    const receipt = await mintReceipt({
      env,
      actorId: 'user-self',
      subjectUserId: 'user-self',
      idempotencyKey: 'self-update-2',
      bodyInput: input,
    });
    const response = await patch(app, env, {
      userId: 'user-self',
      idempotencyKey: 'self-update-2',
      body: { input },
      receipt,
    });

    expect(response.status).toBe(200);
    expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    expect(mocks.syncUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-self',
        sensitiveValues: { name: 'Self Updated' },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      customer_profile: { sub: 'user-self' },
    });
  });

  securityRegressionIt(
    'does not serve the profile read route to an ordinary access token for another user',
    async () => {
      const { env } = createEnv();
      signInAs('user-attacker');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'user-attacker', aud: 'https://tenant.example.com' })
      ).toString('base64url');
      const response = await createApp().request(
        'http://localhost/api/protected/customer-profiles/user-victim',
        { headers: { Authorization: `Bearer e30.${payload}.signature` } },
        env
      );

      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(response.status).toBeLessThanOrEqual(403);
      expect(mocks.findById).not.toHaveBeenCalled();
    }
  );
});

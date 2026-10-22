import { Hono } from 'hono';
import type {
  Challenge,
  ConsumeChallengeRequest,
  DatabaseAdapter,
  Env,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core';
import {
  cleanupExpiredIdempotencyKeys,
  completeStepUpAction,
  createStepUpOperationHash,
  issueStepUpToken,
  startStepUpAction,
} from '@authrim/ar-lib-core';
import {
  createCustomerProfileDelegatedWriteOperation,
  createProtectedCustomerProfileRouter,
} from '../../protected-customer-profile';

/**
 * Harness for the customer-profile delegated-write route with its default wiring: the idempotency
 * middleware runs against an in-memory idempotency_keys table and step-up runs through the real
 * library against an in-memory challenge store. The test file mocks token introspection and the
 * user store (vi.mock of @authrim/ar-lib-core, which must stay in the test file).
 */

export class InMemoryChallengeStore {
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

export function createMockKV(): KVNamespace {
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

export type IdempotencyD1 = D1Database & { entries: Map<string, Record<string, unknown>> };

export function createIdempotencyD1(): IdempotencyD1 {
  const entries = new Map<string, Record<string, unknown>>();
  return {
    entries,
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
            // Reservation transitions:
            // WHERE id = ? AND body_hash = ? AND response_status = <n> [AND response_body = ?]
            const where = sql.slice(sql.indexOf('WHERE'));
            const expectedStatus = /AND response_status = (\d+)/.exec(where)?.[1];
            if (
              !entry ||
              (where.includes('body_hash = ?') && entry.body_hash !== params[4]) ||
              (expectedStatus !== undefined && entry.response_status !== Number(expectedStatus)) ||
              (where.includes('response_body = ?') && entry.response_body !== params[5])
            ) {
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
          if (sql.trim().startsWith('DELETE FROM idempotency_keys WHERE expires_at < ?')) {
            // Scheduled cleanup. Honour the reservation guard only when the SQL carries it:
            // expires_at < ? AND (response_status <> 425 OR expires_at < ?)
            const guardsReservations = sql.includes('(response_status <> 425 OR expires_at < ?)');
            let changes = 0;
            for (const [id, entry] of entries) {
              const expiresAt = Number(entry.expires_at);
              if (
                expiresAt < Number(params[0]) &&
                (!guardsReservations ||
                  entry.response_status !== 425 ||
                  expiresAt < Number(params[1]))
              ) {
                entries.delete(id);
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (sql.trim().startsWith('DELETE FROM idempotency_keys')) {
            const id = String(params[0]);
            const entry = entries.get(id);
            if (
              entry &&
              Number(entry.expires_at) <= Number(params[1]) &&
              !(sql.includes('response_status <> 425') && entry.response_status === 425)
            ) {
              entries.delete(id);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
    batch: async () => [],
  } as unknown as IdempotencyD1;
}

/** The scheduled cleanup, run against the in-memory idempotency table. */
export function runIdempotencyCleanup(db: IdempotencyD1): Promise<number> {
  return cleanupExpiredIdempotencyKeys({
    execute: async (sql: string, params: unknown[]) => {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .run();
      return { rowsAffected: result.meta.changes };
    },
  } as unknown as DatabaseAdapter);
}

export function createEnv() {
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

/** `tenantMetadataDb` backs the idempotency middleware (it resolves the tenant core DB). */
export function createApp(tenantMetadataDb: IdempotencyD1 = createIdempotencyD1()) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as any).set('tenantId', 'tenant-a');
    (c as any).set('tenantMetadataContext', { tenantId: 'tenant-a', coreDb: tenantMetadataDb });
    await next();
  });
  app.route('/api/protected/customer-profiles', createProtectedCustomerProfileRouter());
  return app;
}

export function projection(id: string) {
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

/** Mints a receipt bound to (actor, subject, operation) through the real step-up flow. */
export async function mintReceipt(input: {
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
  return completeStepUp(input.env, requirement.step_up_token);
}

/** Completes a step-up token (as the client would after step_up_required) and returns the receipt. */
export async function completeStepUp(env: Env, stepUpToken: string): Promise<string> {
  const action = await startStepUpAction(env, {
    stepUpToken,
    tenantId: 'tenant-a',
  });
  const completed = await completeStepUpAction(env, {
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

export function patch(
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

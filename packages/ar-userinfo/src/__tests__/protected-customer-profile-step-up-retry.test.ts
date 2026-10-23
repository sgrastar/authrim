import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retrying a customer-profile write after step-up, with the DEFAULT actor validator, profile
 * updater, step-up library and idempotency middleware (only token introspection and the user store
 * are stubbed). The client resends the step_up_required request with the same Idempotency-Key and
 * the receipt; the idempotency middleware must let that retry reach the handler, then replay the
 * completed write instead of repeating it.
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
  completeStepUp,
  createApp,
  createEnv,
  createIdempotencyD1,
  mintReceipt,
  patch,
  projection,
  runIdempotencyCleanup,
} from './helpers/customer-profile-write-harness';

const SELF = 'user-self';

function signInAs(sub: string) {
  mocks.introspectTokenFromContext.mockResolvedValue({
    valid: true,
    claims: { sub, aud: 'https://tenant.example.com', client_id: 'rp-1', scope: 'openid' },
  });
}

async function readStepUpToken(response: Response): Promise<string> {
  expect(response.status).toBe(403);
  const payload = (await response.json()) as {
    error?: string;
    step_up?: { step_up_token?: string };
  };
  expect(payload.error).toBe('step_up_required');
  expect(payload.step_up?.step_up_token).toEqual(expect.any(String));
  return payload.step_up!.step_up_token!;
}

function storedStatuses(db: ReturnType<typeof createIdempotencyD1>): unknown[] {
  return [...db.entries.values()].map((entry) => entry.response_status);
}

describe('customer profile delegated write: retry after step-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({ tenantId: 'tenant-a' });
    mocks.findById.mockImplementation(async (id: string) => projection(id));
    mocks.syncUser.mockResolvedValue(undefined);
    signInAs(SELF);
  });

  securityRegressionIt(
    'completes the write on the same-key retry with the receipt, then replays it',
    async () => {
      const { env, challengeStore } = createEnv();
      const db = createIdempotencyD1();
      const app = createApp(db);
      const request = {
        userId: SELF,
        idempotencyKey: 'retry-same-key',
        body: { input: { name: 'New' } },
      };

      const stepUpToken = await readStepUpToken(await patch(app, env, request));
      // The key keeps the body binding but no outcome (status 0: retryable).
      expect(storedStatuses(db)).toEqual([0]);
      expect(mocks.syncUser).not.toHaveBeenCalled();

      const receipt = await completeStepUp(env, stepUpToken);
      const written = await patch(app, env, { ...request, receipt });
      expect(written.status).toBe(200);
      const writtenBody = await written.json();
      expect(writtenBody).toMatchObject({ customer_profile: { sub: SELF } });
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
      expect(mocks.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: SELF, sensitiveValues: { name: 'New' } })
      );
      expect(storedStatuses(db)).toEqual([200]);

      const challengesAfterWrite = challengeStore.challenges.size;
      for (const retry of [{ ...request, receipt }, request]) {
        const replayed = await patch(app, env, retry);
        expect(replayed.status).toBe(200);
        await expect(replayed.json()).resolves.toEqual(writtenBody);
      }
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
      // The replay issues no new step-up token: the completed write is the key's outcome.
      expect(challengeStore.challenges.size).toBe(challengesAfterWrite);
    }
  );

  securityRegressionIt('refuses a different body with the same key after the write', async () => {
    const { env } = createEnv();
    const app = createApp();
    const request = {
      userId: SELF,
      idempotencyKey: 'retry-conflict',
      body: { input: { name: 'A' } },
    };
    const receipt = await completeStepUp(
      env,
      await readStepUpToken(await patch(app, env, request))
    );
    expect((await patch(app, env, { ...request, receipt })).status).toBe(200);

    const conflict = await patch(app, env, {
      ...request,
      body: { input: { name: 'B' } },
      receipt,
    });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'idempotency_conflict' });
    expect(mocks.syncUser).toHaveBeenCalledTimes(1);
  });

  securityRegressionIt(
    'refuses a different body with the same key right after step_up_required',
    async () => {
      const { env, challengeStore } = createEnv();
      const app = createApp();
      const request = {
        userId: SELF,
        idempotencyKey: 'retry-other-body',
        body: { input: { name: 'A' } },
      };
      const receipt = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      const challengesBefore = challengeStore.challenges.size;

      for (const swapped of [
        { ...request, body: { input: { name: 'B' } } },
        { ...request, body: { input: { name: 'B' } }, receipt },
      ]) {
        const response = await patch(app, env, swapped);
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: 'idempotency_conflict' });
      }
      // No step-up was issued for body B.
      expect(challengeStore.challenges.size).toBe(challengesBefore);
      expect(mocks.syncUser).not.toHaveBeenCalled();

      const written = await patch(app, env, { ...request, receipt });
      expect(written.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
      expect(mocks.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({ sensitiveValues: { name: 'A' } })
      );
    }
  );

  securityRegressionIt(
    'does not replay a refused receipt to the retry with the right one',
    async () => {
      const { env } = createEnv();
      const db = createIdempotencyD1();
      const app = createApp(db);
      const request = {
        userId: SELF,
        idempotencyKey: 'retry-after-refusal',
        body: { input: { name: 'A' } },
      };
      const receipt = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      const wrongReceipt = await mintReceipt({
        env,
        actorId: SELF,
        subjectUserId: SELF,
        idempotencyKey: 'some-other-key',
        bodyInput: { name: 'A' },
      });

      const refused = await patch(app, env, { ...request, receipt: wrongReceipt });
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({ error: 'step_up_required' });
      expect(storedStatuses(db)).toEqual([0]);

      const written = await patch(app, env, { ...request, receipt });
      expect(written.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    }
  );

  securityRegressionIt(
    'writes once when two retries with separate receipts for the same key race',
    async () => {
      const { env } = createEnv();
      const app = createApp();
      const request = {
        userId: SELF,
        idempotencyKey: 'retry-race',
        body: { input: { name: 'A' } },
      };
      // Two step_up_required answers for the same key and body yield two distinct receipts.
      const first = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      const second = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      expect(first).not.toBe(second);

      const responses = await Promise.all([
        patch(app, env, { ...request, receipt: first }),
        patch(app, env, { ...request, receipt: second }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 425]);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
      const replayed = await patch(app, env, { ...request, receipt: second });
      expect(replayed.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    }
  );

  securityRegressionIt(
    'does not let a retry take over a reservation whose handler outlives its TTL',
    async () => {
      const { env } = createEnv();
      const db = createIdempotencyD1();
      const app = createApp(db);
      const request = {
        userId: SELF,
        idempotencyKey: 'retry-stalled',
        body: { input: { name: 'A' } },
      };
      const first = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      const second = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      let finishWrite!: () => void;
      mocks.syncUser.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          })
      );

      const stalled = patch(app, env, { ...request, receipt: first });
      await vi.waitFor(() => expect(mocks.syncUser).toHaveBeenCalledTimes(1));
      // The write is still running when its reservation expires, and scheduled cleanup runs.
      for (const entry of db.entries.values()) entry.expires_at = Math.floor(Date.now() / 1000) - 1;
      await runIdempotencyCleanup(db);
      expect(storedStatuses(db)).toEqual([425]);

      const retry = await patch(app, env, { ...request, receipt: second });
      expect(retry.status).toBe(425);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);

      finishWrite();
      expect((await stalled).status).toBe(200);
      expect(storedStatuses(db)).toEqual([200]);
      const replayed = await patch(app, env, { ...request, receipt: second });
      expect(replayed.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    }
  );

  securityRegressionIt('re-reserves a key whose retryable row expired unswept', async () => {
    const { env } = createEnv();
    const db = createIdempotencyD1();
    const app = createApp(db);
    const request = {
      userId: SELF,
      idempotencyKey: 'retry-expired-row',
      body: { input: { name: 'A' } },
    };
    const receipt = await completeStepUp(
      env,
      await readStepUpToken(await patch(app, env, request))
    );
    for (const entry of db.entries.values()) entry.expires_at = 0;

    const written = await patch(app, env, { ...request, receipt });

    expect(written.status).toBe(200);
    expect(storedStatuses(db)).toEqual([200]);
    expect(mocks.syncUser).toHaveBeenCalledTimes(1);
  });

  securityRegressionIt.each([
    [
      'another operation',
      { subjectUserId: SELF, idempotencyKey: 'bound', bodyInput: { name: 'X' } },
    ],
    [
      'another subject',
      { subjectUserId: 'user-other', idempotencyKey: 'bound', bodyInput: { name: 'A' } },
    ],
    [
      'another Idempotency-Key',
      { subjectUserId: SELF, idempotencyKey: 'other-key', bodyInput: { name: 'A' } },
    ],
  ])('refuses a receipt minted for %s', async (_label, binding) => {
    const { env } = createEnv();
    const db = createIdempotencyD1();
    const app = createApp(db);
    const receipt = await mintReceipt({
      env,
      actorId: SELF,
      subjectUserId: binding.subjectUserId,
      idempotencyKey: `retry-${binding.idempotencyKey}`,
      bodyInput: binding.bodyInput,
    });

    const response = await patch(app, env, {
      userId: SELF,
      idempotencyKey: 'retry-bound',
      body: { input: { name: 'A' } },
      receipt,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'step_up_required' });
    expect(mocks.syncUser).not.toHaveBeenCalled();
    expect(storedStatuses(db)).toEqual([0]);
  });

  securityRegressionIt(
    'does not repeat the write if the stored outcome is gone: the receipt is single-use',
    async () => {
      const { env } = createEnv();
      const db = createIdempotencyD1();
      const app = createApp(db);
      const request = {
        userId: SELF,
        idempotencyKey: 'retry-single-use',
        body: { input: { name: 'A' } },
      };
      const receipt = await completeStepUp(
        env,
        await readStepUpToken(await patch(app, env, request))
      );
      expect((await patch(app, env, { ...request, receipt })).status).toBe(200);

      db.entries.clear();
      const reused = await patch(app, env, { ...request, receipt });

      expect(reused.status).toBe(403);
      await expect(reused.json()).resolves.toMatchObject({ error: 'step_up_required' });
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    }
  );
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_SUBJECT_ISSUER_CLAIM,
  StepUpFlowError,
  SUBJECT_PRINCIPAL_CLAIM,
  SUBJECT_REFERENCE_CLAIM,
  type StepUpInputState,
  type StepUpNextAction,
  type StepUpRequirement,
  type StepUpStatusObject,
} from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  introspectTokenFromContext: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  issueStepUpToken: vi.fn(),
  consumeStepUpReceipt: vi.fn(),
  parseDelegatedWriteEnvelope: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  mocks.issueStepUpToken.mockImplementation(actual.issueStepUpToken);
  mocks.consumeStepUpReceipt.mockImplementation(actual.consumeStepUpReceipt);
  mocks.parseDelegatedWriteEnvelope.mockImplementation(actual.parseDelegatedWriteEnvelope);
  return {
    ...actual,
    introspectTokenFromContext: mocks.introspectTokenFromContext,
    issueStepUpToken: mocks.issueStepUpToken,
    consumeStepUpReceipt: mocks.consumeStepUpReceipt,
    parseDelegatedWriteEnvelope: mocks.parseDelegatedWriteEnvelope,
    resolveAccountDataContextFromHono: async () => ({ tenantId: 'tenant-a' }),
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
  };
});

import { createCustomerProfileDelegatedWriteOperation } from '../protected-customer-profile';
import {
  createApp,
  createEnv,
  createIdempotencyD1,
  mintReceipt,
  patch,
  projection,
} from './helpers/customer-profile-write-harness';

function signInAs(sub: string, extra: Record<string, unknown> = {}) {
  mocks.introspectTokenFromContext.mockResolvedValue({
    valid: true,
    claims: { sub, client_id: 'rp-1', ...extra },
  });
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json<Record<string, unknown>>();
}

const anyString: unknown = expect.any(String);

function expectNoStore(response: Response): void {
  expect(response.headers.get('Content-Type')).toBe('application/json');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Pragma')).toBe('no-cache');
}

describe('customer profile delegated write (exact behaviour)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockImplementation(async (id: string) =>
      id === 'user-404' ? null : projection(id)
    );
    mocks.syncUser.mockResolvedValue(undefined);
    signInAs('user-1');
  });

  describe('createCustomerProfileDelegatedWriteOperation', () => {
    it('names the PATCH operation, with a null audit when none is given', () => {
      expect(
        createCustomerProfileDelegatedWriteOperation({
          subjectUserId: 'user-1',
          input: { name: 'x' },
        })
      ).toEqual({
        resource: 'customer_profile',
        action: 'update',
        method: 'PATCH',
        path: '/api/protected/customer-profiles/users/{subject_user_id}',
        subject_user_id: 'user-1',
        input: { name: 'x' },
        audit: null,
      });
    });

    it('carries the audit when given', () => {
      const audit = { reason_code: 'admin_repair' };
      expect(
        createCustomerProfileDelegatedWriteOperation({
          subjectUserId: 'user-1',
          input: {},
          audit,
        }).audit
      ).toBe(audit);
    });
  });

  describe('actor validation', () => {
    it('forwards the WWW-Authenticate challenge and status of a refused token', async () => {
      mocks.introspectTokenFromContext.mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Expired',
          statusCode: 401,
          wwwAuthenticate: 'Bearer error="invalid_token"',
        },
      });
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-www-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
      expectNoStore(response);
      expect(await json(response)).toEqual({
        error: 'invalid_token',
        error_description: 'Expired',
      });
    });

    it('sends no challenge header when the refusal carries none', async () => {
      mocks.introspectTokenFromContext.mockResolvedValue({
        valid: false,
        error: { error: 'server_error', error_description: 'x', statusCode: 500 },
      });
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-nowww-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('WWW-Authenticate')).toBeNull();
    });

    it.each([
      ['a sealed subject reference', { [SUBJECT_REFERENCE_CLAIM]: 'sr1.iv.ct' }],
      [
        'an external subject issuer',
        { [ACCESS_TOKEN_SUBJECT_ISSUER_CLAIM]: 'https://idp.example' },
      ],
      ['a subject principal claim', { [SUBJECT_PRINCIPAL_CLAIM]: 'client' }],
      ['a delegation (act) claim', { act: { sub: 'someone' } }],
    ])('refuses a token whose sub equals the target but carries %s', async (_label, extra) => {
      signInAs('user-1', extra);
      const { env, challengeStore } = createEnv();
      const response = await patch(createApp(), env, {
        userId: 'user-1',
        idempotencyKey: `idem-k-${Object.keys(extra)[0]}-key`,
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(403);
      expectNoStore(response);
      expect(await json(response)).toEqual({
        error: 'access_denied',
        error_description: 'The access token is not authorized to update this customer profile.',
      });
      expect(challengeStore.challenges.size).toBe(0);
    });

    it('refuses a client principal used as the account id', async () => {
      signInAs('client:rp-1');
      const response = await patch(createApp(), createEnv().env, {
        userId: 'client:rp-1',
        idempotencyKey: 'idem-k-client-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(403);
      expect((await json(response)).error).toBe('access_denied');
    });

    it('refuses an actor that is not the subject, before any step-up is issued', async () => {
      signInAs('user-a');
      const { env, challengeStore } = createEnv();
      const response = await patch(createApp(), env, {
        userId: 'user-b',
        idempotencyKey: 'idem-k-other-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({
        error: 'access_denied',
        error_description: 'The access token is not authorized to update this customer profile.',
      });
      expect(challengeStore.challenges.size).toBe(0);
      expect(mocks.issueStepUpToken).not.toHaveBeenCalled();
    });

    it.each([
      ['an authrim_elevation claim', { authrim_elevation: {} }],
      ['the elevation_grant_subject token use', { token_use: 'elevation_grant_subject' }],
    ])('refuses a token with %s even for the actor itself', async (_label, extra) => {
      signInAs('user-1', extra);
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-elev-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({
        error: 'access_denied',
        error_description:
          'Product-specific downstream elevation grant tokens are not accepted for standard delegated write.',
      });
    });

    it('accepts an ordinary token use for the actor itself', async () => {
      signInAs('user-1', { token_use: 'access_token' });
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-ordinary-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(403);
      expect((await json(response)).error).toBe('step_up_required');
    });

    it('does not run actor validation for methods other than PATCH', async () => {
      const response = await createApp().request(
        'http://localhost/api/protected/customer-profiles/users/user-1',
        { method: 'GET' },
        createEnv().env
      );
      expect(response.status).toBe(404);
      expect(mocks.introspectTokenFromContext).not.toHaveBeenCalled();
    });

    it('records the idempotency reservation under the actor id', async () => {
      const inserts: unknown[][] = [];
      const base = createIdempotencyD1();
      const db = {
        ...base,
        prepare: (sql: string) => {
          const statement = base.prepare(sql);
          const bind = statement.bind.bind(statement);
          statement.bind = (...params: unknown[]) => {
            if (sql.trim().startsWith('INSERT INTO idempotency_keys')) inserts.push(params);
            return bind(...params);
          };
          return statement;
        },
      } as unknown as typeof base;
      await patch(createApp(db), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-actor-key',
        body: { input: { name: 'x' } },
      });
      expect(inserts.length).toBeGreaterThan(0);
      expect(must(inserts[0])[2]).toBe('user-1');
    });
  });

  describe('request body', () => {
    it('answers a body that is not JSON as an invalid request', async () => {
      const app = createApp();
      const response = await app.request(
        'http://localhost/api/protected/customer-profiles/users/user-1',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-k-bad-json-key' },
          body: 'not json',
        },
        createEnv().env
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('invalid_request');
    });

    it('answers an unexpected parser failure with the generic message and no field', async () => {
      mocks.parseDelegatedWriteEnvelope.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-parser-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(400);
      expectNoStore(response);
      expect(await json(response)).toEqual({
        error: 'invalid_request',
        error_description: 'Delegated write body is invalid',
      });
    });

    it('names the offending field of an invalid input', async () => {
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-field-key',
        body: { input: { name: 5 } },
      });
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: 'invalid_request',
        error_description: 'input.name must be a string or null',
        field: 'input.name',
      });
    });
  });

  describe('step-up', () => {
    it('issues a step-up requirement bound to the idempotency key', async () => {
      const { env } = createEnv();
      const response = await patch(createApp(), env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-issue-key',
        body: { input: { name: 'x' } },
      });
      expect(response.status).toBe(403);
      const body = await json(response);
      expect(body).toMatchObject({
        error: 'step_up_required',
        error_description: 'Step-up is required for this delegated write.',
      });
      expect(body.step_up).toBeDefined();
      expect(mocks.issueStepUpToken).toHaveBeenCalledWith(env, {
        tenantId: 'tenant-a',
        actorId: 'user-1',
        subjectId: 'user-1',
        operationHash: anyString,
        idempotencyKey: 'idem-k-issue-key',
      });
    });

    it('does not replay a step-up requirement to a retry with the same key', async () => {
      const { env } = createEnv();
      const app = createApp();
      const first = await json(
        await patch(app, env, {
          userId: 'user-1',
          idempotencyKey: 'idem-k-retry-key',
          body: { input: { name: 'x' } },
        })
      );
      const second = await json(
        await patch(app, env, {
          userId: 'user-1',
          idempotencyKey: 'idem-k-retry-key',
          body: { input: { name: 'x' } },
        })
      );
      expect(second.error).toBe('step_up_required');
      expect(second.step_up).not.toEqual(first.step_up);
      expect(mocks.issueStepUpToken).toHaveBeenCalledTimes(2);
    });

    it('lets a valid receipt through after a refused one under the same key', async () => {
      const { env } = createEnv();
      const app = createApp();
      const input = { name: 'Retry Name' };
      const refused = await patch(app, env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-bad-receipt-key',
        body: { input },
        receipt: 'sur_unknownreceipt0000000000',
      });
      expect(refused.status).toBe(403);
      expect(mocks.syncUser).not.toHaveBeenCalled();

      const receipt = await mintReceipt({
        env,
        actorId: 'user-1',
        subjectUserId: 'user-1',
        idempotencyKey: 'idem-k-bad-receipt-key',
        bodyInput: input,
      });
      const accepted = await patch(app, env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-bad-receipt-key',
        body: { input },
        receipt,
      });
      expect(accepted.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    });

    it('passes the receipt and key to the receipt check', async () => {
      const { env } = createEnv();
      mocks.consumeStepUpReceipt.mockResolvedValueOnce({});
      await patch(createApp(), env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-consume-key',
        body: { input: { name: 'x' } },
        receipt: 'receipt-value',
      });
      expect(mocks.consumeStepUpReceipt).toHaveBeenCalledWith(env, {
        tenantId: 'tenant-a',
        actorId: 'user-1',
        subjectId: 'user-1',
        operationHash: anyString,
        idempotencyKey: 'idem-k-consume-key',
        receipt: 'receipt-value',
      });
    });

    it('answers a plain step-up error without details as a no-store JSON error', async () => {
      mocks.consumeStepUpReceipt.mockRejectedValueOnce(
        new StepUpFlowError({
          error: 'access_denied',
          message: 'Receipt belongs to another operation',
          httpStatus: 409,
        })
      );
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-plain-key',
        body: { input: { name: 'x' } },
        receipt: 'r',
      });
      expect(response.status).toBe(409);
      expectNoStore(response);
      expect(await json(response)).toEqual({
        error: 'access_denied',
        error_description: 'Receipt belongs to another operation',
      });
    });

    it('carries every detail of a step-up error that has a detail code', async () => {
      const statusObject: StepUpStatusObject = { status: 'pending', attempts_remaining: 2 };
      const inputState: StepUpInputState = { field: 'code', attempts_remaining: 2 };
      const stepUp: StepUpRequirement = {
        step_up_token: 'su_x',
        expires_at: '2026-11-01T00:00:00.000Z',
        expires_at_unix: 1793491200,
        acceptable_methods: { methods: ['email_otp'] },
      };
      const nextAction: StepUpNextAction = {
        type: 'otp',
        method: 'email_otp',
        category: 'otp',
        action_id: 'act-1',
        expires_at: '2026-11-01T00:00:00.000Z',
        expires_at_unix: 1793491200,
        payload: {},
      };
      mocks.consumeStepUpReceipt.mockRejectedValueOnce(
        new StepUpFlowError({
          error: 'invalid_request',
          message: 'Bad input',
          httpStatus: 400,
          detailCode: 'invalid_step_up_input',
          statusObject,
          inputState,
          stepUp,
          nextAction,
        })
      );
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-detail-key',
        body: { input: { name: 'x' } },
        receipt: 'r',
      });
      expect(response.status).toBe(400);
      expectNoStore(response);
      const body = await json(response);
      expect(body).toMatchObject({
        error: 'invalid_request',
        error_description: 'Bad input',
        status: statusObject,
        input_state: inputState,
        step_up: stepUp,
        next_action: nextAction,
      });
      expect(must(body.error_details as { code?: string }).code).toBe('invalid_step_up_input');
    });

    it('leaves out the optional details a step-up error does not have, and maps 404 to 400', async () => {
      mocks.consumeStepUpReceipt.mockRejectedValueOnce(
        new StepUpFlowError({
          error: 'not_found',
          message: 'No such action',
          httpStatus: 404,
          detailCode: 'step_up_required',
        })
      );
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-sparse-key',
        body: { input: { name: 'x' } },
        receipt: 'r',
      });
      expect(response.status).toBe(400);
      const body = await json(response);
      expect(body.error).toBe('not_found');
      for (const key of ['status', 'input_state', 'step_up', 'next_action']) {
        expect(body).not.toHaveProperty(key);
      }
    });

    it('answers an unexpected receipt failure as step_up_required', async () => {
      mocks.consumeStepUpReceipt.mockRejectedValueOnce(new Error('store down'));
      const response = await patch(createApp(), createEnv().env, {
        userId: 'user-1',
        idempotencyKey: 'idem-k-unexpected-key',
        body: { input: { name: 'x' } },
        receipt: 'r',
      });
      expect(response.status).toBe(403);
      expectNoStore(response);
      const body = await json(response);
      expect(body).toMatchObject({
        error: 'step_up_required',
        error_description: 'Step-up receipt is invalid or expired.',
      });
      expect(must(body.error_details as { code?: string }).code).toBe('step_up_required');
    });
  });
});

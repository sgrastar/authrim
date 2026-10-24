/**
 * zod 3 -> 4 migration pins for routes/approval-artifacts.ts.
 *
 * Every route here does `Schema.parse(await c.req.json())` inside a try/catch and, for
 * `error instanceof z.ZodError`, reports ONLY `issues[0]` as `field = path.join('.') || 'body'`,
 * `reason = message`. `createErrorResponse` is mocked (status from the real implementation, body
 * `{ error: code, ...options }`) so both strings are pinned.
 * A payload that passes validation is detected by the next step: the (mocked) artifact lookup
 * returns null, which yields `404 ADMIN_RESOURCE_NOT_FOUND`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ getArtifact: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
    })),
    createErrorResponse: vi.fn(
      async (...[c, code, options]: Parameters<typeof actual.createErrorResponse>) => {
        const real = await actual.createErrorResponse(c, code, options);
        return Response.json({ error: code, ...options }, { status: real.status });
      }
    ),
  };
});
vi.mock('../../approval-completion-artifact', () => ({
  getApprovalCompletionArtifact: mocks.getArtifact,
  consumeApprovalCompletionArtifact: vi.fn(),
}));

import { approvalArtifactsRouter } from '../../routes/approval-artifacts';

const env = {
  ISSUER_URL: 'https://auth.example.com',
  ADMIN_UI_URL: 'https://admin.example.com',
  DB_ADMIN: {},
  AUTHRIM_CONFIG: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
} as unknown as Env;

async function post(path: string, body: unknown, raw?: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/approval-artifacts', approvalArtifactsRouter);
  const response = await app.request(
    `/api/approval-artifacts/apc_1/${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    },
    env
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const invalid = (field: string, reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});
/** Passed the schema; the artifact lookup (mocked to null) stopped it. */
const ACCEPTED = { status: 404, body: { error: 'AR060004' } };

const METHODS = "'ciba' | 'passkey' | 'portal_confirm' | 'email_otp' | 'sms_otp' | 'reauth'";
const ACTOR_TYPES = "'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal'";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getArtifact.mockResolvedValue(null);
});

describe('zod pins: ApprovalArtifactDecisionSchema (POST /:id/complete)', () => {
  const complete = (body: unknown, raw?: string) => post('complete', body, raw);
  const good = { decision: 'approved' };

  it('only the first issue is reported; field uses dotted paths', async () => {
    expect(await complete(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await complete([])).toEqual(invalid('body', 'Expected object, received array'));
    expect(await complete('x')).toEqual(invalid('body', 'Expected object, received string'));
    expect(await complete({})).toEqual(invalid('decision', 'Required'));
    expect(await complete({ decision: 'maybe' })).toEqual(
      invalid('decision', "Invalid enum value. Expected 'approved' | 'denied', received 'maybe'")
    );
    expect(await complete({ decision: 5 })).toEqual(
      invalid('decision', "Expected 'approved' | 'denied', received number")
    );
    expect(await complete({ ...good, method: 'fax' })).toEqual(
      invalid('method', `Invalid enum value. Expected ${METHODS}, received 'fax'`)
    );
    expect(await complete({ ...good, transport_channel: '' })).toEqual(
      invalid('transport_channel', 'String must contain at least 1 character(s)')
    );
    expect(await complete({ ...good, reason_code: 5 })).toEqual(
      invalid('reason_code', 'Expected string, received number')
    );
    expect(await complete({ ...good, reason_note: '' })).toEqual(
      invalid('reason_note', 'String must contain at least 1 character(s)')
    );
    expect(await complete({ ...good, transport_summary: 'x' })).toEqual(
      invalid('transport_summary', 'Expected object, received string')
    );
    expect(await complete({ ...good, transport_summary: { provider: '' } })).toEqual(
      invalid('transport_summary.provider', 'String must contain at least 1 character(s)')
    );
    expect(await complete({ ...good, transport_detail: { request: 'x' } })).toEqual(
      invalid('transport_detail.request', 'Expected object, received string')
    );
    expect(await complete({ ...good, transport_detail: { request: [] } })).toEqual(
      invalid('transport_detail.request', 'Expected object, received array')
    );
    expect(await complete({ ...good, completion_assertion: {} })).toEqual(
      invalid('completion_assertion.method', 'Required')
    );
    expect(await complete({ ...good, completion_assertion: { method: 'x' } })).toEqual(
      invalid(
        'completion_assertion.method',
        `Invalid enum value. Expected ${METHODS}, received 'x'`
      )
    );
    expect(
      await complete({
        ...good,
        completion_assertion: { method: 'passkey', actor_subject_type: 'bot' },
      })
    ).toEqual(
      invalid(
        'completion_assertion.actor_subject_type',
        `Invalid enum value. Expected ${ACTOR_TYPES}, received 'bot'`
      )
    );
    expect(
      await complete({ ...good, completion_assertion: { method: 'passkey', verified_at: 0 } })
    ).toEqual(invalid('completion_assertion.verified_at', 'Number must be greater than 0'));
    expect(
      await complete({ ...good, completion_assertion: { method: 'passkey', verified_at: 1.5 } })
    ).toEqual(invalid('completion_assertion.verified_at', 'Expected integer, received float'));
  });

  it('issue order is schema order across multiple failing fields', async () => {
    expect(await complete({ method: 'x', decision: 'y', reason_code: 1 })).toEqual(
      invalid('decision', "Invalid enum value. Expected 'approved' | 'denied', received 'y'")
    );
    expect(
      await complete({ ...good, reason_note: '', transport_channel: '', method: 'x' })
    ).toEqual(invalid('method', `Invalid enum value. Expected ${METHODS}, received 'x'`));
  });

  it('malformed JSON is not a ZodError: it falls into the generic internal-error branch', async () => {
    const result = await complete(undefined, '{oops');
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'AR900001' });
  });

  it('accepted: nullable records, unknown keys stripped, boundaries', async () => {
    expect(await complete({ ...good, extra: true })).toEqual(ACCEPTED);
    expect(
      await complete({
        decision: 'denied',
        method: 'reauth',
        transport_channel: 'c',
        reason_code: 'r',
        reason_note: 'n',
        transport_summary: {
          provider: 'p',
          delivery_status: 'd',
          target: 't',
          correlation_id: 'c',
          transport_request_id: 'i',
        },
        transport_detail: { request: { a: 1 }, response: null, metadata: {} },
        completion_assertion: {
          method: 'email_otp',
          actor_subject_type: 'end_user',
          actor_subject_id: 'u',
          verified_at: 1,
          metadata: null,
        },
      })
    ).toEqual(ACCEPTED);
  });
});

describe('zod pins: passkey / otp / ciba / switch-method schemas', () => {
  it('passkey/options: empty/invalid JSON falls back to {} (rp_id optional); bad rp_id reports a field', async () => {
    expect(await post('passkey/options', undefined, '{oops')).toEqual(ACCEPTED);
    expect(await post('passkey/options', {})).toEqual(ACCEPTED);
    expect(await post('passkey/options', { rp_id: 'example.com', extra: 1 })).toEqual(ACCEPTED);
    expect(await post('passkey/options', { rp_id: '' })).toEqual(
      invalid('rp_id', 'String must contain at least 1 character(s)')
    );
    expect(await post('passkey/options', { rp_id: 5 })).toEqual(
      invalid('rp_id', 'Expected string, received number')
    );
    expect(await post('passkey/options', null)).toEqual(
      invalid('body', 'Expected object, received null')
    );
  });

  it('passkey/verify: credential accepts any present value and is required', async () => {
    expect(await post('passkey/verify', {})).toEqual(invalid('challenge_id', 'Required'));
    expect(await post('passkey/verify', { challenge_id: '' })).toEqual(
      invalid('challenge_id', 'String must contain at least 1 character(s)')
    );
    expect(await post('passkey/verify', { challenge_id: 5, credential: {} })).toEqual(
      invalid('challenge_id', 'Expected string, received number')
    );
    // zod 3 let a missing credential through (the handler then threw on credential.id);
    // zod 4 reports it as a validation error.
    expect(await post('passkey/verify', { challenge_id: 'c' })).toEqual(
      invalid('credential', 'Required')
    );
    // accepted: credential null / primitive / object
    expect(await post('passkey/verify', { challenge_id: 'c', credential: null })).toEqual(ACCEPTED);
    expect(
      await post('passkey/verify', { challenge_id: 'c', credential: 'not-an-object' })
    ).toEqual(ACCEPTED);
    expect(await post('passkey/verify', { challenge_id: 'c', credential: { id: 'x' } })).toEqual(
      ACCEPTED
    );
  });

  it('otp/verify: code must be exactly six ASCII digits', async () => {
    expect(await post('otp/verify', {})).toEqual(invalid('code', 'Required'));
    expect(await post('otp/verify', null)).toEqual(
      invalid('body', 'Expected object, received null')
    );
    const rejected: unknown[] = [
      '12345',
      '1234567',
      '12345a',
      ' 123456',
      '123456 ',
      '123456\n',
      '',
      '１２３４５６',
    ];
    for (const code of rejected) {
      expect([code, await post('otp/verify', { code })]).toEqual([
        code,
        invalid('code', 'Invalid'),
      ]);
    }
    expect(await post('otp/verify', { code: 123456 })).toEqual(
      invalid('code', 'Expected string, received number')
    );
    expect(await post('otp/verify', { code: '000000' })).toEqual(ACCEPTED);
    expect(await post('otp/verify', { code: '123456', extra: 1 })).toEqual(ACCEPTED);
  });

  it('ciba/respond: decision enum and non-empty auth_req_id / user_code', async () => {
    expect(await post('ciba/respond', {})).toEqual(invalid('decision', 'Required'));
    expect(await post('ciba/respond', { decision: 'x', auth_req_id: 'a', user_code: 'u' })).toEqual(
      invalid('decision', "Invalid enum value. Expected 'approved' | 'denied', received 'x'")
    );
    expect(await post('ciba/respond', { decision: 'approved' })).toEqual(
      invalid('auth_req_id', 'Required')
    );
    expect(
      await post('ciba/respond', { decision: 'approved', auth_req_id: '', user_code: 'u' })
    ).toEqual(invalid('auth_req_id', 'String must contain at least 1 character(s)'));
    expect(
      await post('ciba/respond', { decision: 'approved', auth_req_id: 'a', user_code: '' })
    ).toEqual(invalid('user_code', 'String must contain at least 1 character(s)'));
    expect(
      await post('ciba/respond', { decision: 'denied', auth_req_id: 'a', user_code: 'u' })
    ).toEqual(ACCEPTED);
  });

  it('switch-method: method enum', async () => {
    expect(await post('switch-method', {})).toEqual(invalid('method', 'Required'));
    expect(await post('switch-method', { method: 'fax' })).toEqual(
      invalid('method', `Invalid enum value. Expected ${METHODS}, received 'fax'`)
    );
    expect(await post('switch-method', { method: null })).toEqual(
      invalid('method', `Expected ${METHODS}, received null`)
    );
    expect(await post('switch-method', { method: 'passkey', extra: 1 })).toEqual(ACCEPTED);
  });
});

/**
 * VP response route: input validation, the reserve/complete/fail/release protocol and its
 * compensation, each with exact request bodies and outcomes.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    verify: vi.fn(),
    storeById: vi.fn(),
    isConfiguredShard: vi.fn(),
    sha: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    createErrorResponse: (
      c: { json: (b: unknown, s: number) => Response },
      code: string,
      options?: unknown
    ) => c.json({ code, options: options ?? null }, 400),
  };
});
vi.mock('../../services/vp-verifier', () => ({ verifyVPToken: h.verify }));
vi.mock('../../../utils/vp-request-sharding', () => ({ getVPRequestStoreById: h.storeById }));
vi.mock('../../../utils/configured-shard', () => ({ isConfiguredShard: h.isConfiguredShard }));
vi.mock('../../../utils/crypto', () => ({ sha256Base64url: h.sha }));

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { vpResponseRoute } from '../response';

const NOW_MS = 1_800_000_000_000;
const REQUEST_ID = 'g1:apac:1:vp_550e8400';
const VP_REQUEST = { nonce: 'n-1', clientId: 'verifier-1', tenantId: 'tenant-1' };

let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };
const env = { marker: 'env' } as unknown as Env;

const answer = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
const calls = (path: string) =>
  stub.fetch.mock.calls.filter((call) => new URL((call[0] as Request).url).pathname === path);
const bodyOf = async (call: unknown[]) => (await (call[0] as Request).clone().json()) as unknown;

function routes(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const table: Record<string, () => Response | Promise<Response>> = {
    '/reserve': () => answer({ reserved: true, reservationId: 'res-1', request: VP_REQUEST }),
    '/complete': () => answer({ completed: true }),
    '/fail': () => answer({ failed: true }),
    '/release': () => answer({}),
    ...overrides,
  };
  stub.fetch.mockImplementation(async (request: Request) => table[new URL(request.url).pathname]());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  routes();
  h.storeById.mockReturnValue({ stub, resolution: 'r' });
  h.isConfiguredShard.mockResolvedValue(true);
  h.sha.mockResolvedValue('fingerprint');
  h.verify.mockResolvedValue({
    verified: true,
    disclosedClaims: { given_name: 'A', family_name: 'B' },
    haipCompliant: true,
    errors: [],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function post(init: { json?: unknown; form?: Record<string, string>; raw?: string } = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/vp/response', vpResponseRoute);
  const useForm = init.form !== undefined;
  const response = await app.request(
    'https://verifier.example.com/vp/response',
    {
      method: 'POST',
      headers: useForm
        ? { 'Content-Type': 'application/x-www-form-urlencoded' }
        : { 'Content-Type': 'application/json' },
      body:
        init.raw ??
        (useForm ? new URLSearchParams(init.form).toString() : JSON.stringify(init.json)),
    },
    env
  );
  return { status: response.status, body: await response.json() };
}
const valid = { vp_token: 'a.b.c~d~', state: REQUEST_ID };
const failure = (code: string, options: unknown = null) => ({
  status: 400,
  body: { code, options },
});

describe('vpResponseRoute: input', () => {
  it('names its logger module', async () => {
    await post();
    expect(h.logger.module).toHaveBeenCalledWith('VC-VERIFIER');
  });

  it('reads a form body and a JSON body alike', async () => {
    expect((await post({ form: valid })).body).toMatchObject({ success: true });
    expect((await post({ json: valid })).body).toMatchObject({ success: true });
  });

  it('refuses a presentation_submission that is not JSON, and ignores an empty one', async () => {
    expect(await post({ form: { ...valid, presentation_submission: '{bad' } })).toEqual(
      failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE)
    );
    expect(stub.fetch).not.toHaveBeenCalled();
    expect(
      (await post({ form: { ...valid, presentation_submission: '{"id":"x"}' } })).body
    ).toMatchObject({
      success: true,
    });
    expect((await post({ form: { ...valid, presentation_submission: '' } })).body).toMatchObject({
      success: true,
    });
  });

  it.each([
    ['missing', { state: REQUEST_ID }],
    ['empty', { vp_token: '', state: REQUEST_ID }],
    ['blank', { vp_token: '  \t', state: REQUEST_ID }],
    ['a number', { vp_token: 123, state: REQUEST_ID }],
    ['an object', { vp_token: { a: 1 }, state: REQUEST_ID }],
  ])('requires a vp_token that is not %s', async (_name, json) => {
    expect(await post({ json })).toEqual(
      failure(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, { variables: { field: 'vp_token' } })
    );
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('requires the state', async () => {
    for (const json of [{ vp_token: 'x' }, { vp_token: 'x', state: '' }]) {
      expect(await post({ json })).toEqual(
        failure(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, { variables: { field: 'state' } })
      );
    }
  });

  it('answers 500-class internal error for an unparsable JSON body', async () => {
    expect(await post({ raw: 'not json' })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    expect(h.logger.error).toHaveBeenCalledWith(
      'VP response processing failed',
      {},
      expect.any(Error)
    );
  });
});

describe('vpResponseRoute: reserving the request', () => {
  it('routes by the state and the tenant, and refuses a shard that is not configured', async () => {
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE));
    expect(h.storeById).toHaveBeenCalledWith(env, REQUEST_ID, 'tenant-1');
    expect(h.isConfiguredShard).toHaveBeenCalledWith(env, 'tenant-1', 'r');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('reserves with the fingerprint of the token and the clock', async () => {
    await post({ json: valid });
    expect(h.sha).toHaveBeenCalledWith('a.b.c~d~');
    expect(await bodyOf(calls('/reserve')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      responseFingerprint: 'fingerprint',
      now: NOW_MS,
    });
  });

  it.each([
    ['a refusing store', () => answer({}, false)],
    ['no reservation', () => answer({ reserved: false })],
    ['a reservation without id', () => answer({ reserved: true, request: VP_REQUEST })],
    ['a reservation without request', () => answer({ reserved: true, reservationId: 'r' })],
  ])('refuses %s without verifying', async (_name, reserve) => {
    routes({ '/reserve': reserve });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE));
    expect(h.verify).not.toHaveBeenCalled();
    expect(calls('/release')).toHaveLength(0);
  });

  it('does not release anything when the reservation itself throws', async () => {
    stub.fetch.mockRejectedValue(new Error('network'));
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('vpResponseRoute: verification outcome', () => {
  it('verifies against the nonce, audience and tenant of the stored request', async () => {
    await post({ json: valid });
    expect(h.verify).toHaveBeenCalledWith(env, 'a.b.c~d~', {
      nonce: 'n-1',
      audience: 'verifier-1',
      tenantId: 'tenant-1',
    });
  });

  it('completes a verified presentation with the claim names only', async () => {
    const result = await post({ json: valid });
    expect(result).toEqual({
      status: 200,
      body: {
        success: true,
        request_id: REQUEST_ID,
        verified_claim_names: ['given_name', 'family_name'],
        haip_compliant: true,
      },
    });
    expect(await bodyOf(calls('/complete')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      reservationId: 'res-1',
      verifiedClaimNames: ['given_name', 'family_name'],
    });
    expect(calls('/fail')).toHaveLength(0);
    expect(calls('/release')).toHaveLength(0);
  });

  it('reports no claim names when none were disclosed', async () => {
    h.verify.mockResolvedValue({ verified: true, haipCompliant: false, errors: [] });
    const result = await post({ json: valid });
    expect(result.body).toMatchObject({ verified_claim_names: [], haip_compliant: false });
    expect(
      ((await bodyOf(calls('/complete')[0])) as { verifiedClaimNames: string[] }).verifiedClaimNames
    ).toEqual([]);
  });

  it.each([
    ['a refusing store', () => answer({}, false)],
    ['an incomplete answer', () => answer({ completed: false })],
    ['an answer without a flag', () => answer({})],
  ])(
    'releases the reservation and answers internal error for %s on completion',
    async (_n, complete) => {
      routes({ '/complete': complete });
      expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
      expect(await bodyOf(calls('/release')[0])).toEqual({
        id: REQUEST_ID,
        tenantId: 'tenant-1',
        reservationId: 'res-1',
      });
      expect(h.logger.error).toHaveBeenCalledWith(
        'VP response processing failed',
        {},
        expect.objectContaining({ message: 'vp_response_completion_failed' })
      );
    }
  );

  it('fails a presentation that did not verify, with the joined reasons, and answers invalid value', async () => {
    h.verify.mockResolvedValue({
      verified: false,
      errors: ['first', 'second'],
      disclosedClaims: { secret: 'x' },
    });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE));
    expect(await bodyOf(calls('/fail')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      reservationId: 'res-1',
      errorCode: 'verification_failed',
      errorDescription: 'first; second',
    });
    expect(calls('/complete')).toHaveLength(0);
    expect(calls('/release')).toHaveLength(0);
  });

  it.each([
    ['a refusing store', () => answer({}, false)],
    ['an incomplete answer', () => answer({ failed: false })],
    ['an answer without a flag', () => answer({})],
  ])('releases the reservation and answers internal error for %s on failing', async (_n, fail) => {
    h.verify.mockResolvedValue({ verified: false, errors: ['x'] });
    routes({ '/fail': fail });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    expect(calls('/release')).toHaveLength(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      'VP response processing failed',
      {},
      expect.objectContaining({ message: 'vp_response_failure_transition_failed' })
    );
  });

  it('speaks JSON to the store on every call', async () => {
    await post({ json: valid });
    for (const path of ['/reserve', '/complete']) {
      expect((calls(path)[0][0] as Request).headers.get('Content-Type')).toBe('application/json');
    }
    h.verify.mockResolvedValue({ verified: false, errors: ['x'] });
    await post({ json: valid });
    expect((calls('/fail')[0][0] as Request).headers.get('Content-Type')).toBe('application/json');
    h.verify.mockRejectedValue(new Error('boom'));
    await post({ json: valid });
    expect((calls('/release')[0][0] as Request).headers.get('Content-Type')).toBe(
      'application/json'
    );
  });

  it('trusts no answer of a store that reported a failure', async () => {
    routes({
      '/reserve': () =>
        answer({ reserved: true, reservationId: 'res-1', request: VP_REQUEST }, false),
    });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE));
    expect(h.verify).not.toHaveBeenCalled();
    routes({ '/complete': () => answer({ completed: true }, false) });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    h.verify.mockResolvedValue({ verified: false, errors: ['x'] });
    routes({ '/fail': () => answer({ failed: true }, false) });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
  });

  it('releases the reservation when verification throws, even if the release fails', async () => {
    h.verify.mockRejectedValue(new Error('boom'));
    routes({ '/release': () => Promise.reject(new Error('gone')) });
    expect(await post({ json: valid })).toEqual(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    expect(calls('/release')).toHaveLength(1);
  });
});

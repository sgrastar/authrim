import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (o) =>
  (await import('./check-mutation-mocks')).coreFactory(await o<object>())
);
vi.mock('../../middleware/check-auth', async (o) =>
  (await import('./check-mutation-mocks')).authFactory(await o<object>())
);
vi.mock('../../middleware/rate-limit', async (o) =>
  (await import('./check-mutation-mocks')).rateLimitFactory(await o<object>())
);
vi.mock('../../rebac-storage-adapter', async () =>
  (await import('./check-mutation-mocks')).adapterFactory()
);
vi.mock('../../tenant-policy', async () =>
  (await import('./check-mutation-mocks')).tenantPolicyFactory()
);
vi.mock('@authrim/ar-lib-core/services/unified-check-service', async (o) =>
  (await import('./check-mutation-mocks')).unifiedFactory(await o<object>())
);
vi.mock('@authrim/ar-lib-core/services/check-audit-service', async (o) =>
  (await import('./check-mutation-mocks')).auditFactory(await o<object>())
);

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { RateLimiterUnavailableError } from '../../middleware/rate-limit';
import { checkRoutes } from '../check';
import {
  adapter,
  clearErrorCalls,
  allowedRate,
  errorBody,
  errorCall,
  executionCtx,
  fns,
  logger,
  makeEnv,
  policySecretAuth,
  postJson,
  firstBatchCall,
  resetMocks,
  settingsReturning,
  tenantAuth,
} from './check-mutation-mocks';

const CHECK = { subject_id: 'user_1', permission: 'documents:read', tenant_id: 'tenant-a' };
const TUPLE = { user_id: 'u', relation: 'r', object: 'o' };

function batch(body: unknown, env = makeEnv(), headers: Record<string, string> = {}) {
  return postJson(checkRoutes, '/batch', body, env, headers);
}

function withRebac(rebac: unknown) {
  return { checks: [CHECK, { ...CHECK, rebac }] };
}

function withTuples(tuples: unknown) {
  return withRebac({ relation: 'viewer', object: 'doc:1', contextual_tuples: tuples });
}

async function expectInvalid(body: unknown): Promise<void> {
  fns.batchCheck.mockClear();
  clearErrorCalls();
  const response = await batch(body);
  expect(response.status).toBe(400);
  expect(errorCall()).toEqual({
    code: AR_ERROR_CODES.VALIDATION_INVALID_VALUE,
    options: undefined,
  });
  expect(fns.batchCheck).not.toHaveBeenCalled();
}

const anyString: unknown = expect.any(String);

beforeEach(resetMocks);

describe('POST /batch gates', () => {
  it('rejects while the Check API is off, before authenticating', async () => {
    settingsReturning({ flags: { 'feature.enable_check_api': false } });
    const response = await batch({ checks: [CHECK] });
    expect(response.status).toBe(403);
    expect((await errorBody(response)).error_code).toBe('AR050001');
    expect(fns.authenticate).not.toHaveBeenCalled();
  });

  it('authenticates with the header and the route collaborators', async () => {
    const env = makeEnv();
    await batch({ checks: [CHECK] }, env, { Authorization: 'Bearer chk_batch' });
    expect(fns.authenticate).toHaveBeenCalledWith('Bearer chk_batch', {
      db: adapter,
      cache: env.CHECK_CACHE_KV,
      policyApiSecret: 'policy-secret',
    });
  });

  it('answers 401 to an unauthenticated caller', async () => {
    fns.authenticate.mockResolvedValue({ authenticated: false });
    const response = await batch({ checks: [CHECK] });
    expect(response.status).toBe(401);
    expect(errorCall().code).toBe(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    expect(fns.checkRateLimit).not.toHaveBeenCalled();
  });

  it('answers 403 when the credential may not batch', async () => {
    fns.authenticate.mockResolvedValue({ ...tenantAuth, allowedOperations: ['check'] });
    const response = await batch({ checks: [CHECK] });
    expect(response.status).toBe(403);
    expect(errorCall().code).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    expect(fns.checkRateLimit).not.toHaveBeenCalled();
  });

  it('rate-limits with the authenticated credential and the limiter binding', async () => {
    const env = makeEnv();
    await batch({ checks: [CHECK] }, env);
    expect(fns.checkRateLimit).toHaveBeenCalledWith(policySecretAuth, {
      limiter: env.RATE_LIMITER,
    });
  });

  it('fails closed with 503 when the limiter is unavailable', async () => {
    fns.checkRateLimit.mockRejectedValue(new RateLimiterUnavailableError());
    const response = await batch({ checks: [CHECK] });
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The service is temporarily unavailable. Please try again later.',
    });
    expect(fns.createService).not.toHaveBeenCalled();
  });

  it('answers 429 with the retry hint and the rate limit headers', async () => {
    fns.checkRateLimit.mockResolvedValue({ ...allowedRate, allowed: false, retryAfter: 9 });
    const response = await batch({ checks: [CHECK] });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'slow_down',
      error_description: 'Too many requests. Please retry later.',
      retry_after: 9,
    });
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000000');
    expect(response.headers.get('Retry-After')).toBe('9');
    expect(fns.createService).not.toHaveBeenCalled();
  });
});

describe('POST /batch request validation', () => {
  it.each([
    ['no checks', {}],
    ['null checks', { checks: null }],
    ['a string', { checks: 'documents:read' }],
    ['an object', { checks: { length: 1, 0: CHECK } }],
    ['an empty array', { checks: [] }],
  ])('requires a non-empty checks array (%s)', async (_label, body) => {
    const response = await batch(body);
    expect(response.status).toBe(400);
    expect(errorCall()).toEqual({
      code: AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD,
      options: { variables: { field: 'checks' } },
    });
    expect(fns.batchCheck).not.toHaveBeenCalled();
  });

  it('allows exactly the configured number of checks and rejects one more', async () => {
    settingsReturning({
      flags: { 'feature.enable_check_api': true },
      limits: { 'limits.check_api_batch_size': 3 },
    });
    expect((await batch({ checks: [CHECK, CHECK, CHECK] })).status).toBe(200);
    await expectInvalid({ checks: [CHECK, CHECK, CHECK, CHECK] });
  });

  it('defaults the limit to 100 checks', async () => {
    const many = (n: number) => ({ checks: Array.from({ length: n }, () => CHECK) });
    expect((await batch(many(100))).status).toBe(200);
    await expectInvalid(many(101));
  });

  it('validates every check, including the last', async () => {
    await expectInvalid({ checks: [CHECK, CHECK, { ...CHECK, subject_id: '' }] });
    await expectInvalid({ checks: [CHECK, { ...CHECK, permission: '' }] });
    await expectInvalid({ checks: [{ permission: 'documents:read' }] });
    await expectInvalid({ checks: [{ subject_id: 'u' }] });
  });

  it('rejects an unparsable permission without leaking the parser error', async () => {
    await expectInvalid({ checks: [{ ...CHECK, permission: 'x' }] });
    expect(logger.debug).toHaveBeenCalledWith('Batch permission parse error', {
      error: anyString,
    });
  });

  it('accepts checks without rebac and with valid rebac', async () => {
    expect((await batch({ checks: [CHECK] })).status).toBe(200);
    expect((await batch(withRebac({ relation: 'viewer', object: 'doc:1' }))).status).toBe(200);
  });

  it.each([
    ['missing relation', { object: 'doc:1' }],
    ['non-string relation', { relation: 7, object: 'doc:1' }],
    ['missing object', { relation: 'viewer' }],
    ['non-string object', { relation: 'viewer', object: 7 }],
  ])('rejects rebac with %s', async (_label, rebac) => {
    await expectInvalid(withRebac(rebac));
  });

  it('rejects contextual_tuples that are not an array', async () => {
    await expectInvalid(withTuples('nope'));
    await expectInvalid(withTuples({ length: 0 }));
  });

  it('accepts empty and valid contextual_tuples', async () => {
    expect((await batch(withTuples([]))).status).toBe(200);
    expect((await batch(withTuples([TUPLE]))).status).toBe(200);
  });

  it('allows exactly 100 contextual tuples and rejects 101 with a warning naming the check', async () => {
    const hundred = Array.from({ length: 100 }, () => TUPLE);
    expect((await batch(withTuples(hundred))).status).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();

    await expectInvalid(withTuples([...hundred, TUPLE]));
    expect(logger.warn).toHaveBeenCalledWith('Batch contextual tuples limit exceeded', {
      checkIndex: 1,
      count: 101,
      limit: 100,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'tuple'],
    ['a number', 5],
    ['an empty array', []],
  ])('rejects %s as a tuple', async (_label, bad) => {
    await expectInvalid(withTuples([TUPLE, bad]));
  });

  it.each(['user_id', 'relation', 'object'])(
    'rejects a tuple whose %s is missing, empty or not a string',
    async (key) => {
      await expectInvalid(withTuples([TUPLE, { ...TUPLE, [key]: undefined }]));
      await expectInvalid(withTuples([TUPLE, { ...TUPLE, [key]: '' }]));
      await expectInvalid(withTuples([TUPLE, { ...TUPLE, [key]: 12 }]));
    }
  );
});

describe('POST /batch tenant resolution', () => {
  it('refuses a system-secret check that names no tenant', async () => {
    const response = await batch({ checks: [CHECK, { subject_id: 'u', permission: 'a:read' }] });
    expect(response.status).toBe(403);
    expect(errorCall().code).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    expect(fns.batchCheck).not.toHaveBeenCalled();
  });

  it('refuses a tenant-bound credential naming another tenant in any check', async () => {
    fns.authenticate.mockResolvedValue(tenantAuth);
    const response = await batch({ checks: [CHECK, { ...CHECK, tenant_id: 'tenant-b' }] });
    expect(response.status).toBe(403);
    expect(fns.batchCheck).not.toHaveBeenCalled();
  });

  it('fills the credential tenant into checks that name none', async () => {
    fns.authenticate.mockResolvedValue(tenantAuth);
    const { tenant_id: _omitted, ...noTenant } = CHECK;
    await batch({ checks: [noTenant, CHECK] });
    const { request } = firstBatchCall();
    expect(request.checks.map((c) => c.tenant_id)).toEqual(['tenant-a', 'tenant-a']);
  });
});

describe('POST /batch execution', () => {
  it('runs every normalized check with the audit options and returns the result', async () => {
    fns.authenticate.mockResolvedValue(tenantAuth);
    fns.batchCheck.mockResolvedValue({ results: [{ allowed: true }], summary: { total: 1 } });
    const rebac = { relation: 'viewer', object: 'doc:1' };
    const response = await batch(
      {
        checks: [
          { ...CHECK, rebac, resource_context: { owner: 'u' } },
          { ...CHECK, subject_id: 'svc', subject_type: 'service', tenant_id: 'tenant-a' },
        ],
        stop_on_deny: true,
      },
      makeEnv(),
      { 'X-Request-ID': 'req-5' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ allowed: true }], summary: { total: 1 } });
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000000');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(fns.batchCheck).toHaveBeenCalledTimes(1);
    expect(fns.batchCheck.mock.calls[0]).toEqual([
      {
        checks: [
          { ...CHECK, rebac, resource_context: { owner: 'u' }, subject_type: 'user' },
          {
            subject_id: 'svc',
            subject_type: 'service',
            permission: 'documents:read',
            tenant_id: 'tenant-a',
          },
        ],
        stop_on_deny: true,
      },
      { ctx: executionCtx, apiKeyId: 'key-2', clientId: 'client-2', requestId: 'req-5' },
    ]);
  });

  it('leaves stop_on_deny and requestId unset when not given', async () => {
    await batch({ checks: [CHECK] });
    const { request, options } = firstBatchCall();
    expect(request.stop_on_deny).toBeUndefined();
    expect(options.requestId).toBeUndefined();
  });

  it('answers 500 and logs when the batch throws', async () => {
    const failure = new Error('db down');
    fns.batchCheck.mockRejectedValue(failure);
    const response = await batch({ checks: [CHECK] });
    expect(response.status).toBe(500);
    expect(errorCall().code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(logger.error).toHaveBeenCalledWith(
      'Batch check error',
      { error: 'Error: db down' },
      failure
    );
  });

  it('answers 500 for an unreadable body', async () => {
    const response = await postJson(checkRoutes, '/batch', '{oops');
    expect(response.status).toBe(500);
    expect(errorCall().code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

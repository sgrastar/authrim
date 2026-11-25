import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  auditService,
  errorBody,
  errorCall,
  executionCtx,
  fns,
  loggerNames,
  logger,
  makeEnv,
  policySecretAuth,
  postJson,
  serviceConfig,
  firstCheckCall,
  rebacService,
  repositories,
  resetMocks,
  settingsReturning,
  tenantAuth,
  allowedRate,
} from './check-mutation-mocks';

const VALID = { subject_id: 'user_1', permission: 'documents:read', tenant_id: 'tenant-a' };

function getHealth(env: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(checkRoutes.request('/health', {}, env, executionCtx));
}

const anyString: unknown = expect.any(String);

beforeEach(resetMocks);
afterEach(() => vi.useRealTimers());

describe('logger', () => {
  it('is created for the CHECK-API module', () => {
    expect(loggerNames).toContain('CHECK-API');
  });
});

describe('GET /health', () => {
  it('reports the platform state with the fixed service identity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
    settingsReturning({
      flags: { 'feature.enable_check_api': true },
      limits: { 'limits.check_api_batch_size': 250 },
    });
    const env = makeEnv({ ENABLE_CHECK_API_DEBUG: 'true' });
    const response = await getHealth(env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'check-api',
      version: '0.1.0',
      timestamp: '2026-01-02T03:04:05.678Z',
      enabled: true,
      database: true,
      cache: true,
      debug_mode: true,
      batch_size_limit: 250,
    });
    expect(fns.resolveSettings).toHaveBeenCalledWith(env, 'feature-flags', {});
    expect(fns.resolveSettings).toHaveBeenCalledWith(env, 'limits', {});
    expect(fns.resolveOptional).toHaveBeenCalledTimes(1);
    expect(fns.resolveOptional.mock.calls[0]?.[1]).toBe('policy-health');
  });

  it.each([
    ['enabled without a database', true, false, 'limited'],
    ['a database while disabled', false, true, 'limited'],
    ['neither', false, false, 'limited'],
    ['both', true, true, 'ok'],
  ])('status for %s', async (_label, enabled, database, status) => {
    settingsReturning({ flags: { 'feature.enable_check_api': enabled } });
    fns.resolveOptional.mockReturnValue(database ? adapter : null);
    const body = await (await getHealth(makeEnv())).json<Record<string, unknown>>();
    expect(body.status).toBe(status);
    expect(body.enabled).toBe(enabled);
    expect(body.database).toBe(database);
  });

  it('reports no cache and debug off unless exactly configured', async () => {
    const env = makeEnv({ CHECK_CACHE_KV: undefined, ENABLE_CHECK_API_DEBUG: 'TRUE' });
    const body = await (await getHealth(env)).json<Record<string, unknown>>();
    expect(body.cache).toBe(false);
    expect(body.debug_mode).toBe(false);
    expect(body.batch_size_limit).toBe(100);
  });

  it('logs a failed settings read and keeps the other value', async () => {
    const failure = new Error('limits down');
    settingsReturning({ flags: { 'feature.enable_check_api': true }, limits: failure });
    const env = makeEnv({ CHECK_API_BATCH_SIZE_LIMIT: '42' });
    const body = await (await getHealth(env)).json<Record<string, unknown>>();
    expect(body.enabled).toBe(true);
    expect(body.batch_size_limit).toBe(42);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to read Check API settings',
      { error: 'Error: limits down' },
      failure
    );
  });
});

describe('POST / gates', () => {
  it('rejects while the Check API is off, before authenticating', async () => {
    settingsReturning({ flags: { 'feature.enable_check_api': false } });
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(403);
    expect((await errorBody(response)).error_code).toBe('AR050001');
    expect(fns.authenticate).not.toHaveBeenCalled();
  });

  it('authenticates with the header and the route collaborators', async () => {
    const env = makeEnv();
    await postJson(checkRoutes, '/', VALID, env, { Authorization: 'Bearer chk_abc' });
    expect(fns.authenticate).toHaveBeenCalledWith('Bearer chk_abc', {
      db: adapter,
      cache: env.CHECK_CACHE_KV,
      policyApiSecret: 'policy-secret',
    });
  });

  it('answers 401 to an unauthenticated caller', async () => {
    fns.authenticate.mockResolvedValue({ authenticated: false });
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(401);
    expect(errorCall().code).toBe(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    expect(fns.checkRateLimit).not.toHaveBeenCalled();
  });

  it('answers 403 when the credential may not check', async () => {
    fns.authenticate.mockResolvedValue({ ...tenantAuth, allowedOperations: ['batch'] });
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(403);
    expect(errorCall().code).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    expect(fns.checkRateLimit).not.toHaveBeenCalled();
  });

  it('rate-limits with the authenticated credential and the limiter binding', async () => {
    const env = makeEnv();
    await postJson(checkRoutes, '/', VALID, env);
    expect(fns.checkRateLimit).toHaveBeenCalledWith(policySecretAuth, {
      limiter: env.RATE_LIMITER,
    });
  });

  it('fails closed with 503 when the limiter is unavailable', async () => {
    fns.checkRateLimit.mockRejectedValue(new RateLimiterUnavailableError());
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The service is temporarily unavailable. Please try again later.',
    });
    expect(fns.createService).not.toHaveBeenCalled();
  });

  it('does not turn other limiter failures into 503', async () => {
    fns.checkRateLimit.mockRejectedValue(new Error('boom'));
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(500);
    expect(fns.createService).not.toHaveBeenCalled();
  });

  it('answers 429 with the retry hint and the rate limit headers', async () => {
    fns.checkRateLimit.mockResolvedValue({ ...allowedRate, allowed: false, retryAfter: 17 });
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'slow_down',
      error_description: 'Too many requests. Please retry later.',
      retry_after: 17,
    });
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000000');
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(fns.check).not.toHaveBeenCalled();
    expect(fns.createService).not.toHaveBeenCalled();
  });
});

describe('POST / validation', () => {
  async function rejected(body: unknown, field?: string) {
    fns.check.mockClear();
    clearErrorCalls();
    const response = await postJson(checkRoutes, '/', body);
    expect(response.status).toBe(400);
    const { code, options } = errorCall();
    if (field === undefined) {
      expect(code).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      expect(options).toBeUndefined();
    } else {
      expect(code).toBe(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD);
      expect(options).toEqual({ variables: { field } });
    }
    expect(fns.check).not.toHaveBeenCalled();
  }

  it('requires subject_id and permission', async () => {
    await rejected({ permission: 'documents:read' }, 'subject_id');
    await rejected({ subject_id: 'u' }, 'permission');
  });

  it('rejects an unparsable permission without leaking the parser error', async () => {
    const response = await postJson(checkRoutes, '/', { ...VALID, permission: 'x' });
    expect(response.status).toBe(400);
    expect(errorCall()).toEqual({
      code: AR_ERROR_CODES.VALIDATION_INVALID_VALUE,
      options: undefined,
    });
    expect(logger.debug).toHaveBeenCalledWith('Permission parse error', {
      error: anyString,
    });
  });

  it('accepts a request without rebac and with a valid rebac', async () => {
    expect((await postJson(checkRoutes, '/', VALID)).status).toBe(200);
    const rebac = { relation: 'viewer', object: 'doc:1' };
    expect((await postJson(checkRoutes, '/', { ...VALID, rebac })).status).toBe(200);
  });

  it.each([
    ['missing relation', { object: 'doc:1' }, 'rebac.relation'],
    ['non-string relation', { relation: 7, object: 'doc:1' }, 'rebac.relation'],
    ['missing object', { relation: 'viewer' }, 'rebac.object'],
    ['non-string object', { relation: 'viewer', object: 7 }, 'rebac.object'],
  ])('rejects rebac with %s', async (_label, rebac, field) => {
    await rejected({ ...VALID, rebac }, field);
  });

  it('rejects contextual_tuples that are not an array', async () => {
    const rebac = { relation: 'viewer', object: 'doc:1', contextual_tuples: 'nope' };
    await rejected({ ...VALID, rebac });
    await rejected({ ...VALID, rebac: { ...rebac, contextual_tuples: {} } });
    await rejected({ ...VALID, rebac: { ...rebac, contextual_tuples: 5 } });
  });

  const tuple = { user_id: 'u', relation: 'r', object: 'o' };
  const withTuples = (tuples: unknown[]) => ({
    ...VALID,
    rebac: { relation: 'viewer', object: 'doc:1', contextual_tuples: tuples },
  });

  it('accepts an empty and a valid contextual_tuples array', async () => {
    expect((await postJson(checkRoutes, '/', withTuples([]))).status).toBe(200);
    expect((await postJson(checkRoutes, '/', withTuples([tuple]))).status).toBe(200);
  });

  it('allows exactly 100 contextual tuples and rejects 101 with a warning', async () => {
    const hundred = Array.from({ length: 100 }, () => tuple);
    expect((await postJson(checkRoutes, '/', withTuples(hundred))).status).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();

    await rejected(withTuples([...hundred, tuple]));
    expect(logger.warn).toHaveBeenCalledWith('Contextual tuples limit exceeded', {
      count: 101,
      limit: 100,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'tuple'],
    ['a number', 5],
  ])('rejects %s as a tuple with the generic invalid-value error', async (_label, bad) => {
    await rejected(withTuples([tuple, bad]));
  });

  it.each([
    ['user_id', 'rebac.contextual_tuples[1].user_id'],
    ['relation', 'rebac.contextual_tuples[1].relation'],
    ['object', 'rebac.contextual_tuples[1].object'],
  ])('rejects a tuple whose %s is missing or not a string', async (key, field) => {
    await rejected(withTuples([tuple, { ...tuple, [key]: undefined }]), field);
    await rejected(withTuples([tuple, { ...tuple, [key]: 12 }]), field);
    await rejected(withTuples([tuple, { ...tuple, [key]: '' }]), field);
  });

  it('reports the index of the first bad tuple', async () => {
    await rejected(
      withTuples([{ ...tuple, user_id: 3 }, tuple]),
      'rebac.contextual_tuples[0].user_id'
    );
  });
});

describe('POST / tenant resolution', () => {
  it('refuses a system-secret request that names no tenant', async () => {
    const response = await postJson(checkRoutes, '/', {
      subject_id: 'u',
      permission: 'documents:read',
    });
    expect(response.status).toBe(403);
    expect(errorCall().code).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    expect(fns.check).not.toHaveBeenCalled();
  });

  it('refuses a tenant-bound credential naming another tenant', async () => {
    fns.authenticate.mockResolvedValue(tenantAuth);
    const response = await postJson(checkRoutes, '/', { ...VALID, tenant_id: 'tenant-b' });
    expect(response.status).toBe(403);
    expect(fns.check).not.toHaveBeenCalled();
  });

  it('uses the credential tenant when the body names none', async () => {
    fns.authenticate.mockResolvedValue(tenantAuth);
    const { tenant_id: _omitted, ...noTenant } = VALID;
    await postJson(checkRoutes, '/', noTenant);
    expect(fns.check.mock.calls[0]?.[0]).toMatchObject({ tenant_id: 'tenant-a' });
  });
});

describe('POST / execution', () => {
  it('runs the check with the audit options and returns the result with rate headers', async () => {
    fns.authenticate.mockResolvedValue(tenantAuth);
    fns.check.mockResolvedValue({ allowed: false, final_decision: 'deny' });
    const resourceContext = { owner: 'u' };
    const rebac = { relation: 'viewer', object: 'doc:1' };
    const response = await postJson(
      checkRoutes,
      '/',
      { ...VALID, subject_type: 'service', resource_context: resourceContext, rebac },
      makeEnv(),
      { 'X-Request-ID': 'req-77' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: false, final_decision: 'deny' });
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000000');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(fns.check).toHaveBeenCalledTimes(1);
    expect(fns.check.mock.calls[0]).toEqual([
      {
        subject_id: 'user_1',
        subject_type: 'service',
        permission: 'documents:read',
        tenant_id: 'tenant-a',
        resource_context: resourceContext,
        rebac,
      },
      { ctx: executionCtx, apiKeyId: 'key-2', clientId: 'client-2', requestId: 'req-77' },
    ]);
  });

  it('defaults the subject type to user and leaves requestId unset without the header', async () => {
    await postJson(checkRoutes, '/', VALID);
    const { request, options } = firstCheckCall();
    expect(request.subject_type).toBe('user');
    expect(options.requestId).toBeUndefined();
  });

  it('answers 500 and logs when the check throws', async () => {
    const failure = new Error('db down');
    fns.check.mockRejectedValue(failure);
    const response = await postJson(checkRoutes, '/', VALID);
    expect(response.status).toBe(500);
    expect(errorCall().code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(logger.error).toHaveBeenCalledWith('Check error', { error: 'Error: db down' }, failure);
  });

  it('answers 500 for an unreadable body', async () => {
    const response = await postJson(checkRoutes, '/', '{not json');
    expect(response.status).toBe(500);
    expect(errorCall().code).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('check service wiring', () => {
  async function wiredConfig(env: Record<string, unknown>) {
    await postJson(checkRoutes, '/', VALID, env);
    expect(fns.createService).toHaveBeenCalledTimes(1);
    return serviceConfig();
  }

  it('builds the service from the core adapter, caches and rebac service', async () => {
    const env = makeEnv();
    const config = await wiredConfig(env);
    expect(fns.createRebac).toHaveBeenCalledWith(adapter, env.REBAC_CACHE_KV);
    expect(config.db).toBe(adapter);
    expect(config.cache).toBe(env.CHECK_CACHE_KV);
    expect(config.rebacService).toBe(rebacService);
    expect(config.cacheTTL).toBe(60);
    expect(config.debugMode).toBe(false);
    expect(config.auditService).toBeUndefined();
    expect(fns.createAudit).not.toHaveBeenCalled();
    expect(repositories).toHaveLength(1);
    expect(config.attributeRepository).toBe(repositories[0]);
    expect(repositories[0]?.db).toBe(adapter);
  });

  it('turns debug mode on only for the exact string true', async () => {
    expect((await wiredConfig(makeEnv({ ENABLE_CHECK_API_DEBUG: 'true' }))).debugMode).toBe(true);
  });

  it('resolves a subject database through the account data context', async () => {
    const env = makeEnv();
    const coreDb = { name: 'account-db' };
    fns.resolveAccount.mockResolvedValue({ coreDb });
    const config = await wiredConfig(env);
    expect(await config.subjectAccountDb('tenant-a', 'user_1')).toBe(coreDb);
    expect(fns.resolveAccount).toHaveBeenCalledWith(env, {
      tenantId: 'tenant-a',
      accountId: 'user_1',
    });
  });

  it('resolves tenant policy through the tenant policy resolver', async () => {
    const env = makeEnv();
    const config = await wiredConfig(env);
    const policy = await config.tenantPolicy('tenant-a');
    expect(policy).toEqual({ name: 'tenant-policy' });
    expect(fns.resolveTenantPolicy).toHaveBeenCalledWith(env, adapter, 'tenant-a');
  });

  it('creates the audit service from the Settings API values when auditing is on', async () => {
    settingsReturning({
      flags: { 'feature.enable_check_api': true },
      audit: {
        'audit.check_api_enabled': true,
        'audit.check_api_mode': 'sync',
        'audit.check_api_log_allow': 'always',
        'audit.check_api_sample_rate': 0.5,
        'audit.check_api_retention_days': 30,
      },
    });
    const env = makeEnv();
    const config = await wiredConfig(env);
    expect(fns.resolveSettings).toHaveBeenCalledWith(env, 'check-api-audit', {});
    expect(fns.createAudit).toHaveBeenCalledWith(env, {
      mode: 'sync',
      logDeny: 'always',
      logAllow: 'always',
      sampleRate: 0.5,
      retentionDays: 30,
    });
    expect(config.auditService).toBe(auditService);
  });

  it('keeps auditing on with defaults when the audit settings cannot be read', async () => {
    const failure = new Error('audit settings down');
    settingsReturning({ flags: { 'feature.enable_check_api': true }, audit: failure });
    await wiredConfig(makeEnv());
    expect(fns.createAudit).toHaveBeenCalledTimes(1);
    expect(fns.createAudit.mock.calls[0]?.[1]).toEqual({
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.01,
      retentionDays: 90,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to read Check API audit settings',
      { error: 'Error: audit settings down' },
      failure
    );
  });
});

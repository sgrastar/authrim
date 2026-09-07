import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJsonWithTimeout: vi.fn(),
  resolveGeneratedSmokeTarget: vi.fn(),
  createContext: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('../core/generated-smoke-common.js', () => ({
  fetchJsonWithTimeout: mocks.fetchJsonWithTimeout,
  isRecord: (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
  resolveGeneratedSmokeTarget: mocks.resolveGeneratedSmokeTarget,
}));
vi.mock('../core/generated-approval-load-context.js', () => ({
  createGeneratedApprovalLoadContext: mocks.createContext,
}));

import {
  resolveGeneratedLocalCapacityPlan,
  runGeneratedLocalCapacity,
} from '../core/generated-local-capacity.js';

const context = {
  env: 'test',
  baseUrl: 'https://router.example',
  configPath: '/tmp/config.json',
  adminSecretPath: '/tmp/admin-secret',
  adminSecret: 'admin-secret',
  tenantId: 'tenant-a',
  userId: 'user-1',
  requestId: 'request-1',
  grantId: 'grant-1',
  clientId: 'client-1',
  clientSecret: 'client-secret',
  subjectToken: 'subject-token',
  downstreamAccessToken: 'access-token',
  protectedResourcePath: '/api/protected/customer-profiles/user-1',
  checks: [{ id: 'bootstrap', details: ['ready'] }],
  cleanup: mocks.cleanup,
};

describe('generated local capacity runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGeneratedSmokeTarget.mockResolvedValue({
      env: 'test',
      baseUrl: 'https://router.example',
      configPath: '/tmp/config.json',
    });
    mocks.createContext.mockResolvedValue(context);
    mocks.cleanup.mockResolvedValue([{ id: 'cleanup', details: ['removed'] }]);
    mocks.fetchJsonWithTimeout.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/registration-fields')) {
        return { ok: true, status: 200, payload: { fields: [] } };
      }
      if (url.includes('/api/protected/')) {
        return { ok: true, status: 200, payload: { profile: { sub: 'user-1' } } };
      }
      if (url.endsWith('/token')) {
        return { ok: true, status: 200, payload: { access_token: 'token' } };
      }
      if (url.endsWith('/introspect')) {
        return { ok: true, status: 200, payload: { active: true } };
      }
      throw new Error(`unexpected:${url}`);
    });
  });

  it('applies documented defaults and validates every plan bound', () => {
    expect(resolveGeneratedLocalCapacityPlan({} as never)).toEqual({
      scenario: 'mixed',
      lps: 25,
      durationSeconds: 30,
      maxInFlight: 100,
    });
    expect(
      resolveGeneratedLocalCapacityPlan({
        scenario: 'introspection',
        lps: 500,
        durationSeconds: 300,
        maxInFlight: 2000,
      } as never)
    ).toEqual({ scenario: 'introspection', lps: 500, durationSeconds: 300, maxInFlight: 2000 });
    for (const options of [
      { scenario: 'unknown' },
      { lps: 0 },
      { lps: Number.NaN },
      { lps: 501 },
      { durationSeconds: 0 },
      { durationSeconds: Number.POSITIVE_INFINITY },
      { durationSeconds: 301 },
      { maxInFlight: 0 },
      { maxInFlight: Number.NaN },
      { maxInFlight: 2001 },
    ]) {
      expect(() => resolveGeneratedLocalCapacityPlan(options as never)).toThrow(/^invalid_/);
    }
  });

  it.each([
    'registration-fields',
    'protected-resource',
    'token-exchange',
    'introspection',
  ] as const)(
    'runs one successful %s request and cleans up only bootstrapped contexts',
    async (scenario) => {
      const result = await runGeneratedLocalCapacity({
        scenario,
        lps: 1,
        durationSeconds: 0.001,
        maxInFlight: 1,
        timeoutMs: 50,
      });
      expect(result).toMatchObject({
        ok: true,
        scenario,
        totalRequests: 1,
        successCount: 1,
        failureCount: 0,
        successRate: 1,
        statusCounts: { '200': 1 },
        localCapacityNotes: expect.any(Array),
      });
      if (scenario === 'registration-fields') {
        expect(mocks.createContext).not.toHaveBeenCalled();
        expect(mocks.cleanup).not.toHaveBeenCalled();
        expect(result.bootstrapChecks).toEqual([]);
      } else {
        expect(mocks.createContext).toHaveBeenCalledOnce();
        expect(mocks.cleanup).toHaveBeenCalledOnce();
        expect(result.bootstrapChecks).toEqual(['bootstrap: ready']);
        expect(result.cleanupNotes).toEqual(['cleanup: removed']);
      }
    }
  );

  it('rotates all request types in mixed mode', async () => {
    const result = await runGeneratedLocalCapacity({
      scenario: 'mixed',
      lps: 400,
      durationSeconds: 0.01,
      maxInFlight: 2,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ ok: true, totalRequests: 4, successCount: 4 });
    expect(mocks.fetchJsonWithTimeout.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/api/protected/'),
        expect.stringContaining('/token'),
        expect.stringContaining('/introspect'),
        expect.stringContaining('/api/v1/registration-fields'),
      ])
    );
  });

  it('records HTTP semantic failures, thrown failures, status counts, and samples', async () => {
    mocks.fetchJsonWithTimeout
      .mockResolvedValueOnce({ ok: false, status: 503, error: 'unavailable' })
      .mockRejectedValueOnce('network down');
    const failed = await runGeneratedLocalCapacity({
      scenario: 'registration-fields',
      lps: 2,
      durationSeconds: 0.5,
      maxInFlight: 2,
    });
    expect(failed).toMatchObject({
      ok: false,
      totalRequests: 1,
      failureCount: 1,
      successRate: 0,
      statusCounts: { '503': 1 },
      failureSamples: ['503 unavailable'],
    });

    const thrown = await runGeneratedLocalCapacity({
      scenario: 'registration-fields',
      lps: 2,
      durationSeconds: 0.5,
      maxInFlight: 2,
    });
    expect(thrown).toMatchObject({
      ok: false,
      statusCounts: { '0': 1 },
      failureSamples: ['network down'],
    });
  });

  it('fails protected-resource, exchange, and introspection checks on malformed success payloads', async () => {
    for (const [scenario, response] of [
      ['protected-resource', { ok: true, status: 200, payload: { profile: { sub: 'other' } } }],
      ['token-exchange', { ok: true, status: 200, payload: {} }],
      ['introspection', { ok: true, status: 200, payload: { active: false } }],
    ] as const) {
      mocks.fetchJsonWithTimeout.mockResolvedValueOnce(response);
      const result = await runGeneratedLocalCapacity({
        scenario,
        lps: 1,
        durationSeconds: 0.001,
      });
      expect(result).toMatchObject({ ok: false, failureCount: 1 });
    }
  });

  it('always invokes cleanup when request execution fails', async () => {
    mocks.fetchJsonWithTimeout.mockRejectedValueOnce(new Error('request failed'));
    await runGeneratedLocalCapacity({
      scenario: 'protected-resource',
      lps: 1,
      durationSeconds: 0.001,
    });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJsonWithTimeout: vi.fn(),
  readAdminSecret: vi.fn(),
  resolveTarget: vi.fn(),
  withTenantHeader: vi.fn((headers: Record<string, string>, tenant?: string) =>
    tenant ? { ...headers, 'X-Tenant-Id': tenant } : headers
  ),
  approvalsSmoke: vi.fn(),
  createContext: vi.fn(),
  adminCleanup: vi.fn(),
  contextCleanup: vi.fn(),
}));

vi.mock('../core/generated-smoke-common.js', () => ({
  fetchJsonWithTimeout: mocks.fetchJsonWithTimeout,
  isRecord: (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
  readGeneratedAdminApiSecret: mocks.readAdminSecret,
  resolveGeneratedSmokeTarget: mocks.resolveTarget,
  withTenantHeader: mocks.withTenantHeader,
}));
vi.mock('../core/generated-approvals-smoke.js', () => ({
  runGeneratedApprovalsSmoke: mocks.approvalsSmoke,
}));
vi.mock('../core/generated-approval-load-context.js', () => ({
  createGeneratedApprovalLoadContext: mocks.createContext,
}));

import { runGeneratedLoadAbuse } from '../core/generated-load-abuse.js';

const context = {
  env: 'test',
  baseUrl: 'https://router.example',
  configPath: '/tmp/config.json',
  adminSecretPath: '/tmp/admin',
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
  cleanup: mocks.contextCleanup,
};

describe('generated load and abuse orchestration', () => {
  let strictValidation = true;

  beforeEach(() => {
    vi.clearAllMocks();
    strictValidation = true;
    mocks.resolveTarget.mockResolvedValue({
      env: 'test',
      baseUrl: 'https://router.example',
      configPath: '/tmp/config.json',
      baseDir: '/tmp',
      tenantId: 'tenant-a',
      config: {},
    });
    mocks.readAdminSecret.mockResolvedValue({
      secret: 'admin-secret',
      path: '/tmp/admin',
      cleanup: mocks.adminCleanup,
    });
    mocks.createContext.mockResolvedValue(context);
    mocks.contextCleanup.mockResolvedValue([{ id: 'cleanup', details: ['removed'] }]);
    mocks.approvalsSmoke.mockResolvedValue({ ok: true, checks: [] });
    mocks.fetchJsonWithTimeout.mockImplementation(
      async (url: string, _timeout: number, init?: globalThis.RequestInit) => {
        const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (url.endsWith('/api/admin/approvals')) return { ok: true, status: 200, payload: {} };
        if (url.endsWith('/api/admin/settings/introspection-validation')) {
          if (init?.method === 'PUT') {
            strictValidation = JSON.parse(String(init.body)).strictValidation;
            return { ok: true, status: 200, payload: {} };
          }
          return {
            ok: true,
            status: 200,
            payload: {
              settings: { strictValidation: { value: strictValidation, source: 'tenant' } },
            },
          };
        }
        if (url.endsWith('/api/v1/registration-fields'))
          return { ok: true, status: 200, payload: {} };
        if (url.includes('/api/admin/runtime-profiles'))
          return { ok: true, status: 200, payload: {} };
        if (url.endsWith('/token')) {
          const body = String(init?.body);
          return body.includes('.tampered')
            ? { ok: false, status: 400, payload: { error: 'invalid_grant' } }
            : { ok: true, status: 200, payload: { access_token: 'token' } };
        }
        if (url.endsWith('/introspect'))
          return { ok: true, status: 200, payload: { active: true } };
        if (url.includes('/api/protected/')) {
          return authorization === 'Bearer invalid-token'
            ? { ok: false, status: 401, payload: { error: 'invalid_token' } }
            : { ok: true, status: 200, payload: { profile: { sub: 'user-1' } } };
        }
        throw new Error(`unexpected:${url}`);
      }
    );
  });

  it('skips load safely when machine access cannot read approvals and always cleans temp access', async () => {
    mocks.fetchJsonWithTimeout.mockResolvedValueOnce({ ok: false, status: 403, payload: {} });
    const result = await runGeneratedLoadAbuse({ profile: 'medium' });
    expect(result).toEqual({
      ok: true,
      env: 'test',
      baseUrl: 'https://router.example',
      configPath: '/tmp/config.json',
      profile: 'medium',
      bootstrapChecks: [expect.stringContaining('skipped')],
      stages: [],
      cleanupNotes: [],
      interStageCooldownsMs: [],
    });
    expect(mocks.adminCleanup).toHaveBeenCalledOnce();
    expect(mocks.createContext).not.toHaveBeenCalled();
  });

  it('runs all safe load and negative-abuse stages and restores strict validation', async () => {
    const result = await runGeneratedLoadAbuse({ profile: 'safe' });
    expect(result.ok).toBe(true);
    expect(result.profile).toBe('safe');
    expect(result.stages.map((stage) => stage.id)).toEqual([
      'registration-fields-read',
      'runtime-profile-list-read',
      'approval-flow-concurrency',
      'token-exchange-load',
      'introspection-load',
      'protected-resource-load',
      'abuse-invalid-token-exchange',
      'abuse-unauthorized-protected-resource',
    ]);
    expect(result.stages.every((stage) => stage.failureCount === 0)).toBe(true);
    expect(result.bootstrapChecks).toEqual(['bootstrap: ready']);
    expect(result.cleanupNotes).toEqual(['cleanup: removed']);
    expect(strictValidation).toBe(true);
    expect(mocks.contextCleanup).toHaveBeenCalledOnce();
    const putBodies = mocks.fetchJsonWithTimeout.mock.calls
      .filter(([, , init]) => init?.method === 'PUT')
      .map(([, , init]) => JSON.parse(String(init.body)).strictValidation);
    expect(putBodies).toEqual([false, true]);
  });

  it('does not rewrite introspection setting when already disabled', async () => {
    strictValidation = false;
    const result = await runGeneratedLoadAbuse({});
    expect(result.ok).toBe(true);
    expect(mocks.fetchJsonWithTimeout.mock.calls.some(([, , init]) => init?.method === 'PUT')).toBe(
      false
    );
  });

  it('reports stage semantic failures while still cleaning up', async () => {
    mocks.approvalsSmoke.mockResolvedValueOnce({
      ok: false,
      checks: [{ id: 'approval', status: 'fail', details: ['failed'] }],
    });
    const result = await runGeneratedLoadAbuse({});
    expect(result.ok).toBe(false);
    expect(result.stages.find((stage) => stage.id === 'approval-flow-concurrency')).toMatchObject({
      failureCount: 1,
      failureSamples: ['approval: failed'],
    });
    expect(mocks.contextCleanup).toHaveBeenCalledOnce();
  });

  it('records cleanup note if strict-validation restoration fails', async () => {
    let putCount = 0;
    const implementation = mocks.fetchJsonWithTimeout.getMockImplementation()!;
    mocks.fetchJsonWithTimeout.mockImplementation(
      async (...args: Parameters<typeof implementation>) => {
        if (args[2]?.method === 'PUT') {
          putCount += 1;
          if (putCount === 2) return { ok: false, status: 500, error: 'restore failed' };
        }
        return implementation(...args);
      }
    );
    const result = await runGeneratedLoadAbuse({});
    expect(result.cleanupNotes).toEqual([
      expect.stringContaining('load_introspection_validation_put_failed'),
      'cleanup: removed',
    ]);
  });

  it('fails fast when introspection settings cannot be read or written', async () => {
    const implementation = mocks.fetchJsonWithTimeout.getMockImplementation()!;
    mocks.fetchJsonWithTimeout.mockImplementation(
      async (...args: Parameters<typeof implementation>) => {
        if (String(args[0]).endsWith('/api/admin/settings/introspection-validation')) {
          return { ok: false, status: 503, error: 'settings unavailable' };
        }
        return implementation(...args);
      }
    );
    await expect(runGeneratedLoadAbuse({})).rejects.toThrow(
      'load_introspection_validation_get_failed'
    );
    expect(mocks.contextCleanup).toHaveBeenCalledOnce();
  });
});

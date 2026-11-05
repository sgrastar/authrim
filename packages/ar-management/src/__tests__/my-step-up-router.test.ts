import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  issueAdminStepUpReceipt: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  isActive: vi.fn(),
  listActiveByUser: vi.fn(),
  readAdminStepUpPolicy: vi.fn(),
  auth: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_AUTH_REQUIRED]: 401,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  class MockAdminSecondFactorRepository {
    isActive = mocks.isActive;
    listActiveByUser = mocks.listActiveByUser;
  }
  return {
    ...actual,
    AdminSecondFactorRepository: MockAdminSecondFactorRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    issueAdminStepUpReceipt: mocks.issueAdminStepUpReceipt,
    readAdminStepUpPolicy: mocks.readAdminStepUpPolicy,
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        if (mocks.auth) c.set('adminAuth', mocks.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status: number) => Response }, code: string) =>
        c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import { ADMIN_STEP_UP_OPERATIONS, AdminStepUpError } from '@authrim/ar-lib-core';
import { myStepUpRouter } from '../routes/admin-management/my-step-up';

const AUTH = { userId: 'admin-1', authMethod: 'session', sessionId: 'sess-1' };

async function post(body: unknown) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/step-up', myStepUpRouter);
  const response = await app.request(
    '/api/admin/me/step-up/receipts',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    {}
  );
  return {
    status: response.status,
    cache: response.headers.get('Cache-Control'),
    body: await response.json<Record<string, unknown>>(),
  };
}

describe('myStepUpRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = AUTH;
    mocks.issueAdminStepUpReceipt.mockResolvedValue({
      receipt: 'asp_receipt',
      expiresAt: 1234,
      binding: {
        sessionId: 'sess-1',
        operation: 'tenant.delete',
        level: 'L2',
        targetTenantId: 'tenant-a',
      },
    });
  });

  it('issues the receipt for the caller and audits it', async () => {
    const result = await post({ step_up_id: 'asr_requirement' });

    expect(result).toEqual({
      status: 200,
      cache: 'no-store',
      body: { step_up_receipt: 'asp_receipt', expires_at: 1234 },
    });
    const [, input] = mocks.issueAdminStepUpReceipt.mock.calls[0] as [
      unknown,
      {
        stepUpId: string;
        auth: unknown;
        isSecondFactorActive: (user: string, id: string) => Promise<boolean>;
      },
    ];
    expect(input).toMatchObject({ stepUpId: 'asr_requirement', auth: AUTH });
    // The issuance checks the session's second factor against the registry.
    mocks.isActive.mockResolvedValue(false);
    await expect(input.isSecondFactorActive('admin-1', 'sf-1')).resolves.toBe(false);
    expect(mocks.isActive).toHaveBeenCalledWith('admin-1', 'sf-1');
    const [, audit] = mocks.writeAdminAuditLog.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(audit).toMatchObject({
      action: 'admin.step_up.receipt_issued',
      resourceId: 'sess-1',
      metadata: { operation: 'tenant.delete', level: 'L2', target_tenant_id: 'tenant-a' },
    });
  });

  it('names the missing factors when evidence is not fresh', async () => {
    mocks.issueAdminStepUpReceipt.mockRejectedValue(
      new AdminStepUpError('step_up_evidence_required', 'x', ['passkey', 'second_factor'])
    );

    const { status, body } = await post({ step_up_id: 'asr_requirement' });

    expect(status).toBe(403);
    expect(body).toMatchObject({
      error: 'step_up_evidence_required',
      missing: ['passkey', 'second_factor'],
    });
    expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
  });

  it('reports an unknown or used request as invalid', async () => {
    mocks.issueAdminStepUpReceipt.mockRejectedValue(new AdminStepUpError('invalid_step_up', 'x'));

    const { status, body } = await post({ step_up_id: 'asr_requirement' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_step_up' });
  });

  it.each([[{}], [{ step_up_id: '' }], [{ step_up_id: 7 }], ['not json'], ['null'], ['7']])(
    'rejects the body %j',
    async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(mocks.issueAdminStepUpReceipt).not.toHaveBeenCalled();
    }
  );

  it('fails closed on an unexpected error', async () => {
    mocks.issueAdminStepUpReceipt.mockRejectedValue(new Error('DO unavailable'));

    expect((await post({ step_up_id: 'asr_requirement' })).status).toBe(500);
  });
});

interface RequirementsBody {
  operations: Record<string, { level: string; catalog_level: string; always_enforced: boolean }>;
  evidence: { passkey_fresh_until: number | null; second_factor_fresh_until: number | null };
  enforced: boolean;
  second_factor_registered: boolean;
  [key: string]: unknown;
}

describe('GET /api/admin/me/step-up/requirements', () => {
  const NOW = 1_800_000_000_000;

  async function get() {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/admin/me/step-up', myStepUpRouter);
    const response = await app.request('/api/admin/me/step-up/requirements', {}, {});
    return {
      status: response.status,
      cache: response.headers.get('Cache-Control'),
      body: await response.json<RequirementsBody>(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.auth = {
      ...AUTH,
      tenantId: 'tenant-a',
      sessionTenantId: 'default',
      mfaVerified: true,
      authenticationTimeMs: NOW - 60_000,
      secondFactorId: 'factor-1',
      secondFactorVerifiedAtMs: NOW - 10 * 60_000,
    };
    mocks.readAdminStepUpPolicy.mockResolvedValue({ overrides: undefined, enforced: undefined });
    mocks.listActiveByUser.mockResolvedValue([{ id: 'factor-1' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists every catalog operation at its level in the selected tenant', async () => {
    const { status, cache, body } = await get();

    expect(status).toBe(200);
    expect(cache).toBe('no-store');
    expect(mocks.readAdminStepUpPolicy).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
    expect(Object.keys(body.operations).sort()).toEqual(
      Object.keys(ADMIN_STEP_UP_OPERATIONS).sort()
    );
    expect(body.operations['client.secret.rotate']).toEqual({
      level: 'L1',
      catalog_level: 'L1',
      always_enforced: false,
    });
    expect(body.operations['admin.second_factor.add']).toEqual({
      level: 'L2',
      catalog_level: 'L2',
      always_enforced: true,
    });
    expect(body).toMatchObject({
      tenant_id: 'tenant-a',
      enforced: true,
      evidence_window_seconds: 300,
      second_factor_registered: true,
    });
  });

  it('reports how long each factor stays fresh', async () => {
    const { body } = await get();

    // The passkey was verified a minute ago; the security key ten minutes ago (stale).
    expect(body.evidence).toEqual({
      passkey_fresh_until: NOW - 60_000 + 5 * 60_000,
      second_factor_fresh_until: null,
    });
  });

  it("applies the tenant's raised levels", async () => {
    mocks.readAdminStepUpPolicy.mockResolvedValue({
      overrides: { 'client.secret.rotate': 'L2' },
      enforced: true,
    });

    const { body } = await get();

    expect(body.operations['client.secret.rotate']).toMatchObject({
      level: 'L2',
      catalog_level: 'L1',
    });
  });

  it('shows L0 when enforcement is off, except for the always-enforced operations', async () => {
    mocks.readAdminStepUpPolicy.mockResolvedValue({ overrides: undefined, enforced: false });

    const { body } = await get();

    expect(body.enforced).toBe(false);
    expect(body.operations['tenant.delete'].level).toBe('L0');
    expect(body.operations['admin_step_up.policy.relax'].level).toBe('L2');
  });

  it('says when the admin has no security key yet', async () => {
    mocks.listActiveByUser.mockResolvedValue([]);

    expect((await get()).body.second_factor_registered).toBe(false);
  });

  it('refuses a machine caller without reading the policy', async () => {
    mocks.auth = { userId: 'machine-1', authMethod: 'machine_access_token', tenantId: 'tenant-a' };

    const { status, body } = await get();

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'step_up_human_required' });
    expect(mocks.readAdminStepUpPolicy).not.toHaveBeenCalled();
    expect(mocks.listActiveByUser).not.toHaveBeenCalled();
  });

  it('fails closed when the policy cannot be read', async () => {
    mocks.readAdminStepUpPolicy.mockRejectedValue(new Error('KV down'));

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'step_up_unavailable' });
  });

  it('requires a signed-in admin', async () => {
    mocks.auth = undefined;

    expect((await get()).status).toBe(401);
    expect(mocks.readAdminStepUpPolicy).not.toHaveBeenCalled();
  });
});

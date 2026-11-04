import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext } from '../../types/admin';
import type { Env } from '../../types/env';

const mocks = vi.hoisted(() => ({
  resolveEffectiveSettings: vi.fn(),
  consumeAdminStepUpReceipt: vi.fn(),
  createAdminStepUpRequirement: vi.fn(),
  isActive: vi.fn(),
}));

vi.mock('../effective-settings', () => ({
  resolveEffectiveSettings: mocks.resolveEffectiveSettings,
}));
vi.mock('../admin-database-adapter', () => ({
  requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
}));
vi.mock('../../repositories/admin/admin-second-factor', () => ({
  AdminSecondFactorRepository: class {
    isActive = mocks.isActive;
  },
}));
vi.mock('../admin-step-up', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-step-up')>();
  return {
    ...actual,
    consumeAdminStepUpReceipt: mocks.consumeAdminStepUpReceipt,
    createAdminStepUpRequirement: mocks.createAdminStepUpRequirement,
  };
});

import { AdminStepUpError, createAdminStepUpOperationHash } from '../admin-step-up';
import { requireAdminStepUp } from '../admin-step-up-gate';

const NOW = 50_000_000;

function human(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    tenantId: 'tenant-a',
    sessionTenantId: 'default',
    sessionId: 'sess-1',
    mfaVerified: true,
    authenticationTimeMs: NOW - 1000,
    ...overrides,
  };
}

const revokeAll = {
  operation: 'sessions.revoke_all' as const,
  targetTenantId: 'tenant-a',
  targetIds: ['user-1'],
};
const deleteTenant = { operation: 'tenant.delete' as const, targetTenantId: 'tenant-a' };

async function run(
  descriptor: Parameters<typeof requireAdminStepUp>[1],
  auth: AdminAuthContext | null = human(),
  headers: Record<string, string> = {}
) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.post('/op', async (c) => {
    if (auth) c.set('adminAuth', auth);
    const refused = await requireAdminStepUp(c, descriptor, NOW);
    return refused ?? c.json({ ran: true });
  });
  const response = await app.request('/op', { method: 'POST', headers }, {});
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe('requireAdminStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEffectiveSettings.mockResolvedValue({});
    mocks.isActive.mockResolvedValue(true);
    mocks.createAdminStepUpRequirement.mockResolvedValue({
      stepUpId: 'asr_requirement',
      expiresAt: NOW + 300_000,
    });
  });

  it('marks a refusal retryable, so a repeat with the same Idempotency-Key reaches the handler', async () => {
    mocks.resolveEffectiveSettings.mockResolvedValue({});
    const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
    let marked: unknown;
    app.post('/op', async (c) => {
      c.set('adminAuth', human());
      // L2 without a receipt: refused with step_up_required.
      const refused = await requireAdminStepUp(c, deleteTenant, NOW);
      marked = (c as unknown as { get: (key: string) => unknown }).get(
        'idempotencyResponseRetryable'
      );
      return refused ?? c.json({ ran: true });
    });
    const response = await app.request('/op', { method: 'POST' }, {});
    expect(response.status).toBe(403);
    expect(marked).toBe(true);
  });

  it('lets an L1 operation through with a fresh passkey', async () => {
    await expect(run(revokeAll)).resolves.toEqual({ status: 200, body: { ran: true } });
    expect(mocks.resolveEffectiveSettings).toHaveBeenCalledWith({}, 'security', {
      tenantId: 'tenant-a',
    });
  });

  it('asks for passkey re-authentication on L1 with an old passkey', async () => {
    const { status, body } = await run(revokeAll, human({ authenticationTimeMs: NOW - 600_000 }));

    expect(status).toBe(403);
    expect(body).toMatchObject({
      error: 'admin_fresh_auth_required',
      fresh_auth_required: true,
      required_level: 'L1',
    });
    expect(mocks.createAdminStepUpRequirement).not.toHaveBeenCalled();
  });

  it('applies a tenant raise from L1 to L2', async () => {
    mocks.resolveEffectiveSettings.mockResolvedValue({
      'security.admin_step_up_overrides': { 'sessions.revoke_all': 'L2' },
    });

    const { status, body } = await run(revokeAll);

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'step_up_required', required_level: 'L2' });
  });

  it('ignores an override that would lower the catalog', async () => {
    mocks.resolveEffectiveSettings.mockResolvedValue({
      'security.admin_step_up_overrides': { 'tenant.delete': 'L1' },
    });

    expect((await run(deleteTenant)).body).toMatchObject({ required_level: 'L2' });
  });

  it('leaves a requirement bound to the session and the operation for L2', async () => {
    const { status, body } = await run(deleteTenant);

    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'step_up_required',
      error_description: 'This operation needs a step-up receipt',
      required_level: 'L2',
      step_up_id: 'asr_requirement',
      expires_at: NOW + 300_000,
      missing: ['second_factor'],
    });
    const [, binding] = mocks.createAdminStepUpRequirement.mock.calls[0] as [unknown, unknown];
    expect(binding).toEqual({
      adminUserId: 'admin-1',
      sessionId: 'sess-1',
      homeTenantId: 'default',
      targetTenantId: 'tenant-a',
      level: 'L2',
      operation: 'tenant.delete',
      operationHash: await createAdminStepUpOperationHash(deleteTenant),
    });
  });

  it('runs an L2 operation once its receipt is accepted', async () => {
    mocks.consumeAdminStepUpReceipt.mockResolvedValue(undefined);

    const result = await run(deleteTenant, human({ secondFactorId: 'sf-1' }), {
      'authrim-step-up-receipt': 'asp_receipt',
    });

    expect(result).toEqual({ status: 200, body: { ran: true } });
    const [, receipt] = mocks.consumeAdminStepUpReceipt.mock.calls[0] as [unknown, string];
    expect(receipt).toBe('asp_receipt');
    expect(mocks.createAdminStepUpRequirement).not.toHaveBeenCalled();
  });

  it('asks for a new receipt when the one presented is refused', async () => {
    mocks.consumeAdminStepUpReceipt.mockRejectedValue(
      new AdminStepUpError('step_up_required', 'used')
    );

    const { status, body } = await run(deleteTenant, human({ secondFactorId: 'sf-1' }), {
      'authrim-step-up-receipt': 'asp_receipt',
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'step_up_required', step_up_id: 'asr_requirement' });
  });

  it('does not spend a receipt once the second factor behind it was revoked', async () => {
    mocks.isActive.mockResolvedValue(false);

    const { status, body } = await run(deleteTenant, human({ secondFactorId: 'sf-1' }), {
      'authrim-step-up-receipt': 'asp_receipt',
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'step_up_required' });
    expect(mocks.isActive).toHaveBeenCalledWith('admin-1', 'sf-1');
    expect(mocks.consumeAdminStepUpReceipt).not.toHaveBeenCalled();
  });

  it('does not take a receipt from a session without a verified second factor', async () => {
    const { status } = await run(deleteTenant, human(), { 'authrim-step-up-receipt': 'asp_x' });

    expect(status).toBe(403);
    expect(mocks.consumeAdminStepUpReceipt).not.toHaveBeenCalled();
  });

  describe('platform enforcement switch', () => {
    it('lets operations through while the platform turned enforcement off', async () => {
      mocks.resolveEffectiveSettings.mockResolvedValue({
        'security.admin_step_up_enforced': false,
      });

      await expect(run(deleteTenant)).resolves.toEqual({ status: 200, body: { ran: true } });
      await expect(
        run(deleteTenant, human({ authMethod: 'machine_access_token', actorType: 'machine' }))
      ).resolves.toMatchObject({ status: 200 });
    });

    it.each([
      'admin_step_up.policy.relax',
      'admin.second_factor.add',
      'admin.second_factor.remove',
    ] as const)('keeps %s protected while enforcement is off', async (operation) => {
      mocks.resolveEffectiveSettings.mockResolvedValue({
        'security.admin_step_up_enforced': false,
      });

      const { status, body } = await run({ operation, targetTenantId: 'tenant-a' });

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'step_up_required' });
    });

    it.each([undefined, 'false', 0, null])(
      'enforces for anything but false (%s)',
      async (value) => {
        mocks.resolveEffectiveSettings.mockResolvedValue({
          'security.admin_step_up_enforced': value,
        });

        expect((await run(deleteTenant)).status).toBe(403);
      }
    );
  });

  describe('machine principals', () => {
    const machine = (permissions: string[], globalPermissions: string[] = []) =>
      human({
        authMethod: 'machine_access_token',
        actorType: 'machine',
        sessionId: undefined,
        permissions,
        globalPermissions,
      });

    it('lets a machine through with the operation’s own exemption', async () => {
      await expect(
        run(deleteTenant, machine(['admin:step_up_exempt:tenant.delete']))
      ).resolves.toEqual({ status: 200, body: { ran: true } });
      await expect(
        run(deleteTenant, machine([], ['admin:step_up_exempt:tenant.delete']))
      ).resolves.toMatchObject({ status: 200 });
    });

    it.each([
      ['another operation’s exemption', ['admin:step_up_exempt:signing_key.rotate']],
      ['a wildcard', ['*']],
      ['admin:*', ['admin:*']],
      ['a namespace wildcard', ['admin:step_up_exempt:*']],
    ])('refuses a machine holding only %s', async (_label, permissions) => {
      const { status, body } = await run(deleteTenant, machine(permissions));

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'step_up_human_required' });
    });

    it('a request that also performs another operation needs the exemption for each', async () => {
      const compound = {
        operation: 'webhook.destination.update' as const,
        targetTenantId: 'tenant-a',
        alsoCovers: ['audit.retention.shorten' as const],
      };
      const onlyOne = await run(
        compound,
        machine(['admin:step_up_exempt:webhook.destination.update'])
      );
      expect(onlyOne.status).toBe(403);
      expect(onlyOne.body).toMatchObject({ error: 'step_up_human_required' });
      await expect(
        run(
          compound,
          machine([
            'admin:step_up_exempt:webhook.destination.update',
            'admin:step_up_exempt:audit.retention.shorten',
          ])
        )
      ).resolves.toMatchObject({ status: 200 });
    });

    it('does not exempt an agent, nor anyone from an always-enforced operation', async () => {
      const agent = human({
        authMethod: 'bearer',
        actorType: 'agent',
        permissions: ['admin:step_up_exempt:tenant.delete'],
      });
      expect((await run(deleteTenant, agent)).status).toBe(403);
      const relax = {
        operation: 'admin_step_up.policy.relax' as const,
        targetTenantId: 'tenant-a',
      };
      expect(
        (await run(relax, machine(['admin:step_up_exempt:admin_step_up.policy.relax']))).status
      ).toBe(403);
    });

    it('does not let a human session skip the step-up with an exemption', async () => {
      const { status } = await run(
        deleteTenant,
        human({ permissions: ['admin:step_up_exempt:tenant.delete'] })
      );

      expect(status).toBe(403);
    });
  });

  it.each([
    ['no admin', null],
    ['a machine token', human({ authMethod: 'machine_access_token', actorType: 'machine' })],
    ['an agent session', human({ actorType: 'agent' })],
    ['a session without its tenant', human({ sessionTenantId: undefined })],
  ])('refuses %s', async (_label, auth) => {
    const { status, body } = await run(deleteTenant, auth);

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'step_up_human_required', required_level: 'L2' });
    expect(mocks.createAdminStepUpRequirement).not.toHaveBeenCalled();
  });

  it('refuses when the tenant policy cannot be read', async () => {
    mocks.resolveEffectiveSettings.mockRejectedValue(new Error('KV down'));

    const { status, body } = await run(revokeAll);

    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'step_up_unavailable' });
  });
});

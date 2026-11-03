import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  resolveEffectiveSettings: vi.fn(),
  consumeAdminStepUpReceipt: vi.fn(),
  createAdminStepUpRequirement: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveEffectiveSettings: mocks.resolveEffectiveSettings,
    consumeAdminStepUpReceipt: mocks.consumeAdminStepUpReceipt,
    createAdminStepUpRequirement: mocks.createAdminStepUpRequirement,
  };
});

import { AdminStepUpError, createAdminStepUpOperationHash } from '@authrim/ar-lib-core';
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
    mocks.createAdminStepUpRequirement.mockResolvedValue({
      stepUpId: 'asr_requirement',
      expiresAt: NOW + 300_000,
    });
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

    const result = await run(deleteTenant, human(), { 'authrim-step-up-receipt': 'asp_receipt' });

    expect(result).toEqual({ status: 200, body: { ran: true } });
    const [, receipt] = mocks.consumeAdminStepUpReceipt.mock.calls[0] as [unknown, string];
    expect(receipt).toBe('asp_receipt');
    expect(mocks.createAdminStepUpRequirement).not.toHaveBeenCalled();
  });

  it('asks for a new receipt when the one presented is refused', async () => {
    mocks.consumeAdminStepUpReceipt.mockRejectedValue(
      new AdminStepUpError('step_up_required', 'used')
    );

    const { status, body } = await run(deleteTenant, human(), {
      'authrim-step-up-receipt': 'asp_receipt',
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'step_up_required', step_up_id: 'asr_requirement' });
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

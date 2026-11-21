import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  requireAdminStepUp: vi.fn(async (): Promise<Response | null> => null),
  listActiveByUser: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  notice: vi.fn(),
  consoleNotice: vi.fn(),
  auth: {} as Record<string, unknown> | undefined,
}));

vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: mocks.requireAdminStepUp,
  refuseAdminFreshAuth: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: 'admin_fresh_auth_required' }, 403),
}));
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));
vi.mock('../routes/settings-v2/second-factor-policy-notice', () => ({
  noticeSecondFactorKindsWidened: mocks.notice,
  showSecondFactorKindsWidenedInConsole: mocks.consoleNotice,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminSecondFactorRepository {
    listActiveByUser = mocks.listActiveByUser;
  }
  return {
    ...actual,
    AdminSecondFactorRepository: MockAdminSecondFactorRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
  };
});

import {
  decideStepUpSettings,
  gateStepUpSettingsPatch,
  runStepUpSettingsAfterSave,
  type StepUpSettingsPending,
} from '../routes/settings-v2/step-up-settings';

const KEY = 'security.admin_second_factor_allowed_kinds';
const OVERRIDES = 'security.admin_step_up_overrides';

describe('decideStepUpSettings: allowed second-factor kinds', () => {
  const decide = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    decideStepUpSettings({ scopeType: 'tenant', before, after, inherited: {} });

  it('gates a change that allows a kind the tenant did not, naming what is now allowed', () => {
    expect(decide({}, { [KEY]: ['hardware', 'totp'] })).toEqual({
      kind: 'gate',
      operation: 'admin_step_up.policy.relax',
      params: { scope: 'tenant', admin_second_factor_allowed_kinds: ['hardware', 'totp'] },
      widensKindsOnly: true,
    });
  });

  it('does not gate narrowing, reordering or leaving the list alone', () => {
    expect(decide({ [KEY]: ['hardware', 'totp'] }, { [KEY]: ['hardware'] })).toEqual({
      kind: 'none',
    });
    expect(decide({ [KEY]: ['hardware', 'totp'] }, { [KEY]: ['totp', 'hardware'] })).toEqual({
      kind: 'none',
    });
    expect(decide({ [KEY]: ['hardware'] }, { [KEY]: ['hardware'] })).toEqual({ kind: 'none' });
  });

  it('does not take an invalid list as widening', () => {
    expect(decide({}, { [KEY]: ['totp'] })).toEqual({ kind: 'none' });
  });

  it('is never only a widening at the platform scope: that widens every tenant, so it needs L2', () => {
    const outcome = decideStepUpSettings({
      scopeType: 'platform',
      before: {},
      after: { [KEY]: ['hardware', 'totp'] },
      inherited: {},
    });
    expect(outcome).toMatchObject({ kind: 'gate', operation: 'admin_step_up.policy.relax' });
    expect(outcome).not.toHaveProperty('widensKindsOnly');
  });

  it('reads the platform value a tenant inherits, so a tenant clearing its own list can widen', () => {
    // The tenant had its own hardware-only list; the platform allows totp. Clearing the tenant's
    // list lets the platform's apply: a widening.
    const outcome = decideStepUpSettings({
      scopeType: 'tenant',
      before: { [KEY]: ['hardware'] },
      after: {},
      inherited: { [KEY]: ['hardware', 'totp'] },
    });
    expect(outcome).toMatchObject({ kind: 'gate', widensKindsOnly: true });
  });

  it('is not only a widening when another guarded setting is weakened in the same document', () => {
    const outcome = decide(
      { 'audit.check_api_retention_days': 90 },
      {
        [KEY]: ['hardware', 'totp'],
        'admin_invitations.code_handoff_enabled': true,
        'audit.check_api_retention_days': 30,
      }
    );
    expect(outcome).toMatchObject({ kind: 'gate', operation: 'admin_step_up.policy.relax' });
    expect(outcome).not.toHaveProperty('widensKindsOnly');
  });

  it('is not only a widening when something else relaxes in the same change', () => {
    const outcome = decide(
      { [OVERRIDES]: { 'sessions.revoke_all': 'L2' } },
      { [KEY]: ['hardware', 'totp'], [OVERRIDES]: {} }
    );
    expect(outcome).toMatchObject({ kind: 'gate', operation: 'admin_step_up.policy.relax' });
    expect(outcome).not.toHaveProperty('widensKindsOnly');
  });
});

function manager(before: Record<string, unknown>, after: Record<string, unknown>) {
  return {
    patch: vi.fn(async () => ({ candidate: { before, after } })),
    getAll: vi.fn(async () => ({ inherited: { values: {} } })),
  };
}

async function gate(
  options: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    refuse?: boolean;
    pending?: StepUpSettingsPending;
  } = {}
) {
  const app = new Hono();
  app.post('/x', async (c) => {
    c.set('adminAuth' as never, mocks.auth as never);
    const refused = await gateStepUpSettingsPatch({
      c: c as never,
      manager: manager(
        options.before ?? {},
        options.after ?? { [KEY]: ['hardware', 'totp'] }
      ) as never,
      category: 'security',
      scope: { type: 'tenant', id: 'tenant-a' },
      targetTenantId: 'tenant-a',
      body: { ifMatch: '1', set: { [KEY]: ['hardware', 'totp'] } },
      actor: 'admin-1',
      refuse: options.refuse,
      pending: options.pending,
    });
    return refused ?? c.json({ saved: true });
  });
  const response = await app.request('/x', { method: 'POST' });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

function human(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    email: 'admin-1@example.com',
    authMethod: 'session',
    actorType: 'human',
    tenantId: 'tenant-a',
    sessionTenantId: 'default',
    sessionId: 'sess-1',
    roles: [],
    mfaVerified: true,
    authenticationTimeMs: Date.now() - 1000,
    ...overrides,
  };
}

describe('widening the allowed second-factor kinds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = human();
    mocks.requireAdminStepUp.mockResolvedValue(null);
    mocks.listActiveByUser.mockResolvedValue([]);
    mocks.writeAdminAuditLog.mockResolvedValue('audit-1');
  });

  it('keeps L2 for an admin who has a second factor that counts', async () => {
    mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-1', kind: 'webauthn_credential' }]);
    const pending: StepUpSettingsPending = {};

    expect(await gate({ pending })).toEqual({ status: 200, body: { saved: true } });

    expect(mocks.requireAdminStepUp).toHaveBeenCalledOnce();
    expect(mocks.requireAdminStepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'admin_step_up.policy.relax' })
    );
    expect(pending.afterSave).toBeUndefined();
  });

  it('lets an admin with no second factor through on a fresh passkey: recorded first, announced after the save', async () => {
    const pending: StepUpSettingsPending = {};

    expect(await gate({ pending })).toEqual({ status: 200, body: { saved: true } });

    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    // Recorded before the change goes ahead; announced only once it is saved.
    expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.second_factor_policy.widened_without_second_factor',
        resourceId: 'tenant-a',
        severity: 'warn',
        metadata: { allowed_kinds: ['hardware', 'totp'], authorized_with: 'passkey_only' },
      })
    );
    expect(mocks.notice).not.toHaveBeenCalled();
    expect(mocks.consoleNotice).not.toHaveBeenCalled();

    await runStepUpSettingsAfterSave(pending);
    for (const sent of [mocks.notice, mocks.consoleNotice]) {
      expect(sent).toHaveBeenCalledOnce();
      expect(sent.mock.calls[0]?.[1]).toMatchObject({
        tenantId: 'tenant-a',
        actor: { id: 'admin-1', email: 'admin-1@example.com' },
        kinds: ['hardware', 'totp'],
      });
    }
  });

  it('does not let the change through when it cannot be recorded', async () => {
    mocks.writeAdminAuditLog.mockResolvedValue(null);
    const pending: StepUpSettingsPending = {};

    expect(await gate({ pending })).toEqual({
      status: 503,
      body: expect.objectContaining({ error: 'audit_unavailable' }) as unknown,
    });
    expect(pending.afterSave).toBeUndefined();
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('counts a factor the tenant does not allow as no second factor', async () => {
    mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-t', kind: 'totp' }]);

    expect((await gate({ pending: {} })).status).toBe(200);

    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('asks for a fresh passkey when the passkey is stale', async () => {
    mocks.auth = human({ authenticationTimeMs: Date.now() - 3_600_000 });
    const pending: StepUpSettingsPending = {};

    expect(await gate({ pending })).toEqual({
      status: 403,
      body: { error: 'admin_fresh_auth_required' },
    });
    expect(pending.afterSave).toBeUndefined();
  });

  it('keeps the normal gate for a caller that is not a signed-in human', async () => {
    mocks.auth = { userId: 'machine-1', authMethod: 'machine_access_token', tenantId: 'tenant-a' };

    await gate({ pending: {} });

    expect(mocks.requireAdminStepUp).toHaveBeenCalledOnce();
    expect(mocks.listActiveByUser).not.toHaveBeenCalled();
  });

  it('keeps L2 when the same request also relaxes another protection', async () => {
    await gate({
      before: { [OVERRIDES]: { 'sessions.revoke_all': 'L2' } },
      after: { [KEY]: ['hardware', 'totp'], [OVERRIDES]: {} },
      pending: {},
    });

    expect(mocks.requireAdminStepUp).toHaveBeenCalledOnce();
    expect(mocks.listActiveByUser).not.toHaveBeenCalled();
  });

  it('is refused in a bulk apply, never let through on a passkey', async () => {
    expect(await gate({ refuse: true, pending: {} })).toEqual({
      status: 400,
      body: expect.objectContaining({ error: 'step_up_not_in_bulk' }) as unknown,
    });
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('does not gate narrowing', async () => {
    expect(
      await gate({ before: { [KEY]: ['hardware', 'totp'] }, after: { [KEY]: ['hardware'] } })
    ).toEqual({ status: 200, body: { saved: true } });
    expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('never fails the saved change when a notice fails, and still sends the other', async () => {
    const pending: StepUpSettingsPending = {};
    await gate({ pending });
    mocks.notice.mockRejectedValue(new Error('mail down'));

    await expect(runStepUpSettingsAfterSave(pending)).resolves.toBeUndefined();
    expect(mocks.consoleNotice).toHaveBeenCalledOnce();

    mocks.notice.mockClear();
    mocks.consoleNotice.mockClear();
    mocks.consoleNotice.mockRejectedValue(new Error('db down'));
    await expect(runStepUpSettingsAfterSave(pending)).resolves.toBeUndefined();
    expect(mocks.notice).toHaveBeenCalledOnce();
  });
});

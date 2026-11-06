import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coreQuery: vi.fn(),
  transition: vi.fn(),
  audit: vi.fn(),
  stepUp: vi.fn(async (_c: unknown, _descriptor: unknown): Promise<Response | null> => null),
}));

vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: mocks.stepUp }));

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return { ...actual, writeAdminAuditLog: mocks.audit };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: () => ({ coreAdapter: { query: mocks.coreQuery } }),
    transitionCredentialStatus: mocks.transition,
  };
});

import { adminUsersRouter } from '../routes/admin-management/admins';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
} from './helpers/admin-authority-fixture';

function setup() {
  return setupApp((app) => {
    app.route('/api/admin/admins', adminUsersRouter);
  });
}

const path = (id: string) => `/api/admin/admins/${id}/wallet-credentials/revoke`;

describe('POST /api/admin/admins/:id/wallet-credentials/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coreQuery.mockResolvedValue([{ public_id: 'c1' }, { public_id: 'c2' }]);
    mocks.transition.mockResolvedValue({ outcome: 'changed', previous: 'active' });
    mocks.stepUp.mockResolvedValue(null);
  });

  it('asks for an admin_credential.revoke step-up bound to the target admin', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);

    await context.call(actor.cookie, 'POST', path(target.userId));

    expect(mocks.stepUp).toHaveBeenCalledTimes(1);
    expect(mocks.stepUp.mock.calls[0][1]).toEqual({
      operation: 'admin_credential.revoke',
      targetTenantId: expect.any(String) as unknown,
      targetIds: [target.userId],
      params: { scope: 'wallet_credentials' },
    });
  });

  it('reports a retry when the Keyring factors of revoked credentials could not be retired', async () => {
    mocks.coreQuery.mockImplementation(async (sql: string) =>
      sql.includes("status = 'revoked'")
        ? Promise.reject(new Error('core db down'))
        : [{ public_id: 'c1' }]
    );
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    const response = await context.call(actor.cookie, 'POST', path(target.userId));
    expect(response.status).toBe(503);
  });

  it('revokes nothing when the step-up refuses the request', async () => {
    mocks.stepUp.mockResolvedValue(
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
    );
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(403);
    expect(mocks.coreQuery).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('revokes every pending/active/suspended credential and answers 200', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      results: [
        { id: 'c1', outcome: 'revoked' },
        { id: 'c2', outcome: 'revoked' },
      ],
      allRevoked: true,
    });
    const [sql, params] = mocks.coreQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status IN ('pending', 'active', 'suspended')");
    expect(params).toEqual(['tenant-a', target.userId, 'https://authrim.com/credentials/admin/v1']);
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        credentialId: 'c1',
        from: ['pending', 'active', 'suspended'],
        to: 'revoked',
      })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_wallet_credential.revoked_all',
        resourceId: target.userId,
        result: 'success',
      })
    );
  });

  it('works for a suspended or deactivated admin', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const suspended = signIn(context.db, []);
    const deactivated = signIn(context.db, []);
    context.db
      .prepare("UPDATE admin_users SET status = 'suspended' WHERE id = ?")
      .run(suspended.userId);
    context.db.prepare('UPDATE admin_users SET is_active = 0 WHERE id = ?').run(deactivated.userId);

    expect((await context.call(actor.cookie, 'POST', path(suspended.userId))).status).toBe(200);
    expect((await context.call(actor.cookie, 'POST', path(deactivated.userId))).status).toBe(200);
  });

  it('is idempotent: a second call finds everything already revoked', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    mocks.transition.mockResolvedValue({ outcome: 'unchanged' });

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(200);
    expect(response.json.allRevoked).toBe(true);
    expect(response.json.results).toHaveLength(2);
  });

  it('answers 200 with no results for an admin without credentials', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    mocks.coreQuery.mockResolvedValue([]);

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ results: [], allRevoked: true });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('reports a partial failure with 503, Retry-After and a failed audit', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    mocks.transition
      .mockResolvedValueOnce({ outcome: 'changed', previous: 'active' })
      .mockResolvedValueOnce({ outcome: 'conflict' });

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(503);
    expect(response.json).toEqual({
      results: [
        { id: 'c1', outcome: 'revoked' },
        { id: 'c2', outcome: 'conflict' },
      ],
      allRevoked: false,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );
  });

  it('keeps going after a thrown error and reports it', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    mocks.transition
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ outcome: 'changed', previous: 'active' });

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(503);
    expect(response.json.results).toEqual([
      { id: 'c1', outcome: 'error' },
      { id: 'c2', outcome: 'revoked' },
    ]);
  });

  it('answers 409 when a credential cannot be revoked from its state', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);
    const target = signIn(context.db, []);
    mocks.transition.mockResolvedValue({ outcome: 'not_allowed', current: 'deferred' });

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(409);
    expect(response.json.allRevoked).toBe(false);
  });

  it('answers 404 for an unknown admin without touching credentials', async () => {
    const context = setup();
    const actor = signIn(context.db, TENANT_SUPER_ADMIN);

    const response = await context.call(actor.cookie, 'POST', path('admin-missing'));

    expect(response.status).toBe(404);
    expect(mocks.coreQuery).not.toHaveBeenCalled();
  });

  it('refuses a caller without admin-user write permission', async () => {
    const context = setup();
    const viewer = signIn(context.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]);
    const target = signIn(context.db, []);

    const response = await context.call(viewer.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(403);
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('refuses a tenant admin acting on an admin who holds a global assignment', async () => {
    const context = setup();
    signIn(context.db, GLOBAL_SUPER_ADMIN);
    const target = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const actor = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);

    const response = await context.call(actor.cookie, 'POST', path(target.userId));

    expect(response.status).toBe(403);
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});

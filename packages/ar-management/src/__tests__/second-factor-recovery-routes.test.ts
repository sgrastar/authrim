import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';

const NOW = Date.now();

const mocks = vi.hoisted(() => ({
  findOpenByUser: vi.fn(),
  findById: vi.fn(),
  listOpenByTenant: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
  markNotified: vi.fn(),
  queryOne: vi.fn(),
  query: vi.fn(),
  coreQueryOne: vi.fn(),
  revokeByAdmin: vi.fn(),
  recoveryNoticeAvailable: vi.fn(),
  sendRecoveryNotice: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  tenantId: 'default',
  auth: {},
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('../routes/admin-management/second-factor-recovery-notice', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../routes/admin-management/second-factor-recovery-notice')
    >();
  return {
    ...actual,
    recoveryNoticeAvailable: mocks.recoveryNoticeAvailable,
    sendRecoveryNotice: mocks.sendRecoveryNotice,
    // The real wrapper around the mocked sender, so its error handling is exercised.
    sendRecoveryNoticeAfterCommit: async (...args: unknown[]) => {
      try {
        return Boolean(await mocks.sendRecoveryNotice(...args));
      } catch {
        return false;
      }
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockRecoveryRepository {
    findOpenByUser = mocks.findOpenByUser;
    findById = mocks.findById;
    listOpenByTenant = mocks.listOpenByTenant;
    create = mocks.create;
    cancel = mocks.cancel;
    complete = mocks.complete;
    markNotified = mocks.markNotified;
  }
  class MockFactorRepository {
    revokeByAdmin = mocks.revokeByAdmin;
  }
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    AdminSecondFactorRecoveryRepository: MockRecoveryRepository,
    AdminSecondFactorRepository: MockFactorRepository,
    resolveTenantMetadataContext: vi.fn(async () => ({ coreDb: {} })),
    ensureDatabaseAdapter: vi.fn(() => ({ queryOne: mocks.coreQueryOne })),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({
      queryOne: mocks.queryOne,
      query: mocks.query,
    })),
    getTenantIdFromContext: vi.fn(() => mocks.tenantId),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status: number) => Response }, code: string) =>
        c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import { adminSecondFactorRecoveriesRouter } from '../routes/admin-management/admin-second-factor-recoveries';
import {
  fileRecoveryRequest,
  mySecondFactorRecoveryRouter,
  refuseRecoveryRequest,
} from '../routes/admin-management/my-second-factor-recovery';

function human(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    email: 'admin-1@example.com',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    tenantId: 'default',
    sessionTenantId: 'default',
    sessionId: 'sess-1',
    mfaVerified: true,
    authenticationTimeMs: NOW - 1000,
    ...overrides,
  };
}

function recovery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    admin_user_id: 'admin-1',
    tenant_id: 'default',
    status: 'pending',
    kind: 'webauthn_credential',
    credential_id: 'cred-new',
    holder_jkt: null,
    admin_credential_id: null,
    aaguid: null,
    label: 'New key',
    requested_session_id: 'sess-1',
    requested_at: NOW - 1000,
    not_before: NOW + 60_000,
    expires_at: NOW + 600_000,
    completed_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    ...overrides,
  };
}

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.route('/api/admin/me/second-factor-recovery', mySecondFactorRecoveryRouter);
  hono.route('/api/admin/admin-second-factor-recoveries', adminSecondFactorRecoveriesRouter);
  return hono;
}

async function call(method: string, path: string) {
  const response = await app().request(path, { method }, {});
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** Runs one of the exported helpers inside a request so it has a context. */
async function withContext(
  run: (c: Parameters<typeof refuseRecoveryRequest>[0]) => Promise<Response | null>
) {
  const hono = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  hono.post('/x', async (c) => (await run(c)) ?? c.json({ allowed: true }));
  const response = await hono.request('/x', { method: 'POST' }, {});
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const newKey = {
  credential_id: 'cred-new',
  public_key: 'cGs=',
  counter: 0,
  transports: ['usb'],
  aaguid: null,
  label: 'New key',
};

describe('second-factor recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = human();
    mocks.tenantId = 'default';
    mocks.queryOne.mockResolvedValue({ id: 'admin-2' });
    mocks.query.mockResolvedValue([{ id: 'admin-1', email: 'admin-1@example.com' }]);
    mocks.findOpenByUser.mockResolvedValue(null);
    mocks.recoveryNoticeAvailable.mockResolvedValue(true);
    mocks.sendRecoveryNotice.mockResolvedValue(true);
    mocks.create.mockResolvedValue({ created: true, recovery: recovery() });
    mocks.cancel.mockResolvedValue(true);
    mocks.markNotified.mockResolvedValue(true);
  });

  describe('before a request is filed', () => {
    const check = () =>
      withContext((c) =>
        refuseRecoveryRequest(
          c,
          human() as never,
          { queryOne: mocks.queryOne, query: mocks.query } as never,
          NOW
        )
      );

    it('allows an admin with a fresh passkey when others exist and email works', async () => {
      expect(await check()).toEqual({ status: 200, body: { allowed: true } });
      expect(mocks.recoveryNoticeAvailable).toHaveBeenCalledWith({}, 'default');
    });

    it('asks for a passkey re-authentication first', async () => {
      const result = await withContext((c) =>
        refuseRecoveryRequest(
          c,
          human({ authenticationTimeMs: NOW - 10 * 60_000 }) as never,
          { queryOne: mocks.queryOne } as never,
          NOW
        )
      );
      expect(result.body).toMatchObject({ error: 'admin_fresh_auth_required' });
    });

    it('sends the only administrator in the system to the last resort', async () => {
      mocks.queryOne.mockResolvedValue(null);

      const result = await check();

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: 'recovery_requires_last_resort' });
    });

    it('refuses a second open request', async () => {
      mocks.findOpenByUser.mockResolvedValue(recovery());

      expect((await check()).body).toMatchObject({ error: 'recovery_pending' });
    });

    it('refuses when administrators cannot be emailed', async () => {
      mocks.recoveryNoticeAvailable.mockResolvedValue(false);

      const result = await check();

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: 'recovery_notification_unavailable' });
    });
  });

  describe('filing', () => {
    const file = (auth = human()) =>
      withContext((c) => fileRecoveryRequest(c, auth as never, newKey));

    it('files the request, notifies and audits', async () => {
      const { status, body } = await file();

      expect(status).toBe(201);
      expect(body).toMatchObject({ recovery: { id: 'rec-1', not_before: NOW + 60_000 } });
      expect(mocks.create.mock.calls[0]?.[0]).toEqual({
        admin_user_id: 'admin-1',
        tenant_id: 'default',
        requested_session_id: 'sess-1',
        ...newKey,
      });
      expect(mocks.sendRecoveryNotice.mock.calls[0]?.[2]).toMatchObject({
        event: 'requested',
        requester: { id: 'admin-1', email: 'admin-1@example.com' },
      });
      expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
        action: 'admin.second_factor.recovery_requested',
        resourceId: 'rec-1',
      });
    });

    it('withdraws the request when a notice cannot be delivered', async () => {
      mocks.sendRecoveryNotice.mockResolvedValue(false);

      const { status, body } = await file();

      expect(status).toBe(503);
      expect(body).toMatchObject({ error: 'recovery_notification_failed' });
      expect(mocks.cancel).toHaveBeenCalledWith(
        'rec-1',
        { adminUserId: 'admin-1' },
        { adminUserId: 'admin-1', reason: 'notification_failed' },
        expect.any(Number)
      );
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it.each([
      ['the notice throws', () => mocks.sendRecoveryNotice.mockRejectedValue(new Error('db'))],
      ['the request was closed meanwhile', () => mocks.markNotified.mockResolvedValue(false)],
    ])('withdraws the request when %s', async (_label, arrange) => {
      arrange();

      const { status, body } = await file();

      expect(status).toBe(503);
      expect(body).toMatchObject({ error: 'recovery_notification_failed' });
      expect(mocks.cancel).toHaveBeenCalledOnce();
    });

    it('still refuses when withdrawing fails, leaving the request unnotified', async () => {
      mocks.sendRecoveryNotice.mockResolvedValue(false);
      mocks.cancel.mockRejectedValue(new Error('db'));

      const { status } = await file();

      expect(status).toBe(503);
      expect(mocks.markNotified).not.toHaveBeenCalled();
    });

    it('marks the request notified only after every notice went out', async () => {
      await file();

      expect(mocks.markNotified).toHaveBeenCalledWith('rec-1', expect.any(Number));
      expect(mocks.sendRecoveryNotice.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.markNotified.mock.invocationCallOrder[0] ?? 0
      );
    });

    it('files nothing for an admin without an email address', async () => {
      const { status } = await file(human({ email: undefined }));

      expect(status).toBe(503);
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it.each([
      ['already_pending', 'recovery_pending'],
      ['credential_in_use', 'credential_in_use'],
    ])('reports %s', async (reason, error) => {
      mocks.create.mockResolvedValue({ created: false, reason });

      const { status, body } = await file();

      expect(status).toBe(409);
      expect(body).toMatchObject({ error });
      expect(mocks.sendRecoveryNotice).not.toHaveBeenCalled();
    });

    it('asks to sign in again when the session ended before the request was filed', async () => {
      mocks.create.mockResolvedValue({ created: false, reason: 'session_ended' });

      const { status, body } = await file();

      expect(status).toBe(401);
      expect(body).toMatchObject({ error: 'session_ended' });
      expect(mocks.sendRecoveryNotice).not.toHaveBeenCalled();
    });
  });

  describe('the requester', () => {
    it('reads the open request', async () => {
      mocks.findOpenByUser.mockResolvedValue(recovery());

      const { body } = await call('GET', '/api/admin/me/second-factor-recovery');

      expect(body).toEqual({
        recovery: {
          id: 'rec-1',
          status: 'pending',
          kind: 'webauthn_credential',
          label: 'New key',
          aaguid: null,
          requested_at: NOW - 1000,
          not_before: NOW + 60_000,
          expires_at: NOW + 600_000,
        },
      });
    });

    it('completes after the wait with a fresh passkey and notifies', async () => {
      mocks.findOpenByUser.mockResolvedValue(recovery({ not_before: NOW - 1 }));
      mocks.complete.mockResolvedValue({
        completed: true,
        secondFactorId: 'sf-new',
        recovery: recovery({ status: 'completed', completed_at: NOW }),
      });

      const { status, body } = await call('POST', '/api/admin/me/second-factor-recovery/complete');

      expect(status).toBe(200);
      expect(body).toEqual({ completed: true, second_factor_id: 'sf-new' });
      expect(mocks.complete).toHaveBeenCalledWith('admin-1', 'sess-1', expect.any(Number));
      expect(mocks.sendRecoveryNotice.mock.calls[0]?.[2]).toMatchObject({ event: 'completed' });
      expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
        action: 'admin.second_factor.recovery_completed',
        metadata: { second_factor_id: 'sf-new' },
      });
    });

    it.each([
      ['completion', '/api/admin/me/second-factor-recovery/complete', 'recovery_completed'],
      ['cancellation', '/api/admin/me/second-factor-recovery/cancel', 'recovery_cancelled'],
    ])('still answers and audits the %s when its notice throws', async (_label, path, action) => {
      mocks.findOpenByUser.mockResolvedValue(recovery({ not_before: NOW - 1 }));
      mocks.complete.mockResolvedValue({
        completed: true,
        secondFactorId: 'sf-new',
        recovery: recovery({ status: 'completed', completed_at: NOW }),
      });
      mocks.sendRecoveryNotice.mockRejectedValue(new Error('db'));

      expect((await call('POST', path)).status).toBe(200);
      expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
        action: `admin.second_factor.${action}`,
      });
    });

    it('asks for a passkey re-authentication before completing', async () => {
      mocks.auth = human({ authenticationTimeMs: NOW - 10 * 60_000 });

      const { status, body } = await call('POST', '/api/admin/me/second-factor-recovery/complete');

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'admin_fresh_auth_required' });
      expect(mocks.complete).not.toHaveBeenCalled();
    });

    it('asks for a passkey re-authentication before cancelling one’s own request', async () => {
      mocks.auth = human({ authenticationTimeMs: NOW - 10 * 60_000 });
      mocks.findOpenByUser.mockResolvedValue(recovery());

      const { status, body } = await call('POST', '/api/admin/me/second-factor-recovery/cancel');

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'admin_fresh_auth_required' });
      expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('says when the wait has not ended', async () => {
      mocks.findOpenByUser.mockResolvedValue(recovery());
      mocks.complete.mockResolvedValue({ completed: false, reason: 'too_early' });

      const { status, body } = await call('POST', '/api/admin/me/second-factor-recovery/complete');

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'recovery_waiting', not_before: NOW + 60_000 });
      expect(mocks.sendRecoveryNotice).not.toHaveBeenCalled();
    });

    it('reports a credential registered elsewhere meanwhile', async () => {
      mocks.complete.mockRejectedValue(new Error('credential is registered as an admin passkey'));

      const { status, body } = await call('POST', '/api/admin/me/second-factor-recovery/complete');

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'credential_in_use' });
    });

    describe('with a Keyring holder key', () => {
      const keyringRecovery = (overrides: Record<string, unknown> = {}) =>
        recovery({
          kind: 'keyring_holder_key',
          credential_id: null,
          holder_jkt: 'jkt-new',
          admin_credential_id: 'vc-1',
          label: 'Keyring',
          not_before: NOW - 1,
          ...overrides,
        });

      beforeEach(() => {
        mocks.findOpenByUser.mockResolvedValue(keyringRecovery());
        mocks.complete.mockResolvedValue({
          completed: true,
          secondFactorId: 'sf-new',
          recovery: keyringRecovery({ status: 'completed', completed_at: NOW }),
        });
      });

      it('completes while the admin credential is still active', async () => {
        mocks.coreQueryOne.mockResolvedValue({ status: 'active' });

        const { status, body } = await call(
          'POST',
          '/api/admin/me/second-factor-recovery/complete'
        );

        expect(status).toBe(200);
        expect(body).toEqual({ completed: true, second_factor_id: 'sf-new' });
        expect(mocks.coreQueryOne.mock.calls[0]?.[1]).toEqual([
          'default',
          'vc-1',
          'admin-1',
          'https://authrim.com/credentials/admin/v1',
        ]);
        expect(mocks.revokeByAdmin).not.toHaveBeenCalled();
        expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
          action: 'admin.second_factor.recovery_completed',
          metadata: { second_factor_id: 'sf-new', kind: 'keyring_holder_key' },
        });
      });

      it('completes nothing once the admin credential expired during the wait', async () => {
        mocks.coreQueryOne.mockResolvedValue({
          status: 'active',
          expires_at: Math.floor(NOW / 1000) - 60,
        });

        const { status, body } = await call(
          'POST',
          '/api/admin/me/second-factor-recovery/complete'
        );

        expect(status).toBe(409);
        expect(body).toMatchObject({ error: 'credential_not_active' });
        expect(mocks.complete).not.toHaveBeenCalled();
      });

      it('completes nothing once the admin credential was revoked during the wait', async () => {
        mocks.coreQueryOne.mockResolvedValue({ status: 'revoked' });

        const { status, body } = await call(
          'POST',
          '/api/admin/me/second-factor-recovery/complete'
        );

        expect(status).toBe(409);
        expect(body).toMatchObject({ error: 'credential_not_active' });
        expect(mocks.complete).not.toHaveBeenCalled();
      });

      it.each([
        ['revoked', () => mocks.coreQueryOne.mockResolvedValueOnce({ status: 'revoked' })],
        ['unknown', () => mocks.coreQueryOne.mockRejectedValueOnce(new Error('db'))],
      ])(
        'retires the new factor when the credential is %s right after completion',
        async (_label, arrange) => {
          mocks.coreQueryOne.mockResolvedValueOnce({ status: 'active' });
          arrange();

          const { status, body } = await call(
            'POST',
            '/api/admin/me/second-factor-recovery/complete'
          );

          expect(status).toBe(409);
          expect(body).toMatchObject({ error: 'credential_not_active' });
          expect(mocks.revokeByAdmin).toHaveBeenCalledWith('admin-1', 'sf-new');
          expect(mocks.sendRecoveryNotice).not.toHaveBeenCalled();
          expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
            result: 'failure',
            metadata: { reason: 'credential_not_active' },
          });
        }
      );
    });

    it('cancels their own request and notifies', async () => {
      mocks.findOpenByUser.mockResolvedValue(recovery());

      const { status } = await call('POST', '/api/admin/me/second-factor-recovery/cancel');

      expect(status).toBe(200);
      expect(mocks.cancel).toHaveBeenCalledWith(
        'rec-1',
        { adminUserId: 'admin-1' },
        { adminUserId: 'admin-1', reason: 'requester' },
        expect.any(Number)
      );
      expect(mocks.sendRecoveryNotice.mock.calls[0]?.[2]).toMatchObject({ event: 'cancelled' });
    });

    it('refuses a machine caller', async () => {
      mocks.auth = human({ authMethod: 'machine_access_token', actorType: 'machine' });

      expect((await call('GET', '/api/admin/me/second-factor-recovery')).status).toBe(403);
    });
  });

  describe('other administrators', () => {
    beforeEach(() => {
      mocks.auth = human({ userId: 'admin-2', email: 'admin-2@example.com' });
      mocks.findById.mockResolvedValue(recovery());
    });

    it('lists the tenant’s open requests with the requester’s email', async () => {
      mocks.listOpenByTenant.mockResolvedValue([recovery()]);

      const { body } = await call('GET', '/api/admin/admin-second-factor-recoveries');

      expect(mocks.listOpenByTenant).toHaveBeenCalledWith('default', expect.any(Number));
      expect(body).toMatchObject({
        items: [{ id: 'rec-1', admin_user_id: 'admin-1', admin_email: 'admin-1@example.com' }],
      });
    });

    it('cancels with a fresh passkey, notifying the requester', async () => {
      const { status } = await call(
        'POST',
        '/api/admin/admin-second-factor-recoveries/rec-1/cancel'
      );

      expect(status).toBe(200);
      expect(mocks.cancel).toHaveBeenCalledWith(
        'rec-1',
        { tenantId: 'default' },
        { adminUserId: 'admin-2', reason: 'admin' },
        expect.any(Number)
      );
      expect(mocks.sendRecoveryNotice.mock.calls[0]?.[2]).toMatchObject({
        event: 'cancelled',
        requester: { id: 'admin-1', email: 'admin-1@example.com' },
      });
      expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
        action: 'admin.second_factor.recovery_cancelled',
        metadata: { reason: 'admin', requester_id: 'admin-1' },
      });
    });

    it.each([
      ['the notice throws', () => mocks.sendRecoveryNotice.mockRejectedValue(new Error('db'))],
      ['the requester lookup throws', () => mocks.query.mockRejectedValue(new Error('db'))],
    ])('still answers and audits the cancellation when %s', async (_label, arrange) => {
      arrange();

      expect(
        (await call('POST', '/api/admin/admin-second-factor-recoveries/rec-1/cancel')).status
      ).toBe(200);
      expect(mocks.writeAdminAuditLog).toHaveBeenCalledOnce();
    });

    it('cannot cancel a request of another tenant’s admin', async () => {
      mocks.tenantId = 'tenant-b';

      const { status } = await call(
        'POST',
        '/api/admin/admin-second-factor-recoveries/rec-1/cancel'
      );

      expect(status).toBe(404);
      expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('asks for a passkey re-authentication before cancelling', async () => {
      mocks.auth = human({ userId: 'admin-2', authenticationTimeMs: NOW - 10 * 60_000 });

      const { status, body } = await call(
        'POST',
        '/api/admin/admin-second-factor-recoveries/rec-1/cancel'
      );

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'admin_fresh_auth_required' });
      expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('refuses a machine caller', async () => {
      mocks.auth = human({ authMethod: 'machine_access_token', actorType: 'machine' });

      expect(
        (await call('POST', '/api/admin/admin-second-factor-recoveries/rec-1/cancel')).status
      ).toBe(403);
    });
  });
});

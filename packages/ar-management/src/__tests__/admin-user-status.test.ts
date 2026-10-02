import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), execute: vi.fn(), query: vi.fn(), batch: vi.fn() },
  audit: vi.fn(),
  operationalLog: vi.fn(),
  retention: vi.fn(),
  scheduleAudit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocks.adapter })),
    createAuditLogFromContext: mocks.audit,
    storeOperationalLog: mocks.operationalLog,
    getOperationalLogRetentionDays: mocks.retention,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    transitionAccountAuthenticationState: vi.fn(async () => ({ lifecycle: 'active' })),
    readAccountAuthenticationState: vi.fn(async () => ({
      lifecycle: 'active',
      lifecycleOperationId: null,
      lifecycleVersionMs: null,
    })),
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
  };
});

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return {
    ...actual,
    scheduleAdminAuditLog: mocks.scheduleAudit,
    logSanitizedError: vi.fn(),
  };
});

import {
  readAccountAuthenticationState,
  transitionAccountAuthenticationState,
} from '@authrim/ar-lib-core';
import { adminUserActivateHandler, adminUserLockHandler, adminUserSuspendHandler } from '../admin';

function context(
  options: {
    id?: string;
    body?: unknown;
    bodyError?: boolean;
    env?: Record<string, unknown>;
    adminId?: string;
  } = {}
) {
  return {
    get: vi.fn((name: string) =>
      name === 'adminAuth' && options.adminId ? { userId: options.adminId } : undefined
    ),
    req: {
      param: vi.fn(() => options.id ?? 'user-1'),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn((name: string) => (name === 'X-Request-ID' ? 'request-1' : undefined)),
    },
    env: options.env ?? {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function queueAccount(status: string | undefined, primarySubjectId: string | null = 'subject-1') {
  mocks.adapter.queryOne
    .mockResolvedValueOnce({
      id: 'account-1',
      lifecycle_state: status === 'active' || status === undefined ? 'active' : status,
      metadata_json: status === undefined ? '{}' : JSON.stringify({ status }),
    })
    .mockResolvedValueOnce({ id: 'account-1', primary_subject_id: primarySubjectId });
}

describe('admin user account status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.adapter.batch.mockReset();
    mocks.adapter.batch.mockImplementation(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, rowsAffected: 1 }))
    );
    mocks.adapter.query.mockResolvedValue([]);
    mocks.audit.mockResolvedValue(undefined);
    mocks.operationalLog.mockResolvedValue(undefined);
    mocks.retention.mockResolvedValue(90);
  });

  it.each([[adminUserSuspendHandler], [adminUserLockHandler], [adminUserActivateHandler]])(
    'requires a user route ID %#',
    async (handler) => {
      expect((await handler(context({ id: '' }))).status).toBe(400);
    }
  );

  it.each([
    [adminUserSuspendHandler, {}],
    [adminUserSuspendHandler, { reason_code: 'invalid' }],
    [adminUserLockHandler, {}],
    [adminUserLockHandler, { reason_code: 'invalid' }],
    [adminUserActivateHandler, {}],
    [adminUserActivateHandler, { reason_code: 'invalid' }],
  ])('rejects unsupported reason code %#', async (handler, body) => {
    expect((await handler(context({ body }))).status).toBe(400);
  });

  it.each([0, 8761])('rejects suspension duration %s', async (duration_hours) => {
    expect(
      (
        await adminUserSuspendHandler(
          context({ body: { reason_code: 'admin_action', duration_hours } })
        )
      ).status
    ).toBe(400);
  });

  it.each(['not-a-date', '2026-13-01'])('rejects invalid unlock time %s', async (unlock_at) => {
    expect(
      (await adminUserLockHandler(context({ body: { reason_code: 'admin_action', unlock_at } })))
        .status
    ).toBe(400);
  });

  it.each([
    [adminUserSuspendHandler, { reason_code: 'admin_action' }],
    [adminUserLockHandler, { reason_code: 'admin_action' }],
    [adminUserActivateHandler, { reason_code: 'admin_action' }],
  ])('does not mutate a user outside the tenant %#', async (handler, body) => {
    expect((await handler(context({ body }))).status).toBe(404);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])('suspends a user with explicit revocation=%s', async (revoke) => {
    queueAccount(undefined, revoke ? 'subject-1' : null);
    const response = await adminUserSuspendHandler(
      context({
        body: {
          reason_code: 'admin_action',
          duration_hours: 24,
          revoke_tokens: revoke,
          revoke_sessions: revoke,
        },
      })
    );
    const body = (await response.json()) as {
      status: string;
      expires_at: string;
      revoked: unknown;
    };
    expect(body).toMatchObject({
      status: 'suspended',
      previous_status: 'active',
      expires_at: expect.any(String),
      revoked: { tokens: revoke ? -1 : 0, sessions: revoke ? -1 : 0 },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'user.suspend',
      'user',
      'user-1',
      expect.not.objectContaining({ reason_detail: expect.anything() })
    );
  });

  it('suspends indefinitely by default and implicitly revokes access', async () => {
    queueAccount('active');
    const body = (await (
      await adminUserSuspendHandler(context({ body: { reason_code: 'security_incident' } }))
    ).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('expires_at');
    expect(body.revoked).toEqual({ tokens: -1, sessions: -1 });
  });

  it.each([undefined, '2027-01-01T00:00:00.000Z'])(
    'locks with unlock time %#',
    async (unlock_at) => {
      queueAccount('suspended');
      const response = await adminUserLockHandler(
        context({ body: { reason_code: 'security_incident', unlock_at } })
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'locked', previous_status: 'suspended' });
      expect(body.hasOwnProperty('unlock_at')).toBe(Boolean(unlock_at));
    }
  );

  it.each(['active', 'deleted'])(
    'does not activate user already in terminal state %s',
    async (status) => {
      mocks.adapter.queryOne.mockResolvedValueOnce({
        id: 'account-1',
        lifecycle_state: status,
        metadata_json: JSON.stringify({ status }),
      });
      expect(
        (
          await adminUserActivateHandler(
            context({ body: { reason_code: 'investigation_cleared' } })
          )
        ).status
      ).toBe(400);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
      expect(mocks.adapter.batch).not.toHaveBeenCalled();
    }
  );

  it('activates a locked user and clears all restriction metadata', async () => {
    queueAccount('locked');
    const response = await adminUserActivateHandler(
      context({ body: { reason_code: 'false_positive' } })
    );
    await expect(response.json()).resolves.toMatchObject({
      status: 'active',
      previous_status: 'locked',
    });
    // The account (status, version and cleared restrictions) and its subject, together.
    expect(mocks.adapter.batch).toHaveBeenCalledTimes(1);
    const [statements] = mocks.adapter.batch.mock.calls[0]! as [
      Array<{ sql: string; params: unknown[] }>,
    ];
    expect(statements).toHaveLength(2);
    expect(statements[0]!.params).toEqual(
      expect.arrayContaining(['active', null, 'account-1', 'tenant-a'])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'user.activate',
      'user',
      'user-1',
      expect.anything()
    );
  });

  it.each([
    ['activate', adminUserActivateHandler, 'locked'],
    ['suspend', adminUserSuspendHandler, 'active'],
  ] as const)(
    'changes nothing when the authentication state took another transition first (%s)',
    async (_name, handler, current) => {
      queueAccount(current);
      // Two changes of the same version: the authentication state takes one and refuses the
      // other, which then never reaches the account (both paths ask it first).
      vi.mocked(transitionAccountAuthenticationState).mockRejectedValueOnce(
        new Error('account_authentication_lifecycle_conflict')
      );
      const response = await handler(context({ body: { reason_code: 'admin_action' } }));
      expect(response.status).toBe(409);
      // A suspension asks the authentication state first and changes nothing else; an activation
      // changed the account first, and sign-in stays refused until activating again settles it.
      expect(mocks.adapter.batch).toHaveBeenCalledTimes(
        handler === adminUserActivateHandler ? 1 : 0
      );
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['deleted account whose status still says active', 'deleted', 'active'],
    ['account being deleted', 'deleting', 'deleting'],
  ])('never activates a %s', async (_name, lifecycleState, authentication) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({
      id: 'account-1',
      lifecycle_state: lifecycleState,
      metadata_json: JSON.stringify({ status: 'active' }),
    });
    vi.mocked(readAccountAuthenticationState).mockResolvedValueOnce({
      lifecycle: authentication as never,
      lifecycleOperationId: null,
      lifecycleVersionMs: null,
      revokedAfterMs: null,
      lastLoginAtMs: null,
    });
    const response = await adminUserActivateHandler(
      context({ body: { reason_code: 'admin_action' } })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter.batch).not.toHaveBeenCalled();
    expect(transitionAccountAuthenticationState).not.toHaveBeenCalled();
  });

  it('activates again an account shown active whose sign-in is still refused', async () => {
    queueAccount('active');
    vi.mocked(readAccountAuthenticationState).mockResolvedValueOnce({
      lifecycle: 'suspended',
      lifecycleOperationId: 'other',
      lifecycleVersionMs: 1,
      revokedAfterMs: null,
      lastLoginAtMs: null,
    });
    const response = await adminUserActivateHandler(
      context({ body: { reason_code: 'admin_action' } })
    );
    expect(response.status).toBe(200);
    expect(transitionAccountAuthenticationState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lifecycle: 'active' })
    );
  });

  it.each([
    [
      adminUserSuspendHandler,
      'user.suspend',
      { reason_code: 'admin_action', reason_detail: 'private' },
    ],
    [adminUserLockHandler, 'user.lock', { reason_code: 'investigation', reason_detail: 'private' }],
    [
      adminUserActivateHandler,
      'user.activate',
      { reason_code: 'admin_action', reason_detail: 'private' },
    ],
  ])(
    'stores private reason detail only in encrypted operational logs %#',
    async (handler, action, body) => {
      queueAccount(action === 'user.activate' ? 'locked' : 'active');
      const response = await handler(
        context({
          body,
          adminId: 'admin-1',
          env: { PII_ENCRYPTION_KEY: 'secret', AUTHRIM_CONFIG: {} },
        })
      );
      expect(response.status).toBe(200);
      expect(mocks.operationalLog).toHaveBeenCalledWith(
        mocks.adapter,
        expect.objectContaining({ inlineEncryptionKey: 'secret' }),
        expect.objectContaining({ action, reasonDetail: 'private', actorId: 'admin-1' })
      );
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private');
    }
  );

  it('does not fail the status transition when encrypted operational logging fails', async () => {
    queueAccount('active');
    mocks.operationalLog.mockRejectedValueOnce(new Error('R2 unavailable'));
    expect(
      (
        await adminUserSuspendHandler(
          context({
            body: { reason_code: 'admin_action', reason_detail: 'private' },
            env: { PII_ENCRYPTION_KEY: 'secret' },
          })
        )
      ).status
    ).toBe(200);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it.each([
    [adminUserSuspendHandler, { reason_code: 'admin_action' }],
    [adminUserLockHandler, { reason_code: 'admin_action' }],
    [adminUserActivateHandler, { reason_code: 'admin_action' }],
  ])('returns internal_error for status persistence failure %#', async (handler, body) => {
    queueAccount(handler === adminUserActivateHandler ? 'locked' : 'active');
    mocks.adapter.batch.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect((await handler(context({ body }))).status).toBe(500);
  });
});

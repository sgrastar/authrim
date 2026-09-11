import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  findUser: vi.fn(),
  deleteUser: vi.fn(),
  transitionAccountAuthenticationState: vi.fn(),
  audit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
  createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocks.adapter })),
  transitionAccountAuthenticationState: mocks.transitionAccountAuthenticationState,
  createAuditLogFromContext: mocks.audit,
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  CanonicalRuntimeUserStore: vi.fn(function () {
    return { findById: mocks.findUser, deleteUser: mocks.deleteUser };
  }),
}));
import {
  cleanupExpiredGuestUsers,
  deleteGuestUser,
  getGuestUser,
  getGuestUserUpgrades,
  listGuestUsers,
} from '../routes/guest-users';
function context(
  options: {
    body?: unknown;
    bodyError?: boolean;
    id?: string;
    query?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    req: {
      param: vi.fn(() => options.id),
      query: vi.fn((n: string) => options.query?.[n]),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env ?? {},
    json: vi.fn((v: unknown, s = 200) => Response.json(v, { status: s })),
  } as never;
}
function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    account_type: 'user',
    registration_state: 'guest',
    created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: 100,
    ...overrides,
  };
}
describe('guest account administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.findUser.mockResolvedValue(null);
    mocks.deleteUser.mockResolvedValue(true);
    mocks.transitionAccountAuthenticationState.mockResolvedValue({ lifecycle: 'active' });
    mocks.audit.mockResolvedValue(undefined);
  });
  it.each([false, true])('lists guest accounts include_expired=%s', async (includeExpired) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 2 });
    mocks.adapter.query.mockResolvedValueOnce([
      {
        user_id: 'u1',
        credential_count: 2,
        active_credential_count: 0,
        next_credential_expiry: null,
        created_at: 1,
        last_used_at: 2,
      },
    ]);
    const body = (await (
      await listGuestUsers(
        context({ query: { limit: '500', offset: '10', include_expired: String(includeExpired) } })
      )
    ).json()) as { users: Array<Record<string, unknown>>; limit: number };
    expect(body.limit).toBe(100);
    expect(body.users[0]).toMatchObject({
      user_id: 'u1',
      credential_count: 2,
      has_active_resume_credential: false,
    });
    expect(mocks.adapter.queryOne.mock.calls[0][0].includes('ad.is_active = 1')).toBe(
      !includeExpired
    );
    for (const sql of [
      mocks.adapter.queryOne.mock.calls[0][0],
      mocks.adapter.query.mock.calls[0][0],
    ]) {
      expect(sql).toContain('uc.tenant_id = ad.tenant_id');
      expect(sql).toContain("uc.registration_state = 'guest'");
      expect(sql).toContain('uc.deleted_at IS NULL');
    }
  });
  it.each([
    [{ limit: '0' }, 400],
    [{ limit: 'not-a-number' }, 400],
    [{ offset: '-1' }, 400],
    [{ include_expired: 'yes' }, 400],
  ])('rejects invalid list pagination %#', async (query, status) => {
    expect((await listGuestUsers(context({ query }))).status).toBe(status);
    expect(mocks.adapter.query).not.toHaveBeenCalled();
  });
  it('defaults list count and handles failure', async () => {
    await expect((await listGuestUsers(context())).json()).resolves.toMatchObject({ total: 0 });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await listGuestUsers(context())).status).toBe(500);
  });
  it('lists only live guest accounts from the current tenant', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE identity_accounts (
          tenant_id TEXT NOT NULL,
          legacy_user_id TEXT NOT NULL,
          account_type TEXT NOT NULL,
          registration_state TEXT NOT NULL,
          deleted_at INTEGER
        );
        CREATE TABLE guest_devices (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          resume_credential_hash TEXT NOT NULL,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          is_active INTEGER NOT NULL
        );
        INSERT INTO identity_accounts VALUES
          ('tenant-a', 'guest-a', 'user', 'guest', NULL),
          ('tenant-a', 'shared-id', 'user', 'registered', NULL),
          ('tenant-b', 'shared-id', 'user', 'guest', NULL),
          ('tenant-a', 'deleted-guest', 'user', 'guest', 1);
        INSERT INTO guest_devices VALUES
          ('c1', 'tenant-a', 'guest-a', '${'a'.repeat(64)}', NULL, 1, 4, 1),
          ('c2', 'tenant-a', 'shared-id', '${'b'.repeat(64)}', NULL, 2, 5, 1),
          ('c3', 'tenant-a', 'deleted-guest', '${'c'.repeat(64)}', NULL, 3, 6, 1),
          ('c4', 'tenant-b', 'shared-id', '${'d'.repeat(64)}', NULL, 4, 7, 1);
      `);
      mocks.adapter.queryOne.mockImplementation(async (sql: string, params: unknown[]) =>
        db.prepare(sql).get(...params)
      );
      mocks.adapter.query.mockImplementation(async (sql: string, params: unknown[]) =>
        db.prepare(sql).all(...params)
      );

      const response = await listGuestUsers(
        context({ query: { include_expired: 'true', limit: '100', offset: '0' } })
      );
      await expect(response.json()).resolves.toMatchObject({
        total: 1,
        users: [{ user_id: 'guest-a' }],
      });
    } finally {
      db.close();
    }
  });
  it('requires anonymous user ID', async () => {
    expect((await getGuestUser(context())).status).toBe(400);
    expect((await getGuestUserUpgrades(context())).status).toBe(400);
    expect((await deleteGuestUser(context())).status).toBe(400);
  });
  it.each([null, user({ registration_state: 'registered' }), user()])(
    'gets anonymous user state %#',
    async (value) => {
      mocks.findUser.mockResolvedValueOnce(value);
      if (value?.registration_state === 'guest') {
        mocks.adapter.query.mockResolvedValueOnce([
          {
            id: 'd1',
            expires_at: null,
            created_at: 1,
            last_used_at: 2,
            is_active: 1,
          },
        ]);
        mocks.adapter.queryOne.mockResolvedValueOnce({
          upgraded_user_id: 'human-1',
          upgrade_method: 'email',
          upgraded_at: 3,
          preserve_sub: 1,
        });
      }
      const response = await getGuestUser(context({ id: 'user-1' }));
      expect(response.status).toBe(!value ? 404 : value.registration_state === 'guest' ? 200 : 400);
    }
  );
  it('blocks anonymous user deletion while an account legal hold is active', async () => {
    mocks.findUser.mockResolvedValueOnce(user());
    mocks.adapter.queryOne.mockResolvedValueOnce({
      hold_id: 'legal-hold:anonymous',
      reason_code: 'litigation',
    });
    const response = await deleteGuestUser(context({ id: 'user-1' }));
    expect(response.status).toBe(409);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.transitionAccountAuthenticationState).not.toHaveBeenCalled();
  });
  it('formats an absent upgrade and expired browser resume credential', async () => {
    mocks.findUser.mockResolvedValueOnce(user());
    mocks.adapter.query.mockResolvedValueOnce([
      { id: 'd1', expires_at: Date.now() - 1, is_active: 0 },
    ]);
    const body = await (await getGuestUser(context({ id: 'user-1' }))).json();
    expect(body).toMatchObject({
      upgrade: null,
      resume_credentials: [{ is_expired: true, is_active: false }],
    });
  });
  it('lists normalized upgrade history and handles failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      {
        id: 'up1',
        guest_user_id: 'u1',
        upgraded_user_id: 'u2',
        upgrade_method: 'email',
        provider_id: null,
        preserve_sub: 1,
        upgraded_at: 1,
        data_migrated: 0,
      },
    ]);
    await expect((await getGuestUserUpgrades(context({ id: 'u1' }))).json()).resolves.toMatchObject(
      { upgrades: [{ preserve_sub: true, data_migrated: false }] }
    );
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await getGuestUserUpgrades(context({ id: 'u1' }))).status).toBe(500);
  });
  it.each([null, user({ registration_state: 'registered' }), user()])(
    'deletes anonymous user state %#',
    async (value) => {
      mocks.findUser.mockResolvedValueOnce(value);
      const response = await deleteGuestUser(context({ id: 'user-1' }));
      expect(response.status).toBe(!value ? 404 : value.registration_state === 'guest' ? 200 : 400);
      expect(mocks.deleteUser).toHaveBeenCalledTimes(value?.registration_state === 'guest' ? 1 : 0);
      expect(mocks.transitionAccountAuthenticationState).toHaveBeenCalledTimes(
        value?.registration_state === 'guest' ? 2 : 0
      );
      expect(mocks.audit).toHaveBeenCalledTimes(value?.registration_state === 'guest' ? 1 : 0);
      if (value?.registration_state === 'guest') {
        expect(mocks.audit).toHaveBeenCalledWith(
          expect.anything(),
          'user.deleted',
          'user',
          'user-1',
          expect.objectContaining({ registration_state: 'guest', reason: 'admin_action' })
        );
      }
    }
  );
  it('handles anonymous user get/delete failures', async () => {
    mocks.findUser.mockRejectedValueOnce(new Error('failure'));
    expect((await getGuestUser(context({ id: 'u' }))).status).toBe(500);
    mocks.findUser.mockRejectedValueOnce(new Error('failure'));
    expect((await deleteGuestUser(context({ id: 'u' }))).status).toBe(500);
  });
  it('defaults cleanup to safe dry-run on empty/malformed body', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      { user_id: 'u1', credential_id: 'c1', expires_at: Date.now() - 3600000 },
    ]);
    const response = await cleanupExpiredGuestUsers(context({ bodyError: true }));
    await expect(response.json()).resolves.toMatchObject({
      dry_run: true,
      expired_count: 1,
      expired_credentials: [{ credential_id: 'c1', expired_since_hours: 1 }],
    });
  });
  it('caps dry-run cleanup limit', async () => {
    expect(
      (await cleanupExpiredGuestUsers(context({ body: { dry_run: true, limit: 5000 } }))).status
    ).toBe(200);
    expect(mocks.adapter.query.mock.calls[0][1][2]).toBe(1000);
  });
  it.each([{ dry_run: 'false' }, { limit: 0 }, { limit: 1.5 }, { limit: '10' }])(
    'rejects invalid cleanup input %#',
    async (body) => {
      expect((await cleanupExpiredGuestUsers(context({ body }))).status).toBe(400);
      expect(mocks.adapter.query).not.toHaveBeenCalled();
    }
  );
  it('deletes users with no active credential and deactivates only expired credentials otherwise', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      { user_id: 'u1', credential_id: 'c1', expires_at: 1 },
      { user_id: 'u1', credential_id: 'c2', expires_at: 2 },
      { user_id: 'u2', credential_id: 'c3', expires_at: 3 },
    ]);
    mocks.adapter.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'active' });
    const body = await (
      await cleanupExpiredGuestUsers(context({ body: { dry_run: false, limit: 10 } }))
    ).json();
    expect(mocks.adapter.query.mock.calls[0][0]).toContain('uc.tenant_id = ad.tenant_id');
    expect(mocks.adapter.query.mock.calls[0][0]).toContain('uc.deleted_at IS NULL');
    expect(body).toMatchObject({
      deleted_users: 1,
      deleted_credentials: 2,
      deactivated_credentials: 1,
    });
    expect(mocks.deleteUser).toHaveBeenCalledTimes(1);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'user.deleted',
      'user',
      'u1',
      expect.objectContaining({ registration_state: 'guest', reason: 'manual_cleanup' })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'guest.resume_credentials.deactivated',
      'user',
      'u2',
      expect.objectContaining({ reason: 'manual_cleanup' })
    );
  });
  it('skips scheduled anonymous cleanup while an account legal hold is active', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      { user_id: 'u1', credential_id: 'c1', expires_at: 1 },
    ]);
    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      hold_id: 'legal-hold:anonymous-cleanup',
      reason_code: 'regulatory_review',
    });
    const body = await (
      await cleanupExpiredGuestUsers(context({ body: { dry_run: false, limit: 10 } }))
    ).json();
    expect(body).toMatchObject({ deleted_users: 0 });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it('deduplicates cleanup user IDs and handles cleanup errors', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await cleanupExpiredGuestUsers(context({ body: { dry_run: false } }))).status).toBe(
      500
    );
  });
});
